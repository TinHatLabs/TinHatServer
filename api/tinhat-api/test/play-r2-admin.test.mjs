// games-s2, polish round 2: F8 the admin money API (GAMES-V1.1-ADDENDUM §5) on a real Postgres (PLAY_TEST_DB_URL;
// skipped without it) through the real HTTP routes, with fake room/space state: who is an admin, grant / remove / set /
// reset / rank, open money, all-or-nothing, the durable op receipt, the economy per space (and the earn it changes),
// the log + why-text, notices, the audit staying clean. Written failing-first against 0.3.20 (no admin routes).
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
const DBNAME = `games_s2_adm_${process.pid}`;
const SERVER = "play.test";
const SPACE = "!adm-space:play.test";
const OTHER = "!adm-elsewhere:other.example"; // kept by another server
const ROOM = "!adm-room:play.test";
const ADM = "@adm-admin:play.test"; // power level 100 in the space
const OWN = "@adm-owner:play.test"; // a Synapse server admin here, plain member of the space
const MOD = "@adm-mod:play.test"; // power level 50: not an admin
const [ANA, BEN, CY] = ["@adm-ana:play.test", "@adm-ben:play.test", "@adm-cy:play.test"];
const OUT = "@adm-outsider:play.test";

let clock = Date.parse("2026-11-20T20:00:00Z");
const now = () => clock;
let pool, play, server, base;
const levels = { [ADM]: 100, [MOD]: 50 };

before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN_DB }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN_DB.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 10 });
    await migrate(pool);
    const joined = new Set([ADM, OWN, MOD, ANA, BEN, CY]);
    const resolve = async () => ({ space: SPACE, server: SERVER, why: "", room: { joined: new Map([...joined].map((x) => [x, x])), sessions: [...joined].map((x) => ({ sender: x, device: "D" })) }, spaceJoined: joined });
    play = createPlay({
        pool, cfg: { ...rules.configFromEnv({}), tz: "America/Los_Angeles" }, spaces: { resolve, forget: () => {} },
        spaceInfo: async (s) => (s === SPACE ? { owner: SERVER, joined, levelOf: (x) => levels[x] ?? 0 } : s === OTHER ? { owner: "other.example", joined, levelOf: () => 100 } : null),
        isServerAdmin: async (x) => x === OWN,
        serverName: SERVER, salt: "test-salt", now, log: () => {}, flags: () => ({ play: true, rig_phone_apps: true }),
        resolveOpenId: async ({ openid, user_id }) => (openid.access_token === `ok:${user_id}` ? user_id : null),
    });
    await play.recover();
    const app = express(); app.set("trust proxy", "loopback");
    const r = express.Router(); play.routes(r); app.use(r);
    server = createServer(app); play.attach(server);
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
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return (S[user] = s.body.session);
}
let opn = 0;
const op = () => `games-s2-adm-${String(++opn).padStart(6, "0")}`;
const sp = encodeURIComponent(SPACE);
const W = (who, action, amount, extra = {}) => ({ op: op(), action, who, ...(amount !== undefined ? { amount } : {}), ...extra });
const me = async (u) => (await http("GET", `/me?space=${sp}`, null, S[u])).body;

test("F8: who is an admin: power level 100 in the space or the server owner; others not-admin; another server's space wrong-server", { skip }, async () => {
    for (const u of [ADM, OWN, MOD, ANA, BEN, CY, OUT]) await signIn(u);
    for (const u of [ANA, BEN, CY]) assert.equal((await http("POST", "/wallet", { space: SPACE }, S[u])).status, 201);
    const g = await http("GET", `/admin/spaces/${sp}`, null, S[ADM]);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.deepEqual(g.body.you, { admin: true, why: "space-admin" });
    fits("adminSpace", g.body);
    assert.equal((await http("GET", `/admin/spaces/${sp}`, null, S[OWN])).body.you.why, "server-owner");
    assert.equal((await http("GET", `/admin/spaces/${sp}`, null, S[MOD])).body.code, "not-admin");
    assert.equal((await http("GET", `/admin/spaces/${sp}`, null, S[ANA])).status, 403);
    assert.equal((await http("GET", `/admin/spaces/${sp}`, null, S[OUT])).body.code, "not-member");
    assert.equal((await http("GET", `/admin/spaces/${encodeURIComponent(OTHER)}`, null, S[ADM])).body.code, "wrong-server");
    assert.equal((await http("POST", `/admin/spaces/${sp}/wallets`, W([ANA], "grant", 5), S[MOD])).body.code, "not-admin");
    // the economy at the v1.1 defaults; wallets of current members only, balances
    assert.deepEqual(g.body.economy.chip_minutes, { value: 15, source: "default" });
    assert.deepEqual(g.body.economy.day_max, { value: 16, source: "default" });
    assert.deepEqual(g.body.wallets.map((w) => [w.u, w.balance, w.rank, w.cap, w.open]).sort(), [[ANA, 10, 0, 100, false], [BEN, 10, 0, 100, false], [CY, 10, 0, 100, false]]);
});

