import express from "express";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync, renameSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installModeration } from "./moderation.mjs";
import { abuseReport, isAbuse, ABUSE_PER_DAY as ABUSE_PER_DAY_MAX, ABUSE_MAX_BYTES, ABUSE_SUFFIX, ABUSE_TOTAL_MAX_BYTES } from "./reports.mjs";
import { installInvites } from "./invites.mjs";
import { createHs, createMatrixAuth, RateLimit, clientKey, ipBucket, trustProxy } from "./reachcommon.mjs";
import { createLimits } from "./limits.mjs";
import { installPresence } from "./presence.mjs";
import { installPush } from "./push.mjs";
import { RING } from "./ring.mjs";
import { installGameServers } from "./gameservers.mjs";
import { installWatch } from "./watch.mjs";
import { installGuests } from "./guests.mjs";
import { installCallToken } from "./calltoken.mjs";
import { accessConfig, createAccess, SIGNIN_REQUIRED } from "./access.mjs";
import { normaliseClipUrl, ClipStore, Admitted, createClipSigner, sameHex, oneDownload } from "./clipcache.mjs";
import { parseForeignClipUrl, foreignDownload } from "./foreign.mjs";
import { giphyMediaUrl, sniffImage, readCapped, MEDIA_HEADERS, sniffAudio, sniffClipAudio, SANDBOX_HEADERS } from "./media.mjs";
import { clearGuestCalls } from "./guestcalls.mjs";

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
// 30/min), per REAL client IP (an IPv6 caller counts as its /64: reachcommon ipBucket).
// Behind a proxy, req.ip must be the REAL client (TRUST_PROXY names the proxies): otherwise every request looks like
// the proxy, one bucket for everybody, and one busy client gets everyone 429s (GIFs, soundboard, the invites check).
// TRUST_PROXY: who may set X-Forwarded-For (comma-separated addresses, networks or loopback / linklocal / uniquelocal;
// on a Tin Hat Server its own Caddy: loopback). Only that immediate hop is believed: req.ip is the last entry, the
// address Caddy verified, the same as reachcommon.clientIp (trustProxy).
app.set("trust proxy", trustProxy(process.env.TRUST_PROXY || "loopback"));
const limits = createLimits(Date.now);
setInterval(() => limits.sweep(), 600000).unref?.(); // idle addresses go, so the maps can't grow unbounded
function tooMany(res) {
    res.setHeader("Retry-After", "5");
    return res.status(429).json({ error: "Too many requests" });
}
function rateLimit(req, res, next) {
    if (!limits.request(req.path, ipBucket(req.ip))) return tooMany(res);
    next();
}

// Reach (Tin Hat 10.6, 2026-09-25): /presence and /push/* authenticate per user, rate-limit per user/token and read
// their own bodies (1 KB / 4 KB), so they skip the shared per-IP bucket above (behind two proxies every client
// arrives from the same address, so it is one bucket for everybody) and the app-wide 8 KB JSON parser.
// + /gameservers/* (the Game servers widget, 11.1; docs/GAMESERVERS.md in both app repos): the same — per-user limits,
// its own 2 KB body reader, whoami cached per token (reachcommon).
// + the guest room (guests.mjs): its own limits (knocks per address), and the waiting page polls every 2 s.
// + call sign-ins (calltoken.mjs): their own per-address limit and body reader (lk-jwt's request shapes).
const REACH_PATH = /^\/(?:presence\/?$|push\/|gameservers\/|guests(?:\/|$)|guest\/(?:door|knock|ticket)$|calltoken(?:\/|$))/;

