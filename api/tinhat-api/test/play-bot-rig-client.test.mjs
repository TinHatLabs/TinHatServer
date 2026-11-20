// The Rig bot's small HTTP/WebSocket client (tools/play-bot-rig.mjs, lab only) against a scripted local WebSocket
// server: RFC 6455 details the bot relies on (a frame in the upgrade response itself, fragmented messages, masked or
// oversized server frames refused) and the move loop's recovery (a connection lost before an ack: after the
// reconnect the SAME op is sent again, which the play server answers once, dup-safe).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

const { wsConnect, RigBot } = await import(new URL("../tools/play-bot-rig.mjs", import.meta.url).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// server-side frame (unmasked unless asked); client frames are masked: decode them
const frame = (op, payload, { fin = true, mask = false } = {}) => {
    const p = Buffer.from(payload);
    const hdr = p.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | p.length]) : Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 126, p.length >> 8, p.length & 255]);
    return Buffer.concat([hdr, mask ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(0), mask ? Buffer.from(p.map((b, i) => b ^ [1, 2, 3, 4][i & 3])) : p]);
};
function readClientFrames(buf) {
    const out = [];
    while (buf.length >= 6) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        const mask = buf.subarray(off, off + 4); off += 4;
        if (buf.length < off + len) break;
        const p = Buffer.from(buf.subarray(off, off + len)).map((b, i) => b ^ mask[i & 3]);
        out.push({ op: buf[0] & 15, text: Buffer.from(p).toString("utf8") });
        buf = buf.subarray(off + len);
    }
    return { out, rest: buf };
}
function server(onConn, headBytes) {
    const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); });
    srv.on("upgrade", (req, sock) => {
        const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        const pre = headBytes ? headBytes() : Buffer.alloc(0);
        sock.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`), pre]));
        let buf = Buffer.alloc(0);
        const conn = { sock, sendJSON: (o) => sock.write(frame(1, JSON.stringify(o))), got: [], onText: null };
        sock.on("data", (d) => { const r = readClientFrames(Buffer.concat([buf, d])); buf = r.rest; for (const f of r.out) if (f.op === 1) { const j = JSON.parse(f.text); conn.got.push(j); conn.onText?.(j); } });
        sock.on("error", () => {});
        onConn(conn);
    });
    return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

test("ws client: a frame inside the upgrade response and a fragmented message both arrive whole", async () => {
    const { srv, base } = await server((c) => {
        c.sock.write(frame(1, '{"t":"fr', { fin: false }));
        setTimeout(() => c.sock.write(Buffer.concat([frame(9, "p"), frame(0, 'ag"}', { fin: true })])), 50); // a ping between the fragments
    }, () => frame(1, '{"t":"head"}'));
    const got = [];
    const ws = await wsConnect({ base }, "/ws", (t) => got.push(t), () => {});
    await sleep(300);
    assert.deepEqual(got, ['{"t":"head"}', '{"t":"frag"}']);
    ws.close(); srv.close();
});

test("ws client: a masked or oversized server frame closes the connection (nothing delivered)", async () => {
    for (const bad of [frame(1, '{"t":"x"}', { mask: true }), Buffer.concat([Buffer.from([0x81, 127]), Buffer.from([0, 0, 0, 0, 0x7f, 0, 0, 0])])]) {
        let closed = false;
        const got = [];
        const { srv, base } = await server((c) => c.sock.write(bad));
        await wsConnect({ base }, "/ws", (t) => got.push(t), () => { closed = true; });
        await sleep(1700);
        assert.equal(closed, true);
        assert.deepEqual(got, []);
        srv.close();
    }
});

test("bot: a move whose ack was lost with the connection is sent again with the SAME op after the reconnect", async () => {
    const conns = [];
    const view = (vseq) => ({ t: "view", table: "tR7q2wE4rT6yU8iO", vseq, view: {
        game: "rig", table: "tR7q2wE4rT6yU8iO", vseq, now: Date.now(), status: "round", host: "@b:lab.test",
        players: [{ u: "@b:lab.test", role: "mechanic", left: false }, { u: "@s:lab.test", role: "spinner", left: false }],
        round: { r: 1, spin: 0, phase: "setup", deadline: Date.now() + 20000, preset: "lite", board: [], history: [], bankroll: { start: 6, now: 6 } },
        you: { role: "mechanic", deal: ["skim", "rebound"], kept: false, market_done: true, holdings: 9 } } });
    const { srv, base } = await server((c) => {
        conns.push(c);
        c.onText = (j) => {
            if (j.t === "auth") { c.sendJSON({ t: "hello", v: 1, user: "@b:lab.test", now: Date.now() }); if (conns.length === 1) c.sendJSON(view(5)); }
            if (j.t === "act" && conns.length === 1) c.sock.destroy(); // the first connection dies before the ack
            if (j.t === "act" && conns.length === 2) c.sendJSON({ t: "ack", op: j.op, ok: true, code: "", dup: true });
        };
    });
    const bot = new RigBot({ base, room: "!room:lab.test", mock: true, speed: 50, seed: 1 }, "@b:lab.test", undefined, 0, () => {});
    bot.session = "s"; bot.space = "!space:lab.test"; bot.table = "tR7q2wE4rT6yU8iO";
    await bot.connect();
    for (let i = 0; i < 100 && !(conns[1]?.got.some((j) => j.t === "act")); i++) await sleep(100);
    const first = conns[0].got.find((j) => j.t === "act"), again = conns[1]?.got.find((j) => j.t === "act");
    assert.ok(first && again, "sent, lost, sent again");
    assert.equal(again.op, first.op, "the same op (the server dedupes it)");
    assert.deepEqual(again.a, first.a);
    await sleep(200);
    assert.equal(bot.pending, null, "the ack arrived: nothing left waiting");
    bot.stopped = true; bot.ws?.close(); srv.close();
});

test("bot: an `open` refused for a moment (not-in-call) is retried until a view arrives, then the bot joins", async () => {
    let opens = 0;
    const { srv, base } = await server((c) => {
        c.onText = (j) => {
            if (j.t === "auth") c.sendJSON({ t: "hello", v: 1, user: "@b:lab.test", now: Date.now() });
            if (j.t === "open") {
                opens++;
                if (opens === 1) c.sendJSON({ t: "error", code: "not-in-call" });
                else c.sendJSON({ t: "view", table: "tR7q2wE4rT6yU8iO", vseq: 3, view: { game: "rig", vseq: 3, now: Date.now(), status: "lobby", host: "@h:lab.test", players: [{ u: "@h:lab.test", left: false }] } });
            }
        };
    });
    const bot = new RigBot({ base, room: "!room:lab.test", mock: true, speed: 50, seed: 1 }, "@b:lab.test", undefined, 0, () => {});
    bot.session = "s"; bot.space = "!space:lab.test"; bot.table = "tR7q2wE4rT6yU8iO";
    await bot.connect();
    // the scripted server answers no join; wait for the bot to send one
    let conn;
    for (let i = 0; i < 100; i++) { await sleep(100); if (opens >= 2 && bot.view) break; }
    assert.ok(opens >= 2, "open retried");
    assert.ok(bot.view, "a view arrived");
    await sleep(200);
    assert.ok(bot.stats.acts >= 1, "then it joined");
    bot.stopped = true; bot.ws?.close(); srv.close();
});

test("bot: a table that turns out closed is dropped; the bot takes the next open Rig table from the room", async () => {
    const opened = [];
    const { srv, base } = await server((c) => {
        c.onText = (j) => {
            if (j.t === "auth") c.sendJSON({ t: "hello", v: 1, user: "@b:lab.test", now: Date.now() });
            if (j.t === "open") {
                opened.push(j.table);
                if (j.table === "tRAAAAAAAAAAAAAA") {
                    c.sendJSON({ t: "view", table: j.table, vseq: 1, view: { game: "rig", vseq: 1, now: Date.now(), status: "closed", host: "@h:lab.test", players: [] } });
                    c.sendJSON({ t: "room", room: "!room:lab.test", tables: [{ table: "tRAAAAAAAAAAAAAA", game: "rig", status: "lobby" }, { table: "tRBBBBBBBBBBBBBB", game: "rig", status: "lobby" }] });
                } else c.sendJSON({ t: "view", table: j.table, vseq: 2, view: { game: "rig", vseq: 2, now: Date.now(), status: "lobby", host: "@h:lab.test", players: [{ u: "@h:lab.test", left: false }] } });
            }
        };
    });
    const bot = new RigBot({ base, room: "!room:lab.test", mock: true, speed: 50, seed: 1 }, "@b:lab.test", undefined, 0, () => {});
    bot.session = "s"; bot.space = "!space:lab.test"; bot.table = "tRAAAAAAAAAAAAAA";
    bot.findTable = async () => null; // no HTTP here: the room frame brings the next table
    await bot.connect();
    for (let i = 0; i < 50 && bot.table !== "tRBBBBBBBBBBBBBB"; i++) await sleep(100);
    assert.equal(bot.table, "tRBBBBBBBBBBBBBB", "moved on to the open table (the stale listing of the closed one skipped)");
    for (let i = 0; i < 30 && !bot.view; i++) await sleep(100);
    assert.equal(bot.view?.status, "lobby");
    bot.stopped = true; bot.ws?.close(); srv.close();
});

test("bot: a move still waiting for its ack when the table closes is dropped, never sent to the next table", async () => {
    const acts = [];
    const { srv, base } = await server((c) => {
        c.onText = (j) => {
            if (j.t === "auth") c.sendJSON({ t: "hello", v: 1, user: "@b:lab.test", now: Date.now() });
            if (j.t === "open" && j.table === "tRAAAAAAAAAAAAAA") c.sendJSON({ t: "view", table: j.table, vseq: 1, view: { game: "rig", vseq: 1, now: Date.now(), status: "lobby", host: "@h:lab.test", players: [{ u: "@h:lab.test", left: false }] } });
            if (j.t === "act") {
                acts.push(j);
                if (j.table === "tRAAAAAAAAAAAAAA") setTimeout(() => {
                    c.sendJSON({ t: "view", table: "tRAAAAAAAAAAAAAA", vseq: 2, view: { game: "rig", vseq: 2, now: Date.now(), status: "closed", host: "@h:lab.test", players: [] } });
                    c.sendJSON({ t: "room", room: "!room:lab.test", tables: [{ table: "tRBBBBBBBBBBBBBB", game: "rig", status: "lobby" }] });
                }, 50); // no ack for the join: the table closes first
            }
            if (j.t === "open" && j.table === "tRBBBBBBBBBBBBBB") c.sendJSON({ t: "view", table: j.table, vseq: 5, view: { game: "rig", vseq: 5, now: Date.now(), status: "lobby", host: "@h:lab.test", players: [{ u: "@h:lab.test", left: false }, { u: "@b:lab.test", left: false }] } });
        };
    });
    const bot = new RigBot({ base, room: "!room:lab.test", mock: true, speed: 50, seed: 1 }, "@b:lab.test", undefined, 0, () => {});
    bot.session = "s"; bot.space = "!space:lab.test"; bot.table = "tRAAAAAAAAAAAAAA";
    let lookups = 0;
    bot.findTable = async () => { lookups++; await sleep(300); return "tRCCCCCCCCCCCCCC"; }; // slower than the room frame
    await bot.connect();
    await sleep(10_000); // past the ack timeout (8 s): nothing may be resent
    const joins = acts.filter((j) => j.a.do === "join");
    assert.equal(joins.length, 1, "the join on the closed table was not resent");
    assert.ok(joins.every((j) => j.table === "tRAAAAAAAAAAAAAA"));
    assert.equal(bot.table, "tRBBBBBBBBBBBBBB", "the room frame's table wins over a slower lookup");
    assert.equal(bot.pending, null);
    assert.equal(lookups, 1, "one lookup, no loop");
    bot.stopped = true; bot.ws?.close(); srv.close();
});
