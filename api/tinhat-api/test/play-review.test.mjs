// The platform review round (astra, 11-19): each fix with a test that fails on the code before it. Real Postgres
// (PLAY_TEST_DB_URL; skipped without it), fake room/space state, the real engines.
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
import { createSampler } from "../play/sampler.mjs";

const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL";
const DBNAME = `games_s1_r${process.pid}`;
const SN = "play.test";
const S1 = "!space-one:play.test", S2 = "!space-two:play.test", FOREIGN = "!far-space:other.test";
const R1 = "!room-one:play.test", R2 = "!room-two:play.test", RF = "!room-far:play.test";
const U = (n) => `@player-r${n}:${SN}`;
let pool, play, server, base, wsUrl, clock = Date.parse("2026-11-19T20:00:00Z");
const now = () => clock;
const cfg = { ...rules.configFromEnv({}), tz: "UTC" };
const everyone = new Set([1, 2, 3, 4, 5, 6].map(U));
const inCall = new Set([1, 2, 3, 4, 5].map(U)); // U(6) is joined but joins the call later
const R3 = "!room-three:play.test", R4 = "!room-four:play.test";
const notInFar = U(5);

function world() {
    const cache = new Map(); // like the real resolver: a non-fresh read may be a cached (older) answer
    const resolve = async (room, { fresh = false } = {}) => {
        if (!fresh && cache.has(room)) return cache.get(room);
        const v = live(room); cache.set(room, v); return v;
    };
    const live = (room) => {
        const sessions = [...inCall].map((u) => ({ sender: u }));
        if (room === "!room-seven:play.test") return { space: S1, server: SN, why: "", room: { joined: new Set(everyone), sessions }, spaceJoined: new Set(everyone) };
        if (room === "!room-six:play.test") return { space: S1, server: SN, why: "", room: { joined: everyone, sessions }, spaceJoined: everyone };
        if (room === "!room-five:play.test") return { space: S1, server: SN, why: "", room: { joined: everyone, sessions }, spaceJoined: everyone };
        if (room === R4) return { space: S1, server: SN, why: "", room: { joined: everyone, sessions }, spaceJoined: everyone };
        if (room === R3) return { space: S1, server: SN, why: "", room: { joined: everyone, sessions }, spaceJoined: everyone };
        if (room === R1) return { space: S1, server: SN, why: "", room: { joined: everyone, sessions }, spaceJoined: everyone };
        if (room === R2) return { space: S2, server: SN, why: "", room: { joined: everyone, sessions }, spaceJoined: everyone };
        if (room === RF) return { space: FOREIGN, server: "other.test", why: "wrong-server", room: { joined: everyone, sessions }, spaceJoined: new Set([...everyone].filter((u) => u !== notInFar)) };
        return { space: null, server: null, why: "no-space", room: { joined: new Set(), sessions: [] }, spaceJoined: new Set() };
    };
    return { resolve, forget: () => {} };
}
async function start({ recoverFirst = true } = {}) {
    play = createPlay({ pool, cfg, spaces: world(), spaceInfo: async (sp) => ([S1, S2].includes(sp) ? { owner: SN, joined: new Set(everyone) } : null), serverName: SN, salt: "r-salt",
        resolveOpenId: async ({ openid, user_id }) => (openid.access_token === `ok:${user_id}` ? user_id : null), now, log: () => {}, flags: () => ({ play: true, rig_phone_apps: false }), debug: process.env.PLAY_DEBUG ? (x) => console.error(x) : undefined });
    if (recoverFirst) await play.recover();
    const app = express(); const r = express.Router(); play.routes(r); app.use(r);
    server = createServer(app); play.attach(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/v1`; wsUrl = `ws://127.0.0.1:${server.address().port}/v1/ws`;
}
async function stop() { server.close(); server.closeAllConnections?.(); await settle(100); } // (upgraded sockets aren't waited for)
before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 10 });
    await migrate(pool);
    await start();
});
after(async () => {
    if (skip) return;
    await stop().catch(() => {}); await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});
