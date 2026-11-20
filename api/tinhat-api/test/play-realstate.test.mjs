// The membership re-check against REAL room-state shapes (lab7 12:33 regression: "not-member" for joined members on
// both games after the first 15 s re-check). Every other platform test fakes the resolver with Sets; here the real
// createSpaces + the real space-membership reader run over Synapse-shaped admin-API state, where ring.mjs roomView's
// `joined` is a Map (mxid -> display name). Real Postgres (PLAY_TEST_DB_URL; skipped without it), the real engines.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import express from "express";
import pg from "pg";
import { migrate } from "../play/db.mjs";
import * as rules from "../play/rules.mjs";
import { createPlay } from "../play/platform.mjs";
import * as SP from "../play/space.mjs";
import { roomView } from "../ring.mjs";

const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL";
const DBNAME = `games_s1_rs${process.pid}`;
const SN = "play.test";
const SPACE = "!night-space:play.test", ROOM = "!table-room:play.test";
const U = (n) => `@player-rs${n}:${SN}`;
let pool, play, server, base, wsUrl, clock = Date.parse("2026-11-19T22:30:00Z");
const now = () => clock;
const cfg = { ...rules.configFromEnv({}), tz: "UTC" };
const roomJoined = new Set([1, 2, 3].map(U)), spaceJoined = new Set([1, 2, 3].map(U)), inCall = new Set([1, 2, 3].map(U));

// Synapse admin API `GET /rooms/<id>/state` shapes (display names on, as real clients set them)
const member = (u, membership) => ({ type: "m.room.member", state_key: u, sender: u, content: { membership, displayname: `Name of ${u.slice(1, 12)}` } });
function stateOf(id) {
    const everyoneEver = [1, 2, 3].map(U);
    if (id === SPACE) return [
        { type: "m.room.create", state_key: "", sender: U(1), content: { type: "m.space", room_version: "11" } },
        { type: "m.space.child", state_key: ROOM, sender: U(1), content: { via: [SN] } },
        ...everyoneEver.map((u) => member(u, spaceJoined.has(u) ? "join" : "leave")),
    ];
    if (id === ROOM) return [
        { type: "m.room.create", state_key: "", sender: U(1), content: { room_version: "11" } },
        { type: "m.space.parent", state_key: SPACE, sender: U(1), content: { via: [SN], canonical: true } },
        ...everyoneEver.map((u) => member(u, roomJoined.has(u) ? "join" : "leave")),
        ...[...inCall].map((u) => ({ type: "org.matrix.msc3401.call.member", state_key: `_${u}_DEV_m.call`, sender: u, origin_server_ts: clock - 1000,
            content: { application: "m.call", scope: "m.room", call_id: "", device_id: "DEV", created_ts: clock - 1000, expires: 14_400_000 } })),
    ];
    return null;
}
const reader = { roomState: async (id) => stateOf(id) };
// the server's own space-membership reader (space.mjs once it holds it; the same code install.mjs carried before)
const spaceInfo = SP.createSpaceInfo ? SP.createSpaceInfo(reader) : async (spaceId) => {
    const ev = await reader.roomState(spaceId);
    if (!ev) return null;
    const create = ev.find((e) => e?.type === "m.room.create" && e.state_key === "");
    if (!create || create.content?.type !== "m.space") return null;
    const owner = typeof create.sender === "string" ? create.sender.slice(create.sender.indexOf(":") + 1) : null;
    return { owner, joined: new Set(roomView(ev, Date.now()).joined.keys()) };
};

