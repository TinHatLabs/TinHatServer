// features/nav — Tin Hat Web navigation (spec: tw-spec/shell-nav.md).
//
// Shell contract (app/Shell.tsx imports these by name):
//   NavColumn   phones: the full-screen home of the stack = ThNav (Spaces rail + room list).
//   Desktop (11.0, islands C6/C7) — the dock host's islands of the nav column, each its own frame:
//   NavIsland · DmsIsland (useDmStripEmpty) · SpacesIsland · RoomsIsland · WidgetsIsland · AccountIsland, and
//   NavColumnState (the column's shared state: the open room). CornerDock = the nav drawer's chrome (ThDock.qml: handle,
//   panel frame, hover intent, pin, badge) at the solver's rects — corner mode or a window narrower than 720 px; the
//   islands ride in the panel (useDrawerStore is the drawer's shared state).
// Also exported for other features:
//   useNav / useNavStore        the nav model (spaces, rooms of the active key, globalRooms,
//                               activeKey/activeLabel, globalBadge, spaceOf) — callui's join banner
//                               reads rooms[i].participants of the open room
//   openRoomId(id)              open a room (bus openRoom; the rail follows)
//   selectSpace, setSpaceOrder, markRoomRead, markSpaceRead, refreshNav
//   navMode: useNavMode / getNavMode / setNavMode / toggleSidebar (Settings → Appearance radios)
//   openNavDialog({kind: "newChat" | "newRoom" | "invite" | "joinSpace" | …})
//   openQuickSwitcher(), startTour(), SHORTCUT_ROWS (the 13 rows of the shortcuts dialog)
//   messageUser(mxid) / createDm(mxid)  profile "Direct message" (reuse or create, then open)
//   useUpdate / checkForUpdates / openWhatsNew  the web updater (app/Banners.tsx reads it)
// Bus events answered here: openRoom (rail follows), openQuickSwitcher, openShortcuts, openTour,
// openNavDialog. Bus events EMITTED for other features (additive, core/bus.ts): openBugReport,
// openAbout (nav fallback sheet if nobody listens), openFloatingChat, openCalendar, openGameReel,
// openParticipantMenu, openSpaceSettings, openVerifyDialog, openSettings.
// Registries hosted here: r.appMenu, r.roomMenu, r.spaceMenu (additive, core/registry.ts).
import type { FeatureModule } from "@/core/registry";
import { bus } from "@/core/bus";
import { getSession, useSessionStore } from "@/core/matrix";
import { CornerDockImpl, NavColumnImpl, NavColumnState, closeDrawer, openDrawer, useDrawerStore } from "./ThNav";
import { installNavModel, refreshNow, selectSpace, setSpaceOrder, spaceOf, useNavStore, type NavState } from "./model";
import { registerNavMenus } from "./menus";
import { NavDialogs, openNavDialog, setOnLeftOpenRoom } from "./dialogs";
import { QuickSwitcherHost, openQuickSwitcher, quickSwitcherOpen, closeQuickSwitcher, pickRoom, type RoomPick } from "./QuickSwitcher";
import { TourHost, startTour } from "./Tour";
import { CallRosterBridge } from "./callinfo";
import { installOpenFollow, openRoomId, stepRoom } from "./open";
import { InviteAlerts, SpaceInviteToasts } from "./toasts";
import { checkForUpdates, installUpdateWatch, useUpdate } from "./update";
import { clearSpaceCounts, createDm } from "./actions";
import { NavSheets, QuitGuard } from "./sheets";
import { applyEarlyGateHooks, applyReadyGateHooks, gateOn } from "./gate";

export interface NavColumnProps {
  /** the open room (null on #/home) */
  currentRoomId: string | null;
  /** phone layout: full-screen list, the first screen of the stack */
  mobile?: boolean;
  /** 11.0 (EDITMODE-UI §12): the phone form's visible sections in order — rail (nav · dms · spaces) and list (rooms ·
   *  widgets · account); absent = today's order, everything shown */
  sections?: PhoneSections;
}
export type { PhoneSections } from "./sections";
import type { PhoneSections } from "./sections";

export function NavColumn(p: NavColumnProps) {
  return <NavColumnImpl currentRoomId={p.currentRoomId} mobile={p.mobile} sections={p.sections} />;
}

export interface CornerDockProps {
  /** the solver's drawer handle and panel rects (host px) */
  handle: { x: number; y: number; w: number; h: number };
  panel: { x: number; y: number; w: number; h: number };
}

export function CornerDock(p: CornerDockProps) {
  return <CornerDockImpl handle={p.handle} panel={p.panel} />;
}
export { useDrawerStore, closeDrawer, openDrawer, NavColumnState };
export { NavIsland, DmsIsland, SpacesIsland, useDmStripEmpty } from "./SpaceRail";
export { RoomsIsland, WidgetsIsland, AccountIsland } from "./RoomList";

/** React: the nav model (use a selector for fine-grained re-renders). */
export function useNav(): NavState;
export function useNav<T>(sel: (s: NavState) => T): T;
export function useNav<T>(sel?: (s: NavState) => T) {
  return useNavStore(sel ?? ((s) => s as unknown as T));
}

// store-style access on the hook too (spaces reads `useNav.getState().activeKey` for the active rail space)
Object.assign(useNav, { getState: useNavStore.getState, subscribe: useNavStore.subscribe });

