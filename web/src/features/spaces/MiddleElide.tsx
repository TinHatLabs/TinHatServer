// MiddleElide.tsx — Qt `elide: Text.ElideMiddle` for one line of text (CSS only elides at the end):
// "@tester3:exa…mple.com". Measures with a canvas in the element's own computed font and
// re-fits on resize. The full text stays in `title` and for screen readers.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

let canvas: HTMLCanvasElement | null = null;
function measure(font: string, text: string): number {
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Largest middle-elided form of `text` that fits `width` px. */
export function elideMiddle(text: string, width: number, font: string): string {
  if (width <= 0 || measure(font, text) <= width) return text;
  const chars = [...text];
  let lo = 0,
    hi = chars.length;
  let best = "…";
  while (lo <= hi) {
    const keep = (lo + hi) >> 1;
    const head = chars.slice(0, Math.ceil(keep / 2)).join("");
    const tail = chars.slice(chars.length - Math.floor(keep / 2)).join("");
    const cand = `${head}…${tail}`;
    if (measure(font, cand) <= width) {
      best = cand;
      lo = keep + 1;
    } else hi = keep - 1;
  }
  return best;
}

export function MiddleElide({ text, className, style }: { text: string; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      setShown(elideMiddle(text, el.clientWidth, font));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <span ref={ref} className={className} style={{ display: "block", whiteSpace: "pre", overflow: "hidden", ...style }} title={text} aria-label={text}>
      {shown}
    </span>
  );
}
