// The play mock (play/mock.mjs) the app lanes code against: a scripted walk through its HTTP + socket surface, every
// frame it sends checked against the frozen schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { SCHEMA } from "../play/contract/schema.mjs";
import { validate } from "../play/jsonschema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

async function startMock(extra = []) {
    const port = await freePort();
    const child = spawn(process.execPath, [join(HERE, "../play/tools/mock.mjs"), "--port", String(port), "--views", join(HERE, "vectors/play/views"), "--quiet", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let errText = "";
    child.stderr.on("data", (d) => { errText += d; });
    await new Promise((ok, no) => { child.stdout.on("data", (d) => { if (String(d).includes("play mock on")) ok(); }); child.on("exit", (c) => no(new Error(`mock exited ${c}: ${errText}`))); });
    return { base: `http://127.0.0.1:${port}/api/play/v1`, ws: `ws://127.0.0.1:${port}/api/play/v1/ws`, child, errText: () => errText };
}
async function stop(m) { if (m.child.exitCode === null) { m.child.kill("SIGTERM"); await once(m.child, "exit"); } assert.equal(m.child.exitCode !== null || m.child.signalCode !== null, true); }

const ok = (def, v) => assert.deepEqual(validate(SCHEMA, { $ref: `#/$defs/${def}` }, v), [], def);
async function http(m, method, path, body, session) {
    const r = await fetch(m.base + path, { method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Play ${session}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, cors: r.headers.get("access-control-allow-origin") };
}
function client(m, session) {
    const ws = new WebSocket(m.ws);
    const frames = [];
    const waiters = [];
    ws.addEventListener("message", (e) => {
        const f = JSON.parse(e.data);
        if (f.t !== "_mock") assert.deepEqual(validate(SCHEMA, { $ref: "#/$defs/serverFrame" }, f), [], `frame ${f.t}`);
        frames.push(f);
        for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.ok(f); }
    });
    const c = {
        ws, frames,
        open: once(ws, "open").then(() => ws.send(JSON.stringify({ t: "auth", session, client: { kind: "web", pad: false } }))),
        send: (f) => ws.send(JSON.stringify(f)),
        wait: (pred, ms = 3000) => new Promise((res, rej) => {
            const hit = frames.find(pred); if (hit) { frames.splice(frames.indexOf(hit), 1); return res(hit); }
            const w = { pred, ok: (f) => { frames.splice(frames.indexOf(f), 1); clearTimeout(tm); res(f); } };
            const tm = setTimeout(() => rej(new Error("timeout waiting for a frame")), ms);
            waiters.push(w);
        }),
    };
    return c;
}
let opn = 0;
const op = () => `games-s1-mock-${String(++opn).padStart(4, "0")}`;
const ROOM = "!lab:play.test";

test("the mock: session, opt-in, me, ranks, tables, a Hold'em walk with acks, stale/dup/turn/amount refusals", async () => {
    const m = await startMock();
    try {
        const s = await http(m, "POST", "/session", { openid: { access_token: "x", matrix_server_name: "play.test", token_type: "Bearer", expires_in: 3600 }, user_id: "@player-test3:play.test", client: { kind: "web" } });
        assert.equal(s.status, 200); assert.equal(s.cors, "*"); ok("sessionAnswer", s.body);
        const S = s.body.session;
        const sp = await http(m, "GET", `/rooms/${encodeURIComponent(ROOM)}/space`, null, S); ok("spaceAnswer", sp.body);
        const SP = sp.body.space;
        assert.equal(sp.body.server, "play.test");
        assert.equal((await http(m, "GET", `/me?space=${encodeURIComponent(SP)}`, null, S)).status, 404);
        assert.equal((await http(m, "GET", `/me?space=${encodeURIComponent(SP)}`, null, "x".repeat(43))).status, 401);
        const w = await http(m, "POST", "/wallet", { space: SP }, S); assert.equal(w.status, 201); ok("me", w.body);
        const me = await http(m, "GET", `/me?space=${encodeURIComponent(SP)}`, null, S); ok("me", me.body); assert.equal(me.body.rank, 4); assert.equal(me.body.cap, 300);
        const rk = await http(m, "GET", `/ranks?space=${encodeURIComponent(SP)}&u=@player-test3:play.test&u=@nobody:play.test`, null, S); ok("ranks", rk.body);
        assert.deepEqual(rk.body.ranks, { "@player-test3:play.test": 4 });
        const tl = await http(m, "GET", `/rooms/${encodeURIComponent(ROOM)}/tables`, null, S); ok("tables", tl.body);
        assert.equal(tl.body.tables.length, 2); assert.equal(tl.body.space, SP);
        assert.equal((await http(m, "POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "holdem", space: SP, opts: { seats: 8 } }, S)).body.code, "one-per-room");
        assert.equal((await http(m, "POST", `/rooms/${encodeURIComponent(ROOM)}/tables`, { game: "holdem", space: "!other:play.test", opts: { seats: 8 } }, S)).body.code, "space-changed");
        // the space errors, each from its own test room
        for (const [room, code, status] of [["!nospace1:play.test", "no-space", 403], ["!remote1:play.test", "wrong-server", 403], ["!unavail1:play.test", "unavailable", 503]]) {
            const r = await http(m, "GET", `/rooms/${encodeURIComponent(room)}/space`, null, S);
            assert.equal(r.status, status); assert.equal(r.body.code, code); ok("httpError", r.body);
            if (code === "wrong-server") assert.equal(r.body.server, "other.example");
        }
        const H = tl.body.tables.find((t) => t.game === "holdem").table;

        const c = client(m, S); await c.open;
        const hello = await c.wait((f) => f.t === "hello"); assert.equal(hello.user, "@player-test3:play.test");
        c.send({ t: "sub", room: ROOM });
        await c.wait((f) => f.t === "room");
        c.send({ t: "open", table: H });
        let v = await c.wait((f) => f.t === "view" && f.view.status === "lobby");
        assert.equal(v.view.you.seat, 1); assert.equal(v.view.host, "@player-test3:play.test"); assert.equal(v.view.space, SP);
        // deal (table move, no `at`)
        const o1 = op(); c.send({ t: "act", table: H, op: o1, a: { do: "deal" } });
        assert.equal((await c.wait((f) => f.t === "ack" && f.op === o1)).ok, true);
        v = await c.wait((f) => f.t === "view" && f.view.hand?.street === "preflop");
        assert.equal(v.view.hand.to_act.seat, 6);
        assert.equal(v.view.you.legal, null);
        // not my turn (seat 6 acts), and a stale turn
        const o2 = op(); c.send({ t: "act", table: H, op: o2, at: { hand: 1, turn: 1 }, a: { do: "fold" } });
        assert.equal((await c.wait((f) => f.t === "ack" && f.op === o2)).code, "not-your-turn");
        const o3 = op(); c.send({ t: "act", table: H, op: o3, at: { hand: 1, turn: 9 }, a: { do: "fold" } });
        assert.equal((await c.wait((f) => f.t === "ack" && f.op === o3)).code, "stale");
        // become seat 6 (mock control), then a raise below the minimum, then a good one, then its resend
        c.send({ t: "_mock", table: H, as: "seat6" });
        v = await c.wait((f) => f.t === "view" && f.view.you?.seat === 6);
        assert.deepEqual(v.view.you.legal, { fold: true, check: false, call: 2, raise: { min: 4, max: 20 } });
        const o4 = op(); c.send({ t: "act", table: H, op: o4, at: { hand: 1, turn: 1 }, a: { do: "raise", to: 3 } });
        assert.equal((await c.wait((f) => f.t === "ack" && f.op === o4)).code, "bad-amount");
        const o5 = op(); c.send({ t: "act", table: H, op: o5, at: { hand: 1, turn: 1 }, a: { do: "raise", to: 6 } });
        const a5 = await c.wait((f) => f.t === "ack" && f.op === o5); assert.equal(a5.ok, true); assert.equal(a5.dup, false);
        await c.wait((f) => f.t === "view" && f.view.hand?.to_act?.seat === 1);
        c.send({ t: "act", table: H, op: o5, at: { hand: 1, turn: 1 }, a: { do: "raise", to: 6 } });
        const d5 = await c.wait((f) => f.t === "ack" && f.op === o5); assert.equal(d5.dup, true); assert.equal(d5.ok, true);
        // a malformed frame is answered, not fatal
        c.send({ t: "act", table: H, op: "short", a: { do: "fold" } });
        assert.equal((await c.wait((f) => f.t === "error")).code, "bad");
        c.send({ t: "ping" }); await c.wait((f) => f.t === "pong");
        c.ws.close();
        assert.equal(m.errText().includes("mock BUG"), false, m.errText());
    } finally { await stop(m); }
});

test("the mock: The Rig is refused to a phone-app session while the switch is off, offered with --rig-phone", async () => {
    for (const [extra, hidden] of [[[], true], [["--rig-phone"], false]]) {
        const m = await startMock(extra);
        try {
            const s = await http(m, "POST", "/session", { user_id: "@player-test1:play.test", client: { kind: "ios-app" } });
            assert.equal(s.body.rig_hidden, hidden);
            const tl = await http(m, "GET", `/rooms/${encodeURIComponent(ROOM)}/tables`, null, s.body.session);
            const R = tl.body.tables.find((t) => t.game === "rig").table;
            assert.equal((await http(m, "GET", `/tables/${R}`, null, s.body.session)).status, hidden ? 403 : 200);
            const c = client(m, s.body.session); await c.open; await c.wait((f) => f.t === "hello");
            c.send({ t: "open", table: R });
            const f = await c.wait((x) => x.t === "error" || x.t === "view");
            assert.equal(f.t === "error" ? f.code : "view", hidden ? "rig-hidden" : "view");
            if (!hidden) { ok("rigView", f.view); assert.equal(f.view.status, "lobby"); }
            c.ws.close();
        } finally { await stop(m); }
    }
});

test("the mock: you.screens follows the person's open sockets (a Pad attaching and detaching)", async () => {
    const m = await startMock();
    try {
        const s = await http(m, "POST", "/session", { user_id: "@player-test2:play.test", client: { kind: "desktop" } });
        const S = s.body.session;
        const sp = (await http(m, "GET", `/rooms/${encodeURIComponent(ROOM)}/space`, null, S)).body.space;
        await http(m, "POST", "/wallet", { space: sp }, S);
        const H = (await http(m, "GET", `/rooms/${encodeURIComponent(ROOM)}/tables`, null, S)).body.tables.find((t) => t.game === "holdem").table;
        const desk = client(m, S); await once(desk.ws, "open");
        desk.send({ t: "auth", session: S, client: { kind: "desktop", pad: false } }); await desk.wait((f) => f.t === "hello");
        desk.send({ t: "open", table: H });
        assert.deepEqual((await desk.wait((f) => f.t === "view" && f.view.you)).view.you.screens, ["desktop"]);
        const pad = client(m, S); await once(pad.ws, "open");
        pad.send({ t: "auth", session: S, client: { kind: "web", pad: true } }); await pad.wait((f) => f.t === "hello");
        pad.send({ t: "open", table: H });
        assert.deepEqual((await desk.wait((f) => f.t === "view" && f.view.you?.screens.includes("pad"))).view.you.screens, ["desktop", "pad", "web"]);
        pad.ws.close();
        assert.deepEqual((await desk.wait((f) => f.t === "view" && !f.view.you?.screens.includes("pad"))).view.you.screens, ["desktop"]);
        desk.ws.close();
    } finally { await stop(m); }
});
