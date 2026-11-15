// roomFilter.ts — the room list's "Filter rooms…" field over the rows it shows (ACTIONS.md §10.8): the ONE shared matcher
// (src/actions/palette.ts roomFilterRun — the palette's folding: accents, separators; the name or the part before ":"
// of the room address / the DM's other person; is:unread, is:mention), byte-compatible with the desktop's
// (crates/actions, the palette/roomfilter.json vectors). P1 (2026-11-14): typing never opens a room — the first match is
// drawn highlighted and Enter (or a click) acts on it, as a click on that row does (open, or the join dialog).
import { roomFilterRun, type RoomFilterRow } from "../../actions/palette";
import { rowGesture } from "./rowGesture";

/** The fields of a room-list row the filter reads (model.ts RoomRow has them all). */
export interface FilterableRow {
  id: string;
  name: string;
  alias: string;
  peer: string;
  membership: string;
  unread: number;
  highlight: boolean;
}

/** A row as the shared matcher sees it (the desktop's ThRoomList builds the same from nav.rs's row JSON). */
export function filterRowOf(r: FilterableRow): RoomFilterRow {
  const aliases: string[] = [];
  if (r.alias) aliases.push(r.alias);
  if (r.peer) aliases.push(r.peer);
  return { name: r.name, aliases, membership: r.membership, unread: r.unread > 0, mention: r.highlight === true };
}

/** Which rows the filter shows (by id) and the first — highlighted, the one Enter acts on (null: none). */
export function filterRooms<R extends FilterableRow>(query: string, rows: R[]): { active: boolean; shown: Set<string>; first: R | null } {
  const run = roomFilterRun(query, rows.map(filterRowOf));
  const shown = new Set<string>();
  rows.forEach((r, i) => {
    if (run.shown[i]) shown.add(r.id);
  });
  return { active: run.filter.active, shown, first: run.first >= 0 ? (rows[run.first] as R) : null };
}

/** What Enter in the filter does: what a click on the first match does — "open" (joined) or "askJoin" (listed, not
 *  joined: the join dialog), else nothing (an empty filter, no match, only invites). */
export function filterEnter<R extends FilterableRow>(query: string, rows: R[]): { kind: "open" | "askJoin"; row: R } | null {
  const first = filterRooms(query, rows).first;
  if (!first) return null;
  const g = rowGesture({ gesture: "click", membership: first.membership as "join" | "invite" | "none" });
  return g === "open" || g === "askJoin" ? { kind: g, row: first } : null;
}