test("F8: grant / remove / set / reset / rank: journal transactions (mint:admin / burn:admin), the log, notices, the audit clean", { skip }, async () => {
    const g = await http("POST", `/admin/spaces/${sp}/wallets`, W([ANA, BEN], "grant", 5, { reason: "birthday" }), S[ADM]);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.deepEqual(g.body.done.map((x) => [x.u, x.before.balance, x.after.balance]).sort(), [[ANA, 10, 15], [BEN, 10, 15]]);
    fits("adminWallets", g.body);
    assert.equal((await me(ANA)).balance, 15);
    const rm = await http("POST", `/admin/spaces/${sp}/wallets`, W([ANA], "remove", 100), S[ADM]);
    assert.deepEqual(rm.body.done[0].after, { balance: 0, rank: 0 }, "remove takes at most the balance");
    assert.equal((await http("POST", `/admin/spaces/${sp}/wallets`, W([BEN], "set", 250), S[OWN])).body.done[0].after.balance, 250, "set above the cap is allowed");
    assert.equal((await http("POST", `/admin/spaces/${sp}/wallets`, W([BEN], "reset"), S[ADM])).body.done[0].after.balance, 10, "reset = the space's start");
    assert.equal((await http("POST", `/admin/spaces/${sp}/wallets`, W([CY], "rank", 3), S[ADM])).body.done[0].after.rank, 3);
    const cyMe = await me(CY);
    assert.equal(cyMe.rank, 3); assert.equal(cyMe.cap, 250);
    // bounds and shapes
    for (const [b, code] of [[W([ANA], "grant", 0), "bad-amount"], [W([ANA], "grant", 10_001), "bad-amount"], [W([ANA], "set", 100_001), "bad-amount"], [W([ANA], "rank", 51), "bad-amount"],
        [W([ANA, ANA], "grant", 1), "bad"], [W([], "grant", 1), "bad"], [W([ANA], "explode", 1), "bad"], [W([ANA], "reset", 3), "bad-amount"],
        [W([ANA], "grant", 1, { reason: "hi @ben:play.test" }), "bad-reason"], [W([ANA], "grant", 1, { reason: "see https://x.example" }), "bad-reason"], [W([ANA], "grant", 1, { reason: "a\u0007b" }), "bad-reason"],
        [W([OUT], "grant", 1), "no-wallet"]]) {
        const r = await http("POST", `/admin/spaces/${sp}/wallets`, b, S[ADM]);
        assert.equal(r.body.code, code, `${JSON.stringify(b)} → ${JSON.stringify(r.body)}`);
    }
    // the log: newest first, who did what, the why-text; visible to admins only
    const log = await http("GET", `/admin/spaces/${sp}/log`, null, S[ADM]);
    assert.equal(log.status, 200);
    fits("adminLog", log.body);
    const first = log.body.entries.at(-1);
    assert.equal(first.action, "grant"); assert.equal(first.by, ADM); assert.equal(first.by_role, "space-admin"); assert.equal(first.reason, "birthday");
    assert.ok(log.body.entries.some((e) => e.by === OWN && e.by_role === "server-owner" && e.action === "set"));
    assert.equal((await http("GET", `/admin/spaces/${sp}/log`, null, S[ANA])).status, 403);
    // notices: ANA saw a grant (birthday) and a remove; then acknowledges them
    const m = await me(ANA);
    fits("me", m);
    assert.deepEqual(m.notices.items.map((n) => [n.action, n.amount, n.reason]), [["grant", 5, "birthday"], ["remove", 100, null]]);
    assert.equal(m.notices.more, 0);
    assert.equal((await http("POST", "/me/notices/seen", { space: SPACE, upto: m.notices.items.at(-1).id }, S[ANA])).body.seen, 2);
    assert.deepEqual((await me(ANA)).notices.items, []);
    // books: double-entry, every space sums to 0, admin chips only through mint:admin / burn:admin
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
    const { rows } = await pool.query("SELECT a.id, a.balance FROM play_accounts a WHERE a.id LIKE 'mint:admin:%' OR a.id LIKE 'burn:admin:%' ORDER BY a.id");
    const by = Object.fromEntries(rows.map((r) => [r.id.split(":")[0], Number(r.balance)]));
    assert.equal(by.mint, -(5 + 5 + 235), "minted: two grants of 5 + the set (ben 15 → 250)");
    assert.equal(by.burn, 15 + 240, "burned: the remove (ana's 15) + the reset (ben 250 → 10)");
});

