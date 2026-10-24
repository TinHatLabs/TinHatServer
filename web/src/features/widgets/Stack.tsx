// Stack.tsx — the widget stack in the room column (contract WIDGETS-UI.md §1): under the room list, above the account
// card, anchored to the bottom; widgets fold to their headers bottom-up when the list would drop under its 160 px
// minimum (auto-fold, not saved), then the stack scrolls. Drag a header to reorder (desktop). Phones: the stack is part
// of the list's scroll content (§8). Nothing renders for an empty list, so the column is exactly the pre-widget one.
// 11.0 (islands C6/C7, `island`): the stack is the dock host's frameless `widgets` island — it reports its natural height
// (every widget open) and its least (every widget folded); the island's height comes back as its max height and the
// fold rule (fold.ts, the desktop's WidgetHost) folds bottom-up to fit, from the heights the widgets last had OPEN.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Icon, useIsland, useIsMobile } from "@/ui";
import { gateOfWidget, useOffered } from "@/core/server";
import { sizeOf } from "@/widgets/registry";
import { WidgetFrame } from "./Frame";
import { Gallery } from "./Gallery";
import { useFreshIds } from "./motion";
import { moveWidget, useWidgetItems } from "./store";
import { FOLDED_H, foldToFit, stackTotal, type FoldItem } from "./fold";
import s from "./Stack.module.css";

/** The room list keeps at least this much (the layout registry's rooms.min.h). */
const LIST_MIN = 160;
const GAP = 6;

const NO_FOLDS: ReadonlySet<string> = new Set();

