// watch.mjs — who spends YouTube units (security review 2026-10-26, H4): a member from their own daily budget, callers
// without a token from one shared one; cached answers cost nobody anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installWatch, createUnitBudget } from "../watch.mjs";
import { fakeReq, fakeRes, clock } from "./helpers.mjs";

test("unit budget: per person, per token-less caller and a ceiling for all of them, per Pacific day", () => {
    const now = clock(Date.UTC(2026, 9, 26, 18));
    const b = createUnitBudget({ userPerDay: 150, anonPerDay: 101, anonAllPerDay: 250, now });
    assert.equal(b.charge({ legacy: true, key: "203.0.113.1" }, 101), null);
    assert.equal(b.charge({ legacy: true, key: "203.0.113.1" }, 1), "anon");
    assert.equal(b.charge({ legacy: true, key: "198.51.100.1" }, 101), null, "another address has its own");
    assert.equal(b.charge({ legacy: true, key: "192.0.2.1" }, 48), null, "101 + 101 + 48 = the ceiling");
    assert.equal(b.charge({ legacy: true, key: "192.0.2.2" }, 1), "anon", "the ceiling for everybody (250)");
    assert.equal(b.charge({ user: "@a:x" }, 101), null);
    assert.equal(b.charge({ user: "@a:x" }, 100), "user");
    assert.equal(b.charge({ user: "@b:x" }, 100), null, "one person's budget is theirs alone");
    assert.equal(b.charge({}, 10_000), null, "no guard installed: not limited here");
    assert.equal(b.used({ user: "@a:x" }), 101);
    now.advance(24 * 3600_000);
    assert.equal(b.charge({ legacy: true, key: "203.0.113.1" }, 101), null, "a new Pacific day");
    assert.equal(b.used({ user: "@a:x" }), 0);
});

function fakeApp() {
    const routes = new Map();
    return {
        get: (path, ...chain) => routes.set(path, chain),
        async run(path, { query = {}, headers = {} } = {}) {
            headers = { "x-forwarded-for": "203.0.113.9", ...headers };
            const req = fakeReq({ query, headers });
            const res = fakeRes();
            res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
            const chain = routes.get(path);
            let i = 0;
            const next = async () => { const h = chain[i++]; if (h) await h(req, res, next); };
            await next();
            return res;
        },
    };
}

test("routes: the guard runs first; members and token-less callers spend from their own budgets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-"));
    const real = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        asked.push(u.split("?")[0]);
        if (u.includes("/youtube/v3/search")) return new Response(JSON.stringify({ items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "T", channelTitle: "C", thumbnails: {} } }] }), { status: 200 });
        if (u.includes("/youtube/v3/videos")) return new Response(JSON.stringify({ items: [{ id: "abcdefghijk", contentDetails: { duration: "PT3M" }, statistics: { viewCount: "5" } }] }), { status: 200 });
        return new Response("{}", { status: 404 });
    };
    try {
        const app = fakeApp();
        const guard = (req, res, next) => {
            const u = req.headers["x-user"];
            if (u === "bad") return res.status(401).json({ error: "bad token" });
            if (u) { req.matrixUser = u; req.legacy = false; } else req.legacy = true;
            return next();
        };
        installWatch(app, { youtubeKey: "K", dataDir: dir, guard, userUnitsPerDay: 150, anonUnitsPerDay: 101 });
        const search = (q, user, ip = "203.0.113.9") => app.run("/youtube/search", { query: { q, v: "2" }, headers: { "x-forwarded-for": ip, ...(user ? { "x-user": user } : {}) } });

        let r = await search("first song");
        assert.equal(r.statusCode, 200, JSON.stringify(r.body));
        assert.equal(r.body.items[0].durationSec, 180);
        r = await search("second song");
        assert.equal(r.statusCode, 401, "this address's token-less budget (101) is spent");
        assert.equal(r.body.signin, true);
        r = await search("another song", undefined, "198.51.100.7");
        assert.equal(r.statusCode, 200, "another address still has its own");
        r = await search("first song");
        assert.equal(r.statusCode, 200, "a cached answer costs nothing, for anyone");
        assert.equal(r.headers["x-cache"], "HIT");

        r = await search("second song", "@alice:example.org");
        assert.equal(r.statusCode, 200);
        r = await search("third song", "@alice:example.org");
        assert.deepEqual([r.statusCode, r.body.error, r.body.scope], [503, "budget", "you"], "alice's own 150 a day");
        assert.ok(r.body.resetAt);
        r = await search("third song", "@bob:example.org");
        assert.equal(r.statusCode, 200, "bob is not starved by alice");
        r = await search("fourth song", "bad");
        assert.equal(r.statusCode, 401, "a bad token is answered by the guard");
        assert.equal(asked.filter((u) => u.endsWith("/search")).length, 4, "Google was asked only for the four allowed searches");
    } finally {
        globalThis.fetch = real;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("routes: the ceiling for every token-less caller together (anonAllUnitsPerDay) is enforced; 0 = none (second review, #6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-"));
    const real = globalThis.fetch;
    let searches = 0;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/youtube/v3/search")) { searches++; return new Response(JSON.stringify({ items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "T", channelTitle: "C", thumbnails: {} } }] }), { status: 200 }); }
        if (u.includes("/youtube/v3/videos")) return new Response(JSON.stringify({ items: [{ id: "abcdefghijk", contentDetails: { duration: "PT3M" } }] }), { status: 200 });
        return new Response("{}", { status: 404 });
    };
    const guard = (req, _res, next) => { if (req.headers["x-user"]) req.matrixUser = req.headers["x-user"]; else req.legacy = true; return next(); };
    try {
        const app = fakeApp();
        installWatch(app, { youtubeKey: "K", dataDir: dir, guard, userUnitsPerDay: 1000, anonUnitsPerDay: 1000, anonAllUnitsPerDay: 202 });
        const search = (q, ip, user) => app.run("/youtube/search", { query: { q, v: "2" }, headers: { "x-forwarded-for": ip, ...(user ? { "x-user": user } : {}) } });
        assert.equal((await search("one", "203.0.113.1")).statusCode, 200);   // 101 units
        assert.equal((await search("two", "203.0.113.2")).statusCode, 200);   // 202: the ceiling
        const r = await search("three", "203.0.113.3");
        assert.equal(r.statusCode, 401, "a fresh address, but everybody's ceiling is spent");
        assert.equal(r.body.signin, true);
        assert.equal((await search("three", "203.0.113.3", "@alice:example.org")).statusCode, 200, "members have their own");
        assert.equal(searches, 3);

        const none = fakeApp();
        installWatch(none, { youtubeKey: "K", dataDir: mkdtempSync(join(dir, "z-")), guard, anonUnitsPerDay: 1000, anonAllUnitsPerDay: 0 });
        const z = await none.run("/youtube/search", { query: { q: "zero", v: "2" }, headers: { "x-forwarded-for": "203.0.113.9" } });
        assert.equal(z.statusCode, 401, "0 = none for token-less callers");
        assert.equal(searches, 3, "and Google was never asked");
    } finally {
        globalThis.fetch = real;
        rmSync(dir, { recursive: true, force: true });
    }
});
