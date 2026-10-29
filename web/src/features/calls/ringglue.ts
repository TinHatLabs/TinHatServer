// ringglue.ts — DM ringing, the web's half of the client glue (share claude/tinhat-android/RINGING.md §4 / §5; the
// server rings phones and closed browsers, the page keeps ringing in-app). Pure (imports only the shared live-session
// rule, callrules.ts): unit-tested under Node
// (ringglue.test.ts, shared vectors testvectors/ringdecline.json), mirrored by the desktop's crates/app/src/ringglue.rs.
//
// Decline: the callee's device sends the room event `dev.tinhat.call.decline` `{ring}` (encrypted in an encrypted DM;
// the mobile core's send_call_decline, ring = the caller's call.member event id the server rang with). The caller's
// call shows "<name> declined" and plays the end tone; the callee's OTHER devices drop their incoming card.

import { sessionsFrom, type RawMemberEvent } from "./callrules";

export const CALL_DECLINE_TYPE = "dev.tinhat.call.decline";
/** A decline counts only this close to now, either way (the server keeps a ring declinable for 60 s). */
export const DECLINE_FRESH_MS = 60_000;

/** The core's call_decline_content rule: "$" + 1..254 more UTF-8 bytes, no control or white-space characters. */
export function ringIdOk(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 2 || v[0] !== "$") return false;
  if (/[\p{Cc}\p{White_Space}]/u.test(v)) return false;
  return new TextEncoder().encode(v).length <= 255;
}

export interface DeclineCtx {
  me: string;
  now: number;
  /** the event's room is a two-person room (the server rings DMs only; nobody else can speak for "the callee") */
  dm: boolean;
  /** the decliner's room membership is `join` (someone who has left can't decline; fix/left-member's join-only rule) */
  senderJoined: boolean;
  /** I am in, or joining, the call of the event's room */
  inCallHere: boolean;
  /** my incoming-call card for the event's room is up */
  cardUp: boolean;
  /** ringSets().own: MY live call.member event ids in the room (the ring I may have rung someone with) */
  ownRings: readonly string[];
  /** ringSets().live: the joined others' live call.member event ids (the ring I'm being rung with) */
  liveRings: readonly string[];
}

export type DeclineOutcome = "declined" | "dismiss" | "none";

/** What a room event means to this device (the vectors' table). */
export function declineOutcome(ev: unknown, ctx: DeclineCtx): DeclineOutcome {
  if (!ev || typeof ev !== "object") return "none";
  const e = ev as { type?: unknown; sender?: unknown; origin_server_ts?: unknown; content?: unknown };
  if (e.type !== CALL_DECLINE_TYPE) return "none";
  const sender = e.sender;
  if (typeof sender !== "string" || !sender) return "none";
  const ts = e.origin_server_ts;
  if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(ctx.now - ts) > DECLINE_FRESH_MS) return "none";
  const c = e.content;
  if (!c || typeof c !== "object" || Array.isArray(c)) return "none";
  const ring = (c as { ring?: unknown }).ring;
  if (!ringIdOk(ring) || !ctx.dm || !ctx.senderJoined) return "none";
  if (sender === ctx.me) return ctx.cardUp && ctx.liveRings.includes(ring) ? "dismiss" : "none";
  return ctx.inCallHere && ctx.ownRings.includes(ring) ? "declined" : "none";
}

/** How long "<name> declined" stays on screen (ms; desktop ringglue.rs DECLINED_SHOWN_MS, the vectors'
 *  `declinedShownMs`). Transient for people; gates read the `[callwatch] ring in … declined by …` log line or
 *  `<html data-th-declined>` (tools/README-gates.md), which stay. */
export const DECLINED_SHOWN_MS = 6000;

/** The words the caller sees (desktop ringglue.rs `declined_text`: the same). */
export function declinedText(name: string): string {
  const n = name.trim();
  return `${n || "They"} declined`;
}

/** The call.member event ids a ring may name: the room's call.member state events (`event_id` added) that are live
 *  sessions (callrules.ts sessionsFrom, the shared rule) of senders whose membership is exactly `join` (unknown counts
 *  as not joined here: a departed caller's ring names nobody). `own` = mine, `live` = the others', in event order. */
export function ringSets(
  events: ReadonlyArray<RawMemberEvent & { event_id?: unknown }>,
  membershipOf: (userId: string) => string | null | undefined,
  me: string,
  now: number,
): { own: string[]; live: string[] } {
  const own: string[] = [];
  const live: string[] = [];
  for (const ev of events) {
    const id = ev?.event_id;
    if (typeof id !== "string" || !id || typeof ev.sender !== "string") continue;
    if (membershipOf(ev.sender) !== "join") continue;
    const s = sessionsFrom([ev], "", now)[0];
    if (!s || s.stateKey !== ev.state_key) continue;
    (ev.sender === me ? own : live).push(id);
  }
  return { own, live };
}
