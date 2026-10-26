import express from "express";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installModeration } from "./moderation.mjs";
import { installInvites } from "./invites.mjs";
import { createHs, createMatrixAuth, RateLimit, clientIp } from "./reachcommon.mjs";
import { createLimits } from "./limits.mjs";
import { installPresence } from "./presence.mjs";
import { installPush } from "./push.mjs";
import { installGameServers } from "./gameservers.mjs";
import { installWatch } from "./watch.mjs";
import { installGuests } from "./guests.mjs";

const app = express();
const PORT = Number(process.env.PORT || 3001);

// Where this service's keys, state files, caches and uploads live (one root-only folder): API_CONF_DIR, else next to
// this script. Every address it talks to or hands out comes from the environment — nothing is built in (on a Tin Hat
// Server the manager writes all of it: manager/tinhat/apiconf.py; README.md lists the variables).
const CONF = (process.env.API_CONF_DIR || new URL("./", import.meta.url).pathname).replace(/\/+$/, "");
function required(name) {
    const v = (process.env[name] || "").trim();
    if (!v) {
        console.error(`[config] ${name} is not set: every address this service uses comes from its environment (README.md)`);
        process.exit(1);
    }
    return v;
}

// Giphy API key — server-side only; never shipped to the browser bundle.
// Read from $GIPHY_API_KEY or a local giphy.key file (not in git).
let GIPHY_KEY = process.env.GIPHY_API_KEY || "";
if (!GIPHY_KEY) {
    try {
        GIPHY_KEY = readFileSync(join(CONF, "giphy.key"), "utf8").trim();
    } catch {
        /* no key file present */
    }
}

// YouTube Data API v3 key — server-side only; never shipped to the browser bundle.
let YOUTUBE_KEY = process.env.YOUTUBE_API_KEY || "";
if (!YOUTUBE_KEY) {
    try {
        YOUTUBE_KEY = readFileSync(join(CONF, "youtube.key"), "utf8").trim();
    } catch {
        /* no key file present */
    }
}

// LiveKit signing secret — server-side ONLY. This is the credential that lets anyone
// mint a token for any room, so it must never reach a browser. Call moderation
// (moderation.mjs) signs its call-server requests with it.
let LK_KEY = process.env.LK_API_KEY || "lk_key";
let LK_SECRET = process.env.LK_API_SECRET || "";
if (!LK_SECRET) {
    try {
        LK_SECRET = readFileSync(join(CONF, "livekit.secret"), "utf8").trim();
    } catch {
        /* no secret present — call moderation stays disabled */
    }
}

