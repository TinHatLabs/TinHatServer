// ytframe.ts — the Media Party's YouTube player WITHOUT YouTube's script in our page (security review 2026-10-26, M3 /
// Low "YouTube IFrame API runs with full privileges"). The IFrame Player API is a loader + www-widgetapi.js from
// www.youtube.com running in the app's origin (next to the session token and the crypto store); all it does is create the
// embed iframe and talk to it over postMessage. This file speaks that same protocol itself, so the app's CSP stays
// `script-src 'self'` and the only YouTube code runs inside YouTube's own cross-origin (sandboxed) frame:
//
//   page → frame   JSON {event:"listening", id, channel:"widget"}            every 250 ms until the frame answers
//                  JSON {event:"command", func, args, id, channel:"widget"} queued until the frame's first message
//                  addEventListener(onReady | onStateChange | onError) are commands too
//   frame → page   initialDelivery {info: playerInfo}  (stops the "listening" poll) · infoDelivery {info: changed fields}
//                  onReady · onStateChange {info: state} · onError {info: code} · alreadyInitialized · readyToListen
//
// (read from www-widgetapi.js, player dce23b30, 2026-10-26). Only messages whose origin is the embed host AND whose
// source is OUR iframe AND whose id is ours are read; nothing in them is ever executed or navigated to. The pure parts
// (embed URL, message parsing, the extrapolated clock) are unit-tested in ytframe.test.ts.

export const YT_HOST = "https://www.youtube-nocookie.com";

export const YT_ENDED = 0;
export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_BUFFERING = 3;

export type YtInfo = Record<string, unknown>;

/** The embed URL the IFrame API would build: host + /embed/[videoId] + playerVars + enablejsapi/origin/widgetid. */
export function ytEmbedUrl(origin: string, id: number, playerVars: Record<string, string | number>, videoId = ""): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(playerVars)) if (k !== "enablejsapi" && k !== "origin" && k !== "widgetid") q.set(k, String(v));
  q.set("enablejsapi", "1");
  q.set("origin", origin);
  q.set("widgetid", String(id));
  const vid = /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : "";
  return `${YT_HOST}/embed/${vid}?${q}`;
}

export interface YtMessage {
  event: string;
  info: unknown;
}

/** A message from the player frame, or null when it isn't one for player `id` (wrong shape / id / not JSON). The
 *  caller has already checked the event's origin and source. */
export function parseYtMessage(data: unknown, id: number): YtMessage | null {
  if (typeof data !== "string" || data.length > 1_000_000) return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (String(o.id) !== String(id) || typeof o.event !== "string") return null;
  return { event: o.event, info: o.info };
}

/** Merge an info delivery into the player's state (own, plain fields only); a fresh currentTime gets its stamp. */
export function mergeYtInfo(into: YtInfo, info: unknown, nowSec: number): void {
  if (!info || typeof info !== "object" || Array.isArray(info)) return;
  for (const k of Object.keys(info)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    into[k] = (info as YtInfo)[k];
  }
  if ("currentTime" in info && !("currentTimeLastUpdated_" in info)) into.currentTimeLastUpdated_ = nowSec;
}

/** getCurrentTime as the IFrame API computes it: the last delivered time, moved on by at most 1 s while playing. */
export function ytCurrentTime(info: YtInfo, nowSec: number): number {
  let t = Number(info.currentTime);
  if (!Number.isFinite(t)) return 0;
  if (info.playerState === YT_PLAYING) {
    const k = (nowSec - Number(info.currentTimeLastUpdated_)) * Number(info.playbackRate ?? 1);
    if (k > 0) t += Math.min(k, 1);
  }
  return t;
}

export interface YtEvents {
  onReady?: () => void;
  onStateChange?: (e: { data: number }) => void;
  onError?: (e: { data: number }) => void;
}

let seq = 0;

