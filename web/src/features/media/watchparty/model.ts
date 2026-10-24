// watchparty/model.ts — the Browse pane's and the History's PURE model (no imports: node tests and the shared vectors
// load it): CONTRACT §3 `Item` and listings, the queue item a browse row adds, view-count text, and the History ring
// (CONTRACT §2). browse.ts re-exports these. The native twins live in watchparty.rs (norm_browse_item, queue_item_of,
// norm_history, history_push).
import type { QueueItem } from "./queue";

export const HISTORY_EVENT = "dev.tinhat.mediaparty.history";
export const HISTORY_MAX = 50;
export const HISTORY_DEBOUNCE_MS = 5_000;

/** CONTRACT §3 `Item`. */
export interface BrowseItem {
  kind: "video" | "playlist" | "channel";
  id: string;
  url: string;
  title: string;
  thumb: string;
  channel: string;
  channelId: string;
  durationSec?: number;
  views?: number;
  publishedAt?: string;
  itemCount?: number;
}
export interface Listing {
  id: string;
  title: string;
  channel: string;
  thumb: string;
  itemCount: number;
  items: BrowseItem[];
  nextPage: string;
}
/** CONTRACT §2: a history entry = a queue item + when / who started it. */
export interface HistoryItem extends QueueItem {
  playedAt: number;
  by: string;
}

type Json = Record<string, unknown>;
const str = (o: Json, k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
const num = (o: Json, k: string) => {
  const n = Number(o[k]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
};

export function normBrowseItem(v: unknown): BrowseItem | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Json;
  const kind = str(o, "kind") as BrowseItem["kind"];
  if (!["video", "playlist", "channel"].includes(kind)) return null;
  const id = str(o, "id");
  if (!id) return null;
  const url = str(o, "url") || (kind === "video" ? `https://www.youtube.com/watch?v=${id}` : kind === "playlist" ? `https://www.youtube.com/playlist?list=${id}` : `https://www.youtube.com/channel/${id}`);
  const it: BrowseItem = { kind, id, url, title: str(o, "title"), thumb: str(o, "thumb"), channel: str(o, "channel"), channelId: str(o, "channelId") };
  const d = num(o, "durationSec");
  if (d) it.durationSec = d;
  const vws = num(o, "views");
  if (vws) it.views = vws;
  if (str(o, "publishedAt")) it.publishedAt = str(o, "publishedAt");
  const c = num(o, "itemCount");
  if (c) it.itemCount = c;
  return it;
}
export function normItems(v: unknown): BrowseItem[] {
  const arr = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as Json).items) ? ((v as Json).items as unknown[]) : [];
  return arr.map(normBrowseItem).filter((x): x is BrowseItem => !!x);
}
export function normListing(v: unknown): Listing | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Json;
  return { id: str(o, "id"), title: str(o, "title"), channel: str(o, "channel"), thumb: str(o, "thumb"), itemCount: num(o, "itemCount") ?? 0, items: normItems(o.items), nextPage: str(o, "nextPage") };
}
/** A browse item → the queue item it adds (pure; the native builds the same; `addedBy` = ""). */
export function queueItemOf(it: BrowseItem, music = false): QueueItem {
  const q: QueueItem = { url: it.url, title: it.title, addedBy: "", kind: music ? "song" : "video", source: { service: music ? "ytmusic" : "youtube", url: it.url, id: it.id } };
  if (it.thumb) q.art = it.thumb;
  if (it.channel) q.artist = it.channel;
  if (it.durationSec) q.durationSec = it.durationSec;
  return q;
}
/** "1.2M views", "48K views", "317 views". */
export function fmtViews(n: number | undefined): string {
  if (!n) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K views`;
  return `${n} views`;
}

// ---- history ring (CONTRACT §2): newest first, max 50, de-duplicated by url (a replay moves it to the top) ----------
export function normHistory(c: unknown): HistoryItem[] {
  const o = (c && typeof c === "object" ? c : {}) as Json;
  const arr = Array.isArray(o.items) ? o.items : [];
  const out: HistoryItem[] = [];
  for (const v of arr) {
    if (!v || typeof v !== "object") continue;
    const i = v as Json;
    const url = typeof i.url === "string" ? i.url.trim() : "";
    if (!url) continue;
    const playedAt = Number(i.playedAt);
    out.push({ ...i, url, title: typeof i.title === "string" ? i.title : "", addedBy: typeof i.addedBy === "string" ? i.addedBy : "", playedAt: Number.isFinite(playedAt) ? Math.max(0, Math.trunc(playedAt)) : 0, by: typeof i.by === "string" ? i.by : "" } as HistoryItem);
    if (out.length >= HISTORY_MAX) break;
  }
  return out;
}
export function historyPush(items: HistoryItem[], item: QueueItem, playedAt: number, by: string): HistoryItem[] {
  const entry: HistoryItem = { ...item, playedAt, by };
  return [entry, ...items.filter((h) => h.url !== item.url)].slice(0, HISTORY_MAX);
}
