// callbridge.ts — the Audio / Calls panes read and drive the call engine ONLY through
// `@/features/calls` (typed by contract.ts). Until the engine implements a field/action (the
// phase-1 stub has only the shell block), each accessor falls back to the same native pref key the
// engine persists (calls-engine.md §3.17) and to a local device enumeration + mic level monitor,
// so the panes work stand-alone and hand over to the engine transparently.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCallStore } from "@/features/calls";
import type { CallStore, Dev } from "@/features/calls/contract";
import { getPref, setPref, usePref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { onWinState, winFocused } from "@/core/winstate";
import { WAVE_TICK_MS } from "@/core/lowgpu";

const log = createLogger("settings-audio");

type Engine = Partial<CallStore>;

// INTEGRATION #10: the call store changes at ~15 Hz (levels, speakers, stats). Every hook below
// subscribes to exactly the fields it reads (shallow-compared), so a pane re-renders only when one of
// ITS values changes; the level meters subscribe on their own (EngineLevelMeter).

/** Narrow engine read (shallow-compared). */
export function useEngineSel<T>(pick: (s: Engine) => T): T {
  return useCallStore(useShallow((s: CallStore) => pick(s as unknown as Engine)));
}

/** The slow-changing call facts the panes show (in a call? connection-test text). */
export function useEngine(): { inCall: boolean; connTest: string } {
  return useEngineSel((e) => ({ inCall: !!e.inCall, connTest: e.connTest ?? "" }));
}

function engine(): Engine {
  return useCallStore.getState() as unknown as Engine;
}

/** Call an engine action when it exists; returns false when the engine lacks it. */
export function act<K extends keyof CallStore>(name: K, ...args: unknown[]): boolean {
  const fn = engine()[name];
  if (typeof fn === "function") {
    (fn as (...a: unknown[]) => unknown)(...args);
    return true;
  }
  return false;
}

// ---- local device enumeration (fallback) -----------------------------------------------------

interface LocalDevs {
  inputs: Dev[];
  outputs: Dev[];
  cameras: Dev[];
}
let localDevs: LocalDevs = { inputs: [], outputs: [], cameras: [] };
const devListeners = new Set<() => void>();

export async function enumerateLocal(): Promise<void> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind: MediaDeviceKind, fallback: string): Dev[] =>
      all
        .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
        .map((d, i) => ({ id: d.deviceId, name: d.label || `${fallback} ${i + 1}` }));
    localDevs = { inputs: pick("audioinput", "Microphone"), outputs: pick("audiooutput", "Speaker"), cameras: pick("videoinput", "Camera") };
    for (const l of devListeners) l();
  } catch (e) {
    log.debug("enumerateDevices", e);
  }
}

if (typeof navigator !== "undefined" && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => void enumerateLocal());
}

function useLocalDevs(): LocalDevs {
  return useSyncExternalStore(
    (cb) => {
      devListeners.add(cb);
      return () => devListeners.delete(cb);
    },
    () => localDevs,
  );
}

export interface DeviceLists {
  inputs: Dev[];
  outputs: Dev[];
  cameras: Dev[];
  inputId: string;
  outputId: string;
  cameraId: string;
}

export function useDeviceLists(): DeviceLists {
  const e = useEngineSel((x) => ({
    inputs: x.inputs,
    outputs: x.outputs,
    cameras: x.cameras,
    inputName: x.inputName,
    outputName: x.outputName,
    cameraName: x.cameraName,
  }));
  const local = useLocalDevs();
  const inPref = usePref("call-input", "");
  const outPref = usePref("call-output", "");
  const camPref = usePref("call-camera", "");
  return {
    inputs: e.inputs?.length ? e.inputs : local.inputs,
    outputs: e.outputs?.length ? e.outputs : local.outputs,
    cameras: e.cameras?.length ? e.cameras : local.cameras,
    inputId: e.inputName ?? inPref,
    outputId: e.outputName ?? outPref,
    cameraId: e.cameraName ?? camPref,
  };
}

/** The engine reports the selection as `inputName` / `outputName` / … — match an id OR a label. */
export function sameDev(d: Dev, sel: string): boolean {
  return !!sel && (d.id === sel || d.name === sel);
}

export function refreshDeviceLists(): void {
  const a = act("refreshInputs");
  act("refreshOutputs");
  act("refreshCameras");
  if (!a || !engine().inputs?.length) void enumerateLocal();
}

export function setInput(id: string): void {
  if (!act("setInput", id)) setPref("call-input", id);
  if (localMon.running) void startLocalMonitor();
}
export function setOutput(id: string): void {
  if (!act("setOutput", id)) setPref("call-output", id);
}
export function setCamera(id: string): void {
  if (!act("setCamera", id)) setPref("call-camera", id);
}

/** HTMLMediaElement.setSinkId exists (Chromium / Edge / Firefox 116+ behind a pref). */
export const canPickOutput: boolean = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

// ---- mic DSP / PTT / quality (engine or pref) ------------------------------------------------

