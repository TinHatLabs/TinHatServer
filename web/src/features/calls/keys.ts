// keys.ts — per-participant LiveKit media keys over Olm to-device (native e2ee_keys.rs +
// call_ctl.rs key paths, 10.4.2 hardening).
//
//   • Own key: 16 random bytes at a persisted, advancing index in 0..254 (`media-key-index`).
//   • Announce: Olm-encrypted to-device `io.element.call.encryption_keys` in the matrix-js-sdk
//     ToDeviceKeyTransport shape — `keys` is ONE object, key = standard base64 with padding.
//   • Intake (keyrules.ts, Astra 2026-09-23 findings 1-2): ONLY Olm-decrypted to-device events whose
//     Curve25519 sender key is bound to a known device of the sender, that device = the claimed one,
//     `room_id` = our call, the sender a JOINED room member holding a live call membership from that
//     exact device. Installed under the sender-bound identities (`sender:dev`, `_sender_dev`, the
//     hashed MSC4143 form); never under our own identity; index 255 refused; ≤ 8 indices per device.
//     A key whose membership hasn't synced yet waits (bounded, ≤ 30 s) and is re-checked — never
//     installed on trust. The legacy ROOM-EVENT intake is gone (natives stopped mirroring 2026-09-21).
//   • Announce (finding 3): only to live call-member devices of JOINED room members, re-checked
//     against the current membership + call generation right before the batch is queued.
//   • Early keys are kept in the registry and replayed into the keyring when the SFU connects.
import { BaseKeyProvider } from "livekit-client";
import { ClientEvent, type MatrixClient } from "matrix-js-sdk";
import type { ReceivedToDeviceMessage } from "matrix-js-sdk/lib/sync-accumulator";
import { getSession, onClientChanged, peekClient } from "@/core/matrix";
import { getPref, setPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { KEYS_TYPE, b64encode, decodeKey, errText, sha256b64NoPad } from "./util";
import { liveSessions } from "./rtc";
import { MAX_INDICES_PER_DEVICE, boundMemberId, checkKeyEvent, claimedDevice, keyRecipients, validIndex, type IntakeCtx, type OlmInfoLike } from "./keyrules";

const log = createLogger("e2ee");

export const KEY_RING_SIZE = 255; // our indices stay in 0..254
const MAX_SLOTS = 4096;
const PENDING_TTL_MS = 30_000;
const PENDING_MAX = 32;

/** livekit-client key provider: per-participant keys, no ratcheting, 256-slot ring (EC fork's MatrixKeyProvider). */
export class TinHatKeyProvider extends BaseKeyProvider {
  /** The index our own sender cryptor encrypts with (re-posted as "current" on signal reconnects). */
  ownIndex = 0;
  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: 256 });
  }
  async setRawKey(identity: string, index: number, raw: Uint8Array): Promise<void> {
    const material = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveBits", "deriveKey"]);
    this.onSetEncryptionKey(material, identity, index);
  }
  override getLatestManuallySetKeyIndex(): number {
    return this.ownIndex;
  }
}

// ---- own key index --------------------------------------------------------------------------------

let lastIndex: number | null = null;

/** e2ee_keys.rs advance_persisted_key_index: in-memory counter first, persisted best-effort. */
export function advanceKeyIndex(): number {
  if (lastIndex === null) {
    const raw = getPref("media-key-index", "");
    const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    lastIndex = Number.isInteger(n) && n >= 0 && n < KEY_RING_SIZE ? n : Math.floor(Math.random() * KEY_RING_SIZE);
  }
  const next = (lastIndex + 1) % KEY_RING_SIZE;
  lastIndex = next;
  try {
    setPref("media-key-index", String(next));
  } catch {
    /* storage full / blocked: the in-memory counter still advances */
  }
  return next;
}

export function mintKey(): Uint8Array {
  const k = new Uint8Array(16);
  crypto.getRandomValues(k);
  return k;
}

// ---- registry of peer keys --------------------------------------------------------------------------

