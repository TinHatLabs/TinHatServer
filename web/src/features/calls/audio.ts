// audio.ts — what we HEAR: the shared AudioContext, one gain stage per remote audio track
// (native call.rs:114-268 per-track volume elements), per-person × category prefs (audio_prefs.rs),
// output-device routing (AudioContext.setSinkId, element fallback), level taps (tile waveform bars,
// the hear analyzer's 10 ms envelopes) and the speaker meter.
//
// Composition (spec §3.11): gain = userPref(identity, category) × cornerFactor; muted = userMute ‖
// layerMuted ‖ deafened ‖ away. Everything is recomputed from flags, so releasing deafen/BRB can
// never un-mute a per-person mute set meanwhile (the native "ownership rule").
import { getPref, setPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import type { CallCategory } from "./contract";
import { clamp, errText, mxidOf } from "./util";
import { setUiSink } from "@/core/sounds";
import { AudioClock, TAP_SRC, type Stamp } from "./envclock";

const log = createLogger("call-audio");

// ---- per-person prefs (audio_prefs.rs) ------------------------------------------------------------

interface PrefEntry {
  volume: number;
  muted: boolean;
}
type PrefMap = Record<string, PrefEntry>;

function readPrefs(): PrefMap {
  const v = getPref<Record<string, unknown>>("audio_prefs", {});
  return v && typeof v === "object" ? (v as PrefMap) : {};
}

let prefs: PrefMap = readPrefs();
const live = new Map<string, number>(); // pushVolume (drag) values not yet persisted

function prefFor(identity: string, category: CallCategory): PrefEntry | undefined {
  return prefs[`${category}_${identity}`] ?? prefs[`${category}_${mxidOf(identity)}`];
}

export function volumeFor(identity: string, category: CallCategory): number {
  const l = live.get(`${category}_${identity}`) ?? live.get(`${category}_${mxidOf(identity)}`);
  const v = l ?? prefFor(identity, category)?.volume ?? 1;
  return Number.isFinite(v) ? clamp(v, 0, 2) : 1;
}

export function mutedFor(identity: string, category: CallCategory): boolean {
  return prefFor(identity, category)?.muted === true;
}

/** Prefs are saved per bare mxid so they follow the person across devices (native uses the user id). */
function keyFor(identity: string, category: CallCategory) {
  return `${category}_${mxidOf(identity)}`;
}

export function setVolume(identity: string, category: CallCategory, v: number): void {
  const k = keyFor(identity, category);
  live.delete(k);
  const cur = prefs[k] ?? { volume: 1, muted: false };
  prefs = { ...prefs, [k]: { ...cur, volume: clamp(Number.isFinite(v) ? v : 1, 0, 2) } };
  setPref("audio_prefs", prefs);
  reapply();
}

export function pushVolume(identity: string, category: CallCategory, v: number): void {
  live.set(keyFor(identity, category), clamp(Number.isFinite(v) ? v : 1, 0, 2));
  reapply();
}

export function setMuted(identity: string, category: CallCategory, muted: boolean): void {
  const k = keyFor(identity, category);
  const cur = prefs[k] ?? { volume: 1, muted: false };
  prefs = { ...prefs, [k]: { ...cur, muted } };
  setPref("audio_prefs", prefs);
  reapply();
}

export function reloadPrefs(): void {
  prefs = readPrefs();
  live.clear();
  reapply();
}

// ---- context + graph ----------------------------------------------------------------------------------

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let outAnalyser: AnalyserNode | null = null;
let fallbackEl: HTMLAudioElement | null = null;
let workletReady: Promise<boolean> | null = null;

// The level tap's worklet source is envclock.ts TAP_SRC (frames on the context's sample grid, posted with their end).

// GPU.md §2.10 (E3): the call's context runs only while something uses it — remote audio, a level tap (the mic
// meter, heard-by), the output monitor. After a call (and after the last monitor) it is suspended (it ran until the
// tab closed); the next use resumes it (audioContext()). A suspend WE made reads as "none" to the resume logic and is
// not undone by the next click (resumeAudio).
let idleByUs = false;
/** the engine's level loop sleeps through silence; a loud remote frame wakes it (GPU.md §2.7) */
let levelWake: (raw: number) => void = () => undefined;
export function setLevelWake(f: (raw: number) => void): void {
  levelWake = f;
}
let openTaps = 0;
/** Nothing needs the context any more: suspend it (the engine calls this after a call and when a monitor stops). */
export function idleContext(): void {
  if (!ctx || ctx.state !== "running" || remotes.size > 0 || openTaps > 0) return;
  idleByUs = true;
  const c = ctx;
  void c
    .suspend()
    .catch(() => void (idleByUs = false))
    .finally(() => {
      // used again while the suspend was in flight (audioContext() cleared idleByUs while the state still read
      // "running", so it could not resume then): run it now
      if (!idleByUs && ctx === c && c.state !== "running" && c.state !== "closed") void c.resume().catch(() => undefined);
    });
}

export function audioContext(): AudioContext {
  idleByUs = false;
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    master = ctx.createGain();
    outAnalyser = ctx.createAnalyser();
    outAnalyser.fftSize = 1024;
    master.connect(outAnalyser);
    master.connect(ctx.destination);
    const url = URL.createObjectURL(new Blob([TAP_SRC], { type: "text/javascript" }));
    workletReady = ctx.audioWorklet
      .addModule(url)
      .then(() => true)
      .catch((e) => {
        log.warn(`level tap worklet unavailable: ${errText(e)}`);
        return false;
      });
    void applyOutputDevice();
  }
  if (stalled(ctx)) void ctx.resume().catch(() => undefined);
  return ctx;
}

