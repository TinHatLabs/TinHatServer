// markread.ts — Mark all as read (A11.2 / A11.3 / D03.8): which unread rooms a rail key covers and the words shown when
// it is done — the desktop's nav.rs mark_read_owns / mark_read_note, replayed on a byte copy of its vectors
// (testvectors/mark-read.json, markread.test.ts). No app imports (Node unit tests).

/** `parented` = the room is in a space; `inKey` = it is the space `key` or in it. */
export interface MarkReadRoom {
  space?: boolean;
  dm?: boolean;
  fav?: boolean;
  parented?: boolean;
  inKey?: boolean;
}

export function markReadOwns(key: string, r: MarkReadRoom): boolean {
  if (r.space) {
    // A5.3: a space's own count goes with Home, and with itself / the space above it
    return key === "home" || (key !== "favourites" && key !== "people" && key !== "orphans" && !!r.inKey);
  }
  switch (key) {
    case "home":
      return !r.parented || !!r.dm;
    case "favourites":
      return !!r.fav;
    case "people":
      return !!r.dm;
    case "orphans":
      return !r.parented && !r.dm;
    default:
      return !!r.inKey;
  }
}

/** The note after Mark all as read (the same words on the desktop). */
export function markReadNote(label: string, marked: number, failed: number): string {
  const rooms = (n: number) => (n === 1 ? "1 room" : `${n} rooms`);
  if (marked === 0 && failed === 0) return `Nothing to mark as read in ${label}`;
  if (marked === 0) return `Couldn't mark ${label} as read — try again`;
  if (failed === 0) return `Marked ${rooms(marked)} in ${label} as read`;
  return `Marked ${rooms(marked)} in ${label} as read; ${rooms(failed)} couldn't be marked — try again`;
}
