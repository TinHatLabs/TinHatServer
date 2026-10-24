// Tin Hat games catalogue — "What do we play tonight" (Game Reel) backend.
//
// Global game catalog with cover art for the reel + My-games editor in both Tin Hat
// apps. Same shape as the GIF picker: secrets stay here, clients call OUR endpoints,
// art is cached on disk and served from our domain. ONE dependency (express), a JSON
// file store (the catalog is hundreds of rows, not millions) and an art directory.
//
// Endpoints (the web server maps /api/games/* here):
//   GET  /search?q=          autocomplete: catalog first, then the keyless Steam store search
//   GET  /game/<id>          full entry (lazily resolves Steam details, rate-limit aware)
//   GET  /art/<id>/<kind>    portrait|header|hero|logo — cached; portrait -> header -> placeholder
//   GET  /seed               the house catalog (non-Steam + pinned entries) with art state
//   POST /custom {name}      Matrix-authed: a custom:<slug> entry with placeholder art
//   POST /steam/library      Matrix-authed: {profile} -> owned games (needs steam.key; stores nothing)
//   GET  /health
//
// Ids: steam:<appid> | sgdb:<id> | custom:<slug>.  Names/art are resolved from here, never
// stored in Matrix events.
//
// Keys (optional, files next to this script, not in git):
//   steam.key        Steam Web API key — ONLY for /steam/library (owned-games import).
//   steamgriddb.key  SteamGridDB key — portraits for non-Steam games (LoL, Blizzard…).
//   Without steamgriddb.key the seeded non-Steam games exist with placeholder art and the
//   art fills in on the next seed pass after the key appears. Manual override: drop a
//   600x900 JPEG/PNG at art-manual/<slug>.jpg — it wins over every source.

import express from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3003);
const DATA_DIR = process.env.GAMES_DATA_DIR || join(ROOT, "data");
const CONF_DIR = process.env.API_CONF_DIR || ROOT; // where the keys live (steam.key, steamgriddb.key)
const ART_DIR = join(DATA_DIR, "art");
const MANUAL_ART_DIR = process.env.GAMES_MANUAL_ART || join(ROOT, "art-manual");
const DB_FILE = join(DATA_DIR, "catalog.json");
const HS_INTERNAL = process.env.SYNAPSE_INTERNAL || ""; // Synapse (whoami for the Matrix-authed routes); unset = those routes refuse
const WEEK = 7 * 24 * 3600 * 1000;

for (const d of [DATA_DIR, ART_DIR, MANUAL_ART_DIR]) mkdirSync(d, { recursive: true });

function readKey(name) {
    try { return readFileSync(join(CONF_DIR, name), "utf8").trim(); } catch { return ""; }
}
const STEAM_KEY = process.env.STEAM_API_KEY || readKey("steam.key");
const SGDB_KEY = process.env.STEAMGRIDDB_API_KEY || readKey("steamgriddb.key");

