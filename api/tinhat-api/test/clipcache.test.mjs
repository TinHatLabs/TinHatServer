// clipcache.mjs — the soundboard clip cache's key, byte budget, admitted set and signed links (security review
// 2026-10-26, H4: the cache was keyed on the full URL incl. query, 25 MB a clip, never evicted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normaliseClipUrl, clipPaths, ClipStore, Admitted, createClipSigner, sameHex, oneDownload } from "../clipcache.mjs";
import { sniffClipAudio } from "../media.mjs";
import { clock } from "./helpers.mjs";

const N = "https://www.myinstants.com/media/sounds/bruh.mp3";

test("one key per clip: query, fragment, spelling and the apex host don't make new entries", () => {
    for (const u of [N, `${N}?x=1`, `${N}?x=2#t`, "https://myinstants.com/media/sounds/bruh.mp3", "HTTPS://WWW.MyInstants.com/media/sounds/bruh.mp3",
        "/media/sounds/bruh.mp3", "https://www.myinstants.com/media/sounds/%62ruh.mp3",
        "https://www.myinstants.com/media/sounds/x/%2e%2e/bruh.mp3",
        "https://www.myinstants.com/media/./sounds/bruh.mp3"]) assert.equal(normaliseClipUrl(u), N, u);
    assert.equal(normaliseClipUrl("https://www.myinstants.com/media/sounds/a%20b.mp3"), "https://www.myinstants.com/media/sounds/a%20b.mp3");
    assert.equal(normaliseClipUrl("https://www.myinstants.com/media/sounds/a b.mp3"), "https://www.myinstants.com/media/sounds/a%20b.mp3");
    assert.equal(clipPaths("/c", `${N}?v=9`.split("?")[0]).key, clipPaths("/c", N).key);
});

test("only myinstants over plain https: no other host, port, userinfo, http, traversal or junk", () => {
    for (const u of ["https://evilmyinstants.com/media/sounds/x.mp3", "https://www.myinstants.com.evil.example/x.mp3",
        "http://www.myinstants.com/media/sounds/x.mp3", "https://www.myinstants.com:8443/media/sounds/x.mp3",
        "https://u:p@www.myinstants.com/media/sounds/x.mp3", "media/sounds/x.mp3", "//evil.example/x.mp3",
        "https://www.myinstants.com/media/sounds/a%2Fb.mp3", "https://www.myinstants.com/media/sounds/%00.mp3",
        "https://www.myinstants.com/media/sounds/%E0%A4%A.mp3", "https://www.myinstants.com/", "javascript:alert(1)",
        "", "x".repeat(3000), 42, null]) assert.equal(normaliseClipUrl(u), null, String(u).slice(0, 60));
    assert.equal(normaliseClipUrl("https://cdn.myinstants.com/x.ogg"), "https://cdn.myinstants.com/x.ogg", "a subdomain stays itself");
});

