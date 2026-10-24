// watchparty/queue.ts — the queue's PURE model (no imports, so node tests and the shared vectors can load it):
// the item shape (Media Party CONTRACT §1), its normalisation (the twin of watchparty.rs norm_queue_item), the party
// event, the next-in-queue rule, the YouTube search answer (old array / v=2 object) and (11.3 QOL) the queue ops
// moveToNext / clearPlayed / shuffleUpcoming, upcomingLabel and fmtTime. engine.ts re-exports these.

// CONTRACT §1 (11.4): a queue item — `url` always PLAYS (a song is stored with its resolved YouTube watch url), the
// optional song fields describe where it came from; every unknown field is preserved on rewrite.
export type QueueKind = "video" | "song" | "file";
export type SongService = "youtube" | "ytmusic" | "spotify" | "apple";
export const SONG_SERVICES: readonly SongService[] = ["youtube", "ytmusic", "spotify", "apple"];
export interface QueueSource {
  service: SongService;
  url: string;
  id: string;
}
export interface QueueItem {
  url: string;
  title: string;
  addedBy: string;
  kind?: QueueKind;
  source?: QueueSource;
  art?: string;
  artist?: string;
  durationSec?: number;
  preview?: string;
  /** fields a newer client wrote — kept as-is (CONTRACT §1) */
  [extra: string]: unknown;
}
export interface Party {
  queue: QueueItem[];
  hostId: string;
}
export interface SearchResult {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
}

type Json = Record<string, unknown>;

export function asU64(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.max(0, Math.trunc(Number(v)));
  return null;
}

/** One queue item as both apps agree on it (native watchparty.rs norm_queue_item): `url` trimmed and required (an item
 *  without one is dropped), `title` / `addedBy` strings, the optional song fields normalised when present (an empty or
 *  wrong-typed one is dropped; `kind` must be video | song | file), everything else kept as-is. */
export function normQueueItem(it: unknown): QueueItem | null {
  if (!it || typeof it !== "object" || Array.isArray(it)) return null;
  const i = it as Json;
  const url = typeof i.url === "string" ? i.url.trim() : "";
  if (!url) return null;
  const out: QueueItem = { ...i, url, title: typeof i.title === "string" ? i.title : "", addedBy: typeof i.addedBy === "string" ? i.addedBy : "" };
  for (const k of ["kind", "art", "artist", "preview"] as const) {
    const v = i[k];
    if (typeof v === "string" && v.trim() && (k !== "kind" || ["video", "song", "file"].includes(v.trim()))) out[k] = v.trim() as never;
    else delete out[k];
  }
  const d = asU64(i.durationSec);
  if (d !== null && d > 0) out.durationSec = d;
  else delete out.durationSec;
  const src = i.source;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    const so = src as Json;
    const g = (k: string) => (typeof so[k] === "string" ? (so[k] as string).trim() : "");
    const service = g("service") as SongService;
    if (SONG_SERVICES.includes(service)) out.source = { service, url: g("url"), id: g("id") };
    else delete out.source;
  } else delete out.source;
  return out;
}

export function normParty(c: unknown): Party {
  const o = (c && typeof c === "object" ? c : {}) as Json;
  const q = Array.isArray(o.queue) ? o.queue : [];
  const queue: QueueItem[] = [];
  for (const it of q) {
    const n = normQueueItem(it);
    if (n) queue.push(n);
  }
  return { queue, hostId: typeof o.hostId === "string" ? o.hostId : "" };
}

/** The url after the current one in the (append-only) queue, or "". */
export function nextQueueUrl(queue: QueueItem[], nowUrl: string): string {
  if (!queue.length) return "";
  if (!nowUrl) return queue[0].url;
  const i = queue.findIndex((q) => q.url === nowUrl);
  if (i >= 0) return i + 1 < queue.length ? queue[i + 1].url : "";
  return queue[0].url;
}

