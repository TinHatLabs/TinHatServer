// net.ts — the Matrix client's fetch (createClient `fetchFn`): requests get an upper bound and requests that
// lived through a page suspension are cut, so nothing waits forever on a dead socket.
//
// Why: matrix-js-sdk sets no timeout on most requests (only /sync has one: its long-poll + 80 s, and even
// that stops at the response headers). On iOS, a request in flight when Safari / the home-screen app is
// suspended can come back to a socket that never answers — a hung PUT /sendToDevice then blocks the SDK's
// to-device queue for good (no call key ever leaves again), a hung call-membership PUT blocks that room's
// write chain, and a hung /sync delays every incoming key by up to 110 s. The native app (matrix-rust-sdk)
// bounds every request at 30 s (sync: long-poll + 30 s); this is the web's equivalent.
//
//   matrixFetch(input, init)  the fetchFn (goes through window.fetch, so the bearer guard still applies).
//                             Tracked until the BODY is read (a body stalled across a suspension is cut too).
//   reapAfterSuspend(info)    after a return: cut the /sync; after a suspension also the small capped
//                             requests that lived through it; after hard evidence (frozen, bfcache, offline)
//                             everything, media and slow endpoints too
//   pendingSyncAgeMs()        age of the /sync request in flight (-1 = none)
//   abortPendingSync(why)     cut the /sync in flight (the SDK retries through its keepalive)
//   onRequestCut(cb)          a request was cut (path) — resume.ts re-kicks the to-device queue
// (no runtime imports: src/core/net.test.ts runs this file under plain Node; core/matrix/resume.ts plugs
// the app's logger in)
import type { ResumeInfo } from "./lifecycle";

let log: { warn(msg: string): void } = { warn: (msg) => console.warn(`[net] ${msg}`) };
export function setNetLogger(l: { warn(msg: string): void }): void {
  log = l;
}

/** Upper bound until the response headers arrive (the native default is 30 s). */
export const REQUEST_CAP_MS = 45_000;

/** Legitimately slow (federation, backfill, big backups): no cap, only the suspend reaper applies. */
const SLOW = /\/(join(\/|$)|createRoom$|upgrade$|messages$|search$|context\/|room_keys\/keys|login$|register$|upload)/;
const MEDIA = /\/_matrix\/(media|client\/v1\/media)\//;
const SYNC = /\/_matrix\/client\/[^/]+\/sync$/;

interface Pending {
  method: string;
  path: string;
  sync: boolean;
  media: boolean;
  started: number;
  /** response headers arrived (0 = not yet); the entry lives on until the body is read */
  headersAt: number;
  /** somebody is reading the body (such a request is never pruned — only finished or cut) */
  reading: boolean;
  /** capped class: small, idempotent, latency-critical (not media, not a slow endpoint, not /sync) */
  capped: boolean;
  ctl: AbortController;
  /** set when WE cut it: the rejection the caller sees (WebKit rejects an aborted fetch with a plain
   *  AbortError whatever the reason — checked in Playwright WebKit — so it is re-thrown here) */
  cutWith?: DOMException;
}

const pending = new Set<Pending>();
const cutCbs = new Set<(path: string) => void>();

export function onRequestCut(cb: (path: string) => void): () => void {
  cutCbs.add(cb);
  return () => cutCbs.delete(cb);
}

function pathOf(input: RequestInfo | URL): string {
  try {
    const u = typeof input === "string" ? new URL(input, location.href) : input instanceof URL ? input : new URL(input.url);
    return u.pathname;
  } catch {
    return String(input);
  }
}

/** A deliberate cut looks like a network failure, not a caller's own cancellation: before the headers the
 *  SDK wraps it into a ConnectionError; during a body read it reaches the SDK as this TimeoutError, which its
 *  retry helpers treat as retryable (only AbortError / a ConnectionError without retry give up). */
function cutReason(why: string): DOMException {
  return new DOMException(why, "TimeoutError");
}

function cut(p: Pending, why: string) {
  if (p.ctl.signal.aborted) return;
  log.warn(`cutting ${p.method} ${p.path} after ${Math.round((Date.now() - p.started) / 1000)} s (${why})`);
  p.cutWith = cutReason(why);
  p.ctl.abort(p.cutWith);
  for (const cb of cutCbs) {
    try {
      cb(p.path);
    } catch {
      /* ignore */
    }
  }
}