// ── store ─────────────────────────────────────────────────────────────────────
// { games: { id: entry }, aliases: { lowercased name: id } }
// entry = { id, name, source, appid?, sgdbId?, year?, flags: {multiplayer,coop,onlinePvp,onlineCoop,crossplay}|null,
//           art: { portrait, header, hero, logo } (source urls or null), artState, detailsAt, seeded, aliases[] }
// Null-prototype maps: ids and names arrive straight from a URL or a Matrix event, so a key like
// "__proto__" or "constructor" must be an ordinary miss rather than a walk into Object.prototype.
// (GET /art/__proto__/portrait used to take the whole service down, unauthenticated.)
let db = { games: Object.create(null), aliases: Object.create(null) };
try {
    const parsed = JSON.parse(readFileSync(DB_FILE, "utf8"));
    db.games = Object.assign(Object.create(null), parsed.games || {});
    db.aliases = Object.assign(Object.create(null), parsed.aliases || {});
} catch {}
const own = (map, key) => (typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);
let saveTimer = null;
function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const tmp = `${DB_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(db));
    renameSync(tmp, DB_FILE);
}
function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 500);
}
// A custom game's id is written into a Matrix event by the client the moment we answer it, so the
// row has to survive a restart from that instant — not 500 ms later.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { flush(); } catch {} process.exit(0); });
process.on("unhandledRejection", (e) => console.error(`[games] unhandled rejection: ${e && e.message ? e.message : e}`));
const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "game";
const clean = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);

function upsert(entry) {
    const prev = db.games[entry.id] || {};
    const merged = { ...prev, ...entry, art: { ...(prev.art || {}), ...(entry.art || {}) }, aliases: [...new Set([...(prev.aliases || []), ...(entry.aliases || [])])] };
    db.games[entry.id] = merged;
    db.aliases[merged.name.toLowerCase()] = merged.id;
    for (const a of merged.aliases) db.aliases[String(a).toLowerCase()] = merged.id;
    save();
    return merged;
}

// One identity per game: a Steam import of Overwatch 2 must land on the same row as the
// seeded Battle.net entry. The seed carries `steamAppId` where one exists; when a steam:
// entry is created for an appid that a seeded row already claims, the seeded row wins.
function canonical(id) {
    const g = own(db.games, id);
    if (!g) return null;
    if (g.mergedInto) return own(db.games, g.mergedInto) || g;
    return g;
}
function findBySteamAppId(appid) {
    for (const g of Object.values(db.games)) if (g.appid === appid && !g.mergedInto) return g;
    return null;
}

// ── Steam (keyless store endpoints) ───────────────────────────────────────────
const CAT = { 1: "multiplayer", 9: "coop", 36: "onlinePvp", 38: "onlineCoop", 27: "crossplay", 37: "lanPvp", 39: "lanCoop", 24: "sharedScreen" };
function steamArt(appid) {
    const b = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}`;
    return { portrait: `${b}/library_600x900_2x.jpg`, portraitSmall: `${b}/library_600x900.jpg`, header: `${b}/header.jpg`, hero: `${b}/library_hero.jpg`, logo: `${b}/logo.png` };
}
async function steamSearch(term) {
    try {
        const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return [];
        const j = await r.json();
        return (j.items || []).filter((i) => i.type === "app").map((i) => ({ appid: i.id, name: i.name }));
    } catch { return []; }
}

