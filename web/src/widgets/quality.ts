// quality.ts — the Call stats widget's shared maths (contract WIDGETS.md §5 + WIDGETS-UI.md "Call stats"; vectors
// testvectors/widgets/{bands,lanes,format,spark}.json): quality bands, LiveKit ConnectionQuality → band, one track's
// receive numbers from two WebRTC stats samples, the lane bar's bitrate scale, codec / resolution / bitrate labels and
// the sparkline's geometry. Pure: no DOM, no imports. The desktop's Rust port runs the same vectors.
//
// Integer rounding everywhere is r(x) = x ≤ 0 ? 0 : floor(x + 0.5) on IEEE doubles, evaluated in the order written
// (both languages' + − × ÷ are correctly rounded, so the results are identical).

export type Band = "good" | "ok" | "poor";
export type TrackKind = "a" | "v" | "s";
export const TRACK_KINDS: readonly TrackKind[] = ["a", "v", "s"];

/** What one side measures about one received track (the `tinhat.rxq` entry; loss in per-mille). */
export interface TrackNumbers {
  k: TrackKind;
  kbps?: number;
  /** packet loss, per-mille (0‥1000) */
  loss?: number;
  /** jitter, ms */
  jit?: number;
  /** round-trip time, ms */
  rtt?: number;
  w?: number;
  h?: number;
  fps?: number;
  /** codec label ≤ 8 chars ("AV1", "H.264", "Opus") */
  c?: string;
}

/** Round half up, never below 0 (the one integer rounding of the widget maths). */
export function r(x: number): number {
  return x <= 0 ? 0 : Math.floor(x + 0.5);
}

// ---- quality bands (§5) ---------------------------------------------------------------------------------------------

/** good < 2 % loss AND < 30 ms jitter AND < 150 ms RTT; poor ≥ 8 % OR ≥ 80 ms OR ≥ 400 ms; else ok. A number that is
 *  missing — or not a finite number (null, a string) — neither helps nor hurts; none of the three = null (unknown). */
export const BAND = { goodLoss: 20, goodJit: 30, goodRtt: 150, poorLoss: 80, poorJit: 80, poorRtt: 400 } as const;

const fin = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function bandOf(n: { loss?: number | null; jit?: number | null; rtt?: number | null }): Band | null {
  const loss = fin(n.loss);
  const jit = fin(n.jit);
  const rtt = fin(n.rtt);
  if (loss === undefined && jit === undefined && rtt === undefined) return null;
  if ((loss !== undefined && loss >= BAND.poorLoss) || (jit !== undefined && jit >= BAND.poorJit) || (rtt !== undefined && rtt >= BAND.poorRtt)) return "poor";
  if ((loss === undefined || loss < BAND.goodLoss) && (jit === undefined || jit < BAND.goodJit) && (rtt === undefined || rtt < BAND.goodRtt)) return "good";
  return "ok";
}

const RANK: Record<Band, number> = { good: 0, ok: 1, poor: 2 };
/** The worst of several bands (null entries ignored; none = null). */
export function worstBand(bands: readonly (Band | null | undefined)[]): Band | null {
  let w: Band | null = null;
  for (const b of bands) if (b && (w === null || RANK[b] > RANK[w])) w = b;
  return w;
}

/** LiveKit ConnectionQuality → the person's dot: excellent/good → good, poor → ok, lost → poor, anything else → null. */
export function cqBand(q: string | null | undefined): Band | null {
  if (q === "excellent" || q === "good") return "good";
  if (q === "poor") return "ok";
  if (q === "lost") return "poor";
  return null;
}

// ---- one received track from two stats samples ----------------------------------------------------------------------

/** One WebRTC `inbound-rtp` sample of a received track, normalised (both apps read the same fields). */
export interface RxSample {
  k: TrackKind;
  /** sample time, ms */
  at: number;
  /** bytesReceived, packetsReceived, packetsLost (cumulative; packetsLost may go down — duplicates) */
  bytes: number;
  packets: number;
  lost: number;
  /** jitter, seconds (inbound-rtp.jitter) */
  jitter?: number;
  /** round-trip time to the server, seconds (the receiving transport's candidate-pair currentRoundTripTime) */
  rtt?: number;
  /** video: framesPerSecond, frameWidth, frameHeight */
  fps?: number;
  w?: number;
  h?: number;
  /** the codec's mimeType ("video/AV1", "audio/opus") */
  codec?: string;
}

