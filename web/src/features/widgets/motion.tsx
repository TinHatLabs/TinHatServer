// motion.tsx — the widgets' one-shot motions (contract WIDGETS-UI.md §10, GPU.md §1): every one is a CSS animation or
// transition that runs once when its data changes and only while the motion switch is on (<html data-animate>;
// without it tokens.css ends every animation at once). Nothing here loops or ticks.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAnimate } from "@/ui";
import s from "./motion.module.css";

/** The ids that appeared since the previous render (never on the first one): their rows play the enter motion. */
export function useFreshIds(ids: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef<Set<string>>(new Set());
  const key = ids.join("\u0000");
  const lastKey = useRef<string | null>(null);
  if (lastKey.current !== key) {
    lastKey.current = key;
    const next = new Set<string>();
    if (seen.current) for (const id of ids) if (!seen.current.has(id)) next.add(id);
    fresh.current = next;
    seen.current = new Set(ids);
  }
  return fresh.current;
}

/** A counter that goes up each time `on` turns true (the loss flash). */
export function useRisingEdge(on: boolean): number {
  const prev = useRef(on);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (on && !prev.current) setN((x) => x + 1);
    prev.current = on;
  }, [on]);
  return n;
}

/** countRoll: the value slides in from below when it changes (the old one is gone at once). */
export function Roll({ value, className }: { value: string | number; className?: string }) {
  const first = useRef(true);
  useEffect(() => {
    first.current = false;
  }, []);
  return (
    <span className={`${s.rollBox} ${className ?? ""}`}>
      <span key={String(value)} className={s.roll} data-enter={first.current ? undefined : ""}>
        {value}
      </span>
    </span>
  );
}

/** coverFade: a new image fades in over the old one (`verylong`); the old layer goes when the fade ends. */
export function CrossFade({ src, className, style, fallback }: { src: string; className?: string; style?: CSSProperties; fallback?: ReactNode }) {
  const animate = useAnimate();
  const [layers, setLayers] = useState<{ cur: string; prev: string | null }>({ cur: src, prev: null });
  const [failed, setFailed] = useState<Record<string, true>>({});
  useEffect(() => {
    setLayers((l) => (l.cur === src ? l : { cur: src, prev: animate ? l.cur : null }));
  }, [src, animate]);
  const show = (u: string) => !!u && !failed[u];
  return (
    <span className={`${s.fadeBox} ${className ?? ""}`} style={style}>
      {!show(layers.cur) && fallback}
      {layers.prev && show(layers.prev) && <img className={s.fadeImg} src={layers.prev} alt="" draggable={false} />}
      {show(layers.cur) && (
        <img
          key={layers.cur}
          className={s.fadeImg}
          data-enter={layers.prev ? "" : undefined}
          src={layers.cur}
          alt=""
          draggable={false}
          onAnimationEnd={() => setLayers((l) => ({ cur: l.cur, prev: null }))}
          onError={() => setFailed((f) => ({ ...f, [layers.cur]: true }))}
        />
      )}
    </span>
  );
}