// appdetails is rate-limited per IP (~200 / 5 min). Every game is fetched ONCE and cached;
// a refresh happens no more than weekly. Requests go through one queue with a floor
// between calls so a big import never trips the limit; callers get `flags: null` until
// the details land and simply ask again.
const detailQueue = [];
const queued = new Set();
let detailsBackoffUntil = 0;
function queueDetails(appid, front = false) {
    if (queued.has(appid)) return;
    queued.add(appid);
    front ? detailQueue.unshift(appid) : detailQueue.push(appid);
}
async function detailsLoop() {
    for (;;) {
        if (!detailQueue.length || Date.now() < detailsBackoffUntil) { await new Promise((r) => setTimeout(r, 500)); continue; }
        const appid = detailQueue.shift();
        try {
            const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic,categories,release_date`, { signal: AbortSignal.timeout(10000) });
            if (r.status === 429 || r.status === 403) { detailsBackoffUntil = Date.now() + 5 * 60 * 1000; detailQueue.unshift(appid); console.log(`[games] steam appdetails limited, pausing 5 min`); continue; }
            const j = r.ok ? await r.json() : null;
            const d = j?.[String(appid)]?.success ? j[String(appid)].data : null;
            if (process.env.GAMES_DEBUG) console.log(`[games] details ${appid}: http ${r.status} ok=${!!d} cats=${d?.categories?.length ?? "-"}`);
            const flags = { multiplayer: false, coop: false, onlinePvp: false, onlineCoop: false, crossplay: false, lanPvp: false, lanCoop: false, sharedScreen: false };
            if (d) for (const c of d.categories || []) if (CAT[c.id]) flags[CAT[c.id]] = true;
            const year = d?.release_date?.date ? (String(d.release_date.date).match(/\d{4}/) || [null])[0] : null;
            const id = `steam:${appid}`;
            const row = findBySteamAppId(appid);
            const target = row && row.id !== id ? row.id : id;
            const cur = own(db.games, target) || {};
            if (!d) {
                // Transient failure: keep what we already knew (seeded flags included) and retry,
                // rather than publishing null flags and blocking the weekly refresh for 7 days.
                if ((cur.detailFails || 0) < 3) setTimeout(() => queueDetails(appid), 5 * 60 * 1000);
                upsert({ id: target, detailFails: (cur.detailFails || 0) + 1 });
            } else {
                upsert({ id: target, name: cur.name || d.name || `App ${appid}`, source: cur.source || "steam", appid, year: year ? Number(year) : cur.year || null, flags, type: d.type || null, detailsAt: Date.now(), detailFails: 0, art: cur.artOverride ? {} : steamArt(appid) });
            }
        } catch (e) { console.log(`[games] details ${appid} failed: ${e.message}`); }
        finally { queued.delete(appid); }
        await new Promise((r) => setTimeout(r, 1600)); // ≈ 185 / 5 min, under the limit
    }
}
void detailsLoop();
// the queue is in-memory: after a restart, pick up every Steam row that never got its details
for (const g of Object.values(db.games)) if (g.appid && !g.detailsAt && !g.mergedInto) queueDetails(g.appid);

function ensureSteam(appid, name) {
    const existing = findBySteamAppId(appid);
    if (existing) {
        if (!existing.detailsAt || Date.now() - existing.detailsAt > WEEK) queueDetails(appid);
        return existing;
    }
    const e = upsert({ id: `steam:${appid}`, name: clean(name) || `App ${appid}`, source: "steam", appid, flags: null, art: steamArt(appid), artState: "steam" });
    queueDetails(appid, true);
    return e;
}

// ── SteamGridDB (non-Steam portraits) ─────────────────────────────────────────
async function sgdb(path) {
    if (!SGDB_KEY) return null;
    try {
        const r = await fetch(`https://www.steamgriddb.com/api/v2${path}`, { headers: { Authorization: `Bearer ${SGDB_KEY}` }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return null;
        const j = await r.json();
        return j.success ? j.data : null;
    } catch { return null; }
}
async function resolveSgdbArt(entry) {
    if (!SGDB_KEY || entry.artOverride) return false;
    let gid = entry.sgdbId;
    if (!gid) {
        const hits = await sgdb(`/search/autocomplete/${encodeURIComponent(entry.name)}`);
        gid = hits?.find((h) => h.name.toLowerCase() === entry.name.toLowerCase())?.id || hits?.[0]?.id;
        if (!gid) return false;
    }
    const grids = await sgdb(`/grids/game/${gid}?dimensions=600x900&types=static&nsfw=false&humor=false&sort=score`);
    const heroes = await sgdb(`/heroes/game/${gid}?types=static&nsfw=false&humor=false`);
    const logos = await sgdb(`/logos/game/${gid}?types=static&nsfw=false&humor=false`);
    const g = grids?.[0]?.url;
    if (!g) return false;
    upsert({ id: entry.id, sgdbId: gid, art: { portrait: g, header: g, hero: heroes?.[0]?.url || null, logo: logos?.[0]?.url || null }, artState: "sgdb" });
    return true;
}

// ── art cache ─────────────────────────────────────────────────────────────────
const KINDS = ["portrait", "header", "hero", "logo"];
function manualArt(entry) {
    // Same sanitiser the cache path applies: an id ultimately comes from a URL or a Matrix event,
    // so it must never be able to walk out of the manual-art directory.
    const slug = entry.id.replace(/^[a-z]+:/, "").replace(/[^a-z0-9._-]/gi, "_");
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
        const p = join(MANUAL_ART_DIR, `${slug}.${ext}`);
        if (existsSync(p)) return p;
    }
    return null;
}
const inflight = new Map();
async function cachedArt(entry, kind) {
    const file = join(ART_DIR, `${entry.id.replace(/[^a-z0-9]/gi, "_")}.${kind}`);
    // Manual art wins over the cache: dropping a better cover into art-manual/ has to take effect
    // even when a downloaded file is already sitting there.
    if (kind === "portrait") { const m = manualArt(entry); if (m) return m; }
    if (existsSync(file)) return file;
    const chain = kind === "portrait" ? [entry.art?.portrait, entry.art?.portraitSmall, entry.art?.header] : [entry.art?.[kind]];
    const key = `${entry.id}|${kind}`;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        for (const url of chain.filter(Boolean)) {
            try {
                const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (!r.ok) continue;
                const buf = Buffer.from(await r.arrayBuffer());
                if (buf.length < 512) continue;
                const tmp = `${file}.part-${process.pid}`;
                writeFileSync(tmp, buf);
                renameSync(tmp, file);
                return file;
            } catch {}
        }
        return null;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
}
function placeholderSvg(name) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const hue = h % 360;
    const words = name.split(/\s+/).slice(0, 4);
    const lines = words.map((w, i) => `<text x="300" y="${420 + i * 78}" text-anchor="middle" font-family="Inter, sans-serif" font-size="64" font-weight="600" fill="#f1f5f6">${esc(w)}</text>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},38%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},45%,10%)"/></linearGradient></defs><rect width="600" height="900" fill="url(#g)"/><circle cx="300" cy="230" r="90" fill="hsl(${hue},50%,60%)" opacity="0.25"/>${lines}</svg>`;
}

