// GameArtLayer.tsx — "Match the game" (lane sun-gamebg): the game's art behind the chat, in the chat background layer's
// art slot (sun-ambience): above its scene, below its particles + scrim. The owner's call (2026-11-14): high resolution and crisp
// (no blur), subtle, toggleable. So:
//   • the full-size art from the person's own server (3840×1240 Steam hero where there is one);
//   • drawn top-anchored, covering the area but NEVER past one art pixel per device pixel (model.ts fitArt): where
//     covering would upscale, the art keeps its size and fades into the theme at its edges;
//   • readability from a theme-coloured veil + a vignette: the veil is MEASURED per art and theme (model.ts veilFor over
//     the art's bound cells, measured off the main thread at full size) so every text the timeline draws straight on the
//     background — its own texts and people's name colours — keeps ≥ 4.5:1; art that can't be made readable is not drawn;
//   • a slow crossfade only when the image changes (none under reduce motion); nothing loaded or timed while hidden.
// src null / art missing (404) → nothing drawn: the room's normal look shows.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { onThemeApplied } from "@/ui/themeStore";
import { themeColours } from "@/ui/themes";
import { hslLightness, qtHsla } from "@/ui/color";
import { useReducedMotion } from "@/ui/motion";
import { useRoomState } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { useLiveWin } from "../ambience/layer";
import { BACKGROUND_STATE } from "../ambience/core";
import { useRoleNameColours } from "@/features/spaces";
import { FADE_MS, FIT_CONTRAST, MIN_CONTRAST, VEIL_CAP, VEIL_FLOOR, boundPixels, fitArt, inkTexts, luminance, parseHex, veilFor, type Rgb, artDimsOk, artSizeOk } from "./model";
import { useGameBackdrop } from "./runtime";

const log = createLogger("gamebg");

/** "#rrggbb" of a computed colour (opaque or flattened on `under`), "" when unreadable. */
function cssHex(v: string, under: Rgb = [0, 0, 0]): string {
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return "";
  let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (!Number.isFinite(a)) a = 1;
  const ch = (i: number) => Math.round(parseFloat(m[i + 1]) * a + under[i] * (1 - a));
  return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}
/** "#rrggbb" of any colour the browser draws ("" = none): a plain "#rrggbb" as is; anything else (a role colour such as
 *  "teal", "hsl(…)" or an rgba() with an out-of-range alpha the browser clamps) painted by the browser itself over the
 *  timeline background `bg` ("#rrggbb") on a 1×1 canvas and read back as the sRGB pixel. */
