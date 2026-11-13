// order.ts — the room-list bar's order (Entry.tsx PadRoomListBar): of the calls one of my OTHER devices is in, a call
// with a READY target (one the Pad can drive now) comes before a call whose every target is greyed (this device not
// verified, that device untrusted, an older Tin Hat or Pad off there); within each group the one whose newest
// membership (the first target: padTargets sorts newest first) is newest comes first; ties by room id in code-point
// order. A call with no target is left out. (QA 12.1.11 D2: a stale or older device's newer call used to hide the call
// the Pad can actually drive.) The desktop's pad_engine::calls_newest_first is the same rule (the same cases in both
// tests: order.test.ts here, `the_room_list_bar_shows_the_newest_call` there).
//
// The bar shows one call at a time; with more than one, its "1/2" button steps to the next (nextCall: the call after the
// shown one in this order, wrapping; a shown call that went away → the first, and the pick is forgotten (keptPick), so
// a later call in that room never takes the bar back by itself). The desktop's PadBar.qml does the same.
export interface CallTargets {
  room: string;
  targets: ReadonlyArray<{ createdTs: number; ready?: boolean }>;
}

function cmpCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

const anyReady = (c: CallTargets): number => (c.targets.some((t) => t.ready === true) ? 1 : 0);

export function callsNewestFirst<T extends CallTargets>(calls: readonly T[]): T[] {
  return calls
    .filter((c) => c.targets.length > 0)
    .slice()
    .sort((a, b) => anyReady(b) - anyReady(a) || (b.targets[0].createdTs || 0) - (a.targets[0].createdTs || 0) || cmpCodePoints(a.room, b.room));
}

/** The index of the call the bar shows: `picked` (a room id) while it is still in `rooms`, else 0. */
export function shownCall(rooms: readonly string[], picked: string): number {
  const i = picked ? rooms.indexOf(picked) : -1;
  return i < 0 ? 0 : i;
}

/** The room the "1/2" button steps to: the one after the shown call, wrapping ("" = no calls). */
export function nextCall(rooms: readonly string[], picked: string): string {
  if (rooms.length === 0) return "";
  return rooms[(shownCall(rooms, picked) + 1) % rooms.length];
}

/** The pick to keep after the calls changed: `picked` while its room is still in `rooms`, else "" (forgotten). */
export function keptPick(rooms: readonly string[], picked: string): string {
  return picked && rooms.includes(picked) ? picked : "";
}
