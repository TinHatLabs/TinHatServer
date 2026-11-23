// GamePanel.tsx — where the game panel draws (the layout both apps share): until the layout
// contract grows a `game` island, the panel COVERS THE ROOM'S COLUMN (the call + timeline + composer islands' rect,
// tracked live) beside the call while a table or the Games list is open; × goes back to the chat. Phones: a
// full-screen sheet over the minimised call (like Media Party). No islands on screen (a layout without them): a
// centred panel. Mounted once (r.overlays); opened by openGameWindow().
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { HeaderIconButton, OverlayPortal, cx, useIsMobile, usePopupStack } from "@/ui";
import { getPref, onPrefChange, setPref } from "@/core/prefs";
import { getC, setUiState } from "@/features/callui/store";
import { useHoldChrome } from "@/features/callui/chrome";
import { GamesWindow, SpaceBadge } from "./GamesWindow";
import { StagePill } from "./Stage";
import { useCallStore } from "@/features/calls";
import { useRoomGame } from "./space";
import { closeGamePanel, openGameWindow, usePlay } from "./store";
import { GAME_WORDS, w } from "./rules";
import { artVars } from "./art";
import s from "./GamePanel.module.css";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The room's column below the call's visible strip + controls: the call island (collapsed while the panel is open, so
 *  only its strip and its control row remain; the rest of its height is free), the timeline and the composer. The PM's
 *  decision for both apps (12:21): mute, deafen, hang-up, the speaking rings and the table chips stay reachable above
 *  the table; the table takes everything under them. Null when the layout shows none of these islands. */
const AREA = '[data-island^="call"], [data-island^="timeline"], [data-island^="composer"]';
function roomArea(): Box | null {
  const els = [...document.querySelectorAll<HTMLElement>(AREA)].filter((e) => e.offsetWidth > 0 && e.offsetHeight > 0);
  if (!els.length) return null;
  const rs = els.map((e) => e.getBoundingClientRect());
  const left = Math.min(...rs.map((r) => r.left)),
    right = Math.max(...rs.map((r) => r.right)),
    bottom = Math.max(...rs.map((r) => r.bottom));
  let top = Math.max(0, Math.min(...rs.map((r) => r.top)));
  const floor = Math.min(bottom, window.innerHeight);
  // the call's chrome that stays: its status strip and its control row. Only rendered chrome inside this column and in
  // its upper part counts (a hidden, off-screen or misplaced control must never squeeze the table to nothing).
  const chrome = [...document.querySelectorAll<HTMLElement>('[data-island^="call"] [data-testid="call-status"], [data-island^="call"] [data-testid="call-bar"]')]
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0 && r.right > left && r.left < right && r.top >= top - 1 && r.bottom <= floor - 240);
  if (chrome.length) top = Math.max(top, Math.max(...chrome.map((r) => r.bottom)) + 8);
  return { left, top, width: right - left, height: Math.max(0, floor - top) };
}
const COLLAPSE_PREF = "ui-call-collapsed";

/** The temporary collapse, shared by every open panel (reference-counted): the first holder collapses the call and
 *  remembers what was there; the last one puts it back, unless the person changed it themselves meanwhile. "Changed
 *  it themselves" is watched synchronously on the pref (not through React renders, which can batch 1 → 0 → 1 away):
 *  any write after ours that leaves another value is theirs, and then nothing is put back. */
