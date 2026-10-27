// clipurl.ts — where a stored sound URL may be PLAYED from (security review 2026-10-26, M9; the desktop's soundboard.rs
// clip_url_for, same rule): the server's clip cache for myinstants links and relative paths (myinstants' own), the
// account's own server for uploaded sounds, nothing else. A foreign link is refused with FOREIGN_SOUND_NOTE (the browser
// would otherwise fetch it — the reader's address and time to a stranger's host — and, with CORS, publish it into the
// call). The `url=` value is byte-identical with the desktop's (pctEncode = its `enc`), so stored `sourceUrl`s and the
// server's cache keys don't change. Pure (no imports): clipurl.test.ts replays the desktop's cases.

/** The note when a sound is refused (the desktop's FOREIGN_SOUND_NOTE, word for word). */
export const FOREIGN_SOUND_NOTE = "This sound isn't on your server or myinstants, so Tin Hat won't play it.";

/** RFC 3986 unreserved-only percent encoding (the desktop's `enc`: keeps A-Za-z0-9-_.~, UTF-8 bytes upper-case hex). */
export function pctEncode(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The rest of a URL after our API base: a plain path (no "/../", whitespace, control characters or backslashes). */
function plainRest(rest: string): boolean {
  return rest.startsWith("/") && !rest.includes("/../") && !/[\s\u0000-\u001f\u007f\\]/.test(rest);
}

/**
 * An absolute URL under one of this server's API bases (`ownBases`: this page's `<origin>/api`, the API base its
 * well-known announces — another host on a server whose web app has a name of its own (app on chat.example.org, API on
 * example.org) — and
 * `https://<former name>/api` for every name it had before a move; the desktop's proxy.rs known_bases) re-homed onto
 * this page's API path: `<apiBase><rest>`. null = not under any of them; "" = under one, but its rest isn't a plain path.
 */
export function rehomeApiUrl(url: string, apiBase: string, ownBases: readonly string[]): string | null {
  const base = (apiBase ?? "").replace(/\/+$/, "");
  for (const raw of ownBases) {
    const b = (raw ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]/i.test(b) || url.length <= b.length || url.slice(0, b.length).toLowerCase() !== b.toLowerCase()) continue;
    const rest = url.slice(b.length);
    if (!rest.startsWith("/")) continue; // a whole path segment only: never `<base>x…`
    return plainRest(rest) ? `${base}${rest}` : "";
  }
  return null;
}

const SOUND_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOUND_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
/** `/soundboard/clip?url=<pctEncode>`: the clip-cache form this file itself writes */
const CACHE_REST = /^\/soundboard\/clip\?url=[A-Za-z0-9%._~-]+$/;

/** Is `rest` (after an API base) one uploaded sound: exactly `/soundboard/clip?id=<id>` or `/soundboard/file/<name>`
 *  (shared rule, member-content.json `ownSounds`: no other path, no other query, no fragment, no %-escapes)? */
