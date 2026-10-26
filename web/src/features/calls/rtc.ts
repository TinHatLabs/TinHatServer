// rtc.ts — MatrixRTC membership (port of native rtc.rs): liveness, participants, focus, publish,
// refresh, tombstone, keepalive tombstone on tab close, and the stale-own-membership sweep.
//
// Wire truth (calls-engine spec §4.2): type org.matrix.msc3401.call.member ONLY (never
// m.call.member / m.rtc.member writes), state key `_@u:server_DEVICE_m.call`, session content with
// `expires` (required), `created_ts` kept across refreshes, and the Tin Hat marker
// `dev.tinhat.client {kind:"web", version, record_optout}`.
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { getAccessToken, getSession, peekClient } from "@/core/matrix";
import { MATRIX_ORIGIN, bearerAllowed } from "@/core/bearer";
import { getPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { stateKeyOwned } from "./keyrules";
import { clientMarker } from "./av1";
import { focusFromWellKnown } from "./focus";
import { deviceStateKey, nativeDeviceId, pageOwnsMembership } from "@/features/native";
import { LEGACY_MEMBER_TYPES, MEMBER_TYPE, MEMBERSHIP_EXPIRES_MS, defaultFocusUrl, displayName, avatarMxc, sleep, withTimeout, errText } from "./util";

const log = createLogger("rtc");

export const WEB_VERSION: string = (import.meta.env.VITE_TW_VERSION as string | undefined) ?? `${(import.meta.env.VITE_TW_SEMVER as string | undefined) ?? "dev"}-web`;

export interface Focus {
  serviceUrl: string;
  alias: string;
}

export interface LiveSession {
  sender: string;
  deviceId: string;
  stateKey: string;
  createdTs: number;
  focus: Focus | null;
  kind: string; // dev.tinhat.client.kind ("" = not Tin Hat)
  recordOptout: boolean;
  /** `membershipID` of the session ("" = none) — the only non-derived member.id a key may carry */
  membershipId: string;
  /** strict schema (application m.call, scope m.room, call_id "", finite expires > 0): required for keys */
  wellFormed: boolean;
}

type Content = Record<string, unknown>;

export function ownStateKey(userId: string, deviceId: string): string {
  return deviceStateKey(userId, deviceId);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Liveness of one session-shaped object (spec §4.2 "Liveness rule"). */
function entryLive(c: Content, originTs: number, now: number): boolean {
  if (!c || Object.keys(c).length === 0) return false;
  const created = num(c.created_ts) ?? (originTs > 0 ? originTs : null);
  if (created === null) return true;
  const expires = num(c.expires) ?? MEMBERSHIP_EXPIRES_MS;
  return now <= created + expires;
}

/** A membership event's content is live (session form or legacy memberships[]). */
export function contentLive(c: Content | undefined, originTs: number, now = Date.now()): boolean {
  if (!c || Object.keys(c).length === 0) return false;
  if (Array.isArray(c.memberships)) {
    return (c.memberships as Content[]).some((m) => m && typeof m === "object" && entryLive(m, originTs, now));
  }
  return entryLive(c, originTs, now);
}

function focusOf(c: Content, roomId: string): Focus | null {
  const list = (Array.isArray(c.foci_preferred) ? c.foci_preferred : Array.isArray(c.foci_active) ? c.foci_active : []) as Content[];
  for (const f of list) {
    if (f && f.type === "livekit" && typeof f.livekit_service_url === "string" && f.livekit_service_url) {
      return { serviceUrl: f.livekit_service_url, alias: typeof f.livekit_alias === "string" && f.livekit_alias ? f.livekit_alias : roomId };
    }
  }
  return null;
}

function memberEvents(roomId: string, type: string, client: MatrixClient | null = peekClient()): MatrixEvent[] {
  const r = client?.getRoom(roomId);
  return r?.currentState.getStateEvents(type) ?? [];
}

/** Live msc3401 sessions of a room (typed session format + legacy array), one per (user, device). */
export function liveSessions(roomId: string, now = Date.now()): LiveSession[] {
  const out: LiveSession[] = [];
  const seen = new Set<string>();
  for (const ev of memberEvents(roomId, MEMBER_TYPE)) {
    const c = ev.getContent() as Content;
    const origin = ev.getTs();
    const sender = ev.getSender() ?? "";
    if (!sender || !contentLive(c, origin, now)) continue;
    const arrayForm = Array.isArray(c.memberships);
    const entries: Content[] = arrayForm
      ? (c.memberships as Content[]).filter((m) => m && typeof m === "object" && entryLive(m, origin, now))
      : [c];
    const stateKey = ev.getStateKey() ?? "";
    for (const e of entries) {
      if (e.application !== undefined && e.application !== "m.call") continue;
      if (e.scope !== undefined && e.scope !== "m.room") continue;
      const dev = typeof e.device_id === "string" ? e.device_id : "";
      // Schema + ownership (Astra finding 3): a device id is required, and the state key must belong
      // to the sender and that device — a membership someone else's key claims is not a member.
      if (!dev || !stateKeyOwned(stateKey, sender, dev, arrayForm)) continue;
      const k = `${sender}|${dev}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const marker = (e["dev.tinhat.client"] ?? c["dev.tinhat.client"]) as Content | undefined;
      out.push({
        sender,
        deviceId: dev,
        stateKey,
        createdTs: num(e.created_ts) ?? origin,
        focus: focusOf(e, roomId),
        kind: marker && typeof marker.kind === "string" ? marker.kind : "",
        recordOptout: !!marker && marker.record_optout === true,
        membershipId: typeof e.membershipID === "string" ? e.membershipID : "",
        wellFormed:
          e.application === "m.call" &&
          e.scope === "m.room" &&
          e.call_id === "" &&
          (num(e.expires) ?? 0) > 0,
      });
    }
  }
  return out;
}

/** "A call is going on" = any live msc3401 membership (rtc.rs:35-38). */
export function callActive(roomId: string): boolean {
  return liveSessions(roomId).length > 0;
}

export interface CallParticipant {
  mxid: string;
  name: string;
  avatar: string; // mxc ("" = none)
}

/** Participants of a room's call (all three spellings, raw, deduped by sender; rtc.rs:80-135). */
export function roomCallParticipants(roomId: string, now = Date.now()): CallParticipant[] {
  const seen = new Set<string>();
  const out: CallParticipant[] = [];
  for (const type of [MEMBER_TYPE, ...LEGACY_MEMBER_TYPES]) {
    for (const ev of memberEvents(roomId, type)) {
      const sender = ev.getSender() ?? "";
      if (!sender || seen.has(sender)) continue;
      if (!contentLive(ev.getContent() as Content, ev.getTs(), now)) continue;
      seen.add(sender);
      out.push({ mxid: sender, name: displayName(roomId, sender), avatar: avatarMxc(roomId, sender) });
    }
  }
  return out;
}

// ---- focus -------------------------------------------------------------------------------------

let wellKnown: Promise<string | null> | null = null;

function wellKnownFocusUrl(): Promise<string | null> {
  if (!wellKnown) {
    // the Tin Hat Server's well-known, on its homeserver origin (= this page's)
    wellKnown = fetch(`${MATRIX_ORIGIN}/.well-known/matrix/client`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Content | null) => focusFromWellKnown(j))
      .catch(() => {
        wellKnown = null;
        return null;
      });
  }
  return wellKnown;
}

/** The call JWT service new calls use (.well-known, else the default) — widgets W2's "Is it just me?" probes it. */
export async function focusServiceUrl(): Promise<string> {
  return (await wellKnownFocusUrl()) ?? defaultFocusUrl();
}

/** The live call's focus (first live session with a livekit focus), else .well-known, else the default. */
export async function resolveFocus(roomId: string): Promise<Focus> {
  const live = liveSessions(roomId)
    .filter((s) => s.focus)
    .sort((a, b) => a.createdTs - b.createdTs);
  if (live[0]?.focus) return live[0].focus;
  const url = (await wellKnownFocusUrl()) ?? defaultFocusUrl();
  return { serviceUrl: url, alias: roomId };
}

// ---- OpenID + LiveKit token ---------------------------------------------------------------------

export interface SfuToken {
  url: string;
  jwt: string;
}

export async function mintSfuToken(focus: Focus, deviceId: string): Promise<SfuToken> {
  const c = peekClient();
  if (!c) throw new Error("not signed in");
  // (bounded like every step of a join: an unanswered request must not leave the call "Connecting…" forever)
  const openid = await withTimeout(c.getOpenIdToken(), 15000, "the call sign-in (OpenID) request timed out");
  const res = await fetch(`${focus.serviceUrl.replace(/\/+$/, "")}/sfu/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: focus.alias, openid_token: openid, device_id: deviceId }),
    signal: AbortSignal.timeout(20000),
  }).catch((e: unknown) => {
    if ((e as { name?: string })?.name === "TimeoutError") throw new Error("lk-jwt-service request timed out (20s)");
    throw new Error(`lk-jwt-service unreachable: ${errText(e)}`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`lk-jwt-service HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { url?: string; jwt?: string };
  if (!j.url || !j.jwt) throw new Error("lk-jwt-service answered without url/jwt");
  return { url: j.url, jwt: j.jwt };
}

// ---- membership content / publish / refresh / tombstone -------------------------------------------

export function membershipContent(o: { roomId: string; userId: string; deviceId: string; createdTs: number; focus: Focus; refresh?: boolean }): Content {
  return {
    application: "m.call",
    call_id: "",
    scope: "m.room",
    device_id: o.deviceId,
    focus_active: { type: "livekit", focus_selection: "oldest_membership" },
    foci_preferred: [{ type: "livekit", livekit_service_url: o.focus.serviceUrl, livekit_alias: o.focus.alias }],
    created_ts: o.createdTs,
    // First join: exactly 4 h; refresh keeps created_ts and grows expires (rtc.rs:323-335).
    expires: o.refresh ? Math.max(MEMBERSHIP_EXPIRES_MS, Date.now() - o.createdTs + MEMBERSHIP_EXPIRES_MS) : MEMBERSHIP_EXPIRES_MS,
    membershipID: `${o.userId}:${o.deviceId}`,
    // kind "native" only when this browser verifiably decrypts natives' AV1 shares (av1.ts, AV1.md)
    "dev.tinhat.client": clientMarker(WEB_VERSION, getPref("record-optout", false)),
  };
}

/** Our own live membership's created_ts (or its origin ts), when one is live. */
export function ownLiveCreatedTs(roomId: string, userId: string, deviceId: string): number | null {
  const c = peekClient();
  const ev = c?.getRoom(roomId)?.currentState.getStateEvents(MEMBER_TYPE, ownStateKey(userId, deviceId));
  if (!ev) return null;
  const content = ev.getContent() as Content;
  if (!contentLive(content, ev.getTs())) return null;
  return num(content.created_ts) ?? ev.getTs();
}

// ---- membership writes: one at a time per room, owned by a join generation (Astra finding 8) ----------
//
// Every write (publish / refresh / withdraw) of our membership in a room runs in that room's chain, so
// a request can never overtake an earlier one. `desired` says which join generation (if any) wants a
// membership there right now: a publish checks it before AND after its PUT (a publish that lands for
// an owner who has since left tombstones itself), and a withdrawal stands down while any join wants
// the room — so a late background publish can neither resurrect a ghost after a leave nor be
// "withdrawn" on top of a newer same-room rejoin.

const chains = new Map<string, Promise<unknown>>();
const desired = new Map<string, number>(); // roomId → owning join generation

function inChain<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(roomId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(roomId, tail);
  void tail.then(() => {
    if (chains.get(roomId) === tail) chains.delete(roomId);
  });
  return run;
}

/** A new session starts with no membership ownership (old owners' writes carry their own writer). */
export function clearMembershipOwnership(): void {
  desired.clear();
}

/** Join generation `gen` wants a membership in `roomId` (set before its first publish). */
export function wantMembership(roomId: string, gen: number): void {
  desired.set(roomId, gen);
}
/** Nobody (or no longer `gen`) wants a membership in `roomId`. */
export function dropMembership(roomId: string, gen?: number): void {
  if (gen === undefined || desired.get(roomId) === gen) desired.delete(roomId);
}
export function membershipWanted(roomId: string): boolean {
  return desired.has(roomId);
}

/** The account + device a write belongs to, captured when the write is REQUESTED. */
interface Writer {
  c: MatrixClient;
  userId: string;
  deviceId: string;
}
function writer(): Writer {
  const c = peekClient();
  const s = getSession();
  if (!c || !s.userId || !s.deviceId) throw new Error("not signed in");
  return { c, userId: s.userId, deviceId: s.deviceId };
}

async function put(w: Writer, roomId: string, content: Content): Promise<void> {
  // A write queued by an earlier session never lands on a replacement account / device.
  if (peekClient() !== w.c) throw new Error("the session changed — write dropped");
  // Bounded: every membership write of a room runs in one chain, so a PUT that never answers (a socket
  // killed by an iOS app switch) used to block every later join / leave of that room until a reload.
  await w.c.sendStateEvent(roomId, MEMBER_TYPE as never, content as never, ownStateKey(w.userId, w.deviceId), { localTimeoutMs: MEMBERSHIP_PUT_TIMEOUT_MS });
}

/** One membership PUT (publish / refresh / tombstone) may take this long before it counts as failed. */
export const MEMBERSHIP_PUT_TIMEOUT_MS = 15_000;

/**
 * Publish / refresh our membership for join generation `gen`. Resolves false (without writing) when
 * `gen` no longer owns the room; a publish that lands after its owner left is tombstoned at once.
 */
export function putMembership(roomId: string, content: Content, gen: number): Promise<boolean> {
  let w: Writer;
  try {
    w = writer();
  } catch (e) {
    return Promise.reject(e);
  }
  return inChain(roomId, async () => {
    if (desired.get(roomId) !== gen) {
      log.info(`membership publish in ${roomId} (gen ${gen}) skipped: no longer wanted`);
      return false;
    }
    await put(w, roomId, content);
    // Landed for an owner who is gone: nobody wants the room any more, or the session it was written
    // for is no longer this tab's (sign-out / account switch) — tombstone with the ORIGINAL writer.
    if ((desired.get(roomId) !== gen && !desired.has(roomId)) || peekClient() !== w.c) {
      log.info(`membership in ${roomId} landed after its call ended — tombstoning it`);
      await w.c
        .sendStateEvent(roomId, MEMBER_TYPE as never, {} as never, ownStateKey(w.userId, w.deviceId), { localTimeoutMs: MEMBERSHIP_PUT_TIMEOUT_MS })
        .catch((e: unknown) => log.warn(`late-publish tombstone: ${errText(e)}`));
      return false;
    }
    return true;
  });
}

/** Leave: tombstone `{}` — 3 attempts with 300/600/900 ms back-off, bounded by `boundMs`; stands down
 *  while any join wants the room (checked before every attempt, inside the room's write chain). */
export async function withdrawMembership(roomId: string, boundMs = 8000): Promise<boolean> {
  let w: Writer;
  try {
    w = writer();
  } catch {
    return false;
  }
  let cancelled = false;
  const run = async () => {
    for (let i = 0; i < 3; i++) {
      const r = await inChain(roomId, async () => {
        if (cancelled || desired.has(roomId)) {
          log.info(`withdraw in ${roomId} abandoned: timed out or a newer membership is wanted`);
          return "abandon" as const;
        }
        try {
          await put(w, roomId, {});
          log.info(`membership withdrawn in ${roomId}`);
          return "done" as const;
        } catch (e) {
          log.warn(`withdraw attempt ${i + 1} failed: ${errText(e)}`);
          return "retry" as const;
        }
      });
      if (r === "done") return true;
      if (r === "abandon") return false;
      await sleep(300 * (i + 1));
    }
    return false;
  };
  try {
    return await withTimeout(run(), boundMs, "withdraw timed out");
  } catch (e) {
    cancelled = true;
    log.warn(`withdraw: ${errText(e)}`);
    return false;
  }
}

/** Tab close / session end: tombstone via fetch keepalive (survives the page going away; needs no
 *  running client). Resolves true once the server accepted it. */
export function withdrawKeepalive(roomId: string, boundMs = 3000): Promise<boolean> {
  const s = getSession();
  const token = getAccessToken();
  if (!s.hsUrl || !s.userId || !s.deviceId || !token || !bearerAllowed(s.hsUrl)) return Promise.resolve(false);
  const url = `${s.hsUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(MEMBER_TYPE)}/${encodeURIComponent(
    ownStateKey(s.userId, s.deviceId),
  )}`;
  try {
    return fetch(url, {
      method: "PUT",
      keepalive: true,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(boundMs),
    })
      .then((r) => r.ok)
      .catch(() => false);
  } catch {
    return Promise.resolve(false); // page is going away
  }
}

/**
 * Start-up sweep: any live membership in a joined room whose state key is OURS while we are not in
 * a call → tombstone it (a killed tab otherwise leaves a 4 h ghost that peers keep keying).
 */
export async function sweepOwnGhosts(skipRoom: string | null, stillIdle: (roomId: string) => boolean = () => true): Promise<void> {
  const c = peekClient();
  const s = getSession();
  if (!c || !s.userId || !s.deviceId) return;
  const key = ownStateKey(s.userId, s.deviceId);
  // our OWN device's membership only — never the phone app's native call device (features/native/membership.ts)
  if (!pageOwnsMembership(key, s.userId, s.deviceId, nativeDeviceId())) return;
  for (const r of c.getRooms()) {
    if (r.getMyMembership() !== "join" || r.roomId === skipRoom) continue;
    const ev = r.currentState.getStateEvents(MEMBER_TYPE, key);
    if (!ev || !contentLive(ev.getContent() as Content, ev.getTs())) continue;
    if (!stillIdle(r.roomId)) continue; // a join started meanwhile
    log.info(`sweeping our stale membership in ${r.roomId}`);
    await withdrawMembership(r.roomId).catch(() => false);
  }
}