let probe: CanvasRenderingContext2D | null | undefined;
function drawnHex(v: string, bg: string): string {
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (!s) return "";
  if (probe === undefined) probe = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return cssHex(s, parseHex(bg) ?? ([0, 0, 0] as Rgb));
  probe.fillStyle = bg;
  probe.fillRect(0, 0, 1, 1);
  probe.fillStyle = v;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return `#${[d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
/** Every colour a person's NAME can have in this theme (ui/themes.ts senderColor: the palette's 12, or the hue band). */
function nameColours(): string[] {
  const t = themeColours();
  if (t.names === "palette") return Array.from({ length: 12 }, (_, i) => String(t.colour[`name.${i + 1}` as keyof typeof t.colour] ?? ""));
  const dark = hslLightness(t.colour["surface.window"]) < 0.5;
  const hues = [...Array.from({ length: 56 }, (_, i) => 0.02 + i / 360), ...Array.from({ length: 22 }, (_, i) => 0.45 + i / 360)];
  return hues.map((h) => qtHsla(h, 0.6, dark ? 0.7 : 0.42, 1));
}
interface Ink {
  bg: string;
  /** the timeline's own texts + the theme's name colours (role colours are added by withRoles) */
  texts: string[];
  mode: "dark" | "oled" | "light";
  key: string;
}
/** The timeline's background and every text colour it draws straight on it (its own texts + people's names). */
export function readInk(el: HTMLElement): Ink {
  const cs = getComputedStyle(el);
  // no readable background colour → "" → veilFor answers null: no art (never less readable than measured)
  const bg = cssHex(cs.getPropertyValue("--th-timeline-bg")) || cssHex(cs.backgroundColor);
  const under = parseHex(bg) ?? ([0, 0, 0] as Rgb);
  const own = ["--th-timeline-start-fg", "--th-timeline-empty-fg", "--th-timeline-new-line-fg"].map((k) => cssHex(cs.getPropertyValue(k), under));
  const names = nameColours().map((c) => cssHex(c, under));
  const texts = inkTexts(own, names, []);
  const L = luminance(under);
  return { bg, texts, mode: L > 0.4 ? "light" : L < 0.002 ? "oled" : "dark", key: `${bg}|${texts.join(",")}` };
}
/** 3-2: the room's role name colours (as drawn: spaces roleNameColour) join the veil's texts. */
export function withRoles(ink: Ink, roles: readonly string[]): Ink {
  if (!roles.length) return ink;
  const texts = inkTexts(ink.texts, [], roles.map((c) => drawnHex(c, ink.bg)));
  return { ...ink, texts, key: `${ink.bg}|${texts.join(",")}` };
}

// ---- measured once per session (off the main thread); a failure is asked again after 10 min ---------------------------
interface Art {
  src: string;
  w: number;
  h: number;
  cells: Rgb[];
}
const arts = new Map<string, { at: number; art: Art | null; p: Promise<Art | null> }>();
let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<number, (a: { ok: boolean; w?: number; h?: number; cells?: Rgb[] }) => void>();
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./measure.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const f = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      f?.(e.data);
    };
    worker.onerror = () => {
      for (const f of waiting.values()) f({ ok: false });
      waiting.clear();
      worker?.terminate();
      worker = undefined; // the next request starts a fresh one
    };
  } catch {
    worker = null;
  }
  return worker;
}
async function measureHere(src: string): Promise<{ ok: boolean; w?: number; h?: number; cells?: Rgb[] }> {
  const r = await fetch(src, { credentials: "same-origin" });
  if (!r.ok) return { ok: false };
  const blob = await r.blob();
  // R3-4: the size from the header first (the worker's rule); a picture too large (or of unknown size) is never decoded
  if (!artSizeOk(new Uint8Array(await blob.arrayBuffer()))) return { ok: false };
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!artDimsOk(img.naturalWidth, img.naturalHeight)) return { ok: false };
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return { ok: false };
    g.drawImage(img, 0, 0);
    return { ok: true, w: c.width, h: c.height, cells: boundPixels(g.getImageData(0, 0, c.width, c.height).data, c.width) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
function loadArt(src: string): Promise<Art | null> {
  const hit = arts.get(src);
  if (hit && (hit.art || Date.now() - hit.at < 10 * 60_000)) return hit.p;
  const p = (async (): Promise<Art | null> => {
    try {
      const w = getWorker();
      const r = w
        ? await new Promise<{ ok: boolean; w?: number; h?: number; cells?: Rgb[] }>((resolve) => {
            const id = nextId++;
            const t = window.setTimeout(() => {
              waiting.delete(id);
              resolve({ ok: false }); // a worker that never answers: a miss, asked again later
            }, 60_000);
            waiting.set(id, (a) => {
              window.clearTimeout(t);
              resolve(a);
            });
            w.postMessage({ id, src });
          })
        : await measureHere(src);
      if (!r.ok || !r.w || !r.h || !r.cells) return null;
      return { src, w: r.w, h: r.h, cells: r.cells };
    } catch {
      return null; // 404 (no art), not an image, a canvas failure: the room's normal look
    }
  })();
  const entry = { at: Date.now(), art: null as Art | null, p };
  arts.set(src, entry);
  void p.then((a) => {
    entry.art = a;
    entry.at = Date.now();
  });
  if (arts.size > 64) arts.delete(arts.keys().next().value as string);
  return p;
}
// keyed by the MEASURED art object: art measured again (evicted, changed on the server) never reuses an old veil
const veils = new WeakMap<Art, Map<string, number | null>>();
function veilOf(art: Art, ink: Ink): number | null {
  let m = veils.get(art);
  if (!m) veils.set(art, (m = new Map()));
  const k = ink.key;
  if (m.has(k)) return m.get(k) ?? null;
  const v = veilFor({ bg: ink.bg, texts: ink.texts, need: MIN_CONTRAST, target: FIT_CONTRAST, floor: VEIL_FLOOR[ink.mode], cap: VEIL_CAP[ink.mode] }, art.cells);
  m.set(k, v);
  if (m.size > 16) m.delete(m.keys().next().value as string);
  return v;
}

export interface GameArtLayerProps {
  roomId: string;
  /** the room's `dev.tinhat.chat.background` content (undefined = none) and its parent space's */
  roomBg: unknown;
  spaceBg?: unknown;
  /** the chat is on screen (a kept-alive hidden conversation does no work) */
  visible?: boolean;
  onShown?: (gameId: string | null) => void;
}

export function GameArtLayer(p: GameArtLayerProps) {
  const { src, gameId } = useGameBackdrop(p.roomId, p.roomBg, p.spaceBg, p.visible ?? true);
  const roles = useRoleNameColours(p.roomId);
  return <GameArtView src={src} gameId={gameId} onShown={p.onShown} visible={p.visible ?? true} roleColours={roles} />;
}

/** The chat's game art for the background layer's `art` slot (null = no art layer at all: the room's usual look). */
export function useGameArt(roomId: string | null | undefined, visible = true): ReactNode | null {
  const raw = useRoomState(roomId, BACKGROUND_STATE, "");
  const { src, gameId } = useGameBackdrop(roomId, raw, undefined, visible);
  const roles = useRoleNameColours(roomId);
  const [drawn, setDrawn] = useState<string | null>(null);
  if (!src && !drawn) return null;
  return <GameArtView src={src} gameId={gameId} onShown={setDrawn} visible={visible} roleColours={roles} />;
}

/** The drawing half: art `src` (null = nothing) for `gameId`. The gallery and the gates use it directly. */
/** `backdrops` = the PREPARED option for brighter art (not the default; the owner decides): every text drawn on the background
 *  sits on its own small backdrop instead, so the veil only needs the gentle floor. Gallery only for now. */
export function GameArtView(p: { src: string | null; gameId: string | null; onShown?: (gameId: string | null) => void; visible?: boolean; backdrops?: boolean; roleColours?: readonly string[] }) {
  const { src, gameId } = p;
  const reduced = useReducedMotion();
  const hidden = useLiveWin() === "hidden" || p.visible === false;
  const [retry, setRetry] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const [baseInk, setInk] = useState<Ink | null>(null);
  // the role name colours are measured too, and a change of them re-measures (3-2)
  const rolesKey = JSON.stringify(p.roleColours ?? []);
  const ink = useMemo(() => (baseInk ? withRoles(baseInk, JSON.parse(rolesKey) as string[]) : null), [baseInk, rolesKey]);
  const [size, setSize] = useState<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });
  const [slides, setSlides] = useState<{ art: Art; key: number }[]>([]);
  const keyRef = useRef(0);
  const shownRef = useRef<((g: string | null) => void) | undefined>(p.onShown);
  shownRef.current = p.onShown;

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const read = () => setInk(readInk(el));
    read();
    const offTheme = onThemeApplied(read);
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    // a move to a screen with another pixel ratio changes no CSS size: follow it on its own (no upscaling)
    let mq: MediaQueryList | null = null;
    const watchDpr = () => {
      mq?.removeEventListener("change", onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", onDpr);
    };
    const onDpr = () => {
      measure();
      watchDpr();
    };
    watchDpr();
    return () => {
      offTheme();
      ro.disconnect();
      mq?.removeEventListener("change", onDpr);
    };
  }, []);

  // the art for the shown game: measured once, then crossfaded in — only when the IMAGE changes (never while hidden)
  useEffect(() => {
    if (!src) {
      setSlides((s) => (s.length ? [] : s));
      shownRef.current?.(null);
      return;
    }
    if (hidden) return;
    let live = true;
    let retryT = 0;
    void loadArt(src).then((art) => {
      if (!live) return;
      if (!art) {
        setSlides([]);
        shownRef.current?.(null);
        retryT = window.setTimeout(() => setRetry((x) => x + 1), 10 * 60_000 + 1000); // the miss expires: ask again
        return;
      }
      setSlides((s) => {
        if (s.length && s[s.length - 1].art.src === art.src) return s; // the same image: keep it as it is
        return [...s.slice(-1), { art, key: ++keyRef.current }];
      });
      shownRef.current?.(gameId);
      log.debug(`art ${gameId} ${art.w}x${art.h} cells ${art.cells.length}`);
    });
    return () => {
      live = false;
      window.clearTimeout(retryT);
    };
  }, [src, gameId, hidden, retry]);

  // drop the faded-out slide once the new one is in
  useEffect(() => {
    if (slides.length < 2 || hidden) return;
    const t = window.setTimeout(() => setSlides((s) => s.slice(-1)), reduced ? 0 : FADE_MS + 100);
    return () => window.clearTimeout(t);
  }, [slides, reduced, hidden]);

  const unreadable = !!ink && slides.length > 0 && veilOf(slides[slides.length - 1].art, ink) === null;
  return (
    <div ref={wrap} aria-hidden="true" data-gamebg={gameId ?? ""} data-gamebg-unreadable={unreadable ? "" : undefined} style={WRAP}>
      {ink &&
        slides.map((s, i) => {
          const veil = p.backdrops ? VEIL_FLOOR[ink.mode] : veilOf(s.art, ink);
          const top = i === slides.length - 1;
          return veil === null ? null : <GameSlide key={s.key} art={s.art} veil={veil} size={size} top={top} leaving={!top} fade={!reduced} />;
        })}
    </div>
  );
}

const WRAP: CSSProperties = { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" };

// A change dissolves THROUGH the theme: the old slide fades out in the first half, the new one fades in in the second.
// One slide at a time, mixed toward the theme background = a stronger veil, which veilFor guarantees is still safe
// (a crossfade between two images was not: their mix can leave both images' bounds).
function GameSlide({ art, veil, size, top, leaving, fade }: { art: Art; veil: number; size: { w: number; h: number; dpr: number }; top: boolean; leaving: boolean; fade: boolean }) {
  const [visible, setVisible] = useState(!fade);
  useEffect(() => {
    if (!fade) {
      setVisible(true); // reduce motion switched on before the first frame: show at once, never stay at 0
      return;
    }
    const r = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(r);
  }, [fade]);
  const f = useMemo(() => fitArt(art.w, art.h, size.w, size.h, size.dpr), [art.w, art.h, size.w, size.h, size.dpr]);
  // fade the art's own edges into the theme where it doesn't reach (the mask colour only needs to be opaque)
  const masks: string[] = [];
  if (f.fadeBottom) masks.push(`linear-gradient(to bottom, var(--th-timeline-bg) ${Math.round(f.h * 0.55)}px, transparent ${Math.round(f.h)}px)`);
  if (f.fadeSides) masks.push(`linear-gradient(to right, transparent ${Math.round(f.x)}px, var(--th-timeline-bg) ${Math.round(f.x + f.w * 0.12)}px, var(--th-timeline-bg) ${Math.round(f.x + f.w * 0.88)}px, transparent ${Math.round(f.x + f.w)}px)`);
  const mask = masks.join(", ");
  const img: CSSProperties = {
    position: "absolute",
    left: f.x,
    top: f.y,
    width: f.w,
    height: f.h,
    backgroundImage: `url("${art.src}")`,
    backgroundSize: "100% 100%",
    backgroundRepeat: "no-repeat",
  };
  // the slide (art + its own veil + vignette) is ONE composited group, so a fade never weakens the veil over the art
  const outer: CSSProperties = {
    position: "absolute",
    inset: 0,
    isolation: "isolate",
    opacity: leaving ? 0 : top ? (visible ? 1 : 0) : 1,
    transition: fade ? `opacity ${FADE_MS / 2}ms ease-in-out ${top && !leaving ? FADE_MS / 2 : 0}ms` : "none",
    ...(mask ? { maskImage: mask, WebkitMaskImage: mask, maskComposite: "intersect", WebkitMaskComposite: "source-in" } : {}),
  };
  return (
    <div style={outer} data-gamebg-veil={veil} data-gamebg-art={`${art.w}x${art.h}`}>
      <div style={img} />
      <div style={{ position: "absolute", inset: 0, background: "var(--th-timeline-bg)", opacity: veil }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 120% 90% at 50% 35%, transparent 55%, var(--th-timeline-bg) 100%)", opacity: 0.7 }} />
    </div>
  );
}
