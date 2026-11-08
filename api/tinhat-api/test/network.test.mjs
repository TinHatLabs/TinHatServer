// network.mjs — GET /network (open network slice 1): the document the apps read to tell rooms on connected Tin Hat
// servers from rooms elsewhere. Driven through the real handler with a scripted homeserver and a hand-driven clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNetwork, parseNetwork, NETWORK } from "../network.mjs";
import { call, bearer, clock, fakeHomeserver, authFor } from "./helpers.mjs";

const A = "@alice:home.example", G = "@guest-x1:home.example";
const NOW_S = 1_800_000_000;   // the wall clock the handler sees (unix seconds)
const fresh = (o) => ({ issued: NOW_S - 60, ...o });

function setup() {
    const dir = mkdtempSync(join(tmpdir(), "tinhat-network-"));
    const path = join(dir, "network.json");
    const now = clock(1000);
    const hs = fakeHomeserver({ tokens: { ta: { user: A, device: "AD" }, tg: { user: G, device: "GD" } } });
    const logs = [];
    let wall = NOW_S;
    const n = createNetwork({ auth: authFor(hs, now), path, isGuest: (m) => /^@guest-/.test(m), now, wallS: () => wall, log: (s) => logs.push(s) });
    const setWall = (v) => { wall = v; };
    const tick = () => now.advance(NETWORK.CHECK_MS);
    const get = (tok) => call(n.get, { headers: tok ? bearer(tok) : {} });
    let stamp = 1_700_000_000;
    const write = (o) => { writeFileSync(path, typeof o === "string" ? o : JSON.stringify(fresh(o))); stamp += 10; utimesSync(path, stamp, stamp); };
    return { dir, path, now, tick, setWall, n, get, write, logs, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("parseNetwork: the document, sorted and deduplicated; home mode lists nobody", () => {
    assert.deepEqual(parseNetwork(JSON.stringify(fresh({ v: 1, mode: "connected", connected: ["b.example", "a.example", "b.example"], blocked: [] })), NOW_S),
        { v: 1, mode: "connected", connected: ["a.example", "b.example"], blocked: [], invites: { default: "known" } });
    assert.deepEqual(parseNetwork(JSON.stringify(fresh({ mode: "home", connected: ["a.example"] })), NOW_S), { v: 1, mode: "home", connected: [], blocked: [], invites: { default: "known" } });
    assert.deepEqual(parseNetwork(JSON.stringify(fresh({ mode: "connected" })), NOW_S), { v: 1, mode: "connected", connected: [], blocked: [], invites: { default: "known" } });
    // a port is kept; damaged entries are dropped, never passed on
    assert.deepEqual(parseNetwork(JSON.stringify(fresh({ mode: "connected", connected: ["chat.example:8448", "Upper.Example", "bad host", "", 7, null,
        "x.example:0", "x.example:99999", "127.0.0.1", "[::1]", "single", "a.example\n", "a..example"] })), NOW_S).connected, ["chat.example:8448"]);
});

test("parseNetwork: anything that isn't the document is refused", () => {
    for (const bad of ["", "nope", "[]", "null", "7", JSON.stringify({ mode: "open" }), JSON.stringify({ mode: "Connected" }),
        JSON.stringify({ connected: [] }), JSON.stringify({ mode: "connected", connected: "a.example" }),
        JSON.stringify({ mode: "connected", blocked: {} }),
        JSON.stringify({ mode: "connected", connected: Array.from({ length: NETWORK.MAX_SERVERS + 1 }, (_, i) => `s${i}.example`) })]) {
        let withStamp = bad;
        try { const o = JSON.parse(bad); if (o && typeof o === "object" && !Array.isArray(o)) withStamp = JSON.stringify(fresh(o)); } catch { /* not JSON */ }
        assert.equal(parseNetwork(withStamp, NOW_S), null, bad.slice(0, 60));
    }
});

test("GET /network: the caller's token is required; a member gets the document", async () => {
    const t = setup();
    try {
        t.write({ v: 1, mode: "connected", connected: ["squad.example"], blocked: [] });
        assert.equal((await t.get(null)).statusCode, 401);
        assert.equal((await t.get("nope")).statusCode, 401);
        const r = await t.get("ta");
        assert.equal(r.statusCode, 200);
        assert.deepEqual(r.body, { v: 1, mode: "connected", connected: ["squad.example"], blocked: [], invites: { default: "known" } });
        assert.equal(r.headers["cache-control"], "no-store");
    } finally { t.done(); }
});

test("GET /network: guests are refused (they never leave the guest room)", async () => {
    const t = setup();
    try {
        t.write({ mode: "connected", connected: ["squad.example"] });
        const r = await t.get("tg");
        assert.equal(r.statusCode, 403);
        assert.equal(r.body.code, "guest");
    } finally { t.done(); }
});

test("GET /network: missing or damaged file is 503 off (the apps fail closed), and recovers when it is written", async () => {
    const t = setup();
    try {
        let r = await t.get("ta");
        assert.equal(r.statusCode, 503);
        assert.equal(r.body.code, "off");
        t.write("{broken");
        t.now.advance(NETWORK.CHECK_MS);
        assert.equal((await t.get("ta")).statusCode, 503);
        t.write({ mode: "connected", connected: ["squad.example"] });
        // still the cached answer inside the check interval
        assert.equal((await t.get("ta")).statusCode, 503);
        t.now.advance(NETWORK.CHECK_MS);
        r = await t.get("ta");
        assert.equal(r.statusCode, 200);
        assert.deepEqual(r.body.connected, ["squad.example"]);
        // a connection ends: the next read after the interval says so
        t.write({ mode: "connected", connected: [] });
        t.now.advance(NETWORK.CHECK_MS);
        assert.deepEqual((await t.get("ta")).body.connected, []);
        // and the file going away is an answer too (never a stale list)
        rmSync(t.path);
        t.now.advance(NETWORK.CHECK_MS);
        assert.equal((await t.get("ta")).statusCode, 503);
    } finally { t.done(); }
});

test("GET /network: an oversized file is refused, not read", async () => {
    const t = setup();
    try {
        t.write(JSON.stringify(fresh({ mode: "connected", connected: [] })) + " ".repeat(NETWORK.MAX_BYTES));
        assert.equal((await t.get("ta")).statusCode, 503);
    } finally { t.done(); }
});

test("GET /network: per-account limit", async () => {
    const t = setup();
    try {
        t.write({ mode: "home" });
        for (let i = 0; i < NETWORK.PER_MIN; i++) assert.equal((await t.get("ta")).statusCode, 200, `read ${i}`);
        const r = await t.get("ta");
        assert.equal(r.statusCode, 429);
        assert.ok(Number(r.headers["retry-after"]) > 0);
        t.now.advance(60_000);
        assert.equal((await t.get("ta")).statusCode, 200);
    } finally { t.done(); }
});

test("GET /network: a replacement with the same mtime is still seen (no mtime cache: astra r1 P3)", async () => {
    const t = setup();
    try {
        t.write({ mode: "connected", connected: ["squad.example"] });
        assert.deepEqual((await t.get("ta")).body.connected, ["squad.example"]);
        const other = join(t.dir, "next.json");
        writeFileSync(other, JSON.stringify(fresh({ mode: "home" })));
        utimesSync(other, 1_700_000_010, 1_700_000_010); // the same stamp the first write got
        renameSync(other, t.path);
        t.tick();
        assert.deepEqual((await t.get("ta")).body, { v: 1, mode: "home", connected: [], blocked: [], invites: { default: "known" } });
    } finally { t.done(); }
});

test("GET /network: an unreadable file is 503 at the next check and recovers without a new mtime", async (tt) => {
    if (process.getuid?.() === 0) { tt.skip("root reads a 000 file anyway: run as a normal user"); return; }
    const t = setup();
    try {
        t.write({ mode: "connected", connected: ["squad.example"] });
        assert.equal((await t.get("ta")).statusCode, 200);
        chmodSync(t.path, 0o000);
        t.tick();
        assert.equal((await t.get("ta")).statusCode, 503); // never the old list
        chmodSync(t.path, 0o600);
        t.tick();
        assert.deepEqual((await t.get("ta")).body.connected, ["squad.example"]);
    } finally { t.done(); }
});

test("GET /network: the deny-list is passed on, and a blocked server is never connected", async () => {
    const t = setup();
    try {
        t.write({ mode: "connected", connected: ["squad.example", "evil.example"], blocked: ["evil.example", "Bad Name", "evil.example"] });
        const b = (await t.get("ta")).body;
        assert.deepEqual(b.blocked, ["evil.example"]);
        assert.deepEqual(b.connected, ["squad.example"]);
        t.write({ mode: "home", connected: ["squad.example"], blocked: ["evil.example"] });
        t.tick();
        assert.deepEqual((await t.get("ta")).body.blocked, [], "home mode federates with nobody: nothing to hide");
    } finally { t.done(); }
});

test("parseNetwork: the invite default is one of the three rules, else known", () => {
    for (const [inv, want] of [[{ default: "nobody" }, "nobody"], [{ default: "anyone" }, "anyone"], [{ default: "Anyone" }, "known"],
        [{ default: 1 }, "known"], ["anyone", "known"], [null, "known"], [undefined, "known"]]) {
        assert.equal(parseNetwork(JSON.stringify(fresh({ mode: "connected", invites: inv })), NOW_S).invites.default, want, JSON.stringify(inv));
    }
});

test("createNetwork: isGuest is required; the reserved guest prefix alone is refused", async () => {
    assert.throws(() => createNetwork({ auth: {}, path: "/nonexistent" }), /isGuest/);
    const t = setup();
    try {
        t.write({ mode: "home" });
        assert.equal((await t.get("tg")).statusCode, 403); // @guest-… by its name, no registry needed
    } finally { t.done(); }
});

test("parseNetwork: the file's age (issued) is checked: missing, too old or from the future is refused", () => {
    const doc = { mode: "connected", connected: ["squad.example"] };
    assert.equal(parseNetwork(JSON.stringify(doc), NOW_S), null);                                   // no stamp
    assert.equal(parseNetwork(JSON.stringify({ ...doc, issued: String(NOW_S) }), NOW_S), null);     // not a number
    assert.equal(parseNetwork(JSON.stringify({ ...doc, issued: NOW_S - NETWORK.MAX_AGE_S - 1 }), NOW_S), null);
    assert.ok(parseNetwork(JSON.stringify({ ...doc, issued: NOW_S - NETWORK.MAX_AGE_S }), NOW_S));
    assert.equal(parseNetwork(JSON.stringify({ ...doc, issued: NOW_S + NETWORK.SKEW_S + 1 }), NOW_S), null);
    assert.ok(parseNetwork(JSON.stringify({ ...doc, issued: NOW_S + NETWORK.SKEW_S }), NOW_S));
    assert.equal(NETWORK.MAX_AGE_S, 6 * 3600); // = apiconf.NETWORK_MAX_AGE_S
});

test("GET /network: a list the manager stopped renewing expires (503: the apps fail closed)", async () => {
    const t = setup();
    try {
        t.write({ mode: "connected", connected: ["squad.example"] });
        assert.equal((await t.get("ta")).statusCode, 200);
        t.setWall(NOW_S + NETWORK.MAX_AGE_S);
        t.tick();
        assert.equal((await t.get("ta")).statusCode, 503);
        assert.ok(t.logs.some((l) => /invalid or expired/.test(l)));
    } finally { t.done(); }
});
