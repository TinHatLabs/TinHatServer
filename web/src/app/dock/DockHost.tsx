// DockHost.tsx — the flat dock host (ISLANDS-ARCH §2.4; the desktop's DockHost.qml, on the same rules: host.ts). Every
// island is an absolutely positioned IslandFrame child of ONE element, rendered in the fixed logical region order (never
// reordered: a moved iframe would reload) and keyed by its ref, so moving an island only changes styles (no unmount —
// the call keeps its tracks). A ResizeObserver on the host and each island's own size report (IslandFrame: "dom" =
// the content's natural height, "explicit" = the content reports, "none" = unmeasured) feed solve() (src/layout, the TS
// reference the vectors run) through the quantized measurement and the bounded episodes of §2.1; nothing runs per
// frame. The island look (fill, 1 px frame, radius, content inset ceil(0.293 × radius)) is IslandFrame's.
// ?debug=layout logs every applied solve (its inputs) and rect, and keeps the last one in window.__twLayout (gates).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { REGION_ORDER, solve, type Json, type SolveOut } from "@/layout";
import { Episode, inClosedDrawer, q, recoverTarget, type Content } from "./host";
import { contentInset } from "./frame";
import { IslandFrame, type MeasureMode, type Measured } from "./IslandFrame";
import s from "./DockHost.module.css";

export interface IslandDef {
  ref: string;
  node: ReactNode;
  /** nothing to show — the island leaves the layout (the DM strip without DMs); explicit islands may report it too */
  empty?: boolean;
  /** how its size reaches the layout: "dom" (default: the content's natural height), "none" (a fill island: the
   *  registry's pref / minimum), "explicit" (the content reports through useIsland().report) */
  measure?: MeasureMode;
  /** draws nothing and insets nothing (the widget stack) */
  flush?: boolean;
  /** the content inset (px) when not ceil(0.293 × radius) — the header's gradient rounds itself: 0 */
  inset?: number;
  /** the landmark (ISLANDS-ARCH §2.7) */
  role?: string;
  label?: string;
  /** the fill when not island.bg.<ref> (a CSS colour: the Flat layout's account and composer islands) */
  fill?: string;
  /** "dom" islands: the natural height is also the minimum (10.8: the composer — never squeezed under a call) */
  minIsNatural?: boolean;
  /** 11.0 edit mode: the island takes part even when it (or its content) says it is empty (EDITMODE-UI §2) */
  present?: boolean;
  /** 11.0 edit mode: the placeholder of absent content — drawn by the island's own frame, above its content and under
   *  its frame line, so a floating island covers it (EDITMODE-UI §2, §20) */
  placeholder?: ReactNode;
}

/** What the last solve was fed (edit mode's drop zones, previews and resizes use the same inputs, LAYOUT.md §8). */
export interface SolveInputs {
  size: HostSize;
  unitPm: number;
  shape: Json | null;
  content: Json;
  view: Json | null;
}

export interface HostSize {
  w: number;
  h: number;
}

const LOG = typeof location !== "undefined" && /[?&]debug=layout\b/.test(location.search);

