// rxq.ts — the `tinhat.rxq` LiveKit data message (contract WIDGETS.md §6; vectors testvectors/widgets/rxq/*): every 5 s
// in a call each app tells EACH remote participant (targeted, unreliable) how it receives THAT participant's tracks.
// The receiver shows it as that person's outgoing lane ("how they receive you"). Display only — never trusted for
// anything else. Pure: the codec, the validation and the per-sender rate limit; the call engine does the I/O.
//
//   {"v":1,"q":"good","t":[{"k":"a","kbps":48,"loss":2,"jit":12,"rtt":40},{"k":"v","kbps":1450,"loss":0,"jit":8,
//    "w":1280,"h":720,"fps":30,"c":"AV1"}]}
//
// Older apps ignore the topic; `tinhat.rx` (hear.ts / hear.rs) is unchanged.
import { TRACK_KINDS, bandOf, clampNumbers, worstBand, type Band, type TrackKind, type TrackNumbers } from "./quality";
import { parseStrictJson } from "./json";

export const RXQ_TOPIC = "tinhat.rxq";
export const RXQ_VERSION = 1;
export const RXQ_MAX_BYTES = 600;
export const RXQ_MAX_ENTRIES = 8;
/** The sender's period. */
export const RXQ_SEND_MS = 5000;
/** The receiver accepts at most one message per sender per 2 s. */
export const RXQ_MIN_GAP_MS = 2000;
/** A lane with no message for longer than this shows "—" (stale / an older app that doesn't send). */
export const RXQ_STALE_MS = 12_000;
/** Messages a sender may make us READ per 2 s window (valid or not) — bounds the work a flood can cause. */
export const RXQ_MAX_ATTEMPTS = 4;
/** The strict reader's nesting limit for rxq texts (the message itself needs 3 levels). */
export const RXQ_MAX_DEPTH = 16;

export interface Rxq {
  q: Band;
  t: TrackNumbers[];
}
export type RxqDecoded = ({ ok: true } & Rxq) | { ok: false; error: RxqError };
export type RxqError = "too-large" | "not-json" | "not-object" | "bad-v" | "bad-t" | "too-many";

const KEY_ORDER = ["k", "kbps", "loss", "jit", "rtt", "w", "h", "fps", "c"] as const;
const KIND_RANK: Record<TrackKind, number> = { a: 0, v: 1, s: 2 };

/** UTF-8 length of a well-formed string (a lone surrogate counts as U+FFFD, 3 bytes). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function entryJson(e: TrackNumbers): string {
  const parts: string[] = [];
  for (const k of KEY_ORDER) {
    const v = e[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * The message a sender writes for one remote participant: its entries clamped, one per kind (a, v, s — the first of each),
 * in kind order; q = the worst band of the entries ("ok" when none can be banded). Keys in the fixed order
 * v, q, t and k, kbps, loss, jit, rtt, w, h, fps, c; no spaces. Entries are dropped from the end while the text is
 * over 600 bytes. Returns "" when there is nothing to report (no entries): send nothing then.
 */
