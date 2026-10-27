// watch.mjs — Media Party browse / meta / resolve routes for the Tin Hat API (Tin Hat 11.4, 2026-10-11).
//
// Contract: the Media Party contract §3 (binding). The web server in front maps https://<server>/api/watch/* to
// http://127.0.0.1:3001/youtube/*.
//
//   GET /youtube/search?q=&type=video|music|playlist|channel&max=&page=&v=2
//        without v=2: the OLD array [{videoId,title,thumb,channel,durationSec}] (11.2.1 clients, unchanged)
//        with    v=2: {items:[Item], nextPage, cached}                         100 units (+1)   cached 24 h
//   GET /youtube/suggest?q=                -> ["…", …] (≤10)                   0 units          cached 1 h
//   GET /youtube/trending?cat=&region=     -> {items:[Item]} (≤30)             1 unit           cached 1 h
//   GET /youtube/playlist?id=&page=        -> {id,title,channel,thumb,itemCount,items,nextPage}  2 units, 6 h
//   GET /youtube/channel?id=|handle=&page= -> {id,title,thumb,uploadsPlaylist,items,nextPage}    2 units, 6 h
//   GET /youtube/meta?url=                 -> Meta (YouTube / YouTube Music / Spotify / Apple Music link)  0–2 units, forever
//   GET /youtube/resolve?url= | artist=&title= -> {videoId,url,title,channel,thumb,durationSec,confidence} | 404 {error:"nomatch"}
//   GET /youtube/budget                    -> {unitsToday, limit:10000, searchesLeft, resetAt}
//
// Item = {kind:"video"|"playlist"|"channel", id, url, title, thumb, channel, channelId, durationSec?, views?, publishedAt?, itemCount?}
// Meta = {kind:"video"|"playlist"|"channel"|"song"|"album"|"unknown", service:"youtube"|"ytmusic"|"spotify"|"apple", id, url,
//         title, artist?, album?, thumb?, durationSec?, preview?, tracks?:[{title, artist, durationSec?, id?, url?}]}
//
// Store: SQLite (node:sqlite, node >= 22.5) at <dataDir>/watch.db — tables cache (key/value/expires), quota (units per
// America/Los_Angeles day = Google's reset) and calls (one row per Data API call, 30 days, for inspection). Falls back to
// a JSON file <dataDir>/watch.json if node:sqlite is missing, so the service still starts.
// Budget: uncached `search` answers 503 {error:"budget",resetAt} above 9 000 units, `resolve` above 9 800; everything
// cached or costing ≤ 3 units keeps working. Google's own 403 quotaExceeded is mapped to the same 503.
// Who spends (security review 2026-10-26, H4): installWatch's `guard` (access.memberOrLegacy) runs first on every route;
// a member's Data API units come out of their own budget per Pacific day (userUnitsPerDay; over it: the same 503
// {error:"budget"} with scope "you"), a caller without a token out of its own (anonUnitsPerDay, per address) under a
// ceiling for all of them together (anonAllUnitsPerDay); over either: 401 {signin:true}. Cached answers cost nothing
// and are served to both. createUnitBudget is pure (tests).
// Upstream: 8 s timeout per call, 2 MB body cap, https only (redirects followed by hand, never to non-https), at most
// 2 upstream calls per leg (see resolve). The Data API key comes in from server.mjs (youtube.key) and never appears in
// a log line, an error message or a response.
// The pure helpers (parseMediaUrl, normaliseTitle, similarity, scoreCandidate, rankCandidates, pickBest, iso8601ToSec,
// pacificDay, pacificResetAt) are exported for watch.test.mjs (`node --test watch.test.mjs`); importing this module
// has no side effects — the store opens inside installWatch().

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { clientKey } from "./reachcommon.mjs";

export const LIMIT = 10000;
export const SEARCH_CUTOFF = 9000;
export const RESOLVE_CUTOFF = 9800;
export const MIN_CONFIDENCE = 0.45;
const SEARCH_COST = 100;
const H = 3600_000;
const D = 24 * H;
const TTL = { search: D, suggest: H, trending: H, playlist: 6 * H, channel: 6 * H, meta: null, metaPlaylist: D, notfound: H, nomatch: D };
const MAX_BODY = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_CALLS = 2;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 TinHat-MediaParty/1.0";
const TYPES = ["video", "music", "playlist", "channel"];
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;           // contract: ids
const TOKEN_RE = /^[A-Za-z0-9_=-]{1,128}$/;      // Data API page tokens
const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST = /^[A-Za-z0-9_-]{13,64}$/;
const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const YT_HANDLE = /^@[A-Za-z0-9_.\-]{3,64}$/;
const SP_ID = /^[A-Za-z0-9]{22}$/;
const AP_NUM = /^\d{1,20}$/;
const AP_PL = /^pl\.[A-Za-z0-9_.\-]{6,80}$/i;

