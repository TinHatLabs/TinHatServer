// background.mjs — chat backgrounds that match the game being played (lane sun-gamebg, 2026-11-14).
//
// Two jobs, both pure or dependency-injected so the tests drive them:
//   • gameKey / resolveNames — map the status texts people already share ("Valheim", "Playing Valheim") to catalogue
//     ids, by a LOCAL catalogue lookup only. Nothing here ever asks Steam: a status text never leaves the server.
//   • createBackgroundArt — the wide "background" art kind (Steam library hero / the stored SteamGridDB hero), fetched
//     by the SERVER once, from an allow-list of https hosts, size-capped, image bytes only, cached on disk, with a
//     remembered miss. No art → null (the route answers 404 and the app shows the room's fallback preset).
//
// The normalisation (gameKey) is shared byte-for-byte with both apps: testvectors gamebg/vectors.json "gameKey".
import { writeFileSync, renameSync, unlinkSync, openSync, fstatSync, readSync, closeSync, constants as FS } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export const BG = Object.freeze({
    MAX_BYTES: 4 * 1024 * 1024,      // full quality, never re-encoded: a Steam 3840×1240 hero is 0.7–1.6 MB; a bigger
                                     // SteamGridDB PNG is skipped for the next source
    MIN_BYTES: 512,                  // smaller is an error page, not art
    TIMEOUT_MS: 15_000,
    MISS_TTL_MS: 6 * 3600_000,       // a game without art is asked again after 6 h, not on every view
    MAX_REDIRECTS: 0,                // launch-gate: a redirect is refused (Steam/SGDB art urls answer directly)
    RESOLVE_MAX_NAMES: 20,
    MAX_DOWNLOADS: 2,                // background art downloads at once, server-wide (astra: bound the aggregate work)
    MAX_QUEUED: 32,                  // more waiting than this → a miss for now (asked again after the miss TTL)
    NAME_MAX: 64,
});

/** https hosts the server may fetch background art from (the ones the catalogue's own art urls point at). */
export const ART_HOSTS = Object.freeze([
    "cdn.cloudflare.steamstatic.com",
    "shared.cloudflare.steamstatic.com",
    "cdn.akamai.steamstatic.com",
    "shared.akamai.steamstatic.com",
    "steamcdn-a.akamaihd.net",
    "cdn2.steamgriddb.com",
]);

export function isAllowedArtUrl(u) {
    let url;
    try { url = new URL(String(u)); } catch { return false; }
    return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && ART_HOSTS.includes(url.hostname);
}

/** `ip` as 16 bytes (IPv4 → the IPv4-mapped form), or null when it isn't an address. Every spelling (compressed,
 *  expanded, dotted tail, upper case) gives the same bytes, so the ranges below can't be dodged by spelling. */
