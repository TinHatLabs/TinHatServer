// echo.ts — echo detection for "can they hear me?" (CALL-129/130/131; a port of native hear.rs
// classify_echo / classify_local / EchoTrack / echo_step, 10.5.0).
//
//   * 10 ms loudness envelopes (dBFS, floor −65) of what we SEND (our processed mic tap) and of
//     everything we RECEIVE, on one 10 ms tick clock.
//   * every 5 s: for each peer's newest mic, correlate a 15 s window of ours against theirs at lags
//     0..1.5 s → Idle / Clean / Dup / Echo window; a verdict needs ≥ 6 windows in 180 s at one lag (±20 ms),
//     ≥ 60 % of the hits, median level ≥ −40 dB → `tinhat.echo {on:true}` to THAT person (repeat ≥ 30 s),
//     cleared after 6 clean talking windows in 120 s → `{on:false}` once. Lag < 120 ms = their mic hears us
//     in the ROOM (same room), not a loudspeaker.
//   * local echo: what we play (the call mix, energy-summed) vs our own mic at lags 0..500 ms
//     (a lead check rejects a talker who is physically in our room).
import { createLogger } from "@/core/log";
import { isRecorder } from "./util";
import { batchSlots, type Stamp } from "./envclock";

const log = createLogger("hear-echo");

const RING = 6000; // 60 s of 10 ms frames
export const FLOOR_DB = -65;
const WIN = 1500;
const ECHO_LMAX = 150;
const LOCAL_LMAX = 50;
const LOCAL_LEAD = 30;
export const ROOM_LAG_MS = 120;

const tickNow = () => Math.floor(Date.now() / 10);

/** A time-indexed ring of (dB, muted) frames. A batch lands where the audio clock puts it (envclock.ts Stamp, via audio.ts
 *  tapTrack): never on the tick it happened to ARRIVE on, which piled neighbouring batches onto each other under delivery
 *  jitter and left holes that read as missing audio. A new clock epoch starts the ring over and becomes the newest
 *  timeline; echoStep compares only envelopes on it (`freshEnv`), so no window mixes two timelines; batches from an
 *  older epoch (null) are dropped. Without a stamp (the analyser fallback) a batch ends on its arrival tick, on the
 *  unstamped timeline (epoch 0) — a context that falls back mid-call switches every envelope to it the same way. */
class Env {
  vals = new Float32Array(RING);
  ticks = new Float64Array(RING).fill(-1);
  muted = new Uint8Array(RING);
  epoch = 0;
  push(frames: number[], muted: boolean, stamp?: Stamp | null) {
    if (stamp === null) return;
    const epoch = stamp ? stamp.epoch : 0;
    if (epoch !== this.epoch) {
      this.ticks.fill(-1);
      this.epoch = epoch;
    }
    newestEpoch = epoch; // every push carries its context's current timeline (an older one is refused as null)
    const n = frames.length;
    const ticks = batchSlots(stamp ? stamp.tick : tickNow(), n);
    for (let i = 0; i < n; i++) {
      const t = ticks[i];
      const slot = t % RING;
      const rms = frames[i];
      this.vals[slot] = Math.max(FLOOR_DB, 10 * Math.log10(rms * rms + 1e-10));
      this.ticks[slot] = t;
      this.muted[slot] = muted ? 1 : 0;
    }
  }
  /** Frames from tick `from`, `len` long; missing → `fill`; muted frames → `mutedAs` when given. */
  pull(from: number, len: number, fill: number, mutedAs: number | null): [Float32Array, number] {
    const out = new Float32Array(len);
    let missing = 0;
    for (let i = 0; i < len; i++) {
      const t = from + i;
      const slot = ((t % RING) + RING) % RING;
      if (this.ticks[slot] === t) out[i] = this.muted[slot] && mutedAs !== null ? mutedAs : this.vals[slot];
      else {
        out[i] = fill;
        missing++;
      }
    }
    return [out, missing];
  }
}

// ---- the math (hear.rs:145-330) ------------------------------------------------------------------

