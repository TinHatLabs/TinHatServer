// entry.ts — how every surface opens the calendar / the Game Reel (Main.qml openCalendar /
// openGameReel equivalents). Windows are in-app AppWindows ("calendar", "gameReel").
import { bus, closeWindow, openWindow } from "@/core/bus";
import { openContainer, openEvent, setRoom as setCalRoom, useCal } from "./calendarStore";
import { refresh as refreshReel, setRoom as setReelRoom, setSession, useGames } from "./gamesStore";

export const CAL_WINDOW = "calendar";
export const REEL_WINDOW = "gameReel";

/** Open or raise the calendar (optionally switched to a container and focused on an event). */
export function openCalendar(opts: { containerId?: string; eventId?: string } = {}): void {
  if (opts.containerId && opts.eventId) openEvent(opts.containerId, opts.eventId);
  else if (opts.containerId) openContainer(opts.containerId);
  else if (opts.eventId) openEvent(useCal.getState().containerId, opts.eventId);
  openWindow(CAL_WINDOW, { label: useCal.getState().label });
}

export function toggleCalendar(): void {
  if (useCal.getState().windowOpen) closeWindow(CAL_WINDOW);
  else openCalendar();
}

/** Open or raise the Game Reel ("Game TBD" pill attaches it to a session explicitly — CAL-42/71). */
export function openGameReel(opts: { sessionId?: string } = {}): void {
  if (opts.sessionId) setSession(opts.sessionId, true);
  // raising an open window refreshes it (GameReelWindow.qml openOrRaise → ctl.refresh())
  if (useGames.getState().windowOpen) void refreshReel();
  openWindow(REEL_WINDOW, {});
}

/** The Game Reel for an event of any container (widgets: Up next's "Game TBD · Pick"): both stores switch to that
 *  container first (the Reel only honours a session of its own container), then the pill's explicit session. */
export function openGameReelFor(containerId: string, sessionId: string): void {
  setCalRoom(containerId);
  setReelRoom(containerId);
  openGameReel({ sessionId });
}

export function toggleGameReel(): void {
  if (useGames.getState().windowOpen) closeWindow(REEL_WINDOW);
  else openGameReel();
}

/** Keep the calendar window's title ("Calendar · <label> — Tin Hat") in step with the container. */
let lastLabel = "";
useCal.subscribe((st) => {
  if (st.windowOpen && st.label !== lastLabel) {
    lastLabel = st.label;
    if (bus.listenerCount("openWindow") > 0) openWindow(CAL_WINDOW, { label: st.label });
  }
});