const collapseHold: { holders: number; before: string | null; applied: string | null; touched: boolean; off: (() => void) | null } = { holders: 0, before: null, applied: null, touched: false, off: null };
function holdCollapse(): () => void {
  if (collapseHold.holders++ === 0) {
    const before = getPref(COLLAPSE_PREF, "0");
    collapseHold.before = before;
    collapseHold.touched = false;
    if (getC().maximized) setUiState({ maximized: false });
    if (before !== "1") {
      setPref(COLLAPSE_PREF, "1");
      collapseHold.applied = "1";
    } else collapseHold.applied = null;
    // subscribed AFTER our own write, so only the person's (or another tab's) writes reach it
    collapseHold.off = onPrefChange(COLLAPSE_PREF, () => {
      if (collapseHold.applied !== null && getPref(COLLAPSE_PREF, "0") !== collapseHold.applied) collapseHold.touched = true;
    });
  }
  return () => {
    if (--collapseHold.holders > 0) return;
    collapseHold.off?.();
    collapseHold.off = null;
    if (collapseHold.applied !== null && !collapseHold.touched && collapseHold.before !== null) setPref(COLLAPSE_PREF, collapseHold.before);
    collapseHold.before = collapseHold.applied = null;
    collapseHold.touched = false;
  };
}

export function GamePanelHost() {
  const panel = usePlay((x) => x.panel);
  return panel ? <GamePanel roomId={panel.roomId} table={panel.table} /> : null;
}

function GamePanel({ roomId, table }: { roomId: string; table: string }) {
  const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(() => (mobile ? null : roomArea()));
  const game = usePlay((x) => (table ? x.views[table]?.view.game : undefined));
  const g = useRoomGame(roomId);
  usePopupStack(true, ref, { onEscape: closeGamePanel });
  // collapse the call while the panel is open (desktop layouts; phones show a sheet over the minimised call)
  useLayoutEffect(() => {
    if (mobile) return;
    return holdCollapse();
  }, [mobile]);
  // the call's controls stay shown above the table (no hover needed), without touching the person's own pin setting
  useHoldChrome(!mobile);
  useLayoutEffect(() => {
    if (mobile) return;
    const measure = () => {
      const b = roomArea();
      setBox((cur) => (cur && b && cur.left === b.left && cur.top === b.top && cur.width === b.width && cur.height === b.height ? cur : b));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const e of document.querySelectorAll<HTMLElement>(`${AREA}, [data-dock-host]`)) ro.observe(e);
    window.addEventListener("resize", measure);
    const t = window.setInterval(measure, 1000); // islands move without resizing (edit mode, a docked call growing)
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.clearInterval(t);
    };
  }, [mobile]);
  const style: CSSProperties | undefined = mobile ? undefined : box ? { left: box.left, top: box.top, width: box.width, height: box.height } : undefined;
  const title = game ? GAME_WORDS[game] : "Games";
  // B4: Table | Call while this table's room is my call
  const stageable = useCallStore((c) => !!table && c.inCall && c.callRoomId === roomId);
  return (
    <OverlayPortal>
      <div ref={ref} role="dialog" aria-label={title} className={cx(s.panel, mobile ? s.phone : box ? s.covering : s.centred)} style={{ ...artVars(), ...style }} data-testid="game-panel">
        <div className={s.head}>
          {mobile && !table && <HeaderIconButton iconName="go-previous-symbolic" tip="Back to the call" onClick={closeGamePanel} />}
          {table && <HeaderIconButton iconName="go-previous-symbolic" tip={w("lobby.all_games")} onClick={() => openGameWindow(roomId, null)} data-testid="games-back" />}
          {stageable && <StagePill on="table" className={mobile ? s.headPill : undefined} />}
          <span className={cx(s.title, mobile && stageable && s.titleTight)}>{title}</span>
          <span className={s.grow} />
          {g.owner && g.space && <SpaceBadge owner={g.owner} space={g.space} table={table} roomId={roomId} compact={mobile && !!table} tight={mobile && stageable} />}
          {!mobile && <HeaderIconButton iconName="window-close-symbolic" tip={w("lobby.back_to_chat")} onClick={closeGamePanel} data-testid="game-panel-close" />}
          {mobile && table && <HeaderIconButton iconName="window-close-symbolic" tip="Back to the call" onClick={closeGamePanel} data-testid="game-panel-close" />}
        </div>
        <div className={s.body}>
          <GamesWindow roomId={roomId} table={table} bare />
        </div>
      </div>
    </OverlayPortal>
  );
}
