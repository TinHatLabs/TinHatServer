// overlay.tsx — the popup plumbing every floating primitive shares (Qt's Overlay.overlay):
// one portal layer above the app, a stack so Escape / outside-press close only the topmost
// popup (Qt closePolicy CloseOnEscape | CloseOnPressOutside), and the "keep the popup inside
// the window" placement Qt applies to every Popup (margins, shift rather than overflow).
import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

let layer: HTMLElement | null = null;

export function overlayLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  layer = document.getElementById("th-overlay");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "th-overlay";
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * Portal into the overlay layer. React bubbles synthetic events through portals to the JSX parent
 * (a Popover declared inside a <button> would click the button); the wrapper stops that, so a
 * popup behaves like Qt's Overlay.overlay child — outside its opener's item tree.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  return createPortal(
    <div style={{ display: "contents" }} onClick={stop} onPointerDown={stop} onPointerUp={stop} onMouseDown={stop} onContextMenu={stop} onKeyDown={stop} onDoubleClick={stop}>
      {children}
    </div>,
    overlayLayer(),
  );
}
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

// ---- popup stack -----------------------------------------------------------------------------
interface StackEntry {
  id: number;
  el: () => HTMLElement | null;
  /** extra elements that count as "inside" (the anchor button, a parent menu) */
  inside: () => (HTMLElement | null)[];
  onEscape?: () => void;
  onOutside?: () => void;
}
const stack: StackEntry[] = [];
let nextId = 1;
let installed = false;


function install() {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const top = stack[stack.length - 1];
      if (top?.onEscape) {
        e.preventDefault();
        e.stopPropagation();
        top.onEscape();
      }
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      // Close every popup the press is outside of, from the top down, stopping at the first one
      // that contains it (a press in a submenu keeps its parent menu open).
      for (let i = stack.length - 1; i >= 0; i--) {
        const s = stack[i];
        const t = e.target as Node | null;
        const els = [s.el(), ...s.inside()].filter(Boolean) as HTMLElement[];
        if (t && els.some((el) => el.contains(t))) break;
        s.onOutside?.();
      }
    },
    true,
  );
}

/** Register an open popup for Escape / outside-press handling while `open`. */
export function usePopupStack(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  opts: { onEscape?: () => void; onOutside?: () => void; inside?: () => (HTMLElement | null)[] },
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!open) return;
    install();
    const entry: StackEntry = {
      id: nextId++,
      el: () => ref.current,
      inside: () => optsRef.current.inside?.() ?? [],
      onEscape: () => optsRef.current.onEscape?.(),
      onOutside: () => optsRef.current.onOutside?.(),
    };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open, ref]);
}

/** Back (ISLANDS-ARCH §2.8): the topmost popup closes as Escape would close it; false when none is open. */
export function closeTopPopup(): boolean {
  const top = stack[stack.length - 1];
  if (!top?.onEscape) return false;
  top.onEscape();
  return true;
}

export function popupDepth(): number {
  return stack.length;
}

// ---- placement -------------------------------------------------------------------------------
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectOf(el: Element | null | undefined): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export type Placement = "below" | "above" | "right" | "left" | "center" | "at";

export interface PlaceOpts {
  /** the anchor rect (item-relative popups) or a point (x,y with 0 size) */
  anchor: Rect;
  size: { width: number; height: number };
  placement: Placement;
  /** horizontal alignment for below/above: start = anchor left, end = anchor right, center */
  align?: "start" | "center" | "end";
  /** gap between anchor and popup */
  gap?: number;
  /** Qt Popup.margins — distance kept from the window edge */
  margins?: number;
  /** flip to the other side when it doesn't fit (combo lists, tooltips); else shift (menus) */
  flip?: boolean;
  /** explicit offset added to the computed position (Qt popup(x, y) offsets) */
  offset?: { x: number; y: number };
}

/** Where a popup goes: requested spot, flipped if allowed, then shifted inside the window. */
export function placePopup(o: PlaceOpts): { x: number; y: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  const m = o.margins ?? 0;
  const gap = o.gap ?? 0;
  const { anchor: a, size: s } = o;
  let x = a.x, y = a.y;
  const alignX = () => (o.align === "end" ? a.x + a.width - s.width : o.align === "center" ? a.x + (a.width - s.width) / 2 : a.x);
  const alignY = () => (o.align === "end" ? a.y + a.height - s.height : o.align === "center" ? a.y + (a.height - s.height) / 2 : a.y);
  switch (o.placement) {
    case "below":
      x = alignX();
      y = a.y + a.height + gap;
      if (o.flip && y + s.height > vh - m && a.y - gap - s.height >= m) y = a.y - gap - s.height;
      break;
    case "above":
      x = alignX();
      y = a.y - gap - s.height;
      if (o.flip && y < m && a.y + a.height + gap + s.height <= vh - m) y = a.y + a.height + gap;
      break;
    case "right":
      x = a.x + a.width + gap;
      y = alignY();
      if (o.flip && x + s.width > vw - m && a.x - gap - s.width >= m) x = a.x - gap - s.width;
      break;
    case "left":
      x = a.x - gap - s.width;
      y = alignY();
      if (o.flip && x < m && a.x + a.width + gap + s.width <= vw - m) x = a.x + a.width + gap;
      break;
    case "center":
      // centred on the anchor rect (callers without an anchor pass the viewport)
      x = a.x + (a.width - s.width) / 2;
      y = a.y + (a.height - s.height) / 2;
      break;
    case "at":
      break;
  }
  if (o.offset) {
    x += o.offset.x;
    y += o.offset.y;
  }
  x = Math.min(x, vw - m - s.width);
  y = Math.min(y, vh - m - s.height);
  x = Math.max(m, x);
  y = Math.max(m, y);
  return { x: Math.round(x), y: Math.round(y) };
}

/** Measure `ref` after render and place it; returns the style to apply (hidden until placed). */
export function usePlacement(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  compute: (size: { width: number; height: number }) => { x: number; y: number },
  deps: unknown[],
): { left: number; top: number; visibility: "visible" | "hidden" } | null {
  const posRef = useRef<{ left: number; top: number } | null>(null);
  const [, force] = useForce();
  useLayoutEffect(() => {
    if (!open || !ref.current) {
      posRef.current = null;
      return;
    }
    const el = ref.current;
    const place = () => {
      const r = el.getBoundingClientRect();
      const p = compute({ width: r.width, height: r.height });
      if (!posRef.current || posRef.current.left !== p.x || posRef.current.top !== p.y) {
        posRef.current = { left: p.x, top: p.y };
        force();
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);
  if (!open) return null;
  const p = posRef.current;
  return p ? { left: p.left, top: p.top, visibility: "visible" } : { left: 0, top: 0, visibility: "hidden" };
}

function useForce(): [number, () => void] {
  const [n, f] = useReducer((x: number) => x + 1, 0);
  return [n, f];
}
