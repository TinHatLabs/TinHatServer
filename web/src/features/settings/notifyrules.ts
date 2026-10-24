// notifyrules.ts — the in-page notification engine's per-room decision (native notify.rs:393-700 + REACH A5.4
// + the web review), pure: no imports and no clock, so notifyrules.test.ts runs under plain Node type stripping.
// notify.ts feeds one observation per joined room per scan.
//
//   • before the baseline (the first NETWORK sync, and again after a resume from suspension): seed silently;
//   • a room already in the baseline fires on a RISE of its count (all → notification count, mentions →
//     highlight count), never while muted or attended, at most once per 5 s per room;
//   • a mode change of a known room seeds silently (switching a busy room to All must not replay it);
//   • a room that APPEARS after the baseline (a new DM, a room just joined) counts from 0 — its first message
//     notifies (web review #16); a new DM is often filed in m.direct a moment after it appears (mentions → all):
//     for FRESH_MS after it appeared that mode change still counts from 0.

export type Mode = "all" | "mentions" | "mute";

export interface RoomSeen {
  count: number;
  mode: Mode;
  lastFire: number;
  /** when a room that appeared after the baseline was first seen (cleared after FRESH_MS or its first alert) */
  fresh?: number;
}

export interface Observation {
  count: number;
  mode: Mode;
  /** the room is on screen and the window has focus */
  attended: boolean;
}

/** The room's own push rule, as far as the push is concerned: "sound" = a room rule that notifies with a sound (our
 *  "All messages"), "quiet" = any other room rule (our "Mentions": no actions), "none" = no room rule. */
export type RoomRule = "sound" | "quiet" | "none";

/**
 * REACH A5.4 + 2026-10-23 (rooms are encrypted by default): will the web push really bring the alert this room's rise
 * is about? While the page is hidden and push is on here, the page leaves alerts to the push — but the gateway pushes
 * only what Synapse's push rules give a highlight or a sound, and Synapse can't see inside an ENCRYPTED event: there a
 * mention is never a highlight, and only a sound room rule ("All messages") or, with no room rule, a 2-member room
 * (.m.rule.encrypted_room_one_to_one) makes a sound. Unencrypted: a mention always highlights (a "mentions" room's
 * rise is one; in an "all" room `highlightRose` = the highlight count rose with it); anything else needs the same
 * sound. When this says no, the page alerts itself even while hidden.
 */
export function pushCovers(o: { encrypted: boolean; mode: Mode; rule: RoomRule; members: number; highlightRose?: boolean }): boolean {
  if (!o.encrypted && (o.mode === "mentions" || o.highlightRose === true)) return true;
  return o.rule === "sound" || (o.rule === "none" && o.members === 2);
}

export const ROOM_GAP_MS = 5_000;
export const FRESH_MS = 120_000;

/** One room at one scan → its next state, and the rise that may fire (0 = nothing to say). The caller still
 *  applies the global cap; when it fires it stamps `lastFire` (and drops `fresh`) itself. */
export function stepRoom(prev: RoomSeen | undefined, o: Observation, seeded: boolean, now: number): { next: RoomSeen; rise: number } {
  if (!seeded) return { next: { count: o.count, mode: o.mode, lastFire: prev?.lastFire ?? 0 }, rise: 0 };
  let base: RoomSeen;
  if (!prev) base = { count: 0, mode: o.mode, lastFire: 0, fresh: now };
  else if (prev.mode !== o.mode) {
    if (prev.fresh !== undefined && now - prev.fresh < FRESH_MS) base = { ...prev, count: 0, mode: o.mode };
    else return { next: { count: o.count, mode: o.mode, lastFire: prev.lastFire }, rise: 0 };
  } else base = prev;
  const next: RoomSeen = { ...base, count: o.count };
  if (next.fresh !== undefined && now - next.fresh >= FRESH_MS) delete next.fresh;
  const rise = o.count - base.count;
  if (rise <= 0 || o.mode === "mute" || o.attended) return { next, rise: 0 };
  if (now - base.lastFire < ROOM_GAP_MS) return { next, rise: 0 };
  return { next, rise };
}
