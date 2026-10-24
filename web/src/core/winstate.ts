// winstate.ts — the app-wide window state of the low-GPU contract (contract GPU.md §1) — TWO of them since 10.8.1:
//
//   REAL    what the window is (focus + visibility):
//             focused    the Tin Hat window (or one of its pop-out windows) has the keyboard focus
//             unfocused  visible, but another window has the focus (Tin Hat on a side monitor next to a game)
//             hidden     a background tab, a minimised window, another workspace — nothing of ours is on screen
//   RENDER  what every low-GPU rule acts on: the real state, except that "unfocused" renders as "focused" unless
//           Settings → Appearance → Performance → "Save GPU while Tin Hat isn't focused" is on (pref
//           `call-unfocused-saver`, default OFF since 10.8.1 — core/lowgpu.ts renderStateFor). Hidden stays hidden.
//
// The long-standing names carry the RENDER state — winState(), winFocused(), useWinState(), useWinFocused(),
// onWinState(), adaptiveInterval() — so every drawing rule follows the option: the motion switch `animate`
// (ui/motion.ts), the timers that coarsen to ≥ 1 s (`adaptiveInterval`), GIFs, meters, the call's video policy and
// previews (features/calls/engine.ts), the stats / widget refresh. What depends on REAL focus reads realWinState() /
// useRealWinState() / onRealWinState(): the incoming-call ring (GPU.md §2.3) and the call chrome. (Notifications /
// unread and the caret never used this module.)
//
// Built from focus/blur, `visibilitychange` and `document.hasFocus()`, mirrored to `<html data-win="…">` (REAL) and
// `<html data-render="…">` (RENDER) — also on the <html> of every registered pop-out window, so a Document PiP
// window's copied stylesheet sees the same state. Every change of either state or of the option is logged once
// (tag `winstate`, console + the bug-report log ring): "[winstate] focused → unfocused (render: focused, option off)".
//
// Pop-out windows (Document Picture-in-Picture: a popped-out call tile, the voice HUD, the overlay) count as the app:
// focusing one of them keeps the app "focused" (the user is working with Tin Hat); `registerAuxWindow` is how a
// feature tells us about one. A focused <iframe> of ours (the watch-party player, an embed) makes the top window get
// `blur` while `document.hasFocus()` stays true; no event says when that iframe loses the focus to another app, so
// the state is re-read once a second only while that is the case.
//
// The pure rules (computeWinState, renderStateFor, unfocusedSaverOn, intervalFor, winStateLogText) live in
// core/lowgpu.ts with the rest of the contract's rules. (Relative imports only: ui/motion.ts imports this module and
// the Node unit tests load it without the "@/" alias.)
import { useSyncExternalStore } from "react";
import { computeRenderState, computeWinState, intervalFor, renderStateFor, unfocusedSaverOn, UNFOCUSED_SAVER_PREF, winStateLogText, type WinState } from "./lowgpu";
import { getPrefRaw, onPrefChange } from "./prefs";
import { createLogger } from "./log";

export { computeRenderState, computeWinState, intervalFor, type WinState };

// ---- the store --------------------------------------------------------------------------------------------------

type Listener = (now: WinState, prev: WinState) => void;
/** RENDER-state listeners (onWinState) */
const listeners = new Set<Listener>();
/** REAL-state listeners (onRealWinState) */
const realListeners = new Set<Listener>();
/** the RENDER state */
let state: WinState = "focused";
/** the REAL state */
let real: WinState = "focused";
/** the option (Settings → Appearance → Performance), read at install and on every change of its pref */
let saver = false;
let installed = false;
const log = createLogger("winstate");
const aux = new Set<Window>();
let iframePoll = 0;

