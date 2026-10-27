// envclock.ts — the wall-clock 10 ms tick of an envelope frame (echo.ts Env), from the AUDIO clock.
//
// Every level tap of the call's AudioContext (audio.ts tapTrack: our mic, each received track) runs tap.worklet.js,
// which cuts its input into 10 ms frames on the context's own sample grid (frame k = the samples of [10k, 10k+10) ms of
// context time, the same samples in every tap) and posts each batch with the sample index where its last frame ends.
// AudioClock (one per context) maps that index to a wall-clock tick through one offset (wall ms − audio ms), so what we
// send and what we receive put the same audio instant on the same tick whatever the main thread's delivery jitter, a
// frame never lands on another frame's tick, and a real gap in the audio stays a gap.
//
// The offset is read from the context's own pairing of its clock with the wall clock (audio.ts: getOutputTimestamp,
// else currentTime at delivery) and held while later readings stay within HOLD_MS (no tick-boundary flutter). ONE offset
// per epoch: a reading further off (clock drift, an output-latency change, suspend/resume, a clock-source switch, a
// wall-clock step) starts a new epoch with the new offset, and everything the context had RENDERED by then (currentTime)
// belongs to the older timeline for good: a batch touching it that is delivered later is dropped whole (a permanent,
// monotonic cutoff), so a late or crossing batch never lands on the new timeline. echo.ts Env starts its ring over on a
// new epoch, and echoStep compares only envelopes of the newest epoch, so no analysis window mixes two timelines.
// HOLD_MS is the desktop's re-anchor bound (hear.rs Env::push, 50 ms).
//
// Why (2026-10-24, the 12.0.0 echo A/B): echo.ts stamped each 5-frame batch backwards from the tick it ARRIVED on. A
// few ms of delivery jitter put neighbouring batches on overlapping ticks and left one-tick holes: 6–7.5 % of a
// window's ticks were missing on the build box, over echo.ts's 5 % "live" gate, so no echo window was ever analysed and
// no verdict could form (the received stream carried our voice at NCC 0.95). Numbering each stream sequentially (the
// desktop's rule) closes the holes but lets one stream keep up to 50 ms of bias against another — enough to flip same
// room (< 120 ms) vs speaker echo, or the local lead check (Astra review). One audio clock for every stream has neither.
// Pure (no imports): envclock.test.ts runs it under Node, tap.worklet.js included.

/** Readings within this (ms) of the held offset are noise (hear.rs: 50 ms); further off starts a new epoch. */
export const HOLD_MS = 50;

/** Where a batch's last frame goes: its tick, and the timeline (epoch) it belongs to. */
export interface Stamp {
  tick: number;
  epoch: number;
}

let epochs = 0;

/** One context's audio clock → the wall clock. */
export class AudioClock {
  private off: number | null = null;
  private cutoff = -Infinity; // audio ms rendered before the current epoch began: never placed again
  epoch = ++epochs;
  /** Where a batch of `n` frames whose last frame ends at audio time `endMs` goes, given a fresh reading: audio time
   *  `audioMs` was wall time `wallMs`, and the context had rendered up to audio time `renderedMs`. null = drop it. */
  stamp(endMs: number, n: number, audioMs: number, wallMs: number, renderedMs: number): Stamp | null {
    const off = wallMs - audioMs;
    if (!Number.isFinite(off) || !Number.isFinite(endMs) || !Number.isFinite(renderedMs)) return null;
    if (this.off === null) this.off = off;
    else if (Math.abs(off - this.off) > HOLD_MS) {
      this.off = off;
      this.epoch = ++epochs;
      this.cutoff = Math.max(this.cutoff, renderedMs, endMs);
    }
    if (endMs - 10 * (n - 1) <= this.cutoff) return null;
    return { tick: Math.ceil((endMs + this.off) / 10) - 1, epoch: this.epoch };
  }
}

/** The ticks of a batch of `n` consecutive 10 ms frames whose last frame is on tick `last`. */
export function batchSlots(last: number, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = last - (n - 1 - i);
  return out;
}

// The level tap's AudioWorklet itself is tap.worklet.js (its own file since the 2026-10-26 security review: the app's CSP
// has no `blob:` script source); envclock.test.ts runs it.