/** Not playing but resumable: "suspended", or WebKit's "interrupted" (iOS app switch, a phone call). */
function stalled(c: AudioContext | null): c is AudioContext {
  return !!c && c.state !== "running" && c.state !== "closed";
}

export function resumeAudio(): void {
  if (idleByUs) return;
  if (stalled(ctx)) void ctx.resume().catch(() => undefined);
}

// A call joined without a user gesture (guest hand-off, auto-rejoin after a reload) starts with a
// suspended AudioContext: the first click / key press anywhere lets it play.
if (typeof window !== "undefined") {
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, resumeAudio, { capture: true, passive: true });
}

// One mapping of a context's audio clock to the wall clock, shared by all of its taps (envclock.ts): what we send and
// what we receive put the same audio instant on the same tick, whatever the main thread's delivery jitter.
const tapClocks = new WeakMap<AudioContext, AudioClock>();
/** Where a tapped batch of `n` frames whose last one ends at context sample `end` goes (envclock.ts; null = drop it). */
function frameStamp(c: AudioContext, end: number, n: number): Stamp | null {
  let clock = tapClocks.get(c);
  if (!clock) tapClocks.set(c, (clock = new AudioClock()));
  // the context's own pairing of its clock with performance.now() (getOutputTimestamp); else currentTime, now
  const ts = typeof c.getOutputTimestamp === "function" ? c.getOutputTimestamp() : undefined;
  const ctxT = ts?.contextTime, perfT = ts?.performanceTime;
  const paired = typeof ctxT === "number" && typeof perfT === "number" && perfT > 0;
  const audioMs = paired ? ctxT * 1000 : c.currentTime * 1000;
  const wallMs = paired ? Date.now() - (performance.now() - perfT) : Date.now();
  // frames end on the context's 10 ms grid (TAP_SRC; within a sample): snap to it, so every frame has the same phase
  const was = clock.epoch;
  const s = clock.stamp(Math.round((end * 100) / c.sampleRate) * 10, n, audioMs, wallMs, c.currentTime * 1000);
  if (clock.epoch !== was) noteClockEpoch(paired);
  return s;
}
// How often the tap clock starts a new timeline (each costs the echo check ~16 s of refill): one line per 10 s at most.
let epochLog = { at: 0, n: 0 };
function noteClockEpoch(paired: boolean): void {
  epochLog.n++;
  const now = Date.now();
  if (now - epochLog.at < 10000) return;
  log.info(`[hear] echo clock: new timeline (${paired ? "output timestamp" : "currentTime"} reading > 50 ms off; ${epochLog.n} since the last line)`);
  epochLog = { at: now, n: 0 };
}

/** A 10 ms RMS envelope tap on a MediaStreamTrack; `onFrames` gets batches of linear RMS values and, from the worklet,
 *  where the batch's last frame goes (envclock.ts Stamp; null = from an older clock epoch, not placeable; undefined from
 *  the analyser fallback). */