function hasDoc(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

function read(): WinState {
  if (!hasDoc()) return "focused";
  const visible = document.visibilityState !== "hidden";
  let focused = false;
  try {
    focused = document.hasFocus();
  } catch {
    focused = true;
  }
  if (!focused)
    for (const w of aux) {
      try {
        if (!w.closed && w.document.hasFocus()) focused = true;
      } catch {
        /* a closed / navigated pop-out */
      }
    }
  return computeWinState(visible, focused);
}

function readSaver(): boolean {
  try {
    return unfocusedSaverOn(getPrefRaw(UNFOCUSED_SAVER_PREF));
  } catch {
    return false;
  }
}

function mirror(w: Window) {
  try {
    w.document.documentElement.dataset.win = real;
    w.document.documentElement.dataset.render = state;
  } catch {
    /* closed */
  }
}

function notify(set: Set<Listener>, now: WinState, prev: WinState) {
  for (const l of [...set]) {
    try {
      l(now, prev);
    } catch (e) {
      console.warn("[winstate] listener", e);
    }
  }
}

function recompute() {
  const nextReal = read();
  // a focused iframe of ours: the top window got `blur` but still "has focus" — re-read once a second until it
  // doesn't (no event fires when the iframe loses the focus to another application)
  const viaIframe = nextReal === "focused" && hasDoc() && document.activeElement instanceof HTMLIFrameElement;
  if (viaIframe && !iframePoll) iframePoll = window.setInterval(recompute, 1000);
  else if (!viaIframe && iframePoll) {
    window.clearInterval(iframePoll);
    iframePoll = 0;
  }
  const nextSaver = readSaver();
  const nextRender = renderStateFor(nextReal, nextSaver);
  if (nextReal === real && nextRender === state && nextSaver === saver) return;
  const prevReal = real;
  const prevRender = state;
  real = nextReal;
  state = nextRender;
  saver = nextSaver;
  log.info(winStateLogText(prevReal, real, state, saver));
  if (hasDoc()) {
    mirror(window);
    for (const w of aux) mirror(w);
  }
  if (real !== prevReal) notify(realListeners, real, prevReal);
  if (state !== prevRender) notify(listeners, state, prevRender);
}

/** The RENDER state: the window state every low-GPU rule acts on (an unfocused window renders as focused unless the
 *  option is on). */
export function winState(): WinState {
  return state;
}

/** True while the RENDER state is focused (the window or a pop-out of it has the focus — or, with the option off, the
 *  window is merely visible). */
export function winFocused(): boolean {
  return state === "focused";
}

/** React: the RENDER state (re-renders on change). */
export function useWinState(): WinState {
  return useSyncExternalStore(subscribeWinState, winState, winState);
}

/** React: true while the RENDER state is focused. */
export function useWinFocused(): boolean {
  return useWinState() === "focused";
}

function subscribeWinState(cb: () => void): () => void {
  return onWinState(() => cb());
}

/** Subscribe to RENDER-state changes: cb(now, prev). Returns the unsubscribe function. */
export function onWinState(cb: Listener): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The REAL window state (focus + visibility) — for what depends on real focus (the ring, the call chrome). */
export function realWinState(): WinState {
  return real;
}

/** True while the app window (or a pop-out of it) REALLY has the focus. */
export function realWinFocused(): boolean {
  return real === "focused";
}

function subscribeRealWinState(cb: () => void): () => void {
  return onRealWinState(() => cb());
}

/** React: the REAL state (re-renders on change). */
export function useRealWinState(): WinState {
  return useSyncExternalStore(subscribeRealWinState, realWinState, realWinState);
}

/** React: true while the app REALLY has the focus. */
export function useRealWinFocused(): boolean {
  return useRealWinState() === "focused";
}

/** Subscribe to REAL-state changes: cb(now, prev). Returns the unsubscribe function. */
export function onRealWinState(cb: Listener): () => void {
  realListeners.add(cb);
  return () => void realListeners.delete(cb);
}

/** Settings → Appearance → Performance → "Save GPU while Tin Hat isn't focused" (default off). */
export function unfocusedSaver(): boolean {
  return saver;
}

/** Install the listeners (idempotent; main.tsx calls it before the first render). */
export function installWinState(): void {
  if (installed || !hasDoc()) return;
  installed = true;
  real = read();
  saver = readSaver();
  state = renderStateFor(real, saver);
  mirror(window);
  log.info(winStateLogText(real, real, state, saver));
  // the option (Settings, or another tab through the storage event) → the render state follows at once
  onPrefChange(UNFOCUSED_SAVER_PREF, recompute);
  window.addEventListener("focus", recompute);
  // blur: the focus may be moving into one of our iframes (hasFocus() true a moment later) — read after the move
  window.addEventListener("blur", () => {
    recompute();
    window.setTimeout(recompute, 0);
  });
  document.addEventListener("visibilitychange", recompute);
  window.addEventListener("pageshow", recompute);
  window.addEventListener("pagehide", recompute);
  // focusin/out inside the page can move the focus in and out of an iframe without a window event
  document.addEventListener("focusin", recompute);
  document.addEventListener("focusout", () => window.setTimeout(recompute, 0));
}

/** A pop-out window of ours (Document PiP): its focus counts as the app's, and its <html> gets `data-win` /
 *  `data-render`. Returns
 *  the unregister function (also run on the window's pagehide). */
export function registerAuxWindow(w: Window): () => void {
  if (aux.has(w)) return () => unregisterAuxWindow(w);
  aux.add(w);
  mirror(w);
  const on = () => recompute();
  const off = () => window.setTimeout(recompute, 0);
  try {
    w.addEventListener("focus", on);
    w.addEventListener("blur", off);
    w.addEventListener("pagehide", () => unregisterAuxWindow(w));
  } catch {
    /* closed already */
  }
  recompute();
  return () => unregisterAuxWindow(w);
}

function unregisterAuxWindow(w: Window) {
  if (!aux.delete(w)) return;
  recompute();
}

/** Every registered pop-out window (for mirroring other <html> attributes, e.g. ui/motion.ts). */
export function auxWindows(): ReadonlySet<Window> {
  return aux;
}

/** setInterval whose period follows the RENDER state: `focusedMs` while focused, `otherMs` (floored at 1 s) while
 *  unfocused, `hiddenMs` (floored at 1 s) while hidden. `tickOnFocus` runs `fn` once at once when the window
 *  regains the focus (a panel that refreshes slower while unfocused catches up immediately). Returns stop(). */
export function adaptiveInterval(fn: () => void, focusedMs: number, otherMs: number = focusedMs, opts: { hiddenMs?: number; tickOnFocus?: boolean } = {}): () => void {
  let t = 0;
  let period = -1;
  const arm = () => {
    const p = intervalFor(state, focusedMs, otherMs, opts.hiddenMs ?? otherMs);
    if (p === period && t) return;
    if (t) window.clearInterval(t);
    period = p;
    t = window.setInterval(fn, p);
  };
  arm();
  const off = onWinState((now, prev) => {
    arm();
    if (opts.tickOnFocus && now === "focused" && prev !== "focused") fn();
  });
  return () => {
    off();
    if (t) window.clearInterval(t);
    t = 0;
  };
}
