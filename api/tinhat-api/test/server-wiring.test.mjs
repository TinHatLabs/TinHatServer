// server.mjs wiring, end to end (review of 116d103, "test gaps"): the real service with express, a fake Synapse, a
// stub myinstants helper and stubbed Giphy / YouTube, nothing on the network. It covers the guard order, the
// per-caller token-less allowance, the GIF cache, the Media Party guard, the clip path (one download per clip,
// audio only, nothing charged for a busy refusal, signed links charged to the signer, search admission), the
// invites route being off on a Tin Hat Server and Memories range requests with their sandbox headers.
// Needs express next to the service (`npm ci` in api/tinhat-api); skipped without it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, symlinkSync, rmSync, existsSync, openSync, truncateSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
let expressDir = null;
try { expressDir = dirname(createRequire(join(SRC, "server.mjs")).resolve("express/package.json")); } catch { /* not installed */ }
const skip = expressDir ? false : "express isn't installed next to the service (npm ci in api/tinhat-api)";

const free = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const M = "https://www.myinstants.com/media/sounds";
const VODS_SECRET = "vods-secret-for-the-wiring-test";
let T, api, hs, base, log;

const STUB = String.raw`import json, os, sys, time
url, out = sys.argv[1], sys.argv[2]
with open(os.environ["STUB_LOG"], "a") as f: f.write("mi " + url + "\n")
if "/search/" in url:
    open(out, "w").write("<button onclick=\"play('/media/sounds/found-one.mp3', 'x')\" title=\"Play Found one sound\"></button>")
    print(json.dumps({"status": 200, "content_type": "text/html", "bytes": 100})); sys.exit()
if "slow" in url or "same" in url:
    time.sleep(1.2)
body = b"<!doctype html><script>alert(1)</script>" + b" " * 100 if "page.mp3" in url else b"\xff\xf1\x50\x80" + b"\0" * 300
open(out, "wb").write(body)
print(json.dumps({"status": 200, "content_type": "audio/mpeg", "bytes": len(body)}))
`;
const PRELOAD = `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://api.giphy.com/")) {
        appendFileSync(process.env.STUB_LOG, "giphy\\n");
        return json({ data: [{ id: "g1", title: "t", images: { downsized: { url: "https://media.giphy.com/media/g1/giphy.gif", width: "1", height: "1" },
            fixed_width_small: { url: "https://media.giphy.com/media/g1/100w.gif" } } }] });
    }
    if (u.startsWith("https://www.googleapis.com/youtube/v3/search")) {
        appendFileSync(process.env.STUB_LOG, "yt-search\\n");
        return json({ items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "T", channelTitle: "C", thumbnails: {} } }] });
    }
    if (u.startsWith("https://www.googleapis.com/youtube/v3/videos")) return json({ items: [{ id: "abcdefghijk", contentDetails: { duration: "PT3M" } }] });
    return real(url, init);
};
`;

