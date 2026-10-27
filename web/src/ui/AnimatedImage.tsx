// AnimatedImage.tsx — an <img> for message media that may be an animated GIF / WebP, playing by the low-GPU rule
// (contract GPU.md §2.6; the pure numbers are core/lowgpu.ts + core/animimg.ts):
//
//   • it plays while the window is focused AND the image is in view, for at most 3 loops or 15 s (the file's own
//     smaller loop count wins), then rests on its FIRST frame;
//   • hovering it replays a run (a click too, where the click isn't taken — `clickPlays`); leaving the view or the
//     window losing the focus stops it at once (the first frame again) — it autoplays again when both come back,
//     unless its run had finished (then only after it left the view and came back, or a hover);
//   • Reduce motion (the app's or the OS's): it never plays on its own — first frame; a click plays ONE loop
//     (`playOnMount: "one"` = the click that opened it, the lightbox);
//   • Settings → Appearance → "Play GIFs automatically" (pref `gif-autoplay`, default on) off: first frame until a
//     hover / click;
//   • no mask or effect layer — the still is the file's first frame, drawn once.
//
// Only sources that sniff as GIF / WebP are managed (the bytes are read once: a blob: URL locally, a remote URL with
// a CORS fetch — Giphy, imgur and Tenor allow it); everything else is a plain <img> exactly as before. The still is
// the image's default (first) frame from createImageBitmap, as a PNG object URL (or, for a remote host without CORS,
// a <canvas> — docs/WEB-EXCEPTIONS.md). A run shows a fresh object URL of the same bytes, so it starts at frame 0.
import { useEffect, useRef, useState, type ImgHTMLAttributes, type MouseEvent, type SyntheticEvent } from "react";
import { usePref } from "../core/prefs";
import { onWinState, winFocused } from "../core/winstate";
import { gifRunMs } from "../core/lowgpu";
import { inspectAnimation, sniffKind, type AnimInfo } from "../core/animimg";
import { animate, onMotionChange, reducedMotion } from "./motion";

export interface AnimatedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onLoad" | "onError" | "onClick" | "onPointerEnter"> {
  src: string | undefined;
  /** fired when the picture (animated, still or plain) has loaded: its natural size */
  onReady?: (w: number, h: number) => void;
  onError?: () => void;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  /** a click on the image plays a run (one loop under reduce motion); false where the click opens something */
  clickPlays?: boolean;
  /** "one": the mount itself was a click (the lightbox) — under reduce motion it plays one loop at once */
  playOnMount?: "one";
  /** a hint that this may be animated (a mimetype or the URL); anything that isn't GIF/WebP skips the byte read */
  mime?: string;
}

type Source = { blob: Blob | null; info: AnimInfo; still: string | null; canvas: ImageBitmap | null };

// ---- shared per-URL inspection (the lightbox and the timeline show the same GIF) ----------------------------------

const cache = new Map<string, { refs: number; p: Promise<Source | null>; src?: Source | null; disposed?: boolean }>();

/** "yes": GIF / WebP by its mimetype or URL — hidden until its bytes are read (it never plays unasked);
 *  "maybe": a local blob of unknown type (a link preview's image) — shown as is while its bytes are read (a JPEG, the
 *  usual case, looks exactly as before); "no": not an animated format. */
function candidate(src: string, mime?: string): "yes" | "maybe" | "no" {
  const m = (mime ?? "").toLowerCase();
  if (m) return m.includes("gif") || m.includes("webp") ? "yes" : "no";
  if (src.startsWith("data:image/gif") || src.startsWith("data:image/webp")) return "yes";
  if (/\.(gif|webp)(\?|#|$)/i.test(src) || /giphy\.com|tenor\.com/i.test(src)) return "yes";
  return src.startsWith("blob:") ? "maybe" : "no";
}

async function readBytes(src: string): Promise<Blob | null> {
  try {
    const r = await fetch(src, src.startsWith("blob:") || src.startsWith("data:") ? {} : { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!r.ok) return null;
    return await r.blob();
  } catch {
    return null; // a host without CORS
  }
}

function loadDetached(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.referrerPolicy = "no-referrer";
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("image failed"));
    im.src = src;
  });
}

