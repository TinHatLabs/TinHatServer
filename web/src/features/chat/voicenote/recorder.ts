// recorder.ts — voice notes: the web recorder (docs/VOICE-NOTES.md §3–§4). getUserMedia (the chosen input, no echo
// cancellation, no AGC, mono; noise suppression per the user's setting: the call's RNNoise path for "Strong" with the
// browser's own suppression off, the browser's for "Standard") → AudioContext at 48 kHz (refused at any other rate) →
// the capture worklet (mono Float32 chunks) → PeakMeter (live level + waveform) + WebCodecs AudioEncoder (Opus, 48 kHz
// mono, 24 kb/s VBR, voip, 20 ms frames) → our Ogg muxer (ogg.ts). Duration and the 15-minute cap are counted from the
// samples the worklet delivered, never from a timer.
//
// The capture runs under a capture lease of its own (calls/capturelease.ts, kind "voice-note"): taken before
// getUserMedia (startUnder: check + platform call in one tick), committed with a gate, so a Watch press or a sign-out
// (leases.revoke) stops the microphone at once and the note goes to review with what was captured.
//
//   if (await voiceSupported()) { const h = await startCapture({ onProgress, onEnd }); …; const note = await h.stop(); }
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import captureWorkletUrl from "./capture.worklet.js?url";
import { getPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { leases } from "@/features/calls/engine";
import { startUnder, step } from "@/features/calls/captureflow";
import type { Lease } from "@/features/calls/capturelease";
import { micProcessorFor } from "@/features/calls/mic";
import { PeakMeter, VOICE_MAX_MS, VOICE_RATE, durationMs, waveform } from "./core";
import { DEFAULT_PRE_SKIP, muxOggOpus, preSkipOf } from "./ogg";
import { abortable, browserNoiseFallback } from "./abortable";

const log = createLogger("voice-note");

/** 15:00 at 48 kHz (43 200 000 samples). */
export const MAX_SAMPLES = (VOICE_MAX_MS * VOICE_RATE) / 1000;
/** The live strip: the last ~3 s of 10 ms frame peaks. */
export const LIVE_FRAMES = 300;
const PROGRESS_MS = 100;

export const ENCODER_CONFIG = {
  codec: "opus",
  sampleRate: VOICE_RATE,
  numberOfChannels: 1,
  bitrate: 24000,
  bitrateMode: "variable",
  opus: { format: "opus", frameDuration: 20000, application: "voip" },
} as unknown as AudioEncoderConfig;

export type VoiceErrorCode = "permission" | "nodevice" | "rate" | "start" | "busy";
export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "VoiceError";
    this.code = code;
  }
}

export interface Finished {
  blob: Blob;
  mimetype: "audio/ogg";
  /** samples captured (48 kHz) — the note's length; the Ogg end trim makes a player decode exactly these */
  samples: number;
  durationMs: number;
  peaks: number[];
  waveform: number[];
  preSkip: number;
  /** the encoder gave fewer samples than preSkip + captured (the end trim was clamped) */
  short: boolean;
}

export type EndReason = "cap" | "device" | "revoked" | "error";
export interface CaptureCallbacks {
  /** at most every 100 ms while recording: samples so far + the recent frame peaks (0..32768) */
  onProgress(p: { samples: number; recent: number[] }): void;
  /** the recording ended by itself: the cap, the device went away, a Watch press / sign-out, an encoder error. The
   *  caller then calls stop() (review with what was captured) — the capture has already stopped taking samples. */
  onEnd(reason: EndReason, detail?: string): void;
}
export interface CaptureHandle {
  /** drain the worklet, flush the encoder, write the EOS page: the finished note */
  stop(): Promise<Finished>;
  /** throw everything away (no output) */
  cancel(): void;
  samples(): number;
}

// ---- feature detection ------------------------------------------------------------------------------------------
let support: Promise<boolean> | null = null;
/** AudioEncoder with Opus (+ AudioWorklet + getUserMedia in a secure context). No → the mic button is hidden. */
export function voiceSupported(): Promise<boolean> {
  if (!support) {
    support = (async () => {
      try {
        if (typeof window === "undefined" || !window.isSecureContext) return false;
        if (typeof AudioEncoder === "undefined" || typeof AudioWorkletNode === "undefined" || typeof AudioData === "undefined") return false;
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") return false;
        const r = await AudioEncoder.isConfigSupported(ENCODER_CONFIG);
        return !!r.supported;
      } catch (e) {
        log.info(`voice notes unavailable: ${(e as Error)?.message ?? e}`);
        return false;
      }
    })();
  }
  return support;
}

