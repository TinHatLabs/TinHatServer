// iconpack.ts — name → file resolution for the Tin Hat icon pack (native iconpack.rs + ThIcon.qml +
// the pack's motion/ThIcon.qml). Nothing is imported eagerly: the 20 KB catalogue is fetched
// once, and each icon's SVG only when it is drawn (rest glyph) or hovered (frame atlases).
//
// Layout (tools/iconpack-web.mjs builds public/iconpack/web from the native pack):
//   web/index.json                      { frameCount, columns, motion: {name: {c,d,a,t}},
//                                         small: {canonical: [parts that differ at ≤18 px]},
//                                         static: {name: [sizes]}, breeze: {name: [sizes]} }
//   web/motion/<canonical>/<part>.svg   rest | rest16 | base | base16 | accent | accent16
//   theme/tinhat/<size>/actions/<n>.svg the pack's static theme (names without a story)
//   web/breeze/<size>/<n>.svg           Breeze-dark fallbacks (the native theme inherits Breeze)
import { useSyncExternalStore } from "react";

export interface MotionRecord {
  /** canonical drawing */
  c: string;
  /** story duration (ms) */
  d: number;
  /** progress at which the accent tone starts lighting (crossfade over 0.22) */
  a: number;
  /** tones present: "accent" and/or "base" */
  t: string[];
}

export interface IconIndex {
  frameCount: number;
  columns: number;
  motion: Record<string, MotionRecord>;
  small: Record<string, string[]>;
  static: Record<string, number[]>;
  breeze: Record<string, number[]>;
}

const BASE = `${import.meta.env.BASE_URL}iconpack/`;

let index: IconIndex | null = null;
let loading: Promise<IconIndex> | null = null;
const listeners = new Set<() => void>();

export function loadIconIndex(): Promise<IconIndex> {
  if (index) return Promise.resolve(index);
  if (!loading) {
    loading = fetch(`${BASE}web/index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`iconpack index: HTTP ${r.status}`);
        return r.json() as Promise<IconIndex>;
      })
      .then((j) => {
        index = j;
        for (const l of listeners) l();
        return j;
      })
      .catch((e) => {
        console.warn("[iconpack] index failed — icons fall back to nothing", e);
        loading = null;
        throw e;
      });
  }
  return loading;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!index) void loadIconIndex().catch(() => {});
  return () => listeners.delete(cb);
}
const snapshot = () => index;

/** React: the catalogue (null until loaded — the first icons paint a frame later). */
export function useIconIndex(): IconIndex | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Native size buckets (motion `_size`, and the theme dirs Kirigami.Icon picks from). */
export function sizeBucket(side: number): 16 | 22 | 24 | 32 {
  return side <= 18 ? 16 : side <= 22 ? 22 : side <= 24 ? 24 : 32;
}

function pickSize(avail: number[], side: number): number {
  const want = sizeBucket(side);
  if (avail.includes(want)) return want;
  const bigger = avail.filter((s) => s >= want).sort((a, b) => a - b);
  if (bigger.length) return bigger[0];
  return [...avail].sort((a, b) => b - a)[0];
}

export type ResolvedIcon =
  | { kind: "motion"; name: string; rec: MotionRecord; rest: string; base: string | null; accent: string | null }
  | { kind: "static"; name: string; url: string }
  | { kind: "breeze"; name: string; url: string }
  | { kind: "url"; name: string; url: string };

/** Is `name` a URL/path rather than an icon-theme name? */
export function isIconUrl(name: string): boolean {
  return /^(https?:|data:|blob:|\.{0,2}\/)/.test(name) || /\.(svg|png|webp|gif|jpe?g)$/i.test(name);
}

/**
 * Resolve `name` at a pixel side. Motion names get their story files (the ≤18 px drawings when
 * they differ); other names the static theme, then Breeze — the native lookup order.
 */
export function resolveIcon(idx: IconIndex | null, name: string, side: number, staticOnly = false): ResolvedIcon | null {
  if (!name) return null;
  if (isIconUrl(name)) return { kind: "url", name, url: name };
  if (!idx) return null;
  const rec = idx.motion[name];
  if (rec && !(staticOnly && idx.static[name])) {
    const small = side <= 18;
    const diff = idx.small[rec.c] ?? [];
    const part = (p: "rest" | "base" | "accent") => {
      const s = `${p}16`;
      return `${BASE}web/motion/${rec.c}/${small && diff.includes(s) ? s : p}.svg`;
    };
    return {
      kind: "motion",
      name,
      rec,
      rest: part("rest"),
      base: rec.t.includes("base") ? part("base") : null,
      accent: rec.t.includes("accent") ? part("accent") : null,
    };
  }
  const st = idx.static[name];
  if (st) return { kind: "static", name, url: `${BASE}theme/tinhat/${pickSize(st, side)}/actions/${name}.svg` };
  const bz = idx.breeze[name];
  if (bz) return { kind: "breeze", name, url: `${BASE}web/breeze/${pickSize(bz, side)}/${name}.svg` };
  return null;
}

// ---- non-mask rendering: recolour the KDE colour-scheme classes like Kirigami.Icon does ------

const svgText = new Map<string, Promise<string>>();

export function fetchSvg(url: string): Promise<string> {
  let p = svgText.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.text() : ""));
    svgText.set(url, p);
  }
  return p;
}

export interface SchemeColors {
  text: string;
  neutral: string;
  negative: string;
  positive: string;
  highlight: string;
  background: string;
}

/** Replace the `.ColorScheme-*` stylesheet colours (Breeze / pack SVGs) → data: URL. */
export function recolorSvg(svg: string, c: SchemeColors): string {
  const map: Record<string, string> = {
    Text: c.text,
    ButtonText: c.text,
    ViewText: c.text,
    NeutralText: c.neutral,
    NegativeText: c.negative,
    PositiveText: c.positive,
    Highlight: c.highlight,
    Background: c.background,
    ViewBackground: c.background,
  };
  const out = svg.replace(/\.ColorScheme-([A-Za-z]+)\s*\{\s*color\s*:\s*[^;}]+;?\s*\}/g, (m, cls: string) =>
    map[cls] ? `.ColorScheme-${cls} { color:${map[cls]}; }` : m,
  );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out)}`;
}

/** Warm the browser cache for a motion story before it is needed (e.g. on pointer-enter). */
const preloaded = new Map<string, Promise<void>>();
const loadedUrls = new Set<string>();
export function preloadImage(url: string): Promise<void> {
  let p = preloaded.get(url);
  if (!p) {
    p = new Promise<void>((resolve) => {
      const img = new Image();
      const done = () => {
        loadedUrls.add(url);
        resolve();
      };
      img.onload = done;
      img.onerror = done;
      img.src = url;
    });
    preloaded.set(url, p);
  }
  return p;
}
export function isPreloaded(url: string): boolean {
  return loadedUrls.has(url);
}