export function WidgetStack({ mobile: mobileProp, island: islandProp }: { mobile?: boolean; island?: boolean }) {
  const isMobile = useIsMobile();
  const mobile = mobileProp ?? isMobile;
  const isl = useIsland();
  const island = !!islandProp && !mobile && isl !== null;
  const items = useWidgetItems();
  const widgetOn = useOffered(gateOfWidget);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const openGallery = useCallback(() => setGalleryOpen(true), []);
  const ids = items.map((i) => i.w);
  const fresh = useFreshIds(ids);

  // ---- auto-fold (desktop) ----
  const stackRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const frames = useRef(new Map<string, HTMLElement>());
  const [autoFolded, setAutoFolded] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  const refFor = useCallback((w: string) => (el: HTMLElement | null) => {
    if (el) frames.current.set(w, el);
    else frames.current.delete(w);
  }, []);
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const frameRef = (w: string) => {
    let f = refs.current.get(w);
    if (!f) refs.current.set(w, (f = refFor(w)));
    return f;
  };

  // The stack never shrinks the list below LIST_MIN: its max height is what the panel leaves above the account card once
  // the list has its minimum; over that, widgets fold bottom-up (auto-fold, not saved), then the stack scrolls.
  const [avail, setAvail] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (mobile || island) return;
    const stack = stackRef.current;
    const panel = stack?.parentElement;
    if (!stack || !panel) return;
    // remember each open widget's height (folded ones keep their last open height)
    for (const [w, el] of frames.current) if (!el.hasAttribute("data-folded")) heights.current.set(w, el.offsetHeight);
    const list = panel.querySelector<HTMLElement>(':scope > [role="list"]');
    const top = list ? list.offsetTop : stack.offsetTop;
    const mb = parseFloat(getComputedStyle(stack).marginBottom) || 0;
    const room = Math.max(FOLDED_H, Math.floor(panel.clientHeight - top - LIST_MIN - mb - 2));
    if (room !== avail) {
      setAvail(room);
      return;
    }
    const natural = stack.scrollHeight;
    const folded = new Set(autoFolded);
    const foldable = items.filter((i) => !i.collapsed && i.size !== "S" && !folded.has(i.w) && i.w !== pinned).map((i) => i.w);
    if (natural > room + 1 && foldable.length) {
      setAutoFolded([...autoFolded, foldable[foldable.length - 1]!]); // bottom-up
      return;
    }
    if (autoFolded.length) {
      // unfold the one folded last (top-most) when its open height fits again
      const w = autoFolded[autoFolded.length - 1]!;
      const h = heights.current.get(w) ?? 220;
      if (natural + (h - FOLDED_H) <= room) setAutoFolded(autoFolded.slice(0, -1));
    }
  });
  // re-run the fold pass when the column or a widget changes size
  useEffect(() => {
    if (mobile) return;
    const stack = stackRef.current;
    const panel = stack?.parentElement;
    if (!stack || !panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setLayoutTick((n) => n + 1));
    if (!island) ro.observe(panel);
    for (const el of stack.children) ro.observe(el);
    return () => ro.disconnect();
  }, [mobile, island, items.length, autoFolded.length]);
  void layoutTick;

  // ---- the widgets island: remember each widget's height while it is OPEN (a folded one keeps its last open height —
  // never the header-only height it shows folded, or a stack at its limit would fold / unfold forever) ----
  const [openTick, setOpenTick] = useState(0);
  useLayoutEffect(() => {
    if (!island) return;
    let changed = false;
    for (const [w, el] of frames.current) {
      if (el.hasAttribute("data-folded")) continue;
      const h = el.getBoundingClientRect().height;
      if (Math.abs((heights.current.get(w) ?? -1) - h) > 0.01) {
        heights.current.set(w, h);
        changed = true;
      }
    }
    if (changed) setOpenTick((n) => n + 1);
  });
  const foldItems = useMemo<FoldItem[]>(() => {
    void openTick;
    return items.map((it) => {
      const userFolded = !!it.collapsed || sizeOf(it) === "S";
      return { w: it.w, openH: userFolded ? FOLDED_H : (heights.current.get(it.w) ?? FOLDED_H), foldable: !userFolded && it.w !== pinned };
    });
  }, [items, pinned, openTick]);
  const openTotal = stackTotal(foldItems, false);
  const foldedTotal = stackTotal(foldItems, true);
  const report = isl?.report;
  useEffect(() => {
    if (!island || !report) return;
    report(items.length ? { h: openTotal, minH: foldedTotal } : { empty: true });
  }, [island, report, items.length, openTotal, foldedTotal]);
  const islandH = island && isl!.visible ? isl!.h : 0;
  const islandFolds = useMemo(() => (island && islandH > 0 ? foldToFit(foldItems, islandH) : NO_FOLDS), [island, islandH, foldItems]);
  // forget folds of widgets that left the list / that the user collapsed themselves
  useEffect(() => {
    setAutoFolded((f) => f.filter((w) => items.some((i) => i.w === w && !i.collapsed && i.size !== "S")));
    if (pinned && !items.some((i) => i.w === pinned && !i.collapsed)) setPinned(null);
  }, [items, pinned]);
  const onPin = useCallback((w: string) => {
    setPinned(w);
    setAutoFolded((f) => f.filter((x) => x !== w));
  }, []);

  // ---- drag to reorder (desktop) ----
  const [drag, setDragState] = useState<{ w: string; dy: number; target: number; line: number } | null>(null);
  const dragNow = useRef<{ w: string; dy: number; target: number; line: number } | null>(null);
  const setDrag = (v: typeof dragNow.current) => {
    dragNow.current = v;
    setDragState(v);
  };
  const dragRef = useRef<{ w: string; startY: number; id: number; started: boolean; tops: { w: string; top: number; h: number }[] } | null>(null);
  const clickSwallow = useRef<string | null>(null);
  const onDragStart = useCallback(
    (w: string, e: RPointerEvent<HTMLElement>) => {
      const stack = stackRef.current;
      if (!stack) return;
      const base = stack.getBoundingClientRect().top - stack.scrollTop;
      const tops = items.map((i) => {
        const el = frames.current.get(i.w);
        const r = el?.getBoundingClientRect();
        return { w: i.w, top: r ? r.top - base : 0, h: r ? r.height : 0 };
      });
      dragRef.current = { w, startY: e.clientY, id: e.pointerId, started: false, tops };
      const target = e.currentTarget;
      const move = (ev: PointerEvent) => {
        const d = dragRef.current;
        if (!d || ev.pointerId !== d.id) return;
        const dy = ev.clientY - d.startY;
        if (!d.started) {
          if (Math.abs(dy) < 4) return;
          d.started = true;
          try {
            target.setPointerCapture(d.id);
          } catch {
            /* gone */
          }
        }
        const me = d.tops.find((t) => t.w === d.w)!;
        const center = me.top + me.h / 2 + dy;
        const others = d.tops.filter((t) => t.w !== d.w);
        let idx = others.findIndex((t) => center < t.top + t.h / 2);
        if (idx < 0) idx = others.length;
        const line = idx < others.length ? others[idx]!.top - GAP / 2 - 1 : (others.length ? others[others.length - 1]!.top + others[others.length - 1]!.h : 0) + GAP / 2 - 1;
        setDrag({ w: d.w, dy, target: idx, line });
      };
      const end = (ev: PointerEvent | KeyboardEvent) => {
        const d = dragRef.current;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("keydown", esc, true);
        dragRef.current = null;
        const cur = dragNow.current;
        setDrag(null);
        if (d?.started && cur && ev.type === "pointerup") moveWidget(cur.w, cur.target);
        if (d?.started) clickSwallow.current = d.w;
      };
      const esc = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !dragRef.current?.started) return;
        ev.preventDefault();
        ev.stopPropagation();
        end(ev);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      window.addEventListener("keydown", esc, true);
    },
    [items],
  );
  const consumeClick = useCallback((w: string) => {
    if (clickSwallow.current !== w) return false;
    clickSwallow.current = null;
    return true;
  }, []);
  useEffect(() => {
    // a click never follows a drag that ended outside the header: clear the swallow flag on the next frame
    if (!clickSwallow.current) return;
    const t = window.setTimeout(() => (clickSwallow.current = null), 0);
    return () => window.clearTimeout(t);
  });

  if (!items.length) return galleryOpen ? <Gallery onClose={() => setGalleryOpen(false)} /> : null;
  const folded = island ? islandFolds : new Set(autoFolded);
  return (
    <div
      ref={stackRef}
      className={s.stack}
      data-widget-stack=""
      data-mobile={mobile ? "" : undefined}
      data-in-island={island ? "" : undefined}
      data-dragging={drag ? "" : undefined}
      style={!mobile && !island && avail !== null ? { maxHeight: avail } : undefined}
    >
      {items.map((it, i) => (
        // selfhost/firstrun item 1: a widget whose feature the server doesn't offer is not drawn (it stays in the list)
        !widgetOn(it.w) ? null : <WidgetFrame
          key={it.w}
          item={it}
          index={i}
          count={items.length}
          mobile={mobile}
          autoFolded={folded.has(it.w)}
          onPin={onPin}
          onOpenGallery={openGallery}
          onDragStart={mobile ? undefined : onDragStart}
          dragOffset={drag?.w === it.w ? drag.dy : 0}
          dragging={drag?.w === it.w}
          frameRef={frameRef(it.w)}
          consumeClick={() => consumeClick(it.w)}
          enter={fresh.has(it.w)}
        />
      ))}
      {drag && <div className={s.dropLine} style={{ top: drag.line }} />}
      <button type="button" className={s.add} onClick={openGallery} data-widget-add="">
        <Icon name="list-add-symbolic" size={mobile ? 16 : 12} color="currentColor" staticOnly />
        <span>Add widget</span>
      </button>
      {galleryOpen && <Gallery onClose={() => setGalleryOpen(false)} />}
    </div>
  );
}
