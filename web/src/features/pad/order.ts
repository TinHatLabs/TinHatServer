// order.ts — the room-list bar's order (Entry.tsx PadRoomListBar): of the calls one of my OTHER devices is in, the one
// whose newest membership (the first target: padTargets sorts newest first) is newest comes first; ties by room id in
// code-point order. A call with no target is left out. The desktop's pad_engine::calls_newest_first is the same rule
// (the same cases in both tests: order.test.ts here, `the_room_list_bar_shows_the_newest_call` there).
export interface CallTargets {
  room: string;
  targets: ReadonlyArray<{ createdTs: number }>;
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

export function callsNewestFirst<T extends CallTargets>(calls: readonly T[]): T[] {
  return calls
    .filter((c) => c.targets.length > 0)
    .slice()
    .sort((a, b) => (b.targets[0].createdTs || 0) - (a.targets[0].createdTs || 0) || cmpCodePoints(a.room, b.room));
}