function nsMode(): "off" | "standard" | "strong" {
  const v = getPref("mic-ns-mode", "off");
  return v === "standard" || v === "strong" ? v : "off";
}

function errCode(e: unknown): VoiceErrorCode {
  if (e instanceof VoiceError) return e.code;
  const n = (e as { name?: string })?.name;
  if (n === "NotAllowedError" || n === "SecurityError") return "permission";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "nodevice";
  if (n === "Revoked" || n === "StartCancelled") return "busy";
  return "start";
}

interface Pipeline {
  stream: MediaStream;
  track: MediaStreamTrack;
  src: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  proc: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> | null;
}

/** The capture itself, under its lease: the microphone (startUnder: the lease check and getUserMedia in one tick),
 *  the RNNoise processor for "Strong", the capture worklet and the one edge into it. Every resource is the lease's the
 *  moment it exists; the caller commits. */
async function openCapture(lease: Lease, ctx: AudioContext, signal?: AbortSignal): Promise<Pipeline> {
  /** cancelled while starting (the store's Cancel, a call join): what the lease holds stops now — throw */
  const live = () => {
    if (signal?.aborted) throw new VoiceError("busy", "cancelled while starting");
  };
  const dev = getPref("call-input", "");
  const ns = nsMode();
  const stopStream = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());
  // every startup await is abortable: an unanswered permission prompt (or a slow worklet / RNNoise load) ends at the
  // cancel, so the store's release barrier resolves; what the platform hands over later is stopped when it arrives
  const stream = await startUnder(
    lease,
    () =>
      abortable(
        navigator.mediaDevices.getUserMedia({
          audio: { deviceId: dev ? { ideal: dev } : undefined, echoCancellation: false, autoGainControl: false, noiseSuppression: ns === "standard", channelCount: 1 },
        }),
        signal,
        stopStream,
      ),
    stopStream,
  );
  live(); // a stream that arrives after Cancel is the lease's: lease.done() stops it at once
  const track = stream.getAudioTracks()[0];
  if (!track) throw new VoiceError("nodevice", "no audio track");
  await step(lease, abortable(ctx.audioWorklet.addModule(captureWorkletUrl), signal));
  live();
  let feed = track;
  let proc: Pipeline["proc"] = null;
  if (ns === "strong") {
    // the call's RNNoise path (its own 48 kHz context); the browser's suppression stays off — never both
    try {
      const p = await step(lease, abortable(micProcessorFor("strong"), signal, (late) => void late?.destroy().catch(() => undefined)));
      if (p) {
        if (!lease.hold(() => void p.destroy())) throw new VoiceError("busy");
        // (an init that finishes after the cancel builds its nodes after the lease's destroy: destroyed again then)
        await step(lease, abortable(p.init({ kind: "audio", track } as unknown as AudioProcessorOptions), signal, () => void p.destroy().catch(() => undefined)));
        live();
        proc = p;
        if (p.processedTrack) feed = p.processedTrack;
      }
    } catch (e) {
      if (e instanceof VoiceError || (e as Error)?.name === "Revoked" || (e as Error)?.name === "StartCancelled" || signal?.aborted) throw e;
      // RNNoise didn't load: the browser's own suppression instead (the user asked for suppression)
      log.warn(`RNNoise unavailable for the voice note, using the browser's noise suppression: ${(e as Error)?.message ?? e}`);
      await step(lease, browserNoiseFallback(track, signal));
    }
  }
  live();
  const src = ctx.createMediaStreamSource(new MediaStream([feed]));
  const node = new AudioWorkletNode(ctx, "tw-voice-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
  src.connect(node);
  if (!lease.hold(() => (src.disconnect(), node.port.postMessage("stop")))) throw new VoiceError("busy");
  return { stream, track, src, node, proc };
}

/** WebCodecs Opus → packets → one Ogg file (muxOggOpus: only the packets the note needs). The encoder is closed on
 *  every path: finish() (finally) and close() (a failed start, a cancel). */
