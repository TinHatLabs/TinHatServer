// winGeom.ts — the Space settings window's content rect, so its popups (confirm dialogs, the invite
// popover) centre on the WINDOW like a Qt Dialog/Popup parented to it (SSW:…) instead of on the page.
// Phones: the window is a full-screen sheet → nothing to do.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { keyboardInset } from "@/core/device";
import type { Rect } from "@/ui";

let winEl: HTMLElement | null = null;

/** SpaceSettingsWindow registers its content element (ref callback). */
export const setSpaceWinEl = (el: HTMLElement | null) => {
  winEl = el;
};

export function spaceWinRect(): Rect | null {
  if (!winEl || !winEl.isConnected || document.documentElement.dataset.ff === "mobile") return null;
  const r = winEl.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Style for a page-centred dialog (ConfirmDialog) that moves it onto the window's centre. */
export function useCenterOnWindow(open: boolean): CSSProperties | undefined {
  const [st, setSt] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const r = spaceWinRect();
    if (!r) return setSt(undefined);
    const dx = Math.round(r.x + r.width / 2 - window.innerWidth / 2);
    const dy = Math.round(r.y + r.height / 2 - window.innerHeight / 2);
    setSt(dx || dy ? { transform: `translate(${dx}px, ${dy}px)` } : undefined);
  }, [open]);
  return st;
}

/** Phones: is the on-screen keyboard up? (visualViewport shorter than the layout viewport by > 120 px —
 *  iOS keeps innerHeight when the keyboard opens; Android with interactive-widget=resizes-content shrinks
 *  both, so this stays false there and nothing needs to move; an iOS Home Screen app: see keyboardInset.) */
export function useKeyboardUp(enabled: boolean): boolean {
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return setUp(false);
    // a pinch-zoom shrinks the visual viewport too — only an unzoomed one counts as "keyboard"
    const on = () => setUp(vv.scale < 1.01 && keyboardInset(vv) > 120);
    on();
    vv.addEventListener("resize", on);
    return () => vv.removeEventListener("resize", on);
  }, [enabled]);
  return up;
}

/** Qt's window Escape shortcut (SSW:114-122) fires wherever focus is inside the window. In a browser a
 *  clicked button that disables or unmounts (Save changes, Discard, Sync now …) drops focus to <body>, so
 *  the window's own onKeyDown never sees the key. When the last pointer/focus interaction was inside the
 *  window and focus sits on <body>, Escape still closes it. Window listener in the bubble phase: a popup that
 *  handled the key first has already called preventDefault. */
export function useWindowEscapeFallback(enabled: boolean, onEscape: () => void) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    let inside = true; // the window opens focused
    const mark = (e: Event) => {
      inside = !!winEl && e.target instanceof Node && winEl.contains(e.target);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !inside) return;
      const a = document.activeElement;
      if (a && a !== document.body) return;
      e.preventDefault();
      cb.current();
    };
    document.addEventListener("pointerdown", mark, true);
    document.addEventListener("focusin", mark, true);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", mark, true);
      document.removeEventListener("focusin", mark, true);
      window.removeEventListener("keydown", key);
    };
  }, [enabled]);
}