export interface Tap {
  close(): void;
  node: AudioNode | null;
}

export async function tapTrack(track: MediaStreamTrack, onFrames: (frames: number[], stamp?: Stamp | null) => void, via?: AudioNode): Promise<Tap> {
  const c = audioContext();
  const ok = await (workletReady ?? Promise.resolve(false));
  const src = via ?? c.createMediaStreamSource(new MediaStream([track]));
  if (!ok) {
    // Fallback: an AnalyserNode polled every 50 ms (one "frame" per poll).
    const an = c.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const t = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let acc = 0;
      for (const v of buf) acc += v * v;
      const r = Math.sqrt(acc / buf.length);
      onFrames([r, r, r, r, r]);
    }, 50);
    openTaps++;
    let open = true;
    return {
      node: an,
      close() {
        if (open) openTaps = Math.max(0, openTaps - 1);
        open = false;
        clearInterval(t);
        try {
          src.disconnect(an);
        } catch {
          /* gone */
        }
      },
    };
  }
  const node = new AudioWorkletNode(c, "tw-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<{ f: number[]; end: number }>) => onFrames(e.data.f, frameStamp(c, e.data.end, e.data.f.length));
  src.connect(node);
  openTaps++;
  let open = true;
  return {
    node,
    close() {
      if (open) openTaps = Math.max(0, openTaps - 1);
      open = false;
      node.port.onmessage = null;
      try {
        src.disconnect(node);
      } catch {
        /* gone */
      }
    },
  };
}

// ---- remote tracks ---------------------------------------------------------------------------------------

export interface RemoteAudio {
  sid: string;
  identity: string;
  category: CallCategory;
  track: MediaStreamTrack;
  el: HTMLAudioElement;
  src: MediaStreamAudioSourceNode;
  gain: GainNode;
  tap: Tap | null;
  level: number; // smoothed linear rms
  lastFrames: number[]; // recent 10 ms frames (dBFS) for the hear analyzer
  lastFrameAt: number;
  subscribedAt: number;
}

export const remotes = new Map<string, RemoteAudio>();

/** Policy callbacks (engine): corner factor, layer mute, deafen/away cut. */
export interface Policy {
  cornerFactor(identity: string, category: CallCategory): number;
  layerMuted(identity: string, category: CallCategory, sid: string): boolean;
  cut(): boolean; // deafened ‖ away
}
let policy: Policy = { cornerFactor: () => 1, layerMuted: () => false, cut: () => false };
export function setPolicy(p: Policy): void {
  policy = p;
  reapply();
}

export function effectiveGain(r: { identity: string; category: CallCategory; sid: string }): number {
  const muted = mutedFor(r.identity, r.category) || policy.layerMuted(r.identity, r.category, r.sid) || policy.cut();
  return muted ? 0 : volumeFor(r.identity, r.category) * policy.cornerFactor(r.identity, r.category);
}

export function reapply(): void {
  if (!ctx) return;
  for (const r of remotes.values()) {
    const g = effectiveGain(r);
    r.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.015);
  }
}