function active(a: ArrayLike<number>): boolean {
  const n = a.length;
  if (!n) return false;
  let loud = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] > -45) loud++;
    sum += a[i];
  }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (a[i] - mean) ** 2;
  return loud / n >= 0.15 && Math.sqrt(v / n) >= 6;
}

function nccCurve(a: ArrayLike<number>, b: ArrayLike<number>, lmax: number): number[] {
  const w = a.length;
  const out = new Array<number>(lmax + 1).fill(0);
  if (w === 0 || b.length < w + lmax) return out;
  let am = 0;
  for (let i = 0; i < w; i++) am += a[i];
  am /= w;
  const a0 = new Float64Array(w);
  let an = 0;
  for (let i = 0; i < w; i++) {
    a0[i] = a[i] - am;
    an += a0[i] * a0[i];
  }
  an = Math.sqrt(an);
  if (an < 1e-9) return out;
  for (let k = 0; k <= lmax; k++) {
    let bm = 0;
    for (let i = 0; i < w; i++) bm += b[k + i];
    bm /= w;
    let dot = 0;
    let bn = 0;
    for (let i = 0; i < w; i++) {
      const v = b[k + i] - bm;
      dot += v * a0[i];
      bn += v * v;
    }
    bn = Math.sqrt(bn);
    out[k] = bn < 1e-3 * Math.sqrt(w) ? 0 : dot / (bn * an);
  }
  return out;
}

function percentile(v: number[], p: number): number {
  if (!v.length) return FLOOR_DB;
  const s = [...v].sort((x, y) => x - y);
  const i = Math.round((p / 100) * (s.length - 1));
  return s[Math.min(i, s.length - 1)];
}
const median = (v: number[]) => percentile(v, 50);

function relDb(a: ArrayLike<number>, b: ArrayLike<number>, lag: number): number {
  const arr = Array.from(a);
  const p80 = percentile(arr, 80);
  const d: number[] = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] > p80) d.push(b[i + lag] - arr[i]);
  return d.length ? median(d) : 0;
}

function levelAt(a: ArrayLike<number>, b: ArrayLike<number>, lag: number): number {
  const arr = Array.from(a);
  const p80 = percentile(arr, 80);
  const d: number[] = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] > p80) d.push(b[i + lag]);
  return d.length ? median(d) : FLOOR_DB;
}

function argmax(c: number[], from: number): number {
  let k = Math.min(from, Math.max(0, c.length - 1));
  for (let i = from; i < c.length; i++) if (c[i] > c[k]) k = i;
  return k;
}

type Win = { t: "idle" } | { t: "clean" } | { t: "dup"; lag: number; ncc: number; rel: number } | { t: "echo"; lag: number; ncc: number; rel: number };

export function classifyEcho(a: Float32Array, b: Float32Array, lmax: number): Win {
  if (!active(a) || b.length < a.length + lmax) return { t: "idle" };
  const c = nccCurve(a, b, lmax);
  const k0 = argmax(c, 0);
  const r0 = relDb(a, b, k0);
  if (c[k0] >= 0.5 && k0 <= 6 && Math.abs(r0) <= 4) return { t: "dup", lag: k0, ncc: c[k0], rel: r0 };
  const k = argmax(c, 4);
  if (c[k] >= 0.3) {
    const r = relDb(a, b, k);
    if (r <= -6) return { t: "echo", lag: k, ncc: c[k], rel: r };
  }
  return { t: "clean" };
}

export function classifyLocal(r: Float32Array, m: Float32Array, w: number, lmax: number, lead: number): Win {
  if (r.length < w + lead || m.length < w + lmax || !active(r.subarray(0, w))) return { t: "idle" };
  const c = nccCurve(r.subarray(0, w), m.subarray(0, w + lmax), lmax);
  const k = argmax(c, 0);
  if (c[k] >= 0.35 && levelAt(r.subarray(0, w), m, k) >= -60) {
    if (lead > 0) {
      const e = nccCurve(m.subarray(0, w), r.subarray(0, w + lead), lead);
      const j = argmax(e, 1);
      if (e[j] > c[k] + 0.05) return { t: "clean" };
    }
    return { t: "echo", lag: k, ncc: c[k], rel: relDb(r.subarray(0, w), m, k) };
  }
  return { t: "clean" };
}