export function encodeRxq(entries: readonly TrackNumbers[]): string {
  const byKind = new Map<TrackKind, TrackNumbers>();
  for (const e of entries) if (e && TRACK_KINDS.includes(e.k) && !byKind.has(e.k)) byKind.set(e.k, clampNumbers(e));
  const t = [...byKind.values()].sort((a, b) => KIND_RANK[a.k] - KIND_RANK[b.k]);
  while (t.length) {
    const q = worstBand(t.map(bandOf)) ?? "ok";
    const text = `{"v":${RXQ_VERSION},"q":${JSON.stringify(q)},"t":[${t.map(entryJson).join(",")}]}`;
    if (utf8Bytes(text) <= RXQ_MAX_BYTES) return text;
    t.pop();
  }
  return "";
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/**
 * Read a received message: the payload's UTF-8 text (the app decodes the bytes strictly — malformed UTF-8 is refused
 * before this; a BOM stays in the text and is refused here). Refused whole: over 600 bytes (too-large); not strict JSON
 * by json.ts (not-json: other whitespace, a duplicate key, an escaped or raw lone surrogate, a number that is not a
 * finite double, nesting over 16); not an object (not-object); `v` not a number whose value is an integer ≥ 1 (bad-v);
 * `t` not an array (bad-t); more than 8 entries (too-many). Then per entry: not an object or `k` not a/v/s → skipped; a
 * second entry of a kind → skipped; fields that are not JSON numbers → dropped, the rest r() + clamped; `c` kept only
 * when it is a valid label. `q` = the given one when good/ok/poor, else the worst band of the kept entries, else "ok".
 * Unknown keys are ignored (a newer version may add some).
 */
export function decodeRxq(text: string): RxqDecoded {
  if (typeof text !== "string") return { ok: false, error: "not-json" };
  if (utf8Bytes(text) > RXQ_MAX_BYTES) return { ok: false, error: "too-large" };
  const parsed = parseStrictJson(text, RXQ_MAX_DEPTH);
  if (!parsed.ok) return { ok: false, error: "not-json" };
  const v: unknown = parsed.value;
  if (!isObj(v)) return { ok: false, error: "not-object" };
  const ver = own(v, "v");
  if (typeof ver !== "number" || !Number.isInteger(ver) || ver < 1) return { ok: false, error: "bad-v" };
  const tv = own(v, "t");
  if (!Array.isArray(tv)) return { ok: false, error: "bad-t" };
  if (tv.length > RXQ_MAX_ENTRIES) return { ok: false, error: "too-many" };
  const t: TrackNumbers[] = [];
  for (const e of tv) {
    if (!isObj(e)) continue;
    const k = own(e, "k");
    if (k !== "a" && k !== "v" && k !== "s") continue;
    if (t.some((x) => x.k === k)) continue;
    const n: TrackNumbers = { k };
    for (const key of ["kbps", "loss", "jit", "rtt", "w", "h", "fps"] as const) {
      const x = own(e, key);
      if (typeof x === "number") n[key] = x;
    }
    const c = own(e, "c");
    if (typeof c === "string") n.c = c;
    t.push(clampNumbers(n));
  }
  const qv = own(v, "q");
  const q: Band = qv === "good" || qv === "ok" || qv === "poor" ? qv : (worstBand(t.map(bandOf)) ?? "ok");
  return { ok: true, q, t };
}

/**
 * The receiver's per-sender limits, checked BEFORE a message is read (times from a monotonic clock, ms: web
 * performance.now(), desktop Instant; one gate per call, cleared when the call ends):
 *   read(sender, now)      false → drop unread: a message of this sender was accepted less than 2000 ms ago, or it
 *                          already made us read RXQ_MAX_ATTEMPTS messages in the current attempt window (a window opens
 *                          at the first read and lasts 2000 ms); a non-finite `now` → false. true → read it (counts
 *                          as an attempt).
 *   accepted(sender, now)  it was valid and is shown: no other message of this sender is read for 2000 ms.
 */
export class RxqGate {
  private acceptedAt = new Map<string, number>();
  private window = new Map<string, { start: number; attempts: number }>();
  read(sender: string, now: number): boolean {
    if (!Number.isFinite(now)) return false;
    const acc = this.acceptedAt.get(sender);
    if (acc !== undefined && now - acc < RXQ_MIN_GAP_MS) return false;
    let w = this.window.get(sender);
    if (!w || now - w.start >= RXQ_MIN_GAP_MS) {
      w = { start: now, attempts: 0 };
      this.window.set(sender, w);
    }
    if (w.attempts >= RXQ_MAX_ATTEMPTS) return false;
    w.attempts++;
    return true;
  }
  accepted(sender: string, now: number): void {
    if (Number.isFinite(now)) this.acceptedAt.set(sender, now);
  }
  /** A participant left: forget them. */
  forget(sender: string): void {
    this.acceptedAt.delete(sender);
    this.window.delete(sender);
  }
  clear(): void {
    this.acceptedAt.clear();
    this.window.clear();
  }
}

/** The gate + the reader, as the app runs them for one received message: "skip" (not read), "accept" (read, valid:
 *  show it), "refuse" (read, malformed). */
export function receiveRxq(gate: RxqGate, sender: string, now: number, text: string): { verdict: "skip" | "refuse" } | { verdict: "accept"; msg: Rxq } {
  if (!gate.read(sender, now)) return { verdict: "skip" };
  const d = decodeRxq(text);
  if (!d.ok) return { verdict: "refuse" };
  gate.accepted(sender, now);
  return { verdict: "accept", msg: { q: d.q, t: d.t } };
}

/** A lane that has had no accepted message for longer than RXQ_STALE_MS (monotonic ms). */
export function rxqStale(receivedAt: number | null | undefined, now: number): boolean {
  return receivedAt == null || !(now - receivedAt <= RXQ_STALE_MS);
}
