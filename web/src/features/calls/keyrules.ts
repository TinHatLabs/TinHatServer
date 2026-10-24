// keyrules.ts — the pure media-key trust rules (Astra calls review 2026-09-23, findings 1-3; the
// native 10.4.2 bar). No imports: unit-tested under Node (`node src/features/calls/keyrules.test.ts`).
//
// Intake (`checkKeyEvent`) — a peer's `io.element.call.encryption_keys` is installed only when ALL hold:
//   1. it arrived Olm-encrypted to-device (the SDK's OlmEncryptionInfo is present) — never plaintext,
//      never a room event (the legacy room-event intake was removed);
//   2. the Olm sender is the event sender, and the SDK bound the Curve25519 sender key to a KNOWN
//      device of that user (`senderDevice`); the payload's claimed device must be that device;
//   3. `room_id` is the call we are in / joining;
//   4. the sender is a joined member of that room and (sender, device) holds a live, well-formed call
//      membership there. A key that is otherwise valid but whose membership has not synced yet is
//      "pending" (held briefly, re-checked), never installed on trust;
//   5. it is not under our own identity.
// Announce (`keyRecipients`) — our key goes only to live call-member devices whose user is a JOINED
// room member, never to ourselves; the caller re-runs the check right before queueing.

export interface OlmInfoLike {
  sender: string;
  senderDevice?: string | null;
  senderCurve25519KeyBase64?: string;
}

export interface IntakeCtx {
  /** the call room we are in / joining ("" = none) */
  callRoomId: string;
  ownUserId: string;
  ownDeviceId: string;
  /** `${userId}|${deviceId}` of every live, well-formed call membership in callRoomId */
  liveMembers: ReadonlySet<string>;
  /** membership of a user in callRoomId: "join" | "leave" | ... | null (not loaded / unknown) */
  membershipOf: (userId: string) => string | null;
}

export type IntakeVerdict =
  | { ok: true; sender: string; device: string; roomId: string }
  | { ok: false; pending: boolean; reason: string };

type Content = Record<string, unknown>;

const reject = (reason: string): IntakeVerdict => ({ ok: false, pending: false, reason });
const pending = (reason: string): IntakeVerdict => ({ ok: false, pending: true, reason });

/** The member.id a key may be installed under (hashed MSC4143 form): a derived form, or the exact
 *  `membershipID` of that device's live membership — anything else falls back to `sender:device`, so a
 *  member can't mint unlimited identities by varying member.id. */
export function boundMemberId(memberIdIn: unknown, sender: string, device: string, liveMembershipId: string): string {
  const colon = `${sender}:${device}`;
  const m = typeof memberIdIn === "string" ? memberIdIn : "";
  if (m && (m === colon || m === `_${sender}_${device}` || (liveMembershipId && m === liveMembershipId))) return m;
  return colon;
}

/** The device the payload claims (`member.claimed_device_id`, else `device_id`). */
export function claimedDevice(content: Content): string {
  const member = content.member && typeof content.member === "object" ? (content.member as Content) : undefined;
  if (typeof member?.claimed_device_id === "string" && member.claimed_device_id) return member.claimed_device_id;
  if (typeof content.device_id === "string" && content.device_id) return content.device_id;
  return "";
}

export function checkKeyEvent(enc: OlmInfoLike | null | undefined, eventSender: string, content: Content, ctx: IntakeCtx): IntakeVerdict {
  if (!enc) return reject("plaintext key event — only Olm-encrypted to-device keys are trusted");
  const sender = enc.sender || "";
  if (!sender || (eventSender && eventSender !== sender)) return reject(`Olm sender ${sender || "?"} ≠ event sender ${eventSender || "?"}`);
  const device = enc.senderDevice || "";
  const claimed = claimedDevice(content);
  if (!claimed) return reject("no claimed device id");
  if (!device) return pending(`the sending device of ${sender} is not bound to a known device yet (claims ${claimed})`);
  if (claimed !== device) return reject(`claimed device ${claimed} ≠ Olm-authenticated device ${device}`);
  const roomId = typeof content.room_id === "string" ? content.room_id : "";
  if (!roomId) return reject("no room_id");
  if (!ctx.callRoomId || roomId !== ctx.callRoomId) return reject(`key for ${roomId}, not our call (${ctx.callRoomId || "none"})`);
  if (sender === ctx.ownUserId && device === ctx.ownDeviceId) return reject("a key from our own device");
  const ms = ctx.membershipOf(sender);
  if (ms === null) return pending(`room membership of ${sender} not loaded yet`);
  if (ms !== "join") return reject(`${sender} is not a joined member of the call room (${ms})`);
  if (!ctx.liveMembers.has(`${sender}|${device}`)) return pending(`${sender}/${device} holds no live call membership (yet)`);
  return { ok: true, sender, device, roomId };
}

/** Is `stateKey` a membership state key owned by (sender, device)? (session form, EC legacy, array form) */
export function stateKeyOwned(stateKey: string, sender: string, device: string, arrayForm: boolean): boolean {
  if (!sender) return false;
  if (arrayForm) return stateKey === sender; // legacy memberships[] live under the user's own key
  if (!device) return false;
  return stateKey === `_${sender}_${device}_m.call` || stateKey === `_${sender}_${device}` || stateKey === `${sender}_${device}` || stateKey === `${sender}_${device}_m.call`;
}

export interface MemberDevice {
  sender: string;
  deviceId: string;
  /** strict membership schema (rtc.ts LiveSession.wellFormed); false → never a key recipient */
  wellFormed?: boolean;
}

/** Who may receive our key: live call members' devices, joined to the room, not us; deduped. */
export function keyRecipients(
  live: readonly MemberDevice[],
  membershipOf: (userId: string) => string | null,
  ownUserId: string,
  ownDeviceId: string,
): Array<{ userId: string; deviceId: string }> {
  const out: Array<{ userId: string; deviceId: string }> = [];
  const seen = new Set<string>();
  for (const m of live) {
    if (!m.sender || !m.deviceId || m.wellFormed === false) continue;
    if (m.sender === ownUserId && m.deviceId === ownDeviceId) continue;
    if (membershipOf(m.sender) !== "join") continue;
    const k = `${m.sender}|${m.deviceId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ userId: m.sender, deviceId: m.deviceId });
  }
  return out;
}

/** Valid own/peer key index: an integer 0..254 (255 is refused, like native). */
export function validIndex(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number" && Number.isInteger(v)) n = v;
  else if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) n = Number(v.trim());
  if (n === null || n < 0 || n > 254) return null;
  return n;
}

/** Per-device cap on distinct key indices held (oldest evicted) — no member can exhaust the registry. */
export const MAX_INDICES_PER_DEVICE = 8;
