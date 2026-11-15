// api/games/background.mjs — "Match the game" chat backgrounds (lane sun-gamebg): the shared name rules (vectors,
// byte-identical with both apps), the local-only name lookup, and the background art kind's guards: https + host
// allow-list at every hop, the size cap while reading, image bytes only, the disk cache, remembered misses, one fetch
// for concurrent asks; then the real route (fetch stubbed, nothing on the network): unknown game and no art → 404.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gameKey, resolveNames, isAllowedArtUrl, sniffImage, fetchCappedArt, createBackgroundArt, BG, isPrivateAddress, ipBytes, guardedLookup, guardedFetch, backgroundSources, readCapped } from "../../games/background.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/gamebg/vectors.json"), "utf8"));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 1)]);
const HERO = "https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_hero.jpg";
const SGDB = "https://cdn2.steamgriddb.com/hero/1.png";

test("gameKey: the shared vectors", () => {
    assert.ok(V.gameKey.length >= 20);
    for (const c of V.gameKey) assert.equal(gameKey(c.in), c.out, JSON.stringify(c.in));
});

test("resolveNames: exact name or alias, local only; merged rows and non-games skipped; Steam row preferred", () => {
    const rows = [
        { id: "steam:892970", name: "Valheim", appid: 892970, type: "game" },
        { id: "custom:valheim-x1", name: "Valheim", source: "custom" },
        { id: "steam:108600", name: "Project Zomboid", appid: 108600, aliases: ["PZ"] },
        { id: "steam:999", name: "Valheim Soundtrack", appid: 999, type: "music" },
        { id: "custom:old", name: "Old Name", mergedInto: "steam:892970" },
        { id: "custom:lol", name: "League of Legends", aliases: ["LoL"] },
    ];
    const out = resolveNames(["Valheim", "Playing PZ", "valheim soundtrack", "Old Name", "lol", "Just chilling", "__proto__", "Val"], rows);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse('{"Valheim":"steam:892970","Playing PZ":"steam:108600","valheim soundtrack":null,"Old Name":null,"lol":"custom:lol","Just chilling":null,"__proto__":null,"Val":null}'));
    assert.equal(Object.getPrototypeOf(out), null, "a null-prototype map: a name like __proto__ is an ordinary key");
    const many = resolveNames(Array.from({ length: 50 }, (_, i) => `Game ${i}`), rows);
    assert.equal(Object.keys(many).length, BG.RESOLVE_MAX_NAMES, "at most 20 names answered");
    assert.deepEqual({ ...resolveNames("Valheim", rows) }, {}, "not a list → nothing");
});

test("isAllowedArtUrl: https, allow-listed host, no userinfo, default port", () => {
    assert.equal(isAllowedArtUrl(HERO), true);
    assert.equal(isAllowedArtUrl("https://cdn2.steamgriddb.com/hero/abc.png"), true);
    for (const bad of ["http://cdn.cloudflare.steamstatic.com/x.jpg", "https://evil.example/x.jpg", "https://cdn.cloudflare.steamstatic.com.evil.example/x.jpg",
        "https://user:pw@cdn.cloudflare.steamstatic.com/x.jpg", "https://cdn.cloudflare.steamstatic.com:8443/x.jpg", "file:///etc/passwd", "not a url", null]) {
        assert.equal(isAllowedArtUrl(bad), false, String(bad));
    }
});

test("isPrivateAddress: loopback, private, link-local, unique-local, CGNAT, mapped forms are refused", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
        "224.0.0.1", "192.0.2.1", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "not-an-ip"]) {
        assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "1.2.3.4", "2.2.2.2", "2606:4700::1", "::ffff:1.1.1.1", "0:0:0:0:0:ffff:101:101"]) assert.equal(isPrivateAddress(ip), false, ip);
    // review round: every SPELLING of a private address is caught (compared as bytes), plus the two missed doc ranges
    for (const ip of ["0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0", "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:ffff:10.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1",
        "0000:0000:0000:0000:0000:0000:0000:0001", "FE80::1", "fd00:0:0:0:0:0:0:1", "198.51.100.7", "203.0.113.9", "2002:7f00:1::", "::127.0.0.1", "[::1]", "fe80::1%eth0"]) {
        assert.equal(isPrivateAddress(ip), true, ip);
    }
    assert.deepEqual(ipBytes("::ffff:10.0.0.1"), ipBytes("0:0:0:0:0:ffff:a00:1"));
    assert.equal(ipBytes("1::2::3"), null);
    assert.equal(ipBytes("::12345"), null);
});

