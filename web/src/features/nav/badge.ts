// badge.ts — REACH A5.10: the app badge (taskbar / dock / home-screen count) is the number of rooms that are not
// spaces and are either joined with a settings-adjusted unread (A5.3, rollup.ts) above 0, or a pending DM invite.
// One room counts one whatever its number; no cap (the OS draws its own "99+" if it wants one). Pure (no imports):
// the desktop's app_badge.rs is the same rule over the same shared vectors (testvectors/app-badge.json, byte copy).

export interface BadgeRow {
  id: string;
  /** "join" | "invite" (anything else never counts) */
  membership: string;
  isSpace: boolean;
  dm: boolean;
  /** the row's settings-adjusted unread (A5.3); an invite's row shows 0 */
  unread: number;
}

/** The ids the badge counts, in input order. */
export function appBadgeRooms(rows: readonly BadgeRow[]): string[] {
  return rows.filter((r) => !r.isSpace && ((r.membership === "join" && r.unread > 0) || (r.membership === "invite" && r.dm))).map((r) => r.id);
}

/** The badge number. */
export function appBadgeCount(rows: readonly BadgeRow[]): number {
  return appBadgeRooms(rows).length;
}

/** Badge text: "" at 0, "99+" above 99 (the desktop's nav::badge_text). */
export function badgeText(total: number): string {
  return total === 0 ? "" : total > 99 ? "99+" : String(total);
}

/** The corner / global badge text (A5.3 + A5.1): the sum of the joined non-space rows' adjusted unread plus 1 per
 *  pending DM invite (like the People bubble). The desktop's app_badge::global_badge; shared vectors: each case's
 *  `global`. */
export function globalBadge(rows: readonly BadgeRow[]): string {
  let total = 0;
  for (const r of rows) {
    if (r.isSpace) continue;
    if (r.membership === "join") total += r.unread;
    else if (r.membership === "invite" && r.dm) total += 1;
  }
  return badgeText(total);
}
