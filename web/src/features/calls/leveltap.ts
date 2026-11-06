// leveltap.ts — the 10 ms RMS level tap on ONE MediaStreamTrack (Pad Watch round 13, share
// claude/tinhat-pad/WATCH-LEASE/ "ROUND 13"). Its own module so that the OUTPUT MIX can't reach a tap: this file never
// imports audio.ts (the master gain, outAnalyser, the playback graph) — the import-graph lint
// (remotetaps.lint.test.ts R6) fails on any path from here to it. The tap's input is a source node made here from the
// tapped track and nothing else; its analyser / worklet node never leaves this closure.
//   tapLocalTrack  — a leased LOCAL capture (the call mic / meter, the sameroom raw mic); its lease gates the track.
//   tapRemoteTrack — a RECEIVED track only: it throws unless the track is the live track of a registered
//                    RTCRtpReceiver (noteReceiver, called by the engine from RoomEvent.TrackSubscribed).
import type { Stamp } from "./envclock";

export interface Tap {
  close(): void;
}
/** what the caller (audio.ts) lends a tap: the context, the worklet's readiness, the frame clock, the open-tap count */
export interface TapEnv {
  ctx: AudioContext;
  ready: Promise<boolean>;
  stamp: (c: AudioContext, end: number, n: number) => Stamp | null;
  opened: () => void;
  closed: () => void;
}
type OnFrames = (frames: number[], stamp?: Stamp | null) => void;
export const WORKLET_WAIT_MS = 3000;

// ---- the receiver registry (round 13: the runtime guard of the remote taps) ----
const receivers = new Set<RTCRtpReceiver>();
/** a subscribed remote track's receiver (engine.ts, TrackSubscribed) */
export function noteReceiver(r: RTCRtpReceiver | undefined): void {
  for (const x of receivers) if (x.track.readyState === "ended") receivers.delete(x);
  if (r && typeof RTCRtpReceiver !== "undefined" && r instanceof RTCRtpReceiver) receivers.add(r);
}
export function forgetReceiver(r: RTCRtpReceiver | undefined): void {
  if (r) receivers.delete(r);
}
/** is `t` the live track of a registered receiver — i.e. audio arriving from the network, not a local source? */
export function isReceiverTrack(t: MediaStreamTrack): boolean {
  if (t.kind !== "audio" || t.readyState !== "live") return false;
  for (const r of receivers) if (r instanceof RTCRtpReceiver && r.track === t) return true;
  return false;
}

async function tapOn(env: TapEnv, track: MediaStreamTrack, onFrames: OnFrames): Promise<Tap> {
  const c = env.ctx;
  // Pad on the phone, Step A: the worklet module's load is waited for at most 3 s (then the analyser fallback)
  const ok = await Promise.race([env.ready, new Promise<boolean>((res) => setTimeout(() => res(false), WORKLET_WAIT_MS))]);
  const src = c.createMediaStreamSource(new MediaStream([track]));
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
    env.opened();
    let open = true;
    return {
      close() {
        if (open) env.closed();
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
  node.port.onmessage = (e: MessageEvent<{ f: number[]; end: number }>) => onFrames(e.data.f, env.stamp(c, e.data.end, e.data.f.length));
  src.connect(node);
  env.opened();
  let open = true;
  return {
    close() {
      if (open) env.closed();
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

/** a leased LOCAL capture's level (the call mic / meter, the sameroom raw mic) */
export function tapLocalTrack(env: TapEnv, track: MediaStreamTrack, onFrames: OnFrames): Promise<Tap> {
  return tapOn(env, track, onFrames);
}

/** a RECEIVED remote track's level — refused unless it is the live track of a registered RTCRtpReceiver */
export function tapRemoteTrack(env: TapEnv, track: MediaStreamTrack, onFrames: OnFrames): Promise<Tap> {
  if (!isReceiverTrack(track)) return Promise.reject(new Error("remote tap refused: not the track of a current receiver"));
  return tapOn(env, track, onFrames);
}
