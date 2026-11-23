// games-s2, polish round 2: F9 Tune In (GAMES-V1.1-ADDENDUM §6) on a real Postgres (PLAY_TEST_DB_URL; skipped without
// it) through the real HTTP routes: who may play (opted in, broke, no open money, day max, switched on), the
// server-held secret and its answers, the pay formula and its clips, exactly-once pay, the tombstone, never activity.
// Written failing-first against 0.3.20 (no side routes).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import pg from "pg";
import { migrate, inTx } from "../play/db.mjs";
import * as L from "../play/ledger.mjs";
import * as rules from "../play/rules.mjs";
import { createPlay } from "../play/platform.mjs";
import { validate } from "../play/jsonschema.mjs";
import { SCHEMA } from "../play/contract/schema.mjs";
const fits = (def, v) => assert.deepEqual(validate(SCHEMA, { $ref: `#/$defs/${def}` }, v), [], `${def}: ${JSON.stringify(v).slice(0, 300)}`);

const ADMIN_DB = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN_DB && "set PLAY_TEST_DB_URL to run the platform tests";
const DBNAME = `games_s2_side_${process.pid}`;
const SERVER = "play.test";
const SPACE = "!side-space:play.test";
const RICH = "!side-rich:play.test";
const [ANA, BEN, CY] = ["@side-ana:play.test", "@side-ben:play.test", "@side-cy:play.test"];

let clock = Date.parse("2026-11-20T20:00:00Z");
const now = () => clock;
let monoAt = 5_000_000;
const mono = () => monoAt;
let secret = 62;
const moves = [];
let pool, server, base;

before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN_DB }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN_DB.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 10 });
    await migrate(pool);
    // the space opens wallets at 0 with no top-up: everyone starts broke
    await inTx(pool, async (c) => { const sid = await L.ensureSpace(c, SPACE, SERVER); await c.query("INSERT INTO play_space_economy (sid, settings) VALUES ($1, $2)", [sid, JSON.stringify({ start: 0, topup_to: 0 })]); });
    const joined = new Set([ANA, BEN, CY]);
    const play = createPlay({
        pool, cfg: { ...rules.configFromEnv({}), tz: "America/Los_Angeles" },
        spaces: { resolve: async () => ({ space: SPACE, server: SERVER, why: "", room: { joined: new Map(), sessions: [] }, spaceJoined: joined }), forget: () => {} },
        spaceInfo: async (s) => (s === SPACE || s === RICH ? { owner: SERVER, joined, levelOf: () => 0 } : null),
        serverName: SERVER, salt: "test-salt", now, mono, sideRng: () => secret, onMove: (x) => moves.push(x), log: () => {}, flags: () => ({ play: true, rig_phone_apps: true }),
        resolveOpenId: async ({ openid, user_id }) => (openid.access_token === `ok:${user_id}` ? user_id : null),
    });
    await play.recover();
    const app = express(); app.set("trust proxy", "loopback");
    const r = express.Router(); play.routes(r); app.use(r);
    server = createServer(app);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(async () => {
    if (skip) return;
    await new Promise((r) => server.close(r)); server.closeAllConnections?.();
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN_DB }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});

async function http(method, path, body, session) {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Play ${session}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
}
const S = {};
async function signIn(user) {
    const s = await http("POST", "/session", { openid: { access_token: `ok:${user}`, matrix_server_name: SERVER, token_type: "Bearer", expires_in: 3600 }, user_id: user, client: { kind: "web" } });
    return (S[user] = s.body.session);
}
let opn = 0;
const op = () => `games-s2-side-${String(++opn).padStart(6, "0")}`;
const sp = encodeURIComponent(SPACE);
const me = async (u, space = SPACE) => (await http("GET", `/me?space=${encodeURIComponent(space)}`, null, S[u])).body;
async function guess(u, run, g, o = op()) { monoAt += 400; return http("POST", `/side/tune/${run}`, { op: o, guess: g }, S[u]); }

