// clipcache.mjs — the soundboard's myinstants clip cache (server.mjs /clip?url=, /fetch?url=) made bounded
// (security review 2026-10-26, finding H4).
//
//   normaliseClipUrl  one canonical https URL per myinstants clip: no query, no fragment, no port or userinfo, the
//                     apex host folded into www, every path segment decoded and re-encoded. The cache key is its
//                     sha256, so `…/x.mp3?1`, `…/x.mp3?2`, `…/%78.mp3` are one entry, not one each.
//   ClipStore         the files on disk with a byte budget: least recently played first out. Entries cached by older
//                     versions (keyed on the raw URL) are counted and age out like any other.
//   Admitted          clip URLs one of this server's own search answers handed out (24 h): a player may fetch those
//                     from myinstants without a token (an <audio> element or GStreamer can't send one).
//   oneDownload       one download per clip, registered without an await in between, removed only by itself.
//   createClipSigner  short-lived signed clip links for members (/clip/sign): HMAC-SHA256 over the normalised URL,
//                     the expiry and the budget principal that pays for the downloads, compared in constant time.
//
// Pure apart from ClipStore's file operations; no dependency.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, statSync, unlinkSync, utimesSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export const CLIP_TYPES = Object.freeze({ mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", webm: "audio/webm" });
const EXT_RE = /\.(mp3|ogg|opus|wav|m4a|webm)$/i;
const FILE_RE = /^([0-9a-f]{64})\.(mp3|ogg|opus|wav|m4a|webm)$/;

/** The first `n` bytes of a file (fewer if it is shorter). */
function head(path, n) {
    const fd = openSync(path, "r");
    try { const b = Buffer.alloc(n); return b.subarray(0, readSync(fd, b, 0, n, 0)); } finally { closeSync(fd); }
}

/** The canonical myinstants clip URL, or null when it isn't one we fetch. A bare path is myinstants'. */
export function normaliseClipUrl(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s || s.length > 2048) return null;
    let u;
    if (!/^https?:\/\//i.test(s) && !s.startsWith("/")) return null;   // a URL, or a path on myinstants ("/media/…")
    try { u = new URL(s.startsWith("/") ? `https://www.myinstants.com${s}` : s); } catch { return null; }
    if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
    let host = u.hostname.toLowerCase();
    if (host === "myinstants.com") host = "www.myinstants.com";
    // exactly myinstants.com or one of its subdomains (endsWith alone let evilmyinstants.com through)
    if (!host.endsWith(".myinstants.com") || !/^[a-z0-9.-]+$/.test(host)) return null;
    const segs = u.pathname.split("/").slice(1);
    if (!segs.length || segs.length > 8 || u.pathname.length > 512) return null;
    const out = [];
    for (const seg of segs) {
        let d;
        try { d = decodeURIComponent(seg); } catch { return null; }
        if (!d || d === "." || d === ".." || /[\/\\\u0000-\u001f\u007f]/.test(d)) return null;
        out.push(encodeURIComponent(d));
    }
    return `https://${host}/${out.join("/")}`;
}

/** The cache entry of a normalised clip URL: {key, ext, file, metaFile} under `dir`. */
export function clipPaths(dir, norm) {
    const key = createHash("sha256").update(norm).digest("hex");
    const m = EXT_RE.exec(new URL(norm).pathname);
    const ext = m ? m[1].toLowerCase() : "mp3";
    return { key, ext, file: join(dir, `${key}.${ext}`), metaFile: join(dir, `${key}.json`) };
}

/**
 * The clip files with a byte budget. Recency lives in memory (a Map in least-recently-played order), seeded from
 * the files' mtimes at start; a play bumps the mtime (at most once a minute per clip) so the order survives restarts.
 */
export class ClipStore {
    constructor({ dir, maxBytes, now = Date.now, log = () => {}, sniff = null }) {
        this.dir = dir; this.maxBytes = maxBytes; this.now = now; this.log = log;
        this.sniff = sniff;   // bytes -> {type} | null: at start, a cached clip that isn't audio is dropped (round 3)
        this.entries = new Map();   // key -> {file, metaFile, bytes, last}
        this.total = 0;
    }

    /** Read what is on disk; drop unfinished downloads older than an hour and sidecars whose audio is gone. */
    scan() {
        let names = [];
        try { names = readdirSync(this.dir); } catch { return this; }
        const found = [];
        const audio = new Set();
        for (const n of names) {
            const p = join(this.dir, n);
            if (n.includes(".part-")) {
                try { if (this.now() - statSync(p).mtimeMs > 3600_000) unlinkSync(p); } catch { /* gone */ }
                continue;
            }
            const m = FILE_RE.exec(n);
            if (!m) continue;
            try {
                if (this.sniff && !this.sniff(head(p, 64))) {
                    unlinkSync(p);
                    try { unlinkSync(join(this.dir, `${m[1]}.json`)); } catch { /* no sidecar */ }
                    this.log(`dropped cached clip ${m[1].slice(0, 12)}: not audio`);
                    continue;
                }
                const st = statSync(p);
                found.push({ key: m[1], file: p, metaFile: join(this.dir, `${m[1]}.json`), bytes: st.size, last: st.mtimeMs });
                audio.add(m[1]);
            } catch { /* gone */ }
        }
        for (const n of names) {
            const m = /^([0-9a-f]{64})\.json$/.exec(n);
            if (m && !audio.has(m[1])) { try { unlinkSync(join(this.dir, n)); } catch { /* gone */ } }
        }
        found.sort((a, b) => a.last - b.last);
        this.entries.clear();
        this.total = 0;
        for (const e of found) { this.entries.set(e.key, e); this.total += e.bytes; }
        this.evict();
        return this;
    }