test("guardedLookup / guardedFetch: a host resolving to a private address is refused before any connection", async () => {
    const fake = (table) => (host, _o, cb) => cb(null, table[host] || []);
    const look = guardedLookup(fake({ "cdn.cloudflare.steamstatic.com": [{ address: "127.0.0.1", family: 4 }], "mixed.example": [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.5", family: 4 }], "ok.example": [{ address: "1.1.1.1", family: 4 }] }));
    const ask = (h, o = {}) => new Promise((r) => look(h, o, (err, a, f) => r({ err, a, f })));
    assert.equal((await ask("cdn.cloudflare.steamstatic.com")).err?.code, "EPRIVATE");
    assert.equal((await ask("mixed.example")).err?.code, "EPRIVATE", "any private address refuses the name");
    assert.equal((await ask("nothing.example")).err?.code, "EPRIVATE", "no address");
    assert.deepEqual(await ask("ok.example"), { err: null, a: "1.1.1.1", f: 4 });
    assert.deepEqual((await ask("ok.example", { all: true })).a, [{ address: "1.1.1.1", family: 4 }]);
    // the real fetcher with that lookup: the allow-listed name resolving to loopback never connects
    const f = guardedFetch({ lookupImpl: fake({ "cdn.cloudflare.steamstatic.com": [{ address: "127.0.0.1", family: 4 }] }) });
    await assert.rejects(f(HERO), (e) => e.code === "EPRIVATE" || /private/.test(String(e?.message)));
    assert.equal(await fetchCappedArt(HERO, { fetchImpl: f }), null, "→ no art → 404 → the preset");
    await assert.rejects(f("http://cdn.cloudflare.steamstatic.com/x.jpg"), /https only/);
});

test("backgroundSources: the 3840 hero first, then the 1920 one; SteamGridDB hero as stored; nothing off the list", () => {
    assert.deepEqual(backgroundSources({ art: { hero: HERO } }), [HERO.replace("library_hero.jpg", "library_hero_2x.jpg"), HERO]);
    assert.deepEqual(backgroundSources({ art: { hero: "https://cdn2.steamgriddb.com/hero/x.png" } }), ["https://cdn2.steamgriddb.com/hero/x.png"]);
    assert.deepEqual(backgroundSources({ art: { hero: "http://cdn2.steamgriddb.com/hero/x.png" } }), []);
    assert.deepEqual(backgroundSources({ art: {} }), []);
});

test("sniffImage: magic bytes only", () => {
    assert.equal(sniffImage(JPEG), "image/jpeg");
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])), "image/png");
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])), null, "the full 8-byte PNG signature");
    assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImage(Buffer.from("<!doctype html><svg onload=alert(1)>")), null);
    assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
});

/** A fake fetch: routes url → (opts) => Response; every call logged. */
function fakeFetch(routes) {
    const calls = [];
    const f = async (url, opts) => { calls.push({ url, opts }); const h = routes[url]; return h ? h(opts) : new Response("no", { status: 404 }); };
    f.calls = calls;
    return f;
}
/** A body stream with no Content-Length, twice the cap long (the cap must stop reading it; finite, so a missing cap
 *  fails the test instead of eating the machine's memory). Starts with JPEG magic so only the cap can refuse it. */
function endless(chunk = 64 * 1024) {
    let sent = 0;
    const s = new ReadableStream({ pull(c) {
        if (sent >= 2 * BG.MAX_BYTES) return c.close();
        const b = new Uint8Array(chunk).fill(0xff); if (sent === 0) b[3] = 0xe0;
        sent += chunk; c.enqueue(b);
    } });
    s.sent = () => sent;
    return s;
}

