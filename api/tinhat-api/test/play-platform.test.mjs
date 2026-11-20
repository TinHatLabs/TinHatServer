// The play platform end to end on a real Postgres (PLAY_TEST_DB_URL; skipped without it) with fake room/space state:
// sessions, opt-in, tables, the socket, a full Hold'em hand and a full Rig round played by scripted clients through the
// real engines. EVERY frame each client receives is checked against the frozen contract schema and the privacy rules
// (no frame sent to a person carries another's secrets), the ledger audit is clean after each game, and a restart in the
// middle of a hand calls it off with every chip back.
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
import { leaks } from "../play/privacy.mjs";

const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL to run the platform tests";
const DBNAME = `games_s1_p${process.pid}`;
let pool;
const SERVER = "play.test";
const SPACE = "!lab-space:play.test";
const ROOM = "!lab-room:play.test";
const PEOPLE = ["@player-test1:play.test", "@player-test2:play.test", "@player-test3:play.test", "@player-test4:play.test"];
const SPECTATOR = "@player-test5:play.test";
const OUTSIDER = "@player-test6:play.test";
const RESTARTERS = ["@player-test7:play.test", "@player-test8:play.test"];

let clock = Date.parse("2026-11-19T20:00:00Z");
const now = () => clock;
const logs = [];

function fakeWorld() {
    const joined = new Set([...PEOPLE, SPECTATOR, ...RESTARTERS]);
    const inCall = new Set([...PEOPLE, SPECTATOR, ...RESTARTERS]);
    const resolve = async (room) => {
        if (!room.startsWith("!lab-room")) return { space: null, server: null, why: "no-space", room: { joined: new Set(), sessions: [] }, spaceJoined: new Set() };
        return { space: SPACE, server: SERVER, why: "", room: { joined, sessions: [...inCall].map((u) => ({ sender: u, device: "D" })) }, spaceJoined: joined };
    };
    return { spaces: { resolve, forget: () => {} }, spaceInfo: async (s) => (s === SPACE ? { owner: SERVER, joined } : null), joined, inCall };
}