// ── seed (house catalog) ──────────────────────────────────────────────────────
async function seed() {
    let list = [];
    try { list = JSON.parse(readFileSync(join(ROOT, "seed.json"), "utf8")); } catch (e) { console.log(`[games] no seed.json: ${e.message}`); return; }
    for (const s of list) {
        const id = s.steamAppId ? `steam:${s.steamAppId}` : `custom:${slugify(s.slug || s.name)}`;
        // One row per game, enforced rather than curated. When a seed entry gains a Steam appid
        // (or someone typed the game before we knew it had one), fold the older row into this one
        // instead of leaving both live: ids already written into people's prefs events keep
        // resolving through canonical(), so nobody's would-play list silently stops matching.
        if (s.steamAppId) {
            const stale = `custom:${slugify(s.slug || s.name)}`;
            const prev = own(db.games, stale);
            if (prev && stale !== id && !prev.mergedInto) {
                db.games[stale] = { ...prev, mergedInto: id, seeded: false };
                for (const [alias, target] of Object.entries(db.aliases)) if (target === stale) db.aliases[alias] = id;
                save();
                console.log(`[games] merged ${stale} -> ${id} (same game, one row)`);
            }
        }
        // a seeded steam: row keeps the SEED name + flags; details only add year/type
        const prev = db.games[id];
        const entry = upsert({ id, name: s.name, source: s.steamAppId ? "steam" : (s.source || "house"), appid: s.steamAppId || undefined, aliases: s.aliases || [], flags: s.flags || prev?.flags || { multiplayer: true }, seeded: true, publisher: s.publisher || null, launcher: s.launcher || null, url: s.url || null, art: s.steamAppId ? steamArt(s.steamAppId) : (prev?.art || {}), artState: prev?.artState || (s.steamAppId ? "steam" : "placeholder") });
        if (s.steamAppId && (!entry.detailsAt || Date.now() - entry.detailsAt > WEEK)) queueDetails(s.steamAppId);
        if (!s.steamAppId && (!entry.art?.portrait) ) {
            if (manualArt(entry)) upsert({ id, artState: "manual", artOverride: true });
            else if (SGDB_KEY) { if (await resolveSgdbArt(entry)) console.log(`[games] art resolved for ${s.name}`); }
        }
    }
    console.log(`[games] seed: ${list.length} entries, sgdb ${SGDB_KEY ? "on" : "OFF (placeholders)"}, steam key ${STEAM_KEY ? "on" : "off"}`);
}
void seed();
setInterval(() => void seed(), 24 * 3600 * 1000);

