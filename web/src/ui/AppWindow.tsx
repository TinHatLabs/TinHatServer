// AppWindow.tsx — the in-app stand-in for the native secondary OS windows (Calendar, Memories,
// Watch Party, Space settings, Game Reel, Icon gallery…). A browser tab has one window, so these
// become floating panels inside it: a title bar (app icon, centred title, maximise + close — the
// KDE Breeze decoration shape, coloured from the app's KColorScheme [WM] group: panel / text),
// drag by the title bar, resize from every edge and corner, double-click the title to maximise,
// click anywhere to raise. Geometry is remembered per window id exactly like WindowMemory.qml:
// prefs `<id>-w`, `<id>-h`, `<id>-x`, `<id>-y` (windowed) and `<id>-max` (maximised), restored on
// open, saved 900 ms after the last change. On phones the window is a full-screen sheet with a
// back chevron (ARCHITECTURE "mobile").
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getPref, setPref } from "@/core/prefs";
import { Icon } from "./Icon";
import { useIsMobile } from "./formFactor";
import { useBackToClose } from "./backStack";
import { cx } from "./hooks";
import s from "./AppWindow.module.css";
import { clampGeo as clampTo, TITLE_H, type Geo } from "./windowGeo";
import { isTouch } from "@/core/device";

export interface AppWindowProps {
  /** WindowMemory key ([a-z0-9-]) */
  id: string;
  title: string;
  icon?: string;
  defaultSize?: { width: number; height: number };
  minSize?: { width: number; height: number };
  onClose: () => void;
  /** z-order from the WindowHost */
  z?: number;
  active?: boolean;
  onRaise?: () => void;
  resizable?: boolean;
  maximizable?: boolean;
  /** open maximised the first time (no remembered geometry) */
  startMaximized?: boolean;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** cascade index so several new windows don't stack exactly */
  cascade?: number;
  /** phones: false = no sheet header (the content draws its own back chevron + title). Default true. */
  phoneHeader?: boolean;
  /** first open without remembered geometry: centred (default) or docked at the right edge (Media Party 11.4) */
  defaultPlacement?: "center" | "right";
  /** content-driven geometry (the Media Party mini player, 11.3 QOL): while set, the window is drawn here instead of at
   *  its own geometry, which stays untouched and is never overwritten by this one (so clearing it returns to exactly
   *  where it was, maximised or not). Fixed size, no resize edges / maximise; the title bar still drags it. */
  floating?: FloatingGeo | null;
}

/** Outer geometry (title bar included) of a floating window; `onMove` reports where a title-bar drag left it. */
export interface FloatingGeo {
  x: number;
  y: number;
  w: number;
  h: number;
  /** keep it above every other in-app window (WindowHost) */
  onTop?: boolean;
  onMove?: (x: number, y: number) => void;
}

/** --th-z-window (tokens.css); raised windows stack above it */
const WINDOW_Z = 200;
const EDGE = 6;

const clampGeo = (g: Geo, min: { width: number; height: number }) => clampTo(g, min, isTouch);

/** Keep a floating window on screen (its size is the content's own). */
export function clampFloating(f: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  return { x: Math.round(Math.min(Math.max(f.x, 0), Math.max(0, vw - f.w))), y: Math.round(Math.min(Math.max(f.y, 0), Math.max(0, vh - f.h))) };
}

export function restoreGeometry(id: string, def: { width: number; height: number }, min: { width: number; height: number }, cascade = 0, placement: "center" | "right" = "center"): { geo: Geo; max: boolean } {
  const w = getPref(`${id}-w`, NaN), h = getPref(`${id}-h`, NaN);
  const x = getPref(`${id}-x`, NaN), y = getPref(`${id}-y`, NaN);
  const vw = window.innerWidth, vh = window.innerHeight;
  const size = !isNaN(w) && !isNaN(h) && w >= min.width && h >= min.height && w < 16000 && h < 16000 ? { w, h } : { w: def.width, h: def.height };
  const pos =
    !isNaN(x) && !isNaN(y) && x > -4000 && y > -4000 && x < 16000 && y < 16000
      ? { x, y }
      : placement === "right"
        ? { x: Math.max(0, vw - Math.min(size.w, vw) - 16), y: Math.min(72, Math.max(0, vh - Math.min(size.h, vh))) }
        : { x: (vw - Math.min(size.w, vw)) / 2 + cascade * 24, y: Math.max(0, (vh - Math.min(size.h, vh)) / 2 - 30) + cascade * 24 };
  return { geo: clampGeo({ ...pos, ...size }, min), max: getPref(`${id}-max`, false) };
}

