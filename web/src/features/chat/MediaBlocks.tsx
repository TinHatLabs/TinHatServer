// MediaBlocks.tsx — the media inside a ChatBubble (CB:614-976): inline/animated image, placeholder,
// video card, file card, inline audio player, big-audio chip. E2EE attachments decrypt through core media.
import { useEffect, useRef, useState } from "react";
import { useMessageMedia } from "@/core/matrix";
import { AnimatedImage, BusyIndicator, Icon, ToolButton, Slider, useTip, cx } from "@/ui";
import { fileGlyph, fmtDuration, fmtSize } from "./lib/format";
import type { MediaRef } from "./lib/model";
import { mediaBlob, openMedia, saveMedia } from "./actions";
import s from "./Bubble.module.css";

type C = Record<string, unknown>;

function useMediaUrl(m: MediaRef, enabled: boolean, retry: number): string | undefined {
  const content: C | null = enabled && !m.localUrl ? (m.file ? { file: m.file, info: { mimetype: m.mimetype } } : { url: m.url, info: { mimetype: m.mimetype } }) : null;
  const url = useMessageMedia(content as never, retry ? { animated: true } : {});
  return m.localUrl ?? url;
}

export function imageBox(m: MediaRef, maxW: number): { w: number; h: number; known: boolean } {
  if (m.w > 0 && m.h > 0) {
    const fit = Math.min(1, maxW / m.w, 360 / m.h);
    return { w: Math.max(1, Math.round(m.w * fit)), h: Math.max(1, Math.round(m.h * fit)), known: true };
  }
  return { w: maxW, h: Math.round((maxW * 9) / 16), known: false };
}

export function ImageBlock({ m, maxW, mine, onOpen }: { m: MediaRef; maxW: number; mine: boolean; onOpen: (src: string, w: number, h: number) => void }) {
  const [retry, setRetry] = useState(0);
  const [err, setErr] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const src = useMediaUrl(m, true, retry);
  const known = m.w > 0 && m.h > 0;
  const box = imageBox(nat && !known ? { ...m, w: nat.w, h: nat.h } : m, maxW);
  if (!src && !err && !m.url && !m.file && !m.localUrl) {
    return (
      <div className={s.imgPlaceholder}>
        <Icon name="image-x-generic" size={16} color={mine ? "var(--th-bubble-own-meta-fg)" : "var(--th-bubble-other-meta-fg)"} />
        <span>{m.name || "image"}</span>
      </div>
    );
  }
  return (
    <div
      className={s.imgBox}
      style={{ width: box.w, height: box.h }}
      onClick={(e) => {
        e.stopPropagation();
        if (err) {
          setErr(false);
          setLoaded(false);
          setRetry((n) => n + 1);
        } else if (src) onOpen(src, nat?.w ?? m.w, nat?.h ?? m.h);
      }}
    >
      {!loaded && !err && (
        <div className={s.imgLoading}>
          <BusyIndicator size={28} />
        </div>
      )}
      {err && (
        <div className={s.imgError}>
          <Icon name="image-missing" size={16} color={mine ? "var(--th-bubble-own-meta-fg)" : "var(--th-bubble-other-meta-fg)"} />
          <span style={{ color: mine ? "var(--th-bubble-own-meta-fg)" : "var(--th-bubble-other-meta-fg)" }}>Couldn't load this image — click to try again</span>
        </div>
      )}
      {src && !err && (
        // GPU.md §2.6: an animated GIF / WebP plays ≤ 3 loops or 15 s while focused + in view, then rests on its first
        // frame (a click opens the lightbox, a hover replays)
        <AnimatedImage
          key={retry}
          src={src}
          mime={m.mimetype}
          alt={m.name}
          draggable={false}
          clickPlays={false}
          style={{ opacity: loaded ? 1 : 0 }}
          onReady={(w, h) => {
            setLoaded(true);
            if (!known) setNat({ w, h });
          }}
          onError={() => setErr(true)}
        />
      )}
    </div>
  );
}

