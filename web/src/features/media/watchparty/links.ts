// watchparty/links.ts — Media Party link parsing (11.4, DESIGN §2.5 / CONTRACT §3), the byte-compatible twin of the
// native crates/app/src/medialinks.rs. PURE: no Matrix, no network. One function, `parseMediaLink(text)`, classifies
// what a person pasted or a chat card carries:
//   youtube   www./m./youtube.com/watch?v= · youtu.be/<id> · /shorts/ /live/ /embed/ /v/ · youtube-nocookie.com
//   ytmusic   music.youtube.com/watch?v= (a song — plays as the YouTube video) · music.youtube.com/playlist?list=
//   playlist  youtube.com/playlist?list= (and a watch url's &list= rides along as `list`)
//   channel   youtube.com/@handle · /channel/<id> · /c/<name> · /user/<name>
//   spotify   open.spotify.com/(intl-xx/)?(track|album|playlist)/<id> · spotify:track:<id>
//   apple     music.apple.com/<cc>/album/<slug>/<albumId>?i=<trackId> · /song/<slug>/<id> · /playlist/<slug>/pl.<id>
//   file      a direct media url (mp4/webm/ogv/ogg/mov/mp3/m4a/opus/wav/flac/m3u8)
//   link      any other http(s) url (the desktop's mpv + yt-dlp may still play it; the browser cannot)
//   text      not a url → a search query
// The shared vectors live in testvectors/mediaparty/links.json (both repos): every URL shape → this exact result.

export type MediaLinkKind = "youtube" | "ytmusic" | "playlist" | "channel" | "spotify" | "apple" | "file" | "link" | "text";
export type MediaService = "youtube" | "ytmusic" | "spotify" | "apple";

export interface MediaLink {
  kind: MediaLinkKind;
  /** the input, trimmed */
  input: string;
  /** youtube / ytmusic / spotify / apple */
  service?: MediaService;
  /** the service id: video id, playlist id, channel id/handle, Spotify id, Apple track/album/playlist id */
  id?: string;
  /** spotify / apple: track | album | playlist (apple album link with ?i= → track) */
  entity?: "track" | "album" | "playlist";
  /** youtube: the canonical watch url (what PLAYS); ytmusic: the same; file/link: the input */
  playUrl?: string;
  /** youtube: a &list= on a watch url */
  list?: string;
  /** youtube: ?t= / ?start= in seconds */
  start?: number;
  /** youtube / ytmusic video: the hqdefault thumbnail */
  art?: string;
  /** channel: the @handle (with the @) when the link was one */
  handle?: string;
}

const YT_ID = /^[A-Za-z0-9_-]{6,64}$/;
const SP_ID = /^[A-Za-z0-9]{6,64}$/;
const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov|mp3|m4a|opus|wav|flac|m3u8)$/i;

