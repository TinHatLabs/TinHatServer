// ScrollArea.tsx — a scroller with FoxScrollBar.qml instead of the browser's bar.
//
// FoxScrollBar: policy AsNeeded, a floating thumb (no track unless `track`): 6 px wide (10 while
// hovered/pressed) inside a 2 px padding at the right edge; tokens scrollbar.thumb (accent 0.35, or the host's
// idleAlpha) → .thumb.hover (0.65) → .thumb.pressed (accentBright 0.85) while dragged; shown only while the list scrolls, the bar is hovered
// or pressed, or the host says the pointer is near its edge (`edgeHover`), fading over
// durSlow; minimumSize 0.08. `gutter` reserves room on the right so content never sits under it
// (the chat timeline keeps a 16 px gutter).
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cx, mergeRefs } from "./hooks";
import s from "./ScrollArea.module.css";

export interface ScrollAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children?: ReactNode;
  /** reserve this many px on the right for the bar */
  gutter?: number;
  /** show the bar while the pointer is within this many px of the right edge */
  edgeHover?: number;
  /** the thumb's alpha at rest; default = the `scrollbar.thumb` token as it is (0.35 in OLED/Goose) */
  idleAlpha?: number;
  /** faint full-length rail behind the thumb (9.3.2 timeline) */
  track?: boolean;
  alwaysOn?: boolean;
  /** class of the scrolling element (padding, layout) */
  contentClassName?: string;
  contentStyle?: CSSProperties;
  /** horizontal overflow handling of the scroller (default hidden) */
  overflowX?: "hidden" | "auto";
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { children, gutter = 0, edgeHover = 0, idleAlpha, track, alwaysOn, className, style, contentClassName, contentStyle, overflowX = "hidden", onScroll, ...rest },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ size: 1, pos: 0 });
  const [moving, setMoving] = useState(false);
  const [hover, setHover] = useState(false);
  const [edge, setEdge] = useState(false);
  const [drag, setDrag] = useState(false);
  const moveTimer = useRef(0);
  const dragRef = useRef<{ y0: number; top0: number } | null>(null);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const size = el.scrollHeight > 0 ? Math.min(1, el.clientHeight / el.scrollHeight) : 1;
    const pos = el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0;
    setGeo((g) => (g.size === size && g.pos === pos ? g : { size, pos }));
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);
  useEffect(() => () => window.clearTimeout(moveTimer.current), []);

  const shown = geo.size < 1 && (hover || drag || moving || edge || !!alwaysOn);
  const fat = hover || drag;
  const thumbH = Math.max(0.08, geo.size);
  // Qt: position is clamped so the (minimum-size) thumb stays inside the track
  const thumbTop = Math.min(geo.pos, 1 - thumbH) * 100;

  return (
    <div
      className={cx(s.area, className)}
      style={style}
      onPointerMove={
        edgeHover > 0
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const near = r.right - e.clientX <= edgeHover;
              if (near !== edge) setEdge(near);
            }
          : undefined
      }
      onPointerLeave={edgeHover > 0 ? () => setEdge(false) : undefined}
    >
      <div
        ref={mergeRefs(ref, scroller)}
        className={cx(s.scroller, contentClassName)}
        style={{ paddingRight: gutter || undefined, overflowX, ...contentStyle }}
        onScroll={(e) => {
          measure();
          setMoving(true);
          window.clearTimeout(moveTimer.current);
          moveTimer.current = window.setTimeout(() => setMoving(false), 350);
          onScroll?.(e);
        }}
        {...rest}
      >
        {children}
      </div>
      {geo.size < 1 && (
        <div
          className={cx(s.bar, fat && s.fat)}
          onPointerEnter={(e) => e.pointerType !== "touch" && setHover(true)}
          onPointerLeave={() => setHover(false)}
          onPointerDown={(e) => {
            const el = scroller.current;
            if (!el || e.button !== 0) return;
            const r = e.currentTarget.getBoundingClientRect();
            const avail = r.height - 4;
            const y = e.clientY - r.top - 2;
            const t0 = (thumbTop / 100) * avail, t1 = t0 + thumbH * avail;
            if (y < t0 || y > t1) {
              // Qt: a press on the track pages toward it
              el.scrollBy({ top: (y < t0 ? -1 : 1) * el.clientHeight * 0.9 });
              return;
            }
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { y0: e.clientY, top0: el.scrollTop };
            setDrag(true);
          }}
          onPointerMove={(e) => {
            const el = scroller.current, d = dragRef.current;
            if (!el || !d) return;
            const r = e.currentTarget.getBoundingClientRect();
            const avail = r.height - 4;
            el.scrollTop = d.top0 + ((e.clientY - d.y0) / avail) * el.scrollHeight;
          }}
          onPointerUp={() => {
            dragRef.current = null;
            setDrag(false);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setDrag(false);
          }}
        >
          {track && <div className={s.track} style={{ opacity: shown ? 1 : 0 }} />}
          <div
            className={cx(s.thumb, idleAlpha !== undefined && s.idle, drag ? s.pressed : hover ? s.hovered : undefined)}
            style={
              {
                top: `calc(2px + ${thumbTop} * (100% - 4px) / 100)`,
                height: `calc(${thumbH} * (100% - 4px))`,
                opacity: shown ? 1 : 0,
                ...(idleAlpha !== undefined ? { "--idle": idleAlpha } : {}),
              } as CSSProperties
            }
          />
        </div>
      )}
    </div>
  );
});