test("fetchCappedArt: the size cap (declared AND while reading), magic, status, redirects refused, the allow-list", async () => {
    const big = endless();
    const f = fakeFetch({
        [HERO]: () => new Response(JPEG),
        "https://cdn.cloudflare.steamstatic.com/declared.jpg": () => new Response(JPEG, { headers: { "content-length": String(BG.MAX_BYTES + 1) } }),
        "https://cdn.cloudflare.steamstatic.com/endless.jpg": () => new Response(big),
        "https://cdn.cloudflare.steamstatic.com/page.jpg": () => new Response("<html>" + "x".repeat(4000)),
        "https://cdn.cloudflare.steamstatic.com/tiny.jpg": () => new Response(JPEG.subarray(0, 100)),
        "https://cdn.cloudflare.steamstatic.com/moved.jpg": () => new Response(null, { status: 302, headers: { location: "https://shared.akamai.steamstatic.com/a/hero.jpg" } }),
        "https://shared.akamai.steamstatic.com/a/hero.jpg": () => new Response(JPEG),
        "https://cdn.cloudflare.steamstatic.com/offlist.jpg": () => new Response(null, { status: 301, headers: { location: "https://evil.example/hero.jpg" } }),
        "https://cdn.cloudflare.steamstatic.com/loop.jpg": () => new Response(null, { status: 302, headers: { location: "/loop.jpg" } }),
    });
    assert.deepEqual(await fetchCappedArt(HERO, { fetchImpl: f }), JPEG);
    assert.equal(f.calls[0].opts.redirect, "manual", "redirects are never followed blindly");
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/declared.jpg", { fetchImpl: f }), null);
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/endless.jpg", { fetchImpl: f }), null);
    assert.ok(big.sent() <= BG.MAX_BYTES + 3 * 64 * 1024, `stopped reading near the cap (read ${big.sent()})`);
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/page.jpg", { fetchImpl: f }), null, "not an image");
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/tiny.jpg", { fetchImpl: f }), null, "too small to be art");
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/missing.jpg", { fetchImpl: f }), null, "404");
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/moved.jpg", { fetchImpl: f }), null, "a redirect is refused, even inside the list");
    assert.equal(f.calls.filter((c) => c.url.includes("akamai")).length, 0, "its target is never asked");
    const before = f.calls.length;
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/offlist.jpg", { fetchImpl: f }), null);
    assert.equal(f.calls.length, before + 1, "the off-list host is never asked");
    assert.equal(await fetchCappedArt("https://cdn.cloudflare.steamstatic.com/loop.jpg", { fetchImpl: f }), null, "redirect budget");
    assert.equal(await fetchCappedArt("https://evil.example/x.jpg", { fetchImpl: f }), null);
    assert.equal(await fetchCappedArt("http://cdn.cloudflare.steamstatic.com/x.jpg", { fetchImpl: f }), null);
});

