// roomsort.ts — the room list's order (nav.rs sort_rooms), pure: no app imports, so roomsort.test.ts replays the shared
// vectors (testvectors/room-sort.json, a byte copy of the desktop's) under plain Node. model.ts re-exports it.

/** The fields the order reads (model.ts RoomRow has them all). */
export interface SortRow {
  id: string;
  name: string;
  membership?: string;
  dm: boolean;
  favourite: boolean;
  call: boolean;
  unread: number;
  highlight: boolean;
  muted: boolean;
  recency: number | null;
}

/** nav.rs sort_rooms — stable, highest first: invites, then what is personal and new (an unread DM or, D03.3, an
 *  unread mention), favourites, a call, anything unread, recency, name (shared vectors testvectors/room-sort.json). */
export function sortRooms<R extends SortRow>(rows: R[]): R[] {
  const unreadOf = (r: SortRow) => !r.muted && r.unread > 0;
  const personalOf = (r: SortRow) => unreadOf(r) && (r.dm || r.highlight);
  const idx = new Map(rows.map((r, i) => [r.id, i]));
  return [...rows].sort((a, b) => {
    const t = (x: boolean, y: boolean) => Number(y) - Number(x);
    return (
      t(a.membership === "invite", b.membership === "invite") ||
      t(personalOf(a), personalOf(b)) ||
      t(a.favourite, b.favourite) ||
      t(a.call, b.call) ||
      t(unreadOf(a), unreadOf(b)) ||
      (a.recency !== null && b.recency !== null
        ? b.recency - a.recency
        : a.recency !== null
          ? -1
          : b.recency !== null
            ? 1
            : 0) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
      idx.get(a.id)! - idx.get(b.id)!
    );
  });
}
