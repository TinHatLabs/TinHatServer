// watchparty/player.tsx — the watch-party player (native: libmpv + yt-dlp). Web backends:
//   • YouTube (youtube.com / youtu.be / shorts / embed / live / music): the youtube-nocookie embed driven over the
//     IFrame Player API's postMessage protocol by ytframe.ts — YouTube's own script never runs in this page (security
//     review 2026-10-26); controls hidden — the window's transport is the only control (like mpv);
//   • <video> for direct media URLs (mp4/webm/ogg/m3u8-in-Safari…);
//   • anything else → a clear failure (yt-dlp-only sites can't play in a browser).
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { sameOrigin } from "../shared/clip";
import { YT_BUFFERING, YT_ENDED, YT_PLAYING, YtFramePlayer } from "./ytframe";

export interface WatchPlayerHandle {
  load(url: string): void;
  stop(): void;
  play(): void;
  pause(): void;
  seek(secs: number): void;
  time(): number;
  duration(): number;
  /** player is paused/unstarted although asked to play (autoplay blocked?) */
  isPaused(): boolean;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
}

export interface WatchPlayerProps {
  onEnded: () => void;
  onError: (msg: string) => void;
  /** a frame / position was produced (clears the load watchdog) */
  onPlaying: () => void;
  /** 11.4: the player is waiting for data (YouTube state 3 / <video> waiting) — the window shows a spinner */
  onBuffering?: (buffering: boolean) => void;
  className?: string;
}

/** YouTube IFrame error codes → what to tell the person (DESIGN §2.3 "real error text"). */
export function youTubeErrorText(code: number): string {
  switch (code) {
    case 2:
      return "This YouTube link is not a valid video.";
    case 5:
      return "YouTube's player couldn't play this video in the browser.";
    case 100:
      return "This video was removed or is private.";
    case 101:
    case 150:
      return "This video doesn't allow playback outside YouTube — open it in YouTube.";
  }
  return `YouTube couldn't play this video (error ${code}).`;
}

/** <video> MediaError codes → text. */
export function mediaErrorText(v: HTMLVideoElement | null): string {
  const c = v?.error?.code ?? 0;
  switch (c) {
    case 1:
      return "Playback was stopped.";
    case 2:
      return "The download failed — a network problem.";
    case 3:
      return "This file couldn't be decoded in the browser.";
    case 4:
      return "This link isn't a media file the browser can play.";
  }
  return "Playback failed — couldn't load this video.";
}

// ---- URL classification ---------------------------------------------------------------------------

export function youTubeId(url: string): { id: string; start: number } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
  const t = u.searchParams.get("t") ?? u.searchParams.get("start") ?? "";
  const start = parseTimeParam(t);
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return id ? { id, start } : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      return id ? { id, start } : null;
    }
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,})/);
    if (m) return { id: m[1], start };
  }
  return null;
}