test("createBackgroundArt: disk cache, remembered misses, one fetch for concurrent asks, manual wins, no hero = no fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gamebg-"));
    try {
        let t = 1_000_000;
        const f = fakeFetch({ [SGDB]: () => new Response(JPEG) });
        const bg = createBackgroundArt({ dir, fetchImpl: f, now: () => t });
        const valheim = { id: "steam:1", art: { hero: SGDB } };
        const [a, b, c] = await Promise.all([bg.get(valheim), bg.get(valheim), bg.get(valheim)]);
        assert.ok(a && a === b && b === c);
        assert.equal(f.calls.length, 1, "three asks, one fetch");
        assert.deepEqual(readFileSync(a), JPEG);
        assert.equal(await bg.get(valheim), a);
        assert.equal(f.calls.length, 1, "cached on disk");
        assert.equal(readdirSync(dir).filter((n) => n.includes(".part-")).length, 0, "no temp files left");
        const noArt = { id: "steam:3", art: { hero: "https://cdn2.steamgriddb.com/hero/3.png" } };
        assert.equal(await bg.get(noArt), null);
        assert.equal(await bg.get(noArt), null);
        assert.equal(f.calls.length, 2, "a miss is remembered");
        t += BG.MISS_TTL_MS;
        assert.equal(await bg.get(noArt), null);
        assert.equal(f.calls.length, 3, "and asked again after the TTL");
        assert.equal(await bg.get({ id: "custom:lol", art: {} }), null);
        assert.equal(await bg.get({ id: "steam:4", art: { hero: "https://evil.example/hero.jpg" } }), null);
        assert.equal(await bg.get(null), null);
        assert.equal(f.calls.length, 3, "no hero / an off-list hero / no entry: nothing fetched");
        const manual = join(dir, "manual.jpg");
        writeFileSync(manual, JPEG);
        const bg2 = createBackgroundArt({ dir, fetchImpl: f, manualFile: (e) => (e.id === "custom:lol" ? manual : null) });
        assert.equal(await bg2.get({ id: "custom:lol", art: {} }), manual);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createBackgroundArt: ids never share a file; downloads are bounded server-wide; a bad cache file reads as absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gamebg-"));
    try {
        const A = Buffer.concat([JPEG, Buffer.from("A")]), B = Buffer.concat([JPEG, Buffer.from("B")]);
        const f = fakeFetch({ "https://cdn2.steamgriddb.com/hero/a.png": () => new Response(A), "https://cdn2.steamgriddb.com/hero/b.png": () => new Response(B) });
        const bg = createBackgroundArt({ dir, fetchImpl: f });
        const fa = await bg.get({ id: "custom:a-b", art: { hero: "https://cdn2.steamgriddb.com/hero/a.png" } });
        const fb = await bg.get({ id: "custom:a_b", art: { hero: "https://cdn2.steamgriddb.com/hero/b.png" } });
        assert.notEqual(fa, fb);
        assert.deepEqual(readFileSync(fa), A);
        assert.deepEqual(readFileSync(fb), B);
        // at most MAX_DOWNLOADS at once, however many distinct games are asked for
        let live = 0, peak = 0;
        const slow = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 30)); live--; return new Response(JPEG); };
        const routes = {};
        for (let i = 0; i < 10; i++) routes[`https://cdn2.steamgriddb.com/hero/s${i}.png`] = slow;
        const bg2 = createBackgroundArt({ dir, fetchImpl: fakeFetch(routes) });
        const got = await Promise.all(Array.from({ length: 10 }, (_, i) => bg2.get({ id: `custom:s${i}`, art: { hero: `https://cdn2.steamgriddb.com/hero/s${i}.png` } })));
        assert.ok(got.every(Boolean));
        assert.ok(peak <= BG.MAX_DOWNLOADS, `peak ${peak}`);
        // readCapped: empty / over the cap / a directory → absent
        writeFileSync(join(dir, "empty"), "");
        writeFileSync(join(dir, "big"), Buffer.alloc(BG.MAX_BYTES + 1));
        assert.equal(readCapped(join(dir, "empty")), null);
        assert.equal(readCapped(join(dir, "big")), null);
        assert.equal(readCapped(dir), null);
        assert.deepEqual(readCapped(fa), A);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── the real route ─────────────────────────────────────────────────────────────
