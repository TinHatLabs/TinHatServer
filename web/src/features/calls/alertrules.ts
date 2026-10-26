// alertrules.ts — when an incoming-call alert may fire (native callwatch.rs `should_announce`, 10.5.1).
// Pure (no DOM / SDK imports) so `alertrules.test.ts` runs under plain Node.
import { padTargets } from "./pad/rules";
//
// A field report: alerts every few minutes while in a call. A room whose call keeps
// starting and stopping (test clients in a test room, a client that keeps
// reconnecting, a recorder retrying its join) raised a notify blip + desktop notification + card on
// EVERY rising edge, over and over while the user was in another call. Now a
// room alerts at most once per REANNOUNCE_MS; the room list still shows the live call.

/** A room that alerted is not announced again for this long (native `callwatch::REANNOUNCE`). */
export const REANNOUNCE_MS = 10 * 60 * 1000;
/** REACH A5.7: a DM rings again only after this gap (a caller reconnecting after an iOS suspension). */
export const DM_RING_GAP_MS = 45 * 1000;

/**
 * `last` = when this room last raised an alert (ms), `now` = current time (ms), `isDm` = the room is
 * in m.direct. A DM call is aimed at you, so a DM rings again after only DM_RING_GAP_MS (A5.7: 45 s —
 * a callback two minutes after a missed call still rings, a reconnect 30 s later doesn't).
 */
export function shouldAnnounce(last: number | undefined, now: number, isDm = false): boolean {
  if (last === undefined) return true;
  return now - last >= (isDm ? DM_RING_GAP_MS : REANNOUNCE_MS);
}

/** Forget rooms whose window has passed (keeps the map bounded over a long session; a DM's shorter gap
 *  is past too once the group window is). */
export function pruneAnnounced(announced: Map<string, number>, now: number): void {
  for (const [id, t] of announced) if (now - t >= REANNOUNCE_MS) announced.delete(id);
}

/**
 * Answered elsewhere (Pad phase 3, 2026-10-26): one of MY OTHER devices has a live, well-formed session in the room's
 * call — the call was taken on another device, so this device's incoming card goes and its ring stops (the room's
 * banner / the room-list bar then offer Pad · Join). The same liveness and ownership rule as Pad's discovery
 * (padTargets: the state key belongs to the sender and that device; created_ts + expires), whatever the device's trust
 * or caps. `events` = the room's raw `org.matrix.msc3401.call.member` state events ({sender, state_key,
 * origin_server_ts, content}). The desktop's callwatch.rs `answered_elsewhere` is the same rule (the same cases).
 */
export function answeredElsewhere(me: string, myDevice: string, now: number, events: readonly unknown[]): boolean {
  if (!me || !myDevice) return false;
  return padTargets(me, myDevice, now, false, [], events).length > 0;
}
