// games-s2, polish round 2 (server): B2 (a quiet Pad no longer hides the cards on the person's other screens), B3 (each
// seat / Rig player carries its prestige rank), on a real Postgres (PLAY_TEST_DB_URL; skipped without it) with fake
// room/space state, through the real socket and engines. Every frame is checked against the contract and the privacy
// rules, as in play-platform.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import pg from "pg";
import { migrate } from "../play/db.mjs";
import * as rules from "../play/rules.mjs";
import { createPlay, PLAY } from "../play/platform.mjs";
import { validate } from "../play/jsonschema.mjs";
import { SCHEMA } from "../play/contract/schema.mjs";
import { leaks } from "../play/privacy.mjs";

const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL to run the platform tests";
const DBNAME = `games_s2_r2_${process.pid}`;
const SERVER = "play.test";
const SPACE = "!lab-space:play.test";
const ROOM = "!lab-room:play.test";
const ROOM2 = "!lab-room2:play.test";
const P = ["@r2-test1:play.test", "@r2-test2:play.test", "@r2-test3:play.test", "@r2-test4:play.test", "@r2-test5:play.test",
    "@r2-test6:play.test", "@r2-test7:play.test", "@r2-test8:play.test", "@r2-test9:play.test", "@r2-test10:play.test", "@r2-test11:play.test"];
const ROOM3 = "!lab-room3:play.test";
const ROOM4 = "!lab-room4:play.test";
const moves = []; // deps.onMove calls (the sampler's "showed life" signal)

let clock = Date.parse("2026-11-20T20:00:00Z");
const now = () => clock;
let monoAt = 1_000_000; // the transport clock, moved by the tests
const mono = () => monoAt;
const logs = [];
let pool, play, server, base, ws;

before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 10 });
    await migrate(pool);
    const joined = new Set(P);
    const resolve = async (room) => (room.startsWith("!lab-room")
        ? { space: SPACE, server: SERVER, why: "", room: { joined: new Map([...joined].map((x) => [x, x])), sessions: [...joined].map((x) => ({ sender: x, device: "D" })) }, spaceJoined: joined }
        : { space: null, server: null, why: "no-space", room: { joined: new Map(), sessions: [] }, spaceJoined: new Set() });
    play = createPlay({
        pool, cfg: { ...rules.configFromEnv({}), tz: "America/Los_Angeles" }, spaces: { resolve, forget: () => {} },
        spaceInfo: async (s) => (s === SPACE ? { owner: SERVER, joined } : null), serverName: SERVER, salt: "test-salt",
        resolveOpenId: async ({ openid, user_id }) => (openid.access_token === `ok:${user_id}` ? user_id : null),
        now, mono, padSweepMs: 40, onMove: (u) => moves.push(u), log: (s) => { logs.push(s); if (process.env.PLAY_DEBUG) console.error(s); }, flags: () => ({ play: true, rig_phone_apps: true }),
    });
    await play.recover();
    const app = express(); app.set("trust proxy", "loopback");
    const r = express.Router(); play.routes(r); app.use(r);
    server = createServer(app); play.attach(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/v1`; ws = `ws://127.0.0.1:${server.address().port}/v1/ws`;
});
after(async () => {
    if (skip) return;
    for (const c of clients) c.ws.close();
    await new Promise((r) => server.close(r)); server.closeAllConnections?.();
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});