function soundRest(rest: string): boolean {
  let m = /^\/soundboard\/clip\?id=([^&#]*)$/.exec(rest);
  if (m) return SOUND_ID.test(m[1]!);
  m = /^\/soundboard\/file\/([^/?#]*)$/.exec(rest);
  return !!m && SOUND_NAME.test(m[1]!);
}

/** What follows `base` in `url` (base compared case-insensitively, trailing slash ignored), or null. */
function under(url: string, base: string): string | null {
  const b = (base ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]/i.test(b) || url.length <= b.length || url.slice(0, b.length).toLowerCase() !== b.toLowerCase()) return null;
  return url.slice(b.length);
}

/** Is `url` one of this server's own uploaded sounds under `base` (the shared `ownSounds` rule)? */
export function isOwnSound(url: string, base: string): boolean {
  const rest = under(String(url ?? ""), base);
  return rest !== null && soundRest(rest);
}

/** A sound uploaded on ANOTHER Tin Hat server (member-content.json `soundRoute` "foreign"):
 *  `https://<host>[:443]/api/soundboard/clip?id=[A-Za-z0-9_-]{1,128}` (no other query) or
 *  `https://<host>[:443]/api/soundboard/file/<[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}>`; the host a dotted DNS name (no IP
 *  address, no single label like localhost) other than `notHosts` (our own); no user name, no other port, no fragment,
 *  no %2e / %2f / %5c in any case, no backslash, white space or control character anywhere. It plays through OUR
 *  server's clip cache (`clip?url=`, with the bearer), never straight from that host (the owner's decision, 2026-10-26). */
export function isForeignTinHatSound(url: string, notHosts: readonly string[] = []): boolean {
  const s = String(url ?? "");
  if (/%2e|%2f|%5c/i.test(s) || /[#\s\\\u0000-\u001f\u007f]/.test(s)) return false;
  const m = /^https:\/\/([^/?@]+)(\/.*)$/i.exec(s);
  if (!m || !m[2]!.startsWith("/api/") || !soundRest(m[2]!.slice(4))) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443")) return false;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return false; // DNS, dotted, no IPv4 (IPv6 has [ ])
  return !notHosts.some((h) => h.toLowerCase() === host);
}

/** The host of an absolute base URL ("" when it isn't one). */
function hostOf(base: string): string {
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export type SoundRoute = "myinstants" | "own" | "foreign" | "refuse";

/** How stored sound `url` plays on a server whose absolute API base is `base` (the shared `soundRoute` rule, in order):
 *  myinstants (starts with "/" or contains "myinstants.com/") → `<base>/soundboard/clip?url=<pctEncode>`; own (isOwnSound)
 *  → the URL itself; foreign (isForeignTinHatSound) → `<base>/soundboard/clip?url=<pctEncode>`; else refuse. */
export function soundRoute(url: string, base: string): { route: SoundRoute; play?: string } {
  const s = typeof url === "string" ? url.trim() : "";
  const b = (base ?? "").trim().replace(/\/+$/, "");
  if (!s || !b) return { route: "refuse" };
  const cache = `${b}/soundboard/clip?url=${pctEncode(s)}`;
  if (s.startsWith("/") || s.includes("myinstants.com/")) return { route: "myinstants", play: cache };
  if (isOwnSound(s, b)) return { route: "own", play: s };
  if (isForeignTinHatSound(s, [hostOf(b)])) return { route: "foreign", play: cache };
  return { route: "refuse" };
}

/**
 * The URL to play stored sound `src` from, or "" (refused: FOREIGN_SOUND_NOTE). `apiBase` = this page's API path
 * ("/api"), `ownBases` = this server's absolute API bases (rehomeApiUrl; empty = no server known → nothing plays).
 * In order:
 *   myinstants (a link containing "myinstants.com/") or a relative path → `<apiBase>/soundboard/clip?url=<pctEncode>`;
 *   one of this server's own uploads (isOwnSound under any own base) → `<apiBase>/soundboard/…` (direct, the bearer);
 *   a sound uploaded on another Tin Hat server (isForeignTinHatSound) → our clip cache `clip?url=` (servers before
 *   0.3.4 refuse it: the player's usual "couldn't load");
 *   `<apiBase>/…` already mapped by this function → itself;
 *   anything else → "".
 */
export function clipUrlWith(src: string, apiBase: string, ownBases: readonly string[]): string {
  const s = (typeof src === "string" ? src : "").trim();
  const base = (apiBase ?? "").replace(/\/+$/, "");
  if (!s || !ownBases?.length || !base.startsWith("/")) return "";
  const cache = (x: string) => `${base}/soundboard/clip?url=${pctEncode(x)}`;
  if (s.startsWith(`${base}/`)) {
    const rest = s.slice(base.length);
    return soundRest(rest) || CACHE_REST.test(rest) ? s : "";
  }
  if (s.includes("myinstants.com/")) return cache(s);
  for (const b of ownBases) {
    const rest = under(s, b);
    if (rest !== null && (soundRest(rest) || CACHE_REST.test(rest))) return `${base}${rest}`;
  }
  if (s.startsWith("/")) return cache(s);
  if (isForeignTinHatSound(s, ownBases.map(hostOf))) return cache(s);
  return "";
}
