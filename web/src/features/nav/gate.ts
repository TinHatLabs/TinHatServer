// gate.ts — the web equivalents of the native screenshot/test hooks (NAV-121; qml/Main.qml:750-791,
// 4397-4450, 8279-8286): `TINHAT_GUI_OPENROOM=index|!id|panel|info|space:<id>:<tab>|selectspace:<id>`,
// `TINHAT_GUI_DOCK=corner`, `--tinhat-settings`, `--tinhat-pane=N`. On the web they are URL query
// params (search or the hash query), honoured only in dev builds or with `gate=1`:
//   navmode=persistent|corner   force the nav mode (persisted, like the Appearance radios)
//   dock=corner                 = navmode=corner; dock=open additionally pins the dock open
//   openroom=<n>|!id|panel|info open the n-th room of the nav list / a room id; panel/info open the
//                               first room with its right panel (members / info)
//   openroom=space:<id>:<tab>   Space settings of <id> on <tab>
//   selectspace=<key>           select a rail entry (home|favourites|people|orphans|!space) and keep
//                               the room page closed (the no-room persistent state)
//   settings=1 [&pane=N]        open Settings (optionally on pane id/number N)
//   notour=1                    never auto-show the tour
import { bus, openSettings } from "@/core/bus";
import { setPref } from "@/core/prefs";
import { selectSpace, useNavStore } from "./model";
import { openRoomId } from "./open";

function params(): URLSearchParams {
  const p = new URLSearchParams(location.search);
  const hq = location.hash.indexOf("?");
  if (hq >= 0) new URLSearchParams(location.hash.slice(hq + 1)).forEach((v, k) => p.set(k, v));
  return p;
}

export const gateOn = (): boolean => import.meta.env.DEV || params().get("gate") === "1";
export const gateParam = (k: string): string | null => (gateOn() ? params().get(k) : null);

/** Before the first render: the layout-affecting hooks (nav mode). */
export function applyEarlyGateHooks(): void {
  if (!gateOn()) return;
  const mode = params().get("navmode") ?? (params().get("dock") ? "corner" : null);
  if (mode === "corner" || mode === "persistent") setPref("nav_mode", mode);
}

/** After the first sync (r.onReady): room / space / settings hooks. */
export function applyReadyGateHooks(): void {
  if (!gateOn()) return;
  const p = params();
  const sel = p.get("selectspace");
  const open = p.get("openroom");
  // wait for the nav model's first snapshot (≤ 10 s)
  let tries = 0;
  const t = window.setInterval(() => {
    const st = useNavStore.getState();
    if (!st.loaded && ++tries < 50) return;
    window.clearInterval(t);
    if (sel) selectSpace(sel);
    if (open) {
      if (open.startsWith("space:")) {
        const [, id, tab] = open.split(":").length > 3 ? ["", open.slice(6, open.lastIndexOf(":")), open.slice(open.lastIndexOf(":") + 1)] : open.split(":");
        if (id) bus.emit("openSpaceSettings", { spaceId: id, tab: tab || "overview" });
      } else if (open.startsWith("!")) openRoomId(open);
      else {
        const rows = useNavStore.getState().rooms.filter((r) => r.membership === "join");
        const n = /^\d+$/.test(open) ? Number(open) : 0;
        const row = rows[n] ?? rows[0];
        if (row) {
          openRoomId(row.id);
          if (open === "panel" || open === "info") {
            window.setTimeout(() => bus.emit("openRightPanel", { roomId: row.id, tab: open === "panel" ? "members" : "info" }), 600);
          }
        }
      }
    }
    if (p.get("settings") === "1") openSettings(p.get("pane") ?? undefined);
  }, 200);
}