test("F8: open money: a named list with someone at a table is refused whole (at-table); everyone skips them; a grant lands", { skip }, async () => {
    // BEN sits at a Hold'em table (open money)
    const T = (await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[BEN])).body.table;
    const ws = new WebSocket(base.replace("http", "ws") + "/ws");
    await once(ws, "open");
    const frames = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
    ws.send(JSON.stringify({ t: "auth", session: S[BEN], client: { kind: "web" } }));
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ t: "open", table: T }));
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ t: "act", table: T, op: "games-s2-adm-sit00001", a: { do: "sit", space: SPACE } }));
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(frames.some((f) => f.t === "ack" && f.ok), JSON.stringify(frames.slice(-3)));
    const g = await http("GET", `/admin/spaces/${sp}`, null, S[ADM]);
    const ben = g.body.wallets.find((w) => w.u === BEN);
    assert.deepEqual([ben.open, ben.balance], [true, null], "no balance shown for someone with open money");
    const before = (await pool.query("SELECT count(*)::int AS n FROM play_admin_log")).rows[0].n;
    const r = await http("POST", `/admin/spaces/${sp}/wallets`, W([ANA, BEN], "set", 50), S[ADM]);
    assert.equal(r.status, 409); assert.equal(r.body.code, "at-table"); assert.deepEqual(r.body.who, [BEN]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM play_admin_log")).rows[0].n, before, "all-or-nothing: no log row, nothing changed");
    assert.notEqual((await me(ANA)).balance, 50);
    const ev = await http("POST", `/admin/spaces/${sp}/wallets`, W("everyone", "set", 50), S[ADM]);
    assert.deepEqual(ev.body.skipped, [{ u: BEN, code: "at-table" }]);
    assert.ok(ev.body.done.every((x) => x.after.balance === 50));
    const gr = await http("POST", `/admin/spaces/${sp}/wallets`, W([BEN], "grant", 7), S[ADM]);
    assert.deepEqual(gr.body.done, [{ u: BEN, before: { granted: 7 }, after: { granted: 7 } }], "a grant to someone at a table shows only the grant");
    fits("adminWallets", gr.body); fits("adminWallets", ev.body); fits("httpError", r.body);
    ws.send(JSON.stringify({ t: "act", table: T, op: "games-s2-adm-leave0001", a: { do: "leave" } }));
    await new Promise((r) => setTimeout(r, 250));
    ws.close();
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("F8: the durable op receipt: a resend answers the first answer (dup); the same op with another request is op-reused", { skip }, async () => {
    const b = W([CY], "grant", 2);
    const r1 = await http("POST", `/admin/spaces/${sp}/wallets`, b, S[ADM]);
    const r2 = await http("POST", `/admin/spaces/${sp}/wallets`, b, S[ADM]);
    assert.equal(r2.body.dup, true); assert.deepEqual(r2.body.done, r1.body.done);
    const c1 = (await me(CY)).balance;
    assert.equal((await http("POST", `/admin/spaces/${sp}/wallets`, b, S[ADM])).body.dup, true);
    assert.equal((await me(CY)).balance, c1, "paid once");
    assert.equal((await http("POST", `/admin/spaces/${sp}/wallets`, { ...b, amount: 3 }, S[ADM])).body.code, "op-reused");
});

test("F8: the economy per space: set / reset with bounds, logged; /me and the cap follow; nothing retroactive", { skip }, async () => {
    const bad = await http("PUT", `/admin/spaces/${sp}/economy`, { op: op(), set: { day_max: 201 } }, S[ADM]);
    assert.equal(bad.status, 400); assert.deepEqual([bad.body.code, bad.body.key, bad.body.min, bad.body.max], ["bad-value", "day_max", 1, 200]);
    assert.equal((await http("PUT", `/admin/spaces/${sp}/economy`, { op: op(), set: { nope: 1 } }, S[ADM])).body.code, "bad");
    const ok = await http("PUT", `/admin/spaces/${sp}/economy`, { op: op(), set: { chip_minutes: 5, day_max: 40, cap_base: 60, start: 20 }, reason: "game night" }, S[ADM]);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.economy.chip_minutes, { value: 5, source: "space" });
    fits("adminEconomy", ok.body);
    const m = await me(ANA);
    assert.equal(m.chip_minutes, 5); assert.equal(m.chip_s, 300); assert.equal(m.day_max, 40); assert.equal(m.cap, 60);
    // reset puts the default back
    const rs = await http("PUT", `/admin/spaces/${sp}/economy`, { op: op(), reset: ["cap_base"] }, S[OWN]);
    assert.deepEqual(rs.body.economy.cap_base, { value: 100, source: "default" });
    const log = await http("GET", `/admin/spaces/${sp}/log?limit=2`, null, S[ADM]);
    assert.equal(log.body.entries.length, 2);
    assert.deepEqual(log.body.entries.map((e) => [e.action, e.who]), [["economy", "economy"], ["economy", "economy"]]);
    assert.equal(log.body.entries[1].reason, "game night");
    // a new wallet now opens with the space's start
    await signIn(OUT); // still not a member: no wallet possible
    assert.equal((await http("POST", "/wallet", { space: SPACE }, S[OUT])).body.code, "not-member");
});