function parseTimeParam(t: string): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function isDirectMedia(url: string): boolean {
  return /^(https?:|blob:|\/)/.test(url) && /\.(mp4|m4v|webm|ogv|ogg|mov|mp3|m4a|opus|wav|flac|m3u8)(\?|#|$)/i.test(url);
}

/** The YouTube player surface player.tsx drives (ytframe.ts YtFramePlayer). */
type YTPlayer = YtFramePlayer;

// ---- the surface ---------------------------------------------------------------------------------------

export const WatchPlayer = forwardRef<WatchPlayerHandle, WatchPlayerProps>(function WatchPlayer({ onEnded, onError, onPlaying, onBuffering, className }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const yt = useRef<YTPlayer | null>(null);
  const ytReady = useRef(false);
  const ytHolder = useRef<HTMLDivElement | null>(null);
  const kind = useRef<"none" | "yt" | "video">("none");
  const pending = useRef<{ id: string; start: number } | null>(null);
  const vol = useRef({ v: 100, muted: false });
  const cb = useRef({ onEnded, onError, onPlaying, onBuffering });
  cb.current = { onEnded, onError, onPlaying, onBuffering };
  const wantPlay = useRef(true);

  useEffect(
    () => () => {
      try {
        yt.current?.destroy();
      } catch {
        /* gone */
      }
      yt.current = null;
    },
    [],
  );

  const ensureYt = async (): Promise<void> => {
    if (yt.current || !host.current) return;
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;inset:0;";
    const inner = document.createElement("div");
    holder.appendChild(inner);
    host.current.appendChild(holder);
    ytHolder.current = holder;
    ytReady.current = false;
    yt.current = new YtFramePlayer(inner, {
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          ytReady.current = true;
          const p = yt.current!;
          p.setVolume(vol.current.v);
          if (vol.current.muted) p.mute();
          else p.unMute();
          const pd = pending.current;
          if (pd) {
            pending.current = null;
            p.loadVideoById({ videoId: pd.id, startSeconds: pd.start });
            if (!wantPlay.current) setTimeout(() => p.pauseVideo(), 0);
          }
        },
        onStateChange: (e: { data: number }) => {
          cb.current.onBuffering?.(e.data === YT_BUFFERING);
          if (e.data === YT_ENDED) cb.current.onEnded();
          else if (e.data === YT_PLAYING) cb.current.onPlaying();
        },
        onError: (e: { data: number }) => {
          cb.current.onBuffering?.(false);
          cb.current.onError(youTubeErrorText(e.data));
        },
      },
    });
  };

  useImperativeHandle(
    ref,
    (): WatchPlayerHandle => ({
      load(url: string) {
        const y = youTubeId(url);
        if (y) {
          if (video.current) {
            video.current.pause();
            video.current.removeAttribute("src");
            video.current.load();
          }
          kind.current = "yt";
          if (ytHolder.current) ytHolder.current.style.display = "";
          if (yt.current && ytReady.current) {
            yt.current.loadVideoById({ videoId: y.id, startSeconds: y.start });
          } else {
            pending.current = y;
            ensureYt().catch((e) => cb.current.onError(String((e as Error)?.message ?? e)));
          }
          return;
        }
        if (isDirectMedia(url)) {
          kind.current = "video";
          if (yt.current && ytReady.current) yt.current.stopVideo();
          if (ytHolder.current) ytHolder.current.style.display = "none";
          const v = video.current!;
          // an absolute Tin Hat API URL (the hub's hosts) plays through this origin's /api
          v.src = sameOrigin(url);
          v.volume = vol.current.v / 100;
          v.muted = vol.current.muted;
          if (wantPlay.current) void v.play().catch(() => {});
          return;
        }
        kind.current = "none";
        cb.current.onError("This link can't play in the browser — open it in the Tin Hat app, or pick a YouTube video.");
      },
      stop() {
        kind.current = "none";
        pending.current = null;
        if (yt.current && ytReady.current) yt.current.stopVideo();
        if (video.current) {
          video.current.pause();
          video.current.removeAttribute("src");
          video.current.load();
        }
      },
      play() {
        wantPlay.current = true;
        if (kind.current === "yt" && yt.current && ytReady.current) yt.current.playVideo();
        else if (kind.current === "video") void video.current?.play().catch(() => {});
      },
      pause() {
        wantPlay.current = false;
        if (kind.current === "yt" && yt.current && ytReady.current) yt.current.pauseVideo();
        else if (kind.current === "video") video.current?.pause();
      },
      seek(secs: number) {
        if (kind.current === "yt" && yt.current && ytReady.current) yt.current.seekTo(secs, true);
        else if (kind.current === "yt" && pending.current) pending.current.start = secs;
        else if (kind.current === "video" && video.current) video.current.currentTime = secs;
      },
      time() {
        if (kind.current === "yt" && yt.current && ytReady.current) return yt.current.getCurrentTime() || 0;
        if (kind.current === "video" && video.current) return video.current.currentTime || 0;
        return 0;
      },
      duration() {
        if (kind.current === "yt" && yt.current && ytReady.current) return yt.current.getDuration() || 0;
        if (kind.current === "video" && video.current) {
          const d = video.current.duration;
          return Number.isFinite(d) ? d : 0;
        }
        return 0;
      },
      isPaused() {
        if (kind.current === "yt" && yt.current && ytReady.current) {
          const st = yt.current.getPlayerState();
          return st !== YT_PLAYING && st !== 3; /* buffering counts as trying */
        }
        if (kind.current === "video" && video.current) return video.current.paused;
        return false;
      },
      setVolume(v: number) {
        vol.current.v = v;
        if (yt.current && ytReady.current) yt.current.setVolume(v);
        if (video.current) video.current.volume = Math.max(0, Math.min(1, v / 100));
      },
      setMuted(m: boolean) {
        vol.current.muted = m;
        if (yt.current && ytReady.current) {
          if (m) yt.current.mute();
          else yt.current.unMute();
        }
        if (video.current) video.current.muted = m;
      },
    }),
    [],
  );

  return (
    <div ref={host} className={className} style={{ position: "absolute", inset: 0 }}>
      <video
        ref={video}
        playsInline
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "var(--th-watchparty-video-bg)", display: "block" }}
        onEnded={() => cb.current.onEnded()}
        onPlaying={() => {
          cb.current.onBuffering?.(false);
          cb.current.onPlaying();
        }}
        onWaiting={() => cb.current.onBuffering?.(true)}
        onStalled={() => cb.current.onBuffering?.(true)}
        onCanPlay={() => cb.current.onBuffering?.(false)}
        onTimeUpdate={(e) => {
          if (e.currentTarget.currentTime > 0) cb.current.onPlaying();
        }}
        onError={(e) => {
          cb.current.onBuffering?.(false);
          if (e.currentTarget.getAttribute("src")) cb.current.onError(mediaErrorText(e.currentTarget));
        }}
      />
      {/* YouTube's iframe is appended here by the API */}
    </div>
  );
});