/** The same response, its body piped through a stream we can see finish (and that errors with our cut). */
function trackBody(r: Response, p: Pending, finish: () => void): Response {
  if (!r.body || typeof ReadableStream === "undefined") {
    finish();
    return r;
  }
  const reader = r.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      p.reading = true;
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          ctrl.close();
        } else ctrl.enqueue(value);
      } catch (e) {
        finish();
        ctrl.error(p.cutWith ?? e);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 }); // (pull only when someone reads: `reading` means a consumer, not the queue filling)
  const out = new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  // (MatrixError messages carry the URL)
  Object.defineProperty(out, "url", { value: r.url });
  return out;
}

export function matrixFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const path = pathOf(input);
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const sync = SYNC.test(path);
  const media = MEDIA.test(path);
  const ctl = new AbortController();
  const outer = init.signal;
  const onOuter = () => ctl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  const slow = SLOW.test(path);
  const p: Pending = { method, path, sync, media, started: Date.now(), headersAt: 0, reading: false, capped: !sync && !media && !slow, ctl };
  pending.add(p);
  // /sync carries its own bound (the SDK's long-poll + 80 s); slow endpoints and media get none.
  const cap = p.capped ? setTimeout(() => cut(p, `no answer in ${REQUEST_CAP_MS / 1000} s`), REQUEST_CAP_MS) : null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    pending.delete(p);
    outer?.removeEventListener("abort", onOuter);
  };
  let res: Promise<Response>;
  try {
    res = globalThis.fetch(input, { ...init, signal: ctl.signal });
  } catch (e) {
    if (cap) clearTimeout(cap);
    finish();
    return Promise.reject(e);
  }
  return res.then(
    (r) => {
      if (cap) clearTimeout(cap); // (the cap is about an answer starting; a body may take its time)
      p.headersAt = Date.now();
      return trackBody(r, p, finish);
    },
    (e) => {
      if (cap) clearTimeout(cap);
      finish();
      throw p.cutWith ?? e;
    },
  );
}

/** A body NOBODY reads never "finishes": stop tracking it 2 min after its headers (never cut it). A body
 *  being read stays tracked until it ends, however long the page was away. */
function prune() {
  const now = Date.now();
  for (const p of [...pending]) if (p.headersAt && !p.reading && now - p.headersAt > 120_000) pending.delete(p);
}

/**
 * The page is back; cut what lived through the hide (in flight before the return):
 *   - the /sync whenever the return is suspect — a fresh one costs one round trip, a dead one would stall
 *     every incoming event and call key for up to 110 s;
 *   - small capped requests (to-device, state, keys, …) that lived through a suspension (a timer gap — which
 *     may also be Chrome's throttling of a long-hidden tab, so nothing slower is touched on that alone);
 *   - everything, media and slow endpoints included, after hard evidence: frozen, the back/forward cache,
 *     or the network gone meanwhile.
 */
export function reapAfterSuspend(info: ResumeInfo): number {
  prune();
  if (!info.suspect) return 0;
  const now = Date.now();
  const hard = info.frozen || info.persisted || info.offline;
  const gapStart = info.at - Math.max(info.gapMs, 0);
  let n = 0;
  for (const p of [...pending]) {
    // in flight before the page came back = it lived through the hide / suspension / outage
    if (p.started > info.at - 500) continue;
    const crossed = p.started <= gapStart + 1000 || now - p.started >= 10_000;
    const hit = p.sync || (hard && crossed) || (info.suspended && p.capped && crossed);
    if (!hit) continue;
    cut(p, info.suspended ? "in flight while the page was suspended" : "a long-poll from before a long hide");
    n++;
  }
  return n;
}

/** Age of the /sync request in flight (-1 = none). */
export function pendingSyncAgeMs(): number {
  prune();
  let age = -1;
  for (const p of pending) if (p.sync) age = Math.max(age, Date.now() - p.started);
  return age;
}

export function abortPendingSync(why: string): boolean {
  let any = false;
  for (const p of [...pending]) {
    if (!p.sync) continue;
    cut(p, why);
    any = true;
  }
  return any;
}

/** Diagnostics / tests: what is in flight right now. */
export function pendingRequests(): Array<{ method: string; path: string; ageMs: number; sync: boolean }> {
  prune();
  return [...pending].map((p) => ({ method: p.method, path: p.path, ageMs: Date.now() - p.started, sync: p.sync }));
}