export class OpusOggWriter {
  private readonly enc: AudioEncoder;
  private readonly packets: Uint8Array[] = [];
  private descSeen = false;
  private closed = false;
  preSkip = DEFAULT_PRE_SKIP;
  error: unknown = null;

  constructor(onError?: (e: DOMException) => void) {
    this.enc = new AudioEncoder({
      output: (chunk, meta) => {
        if (!this.descSeen && meta?.decoderConfig?.description) {
          this.descSeen = true;
          const ps = preSkipOf(meta.decoderConfig.description as ArrayBuffer);
          if (ps !== null) this.preSkip = ps;
        }
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        this.packets.push(b);
      },
      error: (e) => {
        this.error = e;
        log.warn(`voice note encoder: ${e?.message ?? e}`);
        onError?.(e);
      },
    });
    try {
      this.enc.configure(ENCODER_CONFIG);
    } catch (e) {
      this.close();
      throw e;
    }
  }

  /** mono f32 samples starting at sample `at` */
  encode(data: Float32Array<ArrayBuffer>, at: number): void {
    if (this.error || this.closed || this.enc.state !== "configured" || data.length === 0) return;
    const ad = new AudioData({ format: "f32", sampleRate: VOICE_RATE, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round((at * 1e6) / VOICE_RATE), data });
    try {
      this.enc.encode(ad);
    } finally {
      ad.close();
    }
  }

  /** After the last captured sample: pad the encoder's lookahead (so the last captured sample is encoded even where the
   *  encoder doesn't pad on flush — Chromium does, Firefox's need not; muxOggOpus drops what is surplus), flush, mux. */
  async finish(capturedSamples: number): Promise<{ blob: Blob; preSkip: number; short: boolean; dropped: number }> {
    try {
      if (this.error) throw this.error;
      this.encode(new Float32Array(this.preSkip), capturedSamples);
      await this.enc.flush();
      if (this.error) throw this.error;
      const r = muxOggOpus(this.packets, { preSkip: this.preSkip, capturedSamples, serial: (Math.random() * 0xffffffff) >>> 0 });
      if (r.short) log.warn(`voice note: the encoder gave ${r.totalSamples} samples for ${this.preSkip} + ${capturedSamples}`);
      return { blob: new Blob(r.pages as BlobPart[], { type: "audio/ogg" }), preSkip: this.preSkip, short: r.short, dropped: r.dropped };
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.enc.state !== "closed") this.enc.close();
    } catch {
      /* closed */
    }
  }
}

/** Tests / the browser proof: `samples` of a synthetic 440 Hz tone (0.5 s on, 0.5 s off) through the same encoder +
 *  muxer, no microphone — so exact lengths (page and packet edges) can be decoded by FFmpeg / GStreamer. */
export async function encodeSynthetic(samples: number): Promise<{ blob: Blob; preSkip: number; short: boolean; dropped: number; peaks: number[] }> {
  const w = new OpusOggWriter();
  const meter = new PeakMeter();
  for (let at = 0; at < samples; at += 2400) {
    const n = Math.min(2400, samples - at);
    const chunk = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = at + i;
      chunk[i] = Math.floor(t / (VOICE_RATE / 2)) % 2 === 0 ? 0.5 * Math.sin((2 * Math.PI * 440 * t) / VOICE_RATE) : 0;
    }
    meter.push(chunk);
    w.encode(chunk, at);
  }
  const r = await w.finish(samples);
  return { ...r, peaks: meter.finish() };
}

/** Start recording. Throws VoiceError (permission / nodevice / rate / start / busy). Call it inside the click: the
 *  AudioContext is made before the first await (iOS lets audio start only there). `signal` = cancelled while starting
 *  (the store's Cancel, a call join, another room's start): everything acquired so far stops at once, a stream that
 *  the permission prompt hands over later is stopped the moment it arrives, and the promise rejects. */