export function useMicDsp() {
  const e = useEngineSel((x) => ({
    micAec: x.micAec,
    micAgc: x.micAgc,
    micNsMode: x.micNsMode,
    ncAvailable: x.ncAvailable,
    ecDegraded: x.ecDegraded,
    ecNote: x.ecNote,
  }));
  const aec = usePref("mic-echo-cancel", "1");
  const agc = usePref("mic-agc", "1");
  const ns = usePref("mic-ns-mode", "off");
  return {
    aec: e.micAec ?? aec !== "0",
    agc: e.micAgc ?? agc !== "0",
    ns: (e.micNsMode ?? (ns === "standard" || ns === "strong" ? ns : "off")) as "off" | "standard" | "strong",
    ncAvailable: e.ncAvailable ?? false,
    ecDegraded: e.ecDegraded ?? false,
    ecNote: e.ecNote ?? "",
  };
}

export function applyAec(on: boolean) {
  if (!act("applyMicAec", on)) setPref("mic-echo-cancel", on ? "1" : "0");
  if (localMon.running) void startLocalMonitor();
}
export function applyAgc(on: boolean) {
  if (!act("applyMicAgc", on)) setPref("mic-agc", on ? "1" : "0");
  if (localMon.running) void startLocalMonitor();
}
export function applyNs(mode: "off" | "standard" | "strong") {
  if (!act("applyMicNsMode", mode)) setPref("mic-ns-mode", mode);
  if (localMon.running) void startLocalMonitor();
}

export function usePushToTalk(): boolean {
  const e = useEngineSel((x) => ({ pushToTalk: x.pushToTalk }));
  const p = usePref("push-to-talk", "0");
  return e.pushToTalk ?? p === "1";
}
export function applyPushToTalk(on: boolean) {
  if (!act("applyPushToTalk", on)) setPref("push-to-talk", on ? "1" : "0");
}

export function useQualities() {
  const e = useEngineSel((x) => ({ shareQuality: x.shareQuality, camQuality: x.camQuality, recvQuality: x.recvQuality }));
  const share = usePref("share-quality", "");
  const cam = usePref("cam-quality", "");
  const recv = usePref("recv-quality", "auto");
  return {
    shareQuality: e.shareQuality || share || "1920 1080 30 12000 nvenc",
    camQuality: e.camQuality || cam || "1280 720 30 2500 1",
    recvQuality: (e.recvQuality ?? recv) as "auto" | "high" | "medium" | "low",
  };
}

function patchQuality(key: string, def: string, idx: number, val: string) {
  const parts = (getPref(key, "") || def).split(/\s+/);
  while (parts.length < 5) parts.push(def.split(/\s+/)[parts.length]);
  parts[idx] = val;
  setPref(key, parts.join(" "));
}

export function applyShareQuality(w: number, h: number, fps: number, kbps: number) {
  if (act("applyShareQuality", w, h, fps, kbps)) return;
  const enc = (getPref("share-quality", "") || "1920 1080 30 12000 nvenc").split(/\s+/)[4] ?? "nvenc";
  setPref("share-quality", `${w} ${h} ${fps} ${kbps} ${enc}`);
}
export function applyShareEncoder(code: number) {
  if (act("applyShareEncoder", String(code))) return;
  patchQuality("share-quality", "1920 1080 30 12000 nvenc", 4, code === 1 ? "vp9" : "nvenc");
}
export function applyCamQuality(w: number, h: number, fps: number, kbps: number) {
  if (act("applyCamQuality", w, h, fps, kbps)) return;
  const sim = (getPref("cam-quality", "") || "1280 720 30 2500 1").split(/\s+/)[4] ?? "1";
  setPref("cam-quality", `${w} ${h} ${fps} ${kbps} ${sim}`);
}
export function applyCamSimulcast(on: boolean) {
  if (act("applyCamSimulcast", on)) return;
  patchQuality("cam-quality", "1280 720 30 2500 1", 4, on ? "1" : "0");
}
export function applyRecvQuality(q: "auto" | "high" | "medium" | "low") {
  if (!act("applyRecvQuality", q)) setPref("recv-quality", q);
}

// ---- share-audio source ----------------------------------------------------------------------

export const TAB_AUDIO_ID = "browser";

export function useShareSource(): { sources: Dev[]; current: string } {
  const e = useEngineSel((x) => ({ audioSources: x.audioSources, musicSourceName: x.musicSourceName }));
  const p = usePref("music-source", "");
  const sources = e.audioSources?.length ? e.audioSources : [{ id: TAB_AUDIO_ID, name: "Tab or system audio (asked when you start)" }];
  return { sources, current: e.musicSourceName ?? p };
}
export function setShareSource(id: string) {
  if (!act("startMusicSource", id)) setPref("music-source", id);
}

// ---- level meters ----------------------------------------------------------------------------