async function http(method, path, body, session) {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Play ${session}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
}
const clients = [];
let opn = 0;
const op = () => `games-s2-r2-${String(++opn).padStart(6, "0")}`;
async function signIn(user, kind = "desktop") {
    const s = await http("POST", "/session", { openid: { access_token: `ok:${user}`, matrix_server_name: SERVER, token_type: "Bearer", expires_in: 3600 }, user_id: user, client: { kind } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return s.body.session;
}
async function connect(user, session, { kind = "desktop", pad = false } = {}) {
    const sock = new WebSocket(ws);
    const c = { user, kind, pad, ws: sock, frames: [], all: [], waiters: [] };
    sock.addEventListener("message", (e) => {
        const f = JSON.parse(e.data);
        c.all.push(f);
        for (const w of [...c.waiters]) if (w.pred(f)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.ok(f); return; }
        c.frames.push(f);
    });
    await once(sock, "open");
    sock.send(JSON.stringify({ t: "auth", session, client: { kind, pad } }));
    c.send = (f) => sock.send(JSON.stringify(f));
    c.wait = (pred, ms = 5000) => new Promise((ok, no) => {
        const i = c.frames.findIndex(pred); if (i >= 0) { const [f] = c.frames.splice(i, 1); return ok(f); }
        const w = { pred, ok: (f) => { clearTimeout(t); ok(f); } };
        const t = setTimeout(() => { c.waiters.splice(c.waiters.indexOf(w), 1); no(new Error(`${user}/${kind}${pad ? "+pad" : ""}: no matching frame (last: ${JSON.stringify(c.all.slice(-2)).slice(0, 500)})`)); }, ms);
        c.waiters.push(w);
    });
    c.latestView = (table) => { const vs = c.all.filter((f) => f.t === "view" && f.table === table); return vs.length ? vs[vs.length - 1].view : null; };
    c.act = async (table, a, at) => { const o = op(); c.send({ t: "act", table, op: o, ...(at ? { at } : {}), a }); return c.wait((f) => f.t === "ack" && f.op === o); };
    await c.wait((f) => f.t === "hello");
    clients.push(c);
    return c;
}
function checkAllFrames() {
    for (const c of clients) for (const f of c.all) {
        assert.deepEqual(validate(SCHEMA, { $ref: "#/$defs/serverFrame" }, f), [], `${c.user} got a ${f.t} frame outside the contract`);
        if (f.t === "view") assert.deepEqual(leaks(f.view.game, f.view, c.user), [], `${c.user} view ${f.view.game} vseq ${f.vseq}`);
    }
    assert.equal(logs.filter((l) => /BUG/.test(l)).length, 0, logs.filter((l) => /BUG/.test(l)).join("\n"));
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const hasPad = (v) => !!v?.you && v.you.screens.includes("pad");

test("B2: a Pad that goes quiet stops hiding the cards on the desktop within SCREEN_STALE_MS; it counts again once it pings", { skip }, async () => {
    const FRESH = PLAY.SCREEN_STALE_MS ?? 25_000; // (checked at the end, so the behaviour fails first, not the constant)
    const [A, B] = P;
    const S = { [A]: await signIn(A), [B]: await signIn(B) };
    for (const u of [A, B]) assert.ok([200, 201].includes((await http("POST", "/wallet", { space: SPACE }, S[u])).status));
    const created = await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[A]);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const T = created.body.table;
    const desk = await connect(A, S[A]);
    const padS = await signIn(A, "ios-app");
    const pad = await connect(A, padS, { kind: "ios-app", pad: true });
    const b = await connect(B, S[B]);
    for (const c of [desk, pad, b]) { c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T); }
    assert.equal((await desk.act(T, { do: "sit", space: SPACE })).ok, true);
    assert.equal((await b.act(T, { do: "sit", space: SPACE })).ok, true);
    assert.equal((await desk.act(T, { do: "deal" })).ok, true);
    await settle();
    // both of A's screens get A's own two hole cards (the server never withholds them); the Pad is listed
    for (const c of [desk, pad]) { const v = c.latestView(T); assert.equal(v.you.cards.length, 2, `${c.kind}: own cards`); assert.ok(hasPad(v), `${c.kind}: screens has pad`); }
    assert.deepEqual(desk.latestView(T).you.cards, pad.latestView(T).you.cards);
    // the phone locks: no frame from it. Just under the limit it still counts...
    monoAt += FRESH - 1_000;
    await settle(200);
    assert.ok(hasPad(desk.latestView(T)), "still counted just under SCREEN_STALE_MS");
    // ...past it, the desktop gets a view without "pad" by itself (no move by anyone)
    monoAt += 2_000;
    const v1 = await desk.wait((f) => f.t === "view" && f.table === T && f.view.you && !f.view.you.screens.includes("pad"), 2000);
    assert.equal(v1.view.you.cards.length, 2, "the cards are still in the view");
    assert.ok(v1.view.you.screens.includes("desktop"));
    // B sees nothing of A's screens (no frame for B moved by A's Pad: their own view didn't change)
    assert.ok(!b.latestView(T).you.screens.includes("pad"));
    // the phone wakes and pings: counted again at once
    pad.send({ t: "ping" });
    const v2 = await desk.wait((f) => f.t === "view" && f.table === T && f.view.you && f.view.you.screens.includes("pad") && f.vseq > v1.vseq, 2000);
    assert.equal(v2.view.you.cards.length, 2);
    // re-opening on the Pad mid-hand (a device swap) gives the cards at once
    pad.send({ t: "close", table: T }); await settle(80);
    pad.frames.length = 0; // only frames after the re-open count
    pad.send({ t: "open", table: T });
    const v3 = await pad.wait((f) => f.t === "view" && f.table === T, 2000);
    assert.equal(v3.view.you.cards.length, 2, "a re-opened Pad gets the cards");
    // a desktop that drops and reconnects mid-hand (a new socket, same session) gets the cards on its first view
    desk.ws.close(); await settle(80);
    const desk2 = await connect(A, S[A]);
    desk2.send({ t: "open", table: T });
    const v4 = await desk2.wait((f) => f.t === "view" && f.table === T, 2000);
    assert.equal(v4.view.you.cards.length, 2, "a reconnected desktop gets the cards");
    checkAllFrames();
    assert.ok(PLAY.SCREEN_STALE_MS >= 21_000 && PLAY.SCREEN_STALE_MS <= 30_000, "fresher than the 20 s ping, well under the silent close");
    for (const c of [desk2, b]) await c.act(T, { do: "leave" });
    await settle(200);
});

test("B3: every seat (Hold'em) and every Rig player carries their prestige rank in the table's space, for every viewer", { skip }, async () => {
    const [A, B, C] = P.slice(2); // (nobody from the B2 test: a failure there leaves its people seated)
    const S = {};
    for (const u of [A, B, C]) { S[u] = await signIn(u); assert.ok([200, 201].includes((await http("POST", "/wallet", { space: SPACE }, S[u])).status)); }
    // B prestiged twice (as the ledger would leave it); the others are at 0
    await pool.query("UPDATE play_wallets SET rank = 2 WHERE wid = (SELECT wid FROM play_people WHERE user_id = $1)", [B]);
    const created = await http("POST", `/rooms/${encodeURIComponent(ROOM2)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[A]);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const T = created.body.table;
    const cs = [];
    for (const u of [A, B, C]) { const c = await connect(u, S[u]); c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T); cs.push(c); }
    for (const c of cs.slice(0, 2)) assert.equal((await c.act(T, { do: "sit", space: SPACE })).ok, true);
    await settle();
    for (const c of cs) { // C is a spectator: same public seat ranks
        const v = c.latestView(T);
        const byU = Object.fromEntries(v.seats.map((s) => [s.u, s.rank]));
        assert.deepEqual(byU, { [A]: 0, [B]: 2 }, `${c.user}'s view`);
    }
    for (const c of cs.slice(0, 2)) await c.act(T, { do: "leave" });
    await settle(150);
    // The Rig: the players list carries the rank too
    const rc = await http("POST", `/rooms/${encodeURIComponent(ROOM2)}/tables`, { game: "rig", space: SPACE, opts: { preset: "lite" } }, S[A]);
    assert.equal(rc.status, 201, JSON.stringify(rc.body));
    const R = rc.body.table;
    for (const c of cs) { c.send({ t: "open", table: R }); await c.wait((f) => f.t === "view" && f.table === R); }
    for (const c of cs.slice(1)) assert.equal((await c.act(R, { do: "join", space: SPACE })).ok, true, c.user); // the creator is in already
    await settle();
    const rv = cs[2].latestView(R);
    assert.deepEqual(Object.fromEntries(rv.players.map((p) => [p.u, p.rank])), { [A]: 0, [B]: 2, [C]: 0 });
    checkAllFrames();
    for (const c of cs) await c.act(R, { do: "leave" });
});

test("F7 reactions: seated and watching people react; everyone with the table open gets them; toss targets; limits; dup; no view, no activity", { skip }, async () => {
    const [A, B, W] = P.slice(5, 8);
    const S = {};
    for (const u of [A, B, W]) { S[u] = await signIn(u); assert.ok([200, 201].includes((await http("POST", "/wallet", { space: SPACE }, S[u])).status)); }
    const created = await http("POST", `/rooms/${encodeURIComponent(ROOM3)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[A]);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const T = created.body.table;
    const [a, b, w] = [await connect(A, S[A]), await connect(B, S[B]), await connect(W, S[W])];
    for (const c of [a, b, w]) { c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T); }
    assert.equal((await a.act(T, { do: "sit", space: SPACE, seat: 1 })).ok, true);
    assert.equal((await b.act(T, { do: "sit", space: SPACE, seat: 2 })).ok, true);
    await settle();
    const hello = a.all.find((f) => f.t === "hello");
    assert.deepEqual(hello.features, ["fresh-screens", "react", "away2"]);
    const viewsBefore = a.all.filter((f) => f.t === "view").length;
    const movesBefore = moves.length;
    const r1 = await a.act(T, { do: "react", r: "tip" });
    assert.deepEqual([r1.ok, r1.code, r1.dup], [true, "", false]);
    for (const c of [a, b, w]) { const f = await c.wait((x) => x.t === "react" && x.r === "tip"); assert.equal(f.u, A); assert.equal(f.seat, 1); assert.equal(f.to, undefined); }
    // a watcher (in the call, not seated) reacts with seat null
    assert.equal((await w.act(T, { do: "react", r: "clap" })).ok, true);
    assert.equal((await b.wait((x) => x.t === "react" && x.r === "clap")).seat, null);
    // toss: to a seat, to the pot (default), never to an empty seat; `to` on anything else is bad
    assert.equal((await a.act(T, { do: "react", r: "toss", to: 2 })).ok, true);
    assert.equal((await b.wait((x) => x.t === "react" && x.r === "toss")).to, 2);
    assert.equal((await b.act(T, { do: "react", r: "toss" })).ok, true);
    assert.equal((await a.wait((x) => x.t === "react" && x.r === "toss" && x.u === B)).to, "pot");
    assert.equal((await b.act(T, { do: "react", r: "toss", to: 5 })).code, "bad", "an empty seat");
    assert.equal((await b.act(T, { do: "react", r: "knock", to: 1 })).code, "bad", "only toss takes a target");
    // A has used 2 of the burst of 3: one more, then cooldown with retry_ms; a refill later it works again
    assert.equal((await a.act(T, { do: "react", r: "sweat" })).ok, true);
    const cd = await a.act(T, { do: "react", r: "foil" });
    assert.equal(cd.ok, false); assert.equal(cd.code, "cooldown"); assert.ok(cd.retry_ms > 0 && cd.retry_ms <= PLAY.REACT_REFILL_MS, JSON.stringify(cd));
    assert.ok(!a.ws.readyState || a.ws.readyState === 1, "a cooldown never closes the socket");
    monoAt += PLAY.REACT_REFILL_MS;
    assert.equal((await a.act(T, { do: "react", r: "foil" })).ok, true);
    // a resend of the same op: answered from memory (dup), no second frame
    const o = "games-s2-r2-dupreact01";
    a.send({ t: "act", table: T, op: o, a: { do: "react", r: "knock" } });
    const d1 = await a.wait((f) => f.t === "ack" && f.op === o);
    a.send({ t: "act", table: T, op: o, a: { do: "react", r: "knock" } });
    const d2 = await a.wait((f) => f.t === "ack" && f.op === o);
    assert.equal(d2.dup, true); assert.equal(d2.ok, d1.ok);
    await settle(100);
    assert.equal(b.all.filter((f) => f.t === "react" && f.r === "knock" && f.u === A).length, d1.ok ? 1 : 0);
    // reactions are not in the view and not activity
    assert.equal(a.all.filter((f) => f.t === "view").length, viewsBefore, "no view frame moved by a reaction");
    assert.equal(moves.length, movesBefore, "a reaction never counts as a move (anti-idle)");
    // the table's rolling minute: at most REACT_TABLE_PER_MIN reactions in all (three people's buckets could give ~50
    // in these 56 s; exactly the limit get through)
    monoAt += 61_000;
    let sent = 0, cooled = 0;
    for (let step = 0; step < 40; step++) {
        for (const c of [a, b, w]) { const r = await c.act(T, { do: "react", r: "clap" }); if (r.ok) sent++; else { assert.equal(r.code, "cooldown"); assert.ok(r.retry_ms > 0); cooled++; } }
        monoAt += 1_400;
    }
    assert.equal(sent, PLAY.REACT_TABLE_PER_MIN, "the table's minute holds exactly the limit");
    assert.ok(cooled > 0);
    checkAllFrames();
    for (const c of [a, b]) await c.act(T, { do: "leave" });
});

test("B10 gone at a deal (platform): a seated player whose last socket on the table closed GONE_MS ago is dealt out (reason gone)", { skip }, async () => {
    const [A, B, C] = P.slice(8, 11);
    const S = {};
    for (const u of [A, B, C]) { S[u] = await signIn(u); assert.ok([200, 201].includes((await http("POST", "/wallet", { space: SPACE }, S[u])).status)); }
    const created = await http("POST", `/rooms/${encodeURIComponent(ROOM4)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[A]);
    const T = created.body.table;
    const cs = [];
    for (const u of [A, B, C]) { const c = await connect(u, S[u]); c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T); cs.push(c); }
    for (const [i, c] of cs.entries()) assert.equal((await c.act(T, { do: "sit", space: SPACE, seat: i + 1 })).ok, true);
    assert.equal((await cs[0].act(T, { do: "deal" })).ok, true);
    await settle();
    assert.equal(cs[0].latestView(T).hand.n, 1);
    // hand 1 ends by folds (everyone present)
    for (let i = 0; i < 6; i++) {
        const v = cs[0].latestView(T);
        if (v.status !== "hand") break;
        const who = v.seats.find((s) => s.seat === v.hand.to_act.seat).u;
        assert.equal((await cs.find((x) => x.user === who).act(T, { do: "fold" }, { hand: v.hand.n, turn: v.hand.to_act.turn })).ok, true);
        await settle(80);
    }
    assert.equal(cs[0].latestView(T).status, "pause");
    cs[2].send({ t: "close", table: T }); // then C's only socket on the table goes
    await settle(80);
    clock += 21_000; // > GONE_MS, and past the pause: a move runs the due timers first = the next deal (a refused Deal
    // in the pause will do; an "I'm back" would not: it goes before the timers, addendum §8.1)
    await cs[0].act(T, { do: "deal" });
    await settle(150);
    const v = cs[0].latestView(T);
    assert.equal(v.hand.n, 2, "hand 2 dealt");
    const c3 = v.seats.find((s) => s.u === C);
    assert.equal(c3.state, "away"); assert.equal(c3.away.reason, "gone");
    assert.equal(c3.cards, 0);
    checkAllFrames();
});

/** Launch-gate ruling 7 (addendum §3.4 (a)): no frame a person gets before the showdown names another player's hole
 *  cards. Every player's own cards come from their own views; every frame of everyone else is searched for them. */
function holeLeaks(cs, T) {
    const holes = new Map(); // hand n → user → their hole cards that hand, from their own views
    for (const c of cs) for (const f of c.all) if (f.t === "view" && f.table === T && f.view.hand && f.view.you?.cards?.length === 2) {
        const h = holes.get(f.view.hand.n) || new Map(); holes.set(f.view.hand.n, h); h.set(c.user, new Set(f.view.you.cards));
    }
    const out = [];
    for (const c of cs) for (const f of c.all) {
        if (f.t === "view" && (f.view.hand?.street === "showdown" || f.view.result)) continue; // shown cards are public then
        const text = JSON.stringify(f);
        const board = new Set(f.t === "view" ? f.view.hand?.board || [] : []);
        const hands = f.t === "view" ? (f.view.hand ? [f.view.hand.n] : []) : [...holes.keys()];
        for (const n of hands) for (const [u, cards] of holes.get(n) || []) {
            if (u === c.user) continue;
            const mine = holes.get(n)?.get(c.user) || new Set();
            for (const card of cards) if (!board.has(card) && !mine.has(card) && text.includes(`"${card}"`)) out.push(`${c.user} got ${u}'s ${card} (hand ${n}) in a ${f.t} frame`);
        }
    }
    return out;
}

test("privacy (ruling 7): scripted hands with reactions, away and an admin read: no frame names another player's hole cards before the showdown; a planted leak is found", { skip }, async () => {
    const [A, B, C] = P.slice(0, 3);
    const S = {};
    for (const u of [A, B, C]) { S[u] = await signIn(u); await http("POST", "/wallet", { space: SPACE }, S[u]); }
    const room = "!lab-room9:play.test";
    const T = (await http("POST", `/rooms/${encodeURIComponent(room)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, S[A])).body.table;
    const cs = [];
    for (const u of [A, B, C]) { const c = await connect(u, S[u]); c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T); cs.push(c); }
    for (const c of cs) assert.equal((await c.act(T, { do: "sit", space: SPACE })).ok, true);
    for (let hand = 0; hand < 3; hand++) {
        if (hand === 0) assert.equal((await cs[0].act(T, { do: "deal" })).ok, true);
        else { clock += 6_000; await cs[0].act(T, { do: "deal" }); }
        await settle();
        for (let i = 0; i < 30; i++) {
            const v = cs[0].latestView(T);
            if (v.status !== "hand" || !v.hand?.to_act) break;
            const who = v.seats.find((s) => s.seat === v.hand.to_act.seat).u;
            const c = cs.find((x) => x.user === who);
            const mine = c.latestView(T);
            monoAt += 4_000;
            await c.act(T, { do: "react", r: i % 2 ? "sweat" : "toss", ...(i % 2 ? {} : { to: "pot" }) });
            const a = mine.you.legal.check ? { do: "check" } : { do: "call" };
            await c.act(T, a, { hand: mine.hand.n, turn: mine.hand.to_act.turn });
            await settle(60);
        }
    }
    await http("GET", `/me?space=${encodeURIComponent(SPACE)}`, null, S[A]);
    assert.ok(cs.every((c) => c.all.some((f) => f.t === "react")), "reactions went out");
    assert.deepEqual(holeLeaks(cs, T), []);
    checkAllFrames();
    // the control: a frame carrying B's first hole card, planted into A's list, must be found
    const bCard = cs[1].all.find((f) => f.t === "view" && f.view.you?.cards?.length === 2).view.you.cards[0];
    cs[0].all.push({ t: "react", table: T, u: B, seat: 2, r: "tip", at: 1, leak: bCard });
    assert.ok(holeLeaks(cs, T).length > 0, "the planted leak is found");
    cs[0].all.pop();
    for (const c of cs) await c.act(T, { do: "leave" });
});
