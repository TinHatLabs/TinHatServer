// A small WebSocket server (RFC 6455), text frames only: what the play socket needs (GAMES-V1-SPEC §6.3) without a new
// dependency. The API only ever talks JSON text frames of at most 16 KiB, so this refuses everything else: binary
// frames (1003), frames or messages over the limit (1009), invalid UTF-8 (1007), unmasked client frames (1002),
// reserved bits / unknown opcodes (1002). Pings are answered; a close is echoed and the socket ended.
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BACKLOG = 1 << 20; // bytes queued to one slow client before we give up on it (any frame, pongs included)
const MAX_FRAGMENTS = 4096; // pieces of one message: bounded so empty continuation frames can't grow memory for free
const MAX_CONTROL_PER_S = 20; // pings/pongs a second before the connection is closed

/**
 * Accept WebSocket upgrades on `path` (exact match after stripping a query string).
 * onConnection(conn, req) receives { send(obj), sendText(s), close(code, reason), on(event, fn), ip, closed }.
 * Events: "message" (text), "close" (code, reason).
 */
export function attachWs(server, { path, maxBytes = 16384, onConnection, accept = () => true }) {
    server.on("upgrade", (req, socket, head) => {
        const url = (req.url || "").split("?")[0];
        if (url !== path) return; // another listener may want it (none today): leave the socket alone
        const key = req.headers["sec-websocket-key"];
        const upgrade = String(req.headers.upgrade || "").toLowerCase();
        if (upgrade !== "websocket" || req.headers["sec-websocket-version"] !== "13" || typeof key !== "string"
            || !/^[A-Za-z0-9+/]{22}==$/.test(key) || !accept(req)) {
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        const acceptKey = createHash("sha1").update(key + GUID).digest("base64");
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
        socket.setNoDelay(true);
        const conn = new WsConn(socket, maxBytes, req);
        socket.on("error", () => conn._gone(1006, ""));
        socket.on("close", () => conn._gone(1006, ""));
        // the application's handlers first, THEN any bytes that came with the upgrade (an auth frame in `head` is kept)
        try { onConnection(conn, req); } catch (e) { conn.close(1011, "error"); throw e; }
        socket.on("data", (d) => conn._feed(d));
        if (head && head.length) conn._feed(head);
    });
}

class WsConn {
    constructor(socket, maxBytes, req) {
        this.socket = socket;
        this.maxBytes = maxBytes;
        this.buf = Buffer.alloc(0);
        this.frag = null; // pieces of a fragmented text message
        this.fragLen = 0;
        this.ctl = { at: Date.now(), n: 0 };
        this.closed = false;
        this.handlers = { message: [], close: [] };
        this.ip = req.socket?.remoteAddress || "";
        this.decoder = new TextDecoder("utf-8", { fatal: true });
    }
    on(ev, fn) { this.handlers[ev].push(fn); return this; }
    _emit(ev, ...a) { for (const fn of this.handlers[ev]) fn(...a); }
    send(obj) { this.sendText(JSON.stringify(obj)); }
    sendText(s) {
        if (this.closed) return;
        if (this.socket.writableLength > MAX_BACKLOG) { this.close(1008, "slow"); return; }
        this._write(0x1, Buffer.from(s, "utf8"));
    }
    _write(op, payload) {
        if (this.socket.writableLength > MAX_BACKLOG) { this.socket.destroy(); this._gone(1008, "slow"); return; }
        const n = payload.length;
        let hdr;
        if (n < 126) { hdr = Buffer.from([0x80 | op, n]); }
        else if (n < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
        else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
        this.socket.write(Buffer.concat([hdr, payload]));
    }
    close(code = 1000, reason = "") {
        if (this.closed) return;
        const r = Buffer.from(String(reason).slice(0, 100), "utf8");
        const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
        try { this._write(0x8, p); } catch { /* socket already gone */ }
        this._gone(code, String(reason));
        this.socket.end();
        setTimeout(() => this.socket.destroy(), 2000).unref?.();
    }
    _gone(code, reason) {
        if (this.closed) return;
        this.closed = true;
        this._emit("close", code, reason);
    }
    _feed(d) {
        if (this.closed) return;
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        for (;;) {
            if (this.closed || this.buf.length < 2) return;
            const b0 = this.buf[0], b1 = this.buf[1];
            const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
            if (b0 & 0x70) { this.close(1002, "rsv"); return; }
            if (!masked) { this.close(1002, "unmasked"); return; }
            let len = b1 & 0x7f, off = 2;
            if (len === 126) {
                if (this.buf.length < 4) return;
                len = this.buf.readUInt16BE(2); off = 4;
                if (len < 126) { this.close(1002, "length"); return; } // the minimal encoding is required
            } else if (len === 127) {
                if (this.buf.length < 10) return;
                const big = this.buf.readBigUInt64BE(2);
                if (big < 65536n) { this.close(1002, "length"); return; }
                if (big > BigInt(this.maxBytes)) { this.close(1009, "too big"); return; }
                len = Number(big); off = 10;
            }
            if (op >= 0x8 && (len > 125 || !fin)) { this.close(1002, "control"); return; }
            if (len > this.maxBytes) { this.close(1009, "too big"); return; }
            if (this.buf.length < off + 4 + len) { // an incomplete frame: never buffer more than one frame's worth
                if (this.buf.length > this.maxBytes + 14) { this.close(1009, "too big"); }
                return;
            }
            const mask = this.buf.subarray(off, off + 4);
            const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
            for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
            this.buf = this.buf.subarray(off + 4 + len);
            if (op === 0x8) { // close: a valid code is echoed; a malformed close payload is a protocol error
                if (payload.length === 1) { this.close(1002, "close"); return; }
                if (payload.length >= 2) {
                    const code = payload.readUInt16BE(0);
                    const okCode = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code < 5000);
                    try { this.decoder.decode(payload.subarray(2)); } catch { this.close(1007, "utf-8"); return; }
                    this.close(okCode ? code : 1002, "");
                } else this.close(1000, "");
                return;
            }
            if (op === 0x9 || op === 0xA) { // ping → pong; both counted (a flood is closed)
                const t = Date.now();
                if (t - this.ctl.at > 1000) { this.ctl = { at: t, n: 0 }; }
                if (++this.ctl.n > MAX_CONTROL_PER_S) { this.close(1008, "control flood"); return; }
                if (op === 0x9) this._write(0xA, payload);
                continue;
            }
            if (op === 0x2) { this.close(1003, "text only"); return; }
            if (op === 0x1) {
                if (this.frag) { this.close(1002, "interleaved"); return; }
                if (fin) { this._text(payload); continue; }
                this.frag = [payload]; this.fragLen = len; continue;
            }
            if (op === 0x0) {
                if (!this.frag) { this.close(1002, "continuation"); return; }
                this.fragLen += len;
                if (this.fragLen > this.maxBytes || this.frag.length >= MAX_FRAGMENTS) { this.close(1009, "too big"); return; }
                this.frag.push(payload);
                if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this._text(all); }
                continue;
            }
            this.close(1002, "opcode"); return;
        }
    }
    _text(payload) {
        let s;
        try { s = this.decoder.decode(payload); } catch { this.close(1007, "utf-8"); return; }
        this._emit("message", s);
    }
}