    /** Where a normalised clip URL lives: {key, ext, file, metaFile}. */
    paths(norm) { return clipPaths(this.dir, norm); }

    /** A cached clip: {file, contentType} (and it becomes the most recently played), else null. */
    get(norm) {
        const { key, ext, file, metaFile } = clipPaths(this.dir, norm);
        const e = this.entries.get(key);
        if (!e) return null;
        let ct = CLIP_TYPES[ext];
        try { ct = JSON.parse(readFileSync(metaFile, "utf8")).content_type || ct; } catch { /* no sidecar */ }
        if (!/^audio\/[a-z0-9.+-]+$/i.test(String(ct))) ct = CLIP_TYPES[ext] || "audio/mpeg";  // audio only, ever
        this.touch(key);
        return { file, contentType: ct };
    }

    touch(key) {
        const e = this.entries.get(key);
        if (!e) return;
        const t = this.now();
        this.entries.delete(key);
        this.entries.set(key, e);
        if (t - e.last > 60_000) {
            e.last = t;
            try { utimesSync(e.file, t / 1000, t / 1000); } catch { /* best effort */ }
        }
    }

    /** A clip just written: count it, then make room. */
    add(key, file, metaFile, bytes) {
        const old = this.entries.get(key);
        if (old) { this.total -= old.bytes; this.entries.delete(key); }
        const t = this.now();
        this.entries.set(key, { file, metaFile, bytes, last: t });
        try { utimesSync(file, t / 1000, t / 1000); } catch { /* best effort */ }
        this.total += bytes;
        this.evict(key);
    }

    /** Least recently played out until the total fits (`keep`: the clip just added stays). */
    evict(keep = null) {
        for (const [key, e] of this.entries) {
            if (this.total <= this.maxBytes) break;
            if (key === keep) continue;
            try { unlinkSync(e.file); } catch { /* already gone */ }
            try { unlinkSync(e.metaFile); } catch { /* no sidecar */ }
            this.entries.delete(key);
            this.total -= e.bytes;
            this.log(`evicted clip ${key.slice(0, 12)} (${e.bytes} B)`);
        }
    }
}

/** Clip URLs (normalised) a search answer of ours handed out, for `ttlMs`; at most `max`, oldest out first. */
export class Admitted {
    constructor({ max = 20_000, ttlMs = 24 * 3600_000, now = Date.now } = {}) { this.max = max; this.ttlMs = ttlMs; this.now = now; this.m = new Map(); }
    add(norm) {
        if (!norm) return;
        this.m.delete(norm);
        this.m.set(norm, this.now() + this.ttlMs);
        while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    }
    has(norm) {
        const exp = this.m.get(norm);
        if (exp === undefined) return false;
        if (exp < this.now()) { this.m.delete(norm); return false; }
        return true;
    }
}

/**
 * Signed clip links. key: a secret (Buffer or string); ttlMs: how long a link works. Every link names its budget
 * principal (whoever asked for it pays for the downloads it causes: security review, second round), covered by the MAC.
 * principalOf(mxid) -> 16 hex (opaque: no account name in a URL); sign(norm, principal) -> {exp, sig};
 * verify(norm, exp, sig, principal) -> bool (constant-time compare; an expired or malformed link is false).
 */
export function createClipSigner({ key, ttlMs = 3600_000, now = Date.now }) {
    const PRINCIPAL_RE = /^[0-9a-f]{16}$/;
    const mac = (norm, exp, p) => createHmac("sha256", key).update(`tinhat-clip-v2\0${norm}\0${exp}\0${p}`).digest("hex").slice(0, 32);
    return {
        ttlMs,
        principalOf(mxid) { return createHmac("sha256", key).update(`tinhat-clip-principal\0${mxid}`).digest("hex").slice(0, 16); },
        sign(norm, principal) {
            if (!PRINCIPAL_RE.test(String(principal))) throw new Error("bad principal");
            const exp = now() + ttlMs;
            return { exp, sig: mac(norm, exp, principal) };
        },
        verify(norm, exp, sig, principal) {
            const e = Number(exp);
            if (!Number.isSafeInteger(e) || e < now() || e > now() + ttlMs + 60_000) return false;
            if (typeof sig !== "string" || !/^[0-9a-f]{32}$/.test(sig)) return false;
            if (typeof principal !== "string" || !PRINCIPAL_RE.test(principal)) return false;
            return timingSafeEqual(Buffer.from(sig), Buffer.from(mac(norm, e, principal)));
        },
    };
}

/**
 * One download per clip (second review: two signed-in requests both passed the in-flight check while their sign-in
 * checks were pending, and each finished download deleted whatever promise was registered). Call it AFTER every await
 * that decides whether the caller may fetch: it looks at the cache and the running downloads again, and from there to
 * registering its own promise nothing awaits. gate() runs only when a new download is needed and returns null (go on:
 * it has reserved / charged what it must) or a refusal to hand back (it must leave nothing spent); start() begins the
 * download. A finished download removes only its own registration. -> {got} | {refused}.
 */
export async function oneDownload(inflight, key, { cached, gate, start }) {
    const hit = cached();
    if (hit) return { got: hit };
    let p = inflight.get(key);
    if (!p) {
        const refused = gate();
        if (refused) return { refused };
        const mine = start();
        inflight.set(key, mine);
        mine.then(() => {}, () => {}).finally(() => { if (inflight.get(key) === mine) inflight.delete(key); });
        p = mine;
    }
    return { got: await p };
}

/** Equal-length hex strings in constant time (the Memories links' signatures: security review, vodsSig). */
export function sameHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !/^[0-9a-f]*$/.test(a)) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