/** Base64url without padding — what JWT wants (call moderation's call-server tokens). */
function b64u(buf) {
    return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const LK_API_URL = required("LK_API_URL"); // the call server's HTTP API (call moderation)

// Rate limiting: the tiers are in limits.mjs (/vods/file + /vods/thumb exempt: every request carries an HMAC sig+exp,
// the player's media plane — the old global 30/min bucket starved it, souphttpsrc "Unknown Error (429)" in field
// logs; THUMB_MAX remains the ffmpeg capacity gate. /vods/sessions 60/min, soundboard clip reads 240/min, the rest
// 30/min), per REAL client IP.
// Behind a proxy, req.ip must be the REAL client (TRUST_PROXY names the proxies): otherwise every request looks like
// the proxy, one bucket for everybody, and one busy client gets everyone 429s (GIFs, soundboard, the invites check).
// TRUST_PROXY: who may set X-Forwarded-For (comma-separated express values; on a Tin Hat Server its own Caddy: loopback).
app.set("trust proxy", (process.env.TRUST_PROXY || "loopback").split(",").map((s) => s.trim()).filter(Boolean));
const limits = createLimits(Date.now);
setInterval(() => limits.sweep(), 600000).unref?.(); // idle addresses go, so the maps can't grow unbounded
function tooMany(res) {
    res.setHeader("Retry-After", "5");
    return res.status(429).json({ error: "Too many requests" });
}
function rateLimit(req, res, next) {
    if (!limits.request(req.path, req.ip)) return tooMany(res);
    next();
}

// Reach (Tin Hat 10.6, 2026-09-25): /presence and /push/* authenticate per user, rate-limit per user/token and read
// their own bodies (1 KB / 4 KB), so they skip the shared per-IP bucket above (behind two proxies every client
// arrives from the same address, so it is one bucket for everybody) and the app-wide 8 KB JSON parser.
// + /gameservers/* (the Game servers widget, 11.1; docs/GAMESERVERS.md in both app repos): the same — per-user limits,
// its own 2 KB body reader, whoami cached per token (reachcommon).
// + the guest room (guests.mjs): its own limits (knocks per address), and the waiting page polls every 2 s.
const REACH_PATH = /^\/(?:presence\/?$|push\/|gameservers\/|guests(?:\/|$)|guest\/(?:door|knock|ticket)$)/;

// ---- this server's own extras (Tin Hat Server) -------------------------------------------------------------------
// Registered before the limiter and the JSON parser: they read their own bodies (the web server caps the sizes).
app.get("/health", (_req, res) => res.json({ ok: true }));
// Upload speed test sink: the app POSTs a few MB and times it; the bytes are counted and dropped.
const SPEED_PER_IP = new RateLimit(6, 60_000);
let speedRunning = 0;
app.post("/speedtest/up", (req, res) => {
    const ip = clientIp(req);
    if (!SPEED_PER_IP.hit(ip) || speedRunning >= 2) { req.resume(); return res.status(429).json({ error: "busy" }); }
    speedRunning++;
    res.on("close", () => { speedRunning--; });
    let n = 0;
    const t0 = Date.now();
    req.on("data", (c) => { n += c.length; });
    req.on("end", () => res.json({ bytes: n, ms: Date.now() - t0 }));
    req.on("error", () => res.status(400).end());
});
// Problem reports and shared logs go to THIS server's owner (the dashboard's Reports card) and nowhere else. Both need
// the sender's own Matrix token; a report is JSON (≤ 1 MB), a log is any bytes (≤ 12 MB), named by the sender.
function readRaw(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let n = 0;
        req.on("data", (c) => {
            n += c.length;
            if (n > max) { reject(new Error("too big")); req.resume(); return; }  // drained, so the 413 gets through
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}
// Quotas (reports and logs accumulate on the server's disk): guests can't send them; each person at most 20 a day;
// all of them together at most 200 MB (the dashboard's Reports card shows them, the owner deletes them there).
const REPORTS_PER_DAY = new RateLimit(20, 24 * 3600_000);
const REPORTS_MAX_BYTES = 200 * 1024 * 1024;
function storedBytes() {
    let n = 0;
    for (const d of ["reports", "logs"]) {
        try { for (const f of readdirSync(join(CONF, d))) { try { n += statSync(join(CONF, d, f)).size; } catch { /* gone */ } } } catch { /* none yet */ }
    }
    return n;
}
function reportAllowed(req, res, incoming) {
    if (/^@guest-/.test(req.matrixUser || "")) { res.status(403).json({ error: "Guests can't send reports." }); return false; }
    if (!REPORTS_PER_DAY.hit(req.matrixUser)) { res.status(429).json({ error: "That's enough reports for today." }); return false; }
    if (storedBytes() + incoming > REPORTS_MAX_BYTES) { res.status(507).json({ error: "The server's report inbox is full; its owner needs to clear it." }); return false; }
    return true;
}
const fileStamp = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
const safeName = (s) => String(s || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
async function storeReport(req, res) {
    if (!reportAllowed(req, res, Number(req.headers["content-length"]) || 0)) { req.resume(); return; }
    let raw;
    try { raw = await readRaw(req, 1024 * 1024); } catch { return res.status(413).json({ error: "report too big (1 MB)" }); }
    let report;
    try { report = JSON.parse(raw.toString("utf8") || "{}"); } catch { return res.status(400).json({ error: "report must be JSON" }); }
    const dir = join(CONF, "reports");
    mkdirSync(dir, { recursive: true });
    const id = fileStamp();
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ at: Date.now(), user: req.matrixUser, report }, null, 1), { mode: 0o600 });
    res.json({ ok: true, id });
}
app.post("/reports", requireMatrixUser, storeReport);
app.post("/reports/api/reports", requireMatrixUser, storeReport); // the path older web apps use
app.post("/logs/upload", requireMatrixUser, async (req, res) => {
    if (!reportAllowed(req, res, Number(req.headers["content-length"]) || 0)) { req.resume(); return; }
    let raw;
    try { raw = await readRaw(req, 12 * 1024 * 1024); } catch { return res.status(413).json({ error: "log too big (12 MB)" }); }
    const dir = join(CONF, "logs");
    mkdirSync(dir, { recursive: true });
    const id = `${fileStamp()}-${safeName(req.matrixUser)}-${safeName(req.query.name)}`;
    writeFileSync(join(dir, id), raw, { mode: 0o600 });
    res.json({ ok: true, id });
});

app.use((req, res, next) => (REACH_PATH.test(req.path) ? next() : rateLimit(req, res, next)));
const jsonBody = express.json({ limit: "8kb" });
app.use((req, res, next) => (REACH_PATH.test(req.path) ? next() : jsonBody(req, res, next)));

// ── guest ACCOUNTS ───────────────────────────────────────────────────────
//
// The guest room (guests.mjs, docs/GUESTS.md) lets a guest in with a TEMPORARY account
// (Synapse shared-secret registration), joined to the Guests room, and hands the session
// to the real web client. Guests are ordinary participants: the same UI as everyone and
// the same call. The reaper deactivates accounts after GUEST_ACCOUNT_TTL_MS.
const HS_INTERNAL = required("SYNAPSE_INTERNAL"); // Synapse, as this process reaches it
const HS_PUBLIC = required("SYNAPSE_PUBLIC"); // Synapse, as a guest's browser reaches it
const WEB_BASE = required("WEB_BASE"); // Tin Hat Web, where a guest is handed over
const GUEST_ACCOUNT_TTL_MS = Number(process.env.GUEST_ACCOUNT_TTL_MS || 12 * 60 * 60 * 1000);
const GUEST_REAP_MS = Number(process.env.GUEST_REAP_MS || 10 * 60 * 1000);
const GUEST_ACCOUNTS_FILE = process.env.GUEST_ACCOUNTS_FILE || join(CONF, "guest-accounts.json");
let SYNAPSE_SECRET = "";
try { SYNAPSE_SECRET = readFileSync(join(CONF, "synapse.secret"), "utf8").trim(); } catch { /* guest accounts disabled */ }
let ADMIN_TOKEN = "";
try { ADMIN_TOKEN = readFileSync(join(CONF, "synapse-admin.token"), "utf8").trim(); } catch { /* guest accounts disabled */ }
if (!SYNAPSE_SECRET || !ADMIN_TOKEN) console.error("[guest] synapse.secret / synapse-admin.token missing -> guest ACCOUNTS disabled");

/** [{user, room, created, name}] — the working set the reaper walks. */
let guestAccounts = [];
try { guestAccounts = JSON.parse(readFileSync(GUEST_ACCOUNTS_FILE, "utf8")); } catch { /* first run */ }
function writeAtomic(path, text, mode = 0o600) {  // a crash mid-write never leaves a truncated file behind
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, path);
}
// What Synapse's tinhat_rules module reads (appliance/rootfs/opt/tinhat/synapse/tinhat_rules.py), mounted read-only into
// its container: which accounts are guests, the guest names about to be registered, the Guests room. Nothing secret.
const PUBLIC_DIR = join(CONF, "public");
try { mkdirSync(PUBLIC_DIR, { recursive: true, mode: 0o755 }); } catch { /* exists */ }
function publish(name, value) {
    try { writeAtomic(join(PUBLIC_DIR, name), JSON.stringify(value), 0o644); }
    catch (e) { console.error(`[guest] could not publish ${name}: ${e.message}`); }
}
const guestAllow = new Map();  // localpart → ms: names the API is registering right now
function allowGuestName(localpart, on) {
    const now = Date.now();
    for (const [k, at] of guestAllow) if (now - at > 120_000) guestAllow.delete(k);
    if (on) guestAllow.set(localpart, now); else guestAllow.delete(localpart);
    publish("guest-allow.json", Object.fromEntries(guestAllow));
}
function saveGuestAccounts() {
    // each account with the ONE room it was made for: Synapse's tinhat_rules lets it join only that room
    publish("guest-accounts.json", guestAccounts.map((a) => ({ user: a.user, room: a.room })));
    try { writeAtomic(GUEST_ACCOUNTS_FILE, JSON.stringify(guestAccounts, null, 1)); }
    catch (e) { console.error(`[guest] could not persist guest accounts: ${e.message}`); }
}

