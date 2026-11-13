// focus.ts — keyboard focus for popups (accessibility pass, fix/a11y-pass). The desktop's Qt Menu / Popup takes the
// keyboard focus when it opens and the item that had it gets it back when it closes; a web popup gets the same here:
//   useFocusReturn(ref)  remember what had focus when the popup mounted, give it back when it unmounts — only while focus
//                        is still in the popup or nowhere (an item that opened a dialog leaves the dialog its focus)
//   firstFocusable(el)   where a keyboard user starts inside a popup: its text field (not a switch), else its first control
//   focusInto(el, ctl)   focus a popup that opened: its first control (from the keyboard) or the popup itself
import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]):not([disabled])';
const TEXT_FIELD =
  'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"]';

// The last input: a popup opened from the KEYBOARD puts the focus on its first control (a ring a keyboard user follows);
// opened by pointer/touch (or by the app) it focuses the popup itself (no ring; Tab then walks in) — Qt does the same:
// a Popup has the focus, its controls show focus only after a key.
let keyboardLast = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => { if (!e.repeat) keyboardLast = true; }, true);
  window.addEventListener("pointerdown", () => { keyboardLast = false; }, true);
}
export function lastInputWasKeyboard(): boolean {
  return keyboardLast;
}

function usable(e: HTMLElement): boolean {
  if (e.getClientRects().length === 0 || e.closest('[inert], [aria-disabled="true"], fieldset:disabled')) return false;
  return getComputedStyle(e).visibility === "visible";
}

/** The control a keyboard user starts on inside `root`: its first text field, else its first control, else null. */
export function firstFocusable(root: HTMLElement): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(usable);
  return all.find((e) => e.matches(TEXT_FIELD)) ?? all[0] ?? null;
}

/** Focus into a popup that just opened: its first control when `control`, and the popup itself whenever that didn't take. */
export function focusInto(root: HTMLElement, control: boolean): void {
  if (root.contains(document.activeElement)) return;
  if (control) firstFocusable(root)?.focus({ preventScroll: true });
  if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
}

/** On unmount, focus goes back to what had it when the popup mounted (see the file header). */
export function useFocusReturn(ref: RefObject<HTMLElement | null>): void {
  // read during the first render: before any effect inside the popup moves the focus
  const prev = useRef<Element | null | undefined>(undefined);
  if (prev.current === undefined) prev.current = typeof document === "undefined" ? null : document.activeElement;
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      const back = prev.current as HTMLElement | null;
      if (!back || back === document.body || !back.isConnected || typeof back.focus !== "function") return;
      const a = document.activeElement;
      if (!a || a === document.body || !a.isConnected || (el?.contains(a) ?? false)) back.focus({ preventScroll: true });
      // a menu and its submenu closing together: the submenu hands the focus to its parent menu, which is removed in the
      // same commit — check again once the commit is done and give it to the opener that is still there
      queueMicrotask(() => {
        const b = document.activeElement;
        if ((!b || b === document.body || !b.isConnected) && back.isConnected) back.focus({ preventScroll: true });
      });
    };
  }, [ref]);
}
