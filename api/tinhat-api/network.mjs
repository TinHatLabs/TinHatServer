// network.mjs — GET /network: what the apps need to know about this server's federation (open network, slice 1:
// share design MATRIX-FRONTEND-DESIGN.md B0 / A4; docs/API.md "Federation for the apps").
//
// The apps tell three kinds of rooms apart: rooms made on this server, rooms made on a Tin Hat server CONNECTED to this
// one by code (docs/FEDERATION.md: Tin Hat's own room state may be sent there, as far as that room's levels allow),
// and rooms on any other Matrix server (Tin Hat's extras stay out). Only this server knows its connections, so it says:
//
//   GET /network  (the caller's Matrix token)  ->  200 {v: 1, mode: "home"|"connected", connected: [server…],
//                                                       blocked: [server…], invites: {default: "known"}}
//
//   mode       "home": no federation at all; "connected": only the servers on the allow-list ("open" arrives with the
//              open Matrix network switch, 0.4.0).
//   connected  the Tin Hat servers connected by code. NOT the plain Matrix servers allowed by name: rooms there are
//              "other" for the apps.
//   blocked    servers this server refuses (the owner's deny-list, Network → Blocked servers; enforced by Synapse's
//              tinhat_network module, the allow-list and Caddy: docs/NETWORK-RULES.md). The apps hide their people
//              like ignored users. A blocked server is never in `connected`.
//   invites    the rule for invites from other servers a person has when they never chose one
//              (account data dev.tinhat.invite_rules; "anyone" | "known" | "nobody").
//
// Source: network.json in the API's folder, written by the manager (apiconf.publish_network) whenever a connection or
// the mode changes, read again here every CHECK_MS (a few hundred bytes: no mtime cache, which could keep a replaced
// or unreadable file's old answer: astra r1 P3). Missing or unreadable -> 503 {code: "off"} (the apps then
// treat every other server's room as "other": fail closed). Guests (docs/GUESTS.md) get 403: they never leave the
// guest room, and the list of connections is none of their business.
import { openSync, readSync, closeSync } from "node:fs";
import { RateLimit, noStore, mono, safe } from "./reachcommon.mjs";

export const NETWORK = Object.freeze({
    PER_MIN: 30,            // reads per account per minute (the apps read once per session start + every 10 min)
    CHECK_MS: 5_000,        // how often the file's mtime is looked at
    MAX_SERVERS: 1000,      // more is a broken file, not a real list
    MAX_BYTES: 256 * 1024,
    MAX_AGE_S: 6 * 3600,    // an older file is refused (= apiconf.NETWORK_MAX_AGE_S; the manager renews it hourly)
    SKEW_S: 300,            // a file "from the future" by more than this is refused too
});

// A server name as the apps' shared vectors take it (foreign.ts validServer): a DNS name, optionally with a port.
// The manager writes only names it accepted through the connection handshake (lower-case DNS names), so anything
// else here is a damaged file: such entries are dropped, never passed on.
const NAME = /^(?=.{1,253}(?::|$))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](?::(?:[1-9][0-9]{0,4}))?$/;
function serverName(s) {
    if (typeof s !== "string" || !NAME.test(s)) return null;
    const i = s.indexOf(":");
    if (i >= 0 && Number(s.slice(i + 1)) > 65535) return null;
    return s;
}

/** Each person's rule for invites from other servers (tinhat_network.RULES). */
export const INVITE_RULES = Object.freeze(["anyone", "known", "nobody"]);

/** network.json's text -> the document the apps get, or null when it isn't one. `nowS` (unix seconds) checks its
 *  age: a file the manager hasn't renewed for MAX_AGE_S is refused, so a list it failed to replace can't live on. */
export function parseNetwork(text, nowS = Math.floor(Date.now() / 1000)) {
    let o;
    try { o = JSON.parse(text); } catch { return null; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (o.mode !== "home" && o.mode !== "connected") return null;
    if (!Number.isSafeInteger(o.issued) || nowS - o.issued > NETWORK.MAX_AGE_S || o.issued - nowS > NETWORK.SKEW_S) return null;
    const list = (v) => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.length > NETWORK.MAX_SERVERS) return null;
        const out = [];
        for (const s of v) { const n = serverName(s); if (n && !out.includes(n)) out.push(n); }
        return out.sort();
    };
    const connected = list(o.connected), blocked = list(o.blocked);
    if (!connected || !blocked) return null;
    const rule = o.invites && typeof o.invites === "object" && INVITE_RULES.includes(o.invites.default) ? o.invites.default : "known";
    // home mode federates with nobody: a stale list there would be a lie. A blocked server is never connected.
    if (o.mode === "home") return { v: 1, mode: "home", connected: [], blocked: [], invites: { default: rule } };
    return { v: 1, mode: o.mode, connected: connected.filter((s) => !blocked.includes(s)), blocked, invites: { default: rule } };
}

/** deps: {auth, path, isGuest(mxid) (required: guests never get the list), now?, wallS? (unix seconds), log?} */
export function createNetwork(deps) {
    if (typeof deps.isGuest !== "function") throw new Error("network: isGuest is required");
    const now = deps.now || mono;
    const log = deps.log || console.log;
    const wallS = deps.wallS || (() => Math.floor(Date.now() / 1000));
    const limit = new RateLimit(NETWORK.PER_MIN, 60_000, now);
    let cached = null, checkedAt = -Infinity, lastSig = "";

    function readBounded() {
        let fd;
        try {
            fd = openSync(deps.path, "r");
            // read to the end, never more than MAX_BYTES + 1 (a file that grows while read is refused, not cut short)
            const buf = Buffer.alloc(NETWORK.MAX_BYTES + 1);
            let n = 0, r;
            while (n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
            if (n > NETWORK.MAX_BYTES) return { bad: "too big" };
            return { text: buf.subarray(0, n).toString("utf8") };
        } catch (e) {
            return e?.code === "ENOENT" ? { missing: true } : { bad: e?.code || "unreadable" };
        } finally {
            if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
        }
    }

    /** The document, read again every CHECK_MS; null (503) when missing, unreadable or invalid. */
    function current() {
        const t = now();
        if (t - checkedAt < NETWORK.CHECK_MS) return cached;
        checkedAt = t;
        const r = readBounded();
        const doc = r.text !== undefined ? parseNetwork(r.text, wallS()) : null;
        const sig = doc ? JSON.stringify(doc) : r.missing ? "missing" : (r.bad || "invalid or expired");
        if (sig !== lastSig) {
            if (doc) log(`[network] mode ${doc.mode}, ${doc.connected.length} connected, ${doc.blocked.length} blocked`);
            else if (r.missing) log("[network] network.json missing -> GET /network answers 503 (apps: rooms elsewhere are 'other')");
            else log(`[network] network.json ${r.bad || "invalid or expired"} -> 503`);
            lastSig = sig;
        }
        cached = doc;
        return cached;
    }

    async function get(req, res) {
        noStore(res);
        const who = await deps.auth.authenticate(req, res);
        if (!who) return;
        if (!limit.hit(who.user)) {
            res.set("Retry-After", String(limit.retryAfter(who.user)));
            return res.status(429).json({ error: "Too many requests — try again shortly", code: "rate" });
        }
        if (deps.isGuest(who.user)) return res.status(403).json({ error: "Not for guest accounts", code: "guest" });
        const doc = current();
        if (!doc) return res.status(503).json({ error: "This server's network settings aren't available", code: "off" });
        return res.json(doc);
    }

    return { get, current };
}

export function installNetwork(app, deps) {
    const n = createNetwork(deps);
    app.get("/network", safe("network", n.get));
    return n;
}