// ── small pure helpers ────────────────────────────────────────────────────────────────────────────────────────────────
export function iso8601ToSec(d) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d || "");
    if (!m) return 0;
    return +(m[1] || 0) * 86400 + +(m[2] || 0) * 3600 + +(m[3] || 0) * 60 + +(m[4] || 0);
}
export function decodeEntities(s) {
    return (s || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
/** "YYYY-MM-DD" of the Pacific-time day `now` falls in (Google's quota day). */
export function pacificDay(now = Date.now()) {
    return DAY_FMT.format(new Date(now));
}
/** ISO instant of the next Pacific midnight (= when the quota resets), DST-safe. */
export function pacificResetAt(now = Date.now()) {
    const today = pacificDay(now);
    const [y, m, d] = today.split("-").map(Number);
    for (const h of [7, 8]) { // PDT = UTC-7, PST = UTC-8
        const t = Date.UTC(y, m - 1, d + 1, h);
        if (pacificDay(t) !== today && pacificDay(t - 60_000) === today) return new Date(t).toISOString();
    }
    return new Date(Date.UTC(y, m - 1, d + 1, 8)).toISOString();
}
const str = (x) => (typeof x === "string" ? x : "");
function clampInt(x, lo, hi, def) {
    const n = parseInt(str(x), 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, n));
}

// ── link parsing (YouTube / YouTube Music / Spotify / Apple Music) ────────────────────────────────────────────────────
/**
 * Classify a pasted link. Returns null for an unsupported host / scheme, otherwise
 * { service: youtube|ytmusic|spotify|apple, kind: video|playlist|channel|song|album|unknown, id, … }.
 * YouTube channels may come back with `handle` (@name, also /c/<name>) or `user` (/user/<name>) instead of `id`.
 */
export function parseMediaUrl(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    if (!s || s.length > 2048) return null;
    const sp = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(s);
    if (sp) return { service: "spotify", kind: sp[1] === "track" ? "song" : sp[1], id: sp[2] };
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    if (/^(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com)$/.test(host) || host === "youtu.be") {
        const service = host === "music.youtube.com" ? "ytmusic" : "youtube";
        let v = u.searchParams.get("v");
        const list = u.searchParams.get("list");
        if (host === "youtu.be") v = segs[0] || v;
        else if (["shorts", "embed", "live", "v"].includes(segs[0]) && segs[1]) v = segs[1];
        if (v && YT_VIDEO.test(v)) {
            const r = { service, kind: "video", id: v };
            if (list && YT_LIST.test(list)) r.list = list;
            return r;
        }
        if (list && YT_LIST.test(list)) return { service, kind: "playlist", id: list };
        if (segs[0] === "channel" && segs[1] && YT_CHANNEL.test(segs[1])) return { service, kind: "channel", id: segs[1] };
        if (segs[0] && YT_HANDLE.test(segs[0])) return { service, kind: "channel", handle: segs[0] };
        if (segs[0] === "c" && segs[1] && YT_HANDLE.test("@" + segs[1])) return { service, kind: "channel", handle: "@" + segs[1] };
        if (segs[0] === "user" && segs[1] && /^[A-Za-z0-9_.\-]{1,64}$/.test(segs[1])) return { service, kind: "channel", user: segs[1] };
        return { service, kind: "unknown", id: "" };
    }
    if (host === "open.spotify.com" || host === "play.spotify.com") {
        let i = 0;
        if (/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(segs[0] || "")) i++;
        if (segs[i] === "embed") i++;
        const type = segs[i];
        const id = segs[i + 1] || "";
        if (["track", "album", "playlist"].includes(type) && SP_ID.test(id)) return { service: "spotify", kind: type === "track" ? "song" : type, id };
        return { service: "spotify", kind: "unknown", id: "" };
    }
    if (/^(geo\.|beta\.)?music\.apple\.com$/.test(host) || host === "itunes.apple.com") {
        let i = 0;
        let cc = "us";
        if (/^[a-z]{2}$/i.test(segs[0] || "")) { cc = segs[0].toLowerCase(); i++; }
        const type = segs[i];
        const rest = segs.slice(i + 1);
        const last = rest[rest.length - 1] || "";
        const trackId = u.searchParams.get("i");
        if (type === "album" && AP_NUM.test(last)) {
            if (trackId && AP_NUM.test(trackId)) return { service: "apple", kind: "song", id: trackId, albumId: last, cc };
            return { service: "apple", kind: "album", id: last, cc };
        }
        if (type === "song" && AP_NUM.test(last)) return { service: "apple", kind: "song", id: last, cc };
        if (type === "playlist" && AP_PL.test(last)) return { service: "apple", kind: "playlist", id: last, cc, slug: rest.length > 1 ? rest[0] : "" };
        return { service: "apple", kind: "unknown", id: "" };
    }
    return null;
}

// ── resolver ranking (pure) ───────────────────────────────────────────────────────────────────────────────────────────
// A YouTube title that carries one of these words while the wanted title does not is a different recording
// (cover, live take, remix, tutorial, …) and loses 0.3. Matched on word boundaries against the RAW title, before the
// noise stripping below (which would otherwise hide "(Live at …)").
const VARIANT_TAGS = [
    "cover", "covers", "live", "remix", "remixes", "karaoke", "instrumental", "acoustic", "reaction", "sped up", "slowed",
    "nightcore", "8d", "mashup", "parody", "tutorial", "lesson", "how to play", "extended", "loop", "looped", "1 hour",
    "10 hours", "trailer", "teaser", "behind the scenes", "making of", "choreography", "orchestral", "lofi", "lo-fi",
    "reverb", "bass boosted", "unplugged", "medley", "concert", "tour", "rehearsal", "review", "vocals only", "piano",
];
const VARIANT_RES = VARIANT_TAGS.map((tag) => [tag, new RegExp(`(^|[^a-z0-9])${tag.replace(/[-\s]/g, "[\\s-]?")}([^a-z0-9]|$)`)]);
// Words that say "this is the song's video/audio" and nothing about which recording it is.
const NOISE_WORDS = /\b(official\s+(music\s+)?(video|audio|visuali[sz]er|lyric\s+video|lyrics)|official\s+video|official\s+audio|lyric\s+video|lyrics|visuali[sz]er|music\s+video|full\s+hd|hd|hq|4k)\b/g;

const fold = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
/** lowercase, ascii-folded, "&" → "and", punctuation → spaces, single-spaced. */
export const words = (s) => fold(s).replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/** Title → comparable core: brackets, "feat. …", "Official Video"-style noise and the artist's own name are removed. */
export function normaliseTitle(title, artist = "") {
    let t = fold(title);
    t = t.replace(/[([{][^)\]}]*[)\]}]/g, " ");               // "(Official Video)", "[Lyrics]", "(feat. X)", "(Live …)"
    t = t.replace(/\b(feat|ft|featuring)\.?\s.*$/, " ");        // trailing "feat. X …"
    t = t.replace(NOISE_WORDS, " ");
    t = words(t);
    const a = words(artist);
    if (a) {
        if (t.startsWith(a + " ")) t = t.slice(a.length + 1);
        else if (t.endsWith(" by " + a)) t = t.slice(0, -a.length - 4);
        else if (t.endsWith(" " + a)) t = t.slice(0, -a.length - 1);
    }
    return t.trim();
}
function bigrams(s) {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
}
/** 0..1 — Sørensen–Dice over character bigrams, lifted when one string contains the other. */
export function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0;
    for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
    const dice = (2 * inter) / (a.length - 1 + (b.length - 1));
    let contain = 0;
    if (a.length >= 4 && b.length >= 4 && (b.includes(a) || a.includes(b)))
        contain = 0.8 + (0.2 * Math.min(a.length, b.length)) / Math.max(a.length, b.length);
    return Math.max(dice, contain);
}
/**
 * Score one YouTube candidate {title, channel, description?, durationSec?} against the wanted song
 * {artist, title, durationSec?}. score = 0.5·titleSimilarity + 0.2 (artist in channel/title) + 0.3 (channel "… - Topic"
 * or description "Provided to YouTube by") + 0.3 (duration within 5 %; −0.2 when off by more than 25 %) − 0.3 (variant
 * word: cover/live/remix/…). confidence = score clamped to 0..1; rank by the raw score.
 */