const GAMES = join(HERE, "../../games/server.mjs");
let expressOk = false;
try { createRequire(GAMES).resolve("express/package.json"); expressOk = true; } catch {}
try { if (!expressOk) { createRequire(join(HERE, "../server.mjs")).resolve("express/package.json"); expressOk = "tinhat-api"; } } catch {}
const free = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test("GET /art/<id>/background on the real service: art, unknown game, over the cap, no art; /resolve needs sign-in", { skip: expressOk ? false : "express isn't installed (npm ci in api/games or api/tinhat-api)" }, async () => {
    const T = mkdtempSync(join(tmpdir(), "gamebg-route-"));
    const data = join(T, "data"); mkdirSync(data);
    const log = join(T, "fetch.log"); writeFileSync(log, "");
    const row = (appid, name) => ({ id: `steam:${appid}`, name, source: "steam", appid, type: "game", detailsAt: Date.now(), flags: { multiplayer: true }, art: { hero: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_hero.jpg` } });
    writeFileSync(join(data, "catalog.json"), JSON.stringify({ games: { "steam:1": row(1, "One"), "steam:2": row(2, "Two"), "steam:3": row(3, "Three") }, aliases: {} }));
    const port = await free();
    // a fake Synapse: whoami answers for one token
    const hs = createServer((req, res) => {
        const ok = req.url.startsWith("/_matrix/client/v3/account/whoami") && req.headers.authorization === "Bearer good";
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? { user_id: "@ana:example.org", device_id: "D" } : { errcode: "M_UNKNOWN_TOKEN" }));
    });
    await new Promise((r) => hs.listen(0, "127.0.0.1", r));
    const env = { ...process.env, PORT: String(port), GAMES_DATA_DIR: data, GAMES_MANUAL_ART: join(T, "manual"), API_CONF_DIR: T, GAMEBG_STUB_LOG: log,
        SYNAPSE_INTERNAL: `http://127.0.0.1:${hs.address().port}`, GAMES_TEST_GLOBAL_FETCH: "1" };
    if (expressOk === "tinhat-api") env.NODE_PATH = join(HERE, "../node_modules");
    const child = spawn(process.execPath, ["--import", join(HERE, "fixtures/gamebg-fetch-stub.mjs"), GAMES], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    try {
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 100 && !out.includes("catalog on"); i++) await new Promise((r) => setTimeout(r, 50));
        assert.ok(out.includes("catalog on"), out);
        const one = await fetch(`${base}/art/steam%3A1/background`);
        assert.equal(one.status, 200);
        assert.equal(one.headers.get("content-type"), "image/jpeg");
        assert.equal(one.headers.get("x-content-type-options"), "nosniff");
        assert.ok((await one.arrayBuffer()).byteLength > 4000);
        const again = await fetch(`${base}/art/steam%3A1/background`);
        assert.equal(again.status, 200);
        await again.arrayBuffer();
        const unknown = await fetch(`${base}/art/steam%3A424242/background`);
        assert.equal(unknown.status, 404, "unknown game: 404, no placeholder");
        assert.equal((await fetch(`${base}/art/__proto__/background`)).status, 404);
        assert.equal((await fetch(`${base}/art/steam%3A2/background`)).status, 404, "over the size cap");
        assert.equal((await fetch(`${base}/art/steam%3A3/background`)).status, 404, "no art upstream");
        assert.equal((await fetch(`${base}/art/steam%3A3/background`)).status, 404);
        const heroes = readFileSync(log, "utf8").split("\n").filter((l) => l.includes("library_hero"));
        assert.deepEqual(heroes.filter((l) => l.includes("/apps/1/")), ["https://cdn.cloudflare.steamstatic.com/steam/apps/1/library_hero_2x.jpg"], "the 3840 art, fetched once, then cached");
        assert.deepEqual(heroes.filter((l) => l.includes("/apps/3/")).length, 2, "a miss (both sizes) fetched once, then remembered");
        assert.equal(heroes.filter((l) => l.includes("424242")).length, 0, "an unknown game is never fetched");
        // /resolve: signed in only; a LOCAL lookup — nothing at all goes out, even for names the catalogue doesn't know
        const post = (body, token) => fetch(`${base}/resolve`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
        assert.equal((await post({ names: ["One"] })).status, 401, "no token");
        assert.equal((await post({ names: ["One"] }, "bad")).status, 401, "a bad token");
        const outBefore = readFileSync(log, "utf8");
        const r = await post({ names: ["One", "Playing Two", "Not In The Catalogue At All", "Some Brand New Game"] }, "good");
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("cache-control"), "no-store");
        assert.deepEqual((await r.json()).ids, { One: "steam:1", "Playing Two": "steam:2", "Not In The Catalogue At All": null, "Some Brand New Game": null });
        assert.equal(readFileSync(log, "utf8"), outBefore, "resolve made no outbound request");
        assert.equal((await post({ names: Array.from({ length: 21 }, (_, i) => `g${i}`) }, "good")).status, 400, "more than 20 names");
        assert.equal((await post({ names: "One" }, "good")).status, 400);
        let limited = 0;
        for (let i = 0; i < 31; i++) if ((await post({ names: ["One"] }, "good")).status === 429) limited++;
        assert.ok(limited >= 1, "a per-person rate limit");
        const bad = await fetch(`${base}/resolve`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer good" }, body: '{"names": ["SECRET-MARKER-Valheim"' });
        assert.equal(bad.status, 400, "malformed JSON");
        assert.equal(JSON.stringify(await bad.json()).includes("SECRET-MARKER"), false, "not echoed");
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(!/One|Not In The Catalogue|Brand New|SECRET-MARKER/.test(out.split("catalog on")[1] || ""), "the names are not logged (not even a malformed body)");
        const p = await fetch(`${base}/art/steam%3A1/portrait`);
        assert.equal(p.status, 200, "the old kinds still answer");
    } finally {
        child.kill();
        hs.close();
        rmSync(T, { recursive: true, force: true });
    }
});
