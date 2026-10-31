// fedresolve.mjs — who a Matrix OpenID token from ANOTHER server belongs to, asked by this process with the SSRF guards
// of foreign.mjs (calls round M1b residual, NEXT-ROUND.md §3): so lk-jwt is only asked to sign for a caller this server
// has already verified as a joined member, and no request for a member-named host leaves lk-jwt for anyone else.
//
//   discover(serverName)   the federation address of a server, as the Matrix spec's server discovery has it
//                          (server-server API "Resolving server names"): an IP literal or an explicit port is used as
//                          is (8448 by default); else https://<name>/.well-known/matrix/server (m.server: a delegated
//                          name[:port]); then SRV _matrix-fed._tcp.<name> (and the deprecated _matrix._tcp); else
//                          <name>:8448. Every address any step connects to must be public (foreign.isPublicAddress,
//                          every DNS answer of a name: resolvePublic) and is pinned (no second lookup); TLS is checked
//                          against the name the spec says (the server name, the delegated name, or the SRV's
//                          delegated name — never the SRV target). The well-known follows up to 3 redirects, each
//                          checked the same way; a well-known on a private address counts as none. Up to 5 SRV
//                          targets are kept in order (private ones skipped) and tried in turn while one doesn't
//                          answer at all. -> [{host (TLS), hostHeader, port, pin: {address, family}}]
//   userinfo(server, tok)  GET /_matrix/federation/v1/openid/userinfo?access_token=… there. -> {sub} (a Matrix id OF
//                          that server, else null = refused) or throws {status: 502} when the server can't be asked.
// Byte caps (well-known 16 KB, userinfo 16 KB), one deadline for the whole lookup (10 s), discovery results cached
// 10 minutes per server name (24 h is the spec's default for a well-known; shorter here: a cache can't be told to drop).
// Per-attempt budgets inside that deadline (0.3.10, NEXT-ROUND): the well-known step gets 4 s in all (a black-holed
// well-known counts as none, so SRV and :8448 still get their turn), and each userinfo attempt gets an even share of
// what's left over the candidates still to try (the last one gets all of it; a fast refusal leaves its share to the
// rest), so a black-holed first SRV target can't use the whole 10 s and leave the healthy second one untried.
// Nothing here logs a token.
import https from "node:https";
import { isIP } from "node:net";
import { isPublicAddress, newResolver, resolvePublic } from "./foreign.mjs";

export const FED = Object.freeze({
    PORT: 8448,
    TIMEOUT_MS: 10_000,
    MAX_BYTES: 16 * 1024,
    REDIRECTS: 3,
    WELLKNOWN_MS: 4_000,
    CACHE_MS: 10 * 60_000,
    CACHE_MAX: 2000,
});

const HOST_RE = /^(?=.{1,254}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i; // (a root dot is allowed)

/** A server name as the spec allows it: hostname | IPv4 | [IPv6], with an optional :port. -> {host, port|null, ip} | null */
export function parseServerName(raw) {
    const s = String(raw ?? "");
    if (!s || s.length > 255 || /[\s/?#@\\]/.test(s)) return null;
    let host, port = null;
    const m6 = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(s);
    if (m6) { host = m6[1]; port = m6[2] ?? null; if (isIP(host) !== 6) return null; }
    else {
        const i = s.lastIndexOf(":");
        if (i >= 0) { host = s.slice(0, i); port = s.slice(i + 1); if (!/^\d{1,5}$/.test(port)) return null; } else host = s;
        if (!(isIP(host) === 4 || HOST_RE.test(host))) return null;
    }
    if (port !== null) { port = Number(port); if (port < 1 || port > 65535) return null; }
    return { host: host.toLowerCase(), port, ip: isIP(host) !== 0, raw: s.toLowerCase() };
}

/** One HTTPS GET to a pinned address; JSON or throws. TLS name = `tlsName`, Host = `hostHeader`. */
export function getPinnedJson({ tlsName, hostHeader, port, path, pin, maxBytes = FED.MAX_BYTES, timeoutMs, request = https.request }) {
    return new Promise((resolve, reject) => {
        let settled = false, req = null, response = null;
        const teardown = () => { try { response?.destroy(); } catch { /* gone */ } try { req?.destroy(); } catch { /* gone */ } };
        const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); teardown(); fn(v); } };
        const fail = (msg, extra = {}) => done(reject, Object.assign(new Error(msg), { status: 502, ...extra }));
        const timer = setTimeout(() => fail("no answer in time"), Math.max(1, timeoutMs));
        req = request({
            host: tlsName, servername: isIP(tlsName) ? undefined : tlsName, port, method: "GET", path, agent: false,
            headers: { host: hostHeader, accept: "application/json", "user-agent": "TinHatServer-calls/1" },
            lookup: (_n, opts, cb) => (opts && opts.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)),
        }, (res) => {
            response = res;
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400) return done(resolve, { status: code, location: String(res.headers.location || "") });
            if (Number(res.headers["content-length"] || 0) > maxBytes) return fail("too big");
            const chunks = [];
            let n = 0;
            res.on("data", (c) => { n += c.length; if (n > maxBytes) return fail("too big"); chunks.push(c); });
            res.on("end", () => {
                if (settled) return;
                let body = null;
                try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
                done(resolve, { status: code, body });
            });
            res.on("error", (e) => fail(e.message));
        });
        req.on("error", (e) => fail(e.message));
        req.end();
    });
}