// ---- this server's own extras (Tin Hat Server) -------------------------------------------------------------------
// Registered before the limiter and the JSON parser: they read their own bodies (the web server caps the sizes).
app.get("/health", (_req, res) => res.json({ ok: true }));
// Upload speed test sink: the app POSTs a few MB and times it; the bytes are counted and dropped.
const SPEED_PER_IP = new RateLimit(6, 60_000);
let speedRunning = 0;
app.post("/speedtest/up", (req, res) => {
    const ip = clientKey(req);
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
        try {
            for (const f of readdirSync(join(CONF, d))) {
                if (f.endsWith(ABUSE_SUFFIX)) continue;  // abuse reports: tiny, outside the cap (reports.mjs)
                try { n += statSync(join(CONF, d, f)).size; } catch { /* gone */ }
            }
        } catch { /* none yet */ }
    }
    return n;
}
/** What the stored abuse reports take together (their own bound, ABUSE_TOTAL_MAX_BYTES). */
function abuseBytes() {
    let n = 0;
    try {
        for (const f of readdirSync(join(CONF, "reports"))) {
            if (!f.endsWith(ABUSE_SUFFIX)) continue;
            try { n += statSync(join(CONF, "reports", f)).size; } catch { /* gone */ }
        }
    } catch { /* none yet */ }
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
// Abuse reports (reports.mjs) have their own quota and never count toward the size cap: they are tiny.
const ABUSE_PER_DAY = new RateLimit(ABUSE_PER_DAY_MAX, 24 * 3600_000);
async function storeReport(req, res) {
    if (/^@guest-/.test(req.matrixUser || "")) { req.resume(); return res.status(403).json({ error: "Guests can't send reports." }); }
    // neither quota left: refuse before reading anything; only abuse reports left: read no more than one of those
    const bugOk = REPORTS_PER_DAY.can(req.matrixUser);
    if (!bugOk && !ABUSE_PER_DAY.can(req.matrixUser)) {
        req.resume();
        return res.status(429).json({ error: "That's enough reports for today." });
    }
    const max = bugOk ? 1024 * 1024 : ABUSE_MAX_BYTES;
    let raw;
    try { raw = await readRaw(req, max); } catch { return res.status(413).json({ error: `report too big (${bugOk ? "1 MB" : "16 KB"})` }); }
    let report;
    try { report = JSON.parse(raw.toString("utf8") || "{}"); } catch { return res.status(400).json({ error: "report must be JSON" }); }
    const abuse = isAbuse(report);
    if (abuse) {  // every try counts, a refused one too
        if (raw.length > ABUSE_MAX_BYTES) return res.status(413).json({ error: "report too big (16 KB)" });
        if (!ABUSE_PER_DAY.hit(req.matrixUser)) return res.status(429).json({ error: "That's enough reports for today." });
        report = abuseReport(report, req.matrixUser);
        if (report.error) return res.status(400).json({ error: report.error });
        if (abuseBytes() + raw.length > ABUSE_TOTAL_MAX_BYTES) return res.status(507).json({ error: "The server's report inbox is full; its owner needs to clear it." });
    } else if (!reportAllowed(req, res, raw.length)) {
        return;
    }
    const dir = join(CONF, "reports");
    mkdirSync(dir, { recursive: true });
    const id = abuse ? `${fileStamp()}-abuse` : fileStamp();
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
// The shared sign-in check (reachcommon; REACH A2.4: pinned at start, never taken from a request) and who may make
// this server spend its keys and outbound fetches (access.mjs: members, or the small allowance for older apps).
const reachHs = createHs({ hsUrl: HS_INTERNAL });
const reachAuth = createMatrixAuth({ hs: reachHs });
const access = createAccess({ auth: reachAuth, config: accessConfig() });
const MB = 1024 * 1024;
/** A positive number from the environment, else `def` (sizes in MB, counts). */
/** A whole-number setting: digits only (no sign, decimals, exponent, Infinity or NaN), inside [min, max], else `def`.
 *  The same ranges as the dashboard's (apiconf.LIMITS), so a value it refuses can't reach the API another way. */
function envNum(name, def, min = 0, max = 999_999_999) {
    const raw = String(process.env[name] ?? "").trim();
    if (!/^[0-9]{1,10}$/.test(raw)) return def;
    const v = Number(raw);
    return v >= min && v <= max ? v : def;
}
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

// The homeserver as `call(method, path, token, body)` (guestcalls.mjs).
const synapseCall = (method, path, token, body) => synapse(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, token);
/** Withdraw the guest's call memberships in its room as the guest (guestcalls.mjs): before every kick / deactivation. */
async function endGuestCalls(user, room) {
    room = room || guestAccounts.find((a) => a.user === user)?.room;
    if (!ADMIN_TOKEN || !room) return 0;
    return clearGuestCalls({ call: synapseCall, adminToken: ADMIN_TOKEN, user, room, log: (l) => console.log(l) }).catch((e) => {
        console.error(`[guest] ending ${user}'s call failed: ${e.message}`);
        return 0;
    });
}

async function deactivateGuest(user) {
    await endGuestCalls(user);  // first: a deactivated account can't leave its call any more
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
    if (!exp || exp < Date.now() || !sameHex(s, vodsSig(p, exp))) return res.status(403).end();  // constant-time
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
            for (const [k, v] of Object.entries(SANDBOX_HEADERS)) res.setHeader(k, v);
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
    if (!exp || exp < Date.now() || !sameHex(s, vodsSig(p, exp))) return res.status(403).end();  // constant-time
    res.sendFile(p, { root: VODS_DIR, acceptRanges: true, headers: SANDBOX_HEADERS }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

// ---- myinstants upstream (0.8.21) --------------------------------------------------
// Everything that touches myinstants goes through mi-fetch.py: since ~2026-09-04 their
// Cloudflare rules 403 Node's/curl's TLS fingerprint from here regardless of headers,
// while Python's urllib passes. Search results are cached 10 min; clips are cached on
// disk and served from THIS origin, so the app's local preview (Windows
// Qt/FFmpeg was 403'd upstream = "I can't hear my own clip") and the call publish both
// fetch from this server and never from myinstants.
// Security review 2026-10-26 (H4): a clip is cached under its NORMALISED URL (clipcache.mjs: no query, one spelling),
// at most SOUNDBOARD_CLIP_MAX_MB (5) each and SOUNDBOARD_CACHE_MAX_MB (512) together, least recently played out first;
// searches and new clip downloads are spent by members (their own hourly budgets) or by the small shared allowance for
// apps that send no token (access.mjs); at most MI_CONCURRENT helpers run at once.
const MI_HELPER = new URL("./mi-fetch.py", import.meta.url).pathname;
const CLIP_DIR = process.env.SOUNDBOARD_CACHE_DIR || join(CONF, "cache");
try { mkdirSync(CLIP_DIR, { recursive: true }); } catch { /* exists */ }
const CLIP_MAX_BYTES = Math.max(64 * 1024, Math.floor(envNum("SOUNDBOARD_CLIP_MAX_MB", 5, 1, 100) * MB));
const CLIP_CACHE_MAX_BYTES = Math.max(CLIP_MAX_BYTES, Math.floor(envNum("SOUNDBOARD_CACHE_MAX_MB", 512, 1, 1_048_576) * MB));
const clipStore = new ClipStore({ dir: CLIP_DIR, maxBytes: CLIP_CACHE_MAX_BYTES, log: (s) => console.log(`[soundboard] ${s}`),
    sniff: sniffClipAudio }).scan();
console.log(`[soundboard] clip cache ${clipStore.entries.size} clips, ${Math.round(clipStore.total / MB)} of ${Math.round(CLIP_CACHE_MAX_BYTES / MB)} MB; one clip at most ${Math.round(CLIP_MAX_BYTES / MB * 10) / 10} MB`);
const admitted = new Admitted();      // clip URLs our own search answers handed out (24 h)
const MI_CONCURRENT = 4;
let miRunning = 0;
/** A helper slot, taken before anything is charged (a request that can't fetch spends no budget): {release} or null. */
function reserveHelper() {
    if (miRunning >= MI_CONCURRENT) return null;
    miRunning++;
    let held = true;
    return { release() { if (held) { held = false; miRunning--; } } };
}
/** Run the helper in a slot reserved with reserveHelper(); the slot is released when it exits. */
function miFetch(url, outPath, maxBytes, slot) {
    return new Promise((resolve) => {
        execFile("python3", [MI_HELPER, url, outPath, String(maxBytes)], { timeout: 25000 }, (err, stdout) => {
            slot.release();
            const line = String(stdout || "").trim().split("\n").pop();
            try { if (line) return resolve(JSON.parse(line)); } catch { /* fall through */ }
            resolve({ status: 0, error: String((err && err.message) || "helper produced no status") });
        });
    });
}
const busy = (res) => { res.setHeader("Retry-After", "2"); return res.status(503).json({ error: "The server is busy fetching sounds; try again in a moment." }); };
const SEARCH_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map(); // q -> { at, results }
/** Every clip a search answer hands out may be fetched without a token for a day (players can't send one). */
const admitResults = (results) => { for (const r of results) admitted.add(normaliseClipUrl(r.mp3Path)); };
app.get("/search", access.memberOrLegacy, async (req, res) => {
    const query = req.query.q;
    if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Missing q parameter" });
    }
    const q = query.trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    if (q.length > 100) return res.status(400).json({ error: "q too long" });
    const hit = searchCache.get(q);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) { admitResults(hit.results); return res.json(hit.results); }
    // a helper first, the budget only once a search will really go out (a busy server spends nobody's allowance)
    const slot = reserveHelper();
    if (!slot) return busy(res);
    const no = access.spend(req, "soundsearch");
    if (no) { slot.release(); return access.refuse(res, no); }
    const tmp = join(tmpdir(), `mi-search-${randomBytes(12).toString("hex")}.html`);
    try {
        const r = await miFetch(`https://www.myinstants.com/en/search/?name=${encodeURIComponent(q)}`, tmp, 4 * MB, slot);
        if (r.status === 404) {
            // myinstants answers 404 for NO-RESULT queries and its own filtered terms —
            // that is "no results", not an outage (field logs 2026-08-17).
            searchCache.set(q, { at: Date.now(), results: [] });
            return res.json([]);
        }
        if (r.status !== 200) {
            console.warn(`[soundboard] search upstream ${r.status} ${r.error || ""} q=${JSON.stringify(q).slice(0, 80)}`);
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
        admitResults(results);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message || "Search failed" });
    } finally {
        try { unlinkSync(tmp); } catch { /* never written */ }
    }
});

// Clip cache: GET /clip?url=<myinstants url>  (and /fetch, the pre-0.8.21 name).
// GET /clip?id=<sha256> serves an UPLOADED clip instead — see the uploads section below.
// A cached clip is served to anyone (public bytes, no spend). A clip this server doesn't have yet is fetched from
// myinstants only for: a member (bearer; their hourly budget), a signed link from /clip/sign (players that can't send
// a header: <audio>, GStreamer), a clip one of our search answers handed out in the last day, or, for apps that send
// no token, the small shared allowance (access.mjs). Anyone else gets 401 SIGNIN_REQUIRED.
const clipInflight = new Map();   // key -> Promise (a second request for the same clip joins the running fetch)
const clipMissing = new Map();    // key -> until: myinstants said 404 (an hour, so made-up paths cost one fetch each)
let clipSigner = null;            // set in the uploads section (needs CLIP_PUBLIC_BASE's neighbour, the vods secret)
/** Another Tin Hat server's sound (foreign.mjs): resolved, checked and fetched under one deadline, only now that the
 *  request was admitted and charged. The same answer shape as miFetch; the slot is released once the transfer is torn
 *  down. A non-public address throws 403, a body that isn't audio 415. */
async function foreignFetch(norm, tmp, host, slot) {
    try {
        const got = await foreignDownload(norm, host, { maxBytes: CLIP_MAX_BYTES });
        if (got.status !== 200) return { status: got.status, bytes: 0 };
        writeFileSync(tmp, got.data);
        return { status: 200, bytes: got.data.length, content_type: got.type };
    } catch (e) {
        if (e.status === 415 || e.status === 403) throw e;
        if (e.status === 413) return { status: 413, bytes: 0 };
        return { status: e.upstream || 0, bytes: 0, error: e.message, redirect: e.reason === "redirect" };
    } finally {
        slot.release();
    }
}
async function fetchClip(norm, slot, foreignHost = null) {
    const { key, ext, file, metaFile } = clipStore.paths(norm);
    const tmp = `${file}.part-${process.pid}-${randomBytes(8).toString("hex")}`;   // unique: never two writers on one file
    const r = foreignHost ? await foreignFetch(norm, tmp, foreignHost, slot) : await miFetch(norm, tmp, CLIP_MAX_BYTES, slot);
    if (r.status !== 200 || !r.bytes) {
        try { unlinkSync(tmp); } catch { /* never written */ }
        if (r.status === 404) {
            if (clipMissing.size > 5000) clipMissing.clear();
            clipMissing.set(key, Date.now() + 3600_000);
        }
        if (r.status === 413) throw Object.assign(new Error(`That sound is bigger than this server keeps (${Math.round(CLIP_MAX_BYTES / MB * 10) / 10} MB).`), { status: 413 });
        const e = new Error(foreignHost ? (r.redirect ? "The other server redirected (not followed)" : r.error || `the other server said ${r.status || "nothing"}`)
            : r.status === 403 ? "myinstants is blocking us right now" : `upstream ${r.status || "error"}`);
        e.upstream = r.status;
        throw e;
    }
    // the type comes from the bytes, never from what myinstants said (round 3): anything that isn't audio is dropped
    const kind = sniffClipAudio(readHead(tmp, 64));
    if (!kind) {
        try { unlinkSync(tmp); } catch { /* gone */ }
        const said = (r.content_type || "").split(";")[0].trim();
        throw Object.assign(new Error(`not audio (${foreignHost ? "the other server" : "myinstants"} said ${said.slice(0, 40) || "nothing"})`), { status: 415 });
    }
    const ct = kind.type;
    writeFileSync(metaFile, JSON.stringify({ url: norm, content_type: ct, bytes: r.bytes, fetched_at: new Date().toISOString() }));
    renameSync(tmp, file);
    clipStore.add(key, file, metaFile, r.bytes);
    return { file, contentType: ct };
}
/** The first `n` bytes of a file (fewer if it is shorter). */
function readHead(path, n) {
    const fd = openSync(path, "r");
    try { const b = Buffer.alloc(n); return b.subarray(0, readSync(fd, b, 0, n, 0)); } finally { closeSync(fd); }
}
/**
 * Who pays for a new clip download from myinstants, decided before anything is charged: {why, charge()} where charge()
 * spends the budget and returns null or a refusal; or null when an answer was already sent (a bad token, 401 with the
 * token-less lane off). Every real download is charged (security review, second round): a member's bearer -> their
 * budget; a signed link -> the budget of whoever asked for it (its principal); a clip one of our search answers handed
 * out -> that address's (and everybody's) budget for those; anything else -> the token-less allowance.
 */
async function clipPayer(req, res, norm, foreign = false) {
    if (/^Bearer\s+\S/i.test(String(req.headers.authorization || ""))) {
        if (!(await access.resolve(req, res))) return null;
        const principal = clipSigner.principalOf(req.matrixUser);
        return { why: "member", charge: () => access.spendAs("clipfetch", principal) };
    }
    const p = typeof req.query.p === "string" ? req.query.p : "";
    if (req.query.sig !== undefined && clipSigner.verify(norm, req.query.exp, String(req.query.sig), p))
        return { why: "signed", charge: () => access.spendAs("clipfetch", p) };
    // another Tin Hat server's sound: a member's bearer or a member-signed link only, never the token-less lane (no
    // app that sends no token sends such a link; second review, #4)
    if (foreign) { res.status(401).json(SIGNIN_REQUIRED); return null; }
    if (admitted.has(norm)) return { why: "searched", charge: () => access.spendSearched(ipBucket(req.ip)) };
    if (!access.config.legacy) { res.status(401).json(SIGNIN_REQUIRED); return null; }
    return { why: "legacy", charge: () => access.spend(req, "clipfetch") };   // req.matrixUser unset: the shared allowance
}
async function serveClip(req, res) {
    // ?id= is a user upload, ?url= the myinstants cache: ONE route for both so the app
    // has a single clip-URL shape whatever the source (uploads section below).
    if (req.query.id !== undefined) return serveUpload(req, res);
    const url = req.query.url;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url parameter" });
    // myinstants, or another Tin Hat server's sound link (foreign.mjs: fetched through this server, never by the apps)
    let norm = normaliseClipUrl(url), foreign = null;
    if (!norm) {
        foreign = parseForeignClipUrl(url, ownHosts());
        if (foreign.error) return res.status(403).json(foreign.reason === "own" ? { error: foreign.error, reason: "own-server" }
            : { error: "Only myinstants.com sounds and other Tin Hat servers' sound links are allowed", reason: "not-allowed" });
        norm = foreign.url;
    }
    try {
        let got = clipStore.get(norm);
        if (!got) {
            const { key } = clipStore.paths(norm);
            // who pays is settled first (it may await the sign-in check); oneDownload then looks again, joins a running
            // download or registers at most one, and charges only a request that really starts one. A request that
            // joins needs no payer: from the has() below to oneDownload's registering nothing awaits.
            let payer = null;
            if (!clipInflight.has(key)) {
                if ((clipMissing.get(key) || 0) > Date.now()) return res.status(404).json({ error: "That sound isn't there any more" });
                payer = await clipPayer(req, res, norm, !!foreign);
                if (!payer) return;   // answered (a bad token; no token with the token-less lane off or for a foreign link)
            }
            let slot = null;
            const r = await oneDownload(clipInflight, key, {
                cached: () => clipStore.get(norm),
                gate: () => {
                    if (!payer) return { status: 401, body: SIGNIN_REQUIRED };   // joined nothing, has no payer
                    // the caller's address (strict tier), then a helper slot, then the budget: nothing spent on a refusal
                    if (!limits.upstreamFetch(ipBucket(req.ip))) return { status: 429, retryAfter: 5, body: { error: "Too many requests" } };
                    slot = reserveHelper();
                    if (!slot) return { status: 503, retryAfter: 2, body: { error: "The server is busy fetching sounds; try again in a moment." } };
                    const no = payer.charge();
                    if (no) { slot.release(); slot = null; return no; }
                    return null;
                },
                start: () => {
                    // a foreign link's name is resolved inside the download (admitted, de-duplicated, charged, one deadline)
                    const p = fetchClip(norm, slot, foreign ? foreign.host : null);
                    p.then(() => console.log(`[soundboard] cached clip ${key.slice(0, 12)} (${payer.why}) ${norm}`), () => {});
                    return p;
                },
            });
            if (r.refused) return access.refuse(res, r.refused);
            got = r.got;
        }
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.sendFile(got.file, { headers: { "Content-Type": got.contentType, "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox" }, acceptRanges: true, lastModified: false },
            (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (err) {
        if (err.status === 429) return tooMany(res);
        if (err.status === 413 || err.status === 415) return res.status(err.status).json({ error: err.message });
        if (err.status === 403) return res.status(403).json(err.reason ? { error: err.message, reason: err.reason } : { error: err.message });
        console.warn(`[soundboard] clip fetch failed: ${err.message} ${norm}`);
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
/** This server's own names: a sound link on one of them is refused as foreign (the apps play those directly). */
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const OWN_HOSTS = [...new Set([process.env.SERVER_NAME, hostOf(CLIP_PUBLIC_BASE), hostOf(HS_PUBLIC), hostOf(WEB_BASE),
    hostOf(VODS_PUBLIC_BASE)].filter(Boolean).map((h) => h.toLowerCase()))];
function ownHosts() { return OWN_HOSTS; }
// Per person and in all (security review 2026-10-26: uploads had no quota): SOUNDBOARD_USER_UPLOADS_MAX clips and
// SOUNDBOARD_USER_UPLOADS_MB each, SOUNDBOARD_UPLOADS_TOTAL_MB for everybody together.
const UPLOAD_USER_MAX = Math.floor(envNum("SOUNDBOARD_USER_UPLOADS_MAX", 200));
const UPLOAD_USER_BYTES = Math.floor(envNum("SOUNDBOARD_USER_UPLOADS_MB", 100, 0, 1_048_576) * MB);
const UPLOAD_TOTAL_BYTES = Math.floor(envNum("SOUNDBOARD_UPLOADS_TOTAL_MB", 2048, 0, 1_048_576) * MB);
/** {count, bytes} of `user`'s clips and the bytes of everybody's (a few hundred sidecars at most, read off disk). */
function uploadUsage(user) {
    const u = { count: 0, bytes: 0, total: 0 };
    try {
        for (const f of readdirSync(UPLOAD_DIR)) {
            if (!f.endsWith(".json") || !UPLOAD_ID_RE.test(f.slice(0, -5))) continue;
            const meta = readUploadMeta(f.slice(0, -5));
            if (!meta) continue;
            const b = Number(meta.bytes) || 0;
            u.total += b;
            if (meta.uploader === user) { u.count++; u.bytes += b; }
        }
    } catch { /* none yet */ }
    return u;
}
// Signed clip links (/clip/sign): a member's app asks for one right before it plays a myinstants sound this server may
// not have yet through a player that can't send a header (<audio>, GStreamer). An hour each; keyed off the vods secret.
clipSigner = createClipSigner({ key: createHmac("sha256", VODS_SECRET).update("tinhat-clip-links").digest(),
    ttlMs: Math.max(60_000, Math.floor(envNum("SOUNDBOARD_CLIP_LINK_MIN", 60, 1, 10_080) * 60_000)) });
/** GET /clip/sign?url=<myinstants url>  (bearer) -> {url, exp}: a link /clip fetches for anyone until exp (ms). */
app.get("/clip/sign", access.member, (req, res) => {
    const raw = String(req.query.url || "");
    let norm = normaliseClipUrl(raw);
    if (!norm) {
        const f = parseForeignClipUrl(raw, ownHosts());
        if (f.error) return res.status(403).json(f.reason === "own" ? { error: f.error, reason: "own-server" }
            : { error: "Only myinstants.com sounds and other Tin Hat servers' sound links are allowed", reason: "not-allowed" });
        norm = f.url;
    }
    const no = access.spend(req, "clipsign");
    if (no) return access.refuse(res, no);
    const principal = clipSigner.principalOf(req.matrixUser);   // the downloads this link causes are charged to the signer
    const { exp, sig } = clipSigner.sign(norm, principal);
    res.setHeader("Cache-Control", "no-store");
    res.json({ url: `${CLIP_PUBLIC_BASE}/clip?url=${encodeURIComponent(norm)}&p=${principal}&exp=${exp}&sig=${sig}`, exp });
});

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
            const use = uploadUsage(req.matrixUser);
            if (use.count >= UPLOAD_USER_MAX || use.bytes + f.data.length > UPLOAD_USER_BYTES)
                return res.status(507).json({ error: "You have a lot of sounds on this server already. Delete some of yours first." });
            if (use.total + f.data.length > UPLOAD_TOTAL_BYTES)
                return res.status(507).json({ error: "This server's room for sounds is full; its owner can make more." });
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
// Security review 2026-10-26: Giphy calls are spent by members (their hourly budget) or the small shared allowance
// for apps that send no token (access.mjs); answers are cached (trending 10 min, a search 30 min), so the owner's key
// is asked once per query, not once per keystroke of everyone.
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

const gifCache = new Map(); // key -> {at, ttl, data}
async function giphyList(req, res, endpoint, params, cacheKey, ttl) {
    if (!GIPHY_KEY) return res.status(503).json({ error: "GIF search not configured" });
    const hit = gifCache.get(cacheKey);
    if (hit && Date.now() - hit.at < hit.ttl) return res.json(hit.data);
    const no = access.spend(req, "gif");
    if (no) return access.refuse(res, no);
    try {
        const url =
            `https://api.giphy.com/v1/gifs/${endpoint}?api_key=${GIPHY_KEY}` +
            `${params ? `&${params}` : ""}&limit=24&rating=pg-13&bundle=messaging_non_clips`;
        const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return res.status(502).json({ error: `giphy ${r.status}` });
        const json = JSON.parse((await readCapped(r, 4 * MB)).toString("utf8"));
        const data = (json.data || []).map(mapGif).filter((g) => g.url && g.preview);
        if (gifCache.size > 1000) gifCache.clear();
        gifCache.set(cacheKey, { at: Date.now(), ttl, data });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: String(err.message || "GIF request failed").split(GIPHY_KEY || "\u0000").join("<key>") });
    }
}

app.get("/gif/search", access.memberOrLegacy, (req, res) => {
    const q = req.query.q;
    if (!q || typeof q !== "string") return res.status(400).json({ error: "Missing q parameter" });
    const t = q.trim().replace(/\s+/g, " ");
    if (!t) return res.status(400).json({ error: "Missing q parameter" });
    if (t.length > 100) return res.status(400).json({ error: "q too long" });
    void giphyList(req, res, "search", `q=${encodeURIComponent(t)}`, `s:${t.toLowerCase()}`, 30 * 60_000);
});

app.get("/gif/trending", access.memberOrLegacy, (req, res) => {
    void giphyList(req, res, "trending", "", "trending", 10 * 60_000);
});

// Proxy GIF bytes (CORS-safe) so the client can re-upload to the homeserver. M5 (security review 2026-10-26): Giphy's
// media hosts only, no redirects, at most GIF_FETCH_MAX_MB (8), and only bytes that ARE an image or an mp4 (sniffed),
// served with nosniff + the sandbox CSP /clip uses — so nothing Giphy answers can run on this origin.
const GIF_FETCH_MAX = Math.max(256 * 1024, Math.floor(envNum("GIF_FETCH_MAX_MB", 8, 1, 100) * MB));
app.get("/gif/fetch", access.memberOrLegacy, async (req, res) => {
    const url = req.query.url;
    if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url parameter" });
    const target = giphyMediaUrl(url);
    if (!target) return res.status(403).json({ error: "Only Giphy media URLs allowed" });
    const no = access.spend(req, "gif");
    if (no) return access.refuse(res, no);
    try {
        const r = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!r.ok) { try { await r.body?.cancel(); } catch { /* gone */ } return res.status(502).json({ error: `Fetch failed: ${r.status}` }); }
        const buf = await readCapped(r, GIF_FETCH_MAX);
        const type = sniffImage(buf);
        if (!type) return res.status(415).json({ error: "Not an image" });
        res.set({ ...MEDIA_HEADERS, "Content-Type": type });
        res.send(buf);
    } catch (err) {
        if (err.status === 413) return res.status(413).json({ error: "That GIF is too big" });
        res.status(502).json({ error: "Fetch failed" });
    }
});

// Media Party (Tin Hat 11.4, 2026-10-11).
// Every /youtube/* route lives in watch.mjs: search (the OLD array shape stays for 11.2.1 clients; v=2 = the new shape +
// type=video|music|playlist|channel), suggest, trending, playlist, channel, meta (Spotify / Apple Music / YouTube Music
// links), resolve (song -> its YouTube upload), budget. SQLite cache + Data API units per Pacific day in
// WATCH_DATA_DIR/watch.db (default: the watch folder next to the config). Caddy maps /api/watch/* here.
// Security review 2026-10-26 (H4): members spend YouTube units from their own daily budget, apps that send no token
// from a small shared one (access.mjs), so strangers can't empty the owner's quota.
installWatch(app, {
    youtubeKey: YOUTUBE_KEY, dataDir: process.env.WATCH_DATA_DIR || join(CONF, "watch"),
    guard: access.memberOrLegacy,
    userUnitsPerDay: access.config.watchUserUnitsPerDay, anonUnitsPerDay: access.config.watchAnonUnitsPerDay,
    anonAllUnitsPerDay: access.config.watchAnonAllUnitsPerDay,
});

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
// On a Tin Hat Server (TINHAT_BOX=1) the manager owns invites (Caddy sends /api/admin/* there), so this second
// privileged route is not mounted at all (security review 2026-10-26: it was still reachable as
// /api/soundboard/admin/invites).
if (process.env.TINHAT_BOX === "1") {
    console.log("[invites] Tin Hat Server: invite codes are the manager's (/api/admin/*); the API's own route is off");
} else {
    let INVITE_OPERATORS = new Set();
    try { INVITE_OPERATORS = new Set(JSON.parse(readFileSync(join(CONF, "invite-operators.json"), "utf8"))); }
    catch { console.error("[invites] invite-operators.json missing/invalid -> Synapse admins only"); }
    installInvites(app, { requireMatrixUser, synapse, adminToken: ADMIN_TOKEN, operators: INVITE_OPERATORS, serverName: process.env.SERVER_NAME || "" });
}

// Reach (Tin Hat 10.6, 2026-09-25; contract REACH.md in both app repos): opt-in presence + web push. Talks only to
// the pinned internal Synapse. The push GATEWAY runs on its own listener (PUSH_GATEWAY_HOST:PUSH_GATEWAY_PORT; never
// this app, whose routes /api/soundboard/ exposes wholesale), reachable by Synapse only (on a Tin Hat Server: the box's
// address on the compose network, the one private address Synapse's ip_range_whitelist allows).
// reachHs / reachAuth: created next to HS_INTERNAL above (pinned at start, REACH A2.4).
installPresence(app, { auth: reachAuth, hs: reachHs, adminToken: ADMIN_TOKEN, serverName: process.env.SERVER_NAME || "" });
installPush(app, {
    auth: reachAuth, hs: reachHs, adminToken: ADMIN_TOKEN, dir: CONF,
    gatewayListen: { host: process.env.PUSH_GATEWAY_HOST || "127.0.0.1", port: Number(process.env.PUSH_GATEWAY_PORT || 3091) },
    gatewayUrl: required("PUSH_GATEWAY_URL"), subject: required("PUSH_SUBJECT"),
    relay: process.env.PUSH_RELAY || null, // the Tin Hat phone apps' relay (docs/PHONE-PUSH.md); unset = phones refused
    // DM ringing (ring.mjs): only local callees ring; never a guest on either side
    serverName: process.env.SERVER_NAME || new URL(HS_PUBLIC).hostname,
    isGuest: (mxid) => guestAccounts.some((a) => a.user === mxid) || /^@guest-/i.test(mxid),
});
// Where Synapse's tinhat_calls module pokes us about call membership changes: the gateway's own listener (ring.mjs).
publish("call-hook.json", { url: new URL(RING.HOOK_PATH, new URL(required("PUSH_GATEWAY_URL")).origin).href });

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
        endCalls: endGuestCalls,
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

// Call sign-ins (security review 2026-10-26, calls round M1b; docs/API.md "Call sign-ins"): Caddy sends every
// /livekit/jwt request but lk-jwt's health check here, and a token is minted only for a Matrix room the caller is
// joined in. CALL_TOKEN_ROOM_CHECK=off (the owner's switch) hands everything to lk-jwt unchanged.
installCallToken(app, {
    hs: reachHs, adminToken: ADMIN_TOKEN, serverName: process.env.SERVER_NAME || new URL(HS_PUBLIC).hostname,
    lkJwtUrl: (process.env.LK_JWT_URL || "http://127.0.0.1:8070").replace(/\/+$/, ""),
    enabled: () => String(process.env.CALL_TOKEN_ROOM_CHECK || "on").trim().toLowerCase() !== "off",
});

app.listen(PORT, "127.0.0.1", () => {
    console.log(`Tin Hat API listening on 127.0.0.1:${PORT} (conf ${CONF})`);
});