async function inspect(src: string): Promise<Source | null> {
  const raw = await readBytes(src);
  if (raw) {
    const head = new Uint8Array(await raw.slice(0, 16).arrayBuffer());
    const kind = sniffKind(head);
    if (kind === "other") return null;
    // the runs show object URLs of these bytes in this origin: type them by what they ARE (a GIF/WebP polyglot served
    // as text/html by a member-chosen host must not become an HTML page here — security review 2026-10-26, H1)
    const blob = new Blob([raw], { type: kind === "gif" ? "image/gif" : "image/webp" });
    const info = inspectAnimation(new Uint8Array(await blob.arrayBuffer()));
    if (!info.animated) return null;
    // the default image of an animated image = its first frame (HTML: createImageBitmap)
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")?.drawImage(bmp, 0, 0);
    bmp.close();
    const png = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    return { blob, info, still: png ? URL.createObjectURL(png) : null, canvas: null };
  }
  // no CORS: no bytes, no length — assume it is animated (the URL said GIF/WebP); a still from a detached image's
  // default frame, shown on a canvas (tainted, but displayable)
  if (src.startsWith("blob:") || src.startsWith("data:")) return null;
  try {
    const im = await loadDetached(src);
    const bmp = await createImageBitmap(im);
    return { blob: null, info: { kind: "gif", animated: true, frames: 0, loopMs: 0, plays: 0, width: bmp.width, height: bmp.height }, still: null, canvas: bmp };
  } catch {
    return null;
  }
}

function disposeSource(v: Source | null | undefined): void {
  if (v?.still) URL.revokeObjectURL(v.still);
  v?.canvas?.close();
}

function acquire(src: string): { p: Promise<Source | null>; release: () => void } {
  let e = cache.get(src);
  if (!e) {
    const entry: { refs: number; p: Promise<Source | null>; src?: Source | null; disposed?: boolean } = { refs: 0, p: inspect(src).catch(() => null) };
    // an inspection that settles after its entry was evicted frees what it made at once
    entry.p.then((v) => (entry.disposed ? disposeSource(v) : (entry.src = v)));
    cache.set(src, entry);
    e = entry;
  }
  const entry = e;
  entry.refs++;
  let done = false;
  return {
    p: entry.p,
    release: () => {
      if (done) return;
      done = true;
      entry.refs--;
      if (entry.refs > 0) return;
      // keep it a little: a re-render / the lightbox reopening reuses it
      setTimeout(() => {
        if (entry.refs > 0 || cache.get(src) !== entry) return;
        cache.delete(src);
        entry.disposed = true;
        disposeSource(entry.src);
      }, 30_000);
    },
  };
}

// ---- one shared IntersectionObserver ------------------------------------------------------------------------------

const seen = new Map<Element, (v: boolean) => void>();
let io: IntersectionObserver | null = null;
function observe(el: Element, cb: (v: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => undefined;
  }
  io ??= new IntersectionObserver((entries) => {
    for (const en of entries) seen.get(en.target)?.(en.isIntersecting);
  });
  seen.set(el, cb);
  io.observe(el);
  return () => {
    seen.delete(el);
    io?.unobserve(el);
  };
}

// ---- the component --------------------------------------------------------------------------------------------------

/** One playback state per source: a new `src` is a new image (its run, "done" mark and one-loop click start over). */
export function AnimatedImage(p: AnimatedImageProps) {
  return <AnimatedImageOne key={p.src ?? ""} {...p} />;
}

