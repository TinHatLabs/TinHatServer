// menus.tsx — the app menu (☰, Main.qml:1854-1976), the room context menu (Main.qml:1444-1565)
// and the space context menu (Main.qml:880-940). The nav HOSTS all three as registries
// (r.appMenu / r.roomMenu / r.spaceMenu, sorted by `order`) and registers its own rows with the
// native orders; other features slot theirs in between (spec §7.2).
import { Fragment, useMemo } from "react";
import { bus, openSettings, openWindow, toast } from "@/core/bus";
import { getSession, getCryptoStatus, peekClient, useCryptoStatus } from "@/core/matrix";
import { getFormFactor } from "@/core/device";
import { serverFeatureOn } from "@/core/server";
import {
  menuValue,
  useRegistry,
  type AppMenuCtx,
  type MenuContribution,
  type Registries,
  type RoomMenuCtx,
  type SpaceMenuCtx,
} from "@/core/registry";
import { CheckMenuItem, Menu, MenuItem, MenuSeparator, MenuSectionLabel, SubMenu, type MenuAnchor } from "@/ui";
import { chooseTheme, recentThemes, useThemeState, type RecentTheme } from "@/ui/themeStore";
import { miniRoles, useLibrary } from "@/ui/themeLibrary";
import {
  canChangeAvatar,
  copyText,
  markRoomRead,
  markSpaceRead,
  removeRoomPhoto,
  roomInviteLink,
  setFavourite,
  setNotifyMode,
  setRecording,
  setRoomPhoto,
} from "./actions";
import { openNavDialog } from "./dialogs";
import { getCurrentRoom } from "./open";
import { refreshNow, useNavStore, type NotifyMode, type RoomRow } from "./model";
import { setNavMode, getNavMode, useNavMode } from "./navmode";
import { startTour } from "./Tour";
import { checkForUpdates, updateState, useUpdate } from "./update";
import { openAboutFallback } from "./sheets";
import mc from "./menus.module.css";

let registriesRef: Registries | null = null;

// ---- generic registry menu body --------------------------------------------------------------------

/** Rows where the nav's own row stays and another feature's row at the SAME order is dropped:
 *  "Settings…" (native shows no "Ctrl+," hint), the update row (the nav's version.json watcher also
 *  drives the banner, so the two can never disagree) and "Keyboard shortcuts…" (the nav hosts that
 *  dialog — INTEGRATION #1). Everywhere else the owning feature's row wins over the nav's fallback. */
const NAV_WINS = new Set(["nav.settings", "nav.update", "nav.shortcuts"]);

/** One row per `order` (INTEGRATION #2): the nav registers a working fallback at every native order
 *  and other features register the real row at the same order — keep exactly one of the two, in
 *  registry order, and keep the nav row's separator / section above whichever survives. */
export function dedupeMenuRows<T extends { id: string; order: number; separatorBefore?: boolean; section?: string }>(items: T[]): T[] {
  const isNav = (it: T) => it.id.startsWith("nav.");
  const byOrder = new Map<number, T[]>();
  for (const it of items) byOrder.set(it.order, [...(byOrder.get(it.order) ?? []), it]);
  const out: T[] = [];
  for (const it of items) {
    const group = byOrder.get(it.order)!;
    const nav = group.filter(isNav);
    const foreign = group.filter((x) => !isNav(x));
    if (!nav.length || !foreign.length) {
      out.push(it);
      continue;
    }
    const navWins = nav.some((x) => NAV_WINS.has(x.id));
    const keep = navWins ? nav : foreign;
    if (!keep.includes(it)) continue;
    const sep = group.some((x) => x.separatorBefore);
    const section = group.find((x) => x.section)?.section;
    out.push(it === keep[0] && ((sep && !it.separatorBefore) || (section && !it.section)) ? { ...it, separatorBefore: sep || it.separatorBefore, section: it.section ?? section } : it);
  }
  return out;
}