test("the store keeps the newest plays inside its byte budget; older cache entries count and age out", () => {
    const dir = mkdtempSync(join(tmpdir(), "clips-"));
    try {
        const now = clock(Date.now() + 10 * 86400_000);   // ahead of the files' real times, so plays move them
        // one entry left by an older version (keyed on a raw URL with a query) and one current
        const legacy = clipPaths(dir, "https://www.myinstants.com/media/sounds/old.mp3?x=1");
        writeFileSync(legacy.file, Buffer.alloc(400)); writeFileSync(legacy.metaFile, "{}");
        utimesSync(legacy.file, 1, 1);
        const a = clipPaths(dir, N);
        writeFileSync(a.file, Buffer.alloc(300)); writeFileSync(a.metaFile, JSON.stringify({ content_type: "audio/mpeg" }));
        writeFileSync(join(dir, "deadbeef.part-1-2"), "x"); utimesSync(join(dir, "deadbeef.part-1-2"), 1, 1);
        writeFileSync(join(dir, `${"f".repeat(64)}.json`), "{}");   // a sidecar whose audio is gone
        const s = new ClipStore({ dir, maxBytes: 1000, now }).scan();
        assert.equal(s.total, 700);
        assert.ok(!existsSync(join(dir, "deadbeef.part-1-2")), "an unfinished download from long ago is removed");
        assert.ok(!existsSync(join(dir, `${"f".repeat(64)}.json`)), "an orphan sidecar is removed");
        assert.deepEqual(s.get(N), { file: a.file, contentType: "audio/mpeg" });
        // a new 500-byte clip: 1200 > 1000, so the least recently played (the legacy entry) goes
        const b = clipPaths(dir, "https://www.myinstants.com/media/sounds/new.ogg");
        writeFileSync(b.file, Buffer.alloc(500)); writeFileSync(b.metaFile, JSON.stringify({ content_type: "text/html" }));
        s.add(b.key, b.file, b.metaFile, 500);
        assert.equal(s.total, 800);
        assert.ok(!existsSync(legacy.file) && !existsSync(legacy.metaFile), "evicted with its sidecar");
        assert.equal(s.get("https://www.myinstants.com/media/sounds/new.ogg").contentType, "audio/ogg", "never anything but audio");
        // play N again, then add a big one: the least recently PLAYED (new.ogg) goes, not the oldest written
        now.advance(120_000);
        s.get(N);
        now.advance(1000);
        const c = clipPaths(dir, "https://www.myinstants.com/media/sounds/big.wav");
        writeFileSync(c.file, Buffer.alloc(600)); writeFileSync(c.metaFile, "{}");
        s.add(c.key, c.file, c.metaFile, 600);
        assert.ok(!existsSync(b.file), "new.ogg was played least recently");
        assert.ok(existsSync(a.file) && existsSync(c.file));
        assert.equal(s.total, 900);
        // a restart keeps the play order (the files' mtimes): bruh was played before big.wav was added
        const again = new ClipStore({ dir, maxBytes: 1000, now }).scan();
        assert.deepEqual([...again.entries.keys()], [a.key, c.key]);
        assert.equal(readdirSync(dir).length, 4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a single clip bigger than the whole budget still plays once, then makes room", () => {
    const dir = mkdtempSync(join(tmpdir(), "clips-"));
    try {
        const s = new ClipStore({ dir, maxBytes: 100, now: clock() }).scan();
        const a = clipPaths(dir, N);
        writeFileSync(a.file, Buffer.alloc(150));
        s.add(a.key, a.file, a.metaFile, 150);
        assert.ok(existsSync(a.file), "the clip just added is kept");
        const b = clipPaths(dir, "https://www.myinstants.com/media/sounds/b.mp3");
        writeFileSync(b.file, Buffer.alloc(10));
        s.add(b.key, b.file, b.metaFile, 10);
        assert.ok(!existsSync(a.file));
        assert.equal(s.total, 10);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("admitted: what a search handed out, for a day, at most max", () => {
    const now = clock();
    const ad = new Admitted({ max: 2, ttlMs: 1000, now });
    ad.add(N); ad.add(null);
    assert.equal(ad.has(N), true);
    now.advance(1001);
    assert.equal(ad.has(N), false);
    ad.add("a"); ad.add("b"); ad.add("c");
    assert.deepEqual([ad.has("a"), ad.has("b"), ad.has("c")], [false, true, true]);
});

test("signed links: bound to the clip, the expiry and who pays; short-lived; compared in constant time", () => {
    const now = clock(1_760_000_000_000);
    const s = createClipSigner({ key: "k".repeat(32), ttlMs: 3600_000, now });
    const P = s.principalOf("@alice:example.org");
    assert.match(P, /^[0-9a-f]{16}$/);
    assert.equal(s.principalOf("@alice:example.org"), P, "stable");
    assert.notEqual(s.principalOf("@bob:example.org"), P);
    assert.ok(!P.includes("alice"), "no account name in a URL");
    const { exp, sig } = s.sign(N, P);
    assert.equal(exp, 1_760_000_000_000 + 3600_000);
    assert.match(sig, /^[0-9a-f]{32}$/);
    assert.equal(s.verify(N, exp, sig, P), true);
    assert.equal(s.verify(N, String(exp), sig, P), true, "exp from a query string");
    assert.equal(s.verify(N, exp, sig, s.principalOf("@bob:example.org")), false, "another payer: the link can't be moved onto someone else's budget");
    assert.equal(s.verify(N, exp, sig, ""), false);
    assert.equal(s.verify(N, exp, sig, undefined), false);
    assert.equal(s.verify("https://www.myinstants.com/media/sounds/other.mp3", exp, sig, P), false, "another clip");
    assert.equal(s.verify(N, exp + 1, sig, P), false, "a moved expiry");
    assert.equal(s.verify(N, exp, sig.toUpperCase(), P), false);
    assert.equal(s.verify(N, exp, sig.slice(0, 31), P), false);
    assert.equal(s.verify(N, exp, undefined, P), false);
    assert.equal(s.verify(N, "soon", sig, P), false);
    assert.throws(() => s.sign(N, "@alice:example.org"), /principal/);
    const other = createClipSigner({ key: "x".repeat(32), now });
    assert.equal(other.verify(N, exp, sig, P), false, "another server's key");
    const far = createClipSigner({ key: "k".repeat(32), ttlMs: 10 * 3600_000, now });
    const long = far.sign(N, P);
    assert.equal(s.verify(N, long.exp, long.sig, P), false, "an expiry further out than this server hands out");
    now.advance(3600_001);
    assert.equal(s.verify(N, exp, sig, P), false, "expired");
});

test("sameHex (the Memories links): equal hex strings only", () => {
    assert.equal(sameHex("ab12", "ab12"), true);
    assert.equal(sameHex("ab12", "ab13"), false);
    assert.equal(sameHex("ab12", "ab1"), false);
    assert.equal(sameHex("", ""), true);
    assert.equal(sameHex(undefined, "ab"), false);
    assert.equal(sameHex("zz", "zz"), false);
});

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("oneDownload: requests that arrive while one runs join it — one download, one charge", async () => {
    const inflight = new Map();
    const d = deferred();
    let gates = 0, starts = 0, cache = null;
    const steps = { cached: () => cache, gate: () => { gates++; return null; }, start: () => { starts++; return d.promise; } };
    // e.g. two signed-in requests whose sign-in checks finished one after the other: both call oneDownload afterwards
    const a = oneDownload(inflight, "k", steps);
    const b = oneDownload(inflight, "k", steps);
    assert.equal(inflight.size, 1);
    d.resolve({ file: "f" });
    assert.deepEqual(await a, { got: { file: "f" } });
    assert.deepEqual(await b, { got: { file: "f" } });
    assert.deepEqual([gates, starts], [1, 1], "the second joined: no second charge, no second download");
    await new Promise((r) => setImmediate(r));
    assert.equal(inflight.size, 0, "a finished download removes its own registration");
    cache = { file: "f" };
    assert.deepEqual(await oneDownload(inflight, "k", steps), { got: { file: "f" } });
    assert.deepEqual([gates, starts], [1, 1], "a cached clip costs nothing");
});

test("oneDownload: a finished download never removes a newer registration; a failure reaches everyone who joined", async () => {
    const inflight = new Map();
    const first = deferred(), second = deferred();
    const a = oneDownload(inflight, "k", { cached: () => null, gate: () => null, start: () => first.promise });
    inflight.set("k", second.promise);   // as if another download had replaced it
    first.resolve({ file: "1" });
    await a;
    await new Promise((r) => setImmediate(r));
    assert.equal(inflight.get("k"), second.promise, "only its own entry is removed");
    inflight.delete("k");
    const fail = deferred();
    const x = oneDownload(inflight, "k", { cached: () => null, gate: () => null, start: () => fail.promise });
    const y = oneDownload(inflight, "k", { cached: () => null, gate: () => { throw new Error("not called"); }, start: () => null });
    fail.reject(Object.assign(new Error("upstream 500"), { upstream: 500 }));
    await assert.rejects(x, /upstream 500/);
    await assert.rejects(y, /upstream 500/);
    await new Promise((r) => setImmediate(r));
    assert.equal(inflight.size, 0);
});

test("oneDownload: a refused gate starts and registers nothing", async () => {
    const inflight = new Map();
    let started = false;
    const r = await oneDownload(inflight, "k", { cached: () => null, gate: () => ({ status: 503 }), start: () => { started = true; } });
    assert.deepEqual(r, { refused: { status: 503 } });
    assert.equal(started, false);
    assert.equal(inflight.size, 0);
});

test("at start, a cached clip whose bytes aren't audio is dropped with its sidecar (round 3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "clips-"));
    try {
        const good = clipPaths(dir, N);
        writeFileSync(good.file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100)]));
        writeFileSync(good.metaFile, JSON.stringify({ content_type: "audio/mpeg" }));
        const bad = clipPaths(dir, "https://www.myinstants.com/media/sounds/page.mp3");
        writeFileSync(bad.file, "<!doctype html><script>alert(1)</script>" + " ".repeat(100));
        writeFileSync(bad.metaFile, JSON.stringify({ content_type: "audio/mpeg" }));   // an older entry trusted what was said
        const lines = [];
        const s = new ClipStore({ dir, maxBytes: 10_000, now: clock(), sniff: sniffClipAudio, log: (l) => lines.push(l) }).scan();
        assert.deepEqual([...s.entries.keys()], [good.key]);
        assert.ok(!existsSync(bad.file) && !existsSync(bad.metaFile));
        assert.equal(s.get("https://www.myinstants.com/media/sounds/page.mp3"), null);
        assert.ok(lines.some((l) => l.includes("not audio")));
        const plain = new ClipStore({ dir, maxBytes: 10_000, now: clock() }).scan();
        assert.equal(plain.entries.size, 1, "without a sniff function nothing is read");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