function AnimatedImageOne(p: AnimatedImageProps) {
  // (the component's own props are read from `p`; `rest` = the <img> attributes to forward)
  const { src, onReady: _r, onError: _e, onClick: _c, clickPlays: _cp, playOnMount: _pm, mime: _m, ...rest } = p;
  const cand = src ? candidate(src, p.mime) : "no";
  const managed = cand !== "no";
  const [source, setSource] = useState<Source | null | undefined>(managed ? undefined : null);
  const autoplay = usePref("gif-autoplay", "1") !== "0";
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  const [, setMotionRev] = useState(0);
  // the current run: a fresh object URL of the bytes (frame 0) until `until`
  // kind: "auto" = autoplay, "user" = a hover / click replay, "one" = the single loop a click plays under Reduce motion
  const [run, setRun] = useState<{ url: string; until: number; kind: "auto" | "user" | "one" } | null>(null);
  const done = useRef(false);

  // inspect (shared per URL)
  useEffect(() => {
    if (!managed || !src) {
      setSource(null);
      return;
    }
    let alive = true;
    setSource(undefined);
    const h = acquire(src);
    void h.p.then((v) => alive && setSource(v));
    return () => {
      alive = false;
      h.release();
    };
  }, [managed, src]);

  // focus / motion changes re-evaluate
  useEffect(() => {
    const a = onMotionChange(() => setMotionRev((n) => n + 1));
    const b = onWinState(() => setMotionRev((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, []);

  // in view?
  const animatedSource = source && source.info.animated ? source : null;
  useEffect(() => {
    const el = ref.current;
    if (!el || !animatedSource) return;
    return observe(el, (v) => {
      setInView(v);
      if (!v) done.current = false; // left the view: the next appearance gets a new run
    });
  }, [animatedSource, run === null]);

  const startRun = (kind: "auto" | "user" | "one") => {
    if (!animatedSource) return;
    const ms = gifRunMs(animatedSource.info.loopMs, animatedSource.info.plays, kind === "one");
    const url = animatedSource.blob ? URL.createObjectURL(animatedSource.blob) : src!;
    setRun((prev) => {
      if (prev && animatedSource.blob) URL.revokeObjectURL(prev.url);
      return { url, until: performance.now() + ms, kind };
    });
  };
  const stopRun = (finished: boolean) => {
    setRun((prev) => {
      if (prev && animatedSource?.blob) URL.revokeObjectURL(prev.url);
      return null;
    });
    if (finished) done.current = true;
  };

  // the run's end
  useEffect(() => {
    if (!run) return;
    const t = window.setTimeout(() => stopRun(true), Math.max(0, run.until - performance.now()));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);
  useEffect(() => () => void (run && animatedSource?.blob && URL.revokeObjectURL(run.url)), [run, animatedSource]);

  // autoplay / stop on focus or view
  const moving = animate(); // focused AND NOT reduce motion
  const focused = winFocused();
  useEffect(() => {
    if (!animatedSource) return;
    // focus lost / out of view: every run stops; Reduce motion on: every run but the one loop a click plays under it
    if (run && (!focused || !inView || (reducedMotion() && run.kind !== "one"))) {
      stopRun(false);
      return;
    }
    if (!run && moving && autoplay && inView && !done.current) startRun("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animatedSource, moving, focused, autoplay, inView]);

  // the lightbox's click-to-open under reduce motion: one loop
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current || !animatedSource) return;
    mounted.current = true;
    if (p.playOnMount === "one" && reducedMotion() && winFocused()) startRun("one");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animatedSource]);

  const common = {
    ...rest,
    onPointerEnter: () => {
      // hover replays a run — not under reduce motion (only a click plays, one loop)
      if (animatedSource && !run && animate()) startRun("user");
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (animatedSource && p.clickPlays !== false && !run && winFocused()) startRun(reducedMotion() ? "one" : "user");
      p.onClick?.(e);
    },
  };
  const ready = (e: SyntheticEvent<HTMLImageElement>) => p.onReady?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);

  const setRef = (el: HTMLElement | null) => void (ref.current = el);
  // not managed / not animated: the plain <img>, exactly as before
  if (!managed || source === null) return <img ref={setRef} {...rest} src={src} onLoad={ready} onError={p.onError} onClick={p.onClick} />;
  // still being read: a GIF / WebP shows nothing yet (the caller keeps its loading state until onReady); an image
  // of unknown type shows as it is meanwhile
  if (source === undefined)
    return cand === "maybe" ? <img ref={setRef} {...rest} src={src} onLoad={ready} onError={p.onError} onClick={p.onClick} /> : <img ref={setRef} {...rest} style={{ ...rest.style, visibility: "hidden" }} />;
  if (run) return <img ref={setRef} key={run.url} {...common} src={run.url} onLoad={ready} onError={p.onError} />;
  if (source.canvas) return <StillCanvas bmp={source.canvas} refCb={setRef} onReady={p.onReady} {...common} />;
  return <img ref={setRef} {...common} src={source.still ?? src} onLoad={ready} onError={p.onError} />;
}

function StillCanvas(p: { bmp: ImageBitmap; refCb: (el: HTMLElement | null) => void; onReady?: (w: number, h: number) => void } & Record<string, unknown>) {
  const { bmp, refCb, onReady, ...rest } = p;
  const c = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = c.current;
    if (!el) return;
    el.width = bmp.width;
    el.height = bmp.height;
    el.getContext("2d")?.drawImage(bmp, 0, 0);
    onReady?.(bmp.width, bmp.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bmp]);
  return (
    <canvas
      ref={(el) => {
        c.current = el;
        refCb(el);
      }}
      {...(rest as object)}
    />
  );
}