before(async () => {
    if (skip) return;
    T = mkdtempSync(join(tmpdir(), "wiring-"));
    const app = join(T, "app"), conf = join(T, "conf");
    mkdirSync(app); mkdirSync(conf); mkdirSync(join(T, "vods", "room1", "s1"), { recursive: true });
    for (const f of readdirSync(SRC)) if (f.endsWith(".mjs")) copyFileSync(join(SRC, f), join(app, f));
    writeFileSync(join(app, "mi-fetch.py"), STUB);
    symlinkSync(dirname(expressDir), join(app, "node_modules"));
    writeFileSync(join(T, "preload.mjs"), PRELOAD);
    writeFileSync(join(T, "vods", "room1", "s1", "track.mka"), Buffer.alloc(100_000, 7));
    writeFileSync(join(conf, "vods.secret"), VODS_SECRET);
    log = join(T, "stub.log");
    writeFileSync(log, "");
    hs = createServer((req, res) => {
        const who = { "Bearer good": "@alice:example.org", "Bearer good2": "@bob:example.org", "Bearer guest": "@guest-1:example.org",
            "Bearer good3": "@carol:example.org", "Bearer good4": "@dave:example.org" }[req.headers.authorization];
        res.writeHead(req.url === "/_matrix/client/v3/account/whoami" && who ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(who ? { user_id: who, device_id: "D" } : { errcode: "M_UNKNOWN_TOKEN" }));
    });
    await new Promise((r) => hs.listen(0, "127.0.0.1", r));
    const port = await free(), gw = await free();
    base = `http://127.0.0.1:${port}`;
    api = spawn(process.execPath, ["--import", pathToFileURL(join(T, "preload.mjs")).href, "server.mjs"], {
        cwd: app, stdio: ["ignore", "ignore", openSync(join(T, "api.log"), "w")],
        env: {
            PATH: process.env.PATH, STUB_LOG: log, PORT: String(port), API_CONF_DIR: conf, TINHAT_BOX: "1",
            SYNAPSE_INTERNAL: `http://127.0.0.1:${hs.address().port}`, SYNAPSE_PUBLIC: "https://example.org", WEB_BASE: "https://example.org",
            SOUNDBOARD_PUBLIC_BASE: "https://example.org/api/soundboard", VODS_PUBLIC_BASE: "https://example.org/api/vods",
            VODS_DIR: join(T, "vods"), LK_API_URL: "http://127.0.0.1:9", PUSH_GATEWAY_HOST: "127.0.0.1",
            PUSH_GATEWAY_PORT: String(gw), PUSH_GATEWAY_URL: `http://127.0.0.1:${gw}/x`, PUSH_SUBJECT: "https://example.org",
            GIPHY_API_KEY: "k", YOUTUBE_API_KEY: "k",
            API_ANON_GIF_PER_HOUR: "2", API_ANON_GIF_ALL_PER_HOUR: "50", API_ANON_CLIPFETCH_PER_HOUR: "2",
            API_ANON_CLIPFETCH_ALL_PER_HOUR: "50", API_USER_CLIPFETCH_PER_HOUR: "3", WATCH_ANON_UNITS_PER_DAY: "101",
            WATCH_ANON_ALL_UNITS_PER_DAY: "1000",
        },
    });
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the API didn't start: ${readFileSync(join(T, "api.log"), "utf8").slice(-800)}`);
});

after(() => {
    if (api) api.kill();
    if (hs) hs.close();
    if (T) rmSync(T, { recursive: true, force: true });
});