async function synapse(path, init = {}, token) {
    const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(HS_INTERNAL + path, { ...init, headers, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { ok: r.ok, status: r.status, body };
}

async function registerGuestAccount(displayName) {
    const nonceRes = await synapse("/_synapse/admin/v1/register");
    if (!nonceRes.ok) throw new Error(`registration nonce said ${nonceRes.status}`);
    const nonce = nonceRes.body.nonce;
    const username = `guest-${randomBytes(6).toString("hex")}`;
    const password = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const mac = createHmac("sha1", SYNAPSE_SECRET).update(`${nonce}\0${username}\0${password}\0notadmin`).digest("hex");
    allowGuestName(username, true);  // tinhat_rules lets only the API register guest-… names, this one, now
    let r;
    try { r = await synapse("/_synapse/admin/v1/register", {
        method: "POST",
        body: JSON.stringify({ nonce, username, displayname: displayName, password, admin: false, mac }),
    }); } finally { allowGuestName(username, false); }
    if (!r.ok) throw new Error(`registration said ${r.status} ${r.body.error || ""}`.trim());
    return { user: r.body.user_id, token: r.body.access_token, device: r.body.device_id };
}

async function deactivateGuest(user) {
    const r = await synapse(`/_synapse/admin/v1/deactivate/${encodeURIComponent(user)}`,
        { method: "POST", body: JSON.stringify({ erase: true }) }, ADMIN_TOKEN);
    return r.ok;
}

saveGuestAccounts();  // publish the list for Synapse at every start
function recordGuestAccount({ user, room, name }) {
    guestAccounts.push({ user, room, created: Date.now(), name });
    saveGuestAccounts();
}
// Set once call moderation is installed (below): takes accounts out of a room's call on the call server.
let dropFromCall = async () => 0;
/** The guest room was turned off: every account it made goes now (in the room or not, and out of its call); failures
 *  retry in the reaper. */
async function revokeGuestsOf(room) {
    let n = 0;
    const theirs = guestAccounts.filter((x) => x.room === room);
    await dropFromCall(room, theirs.map((a) => a.user)).catch(() => 0);
    for (const a of theirs) {
        a.revokeNow = true;
        if (await deactivateGuest(a.user).catch(() => false)) {
            guestAccounts = guestAccounts.filter((x) => x.user !== a.user);
            n++;
        }
    }
    saveGuestAccounts();
    return n;
}
async function guestReap() {
    if (!ADMIN_TOKEN) return;
    const now = Date.now();
    const due = guestAccounts.filter((a) => a.revokeNow || now - a.created > GUEST_ACCOUNT_TTL_MS);
    for (const a of due) {
        await dropFromCall(a.room, [a.user]).catch(() => 0);
        try {
            if (await deactivateGuest(a.user)) {
                guestAccounts = guestAccounts.filter((x) => x.user !== a.user);
                console.log(`[guest] ${a.user} deactivated after ${Math.round((now - a.created) / 3600000)} h`);
            } else {
                console.error(`[guest] could not deactivate ${a.user} (will retry)`);
            }
        } catch (e) {
            console.error(`[guest] deactivate ${a.user} failed: ${e.message}`);
        }
    }
    if (due.length) saveGuestAccounts();
}
setInterval(guestReap, GUEST_REAP_MS).unref?.();
guestReap();

// ---- Memories / DVR API (0.8.8) --------------------------------------------------
// Recordings live on the READ-ONLY /vods mount. Listing requires the caller's own
// Matrix access token + membership in the room; file URLs are HMAC-signed with a 24h
// expiry so the mpv player can stream them without auth headers.
const VODS_DIR = process.env.VODS_DIR || "/vods";
// Public prefix of the signed file URLs handed to players (https://<server>/api/vods). The HMAC covers path + expiry
// only, so a signed URL keeps playing if the server is reached under another of its names.
const VODS_PUBLIC_BASE = required("VODS_PUBLIC_BASE").replace(/\/+$/, "");
let VODS_SECRET = "";
try { VODS_SECRET = readFileSync(join(CONF, "vods.secret"), "utf8").trim(); } catch { /* generate */ }
if (!VODS_SECRET) {
    VODS_SECRET = crypto.randomUUID() + crypto.randomUUID();
    try { writeFileSync(join(CONF, "vods.secret"), VODS_SECRET, { mode: 0o600 }); } catch { /* ephemeral */ }
}
const vodsSanitize = (r) => r.replace(/[^A-Za-z0-9._@-]/g, "_");
const vodsSig = (p, exp) => createHmac("sha256", VODS_SECRET).update(`${p}\0${exp}`).digest("hex").slice(0, 32);

async function matrixWhoami(token) {
    try {
        const r = await fetch(`${HS_INTERNAL}/_matrix/client/v3/account/whoami`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return null;
        return (await r.json()).user_id || null;
    } catch { return null; }
}
async function vodsMemberOf(token, room, user) {
    try {
        const r = await fetch(
            `${HS_INTERNAL}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.member/${encodeURIComponent(user)}`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) },
        );
        if (!r.ok) return false;
        return (await r.json()).membership === "join";
    } catch { return false; }
}

app.get("/vods/sessions", async (req, res) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const room = String(req.query.room || "");
    if (!token || !room) return res.status(400).json({ error: "room + bearer token required" });
    const user = await matrixWhoami(token);
    if (!user) return res.status(401).json({ error: "bad token" });
    if (!(await vodsMemberOf(token, room, user))) return res.status(403).json({ error: "not a member of that room" });
    const sroom = vodsSanitize(room);
    const dir = `${VODS_DIR}/${sroom}`;
    const out = [];
    try {
        for (const s of readdirSync(dir)) {
            const sd = `${dir}/${s}`;
            let session = {};
            try { session = JSON.parse(readFileSync(`${sd}/session.json`, "utf8")); } catch { continue; }
            const exp = Date.now() + 24 * 3600 * 1000;
            const urlFor = (f) => {
                const p = `${sroom}/${s}/${f}`;
                return `${VODS_PUBLIC_BASE}/file/${p}?exp=${exp}&sig=${vodsSig(p, exp)}`;
            };
            const tracks = [];
            try {
                for (const line of readFileSync(`${sd}/tracks.jsonl`, "utf8").trim().split("\n")) {
                    if (!line) continue;
                    const t = JSON.parse(line);
                    t.url = urlFor(t.file);
                    // combined POV file (video + aligned mixed audio) — the player's
                    // preferred single-file lipsync source (0.8.10)
                    if (t.kind !== "audio" && existsSync(`${sd}/combined-${t.file}`))
                        t.combined_url = urlFor(`combined-${t.file}`);
                    tracks.push(t);
                }
            } catch { /* no tracks yet */ }
            const mixed = existsSync(`${sd}/mixed.mka`) ? urlFor("mixed.mka") : "";
            // Player gating: live = the call is still being recorded;
            // ready = post-close processing done (mixed + every video track's
            // combined file present). A session can be neither (processing window
            // ~minutes after close, or a crashed recorder) — the player shows
            // those as "Processing…" until this flips.
            const live = session.end_ms == null;
            const ready = !live && mixed !== ""
                && tracks.filter(t => t.kind !== "audio").every(t => !!t.combined_url);
            // 0.8.15 polish: card metadata. bytes = on-disk size of the whole session;
            // people = unique Matrix users behind the tracks (identity is
            // "@user:server:DEVICE"), first-seen order; empty = nothing was captured.
            let bytes = 0;
            try { for (const f of readdirSync(sd)) { try { bytes += statSync(`${sd}/${f}`).size; } catch { /* vanished */ } } } catch { /* unreadable */ }
            const people = [];
            for (const t of tracks) {
                const m = /^(@[^:]+:[^:]+)/.exec(String(t.identity || ""));
                if (m && !people.includes(m[1])) people.push(m[1]);
            }
            out.push({ id: s, ...session, tracks, mixed_url: mixed, live, ready, bytes, people, empty: tracks.length === 0 });
        }
    } catch { /* room has no recordings yet */ }
    out.sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));
    res.json({ sessions: out });
});