export function DockHost({ form, view, shape, radius = 12, border = 1, unitPm = 1000, islands, chrome, underlay, onLayout, drawerOpen = false, onDrawerHover, onTab, tabLabel, onBackgroundMenu, style }: {
  form: Json;
  view?: Json;
  /** the solver's shape (gap, margin; tab / handle / drawerW / drawerPad default to the schema's shapeDefaults) */
  shape?: Json;
  /** what the frames draw with (px): the corner radius (and so the content inset) and the frame's width — the theme's
   *  shape, or 0 / 0 in the Flat layout style */
  radius?: number;
  border?: number;
  unitPm?: number;
  islands: IslandDef[];
  /** the host's own chrome (the drawer's handle + panel frame), after the frames */
  chrome?: ReactNode;
  /** host layers drawn BEFORE the frames (an equal z-index then paints under the frame): an open island drawer's
   *  outside-press catcher at the drawer's own z (features/editmode/drawerRun.ts drawerCatchZ) */
  underlay?: ReactNode;
  /** every applied layout and the host size it was solved for (the shell reads collapse state and insets from it), and
   *  the whole solve input (edit mode) */
  onLayout?: (out: SolveOut, size: HostSize, inputs: SolveInputs) => void;
  /** 11.0: a stack's tab was picked (EDITMODE-UI §4.4) — the shell keeps view.active */
  onTab?: (stackId: string, ref: string) => void;
  /** a tab's label (the island's name) */
  tabLabel?: (ref: string) => string;
  /** 11.0: right-click / long-press on the host's own background — a gap, the margin (EDITMODE-UI §10) */
  onBackgroundMenu?: (x: number, y: number) => void;
  /** the drawer's panel is open: its islands fade + slide in with it */
  drawerOpen?: boolean;
  /** the pointer entered / left the drawer's islands (any of them) — keeps the drawer open */
  onDrawerHover?: (on: boolean) => void;
  style?: CSSProperties;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [out, setOut] = useState<SolveOut | null>(null);
  const size = useRef<HostSize>({ w: 0, h: 0 });
  const solvedFor = useRef<HostSize>({ w: 0, h: 0 });
  const inputs = useRef<SolveInputs | null>(null);
  const measured = useRef<Record<string, Measured>>({});
  const episode = useRef(new Episode());
  const reflowWindow = useRef(false);
  const pending = useRef(false);
  const defs = useRef(islands);
  defs.current = islands;
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;
  const onHoverRef = useRef(onDrawerHover);
  onHoverRef.current = onDrawerHover;
  // an island's `empty` / `present` from the shell is an input like the view state: a change starts a new episode
  const emptyKey = islands
    .filter((d) => d.empty || d.present)
    .map((d) => `${d.ref}${d.present ? "+" : ""}`)
    .join(",");

  const run = useCallback(
    (reflow: boolean) => {
      if (pending.current) return;
      pending.current = true;
      queueMicrotask(() => {
        pending.current = false;
        if (size.current.w <= 0 || size.current.h <= 0) return;
        const now: Content = {};
        for (const d of defs.current) {
          const m = measured.current[d.ref];
          const e: Record<string, number | boolean> = {};
          if (m && (d.measure ?? "dom") !== "none") {
            if (m.w !== undefined) e.w = q(m.w);
            if (m.h !== undefined) e.h = q(m.h);
            if (m.minH !== undefined) e.minH = q(m.minH);
          }
          if ((d.empty || m?.empty) && !d.present) e.empty = true;
          if (Object.keys(e).length) now[d.ref] = e;
        }
        const c = episode.current.next(now, reflow);
        if (!c) return;
        if (episode.current.frozen && c === episode.current.frozen && reflow) console.log(`[layout] unstable ${Object.keys(c).join(",")}`);
        const sz = { ...size.current };
        const o = solve(form as never, sz, unitPm, shape, c as never, view);
        solvedFor.current = sz;
        inputs.current = { size: sz, unitPm, shape: (shape as Json | undefined) ?? null, content: c as unknown as Json, view: (view as Json | undefined) ?? null };
        reflowWindow.current = true;
        if (LOG) {
          const ctx = { size: sz, unitPm, shape: shape ?? null, content: c, view: view ?? null };
          console.log(`[layout] solve ${JSON.stringify(ctx)}`);
          (window as unknown as { __twLayout?: unknown }).__twLayout = { ...ctx, out: o };
        }
        setOut(o);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, view, shape, unitPm, emptyKey],
  );

  // external triggers: the form / view / shape / unitPm / an island's emptiness (a new episode)
  useEffect(() => {
    episode.current.reset();
    run(false);
  }, [run]);

  // the host's own size
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      size.current = { w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) };
      episode.current.reset();
      run(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [run]);

  const onMeasure = useCallback(
    (ref: string, m: Measured) => {
      const was = measured.current[ref];
      if (was && was.w === m.w && was.h === m.h && was.minH === m.minH && !!was.empty === !!m.empty) return;
      measured.current[ref] = m;
      const reflow = reflowWindow.current;
      if (!reflow) episode.current.reset(); // `data`: a new episode
      run(reflow);
    },
    [run],
  );

  // the drawer's hover: any of its islands under the pointer
  const hovered = useRef(new Set<string>());
  const onFrameHover = useCallback((ref: string, on: boolean) => {
    const set = hovered.current;
    const before = set.size > 0;
    if (on) set.add(ref);
    else set.delete(ref);
    if (before !== set.size > 0) onHoverRef.current?.(set.size > 0);
  }, []);

  // after every applied layout: tell the shell, recover a stranded focus (§2.7), log (?debug=layout); size changes the
  // new rects cause arrive as `reflow` until the frame after it has been laid out
  useEffect(() => {
    if (!out) return;
    onLayoutRef.current?.(out, solvedFor.current, inputs.current as SolveInputs);
    const f = document.activeElement?.closest<HTMLElement>("[data-island]");
    const focusedRef = f?.dataset.island ?? null;
    const target = recoverTarget(focusedRef, out, REGION_ORDER);
    if (target) {
      // 10.8: a drawer that closed around the focus hands it back to its handle (the invoker), else the region order
      const handle = inClosedDrawer(focusedRef, out) ? hostRef.current?.querySelector<HTMLElement>("[data-drawer-handle]") : null;
      (handle ?? hostRef.current?.querySelector<HTMLElement>(`[data-island="${target}"]`))?.focus();
    }
    if (LOG)
      for (const [ref, r] of Object.entries(out.islands))
        console.log(`[layout] island:${ref} ${r.x},${r.y} ${r.w}x${r.h} z=${r.z ?? 0} vis=${r.vis !== false}${r.inset?.l ? ` inset.l=${r.inset.l}` : ""}`);
    const t = window.setTimeout(() => (reflowWindow.current = false), 50);
    return () => window.clearTimeout(t);
  }, [out]);

  const inset = contentInset(radius);
  const byRef = useMemo(() => new Map(islands.map((d) => [d.ref, d])), [islands]);
  const ordered = [...REGION_ORDER.filter((r) => byRef.has(r)), ...islands.map((d) => d.ref).filter((r) => !REGION_ORDER.includes(r))];
  const bgMenu = useRef(onBackgroundMenu);
  bgMenu.current = onBackgroundMenu;
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  return (
    <div
      ref={hostRef}
      className={s.host}
      data-dock-host=""
      style={{ ...style, ["--island-radius" as string]: `${radius}px`, ["--island-border" as string]: `${border}px` } as CSSProperties}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget || !bgMenu.current) return;
        e.preventDefault();
        bgMenu.current(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch" || e.target !== e.currentTarget || !bgMenu.current) return;
        const x = e.clientX;
        const y = e.clientY;
        press.current = { t: window.setTimeout(() => bgMenu.current?.(x, y), 500), x, y };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
          window.clearTimeout(p.t);
          press.current = null;
        }
      }}
      onPointerUp={() => {
        if (press.current) window.clearTimeout(press.current.t);
        press.current = null;
      }}
    >
      {underlay}
      {ordered.map((ref) => {
        const d = byRef.get(ref)!;
        return (
          <IslandFrame
            key={ref}
            islandRef={ref}
            rect={out?.islands[ref]}
            solved={out !== null}
            measure={d.measure ?? "dom"}
            onMeasure={onMeasure}
            inset={d.inset ?? inset}
            flush={!!d.flush}
            fill={d.fill}
            minIsNatural={!!d.minIsNatural}
            role={d.role}
            label={d.label}
            drawerOpen={drawerOpen}
            onDrawerHover={onFrameHover}
            placeholder={d.placeholder}
          >
            {d.node}
          </IslandFrame>
        );
      })}
      {out &&
        Object.entries(out.stacks).map(([id, st]) =>
          st.vis && st.tab > 0 ? <TabStrip key={id} id={id} stack={st} onTab={onTab} label={tabLabel} /> : null,
        )}
      {chrome}
    </div>
  );
}

