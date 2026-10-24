// Icon.tsx — ThIcon.qml + the pack's motion/ThIcon.qml, for the browser.
//
// Static path: the pack's resting glyph (or its static theme / Breeze fallback) drawn as a CSS
// mask filled with `color` — the same "tint the ColorScheme-Text ink" the native does by string-
// replacing #eff0f1 before decode. Non-mask icons (Breeze emblems, colourful glyphs) load the SVG
// text and recolour the KDE colour-scheme classes like Kirigami.Icon.
//
// Motion path (names in the catalogue): `hovered` or `active`/`playing` (= the native `focused`)
// engage the story. Progress runs 0→1 linearly over the record's duration (easing is drawn into
// the frames), unwinds at 0.7× the duration when released, and jumps straight to the target with
// Reduce motion / when disabled. frame = round(progress × (frameCount − 1)) from a 7×7 atlas;
// the accent tone cross-fades from `color` to `accentColor` over progress accentAt … accentAt+0.22.
// The atlases are fetched on first engagement; until they are in, the resting glyph stays up.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fetchSvg, isPreloaded, preloadImage, recolorSvg, resolveIcon, useIconIndex } from "./iconpack";
import { useThemeColours } from "./themes";
import { DUR, useAnimate } from "./motion";
import s from "./Icon.module.css";

export interface IconProps {
  /** freedesktop icon name ("go-home-symbolic"), or an image URL */
  name: string;
  /** square side in px (Kirigami.Units.iconSizes.smallMedium = 22 by default, like ThIcon) */
  size?: number;
  width?: number;
  height?: number;
  /** ink colour (CSS; var(--th-…) ok). Default: the theme text colour. */
  color?: string;
  /** the story's lit tone. Default: accentBright. */
  accentColor?: string;
  /** true = tint the whole glyph with `color` (Kirigami isMask). false = the SVG's own colours. */
  isMask?: boolean;
  /** parent's hover — drives the motion story */
  hovered?: boolean;
  /** "on" state: holds the story's end pose (mic live, panel open, tab selected) */
  active?: boolean;
  /** busy: forces the held pose */
  playing?: boolean;
  /** disabled controls never animate (native `enabled`) */
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** CSS opacity of the glyph (the native passes colour alpha; this is the explicit form) */
  opacity?: number;
  /** draw the pack's STATIC theme glyph even for story names — what a stock Qt control shows
   *  (Controls.MenuItem / Button / ToolButton icon.name go through QIcon, not ThIcon) */
  staticOnly?: boolean;
}

export function Icon(p: IconProps) {
  const w = p.width ?? p.size ?? 22;
  const h = p.height ?? p.size ?? 22;
  const side = Math.min(w, h);
  const idx = useIconIndex();
  const res = useMemo(() => resolveIcon(idx, p.name, side, p.staticOnly), [idx, p.name, side, p.staticOnly]);
  const color = p.color ?? "var(--th-icon-fg)";
  const box: CSSProperties = { width: w, height: h, opacity: p.opacity, ...p.style };
  const cls = p.className ? `${s.icon} ${p.className}` : s.icon;
  if (!res) return <span className={cls} style={box} aria-hidden={!p.title} title={p.title} />;

  if (res.kind === "motion" && (p.isMask ?? true)) {
    return (
      <MotionIcon
        res={res}
        frameCount={idx?.frameCount ?? 49}
        columns={idx?.columns ?? 7}
        side={side}
        cls={cls}
        box={box}
        color={color}
        accentColor={p.accentColor ?? "var(--th-icon-highlight)"}
        engaged={!p.disabled && !!(p.hovered || p.active || p.playing)}
        title={p.title}
      />
    );
  }
  const url = res.kind === "motion" ? res.rest : res.url;
  if (res.kind === "url" && !/\.svg($|\?)|^data:image\/svg/i.test(url)) {
    return <img className={cls} style={{ ...box, objectFit: "contain" }} src={url} alt={p.title ?? ""} draggable={false} />;
  }
  if (p.isMask ?? true) {
    return <MaskGlyph cls={cls} box={box} url={url} color={color} side={side} title={p.title} />;
  }
  return <SchemeGlyph cls={cls} box={box} url={url} color={p.color} title={p.title} />;
}

function MaskGlyph(p: { cls: string; box: CSSProperties; url: string; color: string; side: number; title?: string }) {
  return (
    <span className={p.cls} style={p.box} role={p.title ? "img" : undefined} aria-label={p.title} aria-hidden={!p.title}>
      <span className={s.layer} style={{ ...maskStyle(p.url, p.side, 1, 0, 0), background: p.color, width: p.side, height: p.side }} />
    </span>
  );
}

