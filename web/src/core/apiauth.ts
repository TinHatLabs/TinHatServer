// apiauth.ts — which Tin Hat API routes carry the caller's Matrix bearer (pure: apiauth.test.ts). The contract is the
// server's docs/API.md "Who may use the extras" (0.3.4, security review 2026-10-26): the GIF picker (/gifs/*), Media
// Party (/watch/*) and the soundboard search spend the owner's Giphy / YouTube quota and fetch from myinstants, so a
// signed-in app sends its token there (a server before 0.3.4 ignores it); and a myinstants clip the app plays itself
// (fetch → Web Audio, never a header-less <audio>) is fetched WITH the bearer from /soundboard/clip, so the server may
// fetch a clip it hasn't cached yet. The desktop's proxy uses the same list. Paths are API paths ("/gifs/search?q=x"),
// without the /api base.

/** Path prefixes whose requests carry `Authorization: Bearer <matrix token>`. */
export const AUTH_PREFIXES: readonly string[] = Object.freeze([
  "/vods/",
  "/admin/",
  "/moderation/",
  "/soundboard/upload", // + /soundboard/uploads
  "/games/",
  // 0.3.4: the quota-spending extras
  "/gifs/",
  "/watch/",
  "/soundboard/search",
  "/soundboard/clip", // the clip cache (and /soundboard/clip/sign): the bytes the app plays itself
]);

/** Does this API path (with its query) take the bearer? A path that leaves its route by "..", "//", a backslash or
 *  an encoded slash never does. */
export function apiPathNeedsBearer(path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  const p = path.split(/[?#]/, 1)[0]!;
  if (p.includes("..") || p.includes("//") || p.includes("\\") || /%2f|%5c|%2e/i.test(p)) return false;
  return AUTH_PREFIXES.some((x) => p.startsWith(x));
}