interface LocalMon {
  running: boolean;
  wanted: boolean;
  level: number;
  pre: number;
  stream: MediaStream | null;
  ctx: AudioContext | null;
  raf: number;
}
const localMon: LocalMon = { running: false, wanted: false, level: 0, pre: 0, stream: null, ctx: null, raf: 0 };
let localMonStop: (() => void) | null = null;
const monListeners = new Set<() => void>();
const emitMon = () => monListeners.forEach((l) => l());
let monSnap = { running: false, level: 0, pre: 0 };

function rms(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

function stopLocalTracks() {
  localMonStop?.();
  localMonStop = null;
  localMon.stream?.getTracks().forEach((t) => t.stop());
  void localMon.ctx?.close().catch(() => undefined);
  localMon.stream = null;
  localMon.ctx = null;
}

/** Standalone mic monitor (native startMicMonitor): pre = raw, level = with the chosen DSP. */
let monGen = 0;

async function startLocalMonitor(): Promise<void> {
  localMon.wanted = true;
  stopLocalTracks();
  const gen = ++monGen; // a newer start (device/DSP change, StrictMode re-run) supersedes this one
  try {
    const id = getPref("call-input", "");
    const dsp = {
      echoCancellation: getPref("mic-echo-cancel", "1") !== "0",
      autoGainControl: getPref("mic-agc", "1") !== "0",
      noiseSuppression: getPref("mic-ns-mode", "off") !== "off",
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), ...dsp } });
    if (!localMon.wanted || gen !== monGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    void enumerateLocal(); // labels appear once permission is granted
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    localMon.stream = stream;
    localMon.ctx = ctx;
    localMon.running = true;
    // GPU.md §2.7/§2.8: sampled every 100 ms while the window is focused (it was every animation frame) and not at all
    // while it isn't — the meter shows its rest pose then (ui/meter.ts); the stream stays open
    const tick = () => {
      const v = Math.min(1, rms(an, buf) * 2.2);
      localMon.level = v;
      localMon.pre = v;
      monSnap = { running: true, level: v, pre: v };
      emitMon();
    };
    let t: ReturnType<typeof setInterval> | 0 = 0;
    const arm = () => {
      if (t) clearInterval(t);
      t = 0;
      if (winFocused()) {
        tick();
        t = setInterval(tick, WAVE_TICK_MS);
      }
    };
    const off = onWinState(arm);
    localMonStop = () => {
      off();
      if (t) clearInterval(t);
      t = 0;
    };
    arm();
  } catch (e) {
    log.info("mic monitor could not start", (e as Error)?.message ?? e);
    localMon.running = false;
    monSnap = { running: false, level: 0, pre: 0 };
    emitMon();
  }
}

function stopLocalMonitor() {
  localMon.wanted = false;
  localMon.running = false;
  stopLocalTracks();
  monSnap = { running: false, level: 0, pre: 0 };
  emitMon();
}

// Held, not toggled: the Audio pane and the noise-test sheet both watch the mic, and since the Settings window
// (2026-09-29) the pane stays open under the sheet — closing the sheet must not stop the pane's meter. The monitor starts
// with the first holder and stops with the last.
let micHolds = 0;
let outHolds = 0;
export function startMicMonitor(): void {
  if (micHolds++ > 0) return;
  if (!act("startMicMonitor")) void startLocalMonitor();
}
export function stopMicMonitor(): void {
  if (micHolds === 0 || --micHolds > 0) return;
  if (!act("stopMicMonitor")) stopLocalMonitor();
}
export function startOutputMonitor(): void {
  if (outHolds++ > 0) return;
  act("startOutputMonitor");
}
export function stopOutputMonitor(): void {
  if (outHolds === 0 || --outHolds > 0) return;
  act("stopOutputMonitor");
}

function useLocalMon() {
  return useSyncExternalStore(
    (cb) => {
      monListeners.add(cb);
      return () => monListeners.delete(cb);
    },
    () => monSnap,
  );
}

const engineHasMon = () => typeof engine().startMicMonitor === "function";

/** Is the mic monitor delivering? (engine: !micSilent; else the local monitor). Changes rarely. */
export function useMicRunning(): boolean {
  const silent = useEngineSel((x) => ({ micSilent: !!x.micSilent, has: typeof x.startMicMonitor === "function" }));
  const local = useLocalMon();
  return silent.has ? !silent.micSilent : local.running;
}

/** Can the output be watched? Changes rarely. */
export function useOutRunning(): boolean {
  const o = useEngineSel((x) => ({ has: typeof x.startOutputMonitor === "function", missing: !!x.outputMissing }));
  return o.has && !o.missing;
}

/** One level (0..1) — used only inside the meters, so the 15 Hz updates re-render the meter alone. */
export function useLevel(which: "mic" | "pre" | "out"): number {
  const eng = useCallStore((s) => (which === "mic" ? s.micLevel : which === "pre" ? s.micLevelPre : s.outputLevel) ?? 0);
  const local = useLocalMon();
  if (which === "out") return eng;
  return engineHasMon() ? eng : which === "mic" ? local.level : local.pre;
}

/** (The LevelMeter's smoothing lives in ui/meter.ts useMeter since the low-GPU contract, GPU.md §2.7.) */
