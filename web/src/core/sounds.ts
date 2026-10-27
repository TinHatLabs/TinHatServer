// sounds.ts — the native UI sounds (AppCore.qml playUiSound / playCallChime / previewSound /
// startRing / stopRing / muted cue), played locally from public/sounds/<theme>/<slot>.mp3.
//
//   playUiSound("send" | "receive" | "notify")   // prefs snd.<kind> ("0" = off), notify variant
//   playCallChime("join" | "leave")              // remote peer joined/left (pref snd.callchime)
//   playMutedCue()                               // 10.5 talking-while-muted (pref snd.mutedtalk = "1")
//   startRing() / stopRing()                     // incoming call (pref snd.ring + snd.ring.variant)
//   previewSound("notify-3")                     // Settings previews; clicking the playing one stops it
//   setCallAudioSession(true|false)              // REACH §4: "auto" right before a call, "ambient" after
//   playClip(url | blob, {channel, maxMs, onEnded}) → ClipHandle   // A5.8: join-sound previews, the profile
//                                                // card's join sound, the soundboard's local playback
//   setUiSink(deviceId)                          // the calls engine: local sounds play where the call plays
//
// Volumes: every channel uses snd.volume (0..100, default 70) like the native (the QML base
// volumes 0.7/0.85 are overwritten with sndVolume() before each play). The sound PACK is its own setting since 11.0
// (THEMES-SYNC.md §1, THEMES-UI.md §11: Settings → Appearance → Sounds and icons): the theme store mirrors the pack in
// use into pref "sound-pack" ("default" | "goose"; without it — a 10.x device before the store ran — Goose's theme
// still means Goose's sounds). Goose ships its own join/leave and takes the default (oled/) files for every other slot
// (assets.rs).
//
// REACH §4 (web only, docs/WEB-EXCEPTIONS.md): ONE Web Audio AudioContext plays every UI sound — decoded
// buffers cached per URL, one gain node at snd.volume, the ring a looping buffer source — and no <audio>
// element is ever made for a UI sound: on iOS each media element registers as media playback (Now Playing,
// the Dynamic Island). Where navigator.audioSession exists (Safari) its type is "ambient" while no call is
// active (a chime mixes with other audio and never claims Now Playing), "auto" right before a call joins
// and "ambient" again after it ends. Browsers only allow audio after a user gesture: the context is made
// (or resumed — iOS suspends it on an app switch) on a gesture, and a sound asked for before the first
// gesture is dropped silently.
import { getPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { apiAuthHeaders } from "@/core/api";

const log = createLogger("sounds");

export type UiSoundKind = "send" | "receive" | "notify";
export type ChimeKind = "join" | "leave";

/** The slots the Goose pack ships itself; every other slot plays the default pack's file. */
const GOOSE_OWN = new Set(["join", "leave"]);

export const SOUND_FILES = [
  "join",
  "leave",
  "send",
  "receive",
  "notify",
  "notify-2",
  "notify-3",
  "notify-4",
  "ring",
  "ring-2",
  "muted",
] as const;

/** The sound pack in use: pref "sound-pack" (the theme store's mirror), else the 10.x rule (the Goose theme). */
export function soundPack(): "default" | "goose" {
  const p = getPref("sound-pack", "");
  if (p) return p === "goose" ? "goose" : "default";
  return getPref("theme", "oled") === "goose" ? "goose" : "default";
}

/** URL of a sound slot in a pack (relative to the app base, so it works at / and /next/). "oled" = the default pack
 *  (its folder name). */
export function soundUrl(file: string, pack: string = soundPack()): string {
  const dir = pack === "goose" && GOOSE_OWN.has(file) ? "goose" : "oled";
  return `${import.meta.env.BASE_URL}sounds/${dir}/${file}.mp3`;
}

/** snd.<key> !== "0" (default on). */
export function sndOn(key: string): boolean {
  return getPref(`snd.${key}`, "") !== "0";
}

/** "" | "-2" | "-3" | "-4" from snd.<key>.variant. */
export function sndVariant(key: string): string {
  const v = getPref(`snd.${key}.variant`, "");
  return v === "2" || v === "3" || v === "4" ? `-${v}` : "";
}

/** 0..1 from snd.volume (default 70). */
export function sndVolume(): number {
  const v = parseInt(getPref("snd.volume", ""), 10);
  return (Number.isNaN(v) ? 70 : Math.max(0, Math.min(100, v))) / 100;
}

// ---- the audio session (Safari's navigator.audioSession) ----------------------------------------------------------

type SessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";
interface AudioSessionLike {
  type: SessionType;
}

function audioSession(): AudioSessionLike | null {
  if (typeof navigator === "undefined") return null;
  return ((navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession ?? null) as AudioSessionLike | null;
}

let callSession = false;

function applySession(): void {
  const as = audioSession();
  if (!as) return;
  const want: SessionType = callSession ? "auto" : "ambient";
  try {
    if (as.type !== want) as.type = want;
  } catch (e) {
    log.debug(`audioSession.type = ${want}: ${(e as Error)?.message ?? e}`);
  }
}

/** The calls engine: true right before a call joins (inside the click), false once the call is fully over. */
export function setCallAudioSession(active: boolean): void {
  callSession = active;
  applySession();
}

/** The type the page asked for last (tests / diagnostics). */
export function audioSessionType(): string {
  return audioSession()?.type ?? "unsupported";
}

// ---- one AudioContext --------------------------------------------------------------------------------------------

type Channel = "ui" | "chime" | "ring" | "clip" | "preview";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let gestured = false;
const voices: Record<Channel, AudioBufferSourceNode | null> = { ui: null, chime: null, ring: null, clip: null, preview: null };
const tokens: Record<Channel, number> = { ui: 0, chime: 0, ring: 0, clip: 0, preview: 0 };
let uiSink = "";

type SinkCtx = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** The calls engine (audio.ts followers): local sounds play on the call's output device — the soundboard's
 *  local copy must sit inside the echo canceller's reference (calls/AEC-WEB.md). "" = the system default. */
export function setUiSink(id: string): void {
  uiSink = id;
  const c = ctx as SinkCtx | null;
  if (c?.setSinkId) void c.setSinkId(id).catch((e: unknown) => log.debug(`setSinkId: ${(e as Error)?.message ?? e}`));
}
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let previewFile = "";
let previewSrc: AudioBufferSourceNode | null = null;

type Ctor = typeof AudioContext;
function contextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  return (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext ?? null) as Ctor | null;
}

/** The context, made on the first gesture (never before — the unlock rule). */
function context(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx;
  if (!gestured) return null;
  const C = contextCtor();
  if (!C) return null;
  try {
    ctx = new C({ latencyHint: "interactive" });
    master = ctx.createGain();
    master.connect(ctx.destination);
    buffers.clear(); // decoded for a context that is gone
    clipBuffers.clear();
    if (uiSink) setUiSink(uiSink);
  } catch (e) {
    log.warn(`no AudioContext: ${(e as Error)?.message ?? e}`);
    ctx = null;
    master = null;
  }
  return ctx;
}

const running = (c: AudioContext) => c.state === "running";

// GPU.md §2.10 (E2): the context's audio render thread runs only while a sound plays — 5 s after the last voice ended
// it is suspended (it ran from the first click until the tab closed); a sound resumes it (startOn: a context started
// by a gesture once may resume without one, Chromium and WebKit alike). A suspend WE made is not undone by the next
// click; an iOS "interrupted" / system-suspended one still is (onGesture).
const IDLE_SUSPEND_MS = 5000;
let idleTimer: ReturnType<typeof setTimeout> | 0 = 0;
let idleSuspended = false;
/** the suspend in flight: its state reads "running" until it lands, so a sound starting meanwhile waits for it */
let suspending: Promise<void> | null = null;
function anyVoice(): boolean {
  return Object.values(voices).some((v) => !!v);
}
function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = 0;
    const c = ctx;
    if (!c || anyVoice() || !running(c)) return;
    idleSuspended = true;
    const p = c.suspend().catch(() => void (idleSuspended = false));
    suspending = p;
    void p.finally(() => {
      if (suspending === p) suspending = null;
      // a sound that started while the suspend was in flight is never left in a stopped context
      if (anyVoice() && ctx === c && !running(c)) {
        idleSuspended = false;
        void c.resume().catch(() => undefined);
      }
    });
  }, IDLE_SUSPEND_MS);
}
function cancelIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = 0;
  idleSuspended = false;
}

