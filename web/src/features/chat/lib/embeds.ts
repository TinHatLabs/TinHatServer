// embeds.ts — 1:1 port of embeds.rs (click-to-play media embeds, reply-fallback strip, spoilers).
// Pure: no Matrix, no network. The Twitch `parent=` is the page's own hostname (native: localhost).

export type EmbedMode = "iframe" | "video" | "image";
export type EmbedLayout = "video" | "audioSm" | "audioLg" | "gif";
export interface Embed {
  id: string;
  platform: string;
  mode: EmbedMode;
  src: string;
  poster?: string;
  label: string;
  layout: EmbedLayout;
  /** the original link (↗ "Open link") */
  url: string;
  /** image mode: shows by itself (true only for Giphy, the GIF picker's provider); otherwise "GIF from <host> — click
   *  to show" and nothing is fetched until the click (security review 2026-10-26, M9; embeds.rs `autoload`) */
  autoload?: boolean;
  /** image mode: the link's host as shown on that face */
  host?: string;
}

/** Giphy's own hosts (giphy.com and its media subdomains: media*.giphy.com, i.giphy.com) — embeds.rs is_giphy_host. */
export function isGiphyHost(host: string): boolean {
  return host === "giphy.com" || host.endsWith(".giphy.com");
}

const MAX_EMBEDS = 3;
export const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

function twitchParent(): string {
  try {
    return location.hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/** Strip a rich-reply fallback: leading "> " quote lines + one blank line after. */
export function stripReplyFallback(text: string): string {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].startsWith("> ")) i++;
  if (i > 0 && i < lines.length && lines[i].trim() === "") i++;
  return i > 0 ? lines.slice(i).join("\n") : text;
}

export function extractEmbeds(body: string): Embed[] {
  const stripped = stripReplyFallback(body);
  const out: Embed[] = [];
  const seen = new Set<string>();
  for (const m of stripped.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,!?)\]]+$/, "");
    const e = parseEmbed(raw);
    if (!e || !e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
    if (out.length >= MAX_EMBEDS) break;
  }
  return out;
}

/** The body is exactly one URL whose embed is image/video → hide the URL text, show the card. */
export function bodyIsOnlyEmbed(body: string): boolean {
  const t = stripReplyFallback(body).trim();
  if (!t || t.split(/\s+/).length !== 1) return false;
  const e = parseEmbed(t);
  return !!e && (e.mode === "image" || e.mode === "video");
}

const isYtId = (s: string) => s.length >= 6 && /^[A-Za-z0-9_-]+$/.test(s);

function parseYtStart(u: URL): number | null {
  const raw = u.searchParams.get("t") ?? u.searchParams.get("start");
  if (raw == null) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  let total = 0;
  let cur = 0;
  let any = false;
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") cur = cur * 10 + (ch.charCodeAt(0) - 48);
    else {
      const mult = ch === "h" ? 3600 : ch === "m" ? 60 : ch === "s" ? 1 : -1;
      if (mult < 0) return null;
      total += cur * mult;
      cur = 0;
      any = true;
    }
  }
  return any ? total : null;
}

function enc(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-_.~]/.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function mk(src: string, platform: string, mode: EmbedMode, label: string, layout: EmbedLayout, url: string, poster?: string): Embed {
  const e: Embed = { id: src, platform, mode, src, label, layout, url };
  if (poster) e.poster = poster;
  return e;
}

