// mic.ts — microphone capture options + the "Strong" noise suppression processor (RNNoise WASM
// AudioWorklet, @sapphi-red/web-noise-suppressor, MIT; DECISIONS D11). Browser NS is turned off
// while Strong runs; Standard = the browser's own noiseSuppression constraint.
import type { AudioCaptureOptions, AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { getPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import type { CallState } from "./contract";
import { errText } from "./util";

const log = createLogger("call-mic");

export function buildMicOptions(st: Pick<CallState, "micAec" | "micAgc" | "micNsMode">): AudioCaptureOptions {
  const dev = getPref("call-input", "");
  return {
    deviceId: dev ? { ideal: dev } : undefined,
    echoCancellation: st.micAec,
    autoGainControl: st.micAgc,
    noiseSuppression: st.micNsMode === "standard",
    channelCount: 1,
  };
}

let wasm: Promise<ArrayBuffer> | null = null;
let nsCtx: AudioContext | null = null;
let workletLoaded: Promise<void> | null = null;

function rnnoiseBinary(): Promise<ArrayBuffer> {
  if (!wasm) {
    wasm = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((e) => {
      wasm = null;
      throw e;
    });
  }
  return wasm;
}

/** RNNoise needs 48 kHz: its own context (the processed track is handed to livekit as a plain track). */
function ctx48(): AudioContext {
  if (!nsCtx || nsCtx.state === "closed") {
    nsCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    workletLoaded = null;
  }
  if (nsCtx.state !== "running") void nsCtx.resume().catch(() => undefined); // (WebKit: also "interrupted")
  return nsCtx;
}

// GPU.md §2.10 (E1): the 48 kHz context runs only while a Strong processor uses it. The "Strong (not installed)"
// probe 5 s after start used to leave it running for good — an audio render thread busy ≈ 85 ms/min in every idle
// state, hidden included. It is suspended after the probe and when the last processor goes; ctx48() resumes it.
let activeNs = 0;
function idleNs(): void {
  if (activeNs !== 0 || !nsCtx || nsCtx.state !== "running") return;
  const c = nsCtx;
  void c
    .suspend()
    .catch(() => undefined)
    .finally(() => {
      // a Strong processor started while the suspend was in flight (ctx48() saw "running" and did not resume): run it
      if (activeNs > 0 && nsCtx === c && c.state !== "running" && c.state !== "closed") void c.resume().catch(() => undefined);
    });
}

/** "Strong" runs the mic through its own context: after an iOS app switch it must be resumed too, or the
 *  call gets silence from us. "none" = Strong is not running (never ran, or idle and suspended by design). */
export function nsContextState(): string {
  return activeNs === 0 ? "none" : (nsCtx?.state ?? "none");
}

export function resumeNsContext(): void {
  if (activeNs === 0) return;
  if (nsCtx && nsCtx.state !== "running" && nsCtx.state !== "closed") void nsCtx.resume().catch(() => undefined);
}

/** Replace a context that won't start with a new one made RIGHT NOW — call inside the tap (iOS lets a
 *  context start only there); the mic re-publish that follows builds its processor in it. */
export function freshNsContext(): void {
  const old = nsCtx;
  nsCtx = null;
  workletLoaded = null;
  ctx48();
  void old?.close().catch(() => undefined);
}

/** Try to load the worklet + WASM (Settings shows "Strong (not installed)" when this fails). */
export async function rnnoiseAvailable(): Promise<boolean> {
  try {
    const c = ctx48();
    if (!workletLoaded) workletLoaded = c.audioWorklet.addModule(rnnoiseWorkletUrl);
    await workletLoaded;
    await rnnoiseBinary();
    return true;
  } catch (e) {
    log.warn(`RNNoise not available: ${errText(e)}`);
    workletLoaded = null;
    return false;
  } finally {
    idleNs(); // the probe: nothing runs through it yet (a processor's init resumes it)
  }
}

class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "tinhat-rnnoise";
  processedTrack?: MediaStreamTrack;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: RnnoiseWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private counted = false;

  async init(opts: AudioProcessorOptions): Promise<void> {
    // counted from the start: a probe's idle suspend landing meanwhile must see that the context is wanted
    if (!this.counted) {
      this.counted = true;
      activeNs++;
    }
    try {
      const c = ctx48();
      if (!workletLoaded) workletLoaded = c.audioWorklet.addModule(rnnoiseWorkletUrl);
      await workletLoaded;
      const bin = await rnnoiseBinary();
      this.src = c.createMediaStreamSource(new MediaStream([opts.track]));
      this.node = new RnnoiseWorkletNode(c, { maxChannels: 1, wasmBinary: bin });
      this.dest = c.createMediaStreamDestination();
      this.dest.channelCount = 1;
      this.src.connect(this.node);
      this.node.connect(this.dest);
      this.processedTrack = this.dest.stream.getAudioTracks()[0];
      log.info("RNNoise (Strong) running on the mic");
    } catch (e) {
      // a failed start holds nothing: uncount it (the context may go idle again)
      if (this.counted) {
        this.counted = false;
        activeNs = Math.max(0, activeNs - 1);
        idleNs();
      }
      throw e;
    }
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.node?.destroy();
    } catch {
      /* gone */
    }
    this.processedTrack?.stop();
    this.src = null;
    this.node = null;
    this.dest = null;
    this.processedTrack = undefined;
    if (this.counted) {
      this.counted = false;
      activeNs = Math.max(0, activeNs - 1);
      idleNs();
    }
  }
}

export async function micProcessorFor(mode: string): Promise<TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> | null> {
  if (mode !== "strong") return null;
  if (!(await rnnoiseAvailable())) throw new Error("RNNoise could not be loaded");
  return new RnnoiseProcessor();
}
