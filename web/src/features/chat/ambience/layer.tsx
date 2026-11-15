// layer.tsx — the chat's background + particle layer (Tin Hat Web; the desktop's AmbienceLayer.qml): the room's
// shared background (a drawn scene: gradient + glow + the theme scrim) and, on top of it but BEHIND the message list,
// the effect canvas. The particles meet the panels of the list (bubbles, day pills, names, reactions — every element
// marked `data-bubble` / `data-amb`): rain pools on their tops and drips down their sides, embers slide along their
// undersides. Nothing is ever drawn inside one (core.ts). Rules: core.ts effectsState (Settings → Appearance →
// Performance; hidden ALWAYS pauses).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { usePref } from "@/core/prefs";
import { onRealWinState, realWinState } from "@/core/winstate";
import { nativeInfo } from "@/features/native/bridge";
import { nativeCall, onNativeCall } from "@/features/native/callState";
import { UNFOCUSED_SAVER_PREF, unfocusedSaverOn } from "@/core/lowgpu";
import { useReducedMotion } from "@/ui/motion";
import { onThemeApplied } from "@/ui/themeStore";
import { createLogger } from "@/core/log";
import {
  AmbienceSim,
  EFFECT_FPS,
  MeshOut,
  PREF_BACKGROUNDS,
  PREF_DEFAULTS,
  PREF_EFFECTS,
  PREF_PAUSE_UNFOCUSED,
  WARM_S,
  effectsState,
  liveWinState,
  lookFor,
  scrimForCells,
  imageCells,
  prefOn,
  presetById,
  scrimFor,
  themeMode,
  type Background,
  type Collider,
  type Look,
  type Mode,
  type Cell,
  type WinState,
} from "./core";
import { AmbienceGl } from "./gl";
import { callPause } from "./callpause";
import { useCall } from "@/features/calls";

const log = createLogger("ambience");

/** The elements particles treat as solid. */
export const COLLIDER_SELECTOR = "[data-bubble], [data-amb]";

/** "#rrggbb" from a computed CSS colour ("rgb(…)", "rgba(…)", "#…"); a translucent colour is flattened on `under`. */
export function cssHex(v: string, under = "#000000"): string {
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return "";
  let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (!Number.isFinite(a)) a = 1;
  const u = /^#([0-9a-f]{6})$/i.exec(under)?.[1] ?? "000000";
  const ch = (i: number) => {
    const c = parseFloat(m[i + 1]);
    const b = parseInt(u.slice(i * 2, i * 2 + 2), 16);
    return Math.round(c * a + b * (1 - a));
  };
  return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}

