// reachcommon.mjs — helpers shared by presence.mjs and push.mjs (Reach, Tin Hat 10.6; docs/REACH.md incl. A2).
//
//   createMatrixAuth  bearer -> Synapse whoami {user_id, device_id}, cached per sha256(token) for 60 s (A2.4).
//                     401 when the header is missing or Synapse rejects the token; 502 when Synapse can't be
//                     asked (a homeserver hiccup must never look like "your token is dead" to a client); 429
//                     when a sign-in check budget is spent: tokens never seen valid are limited per client
//                     address (from our own proxy chain) and globally, tokens that were valid before have their
//                     own refresh budget, and only a lookup that really starts is charged.
//   createHs          GET/POST against the homeserver's pinned internal URL with a 5 s timeout.
//   readJson          the request body as JSON with a hard byte limit (these routes bypass the app-wide
//                     8 KB express.json parser: presence takes 1 KB, the push gateway 64 KB).
//   RateLimit         sliding window per key.
//   mono              the monotonic clock every TTL here runs on (A2.4); wall time only where it must be real
//                     (JWT expiry, persisted timestamps, a status' `until`).
//
// No npm dependency; nothing here logs a token, a user or a body.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

export const mono = () => performance.now();
export const wall = () => Date.now();
export const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

/** Every presence/push API answer is private and live (A2.4). */
export const noStore = (res) => res.set("Cache-Control", "no-store");

export class RateLimit {
    constructor(max, windowMs, now = mono) { this.max = max; this.windowMs = windowMs; this.now = now; this.m = new Map(); }
    /** true = allowed (and counted). */
    hit(key) {
        const t = this.now();
        const arr = (this.m.get(key) || []).filter((x) => t - x < this.windowMs);
        if (arr.length >= this.max) { this.m.set(key, arr); return false; }
        arr.push(t);
        this.m.set(key, arr);
        if (this.m.size > 5000) this.sweep();
        return true;
    }
    /** Seconds until `key` may hit again (>= 1). */
    retryAfter(key) {
        const arr = this.m.get(key) || [];
        return arr.length ? Math.max(1, Math.ceil((arr[0] + this.windowMs - this.now()) / 1000)) : 1;
    }
    sweep() {
        const t = this.now();
        for (const [k, arr] of this.m) if (!arr.length || t - arr[arr.length - 1] >= this.windowMs) this.m.delete(k);
    }
}