// Cap concurrent thumb ffmpegs — this box has 2 cores, and N tiles x a
// fresh 1440p decode every 2s piled up into 8s-SIGKILL'd truncated 200s. Busy now
// answers an honest 503 (clients retry on their own cadence). 0.8.13+ side tiles
// are LIVE gst pipelines; thumbs remain only as the per-tile fallback + posters.
let thumbBusy = 0;
const THUMB_MAX = 3;
app.get("/vods/thumb/:room/:session/:file", (req, res) => {
    const { room, session, file } = req.params;
    const exp = Number(req.query.exp || 0);
    const s = String(req.query.sig || "");
    const t = Math.max(0, Math.min(86400, Number(req.query.t || 0)));
    const p = `${room}/${session}/${file}`;
    if (p.includes("..") || p.includes("//")) return res.status(400).end();
    if (!exp || exp < Date.now() || s !== vodsSig(p, exp)) return res.status(403).end();
    if (thumbBusy >= THUMB_MAX) {
        res.setHeader("Retry-After", "2");
        return res.status(503).end();
    }
    thumbBusy++;
    let counted = true;
    const done = () => { if (counted) { counted = false; thumbBusy--; } };
    // -skip_frame nokey: decode ONLY the keyframe at the seek point instead of a
    // full GOP of (potentially 1440p60) frames — turns a ~2s render into ~100ms,
    // which is what lets N fallback tiles poll every few seconds under the cap.
    const ff = spawn("ffmpeg", ["-v", "error", "-skip_frame", "nokey", "-an", "-sn",
        "-ss", String(t), "-i", `${VODS_DIR}/${p}`,
        "-frames:v", "1", "-vf", "scale=356:-2", "-f", "mjpeg", "-"]);
    // Buffer FIRST, send headers only once real bytes exist: piping immediately
    // meant a failed/empty render (t past EOF, killed ffmpeg) had already sent a
    // 200 image/jpeg header and delivered a truncated nothing — the field
    // "server replied:" empty-image errors. Zero bytes or nonzero exit → 404.
    const chunks = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("error", () => { done(); try { res.status(500).end(); } catch {} });
    ff.on("close", (c) => {
        done();
        const body = Buffer.concat(chunks);
        try {
            if (c !== 0 || body.length === 0) return res.status(404).end();
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
        } catch {}
    });
    setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} }, 8000);
});

