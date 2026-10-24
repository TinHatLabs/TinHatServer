// chrome.ts — call chrome visibility (CUI-60; Main.qml:810-827, 5330-5340):
//   chromeShown = forced || (mutedTalkBubble && inCall) || (windowFocused && ((pointerOverCall && !idle)
//                 || barHovered || menuHeld || any call popover / soundboard / tile menu / EC popup open))
// Every pointer move of > 1 px over the call restarts a 3000 ms idle timer.
// 11.0.2 (2026-09-28, ACTIONS.md §15): the call BAR also stays while "Keep call buttons visible" is on —
//   barShown = chromeShown || pinned (Main.qml callBarShown) — its pin, Settings → Calls and call.bar.pin.toggle; the
//   tile buttons keep following chromeShown. Device-local pref `call-bar-pinned` ("1" = on, else off; default off — the
//   desktop's uiPref of the same name). A pinned bar is static: no timer or animation of its own.
import { useEffect } from "react";
import { create } from "zustand";
import { getPref, setPref, usePref } from "@/core/prefs";
import { onRealWinState, realWinFocused, useRealWinFocused } from "@/core/winstate";
import { useC, useCallUi } from "./store";

interface ChromeState {
  over: boolean;
  idle: boolean;
  barHovered: boolean;
  focused: boolean;
  set: (p: Partial<ChromeState>) => void;
}

export const useChromeStore = create<ChromeState>()((set) => ({
  over: false,
  idle: true,
  barHovered: false,
  focused: realWinFocused(),
  set: (p) => set(p),
}));

let idleTimer = 0;
let last = { x: -1, y: -1 };

export function chromePointerMove(e: { clientX: number; clientY: number }) {
  if (Math.abs(e.clientX - last.x) <= 1 && Math.abs(e.clientY - last.y) <= 1) return;
  last = { x: e.clientX, y: e.clientY };
  const st = useChromeStore.getState();
  if (!st.over || st.idle) st.set({ over: true, idle: false });
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => useChromeStore.getState().set({ idle: true }), 3000);
}

export function chromePointerLeave() {
  useChromeStore.getState().set({ over: false });
}

/** Tracks window focus (native: the window is active) — the REAL window state of core/winstate.ts (GPU.md §1;
 *  a focused pop-out window of ours counts as focused). Real focus, not the render state: the chrome hides when
 *  another window has the focus whatever "Save GPU while Tin Hat isn't focused" says (10.8.1). */
export function useWindowFocusTracking() {
  useEffect(() => {
    useChromeStore.getState().set({ focused: realWinFocused() });
    return onRealWinState((now) => useChromeStore.getState().set(now === "focused" ? { focused: true } : { focused: false, barHovered: false }));
  }, []);
}

const forcedByUrl = (() => {
  try {
    const q = location.search + "&" + (location.hash.split("?")[1] ?? "");
    return /(^|[?&])callchrome=1/.test(q);
  } catch {
    return false;
  }
})();

export function useChromeShown(): boolean {
  const c = useChromeStore();
  const focused = useRealWinFocused();
  const inCall = useC("inCall");
  const u = useCallUi();
  if (forcedByUrl || u.forceChrome) return true;
  if (u.mutedBubble && inCall) return true;
  if (!focused) return false;
  return (c.over && !c.idle) || c.barHovered || u.menuHeld > 0 || !!u.optsFace || u.streamPop || u.soundboardOpen || !!u.volMenu || u.ecOpen;
}

/** The pref behind "Keep call buttons visible" (the desktop's settings.uiPref("call-bar-pinned")). */
export const CALL_BAR_PIN_PREF = "ui-call-bar-pinned";
/** The stored value → pinned: only "1" is on (absent = off, the default). */
export const callBarPinnedOn = (raw: unknown): boolean => raw === "1";
export const callBarPinned = (): boolean => callBarPinnedOn(getPref(CALL_BAR_PIN_PREF, ""));
export function setCallBarPinned(on: boolean): void {
  setPref(CALL_BAR_PIN_PREF, on ? "1" : "0");
}
export function useCallBarPinned(): boolean {
  return callBarPinnedOn(usePref(CALL_BAR_PIN_PREF, ""));
}
/** The bar's own rule (Main.qml callBarShown): the chrome's, or pinned. */
export const callBarShownRule = (chromeShown: boolean, pinned: boolean): boolean => chromeShown || pinned;
export function useCallBarShown(): boolean {
  const chrome = useChromeShown();
  const pinned = useCallBarPinned();
  return callBarShownRule(chrome, pinned);
}

/** Hold the chrome open while a menu/popup is open (devices menu, health popup, game popup). */
export function useHoldChrome(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const s = useCallUi.getState();
    s.set({ menuHeld: s.menuHeld + 1 });
    return () => {
      const t = useCallUi.getState();
      t.set({ menuHeld: Math.max(0, t.menuHeld - 1) });
    };
  }, [open]);
}