export function scoreCandidate(cand, want) {
    const wantN = normaliseTitle(want.title, want.artist);
    const candN = normaliseTitle(cand.title, want.artist);
    const sim = similarity(wantN, candN);
    const rawCand = fold(cand.title), rawWant = fold(want.title);
    const variantTags = VARIANT_RES.filter(([, re]) => re.test(rawCand) && !re.test(rawWant)).map(([tag]) => tag);
    const variant = variantTags.length ? 0.3 : 0;
    const aFlat = words(want.artist).replace(/ /g, "");
    const chanFlat = words((cand.channel || "").replace(/\s*-\s*topic$/i, "")).replace(/ /g, "");
    const titleFlat = words(cand.title).replace(/ /g, "");
    const artistHit = aFlat.length >= 2 && (chanFlat.includes(aFlat) || titleFlat.includes(aFlat)) ? 0.2 : 0;
    const topic = / - Topic$/.test(cand.channel || "") || /^\s*provided to youtube by/i.test(cand.description || "") ? 0.3 : 0;
    let dur = 0;
    if (want.durationSec > 0 && cand.durationSec > 0) {
        const off = Math.abs(cand.durationSec - want.durationSec) / want.durationSec;
        if (off <= 0.05) dur = 0.3;
        else if (off > 0.25) dur = -0.2;
    }
    const score = 0.5 * sim + artistHit + topic + dur - variant;
    return { score, confidence: Math.max(0, Math.min(1, score)), parts: { sim, artistHit, topic, dur, variant: variantTags } };
}
export function rankCandidates(cands, want) {
    return cands
        .map((c, i) => ({ ...c, ...scoreCandidate(c, want), _i: i }))
        .sort((x, y) => y.score - x.score || x._i - y._i);
}
/** Best candidate at or above MIN_CONFIDENCE, else null. */
export function pickBest(cands, want) {
    const r = rankCandidates(cands, want);
    return r.length && r[0].confidence >= MIN_CONFIDENCE ? r[0] : null;
}

// ── errors + capped https fetch ───────────────────────────────────────────────────────────────────────────────────────
class HttpError extends Error {
    constructor(status, body) {
        super(body && body.error ? body.error : "error");
        this.status = status;
        this.body = body;
    }
}
const bad = (error) => new HttpError(400, { error });
const notFound = () => new HttpError(404, { error: "notfound" });

async function readCapped(r, maxBytes) {
    if (!r.body) return "";
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            try { await reader.cancel(); } catch { /* already gone */ }
            throw new Error("body too large");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}
