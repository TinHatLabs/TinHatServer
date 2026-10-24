// ThemeGrid.tsx — THEMES-UI.md §5.5: the card grids. `ThemeGrid` = a plain wrapping grid (favourites, My themes) or a
// phone strip; `VirtualThemeGrid` = the 1,190-theme grid: only the rows in view ± 2 exist, laid out with the same cell
// maths (n = max(1, ⌊(W + 8) / (min + 8)⌋), gap 8, pitch = card height + 8). Arrow keys move the focus between cards
// (a virtual grid scrolls the target row in first); Tab enters/leaves a grid at its first card.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useIsMobile } from "@/ui";
import { cardStyles as s } from "./ThemeCard";

export interface CellRender {
  (p: { tabIndex: number; onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void }): ReactNode;
}

const GAP = 8;

/** Arrow keys among the grid's buttons (cells in DOM order; up/down = the same column one row away). */
function moveFocus(container: HTMLElement | null, e: KeyboardEvent<HTMLButtonElement>): void {
  if (!container || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(":scope > div > button, :scope > div > div > button")].filter((b) => !b.getAttribute("aria-haspopup"));
  const i = buttons.indexOf(e.currentTarget);
  if (i < 0) return;
  let j = i;
  if (e.key === "ArrowLeft") j = i - 1;
  else if (e.key === "ArrowRight") j = i + 1;
  else if (e.key === "Home") j = 0;
  else if (e.key === "End") j = buttons.length - 1;
  else {
    const r = e.currentTarget.getBoundingClientRect();
    const down = e.key === "ArrowDown";
    let best = -1;
    let bestD = Infinity;
    buttons.forEach((b, k) => {
      const q = b.getBoundingClientRect();
      if (down ? q.top <= r.top + 1 : q.top >= r.top - 1) return;
      const dy = Math.abs(q.top - r.top);
      const dx = Math.abs(q.left - r.left);
      const d = dy * 10000 + dx;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best < 0) return;
    j = best;
  }
  if (j < 0 || j >= buttons.length) return;
  e.preventDefault();
  buttons[j].focus();
}

export function ThemeGrid({ cells, label, strip }: { cells: CellRender[]; label: string; strip?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => moveFocus(ref.current, e), []);
  return (
    <div ref={ref} className={strip ? s.strip : s.grid} role="radiogroup" aria-label={label}>
      {cells.map((c, i) => (
        <GridSlot key={i} render={c} tabIndex={i === 0 ? 0 : -1} onKeyDown={onKeyDown} />
      ))}
    </div>
  );
}

function GridSlot({ render, tabIndex, onKeyDown }: { render: CellRender; tabIndex: number; onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void }) {
  return <>{render({ tabIndex, onKeyDown })}</>;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

export interface VirtualGridProps<T> {
  items: T[];
  keyOf: (item: T) => string;
  render: (item: T, p: { tabIndex: number; onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void }) => ReactNode;
  /** the scrolling element the grid sits in (optional: the nearest scrolling ancestor is found anyway) */
  scroller?: RefObject<HTMLElement | null>;
  label: string;
}

export function VirtualThemeGrid<T>({ items, keyOf, render, scroller, label }: VirtualGridProps<T>) {
  const mobile = useIsMobile();
  const minCell = mobile ? 150 : 148;
  const cardH = mobile ? 96 : 108;
  const pitch = cardH + GAP;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 8]);
  const pendingFocus = useRef<number | null>(null);

  const cols = Math.max(1, Math.floor((width + GAP) / (minCell + GAP)));
  const rows = Math.ceil(items.length / cols);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The rows that intersect the window (whichever element scrolls — the page's own scroller on desktops, the sheet on
  // phones): read from the grid's own rectangle, so any scrolling ancestor works.
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const first = Math.max(0, Math.floor(-top / pitch) - 2);
    const last = Math.min(rows, Math.ceil((window.innerHeight - top) / pitch) + 2);
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, Math.max(first, last)]));
  }, [pitch, rows]);

  useEffect(() => {
    measure();
    // scroll events don't bubble: one capture-phase listener sees every scroller (read-only work, no paint)
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [measure]);
  useLayoutEffect(measure, [measure, items.length, cols]);

  // a focus request for an index whose row was not rendered yet: done once it is
  useEffect(() => {
    const k = pendingFocus.current;
    if (k === null) return;
    const b = ref.current?.querySelector<HTMLButtonElement>(`[data-vi="${k}"] > button`);
    if (b) {
      pendingFocus.current = null;
      b.focus();
    }
  });

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      const cell = (e.currentTarget.parentElement?.closest("[data-vi]") ?? e.currentTarget.parentElement) as HTMLElement | null;
      const i = Number(cell?.dataset.vi ?? -1);
      if (i < 0) return;
      let j = i;
      if (e.key === "ArrowLeft") j = i - 1;
      else if (e.key === "ArrowRight") j = i + 1;
      else if (e.key === "ArrowUp") j = i - cols;
      else if (e.key === "ArrowDown") j = i + cols;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = items.length - 1;
      else return;
      if (j < 0 || j >= items.length) return;
      e.preventDefault();
      const b = ref.current?.querySelector<HTMLButtonElement>(`[data-vi="${j}"] > div > button, [data-vi="${j}"] > button`);
      if (b) {
        b.focus();
        return;
      }
      // scroll its row into view (the nearest ancestor that scrolls); the effect above focuses it once rendered
      const el = ref.current;
      const sc = scrollParent(el) ?? scroller?.current ?? null;
      if (el && sc) {
        const rowTop = Math.floor(j / cols) * pitch;
        const gridTop = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        sc.scrollTop = Math.max(0, gridTop + rowTop - sc.clientHeight / 2 + pitch / 2);
        pendingFocus.current = j;
        measure();
      }
    },
    [cols, items.length, pitch, scroller, measure],
  );

  const out: ReactNode[] = [];
  for (let r = range[0]; r < Math.min(range[1], rows); r++) {
    const rowItems = items.slice(r * cols, r * cols + cols);
    out.push(
      <div
        key={r}
        className={s.grid}
        style={{ position: "absolute", left: 0, right: 0, top: r * pitch, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {rowItems.map((it, k) => {
          const idx = r * cols + k;
          return (
            <div key={keyOf(it)} data-vi={idx} style={{ display: "contents" }}>
              {render(it, { tabIndex: idx === 0 ? 0 : -1, onKeyDown })}
            </div>
          );
        })}
      </div>,
    );
  }
  return (
    <div ref={ref} role="radiogroup" aria-label={label} style={{ position: "relative", height: Math.max(0, rows * pitch - GAP) }}>
      {out}
    </div>
  );
}
