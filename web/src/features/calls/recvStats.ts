// recvStats.ts — the [recv-stats] log line: what this app, as a RECEIVER, did about one remote video track. It names who
// asks a sender for keyframes: the sender only sees a PLI count, so each receiver's own log has to say it was the one.
//
// Shared logic: the desktop's crates/widgets/src/recvstats.rs builds the same line, and both run
// testvectors/recv-stats/format.json. A figure the receiver doesn't report is left out, never written as a zero.

/** One remote video track's receiver counters, as totals since the track started. */
export interface RecvCounters {
  pli: number | null;
  nack: number | null;
  fir: number | null;
  decoded: number | null;
  dropped: number | null;
  kf: number | null;
  w: number | null;
  h: number | null;
  decoder: string | null;
}

/** How often a call logs the line. */
export const RECV_LOG_MS = 30_000;
/** The samplers tick on their own timers: this much early still counts as due. */
const SLACK_MS = 250;
const ID_MAX = 128;
const DECODER_MAX = 64;

export function recvLogDue(last: number | null, now: number): boolean {
  return last === null || now - last >= RECV_LOG_MS - SLACK_MS;
}

/** Keeps one log line one line: what isn't printable ASCII (or is a quote) becomes `_`. */
function safe(s: string, max: number, spaces: boolean): string {
  return [...s]
    .slice(0, max)
    .map((c) => ((c >= "!" && c <= "~" && c !== "'") || (spaces && c === " ") ? c : "_"))
    .join("");
}

const id = (s: string): string => (s === "" ? "?" : safe(s, ID_MAX, false));

/** `prev` is the same track's counters at its last line and `dt` the seconds since then (both null on its first line). */
export function formatRecvLine(who: string, src: string, sid: string, cur: RecvCounters, prev: RecvCounters | null, dt: number | null): string {
  let line = `[recv-stats] who=${id(who)} src=${src} sid=${id(sid)}`;
  if (cur.w !== null && cur.h !== null && cur.w > 0 && cur.h > 0) line += ` res=${cur.w}x${cur.h}`;
  if (cur.decoder) line += ` decoder='${safe(cur.decoder, DECODER_MAX, true)}'`;
  if (dt !== null) line += ` dt=${dt}`;
  for (const name of ["pli", "nack", "fir", "decoded", "dropped", "kf"] as const) {
    const c = cur[name];
    if (c === null) continue;
    const p = prev ? prev[name] : null;
    // a counter that went backwards restarted from zero
    line += p === null ? ` ${name}=${c}` : ` ${name}=${c} d_${name}=${c >= p ? c - p : c}`;
  }
  return line;
}

/**
 * Each track's counters at its last line. A baseline outlives a round where the stats call came back empty and ends with
 * its receiver, so one receiver's counters are never compared with another's (on the desktop, the track's own record).
 */
export class RecvBaselines<R> {
  private readonly m = new Map<string, { c: RecvCounters; at: number; owner: R }>();
  /** Records this round's counters; returns what the line compares them with (null on the receiver's first line). */
  step(key: string, owner: R, c: RecvCounters, at: number): { prev: RecvCounters; dt: number } | null {
    const old = this.m.get(key);
    this.m.set(key, { c, at, owner });
    return old && old.owner === owner ? { prev: old.c, dt: Math.round((at - old.at) / 1000) } : null;
  }
  /** Forgets every track not in `live` (the ones that are still subscribed). */
  retain(live: ReadonlySet<string>): void {
    for (const k of [...this.m.keys()]) if (!live.has(k)) this.m.delete(k);
  }
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** One video receiver's counters from its `inbound-rtp`. Browsers differ in what they report (docs/WEB-EXCEPTIONS.md). */
export function countersFromInbound(r: Record<string, unknown>): RecvCounters {
  return {
    pli: count(r.pliCount),
    nack: count(r.nackCount),
    fir: count(r.firCount),
    decoded: count(r.framesDecoded),
    dropped: count(r.framesDropped),
    kf: count(r.keyFramesDecoded),
    w: count(r.frameWidth),
    h: count(r.frameHeight),
    decoder: typeof r.decoderImplementation === "string" ? r.decoderImplementation : null,
  };
}
