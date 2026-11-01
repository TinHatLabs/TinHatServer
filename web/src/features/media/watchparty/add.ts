// watchparty/add.ts — "paste any link in the one box" (DESIGN §2.3) and the song pipeline (§2.5, CONTRACT §1/§3):
// a pasted / searched / chat link → a queue item. Pure classification is links.ts; this file talks to the Tin Hat API
// routes (/api/watch/meta, /api/watch/resolve) and the engine. The native twin is watchparty.rs `add_link`.
//   youtube / ytmusic  → the canonical watch url plays; title + duration from /watch/meta (else /watch/oembed, else "")
//   file / link        → the url itself plays (the browser only plays direct media — WEB-EXCEPTIONS); title = the name
//   spotify / apple    → /watch/meta (title, artist, art, preview) → /watch/resolve (the YouTube match); matched: a song
//                        item with url = the YouTube watch url; no match: a CARD (not queued) with Open-in + preview
//   playlist / channel → the browse pane (U4) lists them; here = "card" with the link so the caller can open the tab
//   text               → a search
import { apiFetch } from "@/core/api";
import { createLogger } from "@/core/log";
import { enqueueItem, joinParty, playUrl, useWatchParty, type QueueItem } from "./engine";
import { parseMediaLink, type MediaLink } from "./links";

const log = createLogger("mediaparty.add");

export { normMeta, normResolved, itemFor } from "./meta";
export type { LinkMeta, Resolved } from "./meta";
import { itemFor, normMeta, normResolved, type LinkMeta, type Resolved } from "./meta";

export type AddOutcome =
  | { status: "queued"; item: QueueItem }
  | { status: "playing"; item: QueueItem }
  | { status: "search"; query: string }
  | { status: "browse"; link: MediaLink }
  /** a song nobody could match on YouTube (or an album/playlist): show the card, nothing queued */
  | { status: "card"; link: MediaLink; meta: LinkMeta | null; message: string }
  | { status: "error"; message: string }
  /** `lookupOnly`: the item the link resolved to, NOT queued (the Pad checks it first, then queues — Pad QOL) */
  | { status: "resolved"; item: QueueItem };

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

/** /watch/meta for a link (best effort: null when the route is missing or the link unknown). */
export async function fetchMeta(url: string, signal?: AbortSignal): Promise<LinkMeta | null> {
  try {
    const r = await getJson(`/watch/meta?url=${encodeURIComponent(url)}`, signal);
    return r.ok ? normMeta(r.body) : null;
  } catch (e) {
    log.debug(`meta: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/** The oEmbed title of a YouTube url through the proxy (what the native does), "" when unavailable. */
async function oembedTitle(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const r = await getJson(`/watch/oembed?url=${encodeURIComponent(url)}`, signal);
    const t = r.ok && r.body && typeof (r.body as { title?: unknown }).title === "string" ? ((r.body as { title: string }).title ?? "").trim() : "";
    return t;
  } catch {
    return "";
  }
}

export type ResolveOutcome = { ok: true; hit: Resolved } | { ok: false; why: "nomatch" | "budget" | "error"; resetAt?: number };

/** /watch/resolve: a song (by its link, or artist + title) → its YouTube upload. */
export async function resolveSong(q: { url?: string; artist?: string; title?: string }, signal?: AbortSignal): Promise<ResolveOutcome> {
  const qs = q.url ? `url=${encodeURIComponent(q.url)}` : `artist=${encodeURIComponent(q.artist ?? "")}&title=${encodeURIComponent(q.title ?? "")}`;
  try {
    const r = await getJson(`/watch/resolve?${qs}`, signal);
    if (r.ok) {
      const hit = normResolved(r.body);
      return hit ? { ok: true, hit } : { ok: false, why: "error" };
    }
    const err = (r.body as { error?: string; resetAt?: number } | null)?.error;
    if (r.status === 404 || err === "nomatch") return { ok: false, why: "nomatch" };
    if (r.status === 503 || err === "budget") return { ok: false, why: "budget", resetAt: Number((r.body as { resetAt?: number })?.resetAt) || undefined };
    return { ok: false, why: "error" };
  } catch (e) {
    log.warn(`resolve: ${(e as Error)?.message ?? e}`);
    return { ok: false, why: "error" };
  }
}

/** Text from the one box / a chat card → queued (or playing), a search, a browse target, a card, or an error. */
export async function addLink(text: string, opts: { playNow?: boolean; signal?: AbortSignal; lookupOnly?: boolean } = {}): Promise<AddOutcome> {
  const link = parseMediaLink(text);
  if (link.kind === "text") return { status: "search", query: link.input };
  if (link.kind === "playlist" || link.kind === "channel") return { status: "browse", link };
  if (!useWatchParty.getState().inParty) return { status: "error", message: "Join the Media Party first." };
  const commit = (item: QueueItem): AddOutcome => {
    if (opts.lookupOnly) return { status: "resolved", item };
    if (opts.playNow) {
      enqueueItem(item);
      playUrl(item.url);
      return { status: "playing", item };
    }
    enqueueItem(item);
    return { status: "queued", item };
  };
  if (link.kind === "youtube" || link.kind === "ytmusic") {
    let meta = await fetchMeta(link.input, opts.signal);
    if (!meta) {
      const t = await oembedTitle(link.playUrl ?? link.input, opts.signal);
      if (t) meta = { kind: "video", service: link.kind === "ytmusic" ? "ytmusic" : "youtube", id: link.id ?? "", url: link.input, title: t };
    }
    const it = itemFor(link, meta);
    return it ? commit(it) : { status: "error", message: "Couldn't add this link." };
  }
  if (link.kind === "file" || link.kind === "link") {
    const it = itemFor(link, null);
    return it ? commit(it) : { status: "error", message: "Couldn't add this link." };
  }
  // spotify / apple: a song → its YouTube upload; an album / playlist → the card with its tracks
  const meta = await fetchMeta(link.input, opts.signal);
  if (link.entity !== "track") return { status: "card", link, meta, message: meta ? `${meta.kind === "album" ? "An album" : "A playlist"} — add its songs from the card.` : "Couldn't read this link." };
  const r = await resolveSong({ url: link.input }, opts.signal);
  if (r.ok) {
    const it = itemFor(link, meta, r.hit);
    return it ? commit(it) : { status: "error", message: "Couldn't add this song." };
  }
  if (r.why === "budget") return { status: "card", link, meta, message: "YouTube search is used up for today — open it in its app, or paste a YouTube link." };
  if (r.why === "nomatch") return { status: "card", link, meta, message: "No YouTube upload of this song was found — open it in its app." };
  return { status: "card", link, meta, message: "Couldn't look this song up right now — open it in its app." };
}

/** A chat card's "Add to Media Party" / "Play now": join `roomId`'s party first when I'm not in one (joinParty is
 *  destructive — never re-join while watching), then run the link pipeline. */
export async function addLinkToParty(roomId: string, url: string, playNow = false): Promise<AddOutcome> {
  const st = useWatchParty.getState();
  if (!st.inParty) joinParty(roomId);
  else if (st.roomId !== roomId) return { status: "error", message: "You're in another room's Media Party — leave it first." };
  return addLink(url, { playNow });
}
