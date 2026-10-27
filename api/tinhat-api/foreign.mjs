// foreign.mjs — sounds uploaded on ANOTHER Tin Hat server (e.g. a friend's), fetched THROUGH this one, never by the
// apps directly (the maintainer's decision, 2026-10-26). The apps send such a link to /soundboard/clip?url= (or /clip/sign) like
// a myinstants one; the same budgets, token-less rules and charging apply (server.mjs). This module decides which links
// are taken and fetches them safely:
//
//   parseForeignClipUrl  only https://<name>[:443]/api/soundboard/clip?id=<id> (that one parameter) or
//                        https://<name>[:443]/api/soundboard/file/<file> (one segment, not starting with a dot); no
//                        userinfo, no other port, no fragment, no %2e / %2f / %5c anywhere (any case), no whitespace,
//                        control characters or backslashes, a dotted DNS name (not an address, not a single label),
//                        never this server's own. Exactly the set the apps' shared vectors (soundRoute) send.
//                        -> {url (the normalised link: the cache key), host} | {error, reason}
//   isPublicAddress      IPv4: false for loopback, private, link-local, CGNAT, multicast, unspecified, documentation,
//                        benchmarking and reserved ranges. IPv6: true only inside the blocks IANA has allocated to the
//                        regional registries (IPV6_ALLOCATED, from the IANA table last updated 2025-10-10), minus
//                        documentation; never IPv4-mapped/compatible, 6to4, Teredo, reserved space (3ffe::/16,
//                        3000::/5 …), and NAT64 (64:ff9b::/96) only when the IPv4 inside is public. A zone id ("%") is
//                        never an address here.
//   resolvePublic        the name's A and AAAA answers through c-ares (dns.promises.Resolver: its own timeouts and tries,
//                        cancellable, never the libuv thread pool that getaddrinfo would tie up); EVERY answer must be
//                        public (a name that mixes in a private one is refused), and the first is pinned.
//   fetchForeignClip     one GET to the pinned address with SNI and Host = the name (the certificate is checked
//                        against the name), no redirects, a byte cap (refused, never truncated), a deadline, and the
//                        bytes must sniff as audio (media.sniffClipAudio). Every way out tears the connection down
//                        first (a refused status's body is never read on: second review, #1).
//   foreignDownload      resolvePublic + fetchForeignClip under ONE deadline (resolution included): what server.mjs
//                        runs, only after the request was admitted, de-duplicated and charged (second review, #2).
import https from "node:https";
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { sniffClipAudio } from "./media.mjs";

const NAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;   // never starts with a dot (the apps' shared vectors)
const CLIP_PATH = "/api/soundboard/clip";
const FILE_PATH = /^\/api\/soundboard\/file\/([^/]+)$/;

const no = (reason, error) => ({ reason, error });

/** A sound link on another Tin Hat server, normalised; ownHosts: this server's names (refused: the apps play those). */
export function parseForeignClipUrl(raw, ownHosts = []) {
    if (typeof raw !== "string" || !raw || raw.length > 2048) return no("shape", "Not a sound link");
    if (/%(2e|2f|5c)/i.test(raw)) return no("shape", "Encoded dots, slashes or backslashes aren't allowed");
    if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return no("shape", "Whitespace, control characters or backslashes aren't allowed");
    if (raw.includes("#")) return no("shape", "A link with a fragment isn't allowed");
    let u;
    try { u = new URL(raw); } catch { return no("shape", "Not a sound link"); }
    if (u.protocol !== "https:") return no("shape", "Only https links");
    if (u.username || u.password) return no("shape", "No user names in links");
    if (u.port) return no("shape", "Only port 443");
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (isIP(host) || host.startsWith("[")) return no("shape", "A server's name, not an address");
    if (!NAME_RE.test(host)) return no("shape", "Not a server's name");
    if (ownHosts.some((h) => String(h || "").toLowerCase().replace(/\.$/, "") === host)) {
        return no("own", "That's this server's own sound: play it directly");
    }
    if (u.pathname === CLIP_PATH) {
        const params = [...u.searchParams];
        if (params.length !== 1 || params[0][0] !== "id" || !ID_RE.test(params[0][1]) || u.search !== `?id=${params[0][1]}`) {
            return no("shape", "Only ?id=<id> on a clip link");
        }
        return { url: `https://${host}${CLIP_PATH}?id=${params[0][1]}`, host };
    }
    const m = FILE_PATH.exec(u.pathname);
    if (m && FILE_RE.test(m[1]) && u.search === "" && !raw.includes("?")) {
        return { url: `https://${host}/api/soundboard/file/${m[1]}`, host };
    }
    return no("shape", "Not another Tin Hat server's sound link");
}