test("F9: a broke opted-in player tunes in: higher / lower narrow the range, a find pays SIDE_PAY[try] once; never activity", { skip }, async () => {
    for (const u of [ANA, BEN, CY]) { await signIn(u); assert.equal((await http("POST", "/wallet", { space: SPACE }, S[u])).status, 201); }
    const m0 = await me(ANA);
    assert.equal(m0.balance, 0);
    assert.deepEqual(m0.side, { on: true, eligible: true, reason: null, left_today: 10, day_max: 10, broke_max: 4 });
    const st = await http("POST", "/side/tune", { space: SPACE }, S[ANA]);
    assert.equal(st.status, 201, JSON.stringify(st.body));
    assert.deepEqual([st.body.lo, st.body.hi, st.body.tries_left, st.body.left_today], [1, 100, 7, 10]);
    assert.deepEqual(st.body.pay, [3, 3, 3, 3, 2, 2, 1]);
    assert.ok(!("secret" in st.body));
    fits("sideRun", st.body); fits("me", m0);
    const run = st.body.run;
    const g1 = await guess(ANA, run, 50);
    assert.deepEqual([g1.body.result, g1.body.lo, g1.body.hi, g1.body.tries_left, g1.body.secret], ["higher", 51, 100, 6, undefined]);
    assert.equal((await guess(ANA, run, 40)).body.code, "bad", "outside the still-possible range: refused, costs nothing");
    const g2 = await guess(ANA, run, 75);
    assert.deepEqual([g2.body.result, g2.body.lo, g2.body.hi, g2.body.tries_left], ["lower", 51, 74, 5]);
    // too fast: one try per 300 ms
    const o = op();
    const fast = await http("POST", `/side/tune/${run}`, { op: o, guess: 60 }, S[ANA]);
    assert.equal(fast.body.code, "rate");
    // someone else's run id: no-run (never "not yours")
    assert.equal((await guess(BEN, run, 62)).body.code, "no-run");
    const found = await guess(ANA, run, 62, "games-s2-side-found001");
    assert.deepEqual([found.body.result, found.body.paid, found.body.secret], ["found", 3, 62]);
    assert.deepEqual(found.body.wallet, { balance: 3, holdings: 3 });
    fits("sideTune", found.body); fits("sideTune", g1.body);
    // a resend of the find answers again (dup) and pays nothing more
    const again = await guess(ANA, run, 62, "games-s2-side-found001");
    assert.equal(again.body.dup, true); assert.equal(again.body.paid, 3);
    const m1 = await me(ANA);
    assert.equal(m1.balance, 3);
    assert.equal(m1.side.left_today, 7);
    assert.equal((await guess(ANA, run, 62)).body.code, "no-run", "a finished run takes no more tries");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM play_tx WHERE kind = 'side'");
    assert.equal(rows[0].n, 1, "one journal transaction");
    assert.deepEqual(moves, [], "Tune In tries are never activity");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("F9: seven misses = lost (the secret told, nothing paid); the broke line and the day max clip the pay; then not-broke / day-max", { skip }, async () => {
    secret = 1;
    const st = await http("POST", "/side/tune", { space: SPACE }, S[BEN]);
    let last;
    for (const g of [100, 90, 80, 70, 60, 50, 40]) last = await guess(BEN, st.body.run, g);
    assert.deepEqual([last.body.result, last.body.tries_left, last.body.paid, last.body.secret], ["lost", 0, 0, 1]);
    assert.equal((await me(BEN)).balance, 0);
    // BEN now finds on try 1: 3, then 3 (holdings 6 > the broke line of 4), then no third run
    secret = 33;
    const pays = [];
    for (let i = 0; i < 3; i++) {
        const r = await http("POST", "/side/tune", { space: SPACE }, S[BEN]);
        if (r.status !== 201) { pays.push(r.body.code); break; }
        pays.push((await guess(BEN, r.body.run, 33)).body.paid);
    }
    assert.deepEqual(pays, [3, 3, "not-broke"], "6 chips > the broke line of 4: no third run");
    assert.equal((await me(BEN)).side.reason, "not-broke");
    // chips that arrive during the run only CLIP the pay at the payout (design2 16:29): holdings 5 → 4 + 3 − 5 = 2
    secret = 77;
    await inTx(pool, async (c) => { const sid = await L.sidOf(c, SPACE); await c.query("UPDATE play_space_economy SET settings = settings || '{\"side_day_max\": 100}' WHERE sid = $1", [sid]); });
    const cyRun = await http("POST", "/side/tune", { space: SPACE }, S[CY]);
    assert.equal(cyRun.status, 201);
    await inTx(pool, async (c) => { const sid = await L.sidOf(c, SPACE); const wid = await L.widOfUser(c, sid, CY);
        await L.post(c, { sid, kind: "earn", idem: `earn:test-${wid}`, day: "2026-11-20", entries: [[L.acct.mint("earn", sid), -5], [L.acct.w(wid), 5]] }); });
    const clipped = await guess(CY, cyRun.body.run, 77);
    assert.deepEqual([clipped.body.result, clipped.body.paid], ["found", 2]);
    await inTx(pool, async (c) => { const sid = await L.sidOf(c, SPACE); const wid = await L.widOfUser(c, sid, CY);
        await L.post(c, { sid, kind: "test", idem: `burn:test-${wid}`, day: "2026-11-20", entries: [[L.acct.w(wid), -7], [L.acct.burn(sid), 7]] }); });
    await inTx(pool, async (c) => { const sid = await L.sidOf(c, SPACE); const wid = await L.widOfUser(c, sid, CY); await c.query("UPDATE play_wallets SET side_earned = 0 WHERE wid = $1", [wid]); });
    await inTx(pool, async (c) => { const sid = await L.sidOf(c, SPACE); await c.query("UPDATE play_space_economy SET settings = settings - 'side_day_max' WHERE sid = $1", [sid]); });
    secret = 33;
    // the day max: CY in a space whose side_day_max is 4
    await inTx(pool, async (c) => { const sid = await L.sidOf(c, SPACE); await c.query("UPDATE play_space_economy SET settings = settings || '{\"side_day_max\": 4}' WHERE sid = $1", [sid]); });
    const r1 = await http("POST", "/side/tune", { space: SPACE }, S[CY]);
    assert.equal((await guess(CY, r1.body.run, 33)).body.paid, 3);
    const r2 = await http("POST", "/side/tune", { space: SPACE }, S[CY]);
    assert.equal((await guess(CY, r2.body.run, 33)).body.paid, 1, "clipped to what's left of the day max");
    const r3 = await http("POST", "/side/tune", { space: SPACE }, S[CY]);
    assert.equal(r3.status, 409); assert.equal(r3.body.code, "day-max");
    // the tombstone keeps the side counters: delete + rejoin doesn't refill the day
    assert.equal((await http("DELETE", `/wallet?space=${sp}`, null, S[CY])).status, 204);
    await signIn(CY);
    assert.equal((await http("POST", "/wallet", { space: SPACE }, S[CY])).status, 201);
    assert.equal((await me(CY)).side.left_today, 0);
    assert.equal((await http("POST", "/side/tune", { space: SPACE }, S[CY])).body.code, "day-max");
    // the switch: side_on false → side-off; no wallet → no-wallet
    await inTx(pool, async (c) => { const sid = await L.sidOf(c, SPACE); await c.query("UPDATE play_space_economy SET settings = settings || '{\"side_on\": false}' WHERE sid = $1", [sid]); });
    assert.equal((await http("POST", "/side/tune", { space: SPACE }, S[ANA])).body.code, "side-off");
    assert.equal((await me(ANA)).side.reason, "off");
    assert.equal((await http("POST", "/side/tune", { space: RICH }, S[ANA])).body.code, "no-wallet");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});