test("F8: the admin log is append-only (UPDATE refused; DELETE only past 180 days); deleting a wallet drops its notices and why-texts", { skip }, async () => {
    await assert.rejects(pool.query("UPDATE play_admin_log SET amount = 1"), /append-only/);
    await assert.rejects(pool.query("DELETE FROM play_admin_log"), /retention/);
    const g = await http("POST", `/admin/spaces/${sp}/wallets`, W([CY], "grant", 1, { reason: "for cy" }), S[ADM]);
    assert.equal(g.status, 200);
    assert.equal((await http("DELETE", `/wallet?space=${sp}`, null, S[CY])).status, 204);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM play_admin_reasons WHERE text = 'for cy'");
    assert.equal(rows[0].n, 0, "the why-text about a deleted wallet is gone");
    const ops = await pool.query("SELECT count(*)::int AS n FROM play_admin_ops WHERE answer::text LIKE $1", [`%${CY}%`]);
    assert.equal(ops.rows[0].n, 0, "no stored admin answer names a deleted wallet's person (astra r1 #1)");
    const log = await http("GET", `/admin/spaces/${sp}/log`, null, S[ADM]);
    assert.ok(log.body.entries.some((e) => e.who === "someone" && e.action === "grant"), "the row stays, unlinked");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("F8: the audit checks admin changes against the log: a planted admin transaction without its log row turns it red", { skip }, async () => {
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
    const sid = (await pool.query("SELECT sid FROM play_spaces WHERE space_id = $1", [SPACE])).rows[0].sid;
    const wid = (await pool.query("SELECT wid FROM play_people WHERE user_id = $1", [ANA])).rows[0].wid;
    await inTx(pool, (c) => L.post(c, { sid: Number(sid), kind: "admin", idem: "admin:planted:1", ref: "alog:999999", day: "2026-11-20", entries: [[`mint:admin:${sid}`, -1], [L.acct.w(wid), 1]] }));
    const bad = await inTx(pool, (c) => L.audit(c));
    assert.ok(bad.some((x) => x.startsWith("admin transaction without its log row")), JSON.stringify(bad));
    // (the last block in this file: the journal is append-only, so the planted row stays)
});