before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 10 });
    await migrate(pool);
    play = createPlay({ pool, cfg, spaces: SP.createSpaces({ reader, serverName: SN, now }), spaceInfo, serverName: SN, salt: "rs-salt",
        resolveOpenId: async ({ openid, user_id }) => {
            if (openid.access_token.startsWith("throw:")) throw Object.assign(new Error("x"), { code: openid.access_token.slice(6) });
            return openid.access_token === `ok:${user_id}` ? user_id : null;
        }, now, log: () => {}, flags: () => ({ play: true, rig_phone_apps: false }) });
    await play.recover();
    const app = express(); const r = express.Router(); play.routes(r); app.use(r);
    server = createServer(app); play.attach(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/v1`; wsUrl = `ws://127.0.0.1:${server.address().port}/v1/ws`;
});
after(async () => {
    if (skip) return;
    server.close(); server.closeAllConnections?.(); await settle(100); await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
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
    c.act = async (table, a, op = `games-s1-rs-${String(++opn).padStart(6, "0")}`) => {
        const from = frames.length;
        c.send({ t: "act", table, op, a });
        return c.wait((f) => f.t === "ack" && f.op === op && frames.indexOf(f) >= from);
    };
    c.send({ t: "auth", session, client: { kind: "web" } }); await c.wait((f) => f.t === "hello");
    return c;
}

for (const game of ["holdem", "rig"]) test(`${game}: joined members of the room AND its space keep the table after the 15 s re-check (lab7 12:33)`, { skip }, async () => {
    const s1 = await signIn(U(1)), s2 = await signIn(U(2));
    for (const s of [s1, s2]) assert.equal((await http("POST", "/wallet", { space: SPACE }, s)).status < 300, true, "wallets");
    const made = await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game, space: SPACE, opts: game === "holdem" ? { seats: 8 } : { preset: "lite" } }, s1);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const T = made.body.table;
    const a = await sock(s1); a.send({ t: "open", table: T }); await a.wait((f) => f.t === "view");
    await play.revalidateAll(); // the re-check, over real state
    await settle(100);
    const dropped = a.frames.find((f) => f.t === "error" && f.table === T);
    assert.equal(dropped, undefined, `a joined member was dropped by the re-check: ${JSON.stringify(dropped)}`);
    // a second joined member opens and sits after the re-check
    const b = await sock(s2); b.send({ t: "open", table: T });
    const first = await b.wait((f) => (f.t === "view" || f.t === "error") && f.table === T);
    assert.equal(first.t, "view", `opened after the re-check (got ${JSON.stringify(first)})`);
    const sat = await b.act(T, { do: game === "holdem" ? "sit" : "join", space: SPACE });
    assert.equal(sat.ok, true, JSON.stringify(sat));
    await play.revalidateAll();
    const v = await a.wait((f) => f.t === "view" && f.table === T && f.vseq > 1).catch(() => null);
    assert.ok(v, "the opener still gets views after a second re-check");
    assert.equal(a.frames.concat(b.frames).filter((f) => f.t === "error" && f.code === "not-member").length, 0, "no not-member for joined members");
    // and the kick still cuts (the 12:07 privacy fix, now over real state): U(2) leaves the SPACE
    spaceJoined.delete(U(2));
    try {
        await play.revalidateAll();
        const e = await b.wait((f) => f.t === "error" && f.table === T).catch(() => ({ code: "no error frame" }));
        assert.equal(e.code, "not-member", "someone who left the space is cut");
        assert.equal(a.frames.filter((f) => f.t === "error" && f.table === T).length, 0, "the joined host is not");
    } finally { spaceJoined.add(U(2)); }
    // a seated player who leaves only the ROOM (still in the space): table + room subscription cut, no more views, and
    // their seat is given up (astra on 60af8c7: the room side of the intersection must be tested too)
    const s3 = await signIn(U(3)); await http("POST", "/wallet", { space: SPACE }, s3);
    const c = await sock(s3); c.send({ t: "open", table: T }); await c.wait((f) => f.t === "view" && f.table === T);
    c.send({ t: "sub", room: ROOM }); await c.wait((f) => f.t === "room" && f.room === ROOM);
    const sat3 = await c.act(T, { do: game === "holdem" ? "sit" : "join", space: SPACE });
    assert.equal(sat3.ok, true, JSON.stringify(sat3));
    const seatedBefore = (await http("GET", `/rooms/${encodeURIComponent(ROOM)}/tables`, null, s1)).body.tables.find((x) => x.table === T).players;
    assert.ok(seatedBefore.includes(U(3)), "U(3) seated");
    roomJoined.delete(U(3)); inCall.delete(U(3));
    try {
        await play.revalidateAll();
        const eT = await c.wait((f) => f.t === "error" && f.table === T).catch(() => ({ code: "no table error" }));
        const eR = await c.wait((f) => f.t === "error" && f.room === ROOM).catch(() => ({ code: "no room error" }));
        assert.equal(eT.code, "not-member", "the table is cut for someone who left the room");
        assert.equal(eR.code, "not-member", "and their room subscription");
        const viewsAt = c.frames.filter((f) => f.t === "view" || f.t === "room").length;
        let players = seatedBefore;
        for (let i = 0; i < 40 && players.includes(U(3)); i++) { await settle(50); players = (await http("GET", `/rooms/${encodeURIComponent(ROOM)}/tables`, null, s1)).body.tables.find((x) => x.table === T).players; }
        assert.ok(!players.includes(U(3)), "their seat is given up (a leave)");
        await settle(200);
        assert.equal(c.frames.filter((f) => f.t === "view" || f.t === "room").length, viewsAt, "no view or room frame after the cut, though the table changed");
        assert.equal(a.frames.filter((f) => f.t === "error" && f.table === T).length, 0, "the joined host is never cut");
    } finally { roomJoined.add(U(3)); inCall.add(U(3)); a.ws.close(); b.ws.close(); c.ws.close(); await settle(50); }
});

