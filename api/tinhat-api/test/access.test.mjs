// access.mjs — who may make the server spend its keys (security review 2026-10-26, H4): members by bearer, older
// token-less apps from one small shared allowance, a bad token never falls back to that allowance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccess, accessConfig, ACCESS_DEFAULTS, SIGNIN_REQUIRED } from "../access.mjs";
import { createMatrixAuth } from "../reachcommon.mjs";
import { fakeReq, fakeRes, bearer, clock, fakeHomeserver } from "./helpers.mjs";

const U = "@alice:example.org", V = "@bob:example.org";

function setup(over = {}) {
    const now = clock(1000);
    const hs = fakeHomeserver({ tokens: { ta: { user: U, device: "D1" }, tb: { user: V, device: "D2" } } });
    const auth = createMatrixAuth({ hs, now });
    const a = createAccess({ auth, now, config: { ...ACCESS_DEFAULTS, ...over } });
    async function run(mw, headers = {}) {
        const req = fakeReq({ headers: { "x-forwarded-for": "203.0.113.9", ...headers } });
        const res = fakeRes();
        let passed = false;
        await mw(req, res, () => { passed = true; });
        return { req, res, passed };
    }
    return { now, hs, a, run };
}

test("a valid bearer is a member; a bad one is 401 and never the token-less lane", async () => {
    const { a, run } = setup();
    const ok = await run(a.memberOrLegacy, bearer("ta"));
    assert.equal(ok.passed, true);
    assert.equal(ok.req.matrixUser, U);
    assert.equal(ok.req.legacy, false);
    const badTok = await run(a.memberOrLegacy, bearer("nope"));
    assert.equal(badTok.passed, false);
    assert.equal(badTok.res.statusCode, 401);
    const none = await run(a.member, {});
    assert.deepEqual([none.passed, none.res.statusCode], [false, 401], "member() needs the bearer whatever the lane");
});

test("no bearer: the legacy lane when on, 401 signin when off", async () => {
    const on = setup();
    const r = await on.run(on.a.memberOrLegacy, {});
    assert.equal(r.passed, true);
    assert.equal(r.req.legacy, true);
    assert.equal(r.req.matrixUser, undefined);
    const off = setup({ legacy: false });
    const r2 = await off.run(off.a.memberOrLegacy, {});
    assert.equal(r2.passed, false);
    assert.deepEqual([r2.res.statusCode, r2.res.body], [401, SIGNIN_REQUIRED]);
    const r3 = await off.run(off.a.optionalMember, {});
    assert.equal(r3.passed, true, "optionalMember lets a token-less caller on (cached clips are public)");
    assert.equal(off.a.spend(r3.req, "clipfetch").status, 401, "but it may spend nothing with the lane off");
});

test("token-less: each address has its own allowance; one draining it leaves the others alone (review of 116d103, #2)", async () => {
    const { a, run, now } = setup({ anonGifPerHour: 3, anonGifAllPerHour: 8, userGifPerHour: 5 });
    const from = async (ip) => (await run(a.memberOrLegacy, { "x-forwarded-for": ip })).req;
    const A = await from("203.0.113.9");
    for (let i = 0; i < 3; i++) assert.equal(a.spend(A, "gif"), null);
    const spent = a.spend(A, "gif");
    assert.deepEqual([spent.status, spent.body], [401, SIGNIN_REQUIRED], "this address's allowance is gone");
    const B = await from("198.51.100.1");
    for (let i = 0; i < 3; i++) assert.equal(a.spend(B, "gif"), null, "another address still has all of its own");
    const A2 = await from("2001:db8:5:6::1"), A3 = await from("2001:db8:5:6::ffff");
    assert.equal(a.spend(A2, "gif"), null);
    assert.equal(a.spend(A3, "gif"), null, "the same /64 shares one allowance");
    assert.equal(a.spend(await from("192.0.2.77"), "gif").status, 401, "the ceiling for everybody (8: 3 + 3 + 2) is reached");
    const alice = (await run(a.memberOrLegacy, bearer("ta"))).req;
    for (let i = 0; i < 5; i++) assert.equal(a.spend(alice, "gif"), null, "members are never starved by token-less callers");
    assert.equal(a.spend(alice, "gif").status, 429);
    const bob = (await run(a.memberOrLegacy, bearer("tb"))).req;
    assert.equal(a.spend(bob, "gif"), null, "one member's budget is theirs alone");
    now.advance(3600_000 + 1);
    assert.equal(a.spend(A, "gif"), null, "an hour later the allowance is back");
});