// ── public shape ──────────────────────────────────────────────────────────────
function pub(e) {
    if (!e) return null;
    const c = canonical(e.id) || e;
    return { id: c.id, name: c.name, source: c.source, appid: c.appid || null, year: c.year || null, flags: c.flags || null, type: c.type || null, playable: c.type ? c.type === "game" : null, seeded: !!c.seeded, launcher: c.launcher || null, url: c.url || (c.appid ? `https://store.steampowered.com/app/${c.appid}/` : null), art: Object.fromEntries(KINDS.map((k) => [k, `/api/games/art/${encodeURIComponent(c.id)}/${k}`])), artState: c.artState || "placeholder" };
}
function isMultiplayer(e) { const f = e.flags; return !!(f && (f.multiplayer || f.coop || f.onlinePvp || f.onlineCoop)); }

// ── auth ──────────────────────────────────────────────────────────────────────
async function matrixWhoami(token) {
    try {
        const r = await fetch(`${HS_INTERNAL}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return null;
        return (await r.json()).user_id || null;
    } catch { return null; }
}
async function requireMatrixUser(req, res, next) {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "bearer token required" });
    const user = await matrixWhoami(token);
    if (!user) return res.status(401).json({ error: "bad token" });
    req.matrixUser = user;
    next();
}

// ── routes ────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, games: Object.keys(db.games).length, queue: detailQueue.length, sgdb: !!SGDB_KEY, steamKey: !!STEAM_KEY }));

app.get("/search", requireMatrixUser, async (req, res) => {
    const q = clean(req.query.q).toLowerCase();
    if (q.length < 2) return res.json({ items: [] });
    const seen = new Set();
    const out = [];
    const push = (e) => { const c = canonical(e.id) || e; if (!c || seen.has(c.id) || c.mergedInto) return; seen.add(c.id); out.push(pub(c)); };
    // catalog first: exact/prefix on name + aliases, then contains
    const rows = Object.values(db.games).filter((g) => !g.mergedInto);
    for (const g of rows) if (g.name.toLowerCase().startsWith(q) || (g.aliases || []).some((a) => String(a).toLowerCase().startsWith(q))) push(g);
    for (const g of rows) if (g.name.toLowerCase().includes(q)) push(g);
    if (out.length < 8 && String(req.query.local || "") !== "1") {
        for (const s of await steamSearch(q)) {
            if (out.length >= 12) break;
            const e = ensureSteam(s.appid, s.name);
            if (e.type && e.type !== "game") continue;   // resolved DLC / soundtrack / demo: never offer it
            push(e);
        }
    }
    res.json({ items: out.slice(0, 12) });
});

app.get("/game/:id", (req, res) => {
    const e = canonical(req.params.id);
    if (!e) return res.status(404).json({ error: "unknown game" });
    if (e.appid && (!e.detailsAt || Date.now() - e.detailsAt > WEEK)) queueDetails(e.appid);
    res.json(pub(e));
});

app.get("/seed", (_req, res) => {
    res.json({ items: Object.values(db.games).filter((g) => g.seeded && !g.mergedInto).map(pub) });
});

app.get("/art/:id/:kind", async (req, res) => {
    const kind = req.params.kind;
    if (!KINDS.includes(kind)) return res.status(404).end();
    const e = canonical(req.params.id);
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (e) {
        const send = (f) => { const b = readFileSync(f); const t = b[0] === 0x89 ? "image/png" : b[0] === 0xff ? "image/jpeg" : (b.slice(0, 4).toString() === "RIFF" ? "image/webp" : "application/octet-stream"); res.setHeader("Content-Type", t); res.send(b); };
        const f = await cachedArt(e, kind);
        if (f) return send(f);
        if (kind !== "portrait") { const p = await cachedArt(e, "portrait"); if (p) return send(p); }
    }
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(placeholderSvg(e?.name || req.params.id.replace(/^[a-z]+:/, "")));
});

app.post("/custom", requireMatrixUser, (req, res) => {
    const name = clean(req.body?.name);
    if (name.length < 2) return res.status(400).json({ error: "Give it a name" });
    const hit = db.aliases[name.toLowerCase()];
    if (hit && db.games[hit]) return res.json(pub(db.games[hit]));
    const e = upsert({ id: `custom:${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`, name, source: "custom", flags: { multiplayer: true }, art: {}, artState: "placeholder", createdBy: req.matrixUser, createdAt: Date.now() });
    console.log(`[games] ${req.matrixUser} added custom game "${name}"`);
    res.status(201).json(pub(e));
});

// Owned-games import. Resolves a profile URL/vanity/steamid64, checks the library is
// public, returns the list — and forgets it. Nothing about the person is written here.
app.post("/steam/library", requireMatrixUser, async (req, res) => {
    if (!STEAM_KEY) return res.status(503).json({ error: "Steam import is not set up on the server yet — add games by name instead." });
    const raw = clean(req.body?.profile);
    if (!raw) return res.status(400).json({ error: "Paste your Steam profile link" });
    const multiplayerOnly = req.body?.multiplayerOnly !== false;
    let sid = null;
    const m64 = raw.match(/(?:profiles\/)?(7656119\d{10})/);
    const mv = raw.match(/id\/([A-Za-z0-9_-]{2,32})/) || (!m64 && /^[A-Za-z0-9_-]{2,32}$/.test(raw) ? [null, raw] : null);
    try {
        if (m64) sid = m64[1];
        else if (mv) {
            const r = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(mv[1])}`, { signal: AbortSignal.timeout(10000) });
            const j = r.ok ? await r.json() : null;
            sid = j?.response?.success === 1 ? j.response.steamid : null;
        }
        if (!sid) return res.status(404).json({ error: "That does not look like a Steam profile" });
        const r = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${sid}&include_appinfo=1&include_played_free_games=1&format=json`, { signal: AbortSignal.timeout(15000) });
        const j = r.ok ? await r.json() : null;
        const games = j?.response?.games;
        if (!games) return res.status(403).json({ error: "Your Steam privacy settings hide your games. Set 'Game details' to Public, import, then set it back — or add games by name.", privacy: true });
        const items = [];
        for (const g of games) {
            const e = ensureSteam(g.appid, g.name);
            const p = pub(e);
            p.playtimeMin = g.playtime_forever || 0;
            if (e.type && e.type !== "game") continue;                     // DLC / soundtracks are not games
            if (multiplayerOnly && e.flags && !isMultiplayer(e)) continue; // unknown flags stay in (client shows "checking")
            items.push(p);
        }
        items.sort((a, b) => b.playtimeMin - a.playtimeMin);
        console.log(`[games] ${req.matrixUser} imported ${games.length} owned games (${items.length} returned, ${detailQueue.length} details queued)`);
        res.json({ items, total: games.length, pending: items.filter((i) => !i.flags).length });
    } catch (e) {
        res.status(502).json({ error: `Steam did not answer: ${e.message}` });
    }
});

app.listen(PORT, "127.0.0.1", () => console.log(`[games] catalog on 127.0.0.1:${PORT}, ${Object.keys(db.games).length} games, data ${DATA_DIR}`));