interface Slot {
  identity: string;
  owner: string; // `${sender}|${device}` (Olm-authenticated)
  index: number;
  raw: Uint8Array;
  roomId: string;
  at: number; // last install (ms, local clock)
}

const slots = new Map<string, Slot>();
// Per room: a delayed key from another call must never overwrite the slot buffered for this one.
const slotKey = (roomId: string, identity: string, index: number) => `${roomId}|${identity}#${index}`;
/** Per (room, owner device): the indices held, oldest first (MAX_INDICES_PER_DEVICE cap). */
const ownerIndices = new Map<string, number[]>();
/** Per (room, sender, device): the one hashed identity currently held. */
const ownerHashed = new Map<string, string>();

/** Where installs go when a LiveKit room exists (set by the engine). */
interface Sink {
  roomId: string; // call room (or the room being joined)
  myIdentity: string; // `@me:server:DEV`
  provider: TinHatKeyProvider | null; // null while connecting → buffer only
}
let sink: Sink | null = null;
/** Bumped whenever the call changes (leave, or a different room); NOT when the same join attaches its
 *  provider — so in-flight intakes of the same call survive the hand-over, an old call's never do. */
let sinkEpoch = 0;

export function setKeySink(s: Sink | null): void {
  if (!s || !sink || s.roomId !== sink.roomId) {
    sinkEpoch++;
    clearPending();
  }
  sink = s;
}