export function AppWindow(p: AppWindowProps) {
  const mobile = useIsMobile();
  if (mobile) return <SheetWindow {...p} />;
  return <DesktopWindow {...p} />;
}

function DesktopWindow({
  id,
  title,
  icon,
  defaultSize = { width: 720, height: 560 },
  minSize = { width: 320, height: 240 },
  onClose,
  z = 0,
  active = true,
  onRaise,
  resizable = true,
  maximizable = true,
  startMaximized,
  defaultPlacement,
  className,
  bodyClassName,
  style,
  children,
  cascade = 0,
  floating,
}: AppWindowProps) {
  // floating (mini player): its own position, seeded from the content's geometry whenever that changes
  const [fpos, setFpos] = useState<{ x: number; y: number } | null>(null);
  const fposRef = useRef(fpos);
  fposRef.current = fpos;
  useLayoutEffect(() => {
    setFpos(floating ? clampFloating(floating) : null);
  }, [floating]);
  const [{ geo, max }, setState] = useState(() => {
    const r = restoreGeometry(id, defaultSize, minSize, cascade, defaultPlacement);
    const remembered = !isNaN(getPref(`${id}-w`, NaN));
    return { geo: r.geo, max: r.max || (!remembered && !!startMaximized) };
  });
  const saveTimer = useRef(0);
  const drag = useRef<{ kind: string; x0: number; y0: number; g0: Geo } | null>(null);

  // WindowMemory.save(): maximised is remembered as a flag, never as a size
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      setPref(`${id}-max`, max);
      if (max) return;
      if (geo.w < minSize.width || geo.h < minSize.height) return;
      setPref(`${id}-w`, geo.w);
      setPref(`${id}-h`, geo.h);
      setPref(`${id}-x`, geo.x);
      setPref(`${id}-y`, geo.y);
    }, 900);
    return () => window.clearTimeout(saveTimer.current);
  }, [id, geo, max, minSize.width, minSize.height]);

  // keep it on screen when the browser window shrinks
  useEffect(() => {
    const onResize = () => {
      setState((st) => ({ ...st, geo: clampGeo(st.geo, minSize) }));
      if (floating) setFpos((p) => (p ? clampFloating({ ...p, w: floating.w, h: floating.h }) : p));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [minSize, floating]);

  const onPointerDown = useCallback(
    (kind: string) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      onRaise?.();
      if (floating && kind !== "move") return;
      if (max && kind !== "move" && !floating) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const g0 = floating ? { x: fpos?.x ?? floating.x, y: fpos?.y ?? floating.y, w: floating.w, h: floating.h } : geo;
      drag.current = { kind: floating ? "float" : kind, x0: e.clientX, y0: e.clientY, g0 };
    },
    [geo, max, onRaise, floating, fpos],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
      if (d.kind === "float") {
        setFpos(clampFloating({ x: d.g0.x + dx, y: d.g0.y + dy, w: d.g0.w, h: d.g0.h }));
        return;
      }
      let { x, y, w, h } = d.g0;
      if (d.kind === "move") {
        if (max) {
          // dragging a maximised window un-maximises it under the pointer (KWin behaviour)
          if (Math.hypot(dx, dy) < 6) return;
          const fx = (d.x0 - 0) / window.innerWidth;
          const g = { ...d.g0, x: e.clientX - d.g0.w * fx, y: e.clientY - TITLE_H / 2 };
          drag.current = { ...d, x0: e.clientX, y0: e.clientY, g0: g };
          setState({ geo: clampGeo(g, minSize), max: false });
          return;
        }
        x += dx;
        y += dy;
      } else {
        if (d.kind.includes("e")) w = Math.max(minSize.width, d.g0.w + dx);
        if (d.kind.includes("s")) h = Math.max(minSize.height, d.g0.h + dy);
        if (d.kind.includes("w")) {
          w = Math.max(minSize.width, d.g0.w - dx);
          x = d.g0.x + d.g0.w - w;
        }
        if (d.kind.includes("n")) {
          h = Math.max(minSize.height, d.g0.h - dy);
          y = d.g0.y + d.g0.h - h;
        }
      }
      setState((st) => ({ ...st, geo: clampGeo({ x, y, w, h }, minSize) }));
    },
    [max, minSize],
  );
  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "float" && fposRef.current) floating?.onMove?.(fposRef.current.x, fposRef.current.y);
  }, [floating]);
  const canMax = maximizable && !floating;
  const toggleMax = () => canMax && setState((st) => ({ ...st, max: !st.max }));

  const zIndex = WINDOW_Z + z;
  const box: CSSProperties = floating
    ? { left: fpos?.x ?? floating.x, top: fpos?.y ?? floating.y, width: floating.w, height: floating.h, zIndex }
    : max
      ? { left: 0, top: 0, width: "100%", height: "100%", zIndex }
      : { left: geo.x, top: geo.y, width: geo.w, height: geo.h, zIndex };
  return (
    <div
      className={cx(s.win, max && !floating && s.max, active && s.active, className)}
      data-floating={floating ? "" : undefined}
      style={{ ...box, ...style }}
      role="dialog"
      aria-label={title}
      onPointerDownCapture={() => onRaise?.()}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className={s.titlebar} onPointerDown={onPointerDown("move")} onDoubleClick={toggleMax}>
        <span className={s.appIcon}>
          {icon ? <Icon name={icon} size={16} /> : <img src={`${import.meta.env.BASE_URL}appicon/tinhat-256.png`} alt="" width={16} height={16} draggable={false} />}
        </span>
        <span className={s.title}>{title}</span>
        <span className={s.buttons} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {canMax && (
            <button type="button" className={s.wbtn} aria-label={max ? "Restore" : "Maximize"} title={max ? "Restore" : "Maximize"} onClick={toggleMax}>
              {max ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M2.5 0.5h7v7M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M1 7 L5 3 L9 7" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              )}
            </button>
          )}
          <button type="button" className={cx(s.wbtn, s.close)} aria-label="Close" title="Close" onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </span>
      </div>
      <div className={cx(s.body, bodyClassName)}>{children}</div>
      {resizable && !max && !floating &&
        ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((k) => (
          <span key={k} className={cx(s.edge, s[`e_${k}`])} onPointerDown={onPointerDown(k)} style={{ ["--edge" as string]: `${EDGE}px` }} />
        ))}
    </div>
  );
}

// Phone sheets close on the browser / Android back button (level 0 of the shared back stack — a sheet
// inside the window, e.g. the calendar's event sheet, is level 1 and closes first).
function SheetWindow({ title, onClose, children, bodyClassName, className, z = 0, phoneHeader = true }: AppWindowProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  useBackToClose(true, onClose, 0);
  return (
    <div ref={ref} tabIndex={-1} className={cx(s.sheet, className)} style={{ zIndex: WINDOW_Z + z }} role="dialog" aria-label={title}>
      {phoneHeader && (
        <div className={s.sheetHeader}>
          <button type="button" className={s.back} aria-label="Back" onClick={onClose}>
            <Icon name="go-previous-symbolic" size={22} />
          </button>
          <span className={s.sheetTitle}>{title}</span>
        </div>
      )}
      <div className={cx(s.body, bodyClassName)}>{children}</div>
    </div>
  );
}