class EchoTrack {
  hits: Array<[number, number, number, number]> = []; // when ms, lag (10 ms), ncc, rel dB
  analysed: Array<[number, boolean]> = [];
  on: [number, number] | null = null; // (lag ms, level dB)
  sentAt = 0;
  note(now: number, w: Win) {
    if (w.t === "idle") return;
    if (w.t === "echo") {
      this.hits.push([now, w.lag, w.ncc, w.rel]);
      this.analysed.push([now, true]);
    } else this.analysed.push([now, false]);
    while (this.hits.length && now - this.hits[0][0] > 180000) this.hits.shift();
    while (this.analysed.length && now - this.analysed[0][0] > 180000) this.analysed.shift();
  }
  verdict(now: number, spanMs: number, need: number, tol: number, minDb: number): [number, number, number] | null {
    const recent = this.hits.filter((h) => now - h[0] <= spanMs);
    if (recent.length < need) return null;
    let best: [number, number] = [0, 0];
    for (const h of recent) {
      const n = recent.filter((o) => Math.abs(o[1] - h[1]) <= tol).length;
      if (n > best[1]) best = [h[1], n];
    }
    if (best[1] < need || best[1] < 0.6 * recent.length) return null;
    const lvl = median(recent.filter((o) => Math.abs(o[1] - best[0]) <= tol).map((o) => o[3]));
    return lvl >= minDb ? [best[0] * 10, lvl, best[1]] : null;
  }
  clear(now: number, spanMs: number, need: number): boolean {
    const recent = this.analysed.filter((h) => now - h[0] <= spanMs);
    return recent.length >= need && !recent.some((h) => h[1]);
  }
}

// ---- state --------------------------------------------------------------------------------------------

let sent: Env | null = null;
let newestEpoch = 0; // the timeline of the latest frames fed (envclock.ts epoch; 0 = unstamped, the analyser fallback)
/** On the newest timeline? An envelope that stopped receiving before an epoch change keeps its old ring: never compare it. */
const freshEnv = (e: Env) => e.epoch === newestEpoch;
const recv = new Map<string, { identity: string; category: string; added: number; last: number; env: Env }>(); // by track sid
const tracks = new Map<string, EchoTrack>(); // peer identity → does THEIR stream carry our voice?
const localCall = new EchoTrack();
const dupLogged = new Set<string>();

export function feedSent(frames: number[], muted: boolean, stamp?: Stamp | null): void {
  if (!sent) sent = new Env();
  sent.push(frames, muted, stamp);
}

export function feedRecv(sid: string, identity: string, category: string, frames: number[], stamp?: Stamp | null): void {
  if (isRecorder(identity)) return;
  let r = recv.get(sid);
  if (!r) {
    r = { identity, category, added: Date.now(), last: 0, env: new Env() };
    recv.set(sid, r);
  }
  r.last = Date.now();
  r.env.push(frames, false, stamp);
}

export function forgetRecv(sid: string): void {
  recv.delete(sid);
}

export function resetEcho(): void {
  sent = null;
  newestEpoch = 0;
  recv.clear();
  tracks.clear();
  localCall.hits = [];
  localCall.analysed = [];
  localCall.on = null;
  dupLogged.clear();
}

/** Our detection of `identity` sending our voice back (for peers[id].echo). */
export function echoOf(identity: string): { lag: number; db: number; room: boolean } | null {
  const on = tracks.get(identity)?.on;
  return on ? { lag: on[0], db: Math.round(on[1] * 10) / 10, room: on[0] < ROOM_LAG_MS } : null;
}

export function localEcho(): { src: "call"; lag: number; db: number } | null {
  return localCall.on ? { src: "call", lag: localCall.on[0], db: Math.round(localCall.on[1] * 10) / 10 } : null;
}