function parseStart(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const ytVideo = (input: string, id: string, u: URL, service: MediaService): MediaLink => {
  const start = parseStart(u.searchParams.get("t") ?? u.searchParams.get("start"));
  const out: MediaLink = { kind: service === "ytmusic" ? "ytmusic" : "youtube", input, service, id, entity: "track", playUrl: `https://www.youtube.com/watch?v=${id}`, art: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  if (start > 0) out.start = start;
  const list = u.searchParams.get("list");
  if (list && YT_ID.test(list)) out.list = list;
  return out;
};

export function parseMediaLink(text: string): MediaLink {
  const input = (text ?? "").trim();
  if (!input) return { kind: "text", input };
  // spotify:track:<id> URIs
  const uri = input.match(/^spotify:(track|album|playlist):([A-Za-z0-9]{6,64})$/);
  if (uri) {
    const entity = uri[1] as "track" | "album" | "playlist";
    return { kind: "spotify", input, service: "spotify", id: uri[2], entity, playUrl: `https://open.spotify.com/${entity}/${uri[2]}` };
  }
  if (!/^https?:\/\//i.test(input) || /\s/.test(input)) return { kind: "text", input };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { kind: "text", input };
  }
  const host = u.hostname.toLowerCase();
  const bare = host.replace(/^(www|m)\./, "");
  const segs = u.pathname.split("/").filter((p) => p !== "");

  // ---- YouTube / YouTube Music -------------------------------------------------------------------------------
  if (bare === "youtu.be") {
    const id = segs[0] ?? "";
    if (YT_ID.test(id)) return ytVideo(input, id, u, "youtube");
    return { kind: "link", input, playUrl: input };
  }
  if (bare === "youtube.com" || bare === "youtube-nocookie.com" || host === "music.youtube.com") {
    const service: MediaService = host === "music.youtube.com" ? "ytmusic" : "youtube";
    const v = u.searchParams.get("v");
    if (u.pathname === "/watch" && v && YT_ID.test(v)) return ytVideo(input, v, u, service);
    const list = u.searchParams.get("list");
    if (u.pathname === "/playlist" && list && YT_ID.test(list)) {
      return { kind: "playlist", input, service, id: list, entity: "playlist", playUrl: `https://www.youtube.com/playlist?list=${list}` };
    }
    if (segs.length >= 2 && ["shorts", "live", "embed", "v"].includes(segs[0]) && YT_ID.test(segs[1])) return ytVideo(input, segs[1], u, service);
    if (segs[0]?.startsWith("@") && segs[0].length > 1) return { kind: "channel", input, service: "youtube", handle: segs[0], id: segs[0], playUrl: `https://www.youtube.com/${segs[0]}` };
    if (segs.length >= 2 && segs[0] === "channel" && YT_ID.test(segs[1])) return { kind: "channel", input, service: "youtube", id: segs[1], playUrl: `https://www.youtube.com/channel/${segs[1]}` };
    if (segs.length >= 2 && (segs[0] === "c" || segs[0] === "user")) return { kind: "channel", input, service: "youtube", id: segs[1], playUrl: `https://www.youtube.com/${segs[0]}/${segs[1]}` };
    return { kind: "link", input, playUrl: input };
  }

  // ---- Spotify ---------------------------------------------------------------------------------------------------
  if (bare === "open.spotify.com") {
    const p = segs[0]?.startsWith("intl-") ? segs.slice(1) : segs;
    if (p.length >= 2 && ["track", "album", "playlist"].includes(p[0]) && SP_ID.test(p[1])) {
      const entity = p[0] as "track" | "album" | "playlist";
      return { kind: "spotify", input, service: "spotify", id: p[1], entity, playUrl: `https://open.spotify.com/${entity}/${p[1]}` };
    }
    return { kind: "link", input, playUrl: input };
  }

  // ---- Apple Music -----------------------------------------------------------------------------------------------
  if (bare === "music.apple.com" || bare === "geo.music.apple.com") {
    // /<cc>/album/<slug>/<albumId>[?i=<trackId>] · /<cc>/song/<slug>/<id> · /<cc>/playlist/<slug>/pl.<id>
    const p = segs.length >= 1 && /^[a-z]{2}$/i.test(segs[0]) ? segs.slice(1) : segs;
    const last = p[p.length - 1] ?? "";
    if (p[0] === "album" && /^\d+$/.test(last)) {
      const i = u.searchParams.get("i");
      if (i && /^\d+$/.test(i)) return { kind: "apple", input, service: "apple", id: i, entity: "track", playUrl: input };
      return { kind: "apple", input, service: "apple", id: last, entity: "album", playUrl: input };
    }
    if (p[0] === "song" && /^\d+$/.test(last)) return { kind: "apple", input, service: "apple", id: last, entity: "track", playUrl: input };
    if (p[0] === "playlist" && /^pl\.[A-Za-z0-9]+$/.test(last)) return { kind: "apple", input, service: "apple", id: last, entity: "playlist", playUrl: input };
    return { kind: "link", input, playUrl: input };
  }

  // ---- direct media / anything else --------------------------------------------------------------------------------
  if (MEDIA_EXT.test(u.pathname)) return { kind: "file", input, playUrl: input };
  return { kind: "link", input, playUrl: input };
}

/** The badge a queue item / card shows for a service. */
export function serviceLabel(service: MediaService | undefined, kind?: string): string {
  switch (service) {
    case "spotify":
      return "Spotify";
    case "apple":
      return "Apple Music";
    case "ytmusic":
      return "YouTube Music";
    case "youtube":
      return "YouTube";
  }
  return kind === "file" ? "File" : kind === "song" ? "Song" : "";
}

/** "Open in Spotify" / "Open in Apple Music" / "Open in YouTube Music" — the item's original link. */
export function openInLabel(service: MediaService | undefined): string {
  const l = serviceLabel(service);
  return l ? `Open in ${l}` : "Open link";
}

/** The YouTube video id of a playing url (youtube / ytmusic), else "". */
export function youTubeIdOf(url: string): string {
  const l = parseMediaLink(url);
  return (l.kind === "youtube" || l.kind === "ytmusic") && l.id ? l.id : "";
}
