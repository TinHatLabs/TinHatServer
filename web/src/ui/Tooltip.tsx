// Tooltip.tsx — Controls.ToolTip (Basic style) as the app uses it: `ToolTip.text: tip`,
// `ToolTip.visible: hovered && tip.length > 0`, `ToolTip.delay: 400`. One shared tooltip at a time
// (Qt's attached ToolTip is a single instance), centred ABOVE the item 3 px away, kept 6 px inside
// the window. Look: palette.toolTipBase (the KColorScheme [Colors:Tooltip] = panelHi) with a 1 px
// palette.dark border, padding 6, 12 px text in palette.toolTipText. Touch devices get none.
//
//   const ref = useRef<HTMLButtonElement>(null); useTip(ref, "Report a problem");
//   <Tooltip text="Mute"><button …/></Tooltip>        // wrapper form (first element child)
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { OverlayPortal, placePopup, rectOf, type Rect } from "./overlay";
import s from "./Tooltip.module.css";

interface TipState {
  text: string;
  anchor: Rect;
  placement: "above" | "below";
  key: number;
}
let state: TipState | null = null;
const listeners = new Set<() => void>();
let seq = 0;
function setState(n: TipState | null) {
  state = n;
  for (const l of listeners) l();
}
function useTipState() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => null,
  );
}

export function hideTooltip(): void {
  if (state) setState(null);
}

export interface TipOptions {
  delay?: number;
  placement?: "above" | "below";
  /** keep showing while this is true even without hover (e.g. a pinned hint) */
  disabled?: boolean;
}

/** Attach a tooltip to an element. `text` "" = none. */
export function useTip(ref: RefObject<HTMLElement | null>, text: string | undefined | null, opts: TipOptions = {}): void {
  const textRef = useRef(text);
  textRef.current = text;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mine = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    const touch = () => document.documentElement.dataset.touch !== undefined;
    const show = () => {
      const t = textRef.current;
      if (!t || optsRef.current.disabled || !el.isConnected) return;
      const r = rectOf(el);
      if (!r) return;
      mine.current = ++seq;
      setState({ text: t, anchor: r, placement: optsRef.current.placement ?? "above", key: mine.current });
    };
    const enter = (e: PointerEvent) => {
      if (e.pointerType === "touch" || touch()) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(show, optsRef.current.delay ?? 400);
    };
    const leave = () => {
      window.clearTimeout(timer);
      if (state && state.key === mine.current) setState(null);
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", leave);
    el.addEventListener("wheel", leave, { passive: true });
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", leave);
      el.removeEventListener("wheel", leave);
      if (state && state.key === mine.current) setState(null);
    };
  }, [ref]);
  // Text changed while showing (e.g. "Mute" → "Unmute"): update in place.
  useEffect(() => {
    if (state && state.key === mine.current) {
      if (!text) setState(null);
      else if (state.text !== text) setState({ ...state, text });
    }
  }, [text]);
}

/** Wrapper form: tooltips its first element child. */
export function Tooltip({ text, children, delay, placement }: { text: string; children: ReactNode; delay?: number; placement?: "above" | "below" }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const target = useRef<HTMLElement | null>(null);
  const [, setReady] = useState(false);
  useLayoutEffect(() => {
    target.current = (wrap.current?.firstElementChild as HTMLElement | null) ?? null;
    setReady(true);
  }, []);
  useTip(target, text, { delay, placement });
  return (
    <span ref={wrap} style={{ display: "contents" }}>
      {children}
    </span>
  );
}

/** The one tooltip surface. Mounted once by the App. */
export function TooltipHost() {
  const st = useTipState();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!st || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    setPos(
      placePopup({
        anchor: st.anchor,
        size: { width: r.width, height: r.height },
        placement: st.placement,
        align: "center",
        gap: 3,
        margins: 6,
      }),
    );
  }, [st]);
  if (!st) return null;
  return (
    <OverlayPortal>
      <div
        ref={ref}
        role="tooltip"
        className={s.tip}
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }}
      >
        {st.text}
      </div>
    </OverlayPortal>
  );
}
