// clip.ts — where a stored sound URL is PLAYED from (native soundboard.rs clip_url_for; the rule itself is
// core/clipurl.ts, shared with the calls engine — security review 2026-10-26, M9: a foreign link plays from nowhere).
//
// myinstants clips go through the server's clip cache (`/api/soundboard/clip?url=…`): myinstants'
// Cloudflare answers 403 to many clients and the browser would hit CORS anyway. Stored URLs stay
// canonical (https://www.myinstants.com/… or the absolute upload URL) — desktop peers resolve them
// with their own clip_url_for. The web uses the same-origin relative API path.
import { pctEncode as encode } from "@/core/clipurl";
import { clipSrc, ownApiPath } from "@/core/clipsrc";

export { FOREIGN_SOUND_NOTE } from "@/core/clipurl";

/** RFC 3986 unreserved-only percent encoding (native `enc`: keeps A-Za-z0-9-_.~). */
export const pctEncode = encode;

/**
 * URL to play a stored sound from, or "" = refused (show FOREIGN_SOUND_NOTE): myinstants / relative → the clip cache,
 * an upload on this page's own server → its same-origin path, an already-mapped API path → itself, anything else → "".
 */
export function clipUrlFor(sourceUrl: string): string {
  return clipSrc(sourceUrl);
}

/** Map a signed Tin Hat API media URL (vods file/thumb) onto this origin's /api (dev + staging, and a server whose API
 *  base or former names differ from this page's origin: core/clipsrc ownApiPath). */
export function sameOrigin(url: string): string {
  return ownApiPath(url);
}