app.get("/vods/file/:room/:session/:file", (req, res) => {
    const { room, session, file } = req.params;
    const exp = Number(req.query.exp || 0);
    const s = String(req.query.sig || "");
    const p = `${room}/${session}/${file}`;
    if (p.includes("..") || p.includes("//")) return res.status(400).end();
    if (!exp || exp < Date.now() || s !== vodsSig(p, exp)) return res.status(403).end();
    res.sendFile(p, { root: VODS_DIR, acceptRanges: true }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

// ---- myinstants upstream (0.8.21) --------------------------------------------------
// Everything that touches myinstants goes through mi-fetch.py: since ~2026-09-04 their
// Cloudflare rules 403 Node's/curl's TLS fingerprint from here regardless of headers,
// while Python's urllib passes. Search results are cached 10 min; clips are cached on
// disk forever and served from THIS origin, so the app's local preview (Windows
// Qt/FFmpeg was 403'd upstream = "I can't hear my own clip") and the call publish both
// fetch from this server and never from myinstants.
const MI_HELPER = new URL("./mi-fetch.py", import.meta.url).pathname;
const CLIP_DIR = process.env.SOUNDBOARD_CACHE_DIR || join(CONF, "cache");
try { mkdirSync(CLIP_DIR, { recursive: true }); } catch { /* exists */ }
function miFetch(url, outPath) {
    return new Promise((resolve) => {
        execFile("python3", [MI_HELPER, url, outPath], { timeout: 25000 }, (err, stdout) => {
            const line = String(stdout || "").trim().split("\n").pop();
            try { if (line) return resolve(JSON.parse(line)); } catch { /* fall through */ }
            resolve({ status: 0, error: String((err && err.message) || "helper produced no status") });
        });
    });
}
function miUrl(url) {
    const full = url.startsWith("http") ? url : `https://www.myinstants.com${url}`;
    let parsed;
    try { parsed = new URL(full); } catch { return null; }
    const host = parsed.hostname.toLowerCase();
    // exactly myinstants.com or one of its subdomains (endsWith alone let evilmyinstants.com through), https, no port
    if (parsed.protocol !== "https:" || parsed.port || !(host === "myinstants.com" || host.endsWith(".myinstants.com"))) return null;
    return parsed.toString();
}
const SEARCH_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map(); // q -> { at, results }
app.get("/search", async (req, res) => {
    const query = req.query.q;
    if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Missing q parameter" });
    }
    const q = query.trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const hit = searchCache.get(q);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return res.json(hit.results);
    const tmp = join(tmpdir(), `mi-search-${randomBytes(12).toString("hex")}.html`);
    try {
        const r = await miFetch(`https://www.myinstants.com/en/search/?name=${encodeURIComponent(q)}`, tmp);
        if (r.status === 404) {
            // myinstants answers 404 for NO-RESULT queries and its own filtered terms —
            // that is "no results", not an outage (field logs 2026-08-17).
            searchCache.set(q, { at: Date.now(), results: [] });
            return res.json([]);
        }
        if (r.status !== 200) {
            console.warn(`[soundboard] search upstream ${r.status} ${r.error || ""} q=${q}`);
            return res.status(502).json({
                error: r.status === 403 ? "myinstants is blocking us right now" : `myinstants returned ${r.status || "error"}`,
            });
        }
        const html = readFileSync(tmp, "utf8");
        const results = [];
        const regex = /onclick="play\('([^']+)'[^"]*"\s+title="Play ([^"]+) sound"/g;
        let match;
        while ((match = regex.exec(html)) !== null && results.length < 20) {
            results.push({ mp3Path: match[1], name: match[2].trim() });
        }
        if (searchCache.size > 500) searchCache.clear();
        searchCache.set(q, { at: Date.now(), results });
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message || "Search failed" });
    } finally {
        try { unlinkSync(tmp); } catch { /* never written */ }
    }
});

// Clip cache: GET /clip?url=<myinstants url>  (and /fetch, the pre-0.8.21 name).
// GET /clip?id=<sha256> serves an UPLOADED clip instead — see the uploads section below.
const CLIP_TYPES = { mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", webm: "audio/webm" };
const clipInflight = new Map(); // key -> Promise
function clipPaths(fullUrl) {
    const key = createHash("sha256").update(fullUrl).digest("hex");
    const m = /\.(mp3|ogg|opus|wav|m4a|webm)(?:\?|$)/i.exec(new URL(fullUrl).pathname);
    const ext = m ? m[1].toLowerCase() : "mp3";
    return { key, ext, file: `${CLIP_DIR}/${key}.${ext}`, metaFile: `${CLIP_DIR}/${key}.json` };
}
// `admit()` is asked only right before a NEW upstream fetch starts (not for a cached clip, not for a request that joins
// a fetch already running): false = no fetch, a 429 (limits.mjs: a fetch from myinstants costs a strict one).
async function ensureClip(fullUrl, admit = () => true) {
    const { key, ext, file, metaFile } = clipPaths(fullUrl);
    if (existsSync(file)) {
        let ct = CLIP_TYPES[ext];
        try { ct = JSON.parse(readFileSync(metaFile, "utf8")).content_type || ct; } catch { /* no meta */ }
        if (!/^audio\/[a-z0-9.+-]+$/i.test(String(ct))) ct = CLIP_TYPES[ext] || "audio/mpeg";  // an older cache entry: audio only
        return { file, contentType: ct };
    }
    if (clipInflight.has(key)) return clipInflight.get(key);
    if (!admit()) throw Object.assign(new Error("Too many requests"), { status: 429 });
    const p = (async () => {
        const tmp = `${file}.part-${process.pid}-${Date.now()}`;
        const r = await miFetch(fullUrl, tmp);
        if (r.status !== 200 || !r.bytes) {
            try { unlinkSync(tmp); } catch { /* never written */ }
            const e = new Error(r.status === 403 ? "myinstants is blocking us right now" : `upstream ${r.status || "error"}`);
            e.upstream = r.status;
            throw e;
        }
        const ct = (r.content_type || "").split(";")[0].trim() || CLIP_TYPES[ext] || "audio/mpeg";
        if (!/^audio\/[a-z0-9.+-]+$/i.test(ct)) {  // a clip is audio: anything else is never served from this origin
            try { unlinkSync(tmp); } catch { /* gone */ }
            throw Object.assign(new Error(`not audio (${ct.slice(0, 40)})`), { status: 415 });
        }
        writeFileSync(metaFile, JSON.stringify({ url: fullUrl, content_type: ct, bytes: r.bytes, fetched_at: new Date().toISOString() }));
        renameSync(tmp, file);
        console.log(`[soundboard] cached clip ${key.slice(0, 12)} ${r.bytes} B ${fullUrl}`);
        return { file, contentType: ct };
    })();
    clipInflight.set(key, p);
    try { return await p; } finally { clipInflight.delete(key); }
}
async function serveClip(req, res) {
    // ?id= is a user upload, ?url= the myinstants cache: ONE route for both so the app
    // has a single clip-URL shape whatever the source (uploads section below).
    if (req.query.id !== undefined) return serveUpload(req, res);
    const url = req.query.url;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url parameter" });
    let full;
    try { full = miUrl(url); } catch { full = null; }
    if (!full) return res.status(403).json({ error: "Only myinstants.com URLs allowed" });
    try {
        // reading a cached clip is the clip tier's (limits.mjs); a new fetch from myinstants also costs a strict one
        const { file, contentType } = await ensureClip(full, () => limits.upstreamFetch(req.ip));
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.sendFile(file, { headers: { "Content-Type": contentType, "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox" }, acceptRanges: true, lastModified: false });
    } catch (err) {
        if (err.status === 429) return tooMany(res);
        console.warn(`[soundboard] clip fetch failed: ${err.message} ${full}`);
        res.status(502).json({ error: err.message || "Fetch failed" });
    }
}
app.get("/clip", serveClip);
app.get("/fetch", serveClip);

// ── uploaded clips (2026-09-07) ─────────────────────────────────────────────
//
// Users can add their OWN sounds, not just myinstants finds. A clip lands under a
// content hash with a .json sidecar that is the ONLY record of who owns it (no DB —
// a few hundred small files at most, read straight off disk). The hash is salted with
// the uploader, so two people uploading the same meme each get their own record:
// with a bare content hash the second person could neither see it in /uploads nor
// delete it, and a delete by the first would silently kill it for both. Playback goes
// through the SAME /clip route as the cache (?id= instead of ?url=) so the app's local
// preview, the call publish path and the immutable Cache-Control stay one code path.
//
// Auth is the caller's Matrix access token (whoami, exactly like the vods API): if
// Synapse says you are @x:your.server, you are. The browser's content-type and filename
// are hints only — the container is sniffed from the first bytes and THAT decides the
// stored type, so a renamed .exe can never be served back as audio.
const UPLOAD_DIR = process.env.SOUNDBOARD_UPLOAD_DIR || join(CONF, "uploads");
try { mkdirSync(UPLOAD_DIR, { recursive: true }); } catch { /* exists */ }
const UPLOAD_MAX = 3 * 1024 * 1024; // a soundboard clip is seconds long; 3 MB is ~3 min of 128k mp3
const UPLOAD_ID_RE = /^[0-9a-f]{64}$/;
const CLIP_PUBLIC_BASE = required("SOUNDBOARD_PUBLIC_BASE");

/**
 * Bearer <matrix access token> -> req.matrixUser, else 401. Mounted BEFORE the body
 * parser on /upload so an unauthenticated 3 MB POST is refused without reading it.
 */
async function requireMatrixUser(req, res, next) {
    // The shared sign-in check (reachcommon): answers cached 60 s per token, and budgets for tokens never seen valid
    // (per client address and overall), so a flood of made-up tokens can't hammer Synapse.
    let who;
    try { who = await reachAuth.authenticate(req, res); } catch (e) { return res.status(502).json({ error: "homeserver unreachable" }); }
    if (!who) return;  // answered (401 / 429 / 502)
    req.matrixUser = who.user;
    next();
}

/**
 * Minimal multipart/form-data parser: text fields + files, one body in memory. Hand
 * written because this service deliberately has ONE dependency (express) and neither
 * multer nor busboy is installed; for "a name and a ≤3 MB clip" this is all it takes.
 * Returns { fields: {name: string}, files: {name: {filename, contentType, data}} },
 * or null when the Content-Type carries no boundary.
 */
function parseMultipart(body, contentType) {
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
    if (!bm) return null;
    const boundary = Buffer.from(`--${(bm[1] || bm[2]).trim()}`);
    const fields = {}, files = {};
    let pos = body.indexOf(boundary);
    while (pos !== -1) {
        pos += boundary.length;
        if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // "--" = the closing boundary
        if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
        const headEnd = body.indexOf("\r\n\r\n", pos);
        if (headEnd === -1) break;
        const next = body.indexOf(boundary, headEnd + 4);
        if (next === -1) break; // unterminated part = truncated body; ignore it
        const head = body.subarray(pos, headEnd).toString("latin1");
        // part data ends at the CRLF that precedes the next boundary
        const data = body.subarray(headEnd + 4, Math.max(headEnd + 4, next - 2));
        // "; name=" (not "filename=") is the field name
        const name = (/;\s*name="([^"]*)"/i.exec(head) || [])[1] || "";
        const filename = /;\s*filename="([^"]*)"/i.exec(head);
        const ct = /content-type:\s*([^\r\n;]+)/i.exec(head);
        if (filename) files[name] = { filename: filename[1], contentType: ((ct && ct[1]) || "").trim().toLowerCase(), data };
        else fields[name] = data.toString("utf8");
        pos = next;
    }
    return { fields, files };
}