/** The address to connect to for a host name or literal: a literal must itself be public. */
async function pinFor(host, resolver) {
    const v = isIP(host);
    if (v) {
        if (!isPublicAddress(host)) throw Object.assign(new Error("not a public address"), { status: 403, reason: "not-public" });
        return { address: host, family: v };
    }
    return resolvePublic(host, resolver);
}

/** SRV records, ordered: by priority, then by weight (highest first; deterministic: the same order every time). */
async function srv(name, resolver, guard) {
    for (const prefix of ["_matrix-fed._tcp.", "_matrix._tcp."]) {
        guard();
        try {
            const recs = await resolver.resolveSrv(prefix + name);
            const ok = (Array.isArray(recs) ? recs : []).filter((r) => r && typeof r.name === "string" && r.name && r.name !== "." && r.port > 0);
            if (ok.length) {
                ok.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
                return ok.slice(0, 5).map((r) => ({ target: r.name.toLowerCase().replace(/\.$/, ""), port: r.port }));
            }
        } catch { /* no record: the next step */ }
    }
    return null;
}

const late = () => Object.assign(new Error("out of time"), { status: 502 });

/** `p`, or a rejection once `ms` have passed (0.3.10 release review: the well-known step's DNS lookups count against
 *  its own 4 s budget, so a stalled lookup there can't use up the whole 10 s before SRV / :8448 are tried). */
function within(p, ms) {
    if (!(ms > 0)) { p.catch(() => {}); return Promise.reject(late()); } // the lookup already started: never left unhandled
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(late()), ms); })]).finally(() => clearTimeout(t));
}

/** The time one userinfo attempt may use: an even share of what's left over the candidates still to try, all of it
 *  for the last one (no floor: a floor would starve the last candidate when several hang, Astra on 218e8df). */
export function attemptBudget(left, candidatesLeft) {
    if (left <= 0) return 0;
    if (candidatesLeft <= 1) return left;
    return Math.floor(left / candidatesLeft);
}

/**
 * deps: {resolver?: () => Resolver (c-ares; injectable for tests), request?: https.request, now?: () => ms,
 *        budgets?: {TIMEOUT_MS, WELLKNOWN_MS} (tests scale them down)}
 */