async function http(method, path, body, session) {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Play ${session}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
}
const signIn = async (u) => (await http("POST", "/session", { openid: { access_token: `ok:${u}`, matrix_server_name: SN, token_type: "Bearer", expires_in: 60 }, user_id: u, client: { kind: "web" } })).body.session;
let opn = 0;
async function sock(session) {
    const ws = new WebSocket(wsUrl); const frames = []; const waiters = [];
    ws.addEventListener("message", (e) => { const f = JSON.parse(e.data); frames.push(f); for (const w of [...waiters]) if (w.p(f)) { waiters.splice(waiters.indexOf(w), 1); w.ok(f); } });
    await once(ws, "open");
    const c = { ws, frames, send: (f) => ws.send(JSON.stringify(f)), wait: (p, ms = 4000) => new Promise((ok, no) => { const hit = frames.find(p); if (hit) return ok(hit); waiters.push({ p, ok }); setTimeout(() => no(new Error("timeout")), ms); }) };
    c.act = async (table, a, at, op = `games-s1-rev-${String(++opn).padStart(6, "0")}`) => {
        const from = frames.length; // only an ack that arrives after this send (a resent op's first ack is history)
        c.send({ t: "act", table, op, ...(at ? { at } : {}), a });
        return c.wait((f) => f.t === "ack" && f.op === op && frames.indexOf(f) >= from);
    };
    c.send({ t: "auth", session, client: { kind: "web" } }); await c.wait((f) => f.t === "hello");
    return c;
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("one table at a time per PERSON across spaces (a Rig seat in one space refuses a Hold'em seat in another)", { skip }, async () => {
    const a = U(1), b = U(2), c = U(3);
    const S = {}; for (const u of [a, b, c]) { S[u] = await signIn(u); for (const sp of [S1, S2]) await http("POST", "/wallet", { space: sp }, S[u]); }
    const rig = (await http("POST", `/rooms/${encodeURIComponent(R1)}/tables`, { game: "rig", space: S1, opts: { preset: "lite" } }, S[a])).body.table;
    const hold = (await http("POST", `/rooms/${encodeURIComponent(R2)}/tables`, { game: "holdem", space: S2, opts: { seats: 8 } }, S[b])).body.table;
    const ca = await sock(S[a]);
    ca.send({ t: "open", table: hold }); await ca.wait((f) => f.t === "view");
    const r = await ca.act(hold, { do: "sit", space: S2 });
    assert.equal(r.code, "seated-elsewhere", "the Rig host (seated in space one) can't sit in space two");
    const cb = await sock(S[b]); cb.send({ t: "open", table: rig }); await cb.wait((f) => f.t === "view");
    const cc = await sock(S[c]); cc.send({ t: "open", table: hold }); await cc.wait((f) => f.t === "view");
    // b joins the Rig AND sits at Hold'em at the same moment: exactly one of the two may win
    const [x, y] = await Promise.all([cb.act(rig, { do: "join", space: S1 }), cb.act(hold, { do: "sit", space: S2 })]);
    assert.equal([x.ok, y.ok].filter(Boolean).length, 1, `exactly one seat (join ${x.code || "ok"}, sit ${y.code || "ok"})`);
    const { rows } = await pool.query("SELECT person, count(*)::int AS n FROM play_seats WHERE active GROUP BY person HAVING count(*) > 1");
    assert.deepEqual(rows, [], "no person holds two active seats");
    for (const k of [ca, cb, cc]) k.ws.close();
});

test("a resent op is answered from the durable receipt even after the in-memory cache is gone (no second sit)", { skip }, async () => {
    const d = U(4);
    const s = await signIn(d); await http("POST", "/wallet", { space: S2 }, s);
    let hold = (await http("GET", `/rooms/${encodeURIComponent(R2)}/tables`, null, s)).body.tables.find((t) => t.game === "holdem")?.table;
    if (!hold) hold = (await http("POST", `/rooms/${encodeURIComponent(R2)}/tables`, { game: "holdem", space: S2, opts: { seats: 8 } }, s)).body.table;
    const c = await sock(s); c.send({ t: "open", table: hold }); await c.wait((f) => f.t === "view");
    const op = "games-s1-rev-sit-once-0001";
    const first = await c.act(hold, { do: "sit", space: S2 }, null, op);
    assert.equal(first.ok, true, JSON.stringify(first));
    if (process.env.PLAY_DEBUG) console.error("ops after sit:", JSON.stringify((await pool.query("SELECT table_id = $1 AS same, op_id, answer FROM play_ops", [hold])).rows));
    assert.equal((await c.act(hold, { do: "leave" })).ok, true);
    await settle();
    play._tables.get(hold).acks.clear(); // as if 5 000 other answers had pushed it out
    const again = await c.act(hold, { do: "sit", space: S2 }, null, op);
    assert.deepEqual([again.ok, again.dup, again.code], [true, true, ""], `the stored answer, dup (got ${JSON.stringify(again)})`);
    const seated = (await pool.query("SELECT count(*)::int AS n FROM play_seats WHERE active AND table_id = $1 AND wid = (SELECT wid FROM play_people WHERE user_id = $2)", [hold, d])).rows[0].n;
    assert.equal(seated, 0, "the resend did not sit them again");
    c.ws.close();
});

test("a socket's session is checked on every frame (an expired session gets bye session)", { skip }, async () => {
    const s = await signIn(U(5));
    const c = await sock(s);
    for (const v of play._sessions.values()) if (v.user === U(5)) v.exp = clock - 1;
    c.send({ t: "ping" });
    const f = await c.wait((x) => x.t === "bye" || x.t === "pong");
    assert.deepEqual(f, { t: "bye", code: "session" });
});

test("wrong-server names the space only to members of that space (a room member outside it gets not-member)", { skip }, async () => {
    const inS = await signIn(U(1)), outS = await signIn(notInFar);
    const a = await http("GET", `/rooms/${encodeURIComponent(RF)}/space`, null, inS);
    assert.deepEqual([a.status, a.body.code, a.body.server], [403, "wrong-server", "other.test"]);
    const b = await http("GET", `/rooms/${encodeURIComponent(RF)}/space`, null, outS);
    assert.deepEqual([b.status, b.body.code, b.body.space, b.body.server], [403, "not-member", undefined, undefined]);
});

test("before recovery has finished, routes and sockets answer db (no table can start during a restart's cleanup)", { skip }, async () => {
    await stop();
    await start({ recoverFirst: false });
    const r = await http("POST", "/session", { openid: { access_token: `ok:${U(1)}`, matrix_server_name: SN, token_type: "Bearer", expires_in: 60 }, user_id: U(1), client: { kind: "web" } });
    assert.deepEqual([r.status, r.body.code], [503, "db"]);
    await play.recover();
    assert.equal((await http("POST", "/session", { openid: { access_token: `ok:${U(1)}`, matrix_server_name: SN, token_type: "Bearer", expires_in: 60 }, user_id: U(1), client: { kind: "web" } })).status, 200);
});

test("recovery runs the prestige check for a Rig player it removes (escrow back, then one leave)", { skip }, async () => {
    const sid = await inTx(pool, (c) => L.ensureSpace(c, S1, SN));
    const u = "@player-r9:play.test";
    const wid = (await inTx(pool, (c) => L.createWallet(c, { sid, user: u, cfg, salt: "r-salt" }))).wid;
    await inTx(pool, async (c) => {
        await L.post(c, { sid, kind: "start", idem: `seed-r9`, day: "2026-11-19", entries: [[L.acct.mint("start", sid), -130], [L.acct.w(wid), 130]] });
        await c.query("INSERT INTO play_tables (id, game, room, space_id, sid, owner, opts, state) VALUES ('tRrecoveryTest01', 'rig', $1, $2, $3, $4, '{}', '{}')", [R1, S1, sid, SN]);
        await c.query("INSERT INTO play_games (id, table_id, sid, kind, n) VALUES ('tRrecoveryTest01:1', 'tRrecoveryTest01', $1, 'round', 1)", [sid]);
        await L.move(c, { sid, kind: "rig-escrow", idem: "esc-r9", cfg, from: L.acct.w(wid), to: L.acct.esc("tRrecoveryTest01", 1, "bankroll", wid), amount: 6 });
    });
    await stop(); await start();
    const w = (await pool.query("SELECT rank FROM play_wallets WHERE wid = $1", [wid])).rows[0];
    const bal = await inTx(pool, (c) => L.balance(c, L.acct.w(wid)));
    assert.deepEqual({ rank: w.rank, bal }, { rank: 1, bal: 10 }, "140 at rank 0 (cap 100) → prestige: 10, rank 1");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("someone who joins the call just after the room's state was cached can open the table at once (lab7, 11:46)", { skip }, async () => {
    const host = U(1), late = U(6);
    const sh = await signIn(host), sl = await signIn(late);
    await http("POST", "/wallet", { space: S1 }, sh); await http("POST", "/wallet", { space: S1 }, sl);
    const t = await http("POST", `/rooms/${encodeURIComponent(R3)}/tables`, { game: "holdem", space: S1, opts: { seats: 8 } }, sh);
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.equal((await http("GET", `/rooms/${encodeURIComponent(R3)}/tables`, null, sl)).status, 200); // the room's state is now cached: late not in the call
    inCall.add(late); // late joins the call
    const c = await sock(sl);
    c.send({ t: "open", table: t.body.table });
    const f = await c.wait((x) => x.t === "view" || x.t === "error");
    assert.equal(f.t, "view", `opened at once (got ${JSON.stringify(f)})`);
    c.ws.close();
});

test("the sampler: someone in calls in two spaces can't be paid twice by switching which call is newest", { skip }, async () => {
    const A = "@player-r8:play.test", B = "@player-r7:play.test";
    const sids = {};
    for (const sp of [S1, S2]) { sids[sp] = await inTx(pool, (c) => L.ensureSpace(c, sp, SN)); for (const u of [A, B]) await inTx(pool, (c) => L.createWallet(c, { sid: sids[sp], user: u, cfg, salt: "s" })); }
    let flip = 0;
    const lk = { listRooms: async () => [{ name: R1 }, { name: R2 }], participants: async () => [{ identity: `${A}:D1`, tracks: [{ source: "MICROPHONE", muted: false }] }, { identity: `${B}:D2`, tracks: [{ source: "MICROPHONE", muted: false }] }] };
    const two = new Set([A, B]);
    const spaces = { resolve: async (room) => ({ space: room === R1 ? S1 : S2, server: SN, why: "", room: { joined: two, sessions: [A, B].map((u) => ({ sender: u, createdTs: (room === R1) === (flip % 2 === 0) ? 2 : 1 })), away: new Set() }, spaceJoined: two }) };
    const s = createSampler({ pool, cfg, lk, spaces, now: () => clock, log: () => {} });
    const total = async () => { let t = 0; for (const sp of [S1, S2]) { const { rows } = await pool.query("SELECT w.accrual_s, w.earned_today FROM play_wallets w JOIN play_people p ON p.wid = w.wid WHERE p.user_id = $1 AND p.sid = $2", [A, sids[sp]]); t += rows[0].accrual_s + rows[0].earned_today * 3600; } return t; };
    for (let i = 0; i <= 20; i++) { flip = i; await s.run(); clock += 60_000; }
    assert.equal(await total(), 20 * 60, "20 minutes in calls = 1 200 seconds credited in all, never more");
});

test("a spectator kicked from the room (or the space) stops getting the table's views (launch-gate 12:07: a privacy leak)", { skip }, async () => {
    const host = U(1), watcher = U(5);
    const sh = await signIn(host), sw = await signIn(watcher);
    await http("POST", "/wallet", { space: S1 }, sh);
    const T = (await http("POST", `/rooms/${encodeURIComponent(R4)}/tables`, { game: "holdem", space: S1, opts: { seats: 8 } }, sh)).body.table;
    assert.ok(T, "a fresh table");
    const hostSock = await sock(sh); hostSock.send({ t: "open", table: T }); await hostSock.wait((f) => f.t === "view");
    const w = await sock(sw); w.send({ t: "open", table: T }); await w.wait((f) => f.t === "view");
    everyone.delete(watcher); inCall.delete(watcher); // kicked from the room
    try {
        await (play.revalidateAll || (async () => {}))(); // (on a server without the re-check this is nothing: the test must then fail)
        const e = await w.wait((f) => f.t === "error" && f.table === T).catch(() => ({ code: "no error frame" }));
        assert.equal(e.code, "not-member");
        const before = w.frames.filter((f) => f.t === "view").length;
        const sp = await signIn(U(6)); await http("POST", "/wallet", { space: S1 }, sp);
        const p6 = await sock(sp); p6.send({ t: "open", table: T }); await p6.wait((f) => f.t === "view");
        const sat = await p6.act(T, { do: "sit", space: S1 }); // a public change the watcher would have seen
        assert.equal(sat.ok, true, JSON.stringify(sat));
        p6.ws.close();
        await settle(300);
        assert.equal(w.frames.filter((f) => f.t === "view").length, before, "no view after the kick");
    } finally { everyone.add(watcher); inCall.add(watcher); hostSock.ws.close(); w.ws.close(); }
});

test("round 2: twelve valid pings in ONE read are all answered (packetization never disconnects a well-behaved client)", { skip }, async () => {
    const { connect } = await import("node:net");
    const s = await signIn(U(2));
    const port = new URL(wsUrl).port;
    const sock2 = connect(Number(port), "127.0.0.1"); await once(sock2, "connect");
    const frame = (text) => { const p = Buffer.from(text); const key = Buffer.from([1, 2, 3, 4]); const hdr = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : (() => { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); return h; })(); return Buffer.concat([hdr, key, Buffer.from(p.map((b, i) => b ^ key[i & 3]))]); };
    let got = "";
    sock2.on("data", (d) => { got += d.toString("latin1"); });
    sock2.write("GET /v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await settle(100);
    sock2.write(frame(JSON.stringify({ t: "auth", session: s, client: { kind: "web" } })));
    await settle(150);
    sock2.write(Buffer.concat(Array.from({ length: 12 }, () => frame('{"t":"ping"}'))));
    await settle(400);
    sock2.destroy();
    assert.equal((got.match(/"t":"pong"/g) || []).length, 12, "every ping answered");
    assert.ok(!/"t":"bye"/.test(got), "no bye");
});

test("round 2: the journal pages through earnings that share one midnight (a composite cursor)", { skip }, async () => {
    const sid = await inTx(pool, (c) => L.ensureSpace(c, "!journal-space:play.test", SN));
    const wid = (await inTx(pool, (c) => L.createWallet(c, { sid, user: "@player-j:play.test", cfg, salt: "s" }))).wid;
    await inTx(pool, async (c) => {
        for (let i = 1; i <= 60; i++) await L.post(c, { sid, kind: "earn", idem: `earn:${wid}:2026-11-19:${i}`, day: "2026-11-19", at: new Date("2026-11-19T00:00:00Z"), entries: [[L.acct.mint("earn", sid), -1], [L.acct.w(wid), 1]] });
    });
    const seen = new Set(); let before = null;
    for (let page = 0; page < 5; page++) {
        const j = await inTx(pool, (c) => L.journal(c, { wid, before, limit: 50 }));
        for (const e of j.entries) seen.add(e.tx);
        if (!j.next) break;
        before = j.next;
    }
    assert.equal(seen.size, 61, "60 earnings + the start, none lost between pages");
});

test("round 2: a restart scrubs Whisper words from the tables it closes (state and round logs)", { skip }, async () => {
    const sid = await inTx(pool, (c) => L.ensureSpace(c, S2, SN));
    await pool.query("INSERT INTO play_tables (id, game, room, space_id, sid, owner, opts, state) VALUES ('tRwhisperScrub01', 'rig', $1, $2, $3, $4, '{}', $5)", [R2, S2, sid, SN, JSON.stringify({ host: "w1", rounds: 1, round: { whispers: [{ who: "w2", text: "gs1 scrub me" }] } })]);
    await pool.query("INSERT INTO play_games (id, table_id, sid, kind, n, disposition, log) VALUES ('tRwhisperScrub01:1', 'tRwhisperScrub01', $1, 'round', 1, 'settled', $2)", [sid, JSON.stringify({ reveal: { whispers: [{ who: "w2", spin: 2, text: "gs1 scrub me" }] } })]);
    await stop(); await start();
    for (const q of ["SELECT count(*)::int AS n FROM play_tables WHERE state::text LIKE '%gs1 scrub me%'", "SELECT count(*)::int AS n FROM play_games WHERE log::text LIKE '%gs1 scrub me%'"]) {
        assert.equal((await pool.query(q)).rows[0].n, 0, q);
    }
});

test("round 2: a view is never pushed to a socket whose session expired (bye session instead)", { skip }, async () => {
    const sa = await signIn(U(3)), sb = await signIn(U(4));
    for (const s2 of [sa, sb]) await http("POST", "/wallet", { space: S1 }, s2);
    const T = (await http("POST", `/rooms/${encodeURIComponent("!room-five:play.test")}/tables`, { game: "holdem", space: S1, opts: { seats: 8 } }, sa)).body.table
        || (await http("GET", `/rooms/${encodeURIComponent(R4)}/tables`, null, sa)).body.tables[0]?.table;
    assert.ok(T, "a table");
    const a = await sock(sa); a.send({ t: "open", table: T }); await a.wait((f) => f.t === "view");
    const b = await sock(sb); b.send({ t: "open", table: T }); await b.wait((f) => f.t === "view");
    for (const v of play._sessions.values()) if (v.user === U(3)) v.exp = clock - 1;
    const n0 = a.frames.filter((f) => f.t === "view").length;
    b.send({ t: "close", table: T }); b.send({ t: "open", table: T }); // something that pushes views to everyone
    const f = await a.wait((x) => x.t === "bye" || (x.t === "view" && a.frames.filter((y) => y.t === "view").length > n0), 3000).catch(() => null);
    assert.ok(f && f.t === "bye", `bye session, not a view (got ${JSON.stringify(f)})`);
    a.ws.close(); b.ws.close();
});

test("lab grant: refused without TINHAT_LAB=1; with it, journalled as lab-grant from mint:lab and the audit stays clean", { skip }, async () => {
    const sid = await inTx(pool, (c) => L.ensureSpace(c, "!lab-grant-space:play.test", SN));
    const wid = (await inTx(pool, (c) => L.createWallet(c, { sid, user: "@player-g:play.test", cfg, salt: "s" }))).wid;
    const no = await inTx(pool, (c) => L.labGrant(c, { env: {}, sid, wid, n: 100, cfg }));
    assert.deepEqual([no.ok, no.code], [false, "refused"]);
    const no2 = await inTx(pool, (c) => L.labGrant(c, { env: { TINHAT_LAB: "true" }, sid, wid, n: 100, cfg }));
    assert.equal(no2.ok, false, "only exactly 1");
    assert.equal(await inTx(pool, (c) => L.balance(c, L.acct.w(wid))), 10, "nothing granted");
    const yes = await inTx(pool, (c) => L.labGrant(c, { env: { TINHAT_LAB: "1" }, sid, wid, n: 140, cfg }));
    assert.equal(yes.ok, true);
    assert.equal(await inTx(pool, (c) => L.balance(c, L.acct.w(wid))), 150);
    const j = await inTx(pool, (c) => L.journal(c, { wid }));
    assert.equal(j.entries[0].reason, "lab-grant");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("an earned chip pushes the person's wallet frame (with earned_today) to their own sockets only", { skip }, async () => {
    const me = U(2), other = U(3);
    const sm = await signIn(me), so = await signIn(other);
    await http("POST", "/wallet", { space: S1 }, sm);
    const cm = await sock(sm), co = await sock(so);
    const sid = (await pool.query("SELECT sid FROM play_spaces WHERE space_id = $1", [S1])).rows[0].sid;
    const wid = (await pool.query("SELECT wid FROM play_people WHERE user_id = $1 AND sid = $2", [me, sid])).rows[0].wid;
    await inTx(pool, (c) => c.query("UPDATE play_wallets SET earned_today = 3, day = $2 WHERE wid = $1", [wid, rules.dayOf(clock, cfg.tz)]));
    await play.pushWalletFor(wid, Number(sid));
    const f = await cm.wait((x) => x.t === "wallet");
    assert.equal(f.space, S1); assert.equal(f.earned_today, 3);
    await settle(200);
    assert.ok(!co.frames.some((x) => x.t === "wallet" && x.space === S1), "nobody else gets it");
    cm.ws.close(); co.ws.close();
});

test("someone who joins the room and space after the last membership snapshot can open the table at once (lab7, 12:29)", { skip }, async () => {
    const host = U(1), fresh = "@player-fresh:play.test";
    const sh = await signIn(host);
    const T = (await http("POST", `/rooms/${encodeURIComponent("!room-six:play.test")}/tables`, { game: "holdem", space: S1, opts: { seats: 8 } }, sh)).body.table;
    assert.ok(T, "a table");
    const hs = await sock(sh); hs.send({ t: "open", table: T }); await hs.wait((x) => x.t === "view");
    await (play.revalidateAll || (async () => {}))(); // a snapshot without the newcomer
    everyone.add(fresh); inCall.add(fresh); // joins the room, the space and the call
    try {
        const sf = await signIn(fresh); await http("POST", "/wallet", { space: S1 }, sf);
        const c = await sock(sf); c.send({ t: "open", table: T });
        const f = await c.wait((x) => x.t === "view" || x.t === "error");
        assert.equal(f.t, "view", `opened (got ${JSON.stringify(f)})`);
        const sat = await c.act(T, { do: "sit", space: S1 });
        assert.equal(sat.ok, true, JSON.stringify(sat));
        const v = await c.wait((x) => x.t === "view" && x.view.you?.seat);
        assert.ok(v.view.you.seat >= 1, "seated, and the view says so");
        c.ws.close();
    } finally { everyone.delete(fresh); inCall.delete(fresh); hs.ws.close(); }
});

test("round 3: a seated player who left the room is NOT dealt into the next hand (they leave first)", { skip }, async () => {
    const host = "@player-h3:play.test", gone = "@player-g3:play.test", third = "@player-t3:play.test";
    for (const u of [host, gone, third]) { everyone.add(u); inCall.add(u); }
    try {
        const S = {}; for (const u of [host, gone, third]) { S[u] = await signIn(u); await http("POST", "/wallet", { space: S1 }, S[u]); }
        const T = (await http("POST", `/rooms/${encodeURIComponent("!room-seven:play.test")}/tables`, { game: "holdem", space: S1, opts: { seats: 8 } }, S[host])).body.table;
        assert.ok(T, "a table");
        const cs = {}; for (const u of [host, gone, third]) { cs[u] = await sock(S[u]); cs[u].send({ t: "open", table: T }); await cs[u].wait((f) => f.t === "view"); assert.equal((await cs[u].act(T, { do: "sit", space: S1 })).ok, true); }
        everyone.delete(gone); inCall.delete(gone); // leaves the room
        const d = await cs[host].act(T, { do: "deal" });
        assert.equal(d.ok, true, JSON.stringify(d));
        const v = await cs[host].wait((f) => f.t === "view" && f.view.hand);
        const goneSeat = v.view.seats.find((s) => s.u === gone);
        assert.ok(!goneSeat || goneSeat.cards === 0, `the departed player holds no cards (${JSON.stringify(goneSeat)})`);
        for (const c of Object.values(cs)) c.ws.close();
    } finally { for (const u of [host, third]) { everyone.delete(u); inCall.delete(u); } }
});

test("round 3: an expired session gets no wallet push (bye session instead)", { skip }, async () => {
    const u = U(2); const s = await signIn(u);
    const c = await sock(s);
    const sid = (await pool.query("SELECT sid FROM play_spaces WHERE space_id = $1", [S1])).rows[0].sid;
    const wid = (await pool.query("SELECT wid FROM play_people WHERE user_id = $1 AND sid = $2", [u, sid])).rows[0].wid;
    for (const v of play._sessions.values()) if (v.user === u) v.exp = clock - 1;
    await play.pushWalletFor(wid, Number(sid));
    const f = await c.wait((x) => x.t === "wallet" || x.t === "bye", 2000).catch(() => null);
    assert.ok(f && f.t === "bye", `bye, not a wallet frame (got ${JSON.stringify(f)})`);
});