/** A stack's tab strip (EDITMODE-UI §4.4): equal tabs ≤ 160 px at the stack's top edge; a pick sets view.active. */
function TabStrip({ id, stack, onTab, label }: { id: string; stack: SolveOut["stacks"][string]; onTab?: (id: string, ref: string) => void; label?: (ref: string) => string }) {
  const w = stack.tabs.length ? Math.min(160, Math.floor(stack.w / stack.tabs.length)) : 0;
  return (
    <div
      className={s.tabs}
      role="tablist"
      data-stack={id}
      style={{ left: stack.x, top: stack.y, width: stack.w, height: stack.tab, zIndex: stack.z }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const i = stack.tabs.indexOf(stack.active);
        const n = stack.tabs.length;
        const next = stack.tabs[(i + (e.key === "ArrowRight" ? 1 : n - 1)) % n];
        onTab?.(id, next);
        requestAnimationFrame(() => (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus());
      }}
    >
      {stack.tabs.map((ref) => (
        <button
          key={ref}
          type="button"
          role="tab"
          className={s.tab}
          data-tab={ref}
          aria-selected={ref === stack.active}
          tabIndex={ref === stack.active ? 0 : -1}
          style={{ width: w }}
          onClick={() => onTab?.(id, ref)}
        >
          {label ? label(ref) : ref}
        </button>
      ))}
    </div>
  );
}
