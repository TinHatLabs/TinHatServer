// clip.ts — where a stored sound URL is PLAYED from (native soundboard.rs clip_url_for).
//
// myinstants clips go through the server's clip cache (`/api/soundboard/clip?url=…`): myinstants'
// Cloudflare answers 403 to many clients and the browser would hit CORS anyway. Stored URLs stay
// canonical (https://www.myinstants.com/… or the absolute upload URL) — desktop peers resolve them
// with their own clip_url_for. The web uses the same-origin relative API path.
import { API_BASE } from "@/core/api";
import { pageOrigin } from "@/core/bearer";

/**
 * An absolute Tin Hat API URL re-rooted on THIS page's /api, else null: this page's own origin (a Tin Hat Server
 * hands out `https://<server>/api/…` upload and media URLs — the same origin the web app is served from). Media and
 * clips then load through this page's base path (fix/polish item 9).
 */
function rerooted(url: string): string | null {
  const own = `${pageOrigin()}/api`;
  return own.length > 4 && url.startsWith(`${own}/`) ? API_BASE + url.slice(own.length) : null;
}

/** RFC 3986 unreserved-only percent encoding (native `enc`: keeps A-Za-z0-9-_.~). */
export function pctEncode(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * URL to play a stored sound from. Idempotent: an already-mapped same-origin API URL is returned
 * unchanged; an absolute API URL of this page's origin (`https://<server>/api/…`) becomes the same-origin path.
 */
export function clipUrlFor(sourceUrl: string): string {
  const s = (sourceUrl ?? "").trim();
  if (!s) return s;
  if (s.startsWith(`${API_BASE}/`)) return s;
  const own = rerooted(s);
  if (own) return own;
  if (!(s.startsWith("/") || s.includes("myinstants.com/"))) return s;
  return `${API_BASE}/soundboard/clip?url=${pctEncode(s)}`;
}

/** Map a signed Tin Hat API media URL (vods file/thumb) onto this origin's /api (dev + staging). */
export function sameOrigin(url: string): string {
  if (!url) return url;
  return rerooted(url) ?? url;
}
