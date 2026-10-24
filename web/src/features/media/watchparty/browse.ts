// watchparty/browse.ts — the Browse pane's data (11.4, DESIGN §2.4 / CONTRACT §3): YouTube search (v=2, typed),
// autocomplete, trending, playlists / channels, and the room's play History (CONTRACT §2). One zustand store; the
// native twin is watchparty.rs `browse` / `suggest` / history. Everything goes through the Tin Hat API (/api/watch/*),
// which caches and counts the Data API units; a 503 {error:"budget"} = "YouTube search is used up for today".
import { create } from "zustand";
import { apiFetch } from "@/core/api";
import { createLogger } from "@/core/log";

const log = createLogger("mediaparty.browse");

export type BrowseTab = "search" | "music" | "trending" | "playlists" | "history";
export type SearchType = "video" | "music" | "playlist" | "channel";
export const SEARCH_TYPES: readonly { id: SearchType; label: string }[] = [
  { id: "video", label: "Videos" },
  { id: "music", label: "Music" },
  { id: "playlist", label: "Playlists" },
  { id: "channel", label: "Channels" },
];
/** Trending categories (YouTube Data API videoCategoryId): All · Music · Gaming · Film · Entertainment · Sports · Science */
export const TRENDING_CATS: readonly { id: number; label: string }[] = [
  { id: 0, label: "All" },
  { id: 10, label: "Music" },
  { id: 20, label: "Gaming" },
  { id: 1, label: "Film" },
  { id: 24, label: "Entertainment" },
  { id: 17, label: "Sports" },
  { id: 28, label: "Science" },
];
export const BUDGET_MESSAGE = "YouTube search is used up for today — paste a link or use Trending / History.";
export {
  HISTORY_EVENT,
  HISTORY_MAX,
  HISTORY_DEBOUNCE_MS,
  normBrowseItem,
  normItems,
  normListing,
  queueItemOf,
  fmtViews,
  normHistory,
  historyPush,
} from "./model";
export type { BrowseItem, Listing, HistoryItem } from "./model";
import { normItems, normListing, type BrowseItem, type Listing } from "./model";