export function addRemote(sid: string, identity: string, category: CallCategory, track: MediaStreamTrack, onFrames?: (r: RemoteAudio, f: number[], stamp?: Stamp | null) => void): RemoteAudio {
  removeRemote(sid);
  const c = audioContext();
  // Chromium only feeds a remote WebRTC stream into WebAudio while a media element plays it. That (muted) element
  // also decides which device Chromium's echo canceller listens to, so it starts on the call's output — before
  // it plays, because the page's WebRTC audio renderer takes its device when it starts (AEC-WEB.md).
  const el = new Audio();
  el.muted = true;
  el.srcObject = new MediaStream([track]);
  const sink = outSink;
  const start = () => {
    if (remotes.get(sid)?.el === el) void el.play().catch(() => undefined);
  };
  if (sink) {
    // Never let a hung setSinkId keep the stream from flowing: after 1.5 s play anyway. The request stays queued;
    // when it completes the renderer switches and Chromium moves the canceller's reference with it.
    const t = setTimeout(() => {
      log.warn("[aec] stream element: setSinkId still pending after 1.5 s — playing anyway");
      start();
    }, 1500);
    void sinkElement(el, sink)
      .catch((e) => {
        // the mix is on `sink` but this element isn't: re-apply, which moves EVERYTHING to the default if it fails again
        log.warn(`[aec] stream element → output device: ${errText(e)} — re-applying the output`);
        if (outSink === sink) void applyOutputDevice();
      })
      .finally(() => {
        clearTimeout(t);
        start();
      });
  } else void el.play().catch(() => undefined);
  const src = c.createMediaStreamSource(new MediaStream([track]));
  const gain = c.createGain();
  gain.gain.value = 0;
  src.connect(gain);
  gain.connect(master!);
  const r: RemoteAudio = { sid, identity, category, track, el, src, gain, tap: null, level: 0, lastFrames: [], lastFrameAt: 0, subscribedAt: Date.now() };
  remotes.set(sid, r);
  frameSinks.set(sid, onFrames);
  gain.gain.value = effectiveGain(r);
  void tapTrack(track, (frames, stamp) => {
    let m = 0;
    for (const f of frames) m = Math.max(m, f);
    r.level = Math.max(m, r.level * 0.7);
    r.lastFrameAt = Date.now();
    levelWake(m);
    onFrames?.(r, frames, stamp);
  }, src).then((t) => {
    if (remotes.get(sid) === r) r.tap = t;
    else t.close();
  });
  log.info(`audio ${category} from ${identity} (${sid}) → gain ${gain.gain.value.toFixed(2)}`);
  return r;
}

// ---- playback healer (CALL-57: repair at 1 / 3 / 9 s, then every 30 s; call.rs:300-360) ------------------------

const heals = new Map<string, { step: number; timer: ReturnType<typeof setTimeout> | null }>();
const HEAL_LADDER = [1000, 3000, 9000];

/** The hear analyzer saw bytes arriving but no frames reaching our graph: resume + rebuild on a ladder. */
export function noteStalled(sid: string): void {
  if (heals.has(sid)) return;
  const st = { step: 0, timer: null as ReturnType<typeof setTimeout> | null };
  heals.set(sid, st);
  const run = () => {
    const r = remotes.get(sid);
    if (!r || heals.get(sid) !== st) return;
    if (r.lastFrameAt && Date.now() - r.lastFrameAt < 1500 && !contextSuspended()) {
      heals.delete(sid);
      log.info(`[play-heal] ${r.identity} ${r.category} recovered`);
      return;
    }
    resumeAudio();
    void r.el.play().catch(() => undefined);
    if (st.step >= 1) {
      log.info(`[play-heal] ${r.identity} ${r.category}: rebuild ${st.step}`);
      rebuild(sid);
    }
    const d = st.step < HEAL_LADDER.length ? HEAL_LADDER[st.step] : 30000;
    st.step++;
    st.timer = setTimeout(run, d);
  };
  st.timer = setTimeout(run, HEAL_LADDER[0]);
}

function clearHeal(sid: string) {
  const h = heals.get(sid);
  if (h?.timer) clearTimeout(h.timer);
  heals.delete(sid);
}

export function contextSuspended(): boolean {
  return !!ctx && !idleByUs && ctx.state !== "running";
}

export function removeRemote(sid: string): void {
  clearHeal(sid);
  frameSinks.delete(sid);
  const r = remotes.get(sid);
  if (!r) return;
  remotes.delete(sid);
  r.tap?.close();
  try {
    r.src.disconnect();
    r.gain.disconnect();
  } catch {
    /* gone */
  }
  r.el.srcObject = null;
}

export function clearRemotes(): void {
  for (const sid of [...remotes.keys()]) removeRemote(sid);
  live.clear(); // an abandoned slider drag never outlives the call
}

const frameSinks = new Map<string, ((r: RemoteAudio, f: number[], stamp?: Stamp | null) => void) | undefined>();

function rebuild(sid: string): boolean {
  const r = remotes.get(sid);
  if (!r) return false;
  const h = heals.get(sid);
  heals.delete(sid); // keep the ladder running across the rebuild
  addRemote(sid, r.identity, r.category, r.track, frameSinks.get(sid));
  if (h) heals.set(sid, h);
  return true;
}

/** Re-create one remote's playback path (the tile's "click to repair"). */
export function repairRemote(sid: string): boolean {
  clearHeal(sid);
  return rebuild(sid);
}

