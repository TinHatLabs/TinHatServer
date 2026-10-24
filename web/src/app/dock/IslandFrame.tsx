// IslandFrame.tsx — one island's frame in the dock host (ISLANDS-ARCH §2.4, §3.4; the desktop's Island.qml): absolutely
// positioned at its solver rect (frame.ts), `data-island=<ref>` for the gates and focus recovery. The island look: the
// fill (island.bg.<ref>) UNDER the content, the 1 px frame (island.border) ABOVE it — content that paints to its edge
// never covers the frame — and the theme's corner radius; the content inset ceil(0.293 × radius) (the host passes it;
// the header's is 0: its gradient rounds itself), never a negative content size. Radius and frame width are the host's
// (--island-radius / --island-border: the theme's shape, or 0 / 0 in the Flat layout style). `flush` frames draw nothing and inset
// nothing (the widget stack: every widget is its own card). No `overflow`, no paint containment, no filter (§2.8, the
// low-GPU rule): popups escape through the overlay portal, the one-time question card floats above the account island.
//
// A hidden island stays mounted (`visibility: hidden` + `inert`: state kept, nothing painted, out of the Tab order) and
// keeps its last box, so its content keeps a sensible width while it is away. How its size reaches the layout:
//   "dom"       the content's natural height (a ResizeObserver on the content box, which is as tall as its content,
//               whatever the frame's height) + 2 × inset — the host quantizes it (§2.1)
//   "none"      unmeasured (a fill island: the registry's pref / minimum applies); the content box fills the frame
//   "explicit"  the content reports through useIsland().report() (the call, the widget stack); fills the frame
// Islands in a drawer panel (z band 20) ride the drawer's fade + slide and keep it open while the pointer is over them.
// 11.0 edit mode: an absent island's placeholder is drawn by its frame, above the content and under the frame line
// (frame.ts FRAME_LAYERS, EDITMODE-UI §20) — so a floating island covers it the way it covers content. It changes no size.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { IslandContext, type IslandCtx, type IslandReport } from "@/ui/island";
import type { IslandOut } from "@/layout/solve";
import { FRAME_LAYERS, contentBox, domMeasured, frameRect, inDrawerBand, islandBg, type FrameLayer } from "./frame";
import s from "./DockHost.module.css";

export type MeasureMode = "dom" | "none" | "explicit";
/** What an island tells the host about its size (px, the frame's inset included). */
export interface Measured {
  /** a natural width (only islands that report one: your own button islands, 11.0) */
  w?: number;
  h?: number;
  minH?: number;
  empty?: boolean;
}

