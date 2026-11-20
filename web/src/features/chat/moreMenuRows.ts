// moreMenuRows.ts — the room menu rows the phone room header's ⋯ More sheet repeats (12.1.17). Pure (types only), so
// the unit tests run it over stand-in registry rows; RoomPage.tsx draws each one as a labelled sheet row.
import type { MenuContribution, RoomMenuCtx } from "@/core/registry";

/** Room menu rows the phone's ⋯ More sheet repeats, so they're reachable from the room screen (12.1.17: on a phone the
 *  room menu is only the room list's long press, and Chat background was hard to find). Each keeps the room menu's
 *  words, icon, visibility and action (the sheet itself shows what you may change); the desktop header is unchanged. */
export const PHONE_MORE_ROOM_MENU: readonly string[] = ["chat.background"];

interface MoreMenuRow {
  id: string;
  label: string;
  icon: string;
  run: () => void;
}
export function phoneMoreMenuRows(items: readonly MenuContribution<RoomMenuCtx>[], ctx: RoomMenuCtx): MoreMenuRow[] {
  const out: MoreMenuRow[] = [];
  for (const id of PHONE_MORE_ROOM_MENU) {
    const it = items.find((x) => x.id === id);
    if (!it || it.submenu || (it.visible && !it.visible(ctx)) || (it.enabled && !it.enabled(ctx))) continue;
    const label = typeof it.label === "function" ? it.label(ctx) : it.label;
    const icon = (typeof it.icon === "function" ? it.icon(ctx) : it.icon) ?? "overflow-menu-symbolic";
    out.push({ id, label, icon, run: () => it.run(ctx) });
  }
  return out;
}