const get = (path, { from = "203.0.113.1", token, headers = {} } = {}) => fetch(`${base}${path}`, {
    headers: { "x-forwarded-for": from, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const calls = (what) => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith(what)).length;
const clip = (name) => `/clip?url=${encodeURIComponent(`${M}/${name}`)}`;

test("GIFs: a bad token is 401, never the token-less lane; answers are cached; each address has its own allowance", { skip }, async () => {
    assert.equal((await get("/gif/trending", { token: "nope", from: "192.0.2.10" })).status, 401);
    assert.equal((await get("/gif/search?q=cats", { from: "192.0.2.10" })).status, 200);
    assert.equal((await get("/gif/search?q=cats", { from: "192.0.2.10" })).status, 200);
    assert.equal(calls("giphy"), 1, "the second was cached");
    assert.equal((await get("/gif/search?q=dogs", { from: "192.0.2.10" })).status, 200);
    const spent = await get("/gif/search?q=birds", { from: "192.0.2.10" });
    assert.equal(spent.status, 401);
    assert.equal((await spent.json()).signin, true);
    assert.equal((await get("/gif/search?q=birds", { from: "192.0.2.11" })).status, 200, "another address isn't drained");
    assert.equal((await get("/gif/search?q=fish", { from: "192.0.2.10", token: "good" })).status, 200, "a member spends their own");
});

test("Media Party: the guard runs first; YouTube units per token-less address", { skip }, async () => {
    assert.equal((await get("/youtube/search?q=hello&v=2", { token: "nope", from: "192.0.2.20" })).status, 401);
    assert.equal((await get("/youtube/search?q=first&v=2", { from: "192.0.2.20" })).status, 200);
    assert.equal((await get("/youtube/search?q=second&v=2", { from: "192.0.2.20" })).status, 401, "101 units: spent");
    assert.equal((await get("/youtube/search?q=second&v=2", { from: "192.0.2.21" })).status, 200);
    assert.equal(calls("yt-search"), 2);
});

test("Media Party: WATCH_ANON_ALL_UNITS_PER_DAY reaches watch.mjs (the ceiling for every token-less caller together)", { skip }, async () => {
    // 1000 units for everybody, 101 a search: whatever earlier tests spent, a fresh address is refused before the 10th
    let ok = 0, refused = null;
    for (let i = 0; i < 20 && refused === null; i++) {
        const r = await get(`/youtube/search?q=ceiling-${i}&v=2`, { from: `198.51.100.${120 + i}` });
        if (r.status === 200) ok++;
        else refused = r.status;
    }
    assert.equal(refused, 401, "the ceiling was reached");
    assert.ok(ok <= 9, `at most 9 searches fit in 1000 units (got ${ok}); the default ceiling (4000) would allow 39`);
    assert.equal((await get("/youtube/search?q=ceiling-member&v=2", { from: "198.51.100.200", token: "good" })).status, 200, "members have their own");
});

test("clips: one download for concurrent requests; only audio is ever cached", { skip }, async () => {
    const [a, b] = await Promise.all([get(clip("same.mp3"), { token: "good", from: "198.51.100.1" }), get(clip("same.mp3"), { token: "good", from: "198.51.100.1" })]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(a.headers.get("content-type"), "audio/aac", "typed from the bytes");
    assert.equal(calls(`mi ${M}/same.mp3`), 1);
    const html = await get(clip("page.mp3"), { token: "good", from: "198.51.100.1" });
    assert.equal(html.status, 415);
    assert.equal(readdirSync(join(T, "conf", "cache")).filter((f) => f.endsWith(".json")).length, 1, "only same.mp3 is cached");
});

test("clips: a request turned away for busy helpers spends nothing", { skip }, async () => {
    const froms = ["198.51.100.11", "198.51.100.12", "198.51.100.13", "198.51.100.14", "198.51.100.15"];
    const got = await Promise.all(froms.map((from, i) => get(clip(`slow${i}.mp3`), { from })));
    const codes = got.map((r) => r.status);
    assert.deepEqual([...codes].sort(), [200, 200, 200, 200, 503]);
    const busy = froms[codes.indexOf(503)];
    assert.equal((await get(clip("slow-again.mp3"), { from: busy })).status, 200, "its allowance (2) was still whole:");
    assert.equal((await get(clip("slow-again2.mp3"), { from: busy })).status, 200, "both of them");
    assert.equal((await get(clip("slow-again3.mp3"), { from: busy })).status, 401);
});

test("clips: signed links are charged to the signer and bound to the clip; search results play without a token", { skip }, async () => {
    const from = "198.51.100.30";
    for (const n of ["x1.mp3", "x2.mp3"]) assert.equal((await get(clip(n), { from })).status, 200);
    assert.equal((await get(clip("x3.mp3"), { from })).status, 401, "this address's token-less allowance (2) is spent");
    assert.equal((await get(`/clip/sign?url=${encodeURIComponent(`${M}/signed.mp3`)}`, { from })).status, 401, "signing needs a member");
    const { url } = await (await get(`/clip/sign?url=${encodeURIComponent(`${M}/signed.mp3`)}`, { token: "good2", from })).json();
    const q = new URL(url).search;
    assert.equal((await get(`/clip${q}`, { from })).status, 200, "the signer pays, not the address");
    assert.equal((await get(`/clip${q.replace("signed.mp3", "other.mp3")}`, { from })).status, 401, "bound to its clip");
    assert.equal((await get("/search?q=found", { from })).status, 200);
    assert.equal((await get(`/clip?url=${encodeURIComponent("/media/sounds/found-one.mp3")}`, { from })).status, 200,
        "a clip our own search handed out has its own budget");
});

test("the API's invite route is off on a Tin Hat Server; Memories ranges keep streaming, sandboxed", { skip }, async () => {
    assert.equal((await get("/admin/invites", { token: "good" })).status, 404);
    const p = "room1/s1/track.mka", exp = Date.now() + 3600_000;
    const sig = createHmac("sha256", VODS_SECRET).update(`${p}\0${exp}`).digest("hex").slice(0, 32);
    const r = await get(`/vods/file/${p}?exp=${exp}&sig=${sig}`, { headers: { range: "bytes=10-19" } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), "bytes 10-19/100000");
    assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await get(`/vods/file/${p}?exp=${exp}&sig=${"0".repeat(32)}`)).status, 403);
    assert.ok(existsSync(join(T, "conf")));
});

test("other Tin Hat servers' sound links: the shapes the apps get back (no network here: the fetch itself is foreign.test)", { skip }, async () => {
    const own = await get(`/clip?url=${encodeURIComponent(`https://example.org/api/soundboard/clip?id=${"a".repeat(64)}`)}`, { token: "good", from: "198.51.100.40" });
    assert.equal(own.status, 403);
    assert.equal((await own.json()).reason, "own-server", "this server's own sound: the apps play it directly");
    const bad = await get(`/clip?url=${encodeURIComponent("https://peer.example/api/soundboard/file/%2e%2e")}`, { token: "good", from: "198.51.100.40" });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).reason, "not-allowed");
    const foreign = `https://peer.example/api/soundboard/clip?id=${"b".repeat(64)}`;
    const signed = await get(`/clip/sign?url=${encodeURIComponent(foreign)}`, { token: "good2", from: "198.51.100.40" });
    assert.equal(signed.status, 200);
    assert.equal(new URL((await signed.json()).url).searchParams.get("url"), foreign, "signed for players that can't send a header");
    const unknown = await get(`/clip?url=${encodeURIComponent("https://no-such-name.invalid/api/soundboard/file/x.mp3")}`, { token: "good", from: "198.51.100.41" });
    assert.equal(unknown.status, 502, "a name that doesn't resolve");
});