export function createHs({ hsUrl, fetchImpl = fetch, timeoutMs = 5000 }) {
    async function call(method, path, token, body) {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const r = await fetchImpl(hsUrl + path, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await r.text();
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
        return { ok: r.ok, status: r.status, body: json };
    }
    return { get: (path, token) => call("GET", path, token), call };
}

// The client is the LAST X-Forwarded-For hop: the web server in front of this app (Caddy on a Tin Hat Server) writes
// the caller's address there, as it worked it out. EDGE_PROXY (optional): a second proxy in front of that web server
// which appends its own address; when the last hop is that proxy, the hop before it is the real client. Anything
// earlier in the header was written by the client and is never trusted.
export const EDGE_PROXY = (process.env.EDGE_PROXY || "").trim();

/** The client address as the proxy chain in front of this app recorded it. */
export function clientIp(req) {
    const hops = String(req.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    let ip = hops.length ? hops[hops.length - 1] : String(req.socket?.remoteAddress || "-");
    if (EDGE_PROXY && ip === EDGE_PROXY && hops.length >= 2) ip = hops[hops.length - 2];
    return ip.slice(0, 64);
}

/** Thrown by whoami() when a sign-in check budget is spent (-> 429, never 401: the token may be fine). */
export class AuthBusy extends Error {}

export const AUTH = Object.freeze({
    UNKNOWN_PER_CLIENT: 20,     // whoami lookups per minute for tokens never seen valid, per client address
    UNKNOWN_GLOBAL: 300,        // ... and for everyone together (a distributed flood still can't hammer Synapse)
    KNOWN_REFRESH_GLOBAL: 1200, // re-checks of tokens that were valid before: their own budget, never starved by floods
    KNOWN_MS: 24 * 3600_000,    // a token stays "known" this long after its last successful check
});

export function createMatrixAuth({ hs, now = mono, ttlMs = 60_000, badTtlMs = 60_000 }) {
    // sha256(token) -> {user, device, exp, known} (exp: answer fresh until; known: counts as seen-valid until)
    //                | {bad: true, exp}
    const cache = new Map();
    const inflight = new Map();  // sha256(token) -> Promise
    const unknownPerClient = new RateLimit(AUTH.UNKNOWN_PER_CLIENT, 60_000, now);
    const unknownGlobal = new RateLimit(AUTH.UNKNOWN_GLOBAL, 60_000, now);
    const knownGlobal = new RateLimit(AUTH.KNOWN_REFRESH_GLOBAL, 60_000, now);

    /**
     * {user, device} | null (token rejected). Throws AuthBusy when a budget is spent, anything else when Synapse
     * can't be asked. A budget is charged only when a real whoami request starts — a cache hit or joining an
     * in-flight lookup for the same token costs nothing.
     */
    async function whoami(token, key = sha256hex(token), ip = "-") {
        const t = now();
        const hit = cache.get(key);
        if (hit && hit.exp > t) return hit.bad ? null : { user: hit.user, device: hit.device };
        if (inflight.has(key)) return inflight.get(key);
        const known = hit && !hit.bad && hit.known > t;
        if (known) {
            if (!knownGlobal.hit("all")) throw new AuthBusy("refresh budget spent");
        } else {
            if (!unknownPerClient.hit(ip)) throw new AuthBusy("per-client budget spent");
            if (!unknownGlobal.hit("all")) throw new AuthBusy("global budget spent");
        }
        const p = (async () => {
            const r = await hs.get("/_matrix/client/v3/account/whoami", token);
            if (r.ok && typeof r.body.user_id === "string") {
                const v = { user: r.body.user_id, device: typeof r.body.device_id === "string" ? r.body.device_id : "-" };
                cache.set(key, { ...v, exp: now() + ttlMs, known: now() + AUTH.KNOWN_MS });
                if (cache.size > 20_000) sweep();
                return v;
            }
            if (r.status === 401 || r.status === 403) {
                cache.set(key, { bad: true, exp: now() + badTtlMs });
                return null;
            }
            throw new Error(`whoami said ${r.status}`);
        })();
        inflight.set(key, p);
        try { return await p; } finally { inflight.delete(key); }
    }

    /**
     * Resolve the caller or answer for them. Returns {user, device, token, key} (key = sha256(token), for
     * per-token limits) or null when a response was already sent.
     */
    async function authenticate(req, res) {
        const m = /^Bearer\s+(\S{1,2048})\s*$/i.exec(String(req.headers?.authorization || ""));
        if (!m) { res.status(401).json({ error: "bearer token required" }); return null; }
        const token = m[1];
        const key = sha256hex(token);
        let who;
        try { who = await whoami(token, key, clientIp(req)); } catch (e) {
            if (e instanceof AuthBusy) {
                res.set("Retry-After", "10");
                res.status(429).json({ error: "too many sign-in checks, try again shortly" });
            } else res.status(502).json({ error: "homeserver unreachable" });
            return null;
        }
        if (!who) { res.status(401).json({ error: "bad token" }); return null; }
        return { ...who, token, key };
    }

    function sweep() {
        const t = now();
        for (const [k, e] of cache) {
            if (e.exp > t) continue;
            // past its 60 s: keep only "this token was valid" (no user, no device) for the refresh budget
            if (!e.bad && e.known > t) { if (e.user !== undefined) cache.set(k, { exp: 0, known: e.known }); }
            else cache.delete(k);
        }
        unknownPerClient.sweep(); unknownGlobal.sweep(); knownGlobal.sweep();
    }

    return { whoami, authenticate, sweep, _cache: cache };
}

/**
 * Read the body as JSON, at most `limit` bytes. {ok: true, value} | {ok: false, status: 400|413, error}.
 * An empty body gives value undefined. If some earlier middleware already parsed the body, that is used.
 */
export function readJson(req, limit) {
    if (req._body === true) return Promise.resolve({ ok: true, value: req.body });
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
        req.resume?.();
        return Promise.resolve({ ok: false, status: 413, error: `body too large (max ${limit} bytes)` });
    }
    return new Promise((resolve) => {
        const chunks = [];
        let n = 0, over = false, settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        req.on("data", (c) => {
            if (over) return;
            n += c.length;
            if (n > limit) { over = true; chunks.length = 0; return; }
            chunks.push(c);
        });
        req.on("end", () => {
            if (over) return done({ ok: false, status: 413, error: `body too large (max ${limit} bytes)` });
            const text = Buffer.concat(chunks).toString("utf8");
            if (!text.trim()) return done({ ok: true, value: undefined });
            try { done({ ok: true, value: JSON.parse(text) }); } catch { done({ ok: false, status: 400, error: "body is not valid JSON" }); }
        });
        req.on("error", () => done({ ok: false, status: 400, error: "body could not be read" }));
    });
}

/** Wrap an async handler so a throw becomes a 500, never an unhandled rejection (which would kill the process). */
export const safe = (tag, fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[${tag}] handler error: ${e?.message || e}`);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// `!opaque:server`, or a room v12 id (`!` + the create event's hash, no server part).
export const ROOM_ID_RE = /^![A-Za-z0-9._~=+/-]{1,255}(?::[A-Za-z0-9.-]{1,255}(?::\d{1,5})?)?$/;
// Characters a status or a notification line must never carry: C0/C1 controls and bidi overrides/isolates.
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