let world, play, server, base, ws;
before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 10 });
    await migrate(pool);
    world = fakeWorld();
    await startPlay();
});
async function startPlay() {
    play = createPlay({
        pool, cfg: { ...rules.configFromEnv({}), tz: "America/Los_Angeles" }, spaces: world.spaces, spaceInfo: world.spaceInfo, serverName: SERVER, salt: "test-salt",
        resolveOpenId: async ({ openid, user_id }) => (openid.access_token === `ok:${user_id}` ? user_id : null),
        now, log: (s) => { logs.push(s); if (process.env.PLAY_DEBUG) console.error(s); }, flags: () => ({ play: true, rig_phone_apps: false }),
        debug: process.env.PLAY_DEBUG ? (s) => console.error("  " + s) : undefined,
    });
    await play.recover();
    const app = express();
    app.set("trust proxy", "loopback");
    const r = express.Router(); play.routes(r); app.use(r);
    server = createServer(app); play.attach(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/v1`; ws = `ws://127.0.0.1:${server.address().port}/v1/ws`;
}
async function stopPlay() { for (const c of clients) c.ws.close(); clients.length = 0; await new Promise((r) => server.close(r)); server.closeAllConnections?.(); }
after(async () => {
    if (skip) return;
    await stopPlay().catch(() => {});
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});

const H = (session) => ({ "Content-Type": "application/json", ...(session ? { Authorization: `Play ${session}` } : {}) });
async function http(method, path, body, session) {
    const r = await fetch(base + path, { method, headers: H(session), body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
}
const clients = [];
let opn = 0;
const op = () => `games-s1-plat-${String(++opn).padStart(6, "0")}`;
async function signIn(user, kind = "desktop") {
    const s = await http("POST", "/session", { openid: { access_token: `ok:${user}`, matrix_server_name: SERVER, token_type: "Bearer", expires_in: 3600 }, user_id: user, client: { kind } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return s.body.session;
}
async function connect(user, session, { kind = "desktop", pad = false } = {}) {
    const sock = new WebSocket(ws);
    const c = { user, ws: sock, frames: [], all: [], waiters: [] };
    sock.addEventListener("message", (e) => {
        const f = JSON.parse(e.data);
        c.all.push(f);
        for (const w of [...c.waiters]) if (w.pred(f)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.ok(f); return; }
        c.frames.push(f);
    });
    await once(sock, "open");
    sock.send(JSON.stringify({ t: "auth", session, client: { kind, pad } }));
    c.send = (f) => sock.send(JSON.stringify(f));
    c.wait = (pred, ms = 10000) => new Promise((ok, no) => {
        const i = c.frames.findIndex(pred); if (i >= 0) { const [f] = c.frames.splice(i, 1); return ok(f); }
        const w = { pred, ok: (f) => { clearTimeout(t); ok(f); } };
        const t = setTimeout(() => { c.waiters.splice(c.waiters.indexOf(w), 1); no(new Error(`${user}: no matching frame (last: ${JSON.stringify(c.all.slice(-2)).slice(0, 400)})`)); }, ms);
        c.waiters.push(w);
    });
    c.latestView = (table) => { const vs = c.all.filter((f) => f.t === "view" && f.table === table); return vs.length ? vs[vs.length - 1].view : null; };
    c.act = async (table, a, at) => {
        const o = op(); c.send({ t: "act", table, op: o, ...(at ? { at } : {}), a });
        try { return await c.wait((f) => f.t === "ack" && f.op === o); }
        catch (e) { throw new Error(`${user} ${JSON.stringify(a)} at ${JSON.stringify(at)}: no ack; server log: ${logs.slice(-5).join(" | ").slice(0, 1500)}`); }
    };
    await c.wait((f) => f.t === "hello");
    clients.push(c);
    return c;
}
/** Every frame every client got: the contract schema, and (views) the privacy rules for that client. */
function checkAllFrames() {
    let n = 0;
    for (const c of clients) for (const f of c.all) {
        assert.deepEqual(validate(SCHEMA, { $ref: "#/$defs/serverFrame" }, f), [], `${c.user} got a ${f.t} frame outside the contract`);
        if (f.t === "view") { assert.deepEqual(leaks(f.view.game, f.view, c.user), [], `${c.user} view ${f.view.game} vseq ${f.vseq}`); n++; }
    }
    assert.equal(logs.filter((l) => /BUG/.test(l)).length, 0, logs.filter((l) => /BUG/.test(l)).join("\n"));
    return n;
}
async function settle(ms = 150) { await new Promise((r) => setTimeout(r, ms)); }

test("sessions, opt-in and access: OpenID → session; wallet per space; the space endpoint; outsiders and guests refused", { skip }, async () => {
    assert.equal((await http("POST", "/session", { openid: { access_token: "bad", matrix_server_name: SERVER, token_type: "Bearer", expires_in: 1 }, user_id: PEOPLE[0], client: { kind: "web" } })).status, 401);
    assert.equal((await http("POST", "/session", { openid: { access_token: "ok:@guest-1:play.test", matrix_server_name: SERVER, token_type: "Bearer", expires_in: 1 }, user_id: "@guest-1:play.test", client: { kind: "web" } })).body.code, "guest");
    const s = await signIn(PEOPLE[0]);
    assert.equal((await http("GET", `/me?space=${encodeURIComponent(SPACE)}`, null, s)).body.code, "no-wallet");
    const w = await http("POST", "/wallet", { space: SPACE }, s);
    assert.equal(w.status, 201); assert.deepEqual(validate(SCHEMA, { $ref: "#/$defs/me" }, w.body), []); assert.equal(w.body.balance, 10);
    assert.equal((await http("POST", "/wallet", { space: SPACE }, s)).status, 200);
    const sp = await http("GET", `/rooms/${encodeURIComponent(ROOM)}/space`, null, s);
    assert.deepEqual(sp.body, { space: SPACE, server: SERVER });
    const out = await signIn(OUTSIDER);
    assert.equal((await http("GET", `/rooms/${encodeURIComponent(ROOM)}/space`, null, out)).body.code, "not-member");
    assert.equal((await http("POST", "/wallet", { space: SPACE }, out)).body.code, "not-member");
    assert.equal((await http("GET", `/rooms/${encodeURIComponent("!loose:play.test")}/space`, null, s)).body.code, "not-member");
    assert.equal((await http("GET", "/me?space=x", null, "A".repeat(43))).status, 401);
});

test("Hold'em end to end: three players, a full hand through the real engine; every frame in the contract, no leaks, books balanced", { skip }, async () => {
    const S = {};
    for (const u of PEOPLE.slice(0, 3)) { S[u] = await signIn(u); await http("POST", "/wallet", { space: SPACE }, S[u]); }
    const created = await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[PEOPLE[0]]);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const T = created.body.table;
    assert.equal((await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[PEOPLE[1]])).body.code, "one-per-room");
    const cs = [];
    for (const u of PEOPLE.slice(0, 3)) { const c = await connect(u, S[u]); c.send({ t: "sub", room: ROOM }); await c.wait((f) => f.t === "room"); c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T); cs.push(c); }
    const specS = await signIn(SPECTATOR); const spec = await connect(SPECTATOR, specS); spec.send({ t: "open", table: T }); await spec.wait((f) => f.t === "view");
    // a sit without the space is refused by the contract; a wrong space = space-changed
    assert.equal((await cs[0].act(T, { do: "sit", space: "!other:play.test" })).code, "space-changed");
    for (const c of cs) assert.equal((await c.act(T, { do: "sit", space: SPACE })).ok, true);
    await settle();
    const r = await cs[0].act(T, { do: "deal" });
    assert.equal(r.ok, true, JSON.stringify(r));
    // play the hand: whoever is to act calls (or checks) until it ends
    for (let i = 0; i < 40; i++) {
        await settle(60);
        const v = cs[0].latestView(T);
        if (!v.hand || !v.hand.to_act) break;
        const seatU = v.seats.find((s) => s.seat === v.hand.to_act.seat).u;
        const c = cs.find((x) => x.user === seatU);
        const mine = c.latestView(T);
        assert.ok(mine.you.legal, "the player to act has legal moves");
        const others = cs.filter((x) => x !== c).map((x) => x.latestView(T).you);
        assert.ok(others.every((y) => y.legal === null), "nobody else gets legal moves");
        const a = mine.you.legal.check ? { do: "check" } : { do: "call" };
        const ack = await c.act(T, a, { hand: mine.hand.n, turn: mine.hand.to_act.turn });
        assert.equal(ack.ok, true, JSON.stringify(ack));
        // a resend of the same op is the same answer, dup
    }
    await settle(200);
    const end = cs[0].latestView(T);
    assert.ok(end.result, "the hand has a result");
    assert.equal(end.status, "pause");
    const total = end.seats.reduce((a, s) => a + s.stack, 0);
    assert.equal(total, 30, "every chip is on the table: 3 × 10");
    // spectators never saw hole cards before the showdown: checked for every frame below
    const n = checkAllFrames();
    assert.ok(n > 20, `views checked: ${n}`);
    // everyone leaves: cashed out
    for (const c of cs) assert.equal((await c.act(T, { do: "leave" })).ok, true);
    await settle(300);
    const audit = await inTx(pool, (c) => L.audit(c));
    assert.deepEqual(audit, []);
    const sum = await pool.query("SELECT sum(balance)::int AS s FROM play_accounts WHERE kind IN ('seat','pot','esc')");
    assert.equal(sum.rows[0].s ?? 0, 0, "nothing left at the table after everyone left");
    checkAllFrames();
});

test("The Rig end to end: four players, a Lite round through the real engine; every frame in the contract, no leaks, books balanced", { skip }, async () => {
    const S = {};
    for (const u of PEOPLE) { S[u] = await signIn(u); await http("POST", "/wallet", { space: SPACE }, S[u]); }
    const created = await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "rig", space: SPACE, opts: { preset: "lite", bankroll: 6, patch: true } }, S[PEOPLE[0]]);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const T = created.body.table;
    const cs = [];
    for (const u of PEOPLE) { const c = await connect(u, S[u]); c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T); cs.push(c); }
    for (const c of cs.slice(1)) assert.equal((await c.act(T, { do: "join", space: SPACE })).ok, true);
    await settle();
    const st = await cs[0].act(T, { do: "start", preset: "full", bankroll: 6, patch: true }); // round 1 is Lite anyway; round 2 Full
    assert.equal(st.ok, true, JSON.stringify(st));
    await settle();
    const setupMoves = async () => {
        for (const c of cs) {
            const v = c.latestView(T);
            if (!v?.you || !v.round || v.round.phase !== "setup") continue;
            const at = { round: v.round.r, spin: v.round.spin, phase: "setup" };
            if (v.you.role === "mechanic" && v.you.deal) assert.equal((await c.act(T, { do: "keep", card: v.you.deal[0] }, at)).ok, true);
            if ((v.you.role === "mechanic" || v.you.role === "sharp") && !v.you.market_done) { const a = await c.act(T, { do: "market", side: "pass" }, at); assert.ok(a.ok || a.code === "phase", JSON.stringify(a)); }
        }
    };
    let muteChecked = false;
    for (let i = 0; i < 400; i++) {
        await settle(40);
        const v = cs[0].latestView(T);
        if (process.env.PLAY_DEBUG) console.error(`  seen ${v.status} r${v.round?.r} ${v.round?.preset} ${v.round?.phase} spin ${v.round?.spin}`);
        if (v.status !== "round" || !v.round) { if (v.status === "end") break; clock += 21_000; await settle(60); continue; }
        if (v.round.phase === "setup") { await setupMoves(); await settle(120); if (cs[0].latestView(T).round?.phase === "setup") { clock += 21_000; await settle(80); } continue; }
        if (v.round.phase !== "turn") { clock += 21_000; await settle(60); if (v.round.r >= 2 && muteChecked && v.round.phase === "reveal") break; continue; }
        // round 2 (Full), first turn: a Mechanic arms a Mute. Their own view changes; nobody else gets ANY frame.
        if (v.round.preset === "full" && !muteChecked) {
            const mech = cs.find((c) => c.latestView(T)?.you?.role === "mechanic" && c.latestView(T).you.mutes_left > 0);
            assert.ok(mech, "a Mechanic with Mutes in round 2 (Full)");
            await settle(200);
            const counts = new Map(cs.map((c) => [c.user, c.all.filter((f) => f.t === "view").length]));
            const mv = mech.latestView(T);
            const a = await mech.act(T, { do: "mute", armed: true }, { round: mv.round.r, spin: mv.round.spin, phase: "turn" });
            assert.equal(a.ok, true, JSON.stringify(a));
            await mech.wait((f) => f.t === "view" && f.view.you?.armed === true, 10000); // event-driven, not a fixed sleep
            await settle(400); // time for any (wrong) frame to the others to arrive
            assert.equal(mech.all.filter((f) => f.t === "view").length, counts.get(mech.user) + 1, "the Mechanic sees their Mute armed");
            for (const c of cs) if (c !== mech) assert.equal(c.all.filter((f) => f.t === "view").length, counts.get(c.user), `${c.user} must get NO frame when someone else arms a Mute`);
            muteChecked = true;
            // a free-text Whisper from a House member: its words must not outlive the table (checked after everyone leaves)
            const wv = mech.latestView(T);
            const w = await mech.act(T, { do: "whisper", text: "gs1 secret words" }, { round: wv.round.r, spin: wv.round.spin, phase: "turn" });
            assert.equal(w.ok, true, JSON.stringify(w));
        }
        const spinner = cs.find((c) => c.user === v.round.spinner);
        const sv = spinner.latestView(T);
        if (!sv?.round || sv.round.phase !== "turn") continue;
        const a = await spinner.act(T, { do: "spin", bet: 1 }, { round: sv.round.r, spin: sv.round.spin, phase: "turn" });
        assert.ok(a.ok || a.code === "stale", JSON.stringify(a));
    }
    assert.ok(muteChecked, "reached round 2 (Full) and checked the Mute");
    await settle(200);
    const vr = cs[1].latestView(T);
    assert.ok(vr.round?.phase === "reveal" || vr.status === "round" || vr.status === "end" || vr.status === "lobby", `phase ${vr.round?.phase} status ${vr.status}`);
    const n = checkAllFrames();
    assert.ok(n > 30, `views checked: ${n}`);
    const audit = await inTx(pool, (c) => L.audit(c));
    assert.deepEqual(audit, []);
    for (const c of cs) await c.act(T, { do: "leave" });
    for (let i = 0; i < 8; i++) { clock += 30_000; await play._tickNow(T); await settle(100); }
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
    if (process.env.PLAY_DEBUG) { const g = play._tables.get(T)?.st; console.error("rig after leave:", g?.status, g?.closing, g?.round?.phase, JSON.stringify(g?.seats), JSON.stringify(g?.round?.left)); }
    const t = await pool.query("SELECT status FROM play_tables WHERE id = $1", [T]);
    assert.equal(t.rows[0].status, "closed", "everyone left: the table closed");
    // ... and it left the room's listing at once, so a new Rig table can be opened there (lab7, 11:51)
    const S0 = await signIn(PEOPLE[0]);
    const lst = await http("GET", `/rooms/${encodeURIComponent(ROOM)}/tables`, null, S0);
    assert.ok(!lst.body.tables.some((x) => x.table === T), "a closed table is no longer listed");
    const again = await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "rig", space: SPACE, opts: { preset: "lite" } }, S0);
    assert.equal(again.status, 201, `a new Rig table in the same room: ${JSON.stringify(again.body)}`);
    for (const q of ["SELECT count(*)::int AS n FROM play_games WHERE table_id = $1 AND log::text LIKE '%gs1 secret words%'", "SELECT count(*)::int AS n FROM play_tables WHERE id = $1 AND state::text LIKE '%gs1 secret words%'"]) {
        assert.equal((await pool.query(q, [T])).rows[0].n, 0, "a Whisper's words are gone once the table ended");
    }
});