export { useNavStore, selectSpace, setSpaceOrder, spaceOf, openRoomId, openNavDialog, openQuickSwitcher, pickRoom, startTour, type RoomPick };
// 11.0 buttons: the palette host, for the #/__gallery/actions review page (the app mounts it as an overlay)
export { QuickSwitcherHost };
export { refreshNow as refreshNav };
export { markRoomRead, markSpaceRead, parseJoinLink, roomInviteLink } from "./actions";
export { createDm };

/** Profile / member menu "Direct message": reuse the 1:1 DM with `mxid` or start one, then open it
 *  (bridge.rs create_dm — status toasts "Opening…" / "Couldn't start that chat: …"). */
export async function messageUser(mxid: string): Promise<string | null> {
  const id = await createDm(mxid);
  if (id) openRoomId(id);
  return id;
}
export { useNavMode, getNavMode, setNavMode, toggleSidebar, type NavMode } from "./navmode";
export { SHORTCUT_ROWS } from "./dialogs";
export { useUpdate, checkForUpdates };
export { openWhatsNew } from "./sheets";
export type { RoomRow, SpaceEntry, Participant, NavSnapshot } from "./model";

const signedIn = () => getSession().state === "ready";

export const feature: FeatureModule = {
  id: "nav",
  setup(r) {
    applyEarlyGateHooks();
    // dev/gate hook for the nav QA scripts (tools/nav-mock.mjs): the SAME module instances the app uses
    if (gateOn()) (window as unknown as { __twNav?: unknown }).__twNav = { checkForUpdates, useUpdate, useNavStore, openNavDialog, openQuickSwitcher, startTour };
    installNavModel();
    installOpenFollow();
    installUpdateWatch();
    registerNavMenus(r);
    r.overlays.add({ id: "nav.dialogs", order: 10, component: NavDialogs });
    r.overlays.add({ id: "nav.quickSwitcher", order: 11, component: QuickSwitcherHost });
    r.overlays.add({ id: "nav.tour", order: 12, component: TourHost });
    r.overlays.add({ id: "nav.callRoster", order: 13, component: CallRosterBridge });
    r.overlays.add({ id: "nav.spaceInviteToasts", order: 14, component: SpaceInviteToasts });
    r.overlays.add({ id: "nav.inviteAlerts", order: 14.5, component: InviteAlerts });
    r.overlays.add({ id: "nav.sheets", order: 15, component: NavSheets });
    r.overlays.add({ id: "nav.quitGuard", order: 16, component: QuitGuard });
    // "Leave room" on the open room pops back to the sidebar-only state (no welcome page)
    setOnLeftOpenRoom(() => {
      if (location.hash.startsWith("#/room/")) location.hash = "#/home";
    });

    // ---- shortcuts (spec §3.10) ----
    r.shortcuts.add({
      id: "nav.quickSwitcher",
      action: "nav.quickSwitcher.open",
      order: 10,
      keys: "Ctrl+K",
      whenTyping: true,
      description: "Jump to any room",
      enabled: signedIn,
      run: () => {
        if (quickSwitcherOpen()) closeQuickSwitcher();
        else openQuickSwitcher();
      },
    });
    r.shortcuts.add({ id: "nav.prevRoom", action: "nav.room.previous", order: 20, keys: "Alt+Up", whenTyping: true, enabled: signedIn, run: () => stepRoom(-1, false) });
    r.shortcuts.add({ id: "nav.nextRoom", action: "nav.room.next", order: 21, keys: "Alt+Down", whenTyping: true, enabled: signedIn, run: () => stepRoom(1, false) });
    r.shortcuts.add({ id: "nav.prevUnread", action: "nav.unread.previous", order: 22, keys: "Alt+Shift+Up", whenTyping: true, enabled: signedIn, run: () => stepRoom(-1, true) });
    r.shortcuts.add({ id: "nav.nextUnread", action: "nav.unread.next", order: 23, keys: "Alt+Shift+Down", whenTyping: true, enabled: signedIn, run: () => stepRoom(1, true) });
    r.shortcuts.add({
      id: "nav.spaceSettings",
      action: "space.settings.open",
      order: 30,
      keys: "Ctrl+Shift+,",
      whenTyping: true,
      enabled: () => signedIn() && useNavStore.getState().activeKey.startsWith("!"),
      run: () => bus.emit("openSpaceSettings", { spaceId: useNavStore.getState().activeKey, tab: "overview" }),
    });
    r.onReady.add({ id: "nav.refresh", order: 0, run: () => refreshNow() });
    // A5.3: once per session after the first LIVE sync, clear the spaces' permanent invite "1"
    let spacesCleared = false;
    useSessionStore.subscribe((s) => {
      if (s.state !== "ready") spacesCleared = false;
      else if (s.liveSyncDone && !spacesCleared) {
        spacesCleared = true;
        void clearSpaceCounts().catch(() => undefined);
      }
    });
    // A5.4: the tab title carries the global badge — "(N) Tin Hat"
    const title = (b: string) => (document.title = b ? `(${b}) Tin Hat` : "Tin Hat");
    title(useNavStore.getState().globalBadge);
    useNavStore.subscribe((st, prev) => {
      if (st.globalBadge !== prev.globalBadge) title(st.globalBadge);
    });
    r.onReady.add({ id: "nav.gateHooks", order: 100, run: () => applyReadyGateHooks() });
  },
};