/**
 * Sniff the container from the first bytes; {ext, type} or null. The set is exactly
 * what the soundboard players (browser <audio>, Qt/FFmpeg) decode and CLIP_TYPES serves.
 */
function sniffAudio(buf) {
    if (buf.length < 12) return null;
    const tag = (at, s) => buf.subarray(at, at + s.length).toString("latin1") === s;
    if (tag(0, "ID3")) return { ext: "mp3", type: "audio/mpeg" };
    // bare MPEG audio frame: 11-bit sync + a non-reserved layer (0xFFFB / FFFA / FFF3 / FFF2 …)
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0) return { ext: "mp3", type: "audio/mpeg" };
    if (tag(0, "OggS")) return { ext: buf.subarray(0, 64).includes("OpusHead") ? "opus" : "ogg", type: "audio/ogg" };
    if (tag(0, "RIFF") && tag(8, "WAVE")) return { ext: "wav", type: "audio/wav" };
    if (tag(4, "ftyp")) return { ext: "m4a", type: "audio/mp4" };
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: "webm", type: "audio/webm" }; // EBML
    return null;
}

function readUploadMeta(id) {
    try {
        const meta = JSON.parse(readFileSync(`${UPLOAD_DIR}/${id}.json`, "utf8"));
        // ext is our own sidecar field, but it becomes a path segment — keep it boring
        return /^[a-z0-9]{2,4}$/.test(meta.ext || "") ? meta : null;
    } catch { return null; }
}
const uploadRecord = (id, meta) => ({
    id, url: `${CLIP_PUBLIC_BASE}/clip?id=${id}`, name: meta.name, bytes: meta.bytes, uploaded_at: meta.uploaded_at,
});