export function RegistryMenuItems<Ctx>({ items, ctx }: { items: MenuContribution<Ctx>[]; ctx: Ctx }) {
  const vis = dedupeMenuRows(items).filter((it) => (it.visible ? it.visible(ctx) : true));
  return (
    <>
      {vis.map((it, i) => {
        const label = menuValue(it.label, ctx);
        const icon = it.icon ? menuValue(it.icon, ctx) : undefined;
        const enabled = it.enabled ? it.enabled(ctx) : true;
        const sep = it.separatorBefore && i > 0;
        const sub = it.submenu?.(ctx);
        return (
          <Fragment key={it.id}>
            {sep && <MenuSeparator />}
            {it.section && <MenuSectionLabel text={it.section} />}
            {sub ? (
              <SubMenu title={label} icon={icon} disabled={!enabled}>
                {sub.map((si) => (
                  <Fragment key={si.id}>
                    {si.separatorBefore && <MenuSeparator />}
                    {si.checked !== undefined ? (
                      <CheckMenuItem text={si.label} icon={si.icon} checked={si.checked} disabled={si.enabled === false} trailing={si.swatch && <ThemeSwatch colours={si.swatch} />} onTriggered={si.run} />
                    ) : (
                      <MenuItem text={si.label} icon={si.icon} disabled={si.enabled === false} trailing={si.swatch && <ThemeSwatch colours={si.swatch} />} onTriggered={si.run} />
                    )}
                  </Fragment>
                ))}
              </SubMenu>
            ) : it.checked ? (
              <CheckMenuItem text={label} icon={icon} checked={it.checked(ctx)} disabled={!enabled} danger={it.danger} shortcut={it.shortcut} onTriggered={() => it.run(ctx)} />
            ) : (
              <MenuItem text={label} icon={icon} disabled={!enabled} danger={it.danger} shortcut={it.shortcut} onTriggered={() => it.run(ctx)} />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/** THEMES-UI §12: a ☰ Theme row's swatch — 30 × 16, radius 4, the row theme's window colour inside a 1 px border in its
 *  subtle border colour, three Ø6 dots (its accent, name 1, name 2) at x 5 / 12 / 19, y 5 (ThemeSwatch.qml on the
 *  desktop). `colours` = [fill, border, dot 1, dot 2, dot 3]. */
function ThemeSwatch({ colours }: { colours: readonly string[] }) {
  const [fill, border, ...dots] = colours;
  return (
    <span className={mc.swatch} style={{ background: fill, borderColor: border }} aria-hidden>
      {dots.map((c, i) => (
        <span key={i} className={mc.swatchDot} style={{ left: 4 + 7 * i, background: c }} />
      ))}
    </span>
  );
}

/** A theme row's swatch colours: the row theme's own roles (the gallery card's, cached per theme). */
function swatchOf(t: RecentTheme): string[] | undefined {
  const r = miniRoles(t.doc, t.library);
  if (!r.ok) return undefined;
  const k = r.roles;
  return [k["surface.window"], k["border.subtle"], k["accent.base"], k["name.1"], k["name.2"]];
}

// ---- hosts ---------------------------------------------------------------------------------------

export function AppMenu({ anchor, onClose, placement }: { anchor: MenuAnchor; onClose: () => void; placement?: "below" | "above" }) {
  const items = useRegistry("appMenu");
  // rows read these imperatively — re-render when they change while the menu is open
  useUpdate();
  useNavStore((st) => st.activeKey);
  useCryptoStatus();
  useNavMode();
  // the Theme ▸ rows (THEMES-UI §12): the theme store, and the library chunk for their names and colours (loaded now)
  useThemeState();
  useLibrary();
  const ctx = {} as AppMenuCtx;
  return (
    <Menu open onClose={onClose} anchor={anchor} placement={placement} title="Menu">
      <RegistryMenuItems items={items} ctx={ctx} />
    </Menu>
  );
}

/** The room column's + (2026-09-29, contract menus.new): New DM, and New room only while a space is selected —
 *  the room is created in that space. Desktop twin: Main.qml newMenu. */
export function NewMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose: () => void }) {
  const activeKey = useNavStore((st) => st.activeKey);
  const activeLabel = useNavStore((st) => st.activeLabel);
  const inSpace = activeKey.startsWith("!");
  return (
    <Menu open onClose={onClose} anchor={anchor} title="New">
      <MenuItem
        text="New DM…"
        icon="document-edit-symbolic"
        onTriggered={() => {
          onClose();
          openNavDialog({ kind: "newChat" });
        }}
      />
      {inSpace && (
        <MenuItem
          text="New room…"
          icon="folder-new-symbolic"
          onTriggered={() => {
            onClose();
            openNavDialog({ kind: "newRoom", space: false, parent: activeKey, parentName: activeLabel });
          }}
        />
      )}
    </Menu>
  );
}

/** Room-menu rows that belong to the CALL's menu (callui hosts "Call features", e.g. media's Watch
 *  party) — never in the room list's context menu (INTEGRATION #4, native Main.qml:1444-1565). */
export const isCallSectionRow = (it: { section?: string }) => it.section === "call" || it.section === "Call features";

export function RoomMenu({ roomId, anchor, onClose }: { roomId: string; anchor: MenuAnchor; onClose: () => void }) {
  const all = useRegistry("roomMenu");
  const items = useMemo(() => all.filter((it) => !isCallSectionRow(it)), [all]);
  useNavStore((st) => st.rev); // favourite / unread / notify mode change under an open menu
  const name = rowOf(roomId)?.name ?? "";
  return (
    <Menu open onClose={onClose} anchor={anchor} title={name}>
      <RegistryMenuItems items={items} ctx={{ roomId }} />
    </Menu>
  );
}

export function SpaceMenu({ spaceId, label, anchor, onClose }: { spaceId: string; label: string; anchor: MenuAnchor; onClose: () => void }) {
  const items = useRegistry("spaceMenu");
  return (
    <Menu open onClose={onClose} anchor={anchor} title={label}>
      <RegistryMenuItems items={items} ctx={{ spaceId, label }} />
    </Menu>
  );
}

// ---- helpers -------------------------------------------------------------------------------------

export function rowOf(roomId: string): RoomRow | undefined {
  const st = useNavStore.getState();
  return st.rooms.find((r) => r.id === roomId) ?? st.globalRooms.find((r) => r.id === roomId);
}

const isOpen = (roomId: string) => getCurrentRoom() === roomId;

function emitOr(name: "openGameReel" | "openCalendar" | "openAbout" | "openBugReport", payload: Record<string, unknown>, fallbackWindow?: string) {
  if (bus.listenerCount(name) > 0) bus.emit(name, payload as never);
  else if (name === "openAbout") openAboutFallback();
  else if (fallbackWindow && registriesRef?.windows.get(fallbackWindow)) openWindow(fallbackWindow, payload);
  else toast("That isn't available yet in Tin Hat Web", { timeoutMs: 4000 });
}

export function openBugReport() {
  emitOr("openBugReport", {}, "bugReport");
}

const devMode = () => /[?&]dev=1\b/.test(location.search + location.hash);

// ---- registrations -------------------------------------------------------------------------------

/** Rows other features may own at integration (spec §7.2: 30/50/60/70/80/90/110 of the room menu,
 *  50 of the space menu, 40 of the app menu). The nav ships a working row at the native order and
 *  steps aside as soon as another feature registers one at the same order — no duplicate rows. */
function yieldTo<C>(reg: { list(): Array<{ id: string; order: number }> }, order: number, visible?: (c: C) => boolean) {
  return (c: C) => !reg.list().some((x) => x.order === order && !x.id.startsWith("nav.")) && (visible ? visible(c) : true);
}

export function registerNavMenus(r: Registries): void {
  registriesRef = r;
  // ☰ app menu (spec §3.7). 2026-09-29: just Settings, Edit layout, Theme, About and Sign out (contract menus.app).
  // New DM / New room moved to the room column's + (NewMenu below); the Game Reel lives in the room header; Add widget in
  // Edit layout; the corner dock in Settings › Appearance; updates, the tour and shortcuts in Settings › About & help;
  // Verify in the verify banner + Settings › Devices & security; Refresh rooms is gone (sync is live).
  const a = r.appMenu;
  a.add({ id: "nav.settings", order: 50, label: "Settings…", icon: "settings-configure", run: () => openSettings() });
  a.add({
    id: "nav.theme",
    order: 60,
    label: "Theme",
    icon: "preferences-desktop-color",
    // THEMES-UI §12: your 5 most recent themes on this device (the one on screen checked; before any pick: it, OLED and
    // Goose), then "More themes…" = Settings → Appearance at the gallery and "Edit current theme…" = the theme editor on
    // the theme on screen (Appearance's Customize…; amendment 2026-09-28). A row applies its theme like a gallery card
    // (the theme store: the account, or this device with its own theme on; a sound offer shows as a toast).
    submenu: () => [
      ...recentThemes().map((t) => ({
        id: `theme:${t.id}`,
        label: t.name,
        checked: t.current,
        swatch: swatchOf(t),
        run: () => {
          if (!t.current) chooseTheme(t.doc); // the checked row: nothing to do (THEMES-UI §3.5)
        },
      })),
      { id: "more", label: "More themes…", icon: "view-grid-symbolic", separatorBefore: true, run: () => bus.emit("openThemeGallery", {}) },
      // the settings host it (SettingsSheet → AppearancePane's editCurrentTheme = Customize…; the desktop's
      // Main.qml editCurrentTheme → AppearancePane.customize); the last row in both apps
      { id: "edit", label: "Edit current theme…", icon: "document-edit-symbolic", run: () => bus.emit("editCurrentTheme", {}) },
    ],
    run: () => {},
  });
  a.add({
    id: "nav.iconGallery",
    order: 130,
    label: "Icon gallery",
    icon: "preferences-desktop-color",
    visible: devMode,
    run: () => {
      if (r.windows.get("iconGallery")) openWindow("iconGallery");
      else location.hash = "#/__gallery/icons";
    },
  });
  a.add({ id: "nav.about", order: 140, separatorBefore: true, label: "About Tin Hat", icon: "help-about-symbolic", run: () => emitOr("openAbout", {}) });
  a.add({ id: "nav.signOut", order: 150, label: "Sign out", icon: "system-log-out-symbolic", run: () => openNavDialog({ kind: "signOut" }) });

  // room context menu (spec §3.7)
  const m = r.roomMenu;
  m.add({
    id: "nav.favourite",
    order: 10,
    label: (c: RoomMenuCtx) => (rowOf(c.roomId)?.favourite ? "Unfavourite" : "Favourite"),
    icon: (c: RoomMenuCtx) => (rowOf(c.roomId)?.favourite ? "starred-symbolic" : "non-starred-symbolic"),
    visible: (c) => rowOf(c.roomId)?.membership === "join",
    run: (c) => void setFavourite(c.roomId, !rowOf(c.roomId)?.favourite),
  });
  m.add({
    id: "nav.markRead",
    order: 20,
    label: "Mark as read",
    icon: "checkmark-symbolic",
    visible: (c) => (rowOf(c.roomId)?.unread ?? 0) > 0,
    run: (c) => void markRoomRead(c.roomId),
  });
  m.add({
    // phones only: the desktop sets it with the pencil on the open row, which a phone's home list
    // never has (the room page covers the list) — same write, explicit target room
    id: "nav.nowPlaying",
    order: 25,
    label: "Now playing…",
    icon: "applications-games-symbolic",
    visible: (c) => getFormFactor() === "mobile" && rowOf(c.roomId)?.membership === "join" && !rowOf(c.roomId)?.dm,
    run: (c) => openNavDialog({ kind: "nowPlaying", roomId: c.roomId, name: rowOf(c.roomId)?.name ?? "" }),
  });
  m.add({
    id: "nav.invite",
    order: 30,
    label: "Invite people…",
    icon: "list-add-user",
    visible: (c) => rowOf(c.roomId)?.membership === "join",
    run: (c) => openNavDialog({ kind: "invite", roomId: c.roomId, name: rowOf(c.roomId)?.name ?? "" }),
  });
  m.add({
    id: "nav.notifications",
    order: 40,
    label: "Notifications",
    visible: (c) => rowOf(c.roomId)?.membership === "join",
    submenu: (c) => {
      const cur = rowOf(c.roomId)?.notifyMode ?? "mentions";
      const set = (mode: NotifyMode) => () => void setNotifyMode(c.roomId, mode, cur);
      return [
        { id: "all", label: "All messages", checked: cur === "all", run: set("all") },
        { id: "mentions", label: "Mentions only", checked: cur === "mentions", run: set("mentions") },
        { id: "mute", label: "Mute", checked: cur === "mute", run: set("mute") },
      ];
    },
    run: () => {},
  });
  const recOn = (id: string) => {
    const g = peekClient()?.getRoom(id)?.currentState.getStateEvents("dev.tinhat.record", "")?.getContent();
    return !!g && g.active === true;
  };
  m.add({
    id: "nav.record",
    order: 70,
    label: (c) => (recOn(c.roomId) ? "Stop recording calls" : "Record calls here (Memories)…"),
    icon: (c) => (recOn(c.roomId) ? "media-playback-stop-symbolic" : "media-record-symbolic"),
    // selfhost/firstrun item 1: not on a server without Memories (the recorder)
    visible: yieldTo(m, 70, (c) => isOpen(c.roomId) && serverFeatureOn("memories")),
    run: (c) => (recOn(c.roomId) ? void setRecording(c.roomId, false) : openNavDialog({ kind: "recordConfirm", roomId: c.roomId })),
  });
  m.add({
    id: "nav.changePhoto",
    order: 80,
    label: "Change photo…",
    icon: "insert-image-symbolic",
    visible: yieldTo(m, 80, (c) => isOpen(c.roomId) && canChangeAvatar(c.roomId)),
    run: (c) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/png,image/jpeg,image/gif,image/webp";
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (f) void setRoomPhoto(c.roomId, f);
      };
      inp.click();
    },
  });
  m.add({
    id: "nav.removePhoto",
    order: 90,
    label: "Remove photo",
    icon: "edit-delete-symbolic",
    visible: yieldTo(m, 90, (c) => isOpen(c.roomId) && canChangeAvatar(c.roomId)),
    run: (c) => void removeRoomPhoto(c.roomId),
  });
  m.add({
    id: "nav.copyInvite",
    order: 100,
    label: "Copy invite link",
    icon: "edit-copy-symbolic",
    run: async (c) => {
      const row = rowOf(c.roomId);
      await copyText(roomInviteLink(c.roomId, row?.alias ?? ""));
      toast(row?.publicJoin ? "Invite link copied — anyone with it can join" : "Link copied — they will still need an invite to this private room", {
        timeoutMs: 4000,
      });
    },
  });
  m.add({
    id: "nav.popOut",
    order: 110,
    label: "Pop out chat",
    icon: "window-new",
    // phones have no floating chats (ARCHITECTURE mobile rules) — the row is hidden there, not a
    // second way to open the room (fix/polish item 6)
    visible: yieldTo(m, 110, (c) => rowOf(c.roomId)?.membership === "join" && getFormFactor() !== "mobile"),
    run: (c) => {
      if (bus.listenerCount("openFloatingChat") > 0) bus.emit("openFloatingChat", { roomId: c.roomId });
      else toast("Pop-out chats aren't available yet in Tin Hat Web", { timeoutMs: 4000 });
    },
  });
  m.add({
    id: "nav.leave",
    order: 120,
    separatorBefore: true,
    label: (c) => (rowOf(c.roomId)?.membership === "invite" ? "Decline invite" : "Leave room"),
    icon: "go-previous-symbolic",
    visible: (c) => rowOf(c.roomId)?.membership !== "none",
    run: (c) => openNavDialog({ kind: "leaveRoom", roomId: c.roomId, name: rowOf(c.roomId)?.name ?? c.roomId, wasOpen: isOpen(c.roomId) }),
  });

  // space context menu (spec §3.7)
  const sm = r.spaceMenu;
  sm.add({
    id: "nav.spaceSettings",
    order: 10,
    label: "Space settings…",
    icon: "configure-symbolic",
    run: (c: SpaceMenuCtx) => bus.emit("openSpaceSettings", { spaceId: c.spaceId, tab: "overview" }),
  });
  sm.add({ id: "nav.markAllRead", order: 20, label: "Mark all as read", icon: "checkmark-symbolic", run: (c) => void markSpaceRead(c.spaceId, c.label) });
  sm.add({ id: "nav.spaceInvite", order: 30, label: "Invite people…", icon: "list-add-user", run: (c) => openNavDialog({ kind: "invite", roomId: c.spaceId, name: c.label }) });
  sm.add({
    id: "nav.copySpaceLink",
    order: 40,
    label: "Copy space link",
    icon: "link-symbolic",
    run: async (c) => {
      const room = peekClient()?.getRoom(c.spaceId);
      const alias = room?.getCanonicalAlias() ?? "";
      const jr = room?.currentState.getStateEvents("m.room.join_rules", "")?.getContent()?.join_rule;
      await copyText(roomInviteLink(c.spaceId, alias));
      toast(jr === "public" || jr === "knock" ? "Space link copied — anyone with it can join" : "Space link copied — they will still need an invite", {
        timeoutMs: 2500,
      });
    },
  });
  sm.add({
    id: "nav.spaceCalendar",
    order: 50,
    label: "Open the space calendar",
    icon: "view-calendar-symbolic",
    visible: yieldTo(sm, 50),
    run: (c) => emitOr("openCalendar", { containerId: c.spaceId }, "calendar"),
  });
  sm.add({
    id: "nav.leaveSpace",
    order: 60,
    separatorBefore: true,
    label: "Leave space",
    icon: "go-previous-symbolic",
    run: (c) => openNavDialog({ kind: "leaveSpace", spaceId: c.spaceId, name: c.label }),
  });
}