export const IslandFrame = memo(function IslandFrame(p: {
  islandRef: string;
  rect: IslandOut | undefined;
  /** a layout has been applied (before the first solve every frame takes the whole host, unpainted) */
  solved: boolean;
  measure: MeasureMode;
  onMeasure: (ref: string, m: Measured) => void;
  /** content inset (px) */
  inset: number;
  flush: boolean;
  /** the fill when not island.bg.<ref> */
  fill?: string;
  /** "dom": the natural height is also the minimum (the composer — frame.ts domMeasured) */
  minIsNatural?: boolean;
  role?: string;
  label?: string;
  /** the drawer's panel is open (its islands fade + slide in) */
  drawerOpen: boolean;
  onDrawerHover: (ref: string, on: boolean) => void;
  /** 11.0 edit mode: the placeholder of absent content (EDITMODE-UI §2), drawn above the content, under the frame line */
  placeholder?: ReactNode;
  children: ReactNode;
}) {
  const { islandRef: ref, onMeasure, measure, onDrawerHover, solved } = p;
  const minIsNatural = !!p.minIsNatural;
  const inset = p.flush ? 0 : Math.max(0, p.inset);
  const inner = useRef<HTMLDivElement>(null);
  const last = useRef<IslandOut | undefined>(undefined);
  if (p.rect) last.current = p.rect;
  const placed = last.current !== undefined;
  const geo = frameRect(last.current);
  const shown = frameRect(p.rect).visible;
  const box = contentBox(geo.width, geo.height, inset);
  const inDrawer = p.rect !== undefined && inDrawerBand(geo.zIndex);

  // "dom": the content box is as tall as its content → its height is the natural height
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || measure !== "dom") return;
    const ro = new ResizeObserver((entries) => {
      const bs = entries[entries.length - 1]?.borderBoxSize?.[0]?.blockSize;
      onMeasure(ref, domMeasured(typeof bs === "number" ? bs : el.getBoundingClientRect().height, inset, minIsNatural));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, onMeasure, measure, inset, minIsNatural]);

  // "explicit": the content's own report (content-box px; the inset is added here)
  const report = useCallback(
    (r: IslandReport) => {
      if (measure !== "explicit") return;
      const m: Measured = {};
      if (typeof r.w === "number" && Number.isFinite(r.w)) m.w = Math.max(0, r.w) + 2 * inset;
      if (typeof r.h === "number" && Number.isFinite(r.h)) m.h = Math.max(0, r.h) + 2 * inset;
      if (typeof r.minH === "number" && Number.isFinite(r.minH)) m.minH = Math.max(0, r.minH) + 2 * inset;
      if (r.empty) m.empty = true;
      onMeasure(ref, m);
    },
    [ref, onMeasure, measure, inset],
  );

  // leaving the drawer (docked again, or unmounted) ends its hover
  useEffect(() => {
    if (!inDrawer) onDrawerHover(ref, false);
    return () => onDrawerHover(ref, false);
  }, [inDrawer, ref, onDrawerHover]);

  const ctx = useMemo<IslandCtx>(
    () => ({ ref, w: box.w, h: box.h, z: geo.zIndex, visible: solved && shown, inset, report }),
    [ref, box.w, box.h, geo.zIndex, solved, shown, inset, report],
  );

  // Before the host's first solve there is no rect yet: the frame takes the whole host, unpainted (opacity 0) but NOT
  // hidden or inert — a component that focuses itself on mount (the composer) must not lose that focus to the one
  // frame it takes the host to measure itself (visibility: hidden and inert both refuse focus).
  const style: CSSProperties = !solved
    ? { inset: 0, opacity: 0, pointerEvents: "none" }
    : placed
      ? { left: geo.left, top: geo.top, width: geo.width, height: geo.height, zIndex: geo.zIndex, visibility: shown ? undefined : "hidden" }
      : { inset: 0, visibility: "hidden" };
  const contentStyle = {
    ...(measure === "dom" ? { top: inset, left: inset, right: inset } : { inset }),
    ["--island-inset" as string]: `${inset}px`,
  } as CSSProperties;
  // the frame's parts, painted in the host's order (FRAME_LAYERS: fill → content → placeholder → line)
  const parts: Record<FrameLayer, ReactNode> = {
    fill: p.flush ? null : <div className={s.bg} style={{ background: p.fill ?? islandBg(ref) }} />,
    content: (
      <div ref={inner} className={s.content} style={contentStyle}>
        <IslandContext.Provider value={ctx}>{p.children}</IslandContext.Provider>
      </div>
    ),
    placeholder: p.placeholder ? <IslandContext.Provider value={ctx}>{p.placeholder}</IslandContext.Provider> : null,
    line: p.flush ? null : <div className={s.line} />,
  };
  return (
    <div
      className={s.frame}
      data-island={ref}
      data-flush={p.flush ? "" : undefined}
      data-drawer={inDrawer ? "" : undefined}
      data-open={inDrawer && shown && p.drawerOpen ? "" : undefined}
      role={p.role}
      aria-label={p.label}
      tabIndex={-1}
      inert={solved && !shown}
      style={style}
      onPointerEnter={inDrawer ? () => onDrawerHover(ref, true) : undefined}
      onPointerLeave={inDrawer ? () => onDrawerHover(ref, false) : undefined}
    >
      {FRAME_LAYERS.map((k) => (
        <Fragment key={k}>{parts[k]}</Fragment>
      ))}
    </div>
  );
});