// ---- output device -----------------------------------------------------------------------------------------
//
// Echo cancellation hangs on this (src/features/calls/AEC-WEB.md). Chromium's canceller (Chrome-wide AEC in the
// audio service: Chrome / Edge / Brave on Windows, macOS and Linux) subtracts what the browser plays on ONE output
// device, and that device is whichever sink was set LAST by either
//   * an AudioContext whose sink CHANGES (constructor `sinkId` or setSinkId), or
//   * the page's single shared WebRTC audio renderer = the sinkId of the remote-track media elements, taken when
//     the renderer starts (the first remote track after a join) or switches.
// The call mix plays through the AudioContext; the muted elements only keep the streams flowing. They used to stay
// on the default device, so a Speaker picked BEFORE joining (context setSinkId first, renderer start later) left
// the canceller listening to the default device while the call played on the picked one: no reference, the peer
// heard their whole voice back (measured 0.2 dB removed vs 75 dB — tools/calls-aec-gate.sh). A live pick mid-call
// happened to work, because then the context wrote last.
// Rule: the mix (AudioContext or its fallback element), every remote element and every follower
// (followCallOutput) are ALWAYS on one device — both writers name the same sink, so the order can't matter.

type SinkCtx = AudioContext & { setSinkId?: (id: string | { type: "none" }) => Promise<void> };
type SinkEl = HTMLMediaElement & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };

/** The device the call plays on ("" = system default); set synchronously when a change starts. */
let outSink = "";
let outTok = 0;
const followers = new Set<WeakRef<HTMLMediaElement>>();

export function outputRoutingSupported(): boolean {
  return typeof (AudioContext.prototype as SinkCtx).setSinkId === "function" || typeof (HTMLMediaElement.prototype as SinkEl).setSinkId === "function";
}

const sinkOps = new WeakMap<HTMLMediaElement, Promise<void>>();

/**
 * setSinkId, serialised per element: each change starts only after the previous one settled and compares with the
 * sink the element really has THEN. (`sinkId` only changes when a request completes, so an unserialised rollback
 * to the default could skip an element whose switch to the pick was still pending — which then lands on the pick
 * alone: the no-reference split again. Astra review 2026-09-23.)
 */
function sinkElement(el: HTMLMediaElement, id: string): Promise<void> {
  const e = el as SinkEl;
  if (typeof e.setSinkId !== "function") return Promise.resolve();
  const prev = sinkOps.get(el) ?? Promise.resolve();
  const op = prev
    .catch(() => undefined)
    .then(() => ((e.sinkId ?? "") === id ? undefined : e.setSinkId!(id)));
  sinkOps.set(el, op);
  return op;
}

/** Where the call mix itself plays: AudioContext.setSinkId, else an element fed from a MediaStreamDestination. */
async function routeMix(id: string): Promise<void> {
  if (!ctx || !master) return;
  const c = ctx as SinkCtx;
  if (typeof c.setSinkId === "function") {
    await c.setSinkId(id);
    return;
  }
  if (!id) {
    if (fallbackEl) await sinkElement(fallbackEl, "");
    return;
  }
  if (typeof (HTMLMediaElement.prototype as SinkEl).setSinkId !== "function") return;
  if (!fallbackEl) {
    const dest = ctx.createMediaStreamDestination();
    master.disconnect(ctx.destination);
    master.connect(dest);
    fallbackEl = new Audio();
    fallbackEl.srcObject = dest.stream;
    void fallbackEl.play().catch(() => undefined);
  }
  await sinkElement(fallbackEl, id);
}

/**
 * Keep one of our own media elements on the call's output (the soundboard's local copy of a clip): sound played
 * on another device is not in the canceller's reference, so it would come back through the mic. Register the element
 * BEFORE it gets a source: Chromium loads a source that arrives while setSinkId is still pending on the old device
 * (measured: the soundboard's first clip played on the default while the call was on the pick).
 */
export function followCallOutput(el: HTMLMediaElement): void {
  for (const w of followers) if (w.deref() === el) return;
  followers.add(new WeakRef(el));
  void sinkElement(el, outSink).catch((e) => log.warn(`[aec] follower → output device: ${errText(e)}`));
}

function syncFollowers(id: string) {
  setUiSink(id); // REACH A5.8: the local sounds' Web Audio context (the soundboard's local copy) follows too
  for (const w of [...followers]) {
    const el = w.deref();
    if (!el) followers.delete(w);
    else void sinkElement(el, id).catch((e) => log.warn(`[aec] follower → output device: ${errText(e)}`));
  }
}

