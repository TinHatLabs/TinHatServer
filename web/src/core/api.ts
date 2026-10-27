// api.ts — the Tin Hat API, always same-origin `/api` (the web twin of the native proxy.rs `<api base>` + path): a
// Tin Hat Server serves it next to the web app (its well-known's `api` names that same origin). The web only ever
// calls its own origin.
//
//   const res  = await apiFetch("/soundboard/uploads");              // Response (bearer added)
//   const list = await apiJson<{ invites: Invite[] }>("/admin/invites");
//   await apiJson("/moderation/call", { method: "POST", json: { room, identity, action: "mute" } });
//
// Routes (Tin Hat Server `api/`; `*` = Matrix bearer sent — core/apiauth.ts, the server's docs/API.md):
//   /api/soundboard/*     search*, clip* (+ clip/sign*), fetch, upload*, uploads*, guest/*
//   /api/gifs/*           search*, trending*, fetch*
//   /api/games/*          games catalog (custom* / steam* need the bearer)
//   /api/moderation/*     call mute/disconnect*
//   /api/admin/*          invites* (operators only; 403 for everyone else)
//   /api/watch/*          YouTube search / meta / resolve*  (0.3.4: gifs / watch / soundboard search+clip spend the
//                         owner's quota — with the bearer, against the member's own budget; 401 {signin:true} = the
//                         token-less allowance is spent: the callers show their normal "couldn't load" state)
//   /api/vods/*           sessions* (+ signed file/thumb URLs it returns)
//   /api/presence, /api/push/*, /api/gameservers/*   Reach presence*, web push*, the game-servers widget*
//   /api/speedtest/up     the uplink sink
//   /api/reports          bug reports* (POST)
// In dev/preview, vite.config.ts proxies /api (and in dev the homeserver's paths) to TH_DEV_SERVER.
//
// "Bearer" = the caller's own Matrix access token; the service checks it with /whoami. It is
// added automatically for the paths that need it (auth: "auto"); force with auth: true/false.
import { getAccessToken } from "@/core/matrix/session";
import { apiBearerAllowed, pageOrigin } from "@/core/bearer";
import { apiPathNeedsBearer } from "@/core/apiauth";

/** Base path (absolute, so it works at / and at the /next/ staging path). */
export const API_BASE: string = ((import.meta.env.VITE_TW_API_BASE as string | undefined) ?? "/api").replace(/\/+$/, "");

/** Where people open Tin Hat Web (invite text, About): this page's origin — a Tin Hat Server serves the web app
 *  itself. fix/polish item 9. */
export function webAppUrl(): string {
  return `${pageOrigin()}/`;
}

/** Where a bug report is POSTed (JSON): the Tin Hat Server's /api/reports (bearer). */
export const REPORTS_PATH = "/reports";


export interface ApiInit extends Omit<RequestInit, "body"> {
  /** "auto" (default): bearer only where the service needs it. */
  auth?: boolean | "auto";
  /** JSON body (sets Content-Type). */
  json?: unknown;
  body?: BodyInit | null;
  /** Abort after this many ms (default 12 000, like the native TIMEOUT). 0 = none. */
  timeoutMs?: number;
  /** The bearer to use instead of the current session's — work that belongs to the session that started it
   *  (a sign-out clean-up, a push transaction) must never run with the next account's token. REACH web review. */
  bearer?: string;
}

/** Absolute URL of an API path ("/gifs/search?q=x" → "/api/gifs/search?q=x"). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch(path: string, init: ApiInit = {}): Promise<Response> {
  const { auth = "auto", json, timeoutMs = 12000, headers, bearer, ...rest } = init;
  const h = new Headers(headers);
  const p = path.startsWith("/") ? path : `/${path}`;
  const wantsAuth = auth === true || (auth === "auto" && apiPathNeedsBearer(p));
  // The bearer only goes to same-origin /api/ (an absolute VITE_TW_API_BASE elsewhere gets none).
  if (wantsAuth && apiBearerAllowed(apiUrl(p))) {
    const token = bearer ?? getAccessToken();
    if (token) h.set("Authorization", `Bearer ${token}`);
  }
  let body = rest.body;
  if (json !== undefined) {
    h.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  const signals: AbortSignal[] = [];
  if (rest.signal) signals.push(rest.signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  // AbortSignal.any is missing on older Safari: keep the caller's signal then (no timeout).
  const signal = signals.length > 1 ? (any ? any(signals) : signals[0]) : signals[0];
  try {
    return await fetch(apiUrl(p), { ...rest, headers: h, body, signal });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError") throw new ApiError("The server didn't answer in time", 0, null);
    if (name === "AbortError") throw e;
    throw new ApiError(`Couldn't reach the server: ${(e as Error)?.message ?? e}`, 0, null);
  }
}

/** The bearer header for a URL the app fetches itself outside apiFetch (a clip it plays through Web Audio): only for
 *  this origin's API (apiBearerAllowed: same origin, under /api/) and a route that takes it (core/apiauth.ts). */
export function apiAuthHeaders(url: string, bearer?: string): Record<string, string> {
  let u: URL;
  try {
    u = new URL(url, typeof location !== "undefined" ? location.href : undefined);
  } catch {
    return {};
  }
  const base = `${API_BASE}/`;
  if (!base.startsWith("/") || !u.pathname.startsWith(base) || !apiBearerAllowed(u.href)) return {};
  if (!apiPathNeedsBearer(`/${u.pathname.slice(base.length)}${u.search}`)) return {};
  const token = bearer ?? getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * JSON request → parsed body. Non-2xx throws ApiError whose message is the service's `error`
 * string, or "The server said <status>" (invites.rs server_error wording).
 */
export async function apiJson<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const r = await apiFetch(path, init);
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) {
    const err = (body as { error?: unknown } | null)?.error;
    throw new ApiError(typeof err === "string" && err ? err : `The server said ${r.status}`, r.status, body);
  }
  return body as T;
}