interface ThemeInk {
  bg: string;
  fgs: string[];
  mode: Mode;
}
function readInk(el: HTMLElement): ThemeInk {
  const cs = getComputedStyle(el);
  const bg = cssHex(cs.getPropertyValue("--th-timeline-bg")) || "#000000";
  const fgs = ["--th-timeline-start-fg", "--th-timeline-empty-fg", "--th-timeline-new-line-fg"].map((k) => cssHex(cs.getPropertyValue(k), bg)).filter(Boolean);
  return { bg, fgs, mode: themeMode(bg) };
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
/** The CSS of a look: the glow (an ellipse fading to nothing) over the vertical gradient. */
export function lookCss(look: Look): string {
  const g = look.glow;
  const stops = look.stops.map(([at, c]) => `${c} ${Math.round(at * 1000) / 10}%`).join(", ");
  return `radial-gradient(${g.rx * 100}% ${g.ry * 100}% at ${g.x * 100}% ${g.y * 100}%, ${hexA(g.color, g.a)} 0%, ${hexA(g.color, 0)} 100%), linear-gradient(to bottom, ${stops})`;
}

/** The three switches (Settings → Appearance → Performance) and what they combine with. */
export function useAmbiencePrefs() {
  const bg = usePref(PREF_BACKGROUNDS, "");
  const fx = usePref(PREF_EFFECTS, "");
  const pause = usePref(PREF_PAUSE_UNFOCUSED, "");
  const saver = usePref(UNFOCUSED_SAVER_PREF, "0");
  return {
    // the shared defaults (core PREF_DEFAULTS): the same as Settings shows and the desktop uses
    backgrounds: prefOn(bg, PREF_DEFAULTS[PREF_BACKGROUNDS]),
    effects: prefOn(fx, PREF_DEFAULTS[PREF_EFFECTS]),
    pauseUnfocused: prefOn(pause, PREF_DEFAULTS[PREF_PAUSE_UNFOCUSED]),
    saver: unfocusedSaverOn(saver),
  };
}

// ---- the window state the effects follow (core.liveWinState): the browser's + the phone apps' bridge -----------------
type Bridge = { appState?: unknown; covered?: unknown };
function bridge(): Bridge | null {
  try {
    const n = (globalThis as { tinhatNative?: unknown }).tinhatNative;
    return n && typeof n === "object" ? (n as Bridge) : null;
  } catch {
    return null;
  }
}
/** Android `tinhatNative.appState()` → {visible, focused} (guarded: the app is untrusted input). */
function appState(): { visible: boolean | null; focused: boolean | null } {
  try {
    const f = bridge()?.appState;
    if (typeof f !== "function") return { visible: null, focused: null };
    const v = (f as () => unknown).call(bridge()) as { visible?: unknown; focused?: unknown } | null;
    return { visible: typeof v?.visible === "boolean" ? v.visible : null, focused: typeof v?.focused === "boolean" ? v.focused : null };
  } catch {
    return { visible: null, focused: null };
  }
}
/** iOS `tinhatNative.covered()`: the native call screen hides the page (it stays "visible" for Media Party). null = the
 *  app has no such call (then a native call counts as covering: core.liveWinState, 3-3). */
function covered(): boolean | null {
  try {
    const f = bridge()?.covered;
    return typeof f === "function" ? (f as () => unknown).call(bridge()) === true : null;
  } catch {
    return false;
  }
}
/** A Tin Hat phone app (iOS or Android): without a native focus report, visible counts as focused (3-4). */
function phoneShell(): boolean {
  const p = nativeInfo()?.platform;
  return p === "ios" || p === "android";
}
export function readLiveWin(): WinState {
  const real = realWinState(); // the page's own: visibility + focus incl. our pop-out windows
  const a = appState();
  return liveWinState({ hidden: real === "hidden", appVisible: a.visible, covered: covered(), appFocused: a.focused, phoneShell: phoneShell(), hasFocus: real === "focused", nativeCall: nativeCall() !== null });
}
function subscribeLive(cb: () => void): () => void {
  const off = onRealWinState(() => cb());
  window.addEventListener("tinhatnative:appstate", cb);
  window.addEventListener("tinhatnative:covered", cb);
  const offCall = onNativeCall(() => cb());
  return () => {
    off();
    offCall();
    window.removeEventListener("tinhatnative:appstate", cb);
    window.removeEventListener("tinhatnative:covered", cb);
  };
}
/** The effects' window state, live (re-read on the page's focus / visibility and the apps' bridge events). */
export function useLiveWin(): WinState {
  return useSyncExternalStore(subscribeLive, readLiveWin, () => "focused");
}

/** Until an image is known: every colour possible — the veil that keeps any text at its level. */
const UNKNOWN_IMAGE: Cell[] = [[[0, 0, 0], [1, 1, 1]]];

/** The name colours drawn on the background in view (`data-amb="name"`): the scrim keeps them readable too. */
function useNameColours(content: () => HTMLElement | null, on: boolean): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    const ct = content();
    if (!on || !ct) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const bg = cssHex(getComputedStyle(ct).getPropertyValue("--th-timeline-bg")) || "#000000";
      const set = new Set<string>();
      for (const el of Array.from(ct.querySelectorAll('[data-amb="name"]'))) {
        const h = cssHex(getComputedStyle(el).color, bg);
        if (h) set.add(h);
        if (set.size >= 64) break;
      }
      const next = Array.from(set).sort();
      setNames((prev) => (prev.join() === next.join() ? prev : next));
    };
    read();
    const again = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    const mo = new MutationObserver(again);
    // new rows, and a name whose colour changed (its style or class: a role colour, another theme)
    mo.observe(ct, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
    const offTheme = onThemeApplied(again);
    return () => {
      mo.disconnect();
      offTheme();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [content, on]);
  return names;
}

export interface AmbienceLayerProps {
  background: Background;
  /** kind "image": the decrypted still image and its colour cells when core.imageShown said yes; null = the preset */
  image?: { src: string; cells: Cell[] } | null;
  /** kind "game" / unset (game art): its art layer, drawn above the scene and below the scrim + particles */
  art?: ReactNode;
  /** the element whose `data-bubble` / `data-amb` descendants are the panels */
  content: () => HTMLElement | null;
  /** the scrolling element (its scroll moves the panels) */
  scroller: () => HTMLElement | null;
  mobile?: boolean;
  /** tests / the gallery: a fixed seed */
  seed?: number;
  /** the worst-case measurements only: run on a software rasteriser too */
  force?: boolean;
}