export async function applyOutputDevice(): Promise<void> {
  const want = getPref("call-output", "");
  const id = want && want !== "default" ? want : "";
  const tok = ++outTok;
  outSink = id; // remote elements created from now on start on it
  if (!ctx || !master) {
    syncFollowers(id);
    return;
  }
  const els = () => [...remotes.values()].map((r) => r.el);
  try {
    await routeMix(id);
    if (tok !== outTok) return; // a newer pick owns the sinks now
    await Promise.all(els().map((el) => sinkElement(el, id)));
    if (tok !== outTok) return;
    syncFollowers(id);
    log.info(`[aec] call output = ${id ? "picked device" : "system default"} (mix + ${remotes.size} stream element(s) + ${followers.size} follower(s))`);
  } catch (e) {
    if (tok !== outTok) return;
    log.warn(`output device ${id}: ${errText(e)} — falling back to the default`);
    outSink = "";
    // all back on the default TOGETHER — a half-moved call is exactly the no-reference case. A newer pick that
    // starts meanwhile owns the sinks: stop writing (per-element order keeps its requests after ours).
    await routeMix("").catch(() => undefined);
    if (tok !== outTok) return;
    await Promise.all(els().map((el) => sinkElement(el, "").catch(() => undefined)));
    if (tok !== outTok) return;
    syncFollowers("");
  }
}

/** Speaker meter: rms of everything Tin Hat plays (0..1). */
export function outputLevel(): number {
  if (!outAnalyser) return 0;
  const buf = new Float32Array(outAnalyser.fftSize);
  outAnalyser.getFloatTimeDomainData(buf);
  let acc = 0;
  for (const v of buf) acc += v * v;
  return Math.sqrt(acc / buf.length);
}

export function masterNode(): GainNode {
  audioContext();
  return master!;
}

// ---- back from the background (iOS: interrupted context, paused elements) -----------------------------------
//
// iOS suspends the page on an app switch; its AudioContext comes back "interrupted" / "suspended" — or says
// "running" and renders nothing — and may only start again inside a tap. resume.ts drives these.

/** Resume the context and every helper element (iOS pauses media elements in the background). */
export function kickPlayback(): void {
  resumeAudio();
  if (fallbackEl?.paused) void fallbackEl.play().catch(() => undefined);
  for (const r of remotes.values()) if (r.el.paused) void r.el.play().catch(() => undefined);
}

export function contextState(): string {
  return idleByUs ? "none" : (ctx?.state ?? "none");
}

let ctxGen = 0;
/** Bumps when the context is replaced: a producer that started in the old one checks it before publishing. */
export function contextGen(): number {
  return ctxGen;
}

/** Does the context actually render (its clock moves)? null = no context, or it was replaced meanwhile. */
export async function contextRendering(ms = 400): Promise<boolean | null> {
  const c = ctx;
  if (!c || c.state === "closed") return null;
  const t0 = c.currentTime;
  await new Promise((r) => setTimeout(r, ms));
  if (ctx !== c) return null;
  return c.currentTime > t0;
}

const replacedCbs = new Set<() => void>();
/** The context was replaced — taps living in the old one must be rebuilt (the engine's mic meter). */
export function onContextReplaced(cb: () => void): () => void {
  replacedCbs.add(cb);
  return () => replacedCbs.delete(cb);
}

/**
 * Throw the context away and rebuild every remote path in a new one. Inside a tap this is what gets iOS
 * playing again when resume() doesn't (a context created in a user gesture may start).
 */
export function recreateContext(why: string): void {
  const old = ctx;
  log.warn(`[audio] new AudioContext (${why}); the old one was ${old?.state ?? "none"}`);
  ctxGen++;
  ctx = null;
  master = null;
  outAnalyser = null;
  workletReady = null;
  if (fallbackEl) {
    fallbackEl.srcObject = null;
    fallbackEl = null;
  }
  audioContext();
  for (const sid of [...remotes.keys()]) rebuild(sid);
  reapply();
  for (const cb of replacedCbs) {
    try {
      cb();
    } catch (e) {
      log.warn(`context replaced hook: ${errText(e)}`);
    }
  }
  void old?.close().catch(() => undefined);
}