test("the caller is the address Caddy wrote last: a spoofed entry to its left keys nothing (second review, #5)", { skip }, async () => {
    // the strict tier (30/min per address) is keyed on req.ip: spend it with a spoofed loopback entry in front ...
    for (let i = 0; i < 30; i++) assert.equal((await get(`/no-such-route-${i}`, { from: "127.0.0.1, 203.0.113.70" })).status, 404);
    // ... and the plain address is the same caller
    assert.equal((await get("/no-such-route", { from: "203.0.113.70" })).status, 429, "the same bucket as 203.0.113.70");
    // only the last entry counts: express's own "loopback" would have walked past this 127.0.0.1 to 203.0.113.70
    assert.equal((await get("/no-such-route", { from: "203.0.113.70, 127.0.0.1" })).status, 404, "keyed as 127.0.0.1, not 203.0.113.70");
    assert.equal((await get("/no-such-route", { from: "203.0.113.71" })).status, 404, "a neighbour isn't drained");
});

test("other Tin Hat servers' sounds are for members only: no token = 401 before any lookup, even with the token-less lane on", { skip }, async () => {
    // .invalid never resolves: 502 would mean the request got as far as the lookup; 401 means it was refused first
    const link = `https://no-such-name.invalid/api/soundboard/clip?id=${"c".repeat(64)}`;
    for (const from of ["198.51.100.50", "198.51.100.51"]) {
        const r = await get(`/clip?url=${encodeURIComponent(link)}`, { from });
        assert.equal(r.status, 401, "the legacy lane never pays for another server's sound");
        assert.equal((await r.json()).signin, true, "the apps' sign-in answer (SIGNIN_REQUIRED)");
    }
    const forged = await get(`/clip?url=${encodeURIComponent(link)}&p=x&exp=${Date.now() + 600_000}&sig=${"0".repeat(64)}`, { from: "198.51.100.52" });
    assert.equal(forged.status, 401, "a link with a signature that doesn't verify is no member's link");
    const bad = await get(`/clip?url=${encodeURIComponent(link)}`, { token: "nope", from: "198.51.100.53" });
    assert.equal(bad.status, 401, "a bad token is refused, never treated as token-less");
    // a member-signed link works without a header (players that can't send one): it reaches the lookup -> 502 here
    const signed = await get(`/clip/sign?url=${encodeURIComponent(link)}`, { token: "good2", from: "198.51.100.54" });
    assert.equal(signed.status, 200);
    const q = new URL((await signed.json()).url).search;
    assert.equal((await get(`/clip${q}`, { from: "198.51.100.55" })).status, 502, "a member-signed link is let through (then the name fails)");
});

