// watchparty/meta.ts — the song pipeline's PURE pieces (no imports beyond types): /watch/meta and /watch/resolve
// answers normalised and the queue item a link + its meta make (the twins of watchparty.rs norm_meta / norm_resolved /
// item_for). add.ts re-exports these.
import type { MediaLink } from "./links";
import type { QueueItem } from "./queue";

/** /youtube/meta (CONTRACT §3): what a link is. */
export interface LinkMeta {
  kind: "video" | "playlist" | "channel" | "song" | "album" | "unknown";
  service: "youtube" | "ytmusic" | "spotify" | "apple";
  id: string;
  url: string;
  title: string;
  artist?: string;
  album?: string;
  thumb?: string;
  durationSec?: number;
  preview?: string;
  tracks?: { title: string; artist?: string; durationSec?: number; id?: string; url?: string }[];
}
/** /youtube/resolve: the YouTube upload a song plays as. */
export interface Resolved {
  videoId: string;
  url: string;
  title: string;
  channel?: string;
  thumb?: string;
  durationSec?: number;
  confidence: number;
}

export function normMeta(v: unknown): LinkMeta | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const kind = str("kind") as LinkMeta["kind"];
  const service = str("service") as LinkMeta["service"];
  if (!["video", "playlist", "channel", "song", "album", "unknown"].includes(kind)) return null;
  if (!["youtube", "ytmusic", "spotify", "apple"].includes(service)) return null;
  const m: LinkMeta = { kind, service, id: str("id"), url: str("url"), title: str("title") };
  if (str("artist")) m.artist = str("artist");
  if (str("album")) m.album = str("album");
  if (str("thumb")) m.thumb = str("thumb");
  if (str("preview")) m.preview = str("preview");
  const d = Number(o.durationSec);
  if (Number.isFinite(d) && d > 0) m.durationSec = Math.trunc(d);
  if (Array.isArray(o.tracks)) {
    m.tracks = (o.tracks as Record<string, unknown>[])
      .filter((t) => t && typeof t === "object" && typeof t.title === "string")
      .slice(0, 50)
      .map((t) => {
        const tr: NonNullable<LinkMeta["tracks"]>[number] = { title: String(t.title) };
        if (typeof t.artist === "string") tr.artist = t.artist;
        if (typeof t.id === "string") tr.id = t.id;
        if (typeof t.url === "string") tr.url = t.url;
        const td = Number(t.durationSec);
        if (Number.isFinite(td) && td > 0) tr.durationSec = Math.trunc(td);
        return tr;
      });
  }
  return m;
}

export function normResolved(v: unknown): Resolved | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const videoId = typeof o.videoId === "string" ? o.videoId : "";
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(videoId)) return null;
  const r: Resolved = { videoId, url: typeof o.url === "string" && o.url ? o.url : `https://www.youtube.com/watch?v=${videoId}`, title: typeof o.title === "string" ? o.title : "", confidence: Number(o.confidence) || 0 };
  if (typeof o.channel === "string") r.channel = o.channel;
  if (typeof o.thumb === "string") r.thumb = o.thumb;
  const d = Number(o.durationSec);
  if (Number.isFinite(d) && d > 0) r.durationSec = Math.trunc(d);
  return r;
}

const fileName = (url: string) => {
  try {
    const p = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(p[p.length - 1] ?? "") || url;
  } catch {
    return url;
  }
};

/** The queue item a parsed link + its meta make (pure; the native builds the same object; `addedBy` = ""). */
export function itemFor(link: MediaLink, meta: LinkMeta | null, resolved?: Resolved | null): QueueItem | null {
  const me = "";
  if (link.kind === "youtube" || link.kind === "ytmusic") {
    const it: QueueItem = { url: link.playUrl ?? "", title: meta?.title ?? "", addedBy: me, kind: link.kind === "ytmusic" || meta?.kind === "song" ? "song" : "video", source: { service: link.kind === "ytmusic" ? "ytmusic" : "youtube", url: link.input, id: link.id ?? "" } };
    const art = meta?.thumb || link.art;
    if (art) it.art = art;
    if (meta?.artist) it.artist = meta.artist;
    if (meta?.durationSec) it.durationSec = meta.durationSec;
    return it;
  }
  if (link.kind === "file") return { url: link.input, title: meta?.title || fileName(link.input), addedBy: me, kind: "file" };
  if (link.kind === "link") return { url: link.input, title: meta?.title || link.input, addedBy: me };
  if ((link.kind === "spotify" || link.kind === "apple") && resolved) {
    const it: QueueItem = { url: resolved.url, title: meta?.title || resolved.title, addedBy: me, kind: "song", source: { service: link.service === "apple" ? "apple" : "spotify", url: link.input, id: link.id ?? "" } };
    const art = meta?.thumb || resolved.thumb;
    if (art) it.art = art;
    if (meta?.artist) it.artist = meta.artist;
    const d = meta?.durationSec || resolved.durationSec;
    if (d) it.durationSec = d;
    if (meta?.preview) it.preview = meta.preview;
    return it;
  }
  return null;
}
