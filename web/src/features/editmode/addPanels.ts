// addPanels.ts — the pure parts of the toolbar's Add button ▾ / Add drawer ▾ panels (EDITMODE-UI §7.2, §7.3; the
// desktop's EditToolbar.qml buttonPanel.rows / drawerPanel.icons): the drawer of actions filtered by the search into
// group headers + rows, and the drawer button's icon faces in the panel's order.
import type { DrawerGroup, DrawerItem } from "@/actions/evaluate";

export type ActionRow = { head: true; label: string; group: string } | { head: false; item: DrawerItem };

/** The desktop's filter: a label that contains the trimmed, lower-cased search; empty groups are left out. The drawer
 *  action is not offered: Add drawer places it, with its island. */
export function actionRows(groups: DrawerGroup[], query: string): ActionRow[] {
  const q = query.trim().toLowerCase();
  const out: ActionRow[] = [];
  for (const g of groups) {
    const items = g.items.filter((it) => it.a !== "layout.drawer.toggle" && (!q || String(it.label).toLowerCase().includes(q)));
    if (!items.length) continue;
    out.push({ head: true, label: g.label, group: g.group });
    for (const item of items) out.push({ head: false, item });
  }
  return out;
}

/** The drawer button's icons, in the panel's order (the action's `icon` param — session.ts DRAWER_ICONS). */
export const DRAWER_ICON_FACES: readonly { id: string; icon: string }[] = [
  { id: "drawer", icon: "sidebar-expand-left-symbolic" },
  { id: "star", icon: "starred-symbolic" },
  { id: "music", icon: "emblem-music-symbolic" },
  { id: "games", icon: "applications-games-symbolic" },
  { id: "people", icon: "system-users-symbolic" },
  { id: "chat", icon: "dialog-messages-symbolic" },
  { id: "calendar", icon: "view-calendar-symbolic" },
  { id: "grid", icon: "view-grid-symbolic" },
  { id: "info", icon: "documentinfo-symbolic" },
  { id: "pin", icon: "pin-symbolic" },
];

/** The new button's looks (the row's `look`). */
export const BUTTON_LOOKS: readonly { id: string; label: string }[] = [
  { id: "icon", label: "Icon" },
  { id: "iconLabel", label: "Icon and label" },
  { id: "label", label: "Label" },
];