/** A gesture: make the context, or resume one iOS suspended / interrupted (app switch, a phone call). */
function onGesture(): void {
  const first = !gestured;
  gestured = true;
  applySession();
  const c = context();
  if (c && !running(c) && !idleSuspended) void c.resume().catch(() => undefined);
  if (first && c) {
    preload();
    scheduleIdle();
  }
}

if (typeof window !== "undefined") {
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, onGesture, { capture: true, passive: true });
  applySession(); // "ambient" from the start: no call yet
}

function load(url: string): Promise<AudioBuffer | null> {
  let p = buffers.get(url);
  if (!p) {
    p = (async () => {
      const c = context();
      if (!c) return null;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await c.decodeAudioData(await res.arrayBuffer());
    })().catch((e: unknown) => {
      log.debug(`load ${url}: ${(e as Error)?.message ?? e}`);
      buffers.delete(url); // try again next time
      return null;
    });
    buffers.set(url, p);
  }
  return p;
}

/** Decode the everyday slots once the context exists (the first chime then starts without a fetch). */
function preload(): void {
  for (const f of ["send", "receive", `notify${sndVariant("notify")}`, "join", "leave", `ring${sndVariant("ring")}`]) void load(soundUrl(f));
}

function stopVoice(ch: Channel): void {
  tokens[ch]++;
  const v = voices[ch];
  voices[ch] = null;
  if (!v) return;
  stopHooks.get(v)?.();
  if (v === previewSrc) previewSrc = null;
  try {
    v.stop();
  } catch {
    /* not started / already stopped */
  }
  try {
    v.disconnect();
  } catch {
    /* gone */
  }
}

