// ThNav.tsx — ThNav.qml: rail (68) + room panel — the phones' NavColumn (the stack's home, incl. the
// "Loading your rooms…" state); on the desktop (11.0, islands C6/C7) the dock host places the nav column's islands
// itself (SpaceRail.tsx / RoomList.tsx) and this file keeps their shared STATE (NavState: the open room) and the nav
// drawer's chrome (CornerDock = ThDock.qml: hover handle, 110 ms open / 280 ms close intent, pin, badge, the panel
// frame — at the solver's rects).
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useSession } from "@/core/matrix";
import { getPref } from "@/core/prefs";
import { BusyIndicator, Icon, UnreadBadge, useStillLabel, useTip } from "@/ui";
import { SpaceRail } from "./SpaceRail";
import { RoomPanel } from "./RoomList";
import type { PhoneSections } from "./sections";
import { followRoom, restoreLastRoom, setCurrentRoom } from "./open";
import { refreshNow, useNavStore } from "./model";
import s from "./ThNav.module.css";

/** Track the open room for the nav (menus, stepping, the rail follow on first load). */
function useCurrentRoom(currentRoomId: string | null, mobile?: boolean) {
  const rev = useNavStore((st) => st.rev);
  const session = useSession();
  useEffect(() => {
    setCurrentRoom(currentRoomId);
  }, [currentRoomId]);
  // the rail follows the open room (a route change, a restored last room, a deep link) once the
  // model KNOWS the room — the first snapshots of a warm start can come from a partly loaded store
  // (D6: corner-mode launch selects the restored room's space too)
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!currentRoomId || followed.current === currentRoomId || session.state !== "ready") return;
    const st = useNavStore.getState();
    if (!st.globalRooms.some((r) => r.id === currentRoomId)) return;
    followed.current = currentRoomId;
    followRoom(currentRoomId);
  }, [rev, currentRoomId, session.state]);
  // NAV-99: reopen the last room at sign-in (desktop), retrying while the list loads
  const tried = useRef(false);
  useEffect(() => {
    if (mobile || tried.current || currentRoomId) return;
    tried.current = true;
    if (/[?&]gate=1/.test(location.search + location.hash) && /[?&]noroom=1/.test(location.search + location.hash)) return;
    return restoreLastRoom(
      () => getPref("last-room", ""),
      () => !!document.querySelector("[data-tw-roompage]") || !!location.hash.match(/^#\/room\//),
    );
  }, [mobile, currentRoomId]);
}

export function ThNav({ currentRoomId, active, mobile, onPicked, sections }: { currentRoomId: string | null; active?: boolean; mobile?: boolean; onPicked?: () => void; sections?: PhoneSections }) {
  return (
    <div className={s.nav}>
      <SpaceRail mobile={mobile} sections={sections} />
      <RoomPanel currentRoomId={currentRoomId} active={active} mobile={mobile} onPicked={onPicked} sections={sections} />
    </div>
  );
}

/** The desktop nav column's shared state (the islands render themselves): the open room for the nav — menus, stepping,
 *  the rail following the room, the last room at sign-in. Renders nothing (the desktop's navState ThNav). */
export function NavColumnState({ currentRoomId }: { currentRoomId: string | null }) {
  useCurrentRoom(currentRoomId);
  return null;
}

export function NavColumnImpl({ currentRoomId, mobile, sections }: { currentRoomId: string | null; mobile?: boolean; sections?: PhoneSections }) {
  useCurrentRoom(currentRoomId, mobile);
  const session = useSession();
  const loaded = useNavStore((st) => st.loaded);
  const busy = session.state !== "ready" || !loaded;
  // GPU.md §2.5: a still busy mark that steps on each sign-in stage; the label changes once after 10 s without one
  const bootLabel = useStillLabel(session.state === "starting" || session.state === "booting" ? "Signing in…" : "Loading your rooms…", busy && session.state !== "ready", session.state);
  return (
    <div className={s.column} data-mobile={mobile ? "" : undefined}>
      {busy && session.state !== "ready" && (
        <div className={s.loading}>
          <BusyIndicator size={32} progress={session.state} />
          <span>{bootLabel}</span>
        </div>
      )}
      <ThNav currentRoomId={currentRoomId} mobile={mobile} active sections={sections} />
    </div>
  );
}

// ---- the nav drawer (corner mode, or a window narrower than 720 px) ----------------------------------------------
// 11.0 (ISLANDS-ARCH §2.4, islands C6/C7): the solver collapses the nav column into a drawer; the shell's dock host places
// the column's islands inside the drawer panel (z 20, fading + sliding with it) and this dock is the drawer's chrome —
// the handle and the panel frame at the solver's rects, the hover intent 110 / 280 ms, pin, badge, the near-top reveal
// zone. Its state is shared through useDrawerStore: the islands read `opened` (the list is active) and close the drawer
// after a pick; the shell reads `shown` (open, or still fading out) for the layout's view state and reports the
// pointer over the drawer's islands as `islandHover`.
interface DrawerState {
  opened: boolean;
  pinned: boolean;
  /** open, or still fading out (the panel and the island stay on screen for the close animation) */
  shown: boolean;
  /** the pointer is over the drawer's island (it sits above the panel frame, not inside it) */
  islandHover: boolean;
}
const initialOpen = typeof location !== "undefined" && /[?&]dock=open\b/.test(location.search + location.hash);
export const useDrawerStore = create<DrawerState>()(() => ({ opened: initialOpen, pinned: initialOpen, shown: initialOpen, islandHover: false }));
// after an explicit close (a room was picked, the bug button) the pointer is still over the panel: don't let that hover
// reopen it — wait until the pointer has left handle + panel once
let suppressed = false;
export function closeDrawer() {
  suppressed = true;
  useDrawerStore.setState({ pinned: false, opened: false });
}
/** Open the nav drawer from the app: Ctrl+K on a pending invite (QuickSwitcher showInvite, as Main.qml showInvite).
 *  (Back on a collapsed nav opens it on the desktop; the web keeps the browser's Back, WEB-EXCEPTIONS.) */