export function ipBytes(ip) {
    const s = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const v = isIP(s);
    const v4 = (t) => t.split(".").map(Number);
    if (v === 4) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...v4(s)];
    if (v !== 6) return null;
    let t = s;
    const dot = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
    if (dot) {
        const q = v4(dot[1]);
        t = `${t.slice(0, -dot[1].length)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
    }
    const [l, r] = t.includes("::") ? t.split("::") : [t, null];
    const groups = (x) => (x ? x.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
    const left = groups(l), right = r === null ? [] : groups(r);
    const fill = r === null ? [] : new Array(Math.max(0, 8 - left.length - right.length)).fill(0);
    const g = [...left, ...fill, ...right];
    if (g.length !== 8 || g.some((x) => !(x >= 0 && x <= 0xffff))) return null;
    return g.flatMap((x) => [x >> 8, x & 255]);
}
/** Is `ip` an address the server must never fetch art from? Loopback, unspecified, private, link-local, unique-local,
 *  CGNAT, multicast/reserved, documentation and benchmark ranges, NAT64 — compared as BYTES (any spelling), IPv4-mapped
 *  and IPv4-compatible forms included. Not an address → true (refuse). */
export function isPrivateAddress(ip) {
    const b = ipBytes(ip);
    if (!b) return true;
    const zero10 = b.slice(0, 10).every((x) => x === 0);
    const mapped = zero10 && b[10] === 0xff && b[11] === 0xff;
    const compat = zero10 && b[10] === 0 && b[11] === 0;
    if (mapped || (compat && b.slice(12).some((x) => x !== 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1))) {
        const [a, c, d] = b.slice(12);
        return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && c >= 64 && c <= 127) || (a === 169 && c === 254)
            || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 192 && c === 0) || (a === 198 && (c === 18 || c === 19))
            || (a === 198 && c === 51 && d === 100) || (a === 203 && c === 0 && d === 113);
    }
    if (b.every((x, i) => (i < 15 ? x === 0 : x <= 1))) return true;                 // :: and ::1
    if ((b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || b[0] === 0xff) return true; // ULA, link-local, multicast
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // 64:ff9b::/96 NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return true;                                   // 6to4 (embeds any IPv4)
    return false;
}

/** A dns.lookup that refuses a name if ANY of its addresses is private (so the connection can only go to a public one).
 *  It is the lookup the connection itself uses, so there is no check-then-connect gap (DNS rebinding). */
export function guardedLookup(lookupImpl = dnsLookup) {
    return (hostname, opts, cb) => {
        if (typeof opts === "function") { cb = opts; opts = {}; }
        lookupImpl(hostname, { all: true, family: opts?.family || 0 }, (err, addrs) => {
            if (err) return cb(err);
            const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: isIP(addrs) }];
            if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
                const e = new Error(`refused: ${hostname} resolves to a private address`); e.code = "EPRIVATE";
                return cb(e);
            }
            if (opts?.all) return cb(null, list);
            cb(null, list[0].address, list[0].family);
        });
    };
}

/** The default fetcher: node:https with the guarded lookup, never following redirects (fetchCappedArt does that by
 *  hand, re-checking every hop). Answers a web Response. */
export function guardedFetch({ lookupImpl = dnsLookup } = {}) {
    const lookup = guardedLookup(lookupImpl);
    return (url, { signal } = {}) => new Promise((resolve, reject) => {
        const u = new URL(url);
        if (u.protocol !== "https:") return reject(new Error("https only"));
        const req = httpsRequest(u, { method: "GET", lookup, signal, headers: { "user-agent": "TinHat-games/1", accept: "image/*" } }, (res) => {
            try {
                const headers = new Headers();
                for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
                const status = res.statusCode || 502;
                // only a 200 carries a body we read; anything else is answered with no body and the socket dropped
                if (status !== 200) {
                    res.destroy();
                    return resolve(new Response(null, { status: status >= 200 && status <= 599 && ![101, 204, 205, 304].includes(status) ? status : 502, headers }));
                }
                resolve(new Response(Readable.toWeb(res), { status, headers }));
            } catch (e) {
                res.destroy();
                req.destroy();
                reject(e);
            }
        });
        req.on("error", reject);
        req.end();
    });
}

/** The image type of `buf` by its magic bytes, or null (never trust a Content-Type). */
export function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => buf[i] === x)) return "image/png";
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
    return null;
}

// ── names → catalogue ids ─────────────────────────────────────────────────────
const WS = new Set([" ", "\t", "\n", "\r", "\f", "\v", " "]);
const MARKS = new Set(["™", "®", "©"]); // ™ ® ©
/**
 * The comparable form of a game name or a status text. Byte-identical rules in both apps (vectors "gameKey"):
 * drop ™ ® ©; every run of ASCII whitespace / NBSP → one space; trim; ASCII-only lower case; strip ONE leading
 * "now playing" or "playing" followed by ":", "-" or a space; strip trailing "." and "!"; trim again.
 * Not a string, or longer than 64 characters (code points) after all that → "".
 */
export function gameKey(s) {
    if (typeof s !== "string") return "";
    let out = "";
    let pendingSpace = false;
    for (const ch of s) {
        if (MARKS.has(ch)) continue;
        if (WS.has(ch)) { pendingSpace = out.length > 0; continue; }
        if (pendingSpace) { out += " "; pendingSpace = false; }
        const c = ch.charCodeAt(0);
        out += ch.length === 1 && c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
    }
    for (const p of ["now playing", "playing"]) {
        if (out.startsWith(p)) {
            const rest = out.slice(p.length);
            const m = /^(?: *[:-] *| +)/.exec(rest);
            if (m && rest.length > m[0].length) { out = rest.slice(m[0].length); break; }
        }
    }
    out = out.replace(/[.!]+$/, "").replace(/ +$/, "");
    return [...out].length > BG.NAME_MAX ? "" : out;
}

/**
 * names → { name: id | null }: an exact gameKey match against the catalogue's names and aliases (rows merged into
 * another and non-games are skipped). Several rows with the same key → the one with a Steam appid, then the smallest id.
 * `rows`: [{ id, name, aliases?, appid?, type?, mergedInto? }]. At most RESOLVE_MAX_NAMES names are answered.
 */
export function resolveNames(names, rows) {
    const index = new Map();
    const better = (a, b) => (!!a.appid !== !!b.appid ? (a.appid ? a : b) : (a.id < b.id ? a : b));
    for (const r of rows) {
        if (!r || r.mergedInto || typeof r.id !== "string" || (r.type && r.type !== "game")) continue;
        for (const n of [r.name, ...(Array.isArray(r.aliases) ? r.aliases : [])]) {
            const k = gameKey(n);
            if (!k) continue;
            const prev = index.get(k);
            index.set(k, prev ? better(prev, r) : r);
        }
    }
    const out = Object.create(null);
    const list = Array.isArray(names) ? names.slice(0, BG.RESOLVE_MAX_NAMES) : [];
    for (const n of list) {
        if (typeof n !== "string" || n.length > 256) continue;
        const k = gameKey(n);
        out[n] = (k && index.get(k)?.id) || null;
    }
    return out;
}

// ── the "background" art kind ─────────────────────────────────────────────────
/** Where a game's background art may come from, best (largest) first. Steam: the 3840×1240 library hero, then the
 *  1920×620 one. Otherwise the hero the catalogue stored (SteamGridDB). Only allow-listed https urls. */
export function backgroundSources(entry) {
    const out = [];
    const hero = entry?.art?.hero;
    if (typeof hero === "string" && /\/library_hero\.jpg$/.test(hero)) out.push(hero.replace(/library_hero\.jpg$/, "library_hero_2x.jpg"));
    if (hero) out.push(hero);
    return out.filter(isAllowedArtUrl);
}

/**
 * GET `url` with the rules: https + allow-listed host, a redirect is refused (MAX_REDIRECTS 0), a byte cap
 * enforced while reading (Content-Length is not trusted), image magic only. → Buffer | null.
 */
export async function fetchCappedArt(url, { fetchImpl = guardedFetch(), maxBytes = BG.MAX_BYTES, timeoutMs = BG.TIMEOUT_MS } = {}) {
    let u = url;
    for (let hop = 0; hop <= BG.MAX_REDIRECTS; hop++) {
        if (!isAllowedArtUrl(u)) return null;
        let r;
        try { r = await fetchImpl(u, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); } catch { return null; }
        const drop = async () => { try { await r.body?.cancel?.(); } catch {} };
        if (r.status >= 300 && r.status < 400) {
            const loc = r.headers?.get?.("location");
            await drop();
            if (!loc || hop >= BG.MAX_REDIRECTS) return null;
            try { u = new URL(loc, u).toString(); } catch { return null; }
            continue;
        }
        if (r.status !== 200) { await drop(); return null; }
        const declared = Number(r.headers?.get?.("content-length") || 0);
        if (declared > maxBytes) { try { await r.body?.cancel?.(); } catch {} return null; }
        const chunks = [];
        let total = 0;
        try {
            if (!r.body || typeof r.body.getReader !== "function") return null; // the cap is enforced while reading, only
            const rd = r.body.getReader();
            for (;;) {
                const { done, value } = await rd.read();
                if (done) break;
                total += value.length;
                if (total > maxBytes) { try { await rd.cancel(); } catch {} return null; }
                chunks.push(Buffer.from(value));
            }
        } catch { return null; }
        const buf = Buffer.concat(chunks);
        if (buf.length < BG.MIN_BYTES || !sniffImage(buf)) return null;
        return buf;
    }
    return null;
}

/**
 * The background art cache. `get(entry)` → a file path or null. A miss (no source, a refused or failed fetch) is
 * remembered for MISS_TTL_MS per game, so a room full of people viewing a game without art costs one fetch, not one each.
 * Concurrent asks for one game share one fetch. `manualFile(entry)` (optional) → a hand-placed file that wins.
 */
export function createBackgroundArt({ dir, fetchImpl = guardedFetch(), now = Date.now, manualFile = () => null, maxBytes = BG.MAX_BYTES }) {
    const misses = new Map();     // id → time of the miss
    const inflight = new Map();
    // one file per id: a hash of the WHOLE id (custom:a-b and custom:a_b must never share a file)
    const fileOf = (entry) => join(dir, `bg-${createHash("sha256").update(entry.id).digest("hex").slice(0, 40)}.background`);
    let fetches = 0, active = 0;
    const waiting = [];
    const slot = () => new Promise((resolve) => (active < BG.MAX_DOWNLOADS ? (active++, resolve(true)) : waiting.length >= BG.MAX_QUEUED ? resolve(false) : waiting.push(resolve)));
    const release = () => { const next = waiting.shift(); if (next) next(true); else active--; };
    const miss = (id) => {
        misses.set(id, now());
        if (misses.size > 5000) misses.delete(misses.keys().next().value);
        return null;
    };
    async function get(entry) {
        if (!entry || typeof entry.id !== "string") return null;
        try {
            const m = manualFile(entry);
            if (m) return m;
            const file = fileOf(entry);
            if (readCapped(file, maxBytes)) return file;
            const missAt = misses.get(entry.id);
            if (missAt !== undefined && now() - missAt < BG.MISS_TTL_MS) return null;
            if (inflight.has(entry.id)) return inflight.get(entry.id);
            const p = (async () => {
                const sources = backgroundSources(entry);
                if (!sources.length) return miss(entry.id);
                if (!(await slot())) return miss(entry.id);
                try {
                    for (const url of sources) {
                        fetches++;
                        const buf = await fetchCappedArt(url, { fetchImpl, maxBytes });
                        if (!buf) continue;
                        const tmp = `${file}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
                        try {
                            writeFileSync(tmp, buf, { flag: "wx" });
                            renameSync(tmp, file);
                        } catch {
                            try { unlinkSync(tmp); } catch {}
                            return miss(entry.id);
                        }
                        misses.delete(entry.id);
                        return file;
                    }
                    return miss(entry.id);
                } finally { release(); }
            })();
            inflight.set(entry.id, p);
            try { return await p; } finally { inflight.delete(entry.id); }
        } catch {
            return miss(entry.id);
        }
    }
    return { get, stats: () => ({ fetches, misses: misses.size, active, waiting: waiting.length }) };
}

/** A regular file's bytes when it is 1 … max bytes long (checked on the OPEN descriptor, never read past max), else
 *  null. A cache file that turned out empty / huge / not a file reads as absent. */
export function readCapped(file, max = BG.MAX_BYTES) {
    let fd = -1;
    try {
        fd = openSync(file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
        const st = fstatSync(fd);
        if (!st.isFile() || st.size < 1 || st.size > max) return null;
        const buf = Buffer.alloc(st.size);
        let off = 0;
        while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
        return off === st.size ? buf : null;
    } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}