test("a refused token-less spend counts nowhere", async () => {
    const { a, run } = setup({ anonGifPerHour: 1, anonGifAllPerHour: 2 });
    const from = async (ip) => (await run(a.memberOrLegacy, { "x-forwarded-for": ip })).req;
    const A = await from("203.0.113.1");
    assert.equal(a.spend(A, "gif"), null);
    for (let i = 0; i < 10; i++) assert.equal(a.spend(A, "gif").status, 401);
    assert.equal(a.spend(await from("203.0.113.2"), "gif"), null, "A's refusals didn't eat the ceiling");
});

test("families are separate; clip links have no token-less allowance at all", async () => {
    const { a, run } = setup({ anonGifPerHour: 0 });
    const anon = (await run(a.memberOrLegacy, {})).req;
    assert.equal(a.spend(anon, "gif").status, 401, "0 = none");
    assert.equal(a.spend(anon, "soundsearch"), null);
    assert.equal(a.spend(anon, "clipsign").status, 401);
    assert.throws(() => a.spend(anon, "nope"));
});

test("accessConfig reads whole numbers and the lane switch from the environment, nothing else", () => {
    assert.deepEqual(accessConfig({}), { ...ACCESS_DEFAULTS });
    const c = accessConfig({ API_LEGACY_ANON: "off", API_ANON_GIF_PER_HOUR: "7", WATCH_USER_UNITS_PER_DAY: "0",
        API_USER_GIF_PER_HOUR: "-3", API_ANON_CLIPFETCH_PER_HOUR: "1e3", WATCH_ANON_UNITS_PER_DAY: " 12 " });
    assert.equal(c.legacy, false);
    assert.equal(c.anonGifPerHour, 7);
    assert.equal(c.watchUserUnitsPerDay, 0);
    assert.equal(c.userGifPerHour, ACCESS_DEFAULTS.userGifPerHour, "negative: default kept");
    assert.equal(c.anonClipFetchPerHour, ACCESS_DEFAULTS.anonClipFetchPerHour, "not a plain number: default kept");
    assert.equal(c.watchAnonUnitsPerDay, 12);
    for (const v of ["on", "", "yes", "1"]) assert.equal(accessConfig({ API_LEGACY_ANON: v }).legacy, true, v);
});

test("spendAs charges a principal's member budget (signed clip links: the signer pays); spendSearched needs both budgets", async () => {
    const { a, now } = setup({ userClipFetchPerHour: 2, searchedClipPerAddrHour: 2, searchedClipPerHour: 3 });
    assert.equal(a.spendAs("clipfetch", "p1"), null);
    assert.equal(a.spendAs("clipfetch", "p1"), null);
    const no = a.spendAs("clipfetch", "p1");
    assert.equal(no.status, 429);
    assert.equal(a.spendAs("clipfetch", "p2"), null, "another payer");
    assert.equal(a.spendSearched("198.51.100.1"), null);
    assert.equal(a.spendSearched("198.51.100.1"), null);
    assert.equal(a.spendSearched("198.51.100.1").status, 429, "per address");
    assert.equal(a.spendSearched("198.51.100.2"), null);
    assert.equal(a.spendSearched("198.51.100.3").status, 429, "and for everybody together");
    assert.equal(a.spendSearched("198.51.100.4").status, 429, "a refused one counts nowhere");
    now.advance(3600_001);
    assert.equal(a.spendSearched("198.51.100.3"), null);
});