export function parseEmbed(raw: string): Embed | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const segs = u.pathname.split("/").filter((p) => p !== "");
  const yt = (id: string, label = "YouTube") => {
    let src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
    const s = parseYtStart(u);
    if (s != null) src += `&start=${s}`;
    return mk(src, "youtube", "iframe", label, "video", raw, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  };
  if (host === "youtu.be" && segs[0] && isYtId(segs[0])) return yt(segs[0]);
  // Media Party 11.4: a YouTube Music link is the same video (the card says where it came from)
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
    const v = u.searchParams.get("v");
    if (v && isYtId(v)) return yt(v, host === "music.youtube.com" ? "YouTube Music" : "YouTube");
    if (segs.length >= 2 && ["shorts", "embed", "live"].includes(segs[0]) && isYtId(segs[1])) return yt(segs[1]);
  }
  if (host === "vimeo.com" && segs[0] && /^\d+$/.test(segs[0])) {
    const src = `https://player.vimeo.com/video/${segs[0]}?autoplay=1`;
    return mk(src, "vimeo", "iframe", "Vimeo", "video", raw);
  }
  if (host === "streamable.com" && segs[0] && segs[0] !== "e" && /^[A-Za-z0-9]+$/.test(segs[0])) {
    const src = `https://streamable.com/e/${segs[0]}?autoplay=1`;
    return mk(src, "streamable", "iframe", "Streamable", "video", raw);
  }
  const parent = twitchParent();
  if (host === "clips.twitch.tv" && segs[0]) {
    const src = `https://clips.twitch.tv/embed?clip=${segs[0]}&parent=${parent}&autoplay=true`;
    return mk(src, "twitch", "iframe", "Twitch", "video", raw);
  }
  if (host === "twitch.tv") {
    if (segs.length >= 3 && segs[1] === "clip") {
      const src = `https://clips.twitch.tv/embed?clip=${segs[2]}&parent=${parent}&autoplay=true`;
      return mk(src, "twitch", "iframe", "Twitch", "video", raw);
    }
    if (segs.length >= 2 && segs[0] === "videos") {
      const src = `https://player.twitch.tv/?video=${segs[1]}&parent=${parent}&autoplay=true`;
      return mk(src, "twitch", "iframe", "Twitch", "video", raw);
    }
    if (segs[0]) {
      const src = `https://player.twitch.tv/?channel=${segs[0]}&parent=${parent}&autoplay=true`;
      return mk(src, "twitch", "iframe", "Twitch", "video", raw);
    }
  }
  if (host === "open.spotify.com" && segs.length >= 2) {
    // Media Party 11.4: the localised /intl-xx/ prefix is skipped
    const sp = segs[0].startsWith("intl-") ? segs.slice(1) : segs;
    const kind = sp[0];
    if (sp.length >= 2 && ["track", "album", "playlist", "episode", "show", "artist"].includes(kind)) {
      const src = `https://open.spotify.com/embed/${kind}/${sp[1]}`;
      const layout: EmbedLayout = ["album", "playlist", "show", "artist"].includes(kind) ? "audioLg" : "audioSm";
      return mk(src, "spotify", "iframe", "Spotify", layout, raw);
    }
  }
  // Media Party 11.4: Apple Music — embed.music.apple.com plays 30 s previews (full songs need a subscription in
  // Apple's own player); /<cc>/album/<slug>/<id>[?i=<track>] · /<cc>/song/<slug>/<id> · /<cc>/playlist/<slug>/pl.<id>
  if (host === "music.apple.com" || host === "geo.music.apple.com") {
    const cc = segs[0] && /^[a-z]{2}$/i.test(segs[0]) ? segs[0].toLowerCase() : "us";
    const p = segs[0] && /^[a-z]{2}$/i.test(segs[0]) ? segs.slice(1) : segs;
    const last = p[p.length - 1] ?? "";
    if (p[0] === "album" && p.length >= 3 && /^\d+$/.test(last)) {
      const i = u.searchParams.get("i");
      const track = i && /^\d+$/.test(i) ? i : "";
      const src = `https://embed.music.apple.com/${cc}/album/${p[1]}/${last}${track ? `?i=${track}` : ""}`;
      return mk(src, "apple", "iframe", "Apple Music", track ? "audioSm" : "audioLg", raw);
    }
    if (p[0] === "song" && p.length >= 3 && /^\d+$/.test(last)) return mk(`https://embed.music.apple.com/${cc}/song/${p[1]}/${last}`, "apple", "iframe", "Apple Music", "audioSm", raw);
    if (p[0] === "playlist" && p.length >= 3 && /^pl\.[A-Za-z0-9]+$/.test(last)) return mk(`https://embed.music.apple.com/${cc}/playlist/${p[1]}/${last}`, "apple", "iframe", "Apple Music", "audioLg", raw);
  }
  if (host === "soundcloud.com" && segs.length >= 2 && segs[0] !== "discover" && segs[0] !== "you") {
    const canonical = `https://soundcloud.com/${segs.join("/")}`;
    const src = `https://w.soundcloud.com/player/?url=${enc(canonical)}&color=%23ff5500&auto_play=true&hide_related=true&show_comments=false&show_artwork=true`;
    return mk(src, "soundcloud", "iframe", "SoundCloud", "audioSm", raw);
  }
  const p = u.pathname.toLowerCase();
  if (p.endsWith(".mp4") || p.endsWith(".webm") || p.endsWith(".mov")) return mk(raw, "media", "video", "Video", "video", raw);
  if (p.endsWith(".gifv")) {
    const mp4 = raw.slice(0, raw.length - 5) + ".mp4";
    return mk(mp4, "media", "video", "Video", "video", raw);
  }
  if (p.endsWith(".gif")) {
    // M9: a GIF shows by itself only from Giphy; from any other host it waits for a click (EmbedCard), so a stranger's
    // link can't make every reader's browser fetch their file (address + time of reading)
    const e = mk(raw, "media", "image", "GIF", "gif", raw);
    e.autoload = isGiphyHost(host);
    e.host = u.hostname.toLowerCase();
    return e;
  }
  return null;
}

/** Link-preview candidate (linkpreview.rs): first URL, real dotted host, not matrix.to, not an embed, not a file. */
export function previewCandidate(body: string): string | null {
  const stripped = stripReplyFallback(body);
  const m = /\bhttps?:\/\/[^\s<>"')]+/i.exec(stripped);
  if (!m) return null;
  const raw = m[0].replace(/[)\].,!?;:'"]+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")) return null;
  if (host === "matrix.to") return null;
  if (parseEmbed(raw)) return null;
  if (/\.(png|jpe?g|gif|webp|svg|mp4|webm|mp3|ogg|pdf|zip|7z|exe)$/i.test(u.pathname)) return null;
  return raw;
}

// Spoilers (embeds.rs hide_spoilers) are hidden on the sanitised DOM by html.ts — never by a regex over serialised HTML
// (security review 2026-10-26: a fake spoiler inside an attribute value broke out of it on older serialisers).