/** GET /clip?id=<sha256> — the uploaded-clip half of serveClip; same headers as the cache. */
function serveUpload(req, res) {
    const id = String(req.query.id || "");
    if (!UPLOAD_ID_RE.test(id)) return res.status(400).json({ error: "Bad clip id" });
    const meta = readUploadMeta(id);
    if (!meta) return res.status(404).json({ error: "No such clip" });
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(`${UPLOAD_DIR}/${id}.${meta.ext}`,
        { headers: { "Content-Type": meta.content_type || "application/octet-stream", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox" }, acceptRanges: true, lastModified: false },
        (err) => { if (err && !res.headersSent) res.status(404).end(); });
}

/**
 * POST /upload  multipart: file (audio, ≤3 MB) + name (≤80 chars)  →  201 {id, url, name, bytes}
 * Same bytes from the same person = same id: the existing record is simply returned.
 */
app.post("/upload", requireMatrixUser, express.raw({ type: "multipart/form-data", limit: "4mb" }), (req, res) => {
    // a guest's few hours leave no sounds on the server's disk (they'd outlive the account)
    if (/^@guest-/.test(req.matrixUser || "")) return res.status(403).json({ error: "Guests can't add sounds." });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "multipart/form-data body required" });
    const parts = parseMultipart(req.body, req.headers["content-type"]);
    const f = parts && parts.files.file;
    if (!f || !f.data.length) return res.status(400).json({ error: "Missing file field" });
    if (f.data.length > UPLOAD_MAX) return res.status(413).json({ error: "Clip too large (3 MB max)" });
    const kind = sniffAudio(f.data);
    if (!kind) return res.status(415).json({ error: "Not a supported audio file (mp3, ogg/opus, wav, m4a, webm)" });
    // same scrub as guest display names: it is rendered in everyone's soundboard
    const clean = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
    const name = clean(parts.fields.name) || clean((f.filename || "").replace(/\.[^.]+$/, "")) || "clip";
    const id = createHash("sha256").update(req.matrixUser).update("\0").update(f.data).digest("hex");
    const file = `${UPLOAD_DIR}/${id}.${kind.ext}`;
    try {
        let meta = readUploadMeta(id);
        if (!meta) {
            // bytes first, sidecar last: a sidecar without audio would be a dead entry in
            // /uploads, whereas orphan audio without a sidecar is merely unreachable
            const tmp = `${file}.part-${process.pid}-${Date.now()}`;
            writeFileSync(tmp, f.data);
            renameSync(tmp, file);
            meta = { name, uploader: req.matrixUser, content_type: kind.type, bytes: f.data.length, uploaded_at: new Date().toISOString(), ext: kind.ext };
            writeFileSync(`${UPLOAD_DIR}/${id}.json`, JSON.stringify(meta));
            console.log(`[soundboard] ${req.matrixUser} uploaded ${id.slice(0, 12)} ${kind.ext} ${f.data.length} B "${name}"`);
        }
        res.status(201).json(uploadRecord(id, meta));
    } catch (err) {
        console.error(`[soundboard] upload failed: ${err.message}`);
        res.status(500).json({ error: "Could not store the clip" });
    }
}, (err, _req, res, _next) => {
    // body-parser's own refusals (the 4 MB raw cap) arrive here as errors with a status —
    // answer JSON like everything else instead of Express's HTML error page
    res.status(err.status || 500).json({ error: err.status === 413 ? "Clip too large (3 MB max)" : (err.message || "Bad upload") });
});

/** GET /uploads — the caller's own clips, newest first. */
app.get("/uploads", requireMatrixUser, (req, res) => {
    const out = [];
    try {
        for (const f of readdirSync(UPLOAD_DIR)) {
            if (!f.endsWith(".json")) continue;
            const id = f.slice(0, -5);
            if (!UPLOAD_ID_RE.test(id)) continue;
            const meta = readUploadMeta(id);
            if (meta && meta.uploader === req.matrixUser) out.push(uploadRecord(id, meta));
        }
    } catch { /* directory vanished */ }
    out.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : a.uploaded_at > b.uploaded_at ? -1 : 0)); // ISO strings sort as time
    res.json(out);
});

/** DELETE /uploads/:id — only the uploader may; 204 when gone. */
app.delete("/uploads/:id", requireMatrixUser, (req, res) => {
    const id = String(req.params.id || "");
    if (!UPLOAD_ID_RE.test(id)) return res.status(400).json({ error: "Bad clip id" });
    const meta = readUploadMeta(id);
    if (!meta) return res.status(404).json({ error: "No such clip" });
    if (meta.uploader !== req.matrixUser) return res.status(403).json({ error: "Not your clip" });
    // sidecar first: it is the ownership record, so once it is gone the clip is
    // unreachable even if the audio unlink below fails
    try { unlinkSync(`${UPLOAD_DIR}/${id}.json`); } catch { /* already gone */ }
    try { unlinkSync(`${UPLOAD_DIR}/${id}.${meta.ext}`); } catch { /* already gone */ }
    console.log(`[soundboard] ${req.matrixUser} deleted upload ${id.slice(0, 12)} "${meta.name}"`);
    res.status(204).end();
});

// ── GIF picker (Giphy) ─────────────────────────────────────────────────────
function mapGif(g) {
    const img = g.images || {};
    const full = img.downsized || img.original || {};
    const prev = img.fixed_width_small || img.fixed_width || img.preview_gif || full;
    return {
        id: g.id,
        title: g.title || "GIF",
        url: full.url,
        width: Number(full.width) || 0,
        height: Number(full.height) || 0,
        preview: prev.url,
    };
}

async function giphyList(endpoint, params, res) {
    if (!GIPHY_KEY) return res.status(503).json({ error: "GIF search not configured" });
    try {
        const url =
            `https://api.giphy.com/v1/gifs/${endpoint}?api_key=${GIPHY_KEY}` +
            `${params ? `&${params}` : ""}&limit=24&rating=pg-13&bundle=messaging_non_clips`;
        const r = await fetch(url);
        if (!r.ok) return res.status(502).json({ error: `giphy ${r.status}` });
        const json = await r.json();
        res.json((json.data || []).map(mapGif).filter((g) => g.url && g.preview));
    } catch (err) {
        res.status(500).json({ error: err.message || "GIF request failed" });
    }
}

app.get("/gif/search", (req, res) => {
    const q = req.query.q;
    if (!q || typeof q !== "string") return res.status(400).json({ error: "Missing q parameter" });
    void giphyList("search", `q=${encodeURIComponent(q)}`, res);
});

app.get("/gif/trending", (_req, res) => {
    void giphyList("trending", "", res);
});