export function AmbienceLayer(p: AmbienceLayerProps) {
  const prefs = useAmbiencePrefs();
  const reduced = useReducedMotion();
  const win = useLiveWin();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ink, setInk] = useState<ThemeInk | null>(null);
  const [gpu, setGpu] = useState(true);
  const preset = p.background.preset ? presetById(p.background.preset) : null;
  // a scene, or (game art) an art layer with no scene under it
  const shown = prefs.backgrounds && (!!preset || !!p.art);

  useEffect(() => {
    const el = wrap.current;
    if (!el || !shown) return;
    const read = () => {
      setInk(readInk(el));
      loop.current?.restyle();
    };
    read();
    return onThemeApplied(read);
  }, [shown]);

  const look = preset && ink ? lookFor(preset, ink.mode) : null;
  const image = p.background.kind === "image" ? (p.image ?? null) : null;
  const img = image?.src ?? null;
  const names = useNameColours(p.content, shown);
  const scrim = useMemo(() => {
    if (!ink) return 0;
    const fgs = [...ink.fgs, ...names];
    // a custom image: the veil its own colour cells need (every pixel measured)
    if (image) return scrimForCells(image.cells.length ? image.cells : UNKNOWN_IMAGE, ink.bg, fgs);
    return look ? scrimFor(look, ink.bg, fgs) : 0;
  }, [look, ink, image, names]);
  // the veil only fades when it gets lighter: a heavier one is needed at once (a fade up would be unreadable meanwhile)
  const lastScrim = useRef(0);
  const scrimFade = scrim < lastScrim.current;
  useEffect(() => {
    lastScrim.current = scrim;
  }, [scrim]);
  const inCall = useCall((c) => c.inCall || c.connecting);
  const state = callPause(effectsState({ ...prefs, reduced, win, gpu, effect: shown ? p.background.effect : "none" }), inCall);

  // the effect loop: alive while the state is "run" or "paused" (paused keeps the particles and stops the clock)
  const loop = useRef<Loop | null>(null);
  useEffect(() => {
    if (!shown || state === "off" || !ink) {
      loop.current?.stop();
      loop.current = null;
      return;
    }
    const cv = canvas.current;
    if (!cv) return;
    const loopKey = `${p.background.effect}|${p.mobile ? 1 : 0}|${p.seed ?? ""}|${p.force ? 1 : 0}`;
    if (!loop.current || loop.current.key !== loopKey || loop.current.content !== p.content || loop.current.scroller !== p.scroller) {
      loop.current?.stop();
      // the worst-case measurements only (a dev build: tools/ambience/call-cost.mjs): run on a software rasteriser too
      const devForce = import.meta.env.DEV && (() => {
        try {
          return localStorage.getItem("tinhat.dev.ambience-force") === "1";
        } catch {
          return false;
        }
      })();
      const gl = AmbienceGl.create(cv, p.force || devForce);
      if (!gl) {
        log.info("no WebGL2 on a GPU: the still background only");
        setGpu(false);
        return;
      }
      loop.current = new Loop(gl, cv, p.background.effect, p.content, p.scroller, p.mobile ? 0.6 : 1, p.seed ?? ((Date.now() & 0x7fffffff) >>> 0), () => setGpu(false));
      loop.current.key = loopKey;
      log.info(`effect ${p.background.effect} on (${p.mobile ? "phone" : "desktop"} density)`);
    }
    loop.current.mode = ink.mode;
    loop.current.setRunning(state === "run");
  }, [shown, state, ink, p.background.effect, p.content, p.scroller, p.mobile, p.seed, p.force]);
  useEffect(() => () => {
    loop.current?.stop();
    loop.current = null;
  }, []);

  if (!shown) return null;
  const style: CSSProperties = { position: "absolute", inset: 0, zIndex: -1, pointerEvents: "none", overflow: "hidden" };
  return (
    <div ref={wrap} style={style} aria-hidden data-ambience={preset?.id ?? "art"} data-ambience-kind={img ? "image" : p.background.kind} data-ambience-effect={p.background.effect} data-ambience-state={state}>
      {look && <div style={{ position: "absolute", inset: 0, background: lookCss(look) }} />}
      {img && ink && <div style={{ position: "absolute", inset: 0, backgroundImage: `url("${img}")`, backgroundSize: "cover", backgroundPosition: "center" }} data-ambience-image="" />}
      {p.art}
      {ink && scrim > 0 && <div style={{ position: "absolute", inset: 0, background: ink.bg, opacity: scrim, transition: scrimFade ? "opacity 400ms" : "none" }} data-ambience-scrim={scrim} />}
      <canvas ref={canvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: state === "off" ? "none" : "block" }} />
    </div>
  );
}

/** The frame loop: rAF at the effect's rate, the panels re-read only when something moved (scroll, resize, the list
 *  changed), one mesh upload + one draw per frame. Paused = no rAF at all (the last frame stays on screen). */
