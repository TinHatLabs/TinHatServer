// reachcommon.mjs — createMatrixAuth budgets (Astra review finding 3) and the trusted client address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMatrixAuth, clientIp, AUTH, EDGE_PROXY } from "../reachcommon.mjs";
import { call, bearer, clock, fakeHomeserver } from "./helpers.mjs";

const U = "@alice:example.org";

/** A handler that only authenticates (what every presence/push route does first). */
const probe = (auth) => async (req, res) => { const who = await auth.authenticate(req, res); if (who) res.json({ user: who.user }); };
const from = (ip) => ({ "x-forwarded-for": `${ip}, ${EDGE_PROXY}` }); // the edge proxy appended ip, the app's own web server appended the edge proxy

function setup() {
    const now = clock(1000);
    const hs = fakeHomeserver({ tokens: { good: { user: U, device: "D1" }, good2: { user: U, device: "D2" } } });
    const auth = createMatrixAuth({ hs, now });
    const hit = (token, ip) => call(probe(auth), { headers: { ...bearer(token), ...from(ip) } });
    return { now, hs, auth, hit };
}

test("f3_client_address_comes_from_our_own_proxy_chain_only", () => {
    assert.equal(clientIp({ headers: { "x-forwarded-for": `203.0.113.7, ${EDGE_PROXY}` } }), "203.0.113.7");
    assert.equal(clientIp({ headers: { "x-forwarded-for": `1.1.1.1, 2.2.2.2, 203.0.113.7, ${EDGE_PROXY}` } }), "203.0.113.7",
        "hops the client wrote itself are ignored");
    assert.equal(clientIp({ headers: { "x-forwarded-for": `${EDGE_PROXY}, 203.0.113.7, ${EDGE_PROXY}` } }), "203.0.113.7",
        "a client pretending to be the edge proxy gains nothing");
    assert.equal(clientIp({ headers: { "x-forwarded-for": "10.9.1.50" } }), "10.9.1.50", "a LAN client talking to the app's own web server directly");
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
});

test("f3_bogus_tokens_from_one_client_only_limit_that_client", async () => {
    const { hit, hs } = setup();
    let last;
    for (let i = 0; i < 300; i++) last = await hit(`bogus-${i}`, "198.51.100.9");
    assert.equal(last.statusCode, 429, "the flooding client is limited");
    assert.equal(hs.count(/whoami$/), AUTH.UNKNOWN_PER_CLIENT, "and Synapse was asked only its per-client budget");
    const r = await hit("good", "203.0.113.7");
    assert.deepEqual([r.statusCode, r.body], [200, { user: U }], "a real user elsewhere is not starved");
});

test("f3_known_tokens_keep_their_own_refresh_budget_through_a_distributed_flood", async () => {
    const { hit, now } = setup();
    assert.equal((await hit("good", "203.0.113.7")).statusCode, 200); // seen valid once
    for (let i = 0; i < AUTH.UNKNOWN_GLOBAL + 20; i++) await hit(`bogus-${i}`, `198.51.${Math.floor(i / 250)}.${i % 250}`);
    assert.equal((await hit("fresh-unknown", "192.0.2.1")).statusCode, 429, "the global budget for never-seen tokens is spent");
    now.advance(61_000);                                              // the 60 s answer cache has expired
    const r = await hit("good", "203.0.113.7");
    assert.equal(r.statusCode, 200, "a token that was valid before is re-checked from its own budget");
});

test("f3_only_a_lookup_that_really_starts_is_charged", async () => {
    const { hs, auth } = setup();
    let release;
    const orig = hs.get;
    hs.get = async (path, token) => { if (token === "slow-unknown") await new Promise((r) => { release = r; }); return orig(path, token); };
    const same = Array.from({ length: 25 }, () => call(probe(auth), { headers: { ...bearer("slow-unknown"), ...from("198.51.100.20") } }));
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
    release();
    for (const r of await Promise.all(same)) assert.equal(r.statusCode, 401);
    assert.equal(hs.count(/whoami$/), 1, "25 requests, one lookup");
    hs.get = orig;
    // that lookup cost one slot of the client's budget: 19 more distinct unknown tokens still go through
    for (let i = 0; i < AUTH.UNKNOWN_PER_CLIENT - 1; i++) {
        const r = await call(probe(auth), { headers: { ...bearer(`other-${i}`), ...from("198.51.100.20") } });
        assert.equal(r.statusCode, 401, `token ${i}`);
    }
    const r = await call(probe(auth), { headers: { ...bearer("one-too-many"), ...from("198.51.100.20") } });
    assert.equal(r.statusCode, 429);
    assert.equal(r.headers["retry-after"], "10");
});

test("f3_cache_hits_and_rejected_tokens_cost_nothing_and_known_entries_keep_no_user", async () => {
    const { hit, hs, auth, now } = setup();
    for (let i = 0; i < 50; i++) await hit("good", "203.0.113.7");
    assert.equal(hs.count(/whoami$/), 1, "cached for 60 s");
    for (let i = 0; i < 50; i++) await hit("bogus-same", "203.0.113.7");
    assert.equal(hs.count(/whoami$/), 2, "a rejected token is remembered as rejected for 60 s");
    now.advance(61_000);
    auth.sweep();
    const [entry] = [...auth._cache.values()].filter((e) => !e.bad && e.known);
    assert.deepEqual(Object.keys(entry).sort(), ["exp", "known"], "past its 60 s a known token keeps no user or device");
});