export function createFedResolver(deps = {}) {
    const mkResolver = deps.resolver || newResolver;
    const request = deps.request || https.request;
    const now = deps.now || Date.now;
    const B = { TIMEOUT_MS: FED.TIMEOUT_MS, WELLKNOWN_MS: FED.WELLKNOWN_MS, ...(deps.budgets || {}) };
    const cache = new Map(); // server name -> {at, v}
    const inflight = new Map(); // server name -> Promise (one discovery per server at a time)

    async function wellKnown(host, resolver, guard, outerDeadline) {
        // its own budget inside the lookup's: out of time here = no well-known (SRV / :8448 are tried next)
        const deadline = Math.min(outerDeadline, now() + B.WELLKNOWN_MS);
        let url = new URL(`https://${host}/.well-known/matrix/server`);
        for (let hop = 0; hop <= FED.REDIRECTS; hop++) {
            guard();
            if (now() >= deadline) return null;
            if (url.protocol !== "https:" || url.username || url.password) return null;
            const h = parseServerName(url.port ? `${url.hostname}:${url.port}` : url.hostname); // (IPv6 stays in brackets)
            if (!h) return null;
            let pin;
            // a well-known on a private address (or one that doesn't resolve) is never fetched: as if there were none
            try { pin = await within(pinFor(h.host, resolver), deadline - now()); } catch { return null; }
            guard();
            let r;
            try {
                r = await getPinnedJson({ tlsName: h.host, hostHeader: url.host, port: h.port || 443, path: url.pathname + url.search, pin,
                    timeoutMs: deadline - now(), request });
            } catch { return null; }
            if (r.status >= 300 && r.status < 400 && r.location) {
                try { url = new URL(r.location, url); } catch { return null; }
                continue;
            }
            if (r.status !== 200 || !r.body || typeof r.body["m.server"] !== "string") return null;
            return parseServerName(r.body["m.server"]);
        }
        return null;
    }

    /** Candidates in order, each with a pinned public address: one, or up to 5 SRV targets (private ones skipped). */
    async function candidates(serverName, sn, resolver, guard, deadline) {
        const one = async (host, hostHeader, port, pinHost = host) => { guard(); return [{ host, hostHeader, port, pin: await pinFor(pinHost, resolver) }]; };
        if (sn.ip) return one(sn.host, serverName, sn.port || FED.PORT);
        if (sn.port) return one(sn.host, serverName, sn.port);
        // a delegation names the server to talk to; TLS and Host are that name (as m.server writes it)
        const d = await wellKnown(sn.host, resolver, guard, deadline);
        const name = d || sn;
        if (name.ip || name.port) return one(name.host, name.raw, name.port || FED.PORT);
        const recs = await srv(name.host, resolver, guard);
        if (!recs) return one(name.host, name.host, FED.PORT);
        // SRV: connect to the target, but TLS and Host stay the (delegated) name
        const out = [];
        let refused = null;
        for (const r of recs) {
            guard();
            try { out.push({ host: name.host, hostHeader: name.host, port: r.port, pin: await pinFor(r.target, resolver) }); }
            catch (e) { refused = refused || e; }
        }
        if (!out.length) throw refused || Object.assign(new Error("no usable SRV target"), { status: 502 });
        return out;
    }

    /** Where `serverName`'s federation API is: [{host (TLS), hostHeader, port, pin}] in order. Throws {status: 403,
     *  reason: "not-public" | "bad-name"} / {status: 502}. One discovery per server at a time; cached 10 min. */
    async function discover(serverName, deadline = now() + B.TIMEOUT_MS) {
        const c = cache.get(serverName);
        if (c && now() - c.at < FED.CACHE_MS) return c.v;
        if (inflight.has(serverName)) return inflight.get(serverName);
        const p = (async () => {
            const sn = parseServerName(serverName);
            if (!sn) throw Object.assign(new Error("not a server name"), { status: 403, reason: "bad-name" });
            const resolver = mkResolver();
            let expired = false;
            const timer = setTimeout(() => { expired = true; try { resolver.cancel?.(); } catch { /* idle */ } }, Math.max(1, deadline - now()));
            const guard = () => { if (expired || now() >= deadline) throw late(); };
            try {
                const v = await candidates(serverName, sn, resolver, guard, deadline);
                guard();
                if (cache.size >= FED.CACHE_MAX) cache.delete(cache.keys().next().value);
                cache.set(serverName, { at: now(), v });
                return v;
            } catch (e) {
                if (e.status) throw e;
                throw Object.assign(new Error(`couldn't find ${serverName}'s federation address`), { status: 502 });
            } finally { clearTimeout(timer); }
        })();
        inflight.set(serverName, p);
        try { return await p; } finally { inflight.delete(serverName); }
    }

    /** -> {sub} (a Matrix id on `serverName`) | null (the server refused the token) ; throws {status: 502|403}.
     *  The candidates are tried in order while they don't answer at all; a failed set is forgotten (found again next time). */
    async function userinfo(serverName, accessToken) {
        const deadline = now() + B.TIMEOUT_MS;
        const list = await discover(serverName, deadline);
        let r = null;
        for (let i = 0; i < list.length; i++) {
            const d = list[i];
            const budget = attemptBudget(deadline - now(), list.length - i);
            if (budget <= 0) break;
            try {
                r = await getPinnedJson({ tlsName: d.host, hostHeader: d.hostHeader, port: d.port, pin: d.pin, timeoutMs: budget, request,
                    path: `/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(accessToken)}` });
                break;
            } catch { r = null; }
        }
        if (!r) { cache.delete(serverName); throw Object.assign(new Error(`${serverName} didn't answer`), { status: 502 }); }
        if (r.status === 200) {
            const sub = typeof r.body?.sub === "string" ? r.body.sub : "";
            const m = /^@[^:\s]{1,255}:(.+)$/.exec(sub);
            return m && m[1] === serverName ? { sub } : null;
        }
        if (r.status === 401 || r.status === 403 || r.status === 404) return null;
        throw Object.assign(new Error(`userinfo said ${r.status}`), { status: 502 });
    }

    return { discover, userinfo, _cache: cache };
}
