// threads/shown.ts — 12.1.16 fixes 1-3 / 1-4: which timelines of a room are on screen ("" = its main timeline, else a
// thread's root). The Mentions list (seen) and the notification engine (on screen?) both ask this. The right panel
// belongs to the main view's room (round 2 #11); when it overlays the room (a phone's sheet, a narrow page) it covers
// the main timeline, so only the thread it shows is on screen.
import { useChatStore } from "../store";
import { useRightPanelStore } from "../../spaces/panelState";
import { THREADS_TAB, useThreadsPanel } from "./state";
import { shownTimelinesRule } from "./shownRule";

function phone(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.ff === "mobile";
}

/** `roomOnScreen`: the caller's own "is this room in a focused view" (the Mentions list: the main view; notifications:
 *  any attended view). */
export function shownTimelines(roomId: string, roomOnScreen: boolean): string[] {
  const panel = useRightPanelStore.getState();
  const panelHere = roomOnScreen && panel.open && panel.tab === THREADS_TAB && useChatStore.getState().mainRoom === roomId;
  const open = panelHere ? (useThreadsPanel.getState().open[roomId] ?? null) : null;
  return shownTimelinesRule({ roomOnScreen, panelHere, open, covers: panelHere && (panel.overlay || phone()) });
}
