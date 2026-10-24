// motion.ts — the motion switch of the low-GPU contract (contract GPU.md §1, the web half):
//
//   reduce motion  = the app's pref (Settings → Appearance → Reduce motion, native `reduce-motion`) OR the OS setting
//                    (`prefers-reduced-motion: reduce`)                                → <html data-reduce-motion>
//   animate        = the window's RENDER state is focused (core/winstate.ts — a visible-but-unfocused window renders as
//                    focused unless Settings → Appearance → Performance → "Save GPU while Tin Hat isn't focused" is on,
//                    10.8.1) AND NOT reduce motion                                    → <html data-animate>
//
// Every CSS transition/animation and every JS animation keys off `animate`: tokens.css zeroes the duration token and
// snaps every transition/animation while <html> lacks `data-animate`; JS asks animate()/useAnimate() or durMs().
// The one exception is the incoming-call ring, which has its own switch (ringOn, GPU.md §2.3).
//
// ONE duration token: `dur` = 120 ms (Main.qml `dur`). The named steps are fixed multiples of it (short = 5/6 → 100,
// slow = 3/2 → 180, long = 5/3 → 200, verylong = 10/3 → 400 = the 400 ms cap) — tokens.css derives them from
// `--th-dur`, so the switch zeroes them all at once. No literal duration anywhere else (CSS or JS).
//
// The text caret (GPU.md §2.1): blinks for 5 s after a key / pointer press / focus, then stays solid; always solid
// under reduce motion. Chromium: `caret-animation: manual` while <html data-caret="still">. Firefox and Safari have
// no caret-animation (docs/WEB-EXCEPTIONS.md) — their caret keeps the platform blink while focused.
// (relative imports: themes.ts re-exports this module and the Node unit tests load themes.ts without the "@/" alias)
import { useSyncExternalStore } from "react";
import { auxWindows, installWinState, onWinState, winState } from "../core/winstate";
import { animateFor, CARET_BLINK_MS, DUR, type DurStep } from "../core/lowgpu";

export { DUR, type DurStep } from "../core/lowgpu";
export { animateFor, ringOn, ringHigh, RING_LIMIT_MS, RING_STEP_MS, RING_OPACITY } from "../core/lowgpu";

// ---- the switch ----------------------------------------------------------------------------------------------------

let prefReduced = false;
let osReduced = false;
let animating = false;
const listeners = new Set<() => void>();
let installed = false;

function hasDoc(): boolean {
  return typeof document !== "undefined";
}

/** Reduce motion is on: the app's pref OR the OS setting. */
export function reducedMotion(): boolean {
  return prefReduced || osReduced;
}

/** The motion switch: the RENDER state is focused AND NOT reduce motion. */
export function animate(): boolean {
  return animating;
}

/** The duration of a step in ms while `animate`, 0 otherwise (Main.qml `dur` = 0 with Reduce motion). */
export function durMs(step: DurStep = "dur"): number {
  return animating ? DUR[step] : 0;
}

function setAttr(root: HTMLElement, name: string, on: boolean, value = "") {
  if (on) root.setAttribute(name, value);
  else root.removeAttribute(name);
}

function paint(root: HTMLElement) {
  setAttr(root, "data-reduce-motion", reducedMotion());
  setAttr(root, "data-animate", animating);
}

function update() {
  const next = animateFor(winState(), reducedMotion());
  const changed = next !== animating;
  animating = next;
  if (hasDoc()) {
    paint(document.documentElement);
    for (const w of auxWindows()) {
      try {
        paint(w.document.documentElement);
      } catch {
        /* closed */
      }
    }
  }
  if (reducedMotion()) caretStill();
  for (const l of [...listeners]) l();
  void changed;
}

/** The app's Reduce motion pref (main.tsx at boot, App.tsx on every change). The OS setting is added by
 *  installMotion(); reducedMotion() is the OR of both. */
export function applyReducedMotion(on: boolean): void {
  prefReduced = !!on;
  update();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** React: reduce motion (pref OR OS). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedMotion, reducedMotion);
}

/** React: the motion switch. */
export function useAnimate(): boolean {
  return useSyncExternalStore(subscribe, animate, animate);
}

/** Subscribe to motion-switch / reduce-motion changes (non-React). */
export function onMotionChange(cb: () => void): () => void {
  return subscribe(cb);
}

// ---- the caret -----------------------------------------------------------------------------------------------------

let caretTimer: ReturnType<typeof setTimeout> | 0 = 0;
function caretStill() {
  if (caretTimer) clearTimeout(caretTimer);
  caretTimer = 0;
  if (hasDoc()) document.documentElement.setAttribute("data-caret", "still");
}
/** A key / pointer press / focus: the caret blinks again for CARET_BLINK_MS (solid at once under reduce motion). */
export function caretWake(): void {
  if (!hasDoc()) return;
  if (reducedMotion()) return caretStill();
  document.documentElement.removeAttribute("data-caret");
  if (caretTimer) clearTimeout(caretTimer);
  caretTimer = setTimeout(caretStill, CARET_BLINK_MS);
}

// ---- install -------------------------------------------------------------------------------------------------------

/** Window state + OS reduce-motion listener + caret; idempotent (main.tsx, before the first render). */
export function installMotion(): void {
  if (installed || !hasDoc()) return;
  installed = true;
  installWinState();
  try {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    osReduced = mq.matches;
    mq.addEventListener("change", () => {
      osReduced = mq.matches;
      update();
    });
  } catch {
    osReduced = false;
  }
  onWinState(() => update());
  // the caret: capture phase, so a handler that stops propagation can't keep it blinking
  const wake = () => caretWake();
  document.addEventListener("keydown", wake, true);
  document.addEventListener("pointerdown", wake, true);
  document.addEventListener("focusin", wake, true);
  window.addEventListener("focus", wake);
  update();
  caretWake();
}