type Json = Record<string, unknown>;
const str = (o: Json, k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");

// ---- the store --------------------------------------------------------------------------------------------------
export interface BrowseState {
  tab: BrowseTab;
  type: SearchType;
  cat: number;
  /** the last query the Search / Music tabs ran */
  query: string;
  suggestions: string[];
  items: BrowseItem[];
  nextPage: string;
  loading: boolean;
  error: string;
  /** the Data API day is used up (search / resolve) */
  budget: boolean;
  listing: Listing | null;
  listingLoading: boolean;
  listingError: string;
  /** the open listing came from a YouTube Music link (or the Music tab): its items queue as songs (service ytmusic) */
  listingMusic: boolean;
}
export const useBrowse = create<BrowseState>()(() => ({
  tab: "search",
  type: "video",
  cat: 0,
  query: "",
  suggestions: [],
  items: [],
  nextPage: "",
  loading: false,
  error: "",
  budget: false,
  listing: null,
  listingLoading: false,
  listingError: "",
  listingMusic: false,
}));
const set = useBrowse.setState;
const get = useBrowse.getState;

async function getJson(path: string, signal?: AbortSignal): Promise<{ ok: true; body: unknown } | { ok: false; status: number; body: unknown }> {
  const r = await apiFetch(path, { signal });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return r.ok ? { ok: true, body } : { ok: false, status: r.status, body };
}
const isBudget = (r: { ok: false; status: number; body: unknown }) => r.status === 503 && (r.body as { error?: string } | null)?.error === "budget";

export function setTab(tab: BrowseTab): void {
  set({ tab });
  if (tab === "trending" && !get().items.length) void loadTrending(get().cat);
}

let searchAbort: AbortController | null = null;
/** Search (v=2): `type` video | music | playlist | channel; `page` = the previous answer's nextPage (append). */
export async function searchYouTube(q: string, type: SearchType = get().type, page = ""): Promise<void> {
  const query = q.trim();
  searchAbort?.abort();
  if (!query) {
    set({ items: [], nextPage: "", query: "", loading: false, error: "" });
    return;
  }
  const ctl = new AbortController();
  searchAbort = ctl;
  set({ loading: true, error: "", query, type, ...(page ? {} : { items: [], nextPage: "" }) });
  try {
    const r = await getJson(`/watch/search?q=${encodeURIComponent(query)}&type=${type}&max=25&v=2${page ? `&page=${encodeURIComponent(page)}` : ""}`, ctl.signal);
    if (ctl.signal.aborted) return;
    if (!r.ok) {
      if (isBudget(r)) {
        set({ loading: false, budget: true, error: BUDGET_MESSAGE });
        return;
      }
      throw new Error(`HTTP ${r.status}`);
    }
    const o = (r.body ?? {}) as Json;
    const items = normItems(o.items);
    set({ loading: false, items: page ? [...get().items, ...items] : items, nextPage: str(o, "nextPage"), budget: false });
  } catch (e) {
    if (ctl.signal.aborted) return;
    log.warn(`search: ${(e as Error)?.message ?? e}`);
    set({ loading: false, error: "Couldn't search YouTube right now." });
  }
}

let suggestTimer = 0;
let suggestAbort: AbortController | null = null;
const suggestCache = new Map<string, string[]>();
/** Autocomplete (debounced 350 ms — the proxy's 30/min bucket is shared), cached per query. */
export function suggest(q: string): void {
  const query = q.trim().toLowerCase();
  window.clearTimeout(suggestTimer);
  suggestAbort?.abort();
  if (!query) {
    set({ suggestions: [] });
    return;
  }
  const hit = suggestCache.get(query);
  if (hit) {
    set({ suggestions: hit });
    return;
  }
  suggestTimer = window.setTimeout(async () => {
    const ctl = new AbortController();
    suggestAbort = ctl;
    try {
      const r = await getJson(`/watch/suggest?q=${encodeURIComponent(query)}`, ctl.signal);
      if (ctl.signal.aborted || !r.ok) return;
      const list = Array.isArray(r.body) ? (r.body as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 10) : [];
      suggestCache.set(query, list);
      set({ suggestions: list });
    } catch {
      /* best effort */
    }
  }, 350);
}
export function clearSuggestions(): void {
  window.clearTimeout(suggestTimer);
  set({ suggestions: [] });
}

const trendingCache = new Map<number, { at: number; items: BrowseItem[] }>();
export async function loadTrending(cat: number): Promise<void> {
  set({ cat, tab: "trending", error: "" });
  const c = trendingCache.get(cat);
  if (c && Date.now() - c.at < 3600_000) {
    set({ items: c.items, nextPage: "", loading: false });
    return;
  }
  set({ loading: true, items: [], nextPage: "" });
  try {
    const r = await getJson(`/watch/trending?cat=${cat}&region=US`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = normItems((r.body as Json)?.items);
    trendingCache.set(cat, { at: Date.now(), items });
    if (get().cat === cat) set({ loading: false, items });
  } catch (e) {
    log.warn(`trending: ${(e as Error)?.message ?? e}`);
    set({ loading: false, error: "Couldn't load what's trending right now." });
  }
}

/** A playlist or channel (by id / @handle), first page or the next one (append). */
export async function loadListing(kind: "playlist" | "channel", idOrHandle: string, page = "", music?: boolean): Promise<void> {
  set({ listingLoading: true, listingError: "", tab: "playlists", ...(page ? {} : { listing: null, listingMusic: !!music }) });
  const key = kind === "channel" && idOrHandle.startsWith("@") ? `handle=${encodeURIComponent(idOrHandle)}` : `id=${encodeURIComponent(idOrHandle)}`;
  try {
    const r = await getJson(`/watch/${kind}?${key}${page ? `&page=${encodeURIComponent(page)}` : ""}`);
    if (!r.ok) throw new Error(r.status === 404 ? "notfound" : `HTTP ${r.status}`);
    const l = normListing(r.body);
    if (!l) throw new Error("bad answer");
    const prev = page ? get().listing : null;
    set({ listingLoading: false, listing: prev ? { ...l, items: [...prev.items, ...l.items] } : l });
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    log.warn(`${kind}: ${m}`);
    set({ listingLoading: false, listingError: m === "notfound" ? `That ${kind} wasn't found.` : `Couldn't load that ${kind} right now.` });
  }
}
export function clearListing(): void {
  set({ listing: null, listingError: "", listingLoading: false });
}