const postReport = (body, token = "good3") => fetch(`${base}/reports`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": "198.51.100.200" },
    body: JSON.stringify(body) });
const ABUSE = { kind: "abuse", type: "abuse", title: "[report] Harassment or hate: @bad:example.org", category: "harassment",
    details: "kept calling names", reported_user: "@bad:example.org", room_id: "!r:example.org", event_id: "$e1",
    reporter: "@someone-else:example.org", platform: "web (Chrome on Linux)", version: "12.0.3", extra: "x".repeat(5000) };

test("abuse reports (docs/ACCOUNT-SAFETY.md): stored cut down to their fields, the reporter is the signed-in sender", { skip }, async () => {
    const r = await postReport(ABUSE);
    assert.equal(r.status, 200);
    const { id } = await r.json();
    assert.match(id, /-abuse$/, "named so the size cap leaves it out");
    const saved = JSON.parse(readFileSync(join(T, "conf", "reports", `${id}.json`), "utf8"));
    assert.equal(saved.user, "@carol:example.org");
    assert.deepEqual(saved.report, { kind: "abuse", type: "abuse", title: ABUSE.title, category: "harassment",
        details: "kept calling names", reporter: "@carol:example.org", platform: ABUSE.platform, version: "12.0.3",
        reported_user: "@bad:example.org", room_id: "!r:example.org", event_id: "$e1" });
    assert.equal((await postReport({ ...ABUSE, reported_user: "bad" })).status, 400);
    assert.equal((await postReport({ ...ABUSE, room_id: undefined })).status, 400, "a message needs its room");
    assert.equal((await postReport({ kind: "abuse" })).status, 400, "who or what");
    assert.equal((await postReport(ABUSE, "guest")).status, 403, "guests report through Matrix");
    assert.equal((await postReport({ ...ABUSE, details: "x".repeat(20_000) })).status, 413, "an abuse report is small");
});

test("abuse reports have their own total bound (20 MB): full -> 507 until the owner clears some", { skip }, async () => {
    const dir = join(T, "conf", "reports");
    mkdirSync(dir, { recursive: true });
    const filler = join(dir, "0000-filler-abuse.json");
    writeFileSync(filler, "");
    truncateSync(filler, 20 * 1024 * 1024 - 100);  // sparse: counts by size, takes no disk
    const r = await postReport(ABUSE);
    assert.equal(r.status, 507, "no room left for another abuse report");
    assert.match((await r.json()).error, /owner needs to clear it/);
    rmSync(filler);
    assert.equal((await postReport(ABUSE)).status, 200, "cleared: taken again");
});

test("abuse reports have their own quota: a day of bug reports doesn't stop a report about a person", { skip }, async () => {
    const as = (body) => postReport(body, "good4");
    let bug = 0;
    for (let i = 0; i < 25; i++) if ((await as({ type: "bug", title: `b${i}` })).status === 200) bug++;
    assert.equal(bug, 20);
    assert.equal((await as({ type: "bug", title: "one more" })).status, 429);
    assert.equal((await as({ type: "bug", title: "big", pad: "x".repeat(40_000) })).status, 413, "bug quota spent: 16 KB at most");
    assert.equal((await as({ ...ABUSE, reported_user: "junk" })).status, 400, "a refused try counts too");
    let abuse = 0;
    for (let i = 0; i < 55; i++) if ((await as({ ...ABUSE, extra: undefined })).status === 200) abuse++;
    assert.equal(abuse, 49, "50 tries a day");
    assert.equal((await as(ABUSE)).status, 429);
});
