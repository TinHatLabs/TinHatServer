// bearer.ts — where a credential may go (Astra calls review 2026-09-23, finding 12).
//
// Tin Hat Web talks to ONE homeserver: authenticated Matrix traffic goes to MATRIX_ORIGIN only, and
// application traffic with the Matrix bearer to same-origin `/api/` only. Enforced centrally:
//   • homeserverAllowed(url)  — sign-in, registration, restore, guest hand-off and client start refuse
//                               any other homeserver BEFORE a password / token is attached;
//   • bearerAllowed(url)      — every request carrying `Authorization: Bearer …` must target one of
//                               the two; installBearerGuard() wraps window.fetch so a request with a
//                               bearer to anywhere else is refused (the SDK, media, api.ts, features).
//
// A Tin Hat Server serves this web app AND its homeserver from one origin, so the one homeserver is this page's own
// origin (the server's /.well-known/matrix/client says the rest: core/server). In `vite` dev the dev server proxies the
// homeserver's paths to TH_DEV_SERVER (vite.config.ts), so the page's origin is still the one homeserver.

/** This page's origin ("" outside a browser). */
export function pageOrigin(): string {
  return typeof location !== "undefined" ? location.origin : "";
}

export const MATRIX_ORIGIN: string = pageOrigin();
/** How the UI names the one server it talks to: this page's address. */
export const SERVER_LABEL: string = typeof location !== "undefined" ? location.host : "";

/** DEV mode only (`vite` dev; `pnpm build` is production mode, where this is a false constant): the dev server on this
 *  machine's loopback address, plain http — it proxies the homeserver (vite.config.ts), so it may carry the session
 *  like the server's own origin does. Exactly the page's own origin still: no other host or port. */
const DEV_LOOPBACK: boolean = import.meta.env.DEV && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(MATRIX_ORIGIN);

function parse(u: string): URL | null {
  try {
    return new URL(u, typeof location !== "undefined" ? location.href : MATRIX_ORIGIN);
  } catch {
    return null;
  }
}

/** A homeserver base URL we may hand credentials to: exactly MATRIX_ORIGIN. */
export function homeserverAllowed(hsUrl: string | null | undefined): boolean {
  if (!hsUrl || !(/^https:\/\//i.test(hsUrl.trim()) || (DEV_LOOPBACK && /^http:\/\//i.test(hsUrl.trim())))) return false;
  const x = parse(hsUrl.trim());
  if (!x || x.username || x.password || x.search || x.hash) return false;
  return x.origin === MATRIX_ORIGIN && (x.pathname === "/" || x.pathname === "");
}

/** Application API: same-origin `/api/` ONLY (never the homeserver origin). */
export function apiBearerAllowed(url: string): boolean {
  const x = parse(url);
  if (!x || x.username || x.password) return false;
  return typeof location !== "undefined" && x.origin === location.origin && x.pathname.startsWith("/api/");
}

/** May a request to `url` carry the session's bearer token? The homeserver, or same-origin /api/. */
export function bearerAllowed(url: string): boolean {
  const x = parse(url);
  if (!x || x.username || x.password) return false;
  if (x.origin === MATRIX_ORIGIN) return true;
  return typeof location !== "undefined" && x.origin === location.origin && x.pathname.startsWith("/api/");
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

let installed = false;
let tokenSource: () => string | undefined | null = () => null;
const knownTokens = new Set<string>();
/** Remember a Matrix access token the moment a session starts (so it stays policed after it is replaced). */
export function noteMatrixToken(token: string | undefined | null): void {
  if (token) knownTokens.add(token);
}

/** Which bearer is the Matrix session token (other bearers, e.g. an SFU JWT, are not ours to police). */
export function setMatrixTokenSource(fn: () => string | undefined | null): void {
  tokenSource = fn;
}

/**
 * Wrap window.fetch: a request carrying the MATRIX token (or, before the session is known, any bearer)
 * to a destination outside the allow-list is refused, and such requests may not follow redirects
 * (redirect "error" unless the caller chose otherwise) — the allow-list is checked on the final URL.
 */
export function installBearerGuard(): void {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    let auth: string | null = null;
    try {
      auth = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined)).get("Authorization");
    } catch {
      auth = null;
    }
    const m = auth ? /^\s*bearer\s+(\S+)/i.exec(auth) : null;
    if (m) {
      let ours = true;
      try {
        const tok = tokenSource();
        if (tok) knownTokens.add(tok);
        // every Matrix token this page has held (a departing session's too); before any is known, all bearers
        ours = knownTokens.size === 0 || knownTokens.has(m[1]);
      } catch {
        ours = true;
      }
      if (ours) {
        const url = urlOf(input);
        if (!bearerAllowed(url)) {
          const where = parse(url)?.origin ?? "an unknown address";
          console.error(`[bearer] refused to send the Matrix token to ${where}`);
          return Promise.reject(new TypeError(`Tin Hat won't send your sign-in token to ${where}`));
        }
        // never follow a redirect with the token ("manual" is opaque, so it may stay)
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        const mode = init?.redirect ?? (isReq ? (input as Request).redirect : undefined);
        if (mode !== "error" && mode !== "manual") {
          if (isReq) input = new Request(input as Request, { redirect: "error" });
          init = { ...init, redirect: "error" };
        }
      }
    }
    return orig(input as RequestInfo, init);
  }) as typeof fetch;
}
