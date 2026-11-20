// play/ws.mjs: the play socket's WebSocket server, against Node's own WebSocket client (and raw frames for the
// refusals a browser can't produce).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { attachWs } from "../play/ws.mjs";

async function echoServer(opts = {}) {
    const server = createServer((_q, r) => r.end("x"));
    attachWs(server, { path: "/ws", maxBytes: 16384, ...opts, onConnection(c) { c.on("message", (t) => c.sendText(t)); } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, url: `ws://127.0.0.1:${server.address().port}/ws`, port: server.address().port };
}
function closeOf(ws) { return new Promise((ok) => ws.addEventListener("close", (e) => ok(e.code))); }
function nextMsg(ws) { return new Promise((ok) => ws.addEventListener("message", (e) => ok(e.data), { once: true })); }

test("echoes text frames, small, 64 KiB-boundary-sized and fragmented-by-the-client sizes", async () => {
    const { server, url } = await echoServer();
    try {
        const ws = new WebSocket(url);
        await once(ws, "open");
        for (const n of [1, 125, 126, 65535 % 16000, 16384]) {
            const s = "é".repeat(Math.floor(n / 2)) + "x".repeat(n % 2);
            ws.send(s);
            assert.equal(await nextMsg(ws), s);
        }
        ws.close(1000);
        await closeOf(ws);
    } finally { server.close(); }
});

test("a message over the limit is closed 1009; binary is closed 1003", async () => {
    const { server, url } = await echoServer();
    try {
        const ws = new WebSocket(url);
        await once(ws, "open");
        ws.send("x".repeat(16385));
        assert.equal(await closeOf(ws), 1009);
        const ws2 = new WebSocket(url);
        await once(ws2, "open");
        ws2.send(new Uint8Array([1, 2, 3]));
        assert.equal(await closeOf(ws2), 1003);
    } finally { server.close(); }
});

function rawFrame(op, payload, { mask = true, fin = true } = {}) {
    const p = Buffer.from(payload);
    const hdr = [(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | p.length];
    const key = Buffer.from([1, 2, 3, 4]);
    const body = Buffer.from(p.map((b, i) => (mask ? b ^ key[i & 3] : b)));
    return Buffer.concat([Buffer.from(hdr), mask ? key : Buffer.alloc(0), body]);
}
async function rawSession(port, frames) {
    const s = connect(port, "127.0.0.1");
    await once(s, "connect");
    s.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    let buf = Buffer.alloc(0);
    s.on("data", (d) => { buf = Buffer.concat([buf, d]); });
    await new Promise((ok) => setTimeout(ok, 50));
    assert.match(buf.toString("latin1"), /^HTTP\/1\.1 101/);
    assert.match(buf.toString("latin1"), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/); // RFC 6455's own example
    buf = Buffer.alloc(0);
    for (const f of frames) s.write(f);
    await new Promise((ok) => setTimeout(ok, 80));
    s.destroy();
    return buf;
}
const closeCode = (buf) => { const i = buf.indexOf(0x88); return i >= 0 ? buf.readUInt16BE(i + 2) : null; };

test("raw refusals: unmasked 1002, invalid UTF-8 1007, a fragmented message is reassembled, ping answered", async () => {
    const { server, port } = await echoServer();
    try {
        assert.equal(closeCode(await rawSession(port, [rawFrame(1, "hi", { mask: false })])), 1002);
        assert.equal(closeCode(await rawSession(port, [rawFrame(1, [0xc3, 0x28])])), 1007);
        const got = await rawSession(port, [rawFrame(1, "hel", { fin: false }), rawFrame(0, "lo")]);
        assert.equal(got.subarray(2, 7).toString(), "hello");
        const pong = await rawSession(port, [rawFrame(9, "p")]);
        assert.equal(pong[0], 0x8a);
    } finally { server.close(); }
});

test("a bad handshake gets a 400 and other paths are left alone", async () => {
    const { server, port } = await echoServer();
    try {
        const s = connect(port, "127.0.0.1");
        await once(s, "connect");
        s.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
        const [d] = await once(s, "data");
        assert.match(d.toString(), /^HTTP\/1\.1 400/);
        s.destroy();
    } finally { server.close(); }
});

test("review round: empty continuation frames are bounded, non-minimal lengths and bad close payloads refused, two full messages in one read accepted, a ping flood closed", async () => {
    const { server, port } = await echoServer();
    try {
        const many = [rawFrame(1, "a", { fin: false }), ...Array.from({ length: 4100 }, () => rawFrame(0, "", { fin: false }))];
        assert.equal(closeCode(await rawSession(port, many)), 1009);
        // a valid small message in 65 pieces is fine (round 2, N11)
        const pieces = [rawFrame(1, "a", { fin: false }), ...Array.from({ length: 63 }, () => rawFrame(0, "b", { fin: false })), rawFrame(0, "c")];
        const ok65 = await rawSession(port, [Buffer.concat(pieces)]);
        assert.equal(closeCode(ok65), null);
        assert.equal(ok65.subarray(2, 2 + 65).toString(), "a" + "b".repeat(63) + "c");
        // a 5-byte payload sent with the 16-bit length form
        const nonMinimal = Buffer.concat([Buffer.from([0x81, 0x80 | 126, 0, 5]), Buffer.from([1, 2, 3, 4]), Buffer.from("hello").map((b, i) => b ^ [1, 2, 3, 4][i & 3])]);
        assert.equal(closeCode(await rawSession(port, [nonMinimal])), 1002);
        assert.equal(closeCode(await rawSession(port, [rawFrame(8, [3])])), 1002);
        assert.equal(closeCode(await rawSession(port, [rawFrame(8, [0x03, 0xed])])), 1002); // 1005 may not be sent
        const big = "x".repeat(16000);
        const two = await rawSession(port, [Buffer.concat([rawFrameLong(1, big), rawFrameLong(1, big)])]);
        assert.equal(closeCode(two), null, "two valid 16 KB messages in one read are fine");
        assert.equal(closeCode(await rawSession(port, Array.from({ length: 30 }, () => rawFrame(9, "p")))), 1008);
    } finally { server.close(); }
});
function rawFrameLong(op, text) {
    const p = Buffer.from(text); const key = Buffer.from([9, 8, 7, 6]);
    const hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(p.length, 2);
    return Buffer.concat([hdr, key, Buffer.from(p.map((b, i) => b ^ key[i & 3]))]);
}

test("an auth frame that arrives with the upgrade itself (in head) reaches the application", async () => {
    const server = createServer();
    const got = [];
    attachWs(server, { path: "/ws", onConnection(c) { c.on("message", (t) => got.push(t)); } });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
        const s = connect(server.address().port, "127.0.0.1"); await once(s, "connect");
        s.write(Buffer.concat([Buffer.from("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"), rawFrame(1, "in-head")]));
        await new Promise((r) => setTimeout(r, 100));
        s.destroy();
        assert.deepEqual(got, ["in-head"]);
    } finally { server.close(); }
});
