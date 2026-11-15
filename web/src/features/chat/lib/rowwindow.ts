// rowwindow.ts — which loaded rows of a conversation are in the DOM (web-perf-2). ConversationView renders rows
// [start, end) of its row list; these pure helpers pick the window: the newest WIN_INIT by default, WIN_STEP more per
// step as the reader scrolls (older or newer), at most WIN_MAX at once (the far side trimmed, never past a kept row = the
// focused one / the last on screen), a window around one row for jumps and the scroll memory. Ids, not indices: older
// pages and new messages shift every index. Web only (the desktop's ListView creates only the delegates it shows).
// Tests: rowwindow.test.ts.

/** The row window: rows in the DOM at the end of the room, rows added per step, most rows in the DOM at once. */
export const WIN_INIT = 50;
export const WIN_STEP = 50;
export const WIN_MAX = 200;
/** `start` = the first row in the DOM (null = the newest WIN_INIT; HEAD = the first loaded row), `end` = the last
 *  (null = the newest row: the tail is shown). Ids, not indices: older pages and new messages shift the indices. */
export interface RowWindow {
  start: string | null;
  end: string | null;
}
export const HEAD = "\u0000head";
export const TAIL: RowWindow = { start: null, end: null };
/** [start, end) of the rows in the DOM. */
export function windowRange(rows: readonly { id: string }[], w: RowWindow): [number, number] {
  const idx = (id: string) => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].id === id) return i;
    return -1;
  };
  let end = rows.length;
  if (w.end) {
    const e = idx(w.end);
    if (e >= 0) end = e + 1;
  }
  let start: number;
  if (w.start === HEAD) start = 0;
  else if (w.start) {
    const s0 = idx(w.start);
    start = s0 >= 0 && s0 < end ? s0 : Math.max(0, end - WIN_INIT);
  } else start = Math.max(0, end - WIN_INIT);
  return [start, end];
}
/** A window of about WIN_STEP rows each side of row i (a jump, a restored scroll position). */
export function windowAround(rows: readonly { id: string }[], i: number): RowWindow {
  const s0 = Math.max(0, i - WIN_STEP);
  const e0 = Math.min(rows.length, i + WIN_STEP + 1);
  return { start: s0 === 0 ? HEAD : rows[s0].id, end: e0 >= rows.length ? null : rows[e0 - 1].id };
}
/** Grow the window by WIN_STEP older rows (rows above in memory); the far (newer) side is trimmed to WIN_MAX, never past
 *  `keep` (a focused row). null = nothing older in memory. */
export function windowOlder(rows: readonly { id: string }[], w: RowWindow, keep = -1): RowWindow | null {
  const [start, end] = windowRange(rows, w);
  if (start <= 0) return null;
  const ns = Math.max(0, start - WIN_STEP);
  let ne = end;
  if (ne - ns > WIN_MAX) ne = Math.max(ns + WIN_MAX, keep + 1);
  return { start: ns === 0 ? HEAD : rows[ns].id, end: ne >= rows.length ? null : rows[ne - 1].id };
}
/** Grow the window by WIN_STEP newer rows (the tail is hidden); the far (older) side is trimmed to WIN_MAX, never past
 *  `keep`. null = the tail is already shown. */
export function windowNewer(rows: readonly { id: string }[], w: RowWindow, keep = -1): RowWindow | null {
  const [start, end] = windowRange(rows, w);
  if (end >= rows.length) return null;
  const ne = Math.min(rows.length, end + WIN_STEP);
  let ns = start;
  if (ne - ns > WIN_MAX) ns = Math.min(ne - WIN_MAX, keep >= 0 ? keep : Number.MAX_SAFE_INTEGER);
  return { start: ns === 0 ? HEAD : rows[ns].id, end: ne >= rows.length ? null : rows[ne - 1].id };
}