/** The numbers of one track over the interval prev → cur. null: no prev; a time, byte or packet count that is not a
 *  finite number; cur.at ≤ prev.at; or bytesReceived / packetsReceived went DOWN (the stats object was replaced — a
 *  resubscription: start again from cur). packetsLost may go down (late / duplicate packets): its delta is floored at 0. */
export function rxNumbers(prev: RxSample | null | undefined, cur: RxSample): TrackNumbers | null {
  if (!prev || !cur) return null;
  for (const v of [prev.at, prev.bytes, prev.packets, prev.lost, cur.at, cur.bytes, cur.packets, cur.lost]) if (!(typeof v === "number" && Number.isFinite(v))) return null;
  if (!(cur.at > prev.at) || cur.bytes < prev.bytes || cur.packets < prev.packets) return null;
  const dt = cur.at - prev.at;
  const out: TrackNumbers = { k: cur.k };
  out.kbps = r(((cur.bytes - prev.bytes) * 8) / dt);
  const lost = Math.max(0, cur.lost - prev.lost);
  const got = Math.max(0, cur.packets - prev.packets);
  out.loss = lost + got > 0 ? r((1000 * lost) / (lost + got)) : 0;
  if (typeof cur.jitter === "number" && Number.isFinite(cur.jitter)) out.jit = r(cur.jitter * 1000);
  if (typeof cur.rtt === "number" && Number.isFinite(cur.rtt)) out.rtt = r(cur.rtt * 1000);
  if (cur.k !== "a") {
    if (typeof cur.w === "number" && cur.w > 0 && typeof cur.h === "number" && cur.h > 0) {
      out.w = r(cur.w);
      out.h = r(cur.h);
    }
    if (typeof cur.fps === "number" && Number.isFinite(cur.fps)) out.fps = r(cur.fps);
  }
  const c = codecName(cur.codec);
  if (c) out.c = c;
  return clampNumbers(out);
}

/** The value limits of a track's numbers (the `tinhat.rxq` clamps). */
export const LIMITS = { kbps: 1_000_000, loss: 1000, jit: 60_000, rtt: 60_000, w: 16_384, h: 16_384, fps: 1000 } as const;
type NumKey = keyof typeof LIMITS;
export const NUM_KEYS: readonly NumKey[] = ["kbps", "loss", "jit", "rtt", "w", "h", "fps"];

/** Clamp every number to its limit (r() applied), drop a codec that isn't a valid label. */
export function clampNumbers(n: TrackNumbers): TrackNumbers {
  const out: TrackNumbers = { k: n.k };
  for (const k of NUM_KEYS) {
    const v = n[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(LIMITS[k], r(v));
  }
  if (typeof n.c === "string" && validCodecLabel(n.c)) out.c = n.c;
  return out;
}

// ---- labels ---------------------------------------------------------------------------------------------------------

const CODECS = new Map<string, string>([
  ["opus", "Opus"],
  ["av1", "AV1"],
  ["h264", "H.264"],
  ["h265", "H.265"],
  ["hevc", "H.265"],
  ["vp8", "VP8"],
  ["vp9", "VP9"],
  ["red", "RED"],
  ["pcmu", "PCMU"],
  ["pcma", "PCMA"],
  ["g722", "G722"],
]);

/** A codec label from a mimeType ("video/H264" → "H.264", "audio/opus" → "Opus"). ASCII-only rules (the same bytes in
 *  every language): the part after the last "/", ASCII whitespace (U+0009–U+000D, U+0020) trimmed, ASCII letters
 *  lower-cased for the lookup; unknown subtypes: ASCII letters upper-cased, only A–Z 0–9 . + - kept, cut to 8;
 *  "" when nothing is left. */
export function codecName(mime: string | undefined | null): string {
  if (typeof mime !== "string") return "";
  const isWs = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  let sub = mime.includes("/") ? mime.slice(mime.lastIndexOf("/") + 1) : mime;
  let a = 0;
  let b = sub.length;
  while (a < b && isWs(sub.charCodeAt(a))) a++;
  while (b > a && isWs(sub.charCodeAt(b - 1))) b--;
  sub = sub.slice(a, b);
  if (!sub) return "";
  const lower = sub.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
  const known = CODECS.get(lower);
  if (known) return known;
  let s = "";
  for (const ch of lower) {
    const up = /^[a-z]$/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) - 32) : ch;
    if (/^[A-Z0-9.+-]$/.test(up)) s += up;
    if (s.length === 8) break;
  }
  return s;
}