test("retention: game logs cleared after 30 days, closed tables removed after 90, tombstones after 30; the journal stays and still audits", { skip }, async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM play_tx")).rows[0].n;
    const logs = (await pool.query("SELECT count(*)::int AS n FROM play_games WHERE log IS NOT NULL")).rows[0].n;
    assert.ok(logs > 0, "some finished games have logs");
    clock += 31 * 86400_000;
    const r1 = await play.sweep();
    assert.equal(r1.logs, logs);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM play_games WHERE log IS NOT NULL AND finished_at IS NOT NULL")).rows[0].n, 0);
    clock += 60 * 86400_000;
    const closed = (await pool.query("SELECT count(*)::int AS n FROM play_tables WHERE status = 'closed'")).rows[0].n;
    const r2 = await play.sweep();
    assert.equal(r2.tables, closed);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM play_tables WHERE status = 'closed'")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM play_tx")).rows[0].n, before, "the journal is never swept");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("a restart mid-hand: the hand is called off from the ledger alone, every chip back, the table closed, audit clean", { skip }, async () => {
    const S = {};
    for (const u of RESTARTERS) S[u] = await signIn(u);
    for (const u of RESTARTERS) await http("POST", "/wallet", { space: SPACE }, S[u]);
    const before = await pool.query("SELECT sum(balance)::int AS s FROM play_accounts WHERE kind IN ('w','seat','pot','esc')");
    const created = await http("POST", `/rooms/${encodeURIComponent("!lab-room2:play.test")}/tables`, { game: "holdem", space: SPACE, opts: { seats: 2 } }, S[RESTARTERS[0]]);
    const T = created.body.table;
    const cs = [];
    for (const u of RESTARTERS) { const c = await connect(u, S[u]); c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view"); cs.push(c); }
    for (const c of cs) await c.act(T, { do: "sit", space: SPACE });
    await settle();
    assert.equal((await cs[0].act(T, { do: "deal" })).ok, true);
    await settle();
    const mid = await pool.query("SELECT count(*)::int AS n FROM play_games WHERE table_id = $1 AND disposition = 'open'", [T]);
    assert.equal(mid.rows[0].n, 1, "a hand is open");
    // "crash": drop the process's in-memory state without any cleanup, start a fresh platform on the same database
    await stopPlay();
    await startPlay();
    const g = await pool.query("SELECT disposition FROM play_games WHERE table_id = $1", [T]);
    assert.deepEqual(g.rows.map((r) => r.disposition), ["voided"]);
    const t = await pool.query("SELECT status, closed_reason FROM play_tables WHERE id = $1", [T]);
    assert.deepEqual(t.rows[0], { status: "closed", closed_reason: "restart" });
    const after2 = await pool.query("SELECT sum(balance)::int AS s FROM play_accounts WHERE kind = 'w'");
    assert.equal(after2.rows[0].s, before.rows[0].s, "every chip that was anywhere at a table is back in a wallet");
    const atTable = await pool.query("SELECT coalesce(sum(balance),0)::int AS s FROM play_accounts WHERE kind IN ('seat','pot','esc')");
    assert.equal(atTable.rows[0].s, 0);
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});