// IPv4 ranges that are never a server on the internet (RFC 6890 and friends).
const V4_BLOCKED = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4num = (s) => s.split(".").reduce((n, x) => n * 256 + Number(x), 0);
function v4Public(ip) {
    const n = v4num(ip);
    return !V4_BLOCKED.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4num(net) / 2 ** (32 - bits)));
}
function v6Groups(s) {
    let x = s.toLowerCase().replace(/%.*$/, "");
    if (x.includes(".")) {   // a dotted IPv4 tail
        const cut = x.lastIndexOf(":");
        const b = x.slice(cut + 1).split(".").map(Number);
        x = `${x.slice(0, cut + 1)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
    }
    const [head, tail] = x.split("::");
    const hp = head ? head.split(":") : [];
    const tp = tail === undefined || tail === "" ? [] : tail.split(":");
    const fill = tail === undefined ? [] : new Array(8 - hp.length - tp.length).fill("0");
    return [...hp, ...fill, ...tp].map((g) => parseInt(g, 16));
}
const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

// IANA "IPv6 Global Unicast Address Assignments" (https://www.iana.org/assignments/ipv6-unicast-address-assignments/,
// last updated 2025-10-10): every ALLOCATED block except 2001::/23 (IANA's own special-purpose space: Teredo, ORCHID,
// benchmarking …) and 2002::/16 (6to4, which carries an IPv4 inside). Everything else in 2000::/3 is reserved.
export const IPV6_ALLOCATED = [
    "2001:200::/23", "2001:400::/23", "2001:600::/23", "2001:800::/22", "2001:c00::/23", "2001:e00::/23", "2001:1200::/23",
    "2001:1400::/22", "2001:1800::/23", "2001:1a00::/23", "2001:1c00::/22", "2001:2000::/19", "2001:4000::/23",
    "2001:4200::/23", "2001:4400::/23", "2001:4600::/23", "2001:4800::/23", "2001:4a00::/23", "2001:4c00::/23",
    "2001:5000::/20", "2001:8000::/19", "2001:a000::/20", "2001:b000::/20", "2003::/18", "2400::/12", "2410::/12",
    "2600::/12", "2610::/23", "2620::/23", "2630::/12", "2800::/12", "2a00::/12", "2a10::/12", "2c00::/12",
];
const IPV6_EXCLUDED = ["2001:db8::/32"];   // documentation (inside APNIC's 2001:c00::/23)
const v6big = (groups) => groups.reduce((n, x) => (n << 16n) | BigInt(x), 0n);
const parsed = (list) => list.map((c) => { const [a, bits] = c.split("/"); return [v6big(v6Groups(a)), BigInt(bits)]; });
const ALLOCATED = parsed(IPV6_ALLOCATED), EXCLUDED = parsed(IPV6_EXCLUDED);
const inAny = (n, nets) => nets.some(([net, bits]) => (n >> (128n - bits)) === (net >> (128n - bits)));

/** Is `ip` (a literal) an address a public server could have? */
export function isPublicAddress(ip) {
    const s = String(ip || "");
    if (s.includes("%")) return false;                                            // a zone id: link-scoped, never public
    const v = isIP(s);
    if (v === 4) return v4Public(s);
    if (v !== 6) return false;
    const g = v6Groups(s);
    if (g.slice(0, 6).every((x) => x === 0)) return false;                        // ::, ::1, IPv4-compatible
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return false;      // IPv4-mapped: never
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Public(v4of(g[6], g[7]));  // NAT64
    const n = v6big(g);
    return inAny(n, ALLOCATED) && !inAny(n, EXCLUDED);
}

/** A c-ares resolver: 3 s per try, 2 tries, cancellable (never the libuv thread pool). */
export const newResolver = () => new dnsPromises.Resolver({ timeout: 3000, tries: 2 });

/** Resolve `host` (A and AAAA); every answer must be public. -> {address, family} (the first: what the fetch connects to). */
export async function resolvePublic(host, resolver = newResolver()) {
    const [a, aaaa] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const addrs = [
        ...(a.status === "fulfilled" && Array.isArray(a.value) ? a.value.map((address) => ({ address, family: 4 })) : []),
        ...(aaaa.status === "fulfilled" && Array.isArray(aaaa.value) ? aaaa.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (!addrs.length) throw Object.assign(new Error(`Couldn't find ${host}`), { status: 502 });
    if (addrs.some((x) => !isPublicAddress(x.address))) {
        throw Object.assign(new Error(`${host} isn't a public server`), { status: 403, reason: "not-public" });
    }
    return addrs[0];
}

/**
 * GET the normalised link from the pinned address. -> {status: 200, type, ext, data} for audio; {status: N} for
 * another answer; throws {status: 413} past maxBytes, {status: 502, reason: "redirect"} for any redirect, {status: 415}
 * for bytes that aren't audio, {status: 502} for a connection, TLS or timeout failure.
 */
export function fetchForeignClip(url, pin, { maxBytes, timeoutMs = 20_000, request = https.request } = {}) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
        let settled = false, req = null, response = null;
        // every way out: stop the transfer first (a refused answer's body is never read on, whatever it streams)
        const teardown = () => {
            try { response?.destroy(); } catch { /* gone */ }
            try { req?.destroy(); } catch { /* gone */ }
        };
        const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); teardown(); fn(v); } };
        const fail = (status, error, extra = {}) => done(reject, Object.assign(new Error(error), { status, ...extra }));
        const timer = setTimeout(() => fail(502, "The other server didn't answer in time"), timeoutMs);
        req = request({
            host: u.hostname, servername: u.hostname, port: 443, method: "GET", path: u.pathname + u.search, agent: false,
            headers: { host: u.hostname, accept: "audio/*, */*;q=0.1", "user-agent": "TinHatServer-soundboard/1" },
            // exactly the address that was checked: the name is never looked up again (no DNS rebinding)
            lookup: (_name, opts, cb) => (opts && opts.all ? cb(null, [{ address: pin.address, family: pin.family }])
                : cb(null, pin.address, pin.family)),
        }, (res) => {
            response = res;
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400) return fail(502, "The other server redirected (not followed)", { reason: "redirect", upstream: code });
            if (code !== 200) return done(resolve, { status: code });
            const declared = Number(res.headers["content-length"] || 0);
            if (declared > maxBytes) return fail(413, "too big");
            const chunks = [];
            let n = 0;
            res.on("data", (c) => {
                n += c.length;
                if (n > maxBytes) return fail(413, "too big");
                chunks.push(c);
            });
            res.on("end", () => {
                if (settled) return;
                const data = Buffer.concat(chunks);
                const kind = sniffClipAudio(data.subarray(0, 64));
                if (!kind) return fail(415, `not audio (the other server said ${String(res.headers["content-type"] || "nothing").slice(0, 40)})`);
                done(resolve, { status: 200, type: kind.type, ext: kind.ext, data });
            });
            res.on("error", (e) => fail(502, e.message));
        });
        req.on("error", (e) => fail(502, e.message));
        req.end();
    });
}

/**
 * Resolve, check and fetch under ONE deadline (second review, #2: resolution used to run before admission and outside
 * any deadline). The resolver is cancelled when the deadline passes. -> what fetchForeignClip answers; throws its
 * errors, {status: 403, reason: "not-public"} or {status: 502} (no answer, or out of time).
 */
export async function foreignDownload(url, host, { maxBytes, timeoutMs = 20_000, resolver = newResolver(), request = https.request } = {}) {
    const started = Date.now();
    let timer;
    const late = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { resolver.cancel(); } catch { /* nothing pending */ }
            reject(Object.assign(new Error("The other server's name didn't resolve in time"), { status: 502 }));
        }, timeoutMs);
    });
    let pin;
    try { pin = await Promise.race([resolvePublic(host, resolver), late]); } finally { clearTimeout(timer); }
    const left = Math.max(1, timeoutMs - (Date.now() - started));
    return fetchForeignClip(url, pin, { maxBytes, timeoutMs: left, request });
}