/** The subset of YT.Player that player.tsx uses, over postMessage to an embed iframe that replaces `el`. */
export class YtFramePlayer {
  readonly iframe: HTMLIFrameElement;
  private readonly id = ++seq;
  private info: YtInfo = {};
  private talking = false; // the frame answered once: commands go straight out
  private readonly queue: Record<string, unknown>[] = [];
  private poll = 0;
  private readonly events: YtEvents;
  private readonly onMessage = (e: MessageEvent) => {
    if (e.origin !== YT_HOST || !this.iframe.contentWindow || e.source !== this.iframe.contentWindow) return;
    const m = parseYtMessage(e.data, this.id);
    if (!m) return;
    if (!this.talking) {
      this.talking = true;
      for (const q of this.queue.splice(0)) this.send(q);
    }
    switch (m.event) {
      case "initialDelivery":
        this.stopPolling();
        this.info = {};
        mergeYtInfo(this.info, m.info, Date.now() / 1000);
        break;
      case "infoDelivery":
        mergeYtInfo(this.info, m.info, Date.now() / 1000);
        break;
      case "alreadyInitialized":
        this.stopPolling();
        break;
      case "readyToListen":
        this.send({ event: "listening" });
        break;
      case "onReady":
        this.events.onReady?.();
        break;
      case "onStateChange":
        // (the state itself arrives with the next infoDelivery, as for the IFrame API)
        this.events.onStateChange?.({ data: Number(m.info) });
        break;
      case "onError":
        this.events.onError?.({ data: Number(m.info) });
        break;
    }
  };
  private readonly onLoad = () => this.startPolling();

  constructor(el: HTMLElement, opts: { playerVars: Record<string, string | number>; events: YtEvents; title?: string }) {
    this.events = opts.events;
    const f = document.createElement("iframe");
    f.src = ytEmbedUrl(location.origin, this.id, opts.playerVars);
    f.title = opts.title ?? "YouTube video player";
    f.setAttribute("width", "100%");
    f.setAttribute("height", "100%");
    f.setAttribute("frameborder", "0");
    f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
    // YouTube refuses embeds that send no referrer (error 153); the page itself sends none (Referrer-Policy no-referrer)
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    // its own origin anyway; the sandbox also keeps it from navigating this app's window
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox");
    f.style.cssText = "display:block;border:0;width:100%;height:100%;";
    this.iframe = f;
    window.addEventListener("message", this.onMessage);
    f.addEventListener("load", this.onLoad);
    el.replaceWith(f);
    this.startPolling();
    for (const ev of ["onReady", "onStateChange", "onError"] as const) if (opts.events[ev]) this.command("addEventListener", [ev]);
  }

  private startPolling(): void {
    this.stopPolling();
    this.poll = window.setInterval(() => {
      if (!this.iframe.contentWindow) return this.stopPolling();
      this.send({ event: "listening" });
    }, 250);
  }

  private stopPolling(): void {
    if (this.poll) window.clearInterval(this.poll);
    this.poll = 0;
  }

  private send(msg: Record<string, unknown>): void {
    const w = this.iframe.contentWindow;
    if (!w) return;
    try {
      w.postMessage(JSON.stringify({ ...msg, id: this.id, channel: "widget" }), YT_HOST);
    } catch {
      /* the frame is navigating / gone */
    }
  }

  private command(func: string, args: unknown[] = []): void {
    const msg = { event: "command", func, args };
    if (this.talking) this.send(msg);
    else this.queue.push(msg);
  }

  loadVideoById(o: { videoId: string; startSeconds?: number }): void {
    this.info = {}; // as the API does for load*/cue*: nothing of the old video is reported for the new one
    this.command("loadVideoById", [{ videoId: o.videoId, startSeconds: o.startSeconds ?? 0 }]);
  }
  playVideo(): void {
    this.command("playVideo");
  }
  pauseVideo(): void {
    this.command("pauseVideo");
  }
  stopVideo(): void {
    this.command("stopVideo");
  }
  seekTo(s: number, allowSeekAhead: boolean): void {
    this.command("seekTo", [s, allowSeekAhead]);
  }
  setVolume(v: number): void {
    this.command("setVolume", [v]);
  }
  mute(): void {
    this.command("mute");
  }
  unMute(): void {
    this.command("unMute");
  }
  getCurrentTime(): number {
    return ytCurrentTime(this.info, Date.now() / 1000);
  }
  getDuration(): number {
    const d = Number(this.info.duration);
    return Number.isFinite(d) ? d : 0;
  }
  getPlayerState(): number {
    return typeof this.info.playerState === "number" ? this.info.playerState : -1;
  }
  destroy(): void {
    this.stopPolling();
    window.removeEventListener("message", this.onMessage);
    this.iframe.removeEventListener("load", this.onLoad);
    this.iframe.remove();
  }
}