/** One 5 s analysis step. Returns the `tinhat.echo` packets to send: [to, payload]. */
export function echoStep(gainOf: (sid: string) => number = () => 1): Array<[string, { v: 1; on: boolean; lag: number; db: number; room: boolean }]> {
  const out: Array<[string, { v: 1; on: boolean; lag: number; db: number; room: boolean }]> = [];
  if (!sent || !freshEnv(sent)) return out;
  const now = Date.now();
  for (const [sid, r] of recv) if (now - r.last > 60000) recv.delete(sid); // unsubscribed tracks
  const t = tickNow() - 20;
  const fromE = t - (ECHO_LMAX + WIN);
  const [aLive, miss] = sent.pull(fromE, WIN, FLOOR_DB, FLOOR_DB);
  const fromL = t - (LOCAL_LMAX + WIN);
  const [bAll, missL] = sent.pull(fromL, WIN + LOCAL_LMAX, FLOOR_DB, null);
  const newest = new Map<string, { added: number; env: Env }>();
  for (const r of recv.values()) {
    if (r.category !== "mic" || !freshEnv(r.env)) continue;
    const cur = newest.get(r.identity);
    if (!cur || cur.added < r.added) newest.set(r.identity, r);
  }
  const peers: Array<[string, Float32Array]> = [...newest].map(([id, r]) => [id, r.env.pull(fromE, WIN + ECHO_LMAX, FLOOR_DB, null)[0]]);
  let anyRx = false;
  const mix = new Float64Array(WIN + LOCAL_LEAD);
  for (const [sid, r] of recv) {
    if (!freshEnv(r.env)) continue;
    const g = gainOf(sid);
    if (!(g > 0)) continue; // muted / deafened / cut: not in our speakers
    const [m] = r.env.pull(fromL, WIN + LOCAL_LEAD, FLOOR_DB, null);
    for (let i = 0; i < m.length; i++) mix[i] += 10 ** (m[i] / 10) * g * g;
    anyRx = true;
  }
  const live = miss < 0.05 * WIN;
  const all = missL < 0.05 * (WIN + LOCAL_LMAX);
  if (live) {
    for (const [id, b] of peers) {
      const w = classifyEcho(aLive, b, ECHO_LMAX);
      if (w.t === "dup" && !dupLogged.has(id)) {
        dupLogged.add(id);
        log.info(`[hear] ${id}'s audio is a copy of ours (${w.lag * 10} ms) — the same microphone on two clients?`);
      }
      let tr = tracks.get(id);
      if (!tr) tracks.set(id, (tr = new EchoTrack()));
      tr.note(now, w);
      const v = tr.verdict(now, 180000, 6, 2, -40);
      if (v) {
        const [lag, db, n] = v;
        const first = tr.on === null;
        tr.on = [lag, db];
        const due = !tr.sentAt || now - tr.sentAt >= 30000;
        if (first)
          log.info(
            lag < ROOM_LAG_MS
              ? `[hear] echo: ${id}'s mic picks up our voice in the room (${lag} ms, ${db.toFixed(0)} dB, ${n} windows)`
              : `[hear] echo: ${id} sends our voice back ${lag} ms later at ${db.toFixed(0)} dB (${n} windows)`,
          );
        if (first || due) {
          tr.sentAt = now;
          out.push([id, { v: 1, on: true, lag, db: Math.round(db * 10) / 10, room: lag < ROOM_LAG_MS }]);
        }
      } else if (tr.on && tr.clear(now, 120000, 6)) {
        tr.on = null;
        tr.sentAt = 0;
        log.info(`[hear] echo: ${id} no longer sends our voice back`);
        out.push([id, { v: 1, on: false, lag: 0, db: 0, room: false }]);
      }
    }
  }
  if (anyRx && all) {
    const r = Float32Array.from(mix, (e) => Math.max(FLOOR_DB, 10 * Math.log10(e)));
    const w = classifyLocal(r, bAll, WIN, LOCAL_LMAX, LOCAL_LEAD);
    localCall.note(now, w);
    const v = localCall.verdict(now, 120000, 5, 3, -60);
    if (v) {
      if (!localCall.on) log.info(`[hear] local echo: our mic picks up the call from the speakers (${v[0]} ms, ${v[1].toFixed(0)} dB vs the source, ${v[2]} windows)`);
      localCall.on = [v[0], v[1]];
    } else if (localCall.on && localCall.clear(now, 90000, 4)) {
      localCall.on = null;
      log.info("[hear] local echo: the call no longer reaches our mic");
    }
  }
  return out;
}