export async function startCapture(cb: CaptureCallbacks, signal?: AbortSignal): Promise<CaptureHandle> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") throw new VoiceError("nodevice");
  if (signal?.aborted) throw new VoiceError("busy", "cancelled");
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: "interactive" });
  } catch (e) {
    throw new VoiceError("rate", (e as Error)?.message);
  }
  if (ctx.sampleRate !== VOICE_RATE) {
    void ctx.close().catch(() => undefined);
    throw new VoiceError("rate", `context runs at ${ctx.sampleRate} Hz`);
  }
  void ctx.resume().catch(() => undefined);
  const lease = leases.take("voice-note", null);
  if (!lease) {
    void ctx.close().catch(() => undefined);
    throw new VoiceError("busy", "capture is barred (watching a call)");
  }
  let pipe: Pipeline | undefined;
  let writer: OpusOggWriter | undefined;
  const meter = new PeakMeter();
  let ended = false;
  let stopping: Promise<Finished> | null = null;
  let cancelled = false;
  let flushWait: (() => void) | null = null;
  let inputClosed = false; // after the drain: anything the worklet still posts is after the stop
  let lastProgress = 0;
  const end = (reason: EndReason, detail?: string) => {
    if (ended || cancelled) return;
    ended = true;
    cb.onEnd(reason, detail);
  };
  const gate = () => {
    // a Watch press / sign-out: the microphone stops NOW; what was captured goes to review
    pipe?.stream.getTracks().forEach((t) => t.stop());
    end("revoked");
  };
  // cancelled while starting: the lease stops what it holds right now (the stream, the context, RNNoise); the await in
  // flight then throws (openCapture's checks) and lease.done() stops whatever arrived after
  const onAbort = () => void lease.stopAll();
  signal?.addEventListener("abort", onAbort);
  try {
    if (!lease.hold(() => void ctx.close().catch(() => undefined))) throw new VoiceError("busy");
    pipe = await openCapture(lease, ctx, signal);
    writer = new OpusOggWriter((e) => end("error", e?.message));
    if (ctx.state !== "running") await step(lease, abortable(ctx.resume(), signal));
    if (signal?.aborted) throw new VoiceError("busy", "cancelled while starting");
    if (!lease.commitOpening(gate)) throw new VoiceError("busy");
  } catch (e) {
    writer?.close(); // the encoder never outlives a failed start
    const code = errCode(e);
    log.info(`voice note didn't start (${code}): ${(e as Error)?.message ?? e}`);
    throw e instanceof VoiceError ? e : new VoiceError(code, (e as Error)?.message);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    lease.done(); // uncommitted: stops everything it holds
  }
  const p = pipe as Pipeline;
  const w = writer;
  p.node.port.onmessage = (e: MessageEvent) => {
    if (e.data instanceof Float32Array) {
      if (cancelled || inputClosed) return;
      let chunk = e.data as Float32Array<ArrayBuffer>;
      const room = MAX_SAMPLES - meter.samples;
      if (room <= 0) return;
      if (chunk.length > room) chunk = chunk.subarray(0, room);
      const at = meter.samples;
      meter.push(chunk);
      w.encode(chunk, at);
      const now = performance.now();
      if (now - lastProgress >= PROGRESS_MS) {
        lastProgress = now;
        cb.onProgress({ samples: meter.samples, recent: meter.peaks.slice(-LIVE_FRAMES) });
      }
      if (meter.samples >= MAX_SAMPLES) end("cap");
    } else if (e.data && (e.data as { flushed?: boolean }).flushed) {
      flushWait?.();
      flushWait = null;
    }
  };
  p.track.addEventListener("ended", () => end("device", "the microphone stopped"));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    leases.removeGate(gate);
    p.stream.getTracks().forEach((t) => t.stop());
    try {
      p.src.disconnect();
    } catch {
      /* gone */
    }
    void p.proc?.destroy().catch(() => undefined);
    void ctx.close().catch(() => undefined);
  };
  return {
    samples: () => meter.samples,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      w.close();
      p.node.port.postMessage("stop");
      release();
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          if (cancelled) throw new Error("cancelled");
          // drain: everything that reached the worklet comes out before "flushed" (bounded: a dead context answers nothing)
          await new Promise<void>((resolve) => {
            flushWait = resolve;
            p.node.port.postMessage("flush");
            setTimeout(resolve, 1000);
          });
          inputClosed = true;
          p.node.port.postMessage("stop");
          release();
          const r = await w.finish(meter.samples);
          const peaks = meter.finish();
          return {
            blob: r.blob,
            mimetype: "audio/ogg" as const,
            samples: meter.samples,
            durationMs: durationMs(meter.samples),
            peaks,
            waveform: waveform(peaks),
            preSkip: r.preSkip,
            short: r.short,
          };
        } finally {
          w.close(); // (finish closes it too; a throw before it must not leave it open)
          release();
        }
      })();
      return stopping;
    },
  };
}