/** Play `url` on a channel (one voice each, like the native MediaPlayers: a new sound cuts the old one). */
async function play(ch: Channel, url: string, opts: { loop?: boolean; preview?: string } = {}): Promise<void> {
  await startOn(ch, () => load(url), url, opts);
}

interface Started {
  src: AudioBufferSourceNode;
  startedAt: number;
  duration: number;
}

/** The shared start: stop the channel's voice, make sure the context runs, decode, start. */
async function startOn(
  ch: Channel,
  getBuf: () => Promise<AudioBuffer | null>,
  what: string,
  opts: { loop?: boolean; preview?: string; maxMs?: number; volume?: number; onEnded?: () => void } = {},
): Promise<Started | null> {
  const c = context();
  if (!c) return null; // before the first gesture: dropped silently
  stopVoice(ch);
  const my = tokens[ch];
  applySession();
  cancelIdle();
  if (suspending) await suspending; // (then the resume below starts it again)
  // (a sound that does not start leaves the context idle again)
  const bail = (): null => {
    if (!anyVoice()) scheduleIdle();
    return null;
  };
  if (!running(c)) {
    // resumable (suspended / iOS "interrupted"): only a sound that can start now is worth playing
    await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
    if (!running(c) || my !== tokens[ch]) return bail();
  }
  const buf = await getBuf();
  if (!buf || my !== tokens[ch] || ctx !== c || !master) return bail();
  // suspended / interrupted while it was loading (iOS app switch, a phone call): a start now would be queued
  // in the stopped context and play at some later gesture — drop it (web review #19)
  if (!running(c)) return bail();
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = !!opts.loop;
  let out: AudioNode = master;
  master.gain.value = sndVolume();
  if (opts.volume !== undefined) {
    // a clip at its own level (the soundboard's local copy is not a UI chime)
    const g = c.createGain();
    g.gain.value = opts.volume;
    g.connect(c.destination);
    out = g;
  }
  src.connect(out);
  let stopped = false;
  src.onended = () => {
    if (voices[ch] === src) voices[ch] = null;
    if (!anyVoice()) scheduleIdle();
    if (previewSrc === src) {
      previewSrc = null;
      previewFile = "";
    }
    if (out !== master)
      try {
        out.disconnect();
      } catch {
        /* gone */
      }
    if (!stopped) opts.onEnded?.();
  };
  voices[ch] = src;
  if (opts.preview) {
    previewSrc = src;
    previewFile = opts.preview;
  }
  const startedAt = c.currentTime;
  try {
    src.start();
    if (opts.maxMs) src.stop(startedAt + opts.maxMs / 1000);
  } catch (e) {
    log.debug(`start ${what}: ${(e as Error)?.message ?? e}`);
    return bail();
  }
  // stopVoice() marks the handle as stopped (no onEnded for a stop the caller asked for)
  stopHooks.set(src, () => (stopped = true));
  return { src, startedAt, duration: buf.duration };
}

const stopHooks = new WeakMap<AudioBufferSourceNode, () => void>();

// ---- clips (A5.8): join-sound previews, the profile card's join sound, the soundboard's local copy ----------------

export interface ClipHandle {
  /** seconds */
  readonly duration: number;
  /** seconds since it started */
  position(): number;
  isPlaying(): boolean;
  stop(): void;
}

const clipBuffers = new Map<string, Promise<AudioBuffer | null>>();