/** A codec label a peer may send: 1–8 of A–Z a–z 0–9 . + - */
export function validCodecLabel(s: string): boolean {
  return /^[A-Za-z0-9.+-]{1,8}$/.test(s);
}

/** "720p30": the short side + p + fps ("720p" without fps); "" without a size. */
export function resChip(w: number | undefined, h: number | undefined, fps?: number): string {
  if (!(typeof w === "number" && w > 0 && typeof h === "number" && h > 0)) return "";
  const p = Math.min(w, h);
  return typeof fps === "number" && fps > 0 ? `${p}p${fps}` : `${p}p`;
}

/** "48 kb/s", "1.4 Mb/s", "120 Mb/s" (kb/s below 1000; one decimal below 100 Mb/s). */
export function fmtRate(kbps: number): string {
  const k = r(kbps);
  if (k < 1000) return `${k} kb/s`;
  if (k < 100_000) {
    const tenths = Math.floor((k + 50) / 100);
    return `${Math.floor(tenths / 10)}.${tenths % 10} Mb/s`;
  }
  return `${Math.floor((k + 500) / 1000)} Mb/s`;
}

/** "2.4 %" from per-mille (one decimal). */
export function fmtLoss(pm: number): string {
  const p = r(pm);
  return `${Math.floor(p / 10)}.${p % 10} %`;
}

// ---- the lane bar ---------------------------------------------------------------------------------------------------

/** The lane bar's length in per-mille: doublings of bitrate from 8 kb/s (0) to 8192 kb/s (1000), linear between the
 *  powers of two — voice ≈ 200‰, 720p camera ≈ 750‰, a 1080p share ≈ 950‰. Integer maths only. */
export function rateFillPm(kbps: number): number {
  const k = r(kbps);
  if (k <= 8) return 0;
  if (k >= 8192) return 1000;
  let i = 0;
  let lo = 8;
  while (lo * 2 <= k) {
    lo *= 2;
    i++;
  }
  // (i + (k − lo) / lo) / 10 × 1000, rounded half up — as one integer fraction num / den
  const num = (i * lo + (k - lo)) * 1000;
  const den = lo * 10;
  return Math.floor((2 * num + den) / (2 * den));
}

// ---- the sparkline --------------------------------------------------------------------------------------------------

export const SPARK_SAMPLES = 60;

/** Headroom above the window's peak: the peak sits at 80 % of the height (a steady stream is a line, not a block). */
export const SPARK_HEADROOM = 1.25;

/** The sparkline's points in centi-pixels ([x, y] × 100, integers) for the last ≤ 60 values in a w × h box: the newest
 *  sample at the right edge (x = w − 1), one step = (w − 2) / 59; top = the window's max × 1.25; y = (h − 1) −
 *  (v / top) × (h − 2) (an all-zero window is a flat line at the bottom). The renderers draw a polyline through
 *  point / 100 (+ the area under it). */
export function sparkPoints(values: readonly number[], w: number, h: number): [number, number][] {
  const vals = values.slice(-SPARK_SAMPLES).map((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0));
  const n = vals.length;
  if (!n) return [];
  let max = 0;
  for (const v of vals) if (v > max) max = v;
  const top = max * SPARK_HEADROOM;
  const step = (w - 2) / (SPARK_SAMPLES - 1);
  return vals.map((v, i) => {
    const x = 1 + (SPARK_SAMPLES - n + i) * step;
    const y = h - 1 - (top > 0 ? (v / top) * (h - 2) : 0);
    return [r(x * 100), r(y * 100)];
  });
}