export function openDrawer() {
  refreshNow();
  useDrawerStore.setState({ opened: true });
}

// the drawer's chrome is mounted exactly while the nav column sits in a drawer (corner mode, a narrow window, the
// emergency arrangement) — the desktop's `root.navInDrawer` / `cornerNav.visible`
let dockMounts = 0;
/** Is the nav tucked into its drawer right now (Ctrl+K on an invite opens the drawer then, Main.qml showInvite)? */
export function navInDrawerNow(): boolean {
  return dockMounts > 0;
}

type Box = { x: number; y: number; w: number; h: number };
export function CornerDockImpl({ handle, panel }: { handle: Box; panel: Box }) {
  const badge = useNavStore((st) => st.globalBadge);
  const opened = useDrawerStore((d) => d.opened);
  const pinned = useDrawerStore((d) => d.pinned);
  const islandHover = useDrawerStore((d) => d.islandHover);
  const [handleHover, setHandleHover] = useState(false);
  const [handleFocus, setHandleFocus] = useState(false); // 10.8: a focused handle shows (the host hands focus back here)
  const [panelHover, setPanelHover] = useState(false);
  const [nearTop, setNearTop] = useState(false);
  const shown = useDrawerStore((d) => d.shown);
  useEffect(() => {
    dockMounts++;
    return () => {
      dockMounts--;
    };
  }, []);
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  useTip(handleRef, opened ? "" : "Spaces & rooms", { delay: 500, placement: "below" });
  const setOpened = (o: boolean) => useDrawerStore.setState({ opened: o });

  // hover intent (ThDock.qml evalHover)
  const openT = useRef(0);
  const closeT = useRef(0);
  const anyPointer = handleHover || panelHover || islandHover;
  useEffect(() => {
    if (!anyPointer) suppressed = false;
  }, [anyPointer]);
  // evaluated when the hover or the pin changes — not when `opened` does (ThDock.qml _evalHover): a drawer the app
  // opens (openDrawer: Ctrl+K on a pending invite) stays open until the pointer has been over it and left, as the
  // desktop's (with `opened` here it closed again 280 ms later)
  useEffect(() => {
    const anyHover = pinned || (anyPointer && !suppressed);
    if (anyHover) {
      window.clearTimeout(closeT.current);
      if (!useDrawerStore.getState().opened) {
        window.clearTimeout(openT.current);
        openT.current = window.setTimeout(() => setOpened(true), 110);
      }
    } else {
      window.clearTimeout(openT.current);
      window.clearTimeout(closeT.current);
      closeT.current = window.setTimeout(() => setOpened(false), 280);
    }
  }, [anyPointer, pinned]);
  useEffect(
    () => () => {
      window.clearTimeout(openT.current);
      window.clearTimeout(closeT.current);
      // the drawer goes with its chrome (corner mode off, or the window wide again)
      useDrawerStore.setState({ opened: false, pinned: false, shown: false, islandHover: false });
    },
    [],
  );
  useEffect(() => {
    if (opened) {
      useDrawerStore.setState({ shown: true });
      return;
    }
    const t = window.setTimeout(() => useDrawerStore.setState({ shown: false }), 260);
    return () => window.clearTimeout(t);
  }, [opened]);

  // the reveal zone (hover only, never input): top-left min(W, 216) × 64 of the page area
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const host = hostRef.current?.parentElement;
      if (!host) return;
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const inZone = x >= 0 && y >= 0 && x < Math.min(r.width, 216) && y < 64;
      setNearTop((was) => {
        if (inZone && !was) refreshNow(); // NAV-97: current by the time it slides in
        return inZone;
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);
  useEffect(() => {
    if (opened || handleHover) refreshNow();
  }, [opened, handleHover]);

  const reveal = opened || handleHover || pinned || nearTop || handleFocus;

  return (
    <div ref={hostRef} className={s.dockHost}>
      <button
        ref={handleRef}
        type="button"
        className={s.handle}
        data-open={opened || handleHover || handleFocus ? "" : undefined}
        data-drawer-handle=""
        style={{ left: handle.x, top: handle.y, width: handle.w, height: handle.h, opacity: reveal ? 1 : 0 }}
        aria-label="Spaces & rooms"
        aria-expanded={opened}
        onPointerEnter={() => setHandleHover(true)}
        onPointerLeave={() => setHandleHover(false)}
        onFocus={() => setHandleFocus(true)}
        onBlur={() => setHandleFocus(false)}
        onClick={() => {
          const p = !pinned;
          useDrawerStore.setState(p ? { pinned: true, opened: true } : { pinned: false });
        }}
      >
        <Icon name="application-menu-symbolic" size={20} color="var(--th-dock-handle-icon)" staticOnly />
        {pinned && <span className={s.pinDot} />}
        {badge && <UnreadBadge count={badge === "99+" ? 100 : Number(badge)} className={s.handleBadge} />}
      </button>
      {shown && (
        <div
          className={s.panel}
          data-open={opened ? "" : undefined}
          style={{ left: panel.x, top: panel.y, width: panel.w, height: panel.h }}
          onPointerEnter={() => setPanelHover(true)}
          onPointerLeave={() => setPanelHover(false)}
        />
      )}
    </div>
  );
}
