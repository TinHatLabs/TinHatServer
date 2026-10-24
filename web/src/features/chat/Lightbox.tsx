// Lightbox.tsx — Lightbox.qml: full-window 88 % black backdrop, the image at natural size capped to 92 %
// of the window (GIFs keep playing), caption at the bottom, ✕ "Close (Esc)"; Esc / ✕ / backdrop close;
// 180 ms fade. Wheel over the image zooms ×1.12 per notch (1×–8×), drag pans when zoomed, back to 1×
// re-centres; the wheel over the backdrop is swallowed (D6). Phones: tap backdrop closes, double-tap
// toggles 2×, one-finger drag pans, two-finger pinch zooms.
import { useEffect, useRef, useState } from "react";
import { useBus } from "@/core/bus";
import { AnimatedImage, OverlayPortal, Icon, cx, durMs, useTip } from "@/ui";
import s from "./Lightbox.module.css";

interface Item {
  src: string;
  name?: string;
}

/** The global lightbox (bus openLightbox) — main window. */
export function Lightbox() {
  const [item, setItem] = useState<Item | null>(null);
  useBus("openLightbox", (p) => {
    const it = p.items?.[p.index ?? 0];
    if (!it) return;
    setItem({ src: it.src, name: it.name });
  });
  return item ? <LightboxView key={item.src} item={item} onClose={() => setItem((cur) => (cur === item ? null : cur))} /> : null;
}

/** One lightbox; `contained` = inside its positioned parent (a floating chat keeps its own, CHAT-120). */
export function LightboxView({ item, onClose, contained = false }: { item: Item; onClose: () => void; contained?: boolean }) {
  const [shown, setShown] = useState(false);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useTip(closeRef, "Close (Esc)", { delay: 400 });
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const closeT = useRef(0);
  useEffect(() => () => window.clearTimeout(closeT.current), []);
  const close = () => {
    if (closeT.current) return;
    setShown(false);
    closeT.current = window.setTimeout(onClose, durMs("slow")); // the fade's length (0 = at once while nothing moves)
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Main.qml parents the Lightbox to the window's contentItem, so the header banners (verify / offline /
  // update, ApplicationWindow.header) stay above it undimmed — chat-lightbox: backdrop from y = 58.
  // the header strip's bottom = the top of the dock host (11.0; the room page's before islands — the strip renders
  // nothing without banners)
  const pageEl = () => document.querySelector("[data-dock-host]") ?? document.querySelector("[data-room-page]");
  const measureTop = () => {
    if (contained || document.documentElement.dataset.ff === "mobile") return 0;
    const pg = pageEl();
    return pg ? Math.max(0, Math.round(pg.getBoundingClientRect().top)) : 0;
  };
  const [top, setTop] = useState(measureTop);
  // a banner may appear / go away while the lightbox is open (offline, verified …): the page resizes → follow it
  useEffect(() => {
    if (contained) return;
    const upd = () => setTop(measureTop());
    const pg = pageEl();
    const ro = pg ? new ResizeObserver(upd) : null;
    if (pg) ro!.observe(pg);
    window.addEventListener("resize", upd);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", upd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contained]);
  const box = contained ? rootRef.current?.parentElement?.getBoundingClientRect() : null;
  const W = box?.width || window.innerWidth;
  const H = box?.height || window.innerHeight - top;
  const fit = nat ? Math.min(1, (0.92 * W) / nat.w, (0.92 * H) / nat.h) : 1;
  const w = nat ? nat.w * fit : undefined;
  const h = nat ? nat.h * fit : undefined;
  const setZ = (z: number) => {
    const nz = Math.max(1, Math.min(8, z));
    setZoom(nz);
    if (nz === 1) setPan({ x: 0, y: 0 });
  };
  const body = (
      <div
        ref={rootRef}
        className={cx(s.root, contained && s.contained)}
        style={{ opacity: shown ? 1 : 0, top: top || undefined }}
        onClick={close}
        onWheel={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* GPU.md §2.6: a GIF / WebP plays by the low-GPU rule; opening it was a click, so under reduce motion it
            plays one loop, and every click on it plays one more */}
        <AnimatedImage
          className={s.img}
          src={item.src}
          playOnMount="one"
          alt={item.name ?? ""}
          draggable={false}
          style={{
            width: w,
            height: h,
            maxWidth: nat ? undefined : "92%",
            maxHeight: nat ? undefined : "92%",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            cursor: zoom > 1 ? "grab" : "default",
          }}
          onReady={(w, h) => setNat({ w, h })}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setZ(zoom > 1 ? 1 : 2);
          }}
          onWheel={(e) => {
            e.stopPropagation();
            const notches = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
            setZ(zoom * Math.pow(1.12, -notches));
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            e.currentTarget.setPointerCapture(e.pointerId);
            if (pointers.current.size === 2) {
              const [a, b] = [...pointers.current.values()];
              pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom };
              drag.current = null;
            } else if (zoom > 1) drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          }}
          onPointerMove={(e) => {
            if (!pointers.current.has(e.pointerId)) return;
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch.current && pointers.current.size === 2) {
              const [a, b] = [...pointers.current.values()];
              setZ((pinch.current.z * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, pinch.current.d));
              return;
            }
            const d = drag.current;
            if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
          }}
          onPointerUp={(e) => {
            pointers.current.delete(e.pointerId);
            if (pointers.current.size < 2) pinch.current = null;
            drag.current = null;
          }}
          onPointerCancel={(e) => {
            pointers.current.delete(e.pointerId);
            pinch.current = null;
            drag.current = null;
          }}
          onLostPointerCapture={(e) => {
            pointers.current.delete(e.pointerId);
            if (pointers.current.size < 2) pinch.current = null;
          }}
        />
        {item.name && <div className={s.caption}>{item.name}</div>}
        <button
          ref={closeRef}
          type="button"
          className={s.close}
          aria-label="Close (Esc)"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          <Icon name="window-close-symbolic" size={16} color="var(--th-lightbox-close-fg)" />
        </button>
      </div>
  );
  return contained ? body : <OverlayPortal>{body}</OverlayPortal>;
}