/** https-only GET with an 8 s timeout, a 2 MB body cap and hand-followed redirects (≤ 3, https only). */
async function fetchSafe(url, { accept = "application/json", headers = {}, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BODY } = {}) {
    let u = url;
    for (let hop = 0; hop <= 3; hop++) {
        if (!/^https:\/\//i.test(u)) throw new Error("non-https url");
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const r = await fetch(u, {
                redirect: "manual",
                signal: ctl.signal,
                headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.8", ...headers },
            });
            if (r.status >= 300 && r.status < 400) {
                const loc = r.headers.get("location");
                try { await r.body?.cancel(); } catch { /* ignore */ }
                if (!loc) throw new Error(`redirect ${r.status} without location`);
                u = new URL(loc, u).href;
                continue;
            }
            const len = Number(r.headers.get("content-length") || 0);
            if (len > maxBytes) { try { await r.body?.cancel(); } catch { /* ignore */ } throw new Error("body too large"); }
            const text = await readCapped(r, maxBytes);
            return { status: r.status, ok: r.ok, text };
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error("too many redirects");
}

// ── who spends the units (security review 2026-10-26) ─────────────────────────────────────────────────────────────────
/**
 * Units per Pacific day: per person (`user`), per token-less caller (`anon`, keyed by address) and for every token-less
 * caller together (`anonAll`). charge(who, units) -> null when allowed (and counted), else "user" | "anon" (the budget
 * that is spent). who = {user} | {legacy: true, key} | {} (no guard installed: not limited here). Kept in memory: a
 * restart forgets the day's counts; the global quota (the store) still holds.
 */
export function createUnitBudget({ userPerDay = Infinity, anonPerDay = Infinity, anonAllPerDay = Infinity, now = Date.now } = {}) {
    let day = "", anonAll = 0;
    const users = new Map(), anon = new Map();
    const roll = () => { const d = pacificDay(now()); if (d !== day) { day = d; anonAll = 0; users.clear(); anon.clear(); } };
    return {
        charge(who, units) {
            roll();
            if (who && who.user) {
                const u = users.get(who.user) || 0;
                if (u + units > userPerDay) return "user";
                users.set(who.user, u + units);
                return null;
            }
            if (who && who.legacy) {
                const k = String(who.key ?? "-");
                const mine = anon.get(k) || 0;
                if (mine + units > anonPerDay || anonAll + units > anonAllPerDay) return "anon";
                anon.set(k, mine + units);
                anonAll += units;
                if (anon.size > 50_000) anon.clear();   // a flood of addresses can't grow it without end
            }
            return null;
        },
        used(who) { roll(); return who && who.user ? users.get(who.user) || 0 : who && who.key !== undefined ? anon.get(String(who.key)) || 0 : anonAll; },
    };
}

// ── stores ────────────────────────────────────────────────────────────────────────────────────────────────────────────
class SqliteStore {
    constructor(DatabaseSync, path) {
        this.kind = "sqlite";
        this.path = path;
        const db = (this.db = new DatabaseSync(path));
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER);
            CREATE TABLE IF NOT EXISTS quota (day TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS calls (ts INTEGER NOT NULL, day TEXT NOT NULL, route TEXT NOT NULL, endpoint TEXT NOT NULL, units INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS calls_day ON calls(day);`);
        this.q = {
            get: db.prepare("SELECT value, expires FROM cache WHERE key = ?"),
            set: db.prepare("INSERT OR REPLACE INTO cache(key, value, created, expires) VALUES (?, ?, ?, ?)"),
            units: db.prepare("SELECT units FROM quota WHERE day = ?"),
            add: db.prepare("INSERT INTO quota(day, units) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units"),
            call: db.prepare("INSERT INTO calls(ts, day, route, endpoint, units) VALUES (?, ?, ?, ?, ?)"),
            sweepCache: db.prepare("DELETE FROM cache WHERE expires IS NOT NULL AND expires < ?"),
            sweepCalls: db.prepare("DELETE FROM calls WHERE ts < ?"),
            sweepQuota: db.prepare("DELETE FROM quota WHERE day < ?"),
        };
    }
    get(key) {
        const r = this.q.get.get(key);
        if (!r || (r.expires != null && Number(r.expires) < Date.now())) return undefined;
        try { return JSON.parse(r.value); } catch { return undefined; }
    }
    set(key, value, ttl) {
        this.q.set.run(key, JSON.stringify(value), Date.now(), ttl == null ? null : Date.now() + ttl);
    }
    unitsToday(day) {
        const r = this.q.units.get(day);
        return r ? Number(r.units) : 0;
    }
    addUnits(day, units, route, endpoint) {
        this.q.add.run(day, units);
        this.q.call.run(Date.now(), day, route, endpoint, units);
    }
    sweep() {
        this.q.sweepCache.run(Date.now());
        this.q.sweepCalls.run(Date.now() - 30 * D);
        this.q.sweepQuota.run(pacificDay(Date.now() - 400 * D));
    }
}
class JsonStore {
    constructor(path, log) {
        this.kind = "json";
        this.path = path;
        this.log = log;
        this.data = { cache: {}, quota: {}, calls: [] };
        try { Object.assign(this.data, JSON.parse(readFileSync(path, "utf8"))); } catch { /* fresh */ }
        this.timer = null;
    }
    save() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            try {
                writeFileSync(this.path + ".tmp", JSON.stringify(this.data));
                renameSync(this.path + ".tmp", this.path);
            } catch (e) { this.log(`json store save failed: ${e.message}`); }
        }, 2000);
        this.timer.unref?.();
    }
    get(key) {
        const e = this.data.cache[key];
        if (!e) return undefined;
        if (e.x != null && e.x < Date.now()) { delete this.data.cache[key]; return undefined; }
        return e.v;
    }
    set(key, value, ttl) {
        this.data.cache[key] = { v: value, c: Date.now(), x: ttl == null ? null : Date.now() + ttl };
        this.save();
    }
    unitsToday(day) { return this.data.quota[day] || 0; }
    addUnits(day, units, route, endpoint) {
        this.data.quota[day] = (this.data.quota[day] || 0) + units;
        this.data.calls.push([Date.now(), day, route, endpoint, units]);
        if (this.data.calls.length > 5000) this.data.calls.splice(0, this.data.calls.length - 5000);
        this.save();
    }
    sweep() {
        const now = Date.now();
        for (const [k, e] of Object.entries(this.data.cache)) if (e.x != null && e.x < now) delete this.data.cache[k];
        this.data.calls = this.data.calls.filter((c) => c[0] > now - 30 * D);
        this.save();
    }
}
async function openStore(dataDir, log) {
    try { mkdirSync(dataDir, { recursive: true, mode: 0o750 }); } catch { /* exists */ }
    try {
        const { DatabaseSync } = await import("node:sqlite");
        const s = new SqliteStore(DatabaseSync, join(dataDir, "watch.db"));
        log(`store: sqlite ${s.path}`);
        return s;
    } catch (e) {
        log(`node:sqlite unavailable (${e.message}) -> JSON store`);
        return new JsonStore(join(dataDir, "watch.json"), log);
    }
}

// ── item builders ─────────────────────────────────────────────────────────────────────────────────────────────────────
const pickThumb = (th, order = ["medium", "default", "high"]) => {
    for (const k of order) if (th && th[k] && th[k].url) return th[k].url;
    return "";
};
const itemUrl = (kind, id) =>
    kind === "video" ? `https://www.youtube.com/watch?v=${id}`
        : kind === "playlist" ? `https://www.youtube.com/playlist?list=${id}`
            : `https://www.youtube.com/channel/${id}`;
function baseItem(kind, id, sn = {}) {
    const it = {
        kind, id, url: itemUrl(kind, id),
        title: decodeEntities(sn.title),
        thumb: pickThumb(sn.thumbnails),            // medium||default = what the old /youtube/search handed out
        channel: decodeEntities(sn.channelTitle || ""),
        channelId: sn.channelId || "",
    };
    if (sn.publishedAt) it.publishedAt = sn.publishedAt;
    return it;
}
function videoItem(v) {   // from a videos.list resource
    const it = baseItem("video", v.id, v.snippet || {});
    it.durationSec = iso8601ToSec(v.contentDetails && v.contentDetails.duration);
    if (v.statistics && v.statistics.viewCount != null) it.views = Number(v.statistics.viewCount);
    return it;
}
const toOld = (it) => ({ videoId: it.id, title: it.title, thumb: it.thumb, channel: it.channel, durationSec: it.durationSec || 0 });

// ── routes ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Mount every /youtube/* route. deps: { youtubeKey, dataDir }.
 */
export function installWatch(app, deps = {}) {
    const key = deps.youtubeKey || "";
    const dataDir = deps.dataDir || "/var/lib/tinhat/api/watch";
    const log = (...a) => console.log("[watch]", ...a);
    const scrub = (s) => (key ? String(s ?? "").split(key).join("<key>") : String(s ?? ""));
    const storeReady = openStore(dataDir, log);
    setInterval(() => storeReady.then((s) => s.sweep()).catch(() => {}), H).unref?.();

    const requireKey = () => { if (!key) throw new HttpError(503, { error: "YouTube search not configured" }); };
    const guard = typeof deps.guard === "function" ? deps.guard : null;
    const unitBudget = createUnitBudget({ userPerDay: deps.userUnitsPerDay ?? Infinity, anonPerDay: deps.anonUnitsPerDay ?? Infinity,
        anonAllPerDay: deps.anonAllUnitsPerDay ?? Infinity });
    const budget503 = () => new HttpError(503, { error: "budget", resetAt: pacificResetAt() });
    const checkBudget = (store, cutoff) => { if (store.unitsToday(pacificDay()) > cutoff) throw budget503(); };

    /** One Data API call: counts units (before the call — Google bills what reaches it), honours the per-leg call cap. */
    async function yt(ctx, store, endpoint, params, cost) {
        if (ctx.calls >= MAX_CALLS) throw new Error("upstream call cap reached");
        const spent = unitBudget.charge(ctx.who, cost);
        if (spent === "user") throw new HttpError(503, { error: "budget", resetAt: pacificResetAt(), scope: "you" });
        if (spent === "anon") throw new HttpError(401, { error: "Sign in to use this. If you are signed in, update Tin Hat.", signin: true });
        const units = cost;
        ctx.calls++;
        ctx.units += units;
        store.addUnits(pacificDay(), units, ctx.route, endpoint);
        const qs = new URLSearchParams({ ...params, key });
        let r;
        try { r = await fetchSafe(`https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`); }
        catch (e) { throw new HttpError(502, { error: `youtube ${endpoint}: ${scrub(e.message)}` }); }
        let j = null;
        try { j = JSON.parse(r.text); } catch { /* not json */ }
        if (!r.ok) {
            const reason = (j && j.error && ((j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || j.error.status)) || "";
            if (r.status === 403 && /quota|dailyLimit|rateLimit/i.test(reason)) throw budget503();
            if (r.status === 404 || /notFound/i.test(reason)) throw notFound();
            throw new HttpError(r.status === 400 ? 400 : 502, { error: `youtube ${r.status}${reason ? " " + reason : ""}` });
        }
        return j || {};
    }
    /** Second call: durations/views (videos), itemCount (playlists/channels) — only while a call slot remains. */
    async function enrich(ctx, store, kind, items) {
        try { return await enrichNow(ctx, store, kind, items); } catch (e) {
            // a budget (the caller's own, or the shared token-less one) ran out between the search and this optional
            // second call: answer without durations rather than lose the search that was already paid for
            if (e instanceof HttpError && (e.status === 401 || (e.body && e.body.scope === "you"))) return false;
            throw e;
        }
    }
    async function enrichNow(ctx, store, kind, items) {
        if (!items.length || ctx.calls >= MAX_CALLS) return false;
        const id = items.map((i) => i.id).join(",");
        if (kind === "video") {
            const j = await yt(ctx, store, "videos", { part: "contentDetails,statistics", id, maxResults: "50" }, 1);
            const by = new Map((j.items || []).map((v) => [v.id, v]));
            for (const it of items) {
                const v = by.get(it.id);
                if (!v) continue;
                it.durationSec = iso8601ToSec(v.contentDetails && v.contentDetails.duration);
                if (v.statistics && v.statistics.viewCount != null) it.views = Number(v.statistics.viewCount);
            }
        } else if (kind === "playlist") {
            const j = await yt(ctx, store, "playlists", { part: "contentDetails", id, maxResults: "50" }, 1);
            const by = new Map((j.items || []).map((p) => [p.id, p]));
            for (const it of items) { const p = by.get(it.id); if (p && p.contentDetails) it.itemCount = Number(p.contentDetails.itemCount || 0); }
        } else if (kind === "channel") {
            const j = await yt(ctx, store, "channels", { part: "statistics", id, maxResults: "50" }, 1);
            const by = new Map((j.items || []).map((c) => [c.id, c]));
            for (const it of items) { const c = by.get(it.id); if (c && c.statistics) it.itemCount = Number(c.statistics.videoCount || 0); }
        }
        return true;
    }
    async function playlistItemsPage(ctx, store, playlistId, page) {
        const p = { part: "snippet,contentDetails", playlistId, maxResults: "50" };
        if (page) p.pageToken = page;
        const j = await yt(ctx, store, "playlistItems", p, 1);
        const items = (j.items || [])
            .filter((it) => it.contentDetails && it.contentDetails.videoId && it.snippet && it.snippet.videoOwnerChannelId) // private/deleted videos have no owner
            .map((it) => baseItem("video", it.contentDetails.videoId, {
                ...it.snippet,
                channelTitle: it.snippet.videoOwnerChannelTitle,
                channelId: it.snippet.videoOwnerChannelId,
                publishedAt: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
            }));
        await enrich(ctx, store, "video", items);
        return { items, nextPage: j.nextPageToken || null };
    }
    async function playlistHead(ctx, store, id) {
        const hk = `plh:${id}`;
        let head = store.get(hk);
        if (head) return head;
        const j = await yt(ctx, store, "playlists", { part: "snippet,contentDetails", id, maxResults: "1" }, 1);
        const p = (j.items || [])[0];
        if (!p) throw notFound();
        const sn = p.snippet || {};
        head = {
            id, title: sn.title || "", channel: sn.channelTitle || "", channelId: sn.channelId || "",
            thumb: pickThumb(sn.thumbnails), itemCount: Number((p.contentDetails && p.contentDetails.itemCount) || 0),
        };
        store.set(hk, head, TTL.playlist);
        return head;
    }
    /** /youtube/playlist page (shared with meta for playlist links). Cold page 1 = playlists.list + playlistItems.list. */
    async function playlistPage(ctx, store, id, page) {
        const ck = `pl:${id}:${page || ""}`;
        let data = store.get(ck);
        if (data) { ctx.hit = true; return data; }
        ctx.hit = false;
        requireKey();
        const head = await playlistHead(ctx, store, id);
        const { items, nextPage } = await playlistItemsPage(ctx, store, id, page);
        data = { id, title: head.title, channel: head.channel, thumb: head.thumb, itemCount: head.itemCount, items, nextPage };
        store.set(ck, data, TTL.playlist);
        return data;
    }
    async function channelHead(ctx, store, ref) {
        const hk = `chh:${ref.id || (ref.handle ? "h:" + ref.handle.toLowerCase() : "u:" + ref.user.toLowerCase())}`;
        let head = store.get(hk);
        if (head) return head;
        const p = { part: "snippet,contentDetails,statistics", maxResults: "1" };
        if (ref.id) p.id = ref.id;
        else if (ref.handle) p.forHandle = ref.handle;
        else p.forUsername = ref.user;
        const j = await yt(ctx, store, "channels", p, 1);
        const c = (j.items || [])[0];
        if (!c) throw notFound();
        const sn = c.snippet || {};
        head = {
            id: c.id, title: sn.title || "", thumb: pickThumb(sn.thumbnails),
            uploadsPlaylist: (c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads) || "",
            itemCount: Number((c.statistics && c.statistics.videoCount) || 0),
        };
        store.set(hk, head, TTL.channel);
        if (!ref.id) store.set(`chh:${c.id}`, head, TTL.channel);
        return head;
    }
    async function channelPage(ctx, store, ref, page) {
        const ck = `ch:${ref.id || (ref.handle ? "h:" + ref.handle.toLowerCase() : "u:" + ref.user.toLowerCase())}:${page || ""}`;
        let data = store.get(ck);
        if (data) { ctx.hit = true; return data; }
        ctx.hit = false;
        requireKey();
        const head = await channelHead(ctx, store, ref);
        let items = [], nextPage = null;
        if (head.uploadsPlaylist) ({ items, nextPage } = await playlistItemsPage(ctx, store, head.uploadsPlaylist, page));
        data = { id: head.id, title: head.title, thumb: head.thumb, uploadsPlaylist: head.uploadsPlaylist, items, nextPage };
        store.set(ck, data, TTL.channel);
        return data;
    }

    // ── music services (keyless) ──
    async function spotifyEmbed(ctx, kind, id) {   // best effort: the public embed page's __NEXT_DATA__ entity, or null
        ctx.calls++;
        try {
            const r = await fetchSafe(`https://open.spotify.com/embed/${kind}/${id}`, { accept: "text/html" });
            if (!r.ok) return null;
            const m = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(r.text);
            if (!m) return null;
            const d = JSON.parse(m[1]);
            const ent = d && d.props && d.props.pageProps && d.props.pageProps.state && d.props.pageProps.state.data && d.props.pageProps.state.data.entity;
            return ent && typeof ent === "object" ? ent : null;
        } catch (e) {
            log(`spotify embed ${kind}/${id}: ${e.message}`);
            return null;
        }
    }
    async function spotifyOembed(ctx, kind, id) {
        ctx.calls++;
        let r;
        try { r = await fetchSafe(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${kind}/${id}`)}`); }
        catch (e) { throw new HttpError(502, { error: `spotify oembed: ${e.message}` }); }
        if (r.status === 404 || r.status === 400) throw notFound();
        if (!r.ok) throw new HttpError(502, { error: `spotify oembed ${r.status}` });
        try { return JSON.parse(r.text); } catch { throw new HttpError(502, { error: "spotify oembed: bad json" }); }
    }
    const spotifyImage = (ent) => {
        const imgs = ent && ent.visualIdentity && Array.isArray(ent.visualIdentity.image) ? ent.visualIdentity.image : [];
        const pick = imgs.filter((i) => i && i.url && (i.maxWidth || 0) <= 640).sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0] || imgs[0];
        if (pick && pick.url) return pick.url;
        const src = ent && ent.coverArt && Array.isArray(ent.coverArt.sources) ? ent.coverArt.sources[0] : null;
        return (src && src.url) || "";
    };
    async function spotifyMeta(ctx, ref) {
        const kind = ref.kind === "song" ? "track" : ref.kind;
        const url = `https://open.spotify.com/${kind}/${ref.id}`;
        const ent = await spotifyEmbed(ctx, kind, ref.id);
        let title = (ent && (ent.name || ent.title)) || "";
        let artist = ent && Array.isArray(ent.artists) ? ent.artists.map((a) => a && a.name).filter(Boolean).join(", ") : (ent && ent.subtitle) || "";
        let thumb = spotifyImage(ent);
        if (!title || !thumb) {   // embed page unavailable/changed -> oEmbed (title + art)
            const o = await spotifyOembed(ctx, kind, ref.id);
            title = title || o.title || "";
            thumb = thumb || o.thumbnail_url || "";
        }
        if (!title) throw notFound();
        const meta = { kind: ref.kind, service: "spotify", id: ref.id, url, title };
        if (artist) meta.artist = artist;
        if (thumb) meta.thumb = thumb;
        if (ref.kind === "song") {
            if (ent && ent.duration > 0) meta.durationSec = Math.round(ent.duration / 1000);
            if (ent && ent.audioPreview && ent.audioPreview.url) meta.preview = ent.audioPreview.url;
        } else if (ent && Array.isArray(ent.trackList)) {
            meta.tracks = ent.trackList.slice(0, 50).map((t) => {
                const id = (t.uri || "").split(":")[2] || "";
                const x = { title: t.title || "", artist: t.subtitle || "" };
                if (t.duration > 0) x.durationSec = Math.round(t.duration / 1000);
                if (id && SP_ID.test(id)) { x.id = id; x.url = `https://open.spotify.com/track/${id}`; }
                return x;
            });
        }
        return meta;
    }
    const appleArt = (u) => (u || "").replace(/\/\d+x\d+[a-z]*\.(jpg|png|webp)$/i, "/600x600bb.$1");
    async function itunesLookup(ctx, id, cc) {
        ctx.calls++;
        let r;
        try { r = await fetchSafe(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=song&country=${encodeURIComponent(cc)}`); }
        catch (e) { throw new HttpError(502, { error: `itunes lookup: ${e.message}` }); }
        if (!r.ok) throw new HttpError(502, { error: `itunes lookup ${r.status}` });
        let j;
        try { j = JSON.parse(r.text); } catch { throw new HttpError(502, { error: "itunes lookup: bad json" }); }
        return Array.isArray(j.results) ? j.results : [];
    }
    const appleTrack = (t) => {
        const x = { title: t.trackName || "", artist: t.artistName || "" };
        if (t.trackTimeMillis > 0) x.durationSec = Math.round(t.trackTimeMillis / 1000);
        if (t.trackId != null) x.id = String(t.trackId);
        if (t.trackViewUrl) x.url = t.trackViewUrl;
        return x;
    };
    async function appleMeta(ctx, ref, original) {
        if (ref.kind === "song") {
            const res = await itunesLookup(ctx, ref.id, ref.cc);
            const t = res.find((r) => r.wrapperType === "track" && String(r.trackId) === ref.id) || res.find((r) => r.wrapperType === "track");
            if (!t) throw notFound();
            const meta = { kind: "song", service: "apple", id: String(t.trackId), url: t.trackViewUrl || original, title: t.trackName || "" };
            if (t.artistName) meta.artist = t.artistName;
            if (t.collectionName) meta.album = t.collectionName;
            if (t.artworkUrl100) meta.thumb = appleArt(t.artworkUrl100);
            if (t.trackTimeMillis > 0) meta.durationSec = Math.round(t.trackTimeMillis / 1000);
            if (t.previewUrl) meta.preview = t.previewUrl;
            return meta;
        }
        if (ref.kind === "album") {
            const res = await itunesLookup(ctx, ref.id, ref.cc);
            const col = res.find((r) => r.wrapperType === "collection");
            const tracks = res.filter((r) => r.wrapperType === "track");
            if (!col && !tracks.length) throw notFound();
            const meta = { kind: "album", service: "apple", id: ref.id, url: (col && col.collectionViewUrl) || original, title: (col && col.collectionName) || (tracks[0] && tracks[0].collectionName) || "" };
            const artist = (col && col.artistName) || (tracks[0] && tracks[0].artistName);
            if (artist) meta.artist = artist;
            const art = (col && col.artworkUrl100) || (tracks[0] && tracks[0].artworkUrl100);
            if (art) meta.thumb = appleArt(art);
            meta.tracks = tracks.slice(0, 50).map(appleTrack);
            return meta;
        }
        // playlist: no lookup API without a developer token -> the public page's JSON-LD (best effort)
        ctx.calls++;
        const pageUrl = `https://music.apple.com/${ref.cc}/playlist/${ref.slug ? encodeURIComponent(ref.slug) + "/" : ""}${ref.id}`;
        let r;
        try { r = await fetchSafe(pageUrl, { accept: "text/html" }); }
        catch (e) { throw new HttpError(502, { error: `apple page: ${e.message}` }); }
        if (r.status === 404) throw notFound();
        if (!r.ok) throw new HttpError(502, { error: `apple page ${r.status}` });
        const meta = { kind: "playlist", service: "apple", id: ref.id, url: pageUrl, title: "" };
        let ld = null;
        for (const m of r.text.matchAll(/<script[^>]*type="?application\/ld\+json"?[^>]*>([\s\S]*?)<\/script>/g)) {
            try { const d = JSON.parse(m[1]); if (d && /playlist/i.test(d["@type"] || "")) { ld = d; break; } } catch { /* next */ }
        }
        if (ld) {
            meta.title = ld.name || "";
            if (ld.author && ld.author.name) meta.artist = ld.author.name;
            const tr = Array.isArray(ld.track) ? ld.track : [];
            meta.tracks = tr.slice(0, 50).map((t) => {
                const x = { title: t.name || "", artist: (t.byArtist && t.byArtist.name) || "" };
                const dur = iso8601ToSec(t.duration);
                if (dur) x.durationSec = dur;
                if (t.url) { x.url = t.url; const id = t.url.split("/").pop(); if (id && AP_NUM.test(id)) x.id = id; }
                return x;
            });
            const firstArt = tr[0] && tr[0].audio && tr[0].audio.thumbnailUrl;
            if (typeof ld.image === "string") meta.thumb = ld.image; else if (firstArt) meta.thumb = firstArt;
        }
        if (!meta.title) {
            const og = /<meta property="og:title" content="([^"]*)"/.exec(r.text);
            if (og) meta.title = decodeEntities(og[1]).replace(/\s+on Apple Music$/i, "");
        }
        if (!meta.thumb) {
            const ogi = /<meta property="og:image" content="([^"]*)"/.exec(r.text);
            if (ogi) meta.thumb = decodeEntities(ogi[1]);
        }
        if (!meta.title) throw notFound();
        return meta;
    }
    async function youtubeMeta(ctx, store, ref) {
        requireKey();
        if (ref.kind === "video") {
            const j = await yt(ctx, store, "videos", { part: "snippet,contentDetails", id: ref.id, maxResults: "1" }, 1);
            const v = (j.items || [])[0];
            if (!v) throw notFound();
            const sn = v.snippet || {};
            const meta = {
                kind: ref.service === "ytmusic" ? "song" : "video", service: ref.service, id: ref.id,
                url: itemUrl("video", ref.id),        // the URL that PLAYS on every client (music.youtube.com is only the badge)
                title: sn.title || "",
            };
            const ch = (sn.channelTitle || "").replace(/\s-\sTopic$/, "");
            if (ch) meta.artist = ch;
            const th = pickThumb(sn.thumbnails, ["high", "medium", "default"]);
            if (th) meta.thumb = th;
            const dur = iso8601ToSec(v.contentDetails && v.contentDetails.duration);
            if (dur) meta.durationSec = dur;
            return meta;
        }
        if (ref.kind === "playlist") {
            const p = await playlistPage(ctx, store, ref.id, "");
            const meta = { kind: "playlist", service: ref.service, id: ref.id, url: itemUrl("playlist", ref.id), title: p.title };
            if (p.channel) meta.artist = p.channel;
            if (p.thumb) meta.thumb = p.thumb;
            meta.tracks = p.items.slice(0, 50).map((it) => {
                const x = { title: it.title, artist: it.channel, id: it.id, url: it.url };
                if (it.durationSec) x.durationSec = it.durationSec;
                return x;
            });
            return meta;
        }
        // channel
        const head = await channelHead(ctx, store, ref);
        const meta = { kind: "channel", service: ref.service, id: head.id, url: itemUrl("channel", head.id), title: head.title };
        if (head.thumb) meta.thumb = head.thumb;
        return meta;
    }
    const metaKey = (ref) => `m:${ref.service}:${ref.kind}:${ref.id || (ref.handle ? "h:" + ref.handle.toLowerCase() : "u:" + (ref.user || "").toLowerCase())}`;
    /** Meta for a parsed link; cached forever (playlists 24 h, 404s 1 h). */
    async function metaFor(ctx, store, ref, original) {
        if (ref.kind === "unknown") return { kind: "unknown", service: ref.service, id: "", url: original, title: "" };
        const ck = metaKey(ref);
        const c = store.get(ck);
        if (c) {
            ctx.hit = true;
            if (c.notfound) throw notFound();
            return c;
        }
        ctx.hit = false;
        let meta;
        try {
            if (ref.service === "spotify") meta = await spotifyMeta(ctx, ref);
            else if (ref.service === "apple") meta = await appleMeta(ctx, ref, original);
            else meta = await youtubeMeta(ctx, store, ref);
        } catch (e) {
            if (e instanceof HttpError && e.status === 404) store.set(ck, { notfound: true }, TTL.notfound);
            throw e;
        }
        store.set(ck, meta, ref.kind === "playlist" ? TTL.metaPlaylist : TTL.meta);
        return meta;
    }

    // ── express wiring ──
    const route = (name, fn) =>
        app.get(`/youtube/${name}`, ...(guard ? [guard] : []), async (req, res) => {
            const t0 = Date.now();
            const ctx = { route: name, calls: 0, units: 0, hit: null,
                who: req.matrixUser ? { user: req.matrixUser } : req.legacy ? { legacy: true, key: clientKey(req) } : {} };
            try {
                const store = await storeReady;
                const body = await fn(req, store, ctx);
                if (res.headersSent) return;
                res.setHeader("X-Cache", ctx.hit === null ? "NONE" : ctx.hit ? "HIT" : "MISS");
                res.setHeader("X-Units", String(ctx.units));
                res.json(body);
                if (ctx.hit === false || ctx.units) log(`${name} miss units=${ctx.units} calls=${ctx.calls} ${Date.now() - t0}ms`);
            } catch (e) {
                if (res.headersSent) return;
                res.setHeader("X-Units", String(ctx.units));
                if (e instanceof HttpError) {
                    if (e.status >= 500 || ctx.units) log(`${name} ${e.status} ${scrub(e.body && e.body.error)} units=${ctx.units} calls=${ctx.calls}`);
                    return res.status(e.status).json(e.body);
                }
                console.error(`[watch] ${name} failed: ${scrub(e && e.message)}`);
                res.status(500).json({ error: scrub(e && e.message) || "failed" });
            }
        });
    const optToken = (x) => {
        const t = str(x);
        if (!t) return "";
        if (!TOKEN_RE.test(t)) throw bad("bad page token");
        return t;
    };
    const optUrl = (x) => {
        const u = str(x);
        if (!u) throw bad("Missing url");
        if (u.length > 2048) throw bad("url too long");
        return u;
    };

    route("search", async (req, store, ctx) => {
        const v2 = str(req.query.v) === "2";
        const q = str(req.query.q);
        if (!q) throw new HttpError(400, { error: "Missing q parameter" });   // the old handler's exact reply
        if (q.length > 200) throw bad("q too long");
        const type = str(req.query.type) || "video";
        if (!TYPES.includes(type)) throw bad("bad type");
        const page = optToken(req.query.page);
        const max = clampInt(req.query.max, 1, 25, v2 ? 25 : 15);   // old handler: 15 results
        const ck = `s:${type}:${page}:${q.trim().toLowerCase().replace(/\s+/g, " ")}`;
        let data = store.get(ck);
        ctx.hit = !!data;
        if (!data) {
            requireKey();
            checkBudget(store, SEARCH_CUTOFF);
            const p = { part: "snippet", maxResults: "25", q: q.trim(), type: type === "music" ? "video" : type };
            if (type === "music") { p.videoCategoryId = "10"; p.videoEmbeddable = "true"; }
            if (page) p.pageToken = page;
            const sj = await yt(ctx, store, "search", p, SEARCH_COST);
            const kind = type === "playlist" ? "playlist" : type === "channel" ? "channel" : "video";
            const idKey = kind + "Id";
            const items = (sj.items || []).filter((it) => it.id && it.id[idKey]).map((it) => baseItem(kind, it.id[idKey], it.snippet));
            await enrich(ctx, store, kind, items);
            data = { items, nextPage: sj.nextPageToken || null };
            store.set(ck, data, TTL.search);
        }
        const items = data.items.slice(0, max);
        return v2 ? { items, nextPage: data.nextPage || null, cached: !!ctx.hit } : items.map(toOld);
    });

    route("suggest", async (req, store, ctx) => {
        const q = str(req.query.q).trim();
        if (!q) throw bad("Missing q");
        if (q.length > 100) throw bad("q too long");
        const ck = `sg:${q.toLowerCase().replace(/\s+/g, " ")}`;
        let data = store.get(ck);
        ctx.hit = !!data;
        if (!data) {
            ctx.calls++;
            data = [];
            try {
                const r = await fetchSafe(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(q)}`, { accept: "*/*" });
                const j = r.ok ? JSON.parse(r.text) : null;
                if (Array.isArray(j) && Array.isArray(j[1])) {
                    data = j[1].filter((s) => typeof s === "string" && s).slice(0, 10);
                    store.set(ck, data, TTL.suggest);
                } else log(`suggest: upstream ${r.status}`);
            } catch (e) {
                log(`suggest failed: ${e.message}`);   // suggestions are optional: answer [] rather than an error
            }
        }
        return data;
    });

    route("trending", async (req, store, ctx) => {
        const cat = str(req.query.cat) || "0";
        if (!/^\d{1,2}$/.test(cat)) throw bad("bad cat");
        const region = (str(req.query.region) || "US").toUpperCase();
        if (!/^[A-Z]{2}$/.test(region)) throw bad("bad region");
        const ck = `tr:${region}:${Number(cat)}`;
        let data = store.get(ck);
        ctx.hit = !!data;
        if (!data) {
            requireKey();
            const p = { part: "snippet,contentDetails,statistics", chart: "mostPopular", regionCode: region, maxResults: "30" };
            if (Number(cat) !== 0) p.videoCategoryId = String(Number(cat));
            const j = await yt(ctx, store, "videos", p, 1);
            data = { items: (j.items || []).filter((v) => v.id).map(videoItem) };
            store.set(ck, data, TTL.trending);
        }
        return data;
    });

    route("playlist", async (req, store, ctx) => {
        const id = str(req.query.id);
        if (!id) throw bad("Missing id");
        if (!ID_RE.test(id)) throw bad("bad id");
        return playlistPage(ctx, store, id, optToken(req.query.page));
    });

    route("channel", async (req, store, ctx) => {
        const id = str(req.query.id);
        let handle = str(req.query.handle);
        let ref;
        if (id) {
            if (!ID_RE.test(id)) throw bad("bad id");
            ref = { id };
        } else if (handle) {
            if (!handle.startsWith("@")) handle = "@" + handle;
            if (!YT_HANDLE.test(handle)) throw bad("bad handle");
            ref = { handle };
        } else throw bad("Missing id or handle");
        return channelPage(ctx, store, ref, optToken(req.query.page));
    });

    route("meta", async (req, store, ctx) => {
        const url = optUrl(req.query.url);
        const ref = parseMediaUrl(url);
        if (!ref) throw new HttpError(400, { error: "unsupported" });
        return metaFor(ctx, store, ref, url);
    });

    route("resolve", async (req, store, ctx) => {
        const url = str(req.query.url);
        let want;
        if (url) {
            const ref = parseMediaUrl(optUrl(url));
            if (!ref) throw new HttpError(400, { error: "unsupported" });
            if (ref.kind === "video") {   // already a YouTube video: nothing to resolve, hand back the video itself
                const m = await metaFor(ctx, store, ref, url);
                return { videoId: m.id, url: m.url, title: m.title, channel: m.artist || "", thumb: m.thumb || "", durationSec: m.durationSec || 0, confidence: 1 };
            }
            if (ref.kind !== "song") throw new HttpError(400, { error: "not a song" });
            const m = await metaFor(ctx, store, ref, url);   // cached forever; cold = ≤ 2 keyless music-service calls
            want = { artist: m.artist || "", title: m.title || "", durationSec: m.durationSec || 0 };
            if (!want.title) throw new HttpError(404, { error: "nomatch" });
        } else {
            const artist = str(req.query.artist).trim(), title = str(req.query.title).trim();
            if (!title) throw bad("Missing url or artist+title");
            if (artist.length > 200 || title.length > 200) throw bad("artist/title too long");
            want = { artist, title, durationSec: clampInt(req.query.durationSec, 0, 86400, 0) };
        }
        const rk = `r:${words(want.artist)}|${words(want.title)}`;   // one resolution per song, shared by its Spotify + Apple links
        const c = store.get(rk);
        if (c) {
            ctx.hit = true;
            if (c.nomatch) throw new HttpError(404, { error: "nomatch" });
            return c;
        }
        ctx.hit = false;
        requireKey();
        checkBudget(store, RESOLVE_CUTOFF);
        const leg = { route: "resolve", calls: 0, units: 0, who: ctx.who };   // the Data API leg: search.list + videos.list (its own 2-call cap)
        try {
            const sj = await yt(leg, store, "search", {
                part: "snippet", type: "video", videoCategoryId: "10", videoEmbeddable: "true", maxResults: "10",
                q: `${want.artist} ${want.title}`.trim(),
            }, SEARCH_COST);
            const cands = (sj.items || []).filter((it) => it.id && it.id.videoId)
                .map((it) => ({ ...baseItem("video", it.id.videoId, it.snippet), description: (it.snippet && it.snippet.description) || "" }));
            await enrich(leg, store, "video", cands);
            const best = pickBest(cands, want);
            if (!best) {
                store.set(rk, { nomatch: true }, TTL.nomatch);
                throw new HttpError(404, { error: "nomatch" });
            }
            const out = {
                videoId: best.id, url: best.url, title: best.title, channel: best.channel, thumb: best.thumb,
                durationSec: best.durationSec || 0, confidence: Math.round(best.confidence * 100) / 100,
            };
            store.set(rk, out, null);
            return out;
        } finally {
            ctx.units += leg.units;
            ctx.calls += leg.calls;
        }
    });

    route("budget", async (_req, store) => {
        const unitsToday = store.unitsToday(pacificDay());
        return {
            unitsToday, limit: LIMIT,
            searchesLeft: Math.max(0, Math.floor((SEARCH_CUTOFF - unitsToday) / (SEARCH_COST + 1))),
            resetAt: pacificResetAt(),
        };
    });

    log(`routes mounted: search suggest trending playlist channel meta resolve budget (key ${key ? "present" : "MISSING"}, data ${dataDir})`);
}