class Loop {
  effect: Background["effect"];
  key = "";
  mode: Mode = "dark";
  private sim: AmbienceSim;
  private out = new MeshOut(4096);
  private raf = 0;
  private last = 0;
  private lastDraw = 0;
  private dirty = true;
  private els: Element[] = [];
  private ids = new WeakMap<Element, string>();
  private radii = new WeakMap<Element, [number, number]>();
  private frames = 0;
  private nextId = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private offs: Array<() => void> = [];
  private running = false;
  private warmed = false;
  private stopped = false;

  constructor(
    private gl: AmbienceGl,
    private cv: HTMLCanvasElement,
    effect: Background["effect"],
    readonly content: () => HTMLElement | null,
    readonly scroller: () => HTMLElement | null,
    density: number,
    seed: number,
    private onLost: () => void,
  ) {
    this.effect = effect;
    this.sim = new AmbienceSim(effect, seed, density);
    this.dprCap = density < 1 ? 1.5 : 2;
    const mark = () => {
      this.dirty = true;
      // paused: the last frame would stay where the panels WERE: clear it (the next running frame redraws)
      if (!this.running && !this.stopped) this.gl.clear();
    };
    const requery = () => {
      this.els = [];
      this.radii = new WeakMap();
      mark();
    };
    const sc = scroller();
    sc?.addEventListener("scroll", mark, { passive: true });
    this.offs.push(() => sc?.removeEventListener("scroll", mark));
    const ro = new ResizeObserver(mark);
    ro.observe(cv);
    const ct = content();
    if (ct) ro.observe(ct);
    this.offs.push(() => ro.disconnect());
    if (ct) {
      const mo = new MutationObserver(requery);
      mo.observe(ct, { childList: true, subtree: true });
      this.offs.push(() => mo.disconnect());
    }
    window.addEventListener("resize", mark);
    this.offs.push(() => window.removeEventListener("resize", mark));
  }
  private dprCap: number;

  /** A theme change: corner radii may differ. */
  restyle(): void {
    this.radii = new WeakMap();
    this.dirty = true;
  }

  setRunning(on: boolean): void {
    if (this.stopped || on === this.running) return;
    this.running = on;
    if (on) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.frame);
    } else cancelAnimationFrame(this.raf);
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    for (const f of this.offs) f();
    this.offs = [];
    this.gl.clear();
    this.gl.dispose();
  }

  private size(): void {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    const bw = Math.max(1, Math.round(r.width * dpr));
    const bh = Math.max(1, Math.round(r.height * dpr));
    if (this.cv.width !== bw || this.cv.height !== bh) {
      this.cv.width = bw;
      this.cv.height = bh;
    }
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    this.sim.setView(r.width, r.height);
  }

  /** The panels in view, in the canvas's coordinates. */
  private colliders(): Collider[] {
    const ct = this.content();
    if (!ct) return [];
    if (this.els.length === 0) this.els = Array.from(ct.querySelectorAll(COLLIDER_SELECTOR));
    const o = this.cv.getBoundingClientRect();
    const out: Collider[] = [];
    for (const el of this.els) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < o.top - 40 || r.top > o.bottom + 40 || r.right < o.left || r.left > o.right) continue;
      let id = this.ids.get(el);
      if (!id) {
        id = `c${this.nextId++}`;
        this.ids.set(el, id);
      }
      let rad = this.radii.get(el);
      if (!rad) {
        const cs = getComputedStyle(el);
        rad = [parseFloat(cs.borderTopLeftRadius) || 0, parseFloat(cs.borderTopRightRadius) || 0];
        this.radii.set(el, rad);
      }
      out.push({ id, x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height, rl: rad[0], rr: rad[1] });
    }
    return out;
  }

  private frame = (now: number): void => {
    if (!this.running || this.stopped) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.gl.lost) {
      this.running = false;
      this.onLost();
      return;
    }
    const fps = EFFECT_FPS[this.effect] || 30;
    if (this.lastDraw && now - this.lastDraw < 1000 / fps - 2) return;
    this.lastDraw = now;
    const dt = this.last ? (now - this.last) / 1000 : 1 / fps;
    this.last = now;
    // a panel can change size without anything above noticing (an edit, a reaction): re-read them twice a second
    if (++this.frames % 15 === 0) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this.size();
      this.sim.setColliders(this.colliders());
      if (!this.warmed) {
        this.warmed = true;
        this.sim.warm(WARM_S);
      }
    }
    this.sim.advance(dt);
    const n = this.sim.mesh(this.mode, this.out);
    this.gl.draw(this.out.buf, n, this.w, this.h);
  };
}
