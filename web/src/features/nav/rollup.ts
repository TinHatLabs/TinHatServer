// rollup.ts — REACH A5.3: every badge counts what the room rows show. A row's number is its
// settings-adjusted unread: 0 for a muted room, the highlight count for a mentions-only room, the
// notification count for an all-messages room or a DM; space rooms never count. The rail rollups (meta
// and space bubbles), the corner-dock badge and the global badge are sums of those numbers; the red flag is
// any unmuted row with highlights. Pure (no imports): rollup.test.ts mirrors the desktop's rollup_adjusted.

export type RowMode = "all" | "mentions" | "mute";

export interface RollupRow {
  mode: RowMode;
  /** the server's notification_count */
  notif: number;
  /** the server's highlight_count */
  highlight: number;
  isSpace: boolean;
}

/** The number a row shows (A5.3). */
export function adjustedUnread(r: RollupRow): number {
  if (r.isSpace || r.mode === "mute") return 0;
  return r.mode === "mentions" ? r.highlight : r.notif;
}

/** The sum and the red flag over rows (spaces skipped). */
export function rollup(rows: readonly RollupRow[]): { total: number; highlight: boolean } {
  let total = 0;
  let highlight = false;
  for (const r of rows) {
    if (r.isSpace) continue;
    total += adjustedUnread(r);
    if (r.mode !== "mute" && r.highlight > 0) highlight = true;
  }
  return { total, highlight };
}