// PM 15:01: a server's web app may run on its OWN origin (the well-known "web": https://tinhat.<domain>) while the API is on
// https://<domain>/api: the games web calls the play API cross-origin and opens the play socket with that Origin. The
// play API authenticates by bearer only (Authorization: Play <session>, the socket's auth frame), never a cookie, so it
// answers CORS * and doesn't gate the socket on Origin (a federated player's web app comes from THEIR server's origin).
test("a split web origin (the well-known web on its own name) can sign in, call the API and open the play socket", { skip }, async () => {
    const ORIGIN = "https://tinhat.split.example";
    const pre = await fetch(base + "/session", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" } });
    assert.ok(pre.status === 204 || pre.status === 200, `preflight ${pre.status}`);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-headers") || "", /Authorization/i);
    const u = U(1);
    const r = await fetch(base + "/session", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ openid: { access_token: `ok:${u}`, matrix_server_name: SN, token_type: "Bearer", expires_in: 60 }, user_id: u, client: { kind: "web" } }) });
    assert.ok(r.ok, `session ${r.status}`);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    const session = (await r.json()).session;
    const me = await fetch(base + `/me?space=${encodeURIComponent(SPACE)}`, { headers: { Origin: ORIGIN, Authorization: `Play ${session}` } });
    assert.equal(me.headers.get("access-control-allow-origin"), "*");
    // the socket: an upgrade carrying that Origin is accepted (101), and the session works on it
    const { port } = server.address();
    const status = await new Promise((ok, no) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/ws", headers: { Connection: "Upgrade", Upgrade: "websocket", Origin: ORIGIN,
            "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") } });
        req.on("upgrade", (res, sock) => { sock.destroy(); ok(res.statusCode); });
        req.on("response", (res) => ok(res.statusCode));
        req.on("error", no);
        req.end();
    });
    assert.equal(status, 101, "the play socket accepts the split web origin");
    const c = await sock(session); // (the same handshake, then auth: hello)
    c.ws.close();
});