/** The old `/watch/search?q=` answer (an array — kept for 11.2.1 clients) or the v=2 object → results. */
export function normalizeWatchResults(v: unknown): SearchResult[] {
  let arr: unknown[] = [];
  if (Array.isArray(v)) arr = v;
  else if (v && typeof v === "object") {
    for (const k of ["results", "items", "videos", "data"]) {
      const x = (v as Json)[k];
      if (Array.isArray(x)) {
        arr = x;
        break;
      }
    }
  }
  const out: SearchResult[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Json;
    const id = String(o.id ?? o.videoId ?? "");
    let url = typeof o.url === "string" ? o.url : typeof o.link === "string" ? o.link : "";
    if (!url && id) url = `https://www.youtube.com/watch?v=${id}`;
    if (!url) continue;
    const thumb = [o.thumbnail, o.thumbnailUrl, o.thumb].find((x) => typeof x === "string") as string | undefined;
    const title = typeof o.title === "string" && o.title ? o.title : url;
    out.push({ id, url, title, thumbnail: thumb ?? "" });
  }
  return out;
}

// ---- 11.3 QOL (the Media Party QOL spec §5): the queue ops, the "N min left" label and h:mm:ss --------
// One write each through engine.ts editQueue. Shared vectors testvectors/mediaparty/queueops.json (36 cases; the
// desktop's watchparty.rs runs the same file); reference tools/media/queueops_ref.py.

const indexOfUrl = (queue: readonly { url: string }[], nowUrl: string): number => (nowUrl ? queue.findIndex((q) => q.url === nowUrl) : -1);

/** "Play next": the item at `from` moves right after the playing one (nothing playing / not in the queue → the top).
 *  The playing item itself, or an index out of range, leaves the queue as it is. */
export function moveToNext<T extends { url: string }>(queue: readonly T[], nowUrl: string, from: number): T[] {
  const q = [...queue];
  if (!Number.isInteger(from) || from < 0 || from >= q.length) return q;
  if (from === indexOfUrl(q, nowUrl)) return q;
  const [it] = q.splice(from, 1);
  q.splice(indexOfUrl(q, nowUrl) + 1, 0, it);
  return q;
}

/** "Clear played": drop everything above the playing item (nothing playing / it is first → unchanged). */
export function clearPlayed<T extends { url: string }>(queue: readonly T[], nowUrl: string): T[] {
  const ni = indexOfUrl(queue, nowUrl);
  return ni <= 0 ? [...queue] : queue.slice(ni);
}

/** mulberry32 (bit-for-bit the reference's): a seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "Shuffle": a seeded Fisher–Yates over the items AFTER the playing one (all of them when nothing plays). */
export function shuffleUpcoming<T extends { url: string }>(queue: readonly T[], nowUrl: string, seed: number): T[] {
  const ni = indexOfUrl(queue, nowUrl);
  const start = ni >= 0 ? ni + 1 : 0;
  const head = queue.slice(0, start);
  const up = queue.slice(start);
  const r = mulberry32(seed);
  for (let i = up.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [up[i], up[j]] = [up[j], up[i]];
  }
  return [...head, ...up];
}

function fmtMinutes(mins: number): string {
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** What is left after the playing item: "48 min left", "1 h 5 min+ left" (+ = some durations unknown), "" when nothing
 *  upcoming has a known duration. */
export function upcomingLabel(queue: readonly { url: string; durationSec?: unknown }[], nowUrl: string): string {
  const ni = indexOfUrl(queue, nowUrl);
  const up = ni >= 0 ? queue.slice(ni + 1) : queue;
  if (!up.length) return "";
  const dur = (it: { durationSec?: unknown }) => (typeof it.durationSec === "number" && it.durationSec > 0 ? it.durationSec : 0);
  const known = up.reduce((sum, it) => sum + Math.trunc(dur(it)), 0);
  const unknown = up.some((it) => !(dur(it) > 0));
  if (known === 0) return "";
  const mins = Math.floor(known / 60 + 0.5);
  return `${fmtMinutes(mins)}${unknown ? "+" : ""} left`;
}

/** h:mm:ss from one hour, else m:ss (floor, ≥ 0; anything not a finite number → "0:00"). */
export function fmtTime(secs: unknown): string {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return "0:00";
  const t = Math.max(0, Math.floor(secs));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}