// Proxy GIF bytes (CORS-safe) so the client can re-upload to the homeserver.
app.get("/gif/fetch", async (req, res) => {
    const url = req.query.url;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url parameter" });
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return res.status(400).json({ error: "Bad url" });
    }
    if (parsed.protocol !== "https:" || !(parsed.hostname === "giphy.com" || parsed.hostname.endsWith(".giphy.com"))) {
        return res.status(403).json({ error: "Only giphy.com URLs allowed" });
    }
    try {
        const r = await fetch(url);
        if (!r.ok) return res.status(502).json({ error: `Fetch failed: ${r.status}` });
        res.setHeader("Content-Type", r.headers.get("content-type") || "image/gif");
        const buf = await r.arrayBuffer();
        res.send(Buffer.from(buf));
    } catch (err) {
        res.status(500).json({ error: err.message || "Fetch failed" });
    }
});

// Media Party (Tin Hat 11.4, 2026-10-11).
// Every /youtube/* route lives in watch.mjs: search (the OLD array shape stays for 11.2.1 clients; v=2 = the new shape +
// type=video|music|playlist|channel), suggest, trending, playlist, channel, meta (Spotify / Apple Music / YouTube Music
// links), resolve (song -> its YouTube upload), budget. SQLite cache + Data API units per Pacific day in
// WATCH_DATA_DIR/watch.db (default: the watch folder next to the config). Caddy maps /api/watch/* here.
installWatch(app, { youtubeKey: YOUTUBE_KEY, dataDir: process.env.WATCH_DATA_DIR || join(CONF, "watch") });

// Call moderation (RBAC, 2026-09-17): server-mute / disconnect a call participant, authorised
// by the space's roles (or power levels). Lives in moderation.mjs; it borrows this process'
// admin token + LiveKit secret and never exposes either.
dropFromCall = installModeration(app, {
    requireMatrixUser, synapse, adminToken: ADMIN_TOKEN,
    lkApiUrl: LK_API_URL, lkKey: LK_KEY, lkSecret: LK_SECRET, b64u, createHmac,
}).dropFromCall;

// Registration invite codes (Tin Hat 10.4, 2026-09-19): server operators mint Synapse registration
// tokens from Settings -> Invites; the sign-in screen's "Create an account" redeems them. Operators =
// Synapse server admins + the mxids in invite-operators.json (the owner's account is not a Synapse admin).
let INVITE_OPERATORS = new Set();
try { INVITE_OPERATORS = new Set(JSON.parse(readFileSync(join(CONF, "invite-operators.json"), "utf8"))); }
catch { console.error("[invites] invite-operators.json missing/invalid -> Synapse admins only"); }
installInvites(app, { requireMatrixUser, synapse, adminToken: ADMIN_TOKEN, operators: INVITE_OPERATORS, serverName: process.env.SERVER_NAME || "" });

// Reach (Tin Hat 10.6, 2026-09-25; contract REACH.md in both app repos): opt-in presence + web push. Talks only to
// the pinned internal Synapse. The push GATEWAY runs on its own listener (PUSH_GATEWAY_HOST:PUSH_GATEWAY_PORT; never
// this app, whose routes /api/soundboard/ exposes wholesale), reachable by Synapse only (on a Tin Hat Server: the box's
// address on the compose network, the one private address Synapse's ip_range_whitelist allows).
const REACH_HS = HS_INTERNAL; // pinned at start (REACH A2.4): never taken from a request
const reachHs = createHs({ hsUrl: REACH_HS });
const reachAuth = createMatrixAuth({ hs: reachHs });
installPresence(app, { auth: reachAuth, hs: reachHs, adminToken: ADMIN_TOKEN });
installPush(app, {
    auth: reachAuth, hs: reachHs, adminToken: ADMIN_TOKEN, dir: CONF,
    gatewayListen: { host: process.env.PUSH_GATEWAY_HOST || "127.0.0.1", port: Number(process.env.PUSH_GATEWAY_PORT || 3091) },
    gatewayUrl: required("PUSH_GATEWAY_URL"), subject: required("PUSH_SUBJECT"),
    relay: process.env.PUSH_RELAY || null, // the Tin Hat phone apps' relay (docs/PHONE-PUSH.md); unset = phones refused
});

// The guest room (docs/GUESTS.md in the server repository): one optional Guests room, a link that can be renewed,
// guests wait at the door until a member lets them in. Needs the system account (a Synapse admin) and the
// registration secret, like the guest accounts above; the 12-hour reaper covers its accounts too.
if (ADMIN_TOKEN && SYNAPSE_SECRET) {
    const PUBLIC_BASE = HS_PUBLIC.replace(/\/+$/, "");
    installGuests(app, {
        auth: reachAuth, hs: reachHs, adminToken: ADMIN_TOKEN, serverName: process.env.SERVER_NAME || new URL(PUBLIC_BASE).hostname,
        publicBase: PUBLIC_BASE, webBase: WEB_BASE, register: registerGuestAccount, deactivate: deactivateGuest,
        recordGuest: recordGuestAccount,
        isGuest: (mxid) => guestAccounts.some((a) => a.user === mxid) || /^@guest-/.test(mxid),
        isTemporary: (mxid) => guestAccounts.some((a) => a.user === mxid),
        revokeAll: revokeGuestsOf,
        publishRoom: (room) => publish("guests-room.json", { room }),
        statePath: join(CONF, "guests.json"),
    });
}

// Game servers (Tin Hat 11.1; contract docs/GAMESERVERS.md in both app repos): GET /gameservers/status + POST
// /gameservers/power. The ONE path from Tin Hat to the owner's Pelican (or Pterodactyl) panel: a least-privilege panel
// subuser's client API key (pelican.key, 0600, best IP-restricted to this server) never leaves this process. Config
// gameservers.json (0600, re-read on change). Members of the governing space see the servers; `manage_game_servers` powers them.
installGameServers(app, {
    auth: reachAuth, hs: reachHs, adminToken: ADMIN_TOKEN,
    configPath: join(CONF, "gameservers.json"),
    keyPath: join(CONF, "pelican.key"),
});

app.listen(PORT, "127.0.0.1", () => {
    console.log(`Tin Hat API listening on 127.0.0.1:${PORT} (conf ${CONF})`);
});