export function VideoCard({ m, maxW }: { m: MediaRef; maxW: number }) {
  const [state, setState] = useState<"poster" | "loading" | "playing">("poster");
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(m.w && m.h ? { w: m.w, h: m.h } : null);
  const vref = useRef<HTMLVideoElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => () => {
    if (url && !m.localUrl) URL.revokeObjectURL(url);
  }, [url, m.localUrl]);
  const w = Math.max(220, maxW);
  const h = state === "playing" ? (dims ? Math.max(120, Math.min(360, Math.round((w * dims.h) / dims.w))) : 220) : 96;
  const play = async () => {
    setState("loading");
    try {
      const b = m.localUrl ? null : await mediaBlob(m);
      if (!alive.current) return; // left the room meanwhile — no URL to leak
      setUrl(m.localUrl ?? URL.createObjectURL(b!));
      setState("playing");
    } catch {
      setState("poster");
    }
  };
  const meta = state === "loading" ? "Downloading…" : [fmtSize(m.size), m.duration ? fmtDuration(m.duration) : ""].filter(Boolean).join("  ·  ");
  return (
    <div className={s.videoCard} style={{ width: w, height: h }}>
      {state === "playing" && url ? (
        <video
          ref={vref}
          className={s.videoEl}
          src={url}
          autoPlay
          playsInline
          onLoadedMetadata={(e) => setDims({ w: e.currentTarget.videoWidth || 16, h: e.currentTarget.videoHeight || 9 })}
          onClick={(e) => {
            e.stopPropagation();
            const v = e.currentTarget;
            if (v.paused) void v.play();
            else v.pause();
          }}
        />
      ) : (
        <div className={s.posterRow}>
          <Icon name="video-x-generic" size={32} color="var(--th-bubble-video-icon)" />
          <div className={s.fileCol}>
            <span className={s.fileName}>{elideMiddle(m.name, 60)}</span>
            {meta && <span className={s.fileMeta}>{meta}</span>}
          </div>
          <ToolButton iconName="media-playback-start" tip="Play here" disabled={state === "loading"} onClick={(e) => (e.stopPropagation(), void play())} />
          <ToolButton iconName="document-save-symbolic" tip="Save as…" onClick={(e) => (e.stopPropagation(), void saveMedia(m))} />
        </div>
      )}
    </div>
  );
}

export function elideMiddle(t: string, max: number): string {
  if (t.length <= max) return t;
  const half = Math.floor((max - 1) / 2);
  return t.slice(0, half) + "…" + t.slice(t.length - half);
}

export function FileCard({ m, maxW, mine }: { m: MediaRef; maxW: number; mine: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={cx(s.fileCard, mine && s.fileCardMine)} style={{ width: Math.max(220, maxW) }}>
      <Icon name={fileGlyph(m.mimetype, m.name)} size={32} color={mine ? "var(--th-bubble-own-file-icon)" : "var(--th-bubble-other-file-icon)"} />
      <div className={s.fileCol}>
        <span className={s.fileName} title={m.name}>
          {elideMiddle(m.name, 60)}
        </span>
        {m.size > 0 && <span className={s.fileMeta}>{fmtSize(m.size)}</span>}
      </div>
      {busy && <BusyIndicator size={18} />}
      <ToolButton
        iconName="document-open-symbolic"
        tip={busy ? "Opening…" : "Open"}
        disabled={busy}
        onClick={async (e) => {
          e.stopPropagation();
          setBusy(true);
          await openMedia(m);
          setBusy(false);
        }}
      />
      <ToolButton iconName="document-save-symbolic" tip="Save as…" onClick={(e) => (e.stopPropagation(), void saveMedia(m))} />
    </div>
  );
}

export const BIG_AUDIO = 8 * 1024 * 1024;

export function AudioPlayer({ m, maxW, mine }: { m: MediaRef; maxW: number; mine: boolean }) {
  const src = useMediaUrl(m, true, 0);
  const a = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(m.duration ? m.duration / 1000 : 0);
  return (
    <div className={s.audio} style={{ width: Math.max(220, maxW) }} onClick={(e) => e.stopPropagation()}>
      <div className={s.audioRow}>
        <ToolButton
          iconName={playing ? "media-playback-pause" : "media-playback-start"}
          tip={playing ? "Pause" : "Play"}
          disabled={!src}
          onClick={() => {
            const el = a.current;
            if (!el) return;
            if (el.paused) void el.play();
            else el.pause();
          }}
        />
        <Slider
          className={s.audioSlider}
          value={pos}
          from={0}
          to={dur || 1}
          onMoved={(v) => {
            if (a.current) a.current.currentTime = v;
            setPos(v);
          }}
          aria-label="Seek"
        />
        <span className={s.audioTime} style={mine ? { color: "var(--th-bubble-own-meta-fg)" } : undefined}>
          {fmtDuration(pos, true)} / {fmtDuration(dur, true)}
        </span>
      </div>
      <span className={s.audioName} style={mine ? { color: "var(--th-bubble-own-meta-fg)" } : undefined}>
        {m.name}
      </span>
      {src && (
        <audio
          ref={a}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
        />
      )}
    </div>
  );
}

export function AudioChip({ m, mine }: { m: MediaRef; mine: boolean }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, busy ? "Opening…" : "Download & open");
  const col = mine ? "var(--th-bubble-own-link-fg)" : "var(--th-bubble-other-link-fg)";
  return (
    <span
      ref={ref}
      className={s.audioChip}
      style={{ color: col }}
      onClick={async (e) => {
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        await openMedia(m);
        setBusy(false);
      }}
    >
      <Icon name="audio-x-generic" size={16} color={col} />
      <u>{m.name}</u>
      {busy && <span>  — opening…</span>}
    </span>
  );
}