// G10 (launch-gate 15:03): CORS * is safe only while the play API never uses ambient credentials. No play route ever
// sends Set-Cookie, none sends Access-Control-Allow-Credentials: true; without a bearer, or with an invalid one, a
// request (from any origin) is refused.
function credentialHeaders(res) {
    const bad = [];
    if (res.headers.get("set-cookie")) bad.push("Set-Cookie");
    if (/^true$/i.test(res.headers.get("access-control-allow-credentials") || "")) bad.push("Access-Control-Allow-Credentials: true");
    return bad;
}
test("G10: no play route sends a cookie or allows credentials; no or an invalid bearer is refused from any origin", { skip }, async () => {
    // the check itself can fail (the control): a response that carries either header is caught
    assert.deepEqual(credentialHeaders(new Response("", { headers: { "Set-Cookie": "a=b", "Access-Control-Allow-Credentials": "true" } })),
        ["Set-Cookie", "Access-Control-Allow-Credentials: true"]);
    const FOREIGN = "https://evil.example";
    const s1 = await signIn(U(1));
    await http("POST", "/wallet", { space: SPACE }, s1);
    const made = await http("POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "holdem", space: SPACE, opts: { seats: 8 } }, s1);
    const T = made.body?.table || "tHnonexistent0000";
    const routes = [
        ["OPTIONS", "/session"], ["POST", "/session"], ["GET", `/me?space=${encodeURIComponent(SPACE)}`],
        ["GET", `/me/journal?space=${encodeURIComponent(SPACE)}`], ["GET", `/ranks?space=${encodeURIComponent(SPACE)}&users=${encodeURIComponent(U(1))}`],
        ["GET", `/rooms/${encodeURIComponent(ROOM)}/space`], ["GET", `/rooms/${encodeURIComponent(ROOM)}/tables`],
        ["POST", `/rooms/${encodeURIComponent(ROOM)}/tables`], ["GET", `/tables/${T}`], ["GET", `/tables/${T}/hands`],
        ["GET", `/tables/${T}/rounds/1`], ["GET", `/tables/${T}/summary`], ["POST", "/wallet"], ["DELETE", "/wallet"],
    ];
    for (const auth of ["valid", "none", "invalid"]) {
        for (const [method, path] of routes) {
            if (auth === "valid" && method === "DELETE") continue; // (would delete the wallet the other rows use)
            const headers = { Origin: FOREIGN, "Content-Type": "application/json" };
            if (auth === "valid") headers.Authorization = `Play ${s1}`;
            if (auth === "invalid") headers.Authorization = "Play not-a-real-session-0000000000000000";
            const body = method === "POST" || method === "DELETE" ? JSON.stringify(path === "/session" ? { openid: { access_token: "forged", matrix_server_name: SN }, user_id: U(1) } : { space: SPACE, game: "holdem" }) : undefined;
            const res = await fetch(base + path, { method, headers, body });
            assert.deepEqual(credentialHeaders(res), [], `${auth} ${method} ${path} sent ${credentialHeaders(res)}`);
            if (auth !== "valid" && method !== "OPTIONS") assert.ok(res.status === 401 || res.status === 403 || res.status === 400,
                `${auth} bearer: ${method} ${path} must be refused, got ${res.status}`);
            await res.arrayBuffer();
        }
    }
    // the socket: an auth frame with an invalid session is refused (bye), from a foreign origin too
    const ws = new WebSocket(wsUrl); const frames = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
    await once(ws, "open");
    ws.send(JSON.stringify({ t: "auth", session: "not-a-real-session-0000000000000000", client: { kind: "web" } }));
    await settle(300);
    assert.ok(frames.some((f) => f.t === "bye" || (f.t === "error" && ["session", "bad"].includes(f.code))), `invalid session on the socket: ${JSON.stringify(frames)}`);
    assert.ok(!frames.some((f) => f.t === "hello"), "no hello for an invalid session");
    if (ws.readyState === WebSocket.OPEN) { // still open: it may do nothing without a session
        const n = frames.length;
        ws.send(JSON.stringify({ t: "open", table: T }));
        await settle(300);
        assert.ok(frames.slice(n).every((f) => f.t !== "view"), "no view without a session");
        assert.ok(frames.slice(n).some((f) => f.t === "bye" || f.t === "error") || ws.readyState !== WebSocket.OPEN, "refused");
    }
    ws.close();
});

// G3 (games-gates 21:48): a federated sign-in the other side or the SSRF guard refuses answered HTTP 503 `db`
test("the session route answers truthful codes for a refused or unreachable remote server, never db", { skip }, async () => {
    const post = (tok) => http("POST", "/session", { openid: { access_token: tok, matrix_server_name: "far.example", token_type: "Bearer", expires_in: 60 }, user_id: "@p:far.example", client: { kind: "web" } });
    const a = await post("throw:remote-refused");
    assert.deepEqual([a.status, a.body.code], [403, "remote-refused"]);
    const b = await post("throw:unavailable");
    assert.deepEqual([b.status, b.body.code], [503, "unavailable"]);
    const c = await post("not-a-good-token");
    assert.deepEqual([c.status, c.body.code], [401, "session"]);
});