function loadClip(url: string): Promise<AudioBuffer | null> {
  if (!url) return Promise.resolve(null); // a refused sound (core/clipurl.ts) never fetches anything
  let p = clipBuffers.get(url);
  if (!p) {
    p = (async () => {
      const c = context();
      if (!c) return null;
      // the server's clip cache fetches a sound it hasn't cached yet only for a member's bearer (docs/API.md, 0.3.4):
      // apiAuthHeaders adds it for this origin's /api clip routes only (core/apiauth.ts)
      const res = await fetch(url, { headers: apiAuthHeaders(url) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await c.decodeAudioData(await res.arrayBuffer());
    })().catch((e: unknown) => {
      log.debug(`clip ${url}: ${(e as Error)?.message ?? e}`);
      clipBuffers.delete(url);
      return null;
    });
    clipBuffers.set(url, p);
    while (clipBuffers.size > 24) clipBuffers.delete(clipBuffers.keys().next().value!);
  }
  return p;
}

/**
 * Play a clip (a same-origin URL, or a Blob) through the one context — never an <audio> element (on iOS each
 * element is media playback: Now Playing, the Dynamic Island). `channel` "clip" (the soundboard's local copy,
 * one at a time) or "preview" (join-sound previews). Null when it can't start (before the first gesture, a
 * clip that won't decode).
 */
export async function playClip(src: string | Blob, opts: { channel?: "clip" | "preview"; maxMs?: number; volume?: number; onEnded?: () => void } = {}): Promise<ClipHandle | null> {
  const ch: Channel = opts.channel ?? "clip";
  const getBuf =
    typeof src === "string"
      ? () => loadClip(src)
      : async () => {
          const c = context();
          if (!c) return null;
          try {
            return await c.decodeAudioData(await src.arrayBuffer());
          } catch {
            return null;
          }
        };
  const st = await startOn(ch, getBuf, typeof src === "string" ? src : "(blob)", { maxMs: opts.maxMs, volume: opts.volume, onEnded: opts.onEnded });
  if (!st) return null;
  const c = ctx!;
  return {
    duration: opts.maxMs ? Math.min(st.duration, opts.maxMs / 1000) : st.duration,
    position: () => Math.max(0, c.currentTime - st.startedAt),
    isPlaying: () => voices[ch] === st.src,
    stop: () => {
      if (voices[ch] === st.src) stopVoice(ch);
    },
  };
}

/** Stop whatever plays on a clip channel. */
export function stopClip(channel: "clip" | "preview" = "clip"): void {
  stopVoice(channel);
}

let lastKind = "";
let lastAt = 0;

/** Message send / receive (open room) and the notification sound. Same-kind bursts < 350 ms play once. */
export function playUiSound(kind: UiSoundKind): void {
  if (!sndOn(kind)) return;
  const now = Date.now();
  if (kind === lastKind && now - lastAt < 350) return;
  lastKind = kind;
  lastAt = now;
  previewFile = "";
  void play("ui", soundUrl(kind === "notify" ? `notify${sndVariant("notify")}` : kind));
}

/** Themed chime when a REMOTE participant joins/leaves the call (local only). */
export function playCallChime(kind: ChimeKind): void {
  if (!sndOn("callchime")) return;
  void play("chime", soundUrl(kind));
}

let mutedCueAt = 0;

/** "You're talking while muted" cue — opt-in (snd.mutedtalk = "1"), at most every 10 s. */
export function playMutedCue(): void {
  if (getPref("snd.mutedtalk", "") !== "1") return;
  const now = Date.now();
  if (now - mutedCueAt <= 10000) return;
  mutedCueAt = now;
  void play("ui", soundUrl("muted"));
}

/** Settings previews on the ui channel; clicking the one that is playing stops it. */
export function previewSound(file: string): void {
  if (isPreviewing(file)) {
    stopVoice("ui");
    previewFile = "";
    return;
  }
  previewFile = file;
  void play("ui", soundUrl(file), { preview: file });
}

/** Whether a preview of `file` is currently playing (for the Settings play/stop glyph). */
export function isPreviewing(file: string): boolean {
  return previewFile === file && !!previewSrc && voices.ui === previewSrc;
}

/** Incoming-call ringtone; loops until stopRing() (the toast bounds it). */
export function startRing(): void {
  if (!sndOn("ring")) return;
  void play("ring", soundUrl(`ring${sndVariant("ring")}`), { loop: true });
}

export function stopRing(): void {
  stopVoice("ring");
}

/** QA (webshot steps): what the sound engine holds. */
export function soundsDebug() {
  return {
    context: ctx?.state ?? "none",
    gestured,
    buffers: [...buffers.keys()],
    voices: { ui: !!voices.ui, chime: !!voices.chime, ring: !!voices.ring, clip: !!voices.clip, preview: !!voices.preview },
    previewFile,
    session: audioSessionType(),
  };
}