function SchemeGlyph(p: { cls: string; box: CSSProperties; url: string; color?: string; title?: string }) {
  const theme = useThemeColours();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Kirigami.Icon's colour-scheme classes: the icon.scheme.* tokens (the desktop's Kirigami.Theme colours; a var()
    // colour can't be read here, so a caller's var() ink falls back to the text class). NeutralText = Kirigami's
    // neutralTextColor (#f67400 in OLED/Goose).
    const c = theme.colour;
    void fetchSvg(p.url).then((txt) => {
      if (!alive || !txt) return;
      setSrc(
        recolorSvg(txt, {
          text: p.color && !p.color.startsWith("var(") ? p.color : c["icon.scheme.text"],
          neutral: c["icon.scheme.neutral"],
          negative: c["icon.scheme.negative"],
          positive: c["icon.scheme.positive"],
          highlight: c["icon.scheme.highlight"],
          background: c["icon.scheme.background"],
        }),
      );
    });
    return () => {
      alive = false;
    };
  }, [p.url, p.color, theme]);
  return (
    <span className={p.cls} style={p.box} role={p.title ? "img" : undefined} aria-label={p.title} aria-hidden={!p.title}>
      {src && <img className={s.img} src={src} alt="" draggable={false} />}
    </span>
  );
}

function maskStyle(url: string, side: number, cols: number, col: number, row: number): CSSProperties {
  const size = `${side * cols}px ${side * cols}px`;
  const pos = `${-col * side}px ${-row * side}px`;
  return {
    WebkitMaskImage: `url("${url}")`,
    maskImage: `url("${url}")`,
    WebkitMaskSize: size,
    maskSize: size,
    WebkitMaskPosition: pos,
    maskPosition: pos,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  };
}

interface MotionProps {
  res: Extract<NonNullable<ReturnType<typeof resolveIcon>>, { kind: "motion" }>;
  frameCount: number;
  columns: number;
  side: number;
  cls: string;
  box: CSSProperties;
  color: string;
  accentColor: string;
  engaged: boolean;
  title?: string;
}

function MotionIcon(p: MotionProps) {
  // GPU.md §1: stories play only while the motion switch is on (focused, no Reduce motion); otherwise they jump to
  // their end pose (the native `reduced` branch)
  const reduced = !useAnimate();
  const { rec } = p.res;
  const [progress, setProgress] = useState(p.engaged ? 1 : 0);
  const progRef = useRef(progress);
  progRef.current = progress;
  const [ready, setReady] = useState(() => atlasReady(p.res));

  // Fetch the atlases on first engagement (the native loads them when _useAtlas turns on).
  useEffect(() => {
    if (!p.engaged && progRef.current === 0) return;
    if (ready) return;
    let alive = true;
    const urls = [p.res.base, p.res.accent].filter((u): u is string => !!u);
    void Promise.all(urls.map(preloadImage)).then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [p.engaged, p.res.base, p.res.accent, ready]);

  // The story: linear progress toward the target, 0.7× on the way back. GPU.md §1: one duration token for icon motion
  // too — every story takes the 400 ms step (`verylong`, the cap) instead of its own 600–1100 ms `d`.
  useEffect(() => {
    const target = p.engaged ? 1 : 0;
    const from = progRef.current;
    if (from === target) return;
    if (reduced) {
      setProgress(target);
      return;
    }
    const dur = Math.max(1, DUR.verylong * (target ? 1 : 0.7) * Math.abs(target - from));
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      setProgress(from + (target - from) * k);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [p.engaged, reduced]);

  // Name change: the native resets progress to 0 and re-evaluates.
  const nameRef = useRef(p.res.name);
  useEffect(() => {
    if (nameRef.current !== p.res.name) {
      nameRef.current = p.res.name;
      setProgress(p.engaged && reduced ? 1 : 0);
      setReady(atlasReady(p.res));
    }
  }, [p.res, p.engaged, reduced]);

  const useAtlas = p.engaged || progress > 0;
  const frame = Math.round(progress * (p.frameCount - 1));
  const col = frame % p.columns;
  const row = Math.floor(frame / p.columns);
  const mixA = Math.max(0, Math.min(1, (progress - rec.a) / 0.22));
  const showAtlas = useAtlas && ready;
  // the lit accent tone carries the ink as --icon-ink: the icon style "One colour" (<html data-icons="mono">, THEMES-UI
  // §10.3) paints it with the ink instead of the accent, without re-rendering a single icon
  const layer = (url: string, bg: string, opacity: number, key: string, lit = false) => (
    <span
      key={key}
      className={lit ? `${s.layer} ${s.lit}` : s.layer}
      style={{ ...maskStyle(url, p.side, p.columns, col, row), background: bg, opacity, width: p.side, height: p.side, ...(lit ? { ["--icon-ink" as string]: p.color } : null) }}
    />
  );
  return (
    <span className={p.cls} style={p.box} role={p.title ? "img" : undefined} aria-label={p.title} aria-hidden={!p.title}>
      {!showAtlas && (
        <span className={s.layer} style={{ ...maskStyle(p.res.rest, p.side, 1, 0, 0), background: p.color, width: p.side, height: p.side }} />
      )}
      {showAtlas && p.res.base && layer(p.res.base, p.color, 1, "base")}
      {showAtlas && p.res.accent && layer(p.res.accent, p.color, 1 - mixA, "accent-n")}
      {showAtlas && p.res.accent && layer(p.res.accent, p.accentColor, mixA, "accent-l", true)}
    </span>
  );
}

function atlasReady(res: MotionProps["res"]): boolean {
  return [res.base, res.accent].every((u) => !u || isPreloaded(u));
}