function ownForms(): Set<string> {
  const s = getSession();
  if (!s.userId || !s.deviceId) return new Set();
  return new Set([`${s.userId}:${s.deviceId}`, `_${s.userId}_${s.deviceId}`]);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Listeners for "a key arrived for identity" (the hear analyzer clears nokey marks). */
const keyListeners = new Set<(identity: string) => void>();
export function onPeerKey(cb: (identity: string) => void): () => void {
  keyListeners.add(cb);
  return () => keyListeners.delete(cb);
}

function evictOwnerIndex(roomId: string, owner: string, index: number) {
  for (const [k, sl] of slots) if (sl.roomId === roomId && sl.owner === owner && sl.index === index) slots.delete(k);
}

function installSlot(identity: string, owner: string, index: number, raw: Uint8Array, roomId: string): boolean {
  if (validIndex(index) === null) {
    log.warn(`refusing key index ${index} for ${identity}`);
    return false;
  }
  if (ownForms().has(identity)) {
    log.warn(`refusing a key under our own identity ${identity}`);
    return false;
  }
  // Per-device index cap: a (legitimate) member can never fill the registry for everyone else.
  const ok = `${roomId}|${owner}`;
  const held = ownerIndices.get(ok) ?? [];
  if (!held.includes(index)) {
    held.push(index);
    while (held.length > MAX_INDICES_PER_DEVICE) evictOwnerIndex(roomId, owner, held.shift()!);
    ownerIndices.set(ok, held);
  }
  const k = slotKey(roomId, identity, index);
  const cur = slots.get(k);
  const now = Date.now();
  if (!cur && slots.size >= MAX_SLOTS) pruneForeign(now);
  if (!cur && slots.size >= MAX_SLOTS) {
    log.warn(`key registry full — dropping new slot ${identity}#${index}`);
    return false;
  }
  if (cur && sameBytes(cur.raw, raw)) cur.at = now;
  else slots.set(k, { identity, owner, index, raw, roomId, at: now });
  const sl = slots.get(k)!;
  if (sink?.provider && sink.roomId === sl.roomId) {
    void sink.provider.setRawKey(identity, index, raw).catch((e) => log.warn(`setKey ${identity}: ${errText(e)}`));
    for (const l of keyListeners) l(identity);
  }
  return true;
}

/** Keys buffered for rooms we are not calling in (sent after we left, or early) — drop those > 10 min old. */
function pruneForeign(now: number) {
  for (const [k, sl] of slots) {
    if (sl.roomId === sink?.roomId) continue;
    if (now - sl.at > 600_000) slots.delete(k);
  }
}

/** Replay every buffered slot of `roomId` into the keyring (skipping ours). */
export async function replayKeys(provider: TinHatKeyProvider, roomId: string): Promise<number> {
  const own = ownForms();
  let n = 0;
  for (const s of slots.values()) {
    if (s.roomId !== roomId || own.has(s.identity)) continue;
    await provider.setRawKey(s.identity, s.index, s.raw).catch(() => undefined);
    n++;
  }
  if (n) log.info(`replayed ${n} buffered key slot(s) into the keyring`);
  return n;
}

/** Does any key exist for this identity (in the call room)? */
export function hasKeyFor(identity: string, roomId: string): boolean {
  for (const s of slots.values()) if (s.identity === identity && s.roomId === roomId) return true;
  return false;
}

export function clearKeysFor(roomId: string): void {
  for (const [k, s] of slots) if (s.roomId === roomId) slots.delete(k);
  for (const k of [...ownerIndices.keys()]) if (k.startsWith(`${roomId}|`)) ownerIndices.delete(k);
  for (const k of [...ownerHashed.keys()]) if (k.startsWith(`${roomId}|`)) ownerHashed.delete(k);
  clearPending();
}

// ---- intake ------------------------------------------------------------------------------------------

type Content = Record<string, unknown>;

/** The membership facts of the call room right now (keyrules IntakeCtx). */
function intakeCtx(roomId: string): IntakeCtx {
  const c = peekClient();
  const s = getSession();
  const room = c?.getRoom(roomId) ?? null;
  const live = new Set<string>();
  for (const m of liveSessions(roomId)) if (m.deviceId && m.wellFormed) live.add(`${m.sender}|${m.deviceId}`);
  return {
    callRoomId: roomId,
    ownUserId: s.userId ?? "",
    ownDeviceId: s.deviceId ?? "",
    liveMembers: live,
    membershipOf: (u) => membershipIn(room, u),
  };
}

function membershipIn(room: ReturnType<MatrixClient["getRoom"]>, userId: string): string | null {
  if (!room) return null;
  const m = room.getMember(userId);
  if (m?.membership) return m.membership;
  const ev = room.currentState.getStateEvents("m.room.member", userId);
  const ms = ev ? (ev.getContent() as { membership?: unknown }).membership : undefined;
  return typeof ms === "string" ? ms : null;
}

/**
 * Bind the Olm sender to a device record: when the SDK already bound it (`senderDevice`), check that
 * record's Curve25519 key is the one the message was encrypted with; when it could not (the device
 * list wasn't cached yet), download the sender's devices and find the one owning that key.
 */
async function bindDevice(enc: OlmInfoLike): Promise<OlmInfoLike | null> {
  const cryptoApi = peekClient()?.getCrypto();
  if (!cryptoApi || !enc.sender) return null;
  const curve = enc.senderCurve25519KeyBase64 ?? "";
  if (enc.senderDevice) {
    let devs = (await cryptoApi.getUserDeviceInfo([enc.sender], false)).get(enc.sender);
    if (!devs?.get(enc.senderDevice)) devs = (await cryptoApi.getUserDeviceInfo([enc.sender], true)).get(enc.sender);
    const d = devs?.get(enc.senderDevice);
    if (!d) return { ...enc, senderDevice: null };
    if (curve && d.getIdentityKey() && d.getIdentityKey() !== curve) {
      log.warn(`[recv-key-td] ${enc.sender}/${enc.senderDevice}: Curve25519 key does not match the device record — rejected`);
      return null;
    }
    return enc;
  }
  if (!curve) return enc;
  const devs = (await cryptoApi.getUserDeviceInfo([enc.sender], true)).get(enc.sender);
  for (const [id, d] of devs ?? []) if (d.getIdentityKey() === curve) return { ...enc, senderDevice: id };
  return enc;
}

interface PendingKey {
  enc: OlmInfoLike;
  sender: string;
  content: Content;
  at: number;
}
const pendingKeys: PendingKey[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clearPending() {
  pendingKeys.length = 0;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}

function holdPending(p: PendingKey) {
  // One entry per (sender, claimed device, index): a newer copy replaces the older one.
  const id = (x: PendingKey) => `${x.sender}|${claimedDevice(x.content)}|${JSON.stringify((x.content.keys as Content | undefined)?.index ?? "")}`;
  const i = pendingKeys.findIndex((x) => id(x) === id(p));
  if (i >= 0) pendingKeys.splice(i, 1);
  pendingKeys.push(p);
  while (pendingKeys.length > PENDING_MAX) pendingKeys.shift();
  if (!pendingTimer) pendingTimer = setTimeout(recheckPending, 1500);
}

/** Re-run held keys through the rules (their membership may have synced meanwhile). */
export function recheckPending(): void {
  pendingTimer = null;
  const now = Date.now();
  const batch = pendingKeys.splice(0);
  for (const p of batch) {
    if (now - p.at > PENDING_TTL_MS) {
      log.warn(`[recv-key-td] ${p.sender}/${claimedDevice(p.content)}: still no live call membership after ${PENDING_TTL_MS / 1000}s — key dropped`);
      continue;
    }
    void intake(p.enc, p.sender, p.content, p.at).catch((e) => log.warn(`[recv-key-td] ${errText(e)}`));
  }
  if (pendingKeys.length && !pendingTimer) pendingTimer = setTimeout(recheckPending, 2000);
}

/** One Olm-decrypted key event → the trust rules → install (or hold / reject). */
async function intake(encIn: OlmInfoLike | null, eventSender: string, content: Content, firstAt = Date.now()): Promise<number> {
  const at = sink;
  const epoch = sinkEpoch;
  if (!at) {
    log.debug(`[recv-key-td] ${eventSender}: no call — dropped`);
    return 0;
  }
  let enc: OlmInfoLike | null = encIn;
  if (enc) {
    const raw: OlmInfoLike = enc;
    try {
      enc = await bindDevice(raw);
    } catch (e) {
      log.warn(`[recv-key-td] device lookup for ${raw.sender}: ${errText(e)}`);
      enc = { ...raw, senderDevice: null };
    }
    if (!enc) return 0;
  }
  // (compare the ROOM: the sink object is replaced when the SFU connects — same call, keep the key)
  if (sinkEpoch !== epoch) return 0; // the call changed while we looked the device up
  let ctx = intakeCtx(at.roomId);
  if (ctx.membershipOf(enc?.sender ?? eventSender) === null) {
    await peekClient()?.getRoom(at.roomId)?.loadMembersIfNeeded().catch(() => false);
    if (sinkEpoch !== epoch) return 0;
    ctx = intakeCtx(at.roomId);
  }
  const v = checkKeyEvent(enc, eventSender, content, ctx);
  if (!v.ok) {
    if (v.pending && enc) {
      log.info(`[recv-key-td] holding: ${v.reason}`);
      holdPending({ enc, sender: eventSender, content, at: firstAt });
    } else log.warn(`[recv-key-td] REJECTED: ${v.reason}`);
    return 0;
  }
  const { sender, device: dev, roomId } = v;
  const member = (content.member && typeof content.member === "object" ? content.member : undefined) as Content | undefined;
  const colon = `${sender}:${dev}`;
  const underscore = `_${sender}_${dev}`;
  const liveMid = liveSessions(roomId).find((m) => m.sender === sender && m.deviceId === dev)?.membershipId ?? "";
  const memberId = boundMemberId(member?.id, sender, dev, liveMid);
  if (typeof member?.id === "string" && member.id && member.id !== memberId) {
    log.warn(`[recv-key-td] member.id ${member.id} is neither derived from ${colon} nor its membershipID — using ${colon}`);
  }
  const identities = [colon, underscore];
  try {
    identities.push(await sha256b64NoPad(JSON.stringify([sender, dev, memberId])));
  } catch {
    /* no subtle crypto: skip the hashed form */
  }
  // Re-check after the await: same call, and the device is STILL a live, joined call member.
  if (sinkEpoch !== epoch) return 0;
  if (!checkKeyEvent(enc, eventSender, content, intakeCtx(at.roomId)).ok) return 0;
  // One hashed (membershipID-bound) identity per device: a changed membershipID retires the old one.
  const hashed = identities[2];
  const owner0 = `${roomId}|${sender}|${dev}`;
  const prevHashed = ownerHashed.get(owner0);
  if (hashed && prevHashed && prevHashed !== hashed) {
    for (const [k, sl] of slots) if (sl.roomId === roomId && sl.identity === prevHashed) slots.delete(k);
  }
  if (hashed) ownerHashed.set(owner0, hashed);
  const entries: Content[] = [];
  const keys = content.keys;
  if (Array.isArray(keys)) entries.push(...(keys as Content[]).filter((x) => x && typeof x === "object").slice(0, 4));
  else if (keys && typeof keys === "object") entries.push(keys as Content);
  let n = 0;
  const owner = `${sender}|${dev}`;
  for (const e of entries) {
    const index = validIndex(e.index);
    const raw = typeof e.key === "string" ? decodeKey(e.key) : null;
    if (index === null || !raw) {
      log.warn(`[recv-key-td] ${colon}: entry without a usable index/key`);
      continue;
    }
    for (const id of identities) if (installSlot(id, owner, index, raw, roomId)) n++;
    log.info(`[recv-key-td] key #${index} from ${colon} for ${roomId}`);
  }
  return n;
}

/** Test/diagnostic entry: run a key event through the full intake (encryption info as the SDK gives it). */
export function ingestKeyEvent(enc: OlmInfoLike | null, eventSender: string, content: Content): Promise<number> {
  return intake(enc, eventSender, content);
}

let attached: MatrixClient | null = null;
function onToDevice(p: ReceivedToDeviceMessage) {
  const m = p.message;
  if (m?.type !== KEYS_TYPE) return;
  if (!p.encryptionInfo) {
    log.warn(`[recv-key-td] REJECTED plaintext key event from ${m.sender} — only Olm-decrypted key events are trusted`);
    return;
  }
  void intake(p.encryptionInfo, m.sender ?? "", (m.content ?? {}) as Content).catch((e) => log.warn(`[recv-key-td] ${errText(e)}`));
}

/** Listen for to-device keys on the current client (also before any call starts). */
export function installKeyIntake(): void {
  const attach = () => {
    const c = peekClient();
    if (c === attached) return;
    attached?.off(ClientEvent.ReceivedToDeviceMessage, onToDevice);
    attached = c;
    c?.on(ClientEvent.ReceivedToDeviceMessage, onToDevice);
    if (!c) {
      slots.clear();
      ownerIndices.clear();
      ownerHashed.clear();
      clearPending();
    }
  };
  attach();
  onClientChanged(attach);
}

// ---- announce ---------------------------------------------------------------------------------------

type RustUserId = { toString(): string };
type OlmLike = {
  trackedUsers(): Promise<Set<RustUserId>>;
  updateTrackedUsers(users: RustUserId[]): Promise<void>;
};

/**
 * The Rust crypto only knows the devices of users it TRACKS (members of encrypted rooms we share).
 * `getUserDeviceInfo(…, true)` downloads untracked users' devices but does not store them, so
 * `encryptToDeviceMessages` then skips them ("unknown device") — in an unencrypted call room the
 * Memories recorder or a peer we share no encrypted room with never got our media key (the
 * recording of a web user was silent: "[recv5-e2ee] … stuck in MissingKey"). Start tracking those
 * users and run the key query now. Uses the crypto backend's internals (no public API for this);
 * a no-op when they aren't there. (media fix round, see features/media/CORE-CHANGES.md)
 */
async function ensureTracked(cryptoApi: object, userIds: string[]): Promise<void> {
  try {
    const om = Reflect.get(cryptoApi, "olmMachine") as OlmLike | undefined;
    if (!om || typeof om.trackedUsers !== "function" || typeof om.updateTrackedUsers !== "function") return;
    const tracked = [...(await om.trackedUsers())];
    const have = new Set(tracked.map((u) => u.toString()));
    const missing = userIds.filter((u) => !have.has(u));
    // UserId objects of the SAME wasm class the machine uses (a second module instance would fail
    // wasm-bindgen's instance check) — our own user is always tracked, so the set is never empty
    const Ctor = tracked[0]?.constructor as (new (id: string) => RustUserId) | undefined;
    if (!missing.length || !Ctor) return;
    await om.updateTrackedUsers(missing.map((u) => new Ctor(u)));
    const orm = Reflect.get(cryptoApi, "outgoingRequestsManager") as { doProcessOutgoingRequests?: () => Promise<void> } | undefined;
    if (typeof orm?.doProcessOutgoingRequests === "function") await orm.doProcessOutgoingRequests();
    log.info(`[send-key-td] now tracking ${missing.join(", ")} (no shared encrypted room)`);
  } catch (e) {
    log.warn(`[send-key-td] tracking untracked recipients: ${errText(e)}`);
  }
}

/**
 * Send our key to every live call-member device of `roomId` whose user is a JOINED room member,
 * except ourselves (the recorder too). Unknown devices → key query, retry once, else skip with a log
 * line. `valid()` = the call/key generation this announce belongs to is still current; the recipient
 * list is re-checked against the room right before the batch is queued.
 */
export async function announceKey(roomId: string, index: number, key: Uint8Array, why: string, valid: () => boolean = () => true): Promise<void> {
  const c = peekClient();
  const s = getSession();
  const cryptoApi = c?.getCrypto();
  if (!c || !cryptoApi || !s.userId || !s.deviceId || !valid()) return;
  const room = c.getRoom(roomId);
  if (!room) return;
  await room.loadMembersIfNeeded().catch(() => false);
  const me = s.userId;
  const myDev = s.deviceId;
  const eligible = () => keyRecipients(liveSessions(roomId), (u) => membershipIn(room, u), me, myDev); // (well-formed memberships only)
  const recips = eligible();
  if (recips.length === 0 || !valid()) return;
  // Make sure every recipient device is in the crypto store (download keys; retry once).
  const users = [...new Set(recips.map((r) => r.userId))];
  await ensureTracked(cryptoApi, users);
  let known = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const map = await cryptoApi.getUserDeviceInfo(users, true);
      known = new Set<string>();
      for (const [u, devs] of map) for (const d of devs.keys()) known.add(`${u}|${d}`);
    } catch (e) {
      log.warn(`[send-key-td] key query failed: ${errText(e)}`);
    }
    if (recips.every((r) => known.has(`${r.userId}|${r.deviceId}`))) break;
  }
  const targets = recips.filter((r) => {
    const ok = known.has(`${r.userId}|${r.deviceId}`);
    if (!ok) log.warn(`[send-key-td] device ${r.userId}/${r.deviceId} unresolved after key-query — skipping`);
    return ok;
  });
  if (!targets.length || !valid()) return;
  const content = {
    keys: { index, key: b64encode(key) },
    room_id: roomId,
    member: { claimed_device_id: myDev, id: `${me}:${myDev}` },
    session: { call_id: "", application: "m.call", scope: "m.room" },
    sent_ts: Date.now(),
  };
  const batch = await cryptoApi.encryptToDeviceMessages(KEYS_TYPE, targets, content);
  // Re-check right before queueing: a recipient whose leave / kick synced during the device query or
  // the encryption must not get the key, nor may a superseded call generation send one.
  if (!valid() || peekClient() !== c || getSession().deviceId !== myDev) return;
  const still = new Set(eligible().map((r) => `${r.userId}|${r.deviceId}`));
  const dropped = batch.batch.filter((m) => !still.has(`${m.userId}|${m.deviceId}`));
  if (dropped.length) log.info(`[send-key-td] ${dropped.length} recipient(s) left before queueing — not sent`);
  batch.batch = batch.batch.filter((m) => still.has(`${m.userId}|${m.deviceId}`));
  if (!batch.batch.length) return;
  await c.queueToDevice(batch);
  log.info(`[send-key-td] key #${index} → ${batch.batch.length} device(s) (${why})`);
}
