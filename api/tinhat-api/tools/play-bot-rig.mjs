#!/usr/bin/env node
// The Rig bot (LAB ONLY: never shipped in the API image, never pointed at a server people use). Plays The Rig through
// the real play API exactly as an app does: Matrix sign-in → OpenID → play session → wallet (opt in) → a call
// membership in the room (no media) → the play WebSocket → join the table → play (tools/play-bot-rig-strategy.mjs).
// Node 22, no install.
//
//   node tools/play-bot-rig.mjs --base https://lab.example.org [--connect http://192.0.2.10:8080] --room '!id:server'
//        --creds FILE --seats 3 [--users @a:s,@b:s] [--table tR…] [--create] [--start] [--speed 1]
//        [--tokens FILE] [--pidfile FILE] [--seed N] [--insecure]
//   node tools/play-bot-rig.mjs --mock --base http://127.0.0.1:8787 --room '!games:example.org' --seats 3 …
//   node tools/play-bot-rig.mjs --stop --pidfile FILE          (TERM to that run, then checks it's gone)
//
// --creds: a file the operator made: JSON {"name": {user_id, password, …}} (the lab's bots.json), {"@user:server":
//   "password"}, or "user password" lines; never printed. --tokens FILE: each bot signs in ONCE and reuses its Matrix
//   token (and device) on later runs (written 0600, atomically); without it a run signs in and signs out again.
// --insecure: accept the lab box's own (Caddy-internal) TLS certificate. Lab only.
// --connect: where to open TCP when the name doesn't resolve here (the base's host name still goes in Host).
// --create: open a Rig table in the room if there is none. --start: the bot that is host starts the table (≥ 3 seated).
// --speed: delays ÷ speed (2 = twice as fast). On TERM/INT the bots leave the table and drop the call membership.
// Every log line names a bot and a move kind only: no tokens, no passwords, no cards; server codes are logged only
// when they look like codes.
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, existsSync, chmodSync, renameSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./play-bot-rig-strategy.mjs";

const CALL_MEMBER = "org.matrix.msc3401.call.member";
const CALL_EXPIRES_MS = 4 * 3600_000;
export const NET = Object.freeze({
    ping_ms: 20_000, silent_ms: 60_000, open_retry_ms: 4_000, open_retry_max_ms: 30_000, handshake_ms: 10_000, request_ms: 15_000, max_frame: 1 << 20,
    ack_ms: 8_000, ack_resends: 3, join_retry_ms: 15_000, reconnect_min_ms: 2_000, reconnect_max_ms: 8_000,
});
const code = (c) => (typeof c === "string" && /^[A-Za-z_-]{1,40}$/.test(c) ? c : "other"); // never echo odd server text

// ------------------------------------------------------------------------------------------------- tiny HTTP + WS
function target(o) {
    const pub = new URL(o.base);
    const tcp = new URL(o.connect || o.base);
    return { pub, tcp, mod: tcp.protocol === "https:" ? https : http, port: tcp.port || (tcp.protocol === "https:" ? 443 : 80) };
}

export function request(o, method, path, body, headers = {}) {
    const { pub, tcp, mod, port } = target(o);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        let done = false;
        const fail = (e) => { if (!done) { done = true; reject(e); } };
        const req = mod.request({
            host: tcp.hostname, port, method, path, servername: pub.hostname, rejectUnauthorized: !o.insecure,
            headers: { Host: pub.host, Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...headers },
        }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("aborted", () => fail(new Error("response aborted")));
            res.on("error", () => fail(new Error("response error")));
            res.on("end", () => {
                if (done) return;
                done = true;
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
                resolve({ status: res.statusCode, json });
            });
            res.on("close", () => fail(new Error("response closed early")));
        });
        req.setTimeout(NET.request_ms, () => req.destroy(new Error("timeout")));
        req.on("error", () => fail(new Error(`${method} failed`)));
        if (data) req.write(data);
        req.end();
    });
}

// A small RFC 6455 client: text messages (fragmented ones assembled), ping/pong, close; a bounded frame size, a
// handshake deadline and a silence watchdog (the play socket answers our pings, so 60 s of nothing = dead).
export function wsConnect(o, path, onText, onClose) {
    const { pub, tcp, mod, port } = target(o);
    const key = randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
        let settled = false;
        const req = mod.request({
            host: tcp.hostname, port, path, servername: pub.hostname, rejectUnauthorized: !o.insecure,
            headers: { Host: pub.host, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key },
        });
        const hs = setTimeout(() => { req.destroy(); if (!settled) { settled = true; reject(new Error("websocket handshake timeout")); } }, NET.handshake_ms);
        req.on("error", () => { clearTimeout(hs); if (!settled) { settled = true; reject(new Error("websocket connect failed")); } });
        req.on("response", (res) => { clearTimeout(hs); res.resume(); req.destroy(); if (!settled) { settled = true; reject(new Error(`websocket refused: HTTP ${res.statusCode}`)); } });
        req.on("upgrade", (res, sock, head) => {
            clearTimeout(hs);
            const want = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
            if (res.headers["sec-websocket-accept"] !== want) { sock.destroy(); settled = true; return reject(new Error("bad websocket accept")); }
            let buf = Buffer.alloc(0), state = "open", parts = null, lastIn = Date.now();
            const send = (op, payload) => {
                if (state !== "open" && op !== 8) return false;
                const p = Buffer.from(payload), mask = randomBytes(4), len = p.length;
                if (len >= 65536) return false; // our frames are small; never throw from a timer
                const hdr = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 255]);
                for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
                sock.write(Buffer.concat([hdr, mask, p]));
                return true;
            };
            const finish = () => {
                if (state === "closed") return;
                state = "closed"; clearInterval(watch); sock.destroy(); onClose();
            };
            const closeNow = () => { if (state === "open") { send(8, Buffer.alloc(0)); state = "closing"; setTimeout(finish, 1000); } };
            const parse = () => {
                while (state === "open") {
                    if (buf.length < 2) return;
                    const fin = buf[0] & 0x80, rsv = buf[0] & 0x70, op = buf[0] & 15, masked = buf[1] & 0x80;
                    let len = buf[1] & 127, off = 2;
                    if (rsv || masked) return closeNow(); // a server never masks; no extensions were agreed
                    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) {
                        if (buf.length < 10) return;
                        const big = buf.readBigUInt64BE(2);
                        if (big > BigInt(NET.max_frame)) return closeNow();
                        len = Number(big); off = 10;
                    }
                    if (len > NET.max_frame || (op >= 8 && (len > 125 || !fin))) return closeNow();
                    if (buf.length < off + len) return;
                    const payload = buf.subarray(off, off + len);
                    buf = buf.subarray(off + len);
                    if (op === 1 || op === 0) {
                        if (op === 1) parts = [];
                        if (!parts) return closeNow(); // a continuation without a start
                        parts.push(payload);
                        if (parts.reduce((s, b) => s + b.length, 0) > NET.max_frame) return closeNow();
                        if (fin) { const t = Buffer.concat(parts).toString("utf8"); parts = null; onText(t); }
                    } else if (op === 9) send(10, payload);
                    else if (op === 10) { /* pong */ } else if (op === 8) { send(8, Buffer.alloc(0)); state = "closing"; setTimeout(finish, 500); return; } else return closeNow();
                }
            };
            sock.on("data", (d) => { lastIn = Date.now(); buf = Buffer.concat([buf, d]); if (buf.length > NET.max_frame + 16) return closeNow(); parse(); });
            sock.on("close", finish);
            sock.on("error", finish);
            const watch = setInterval(() => { if (Date.now() - lastIn > NET.silent_ms) finish(); }, 5000);
            settled = true;
            resolve({ sendText: (t) => send(1, Buffer.from(t, "utf8")), close: closeNow, isOpen: () => state === "open" });
            if (head && head.length) { buf = Buffer.from(head); setImmediate(parse); }
        });
        req.end();
    });
}

// ------------------------------------------------------------------------------------------------ files (secrets)
function readCreds(file) {
    const text = readFileSync(file, "utf8");
    let j = null;
    try { j = JSON.parse(text); } catch { /* lines */ }
    const out = {};
    if (j && typeof j === "object") {
        for (const [k, v] of Object.entries(j)) {
            if (v && typeof v === "object" && typeof v.user_id === "string" && typeof v.password === "string") out[v.user_id] = v.password;
            else if (typeof v === "string") out[k] = v;
        }
        return out;
    }
    for (const line of text.split("\n")) { const m = line.trim().match(/^(\S+)\s+(.+)$/); if (m) out[m[1]] = m[2]; }
    return out;
}
// the token cache: a regular file of ours, 0600, replaced atomically (a temp file created exclusively, then renamed)
function readTokens(file) {
    if (!existsSync(file)) return {};
    const st = lstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid()) throw new Error("--tokens must be a regular file owned by this user");
    if ((st.mode & 0o077) !== 0) chmodSync(file, 0o600);
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}
function writeTokens(file, c) {
    const tmp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tokens.tmp`);
    writeFileSync(tmp, JSON.stringify(c), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
}

const seeded = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const opId = () => randomBytes(12).toString("base64url");
const enc = encodeURIComponent;
const sameMoment = (a, b) => !!(a?.round && b?.round && a.round.r === b.round.r && a.round.spin === b.round.spin && a.round.phase === b.round.phase);

// ------------------------------------------------------------------------------------------------------- one bot
export class RigBot {
    constructor(o, user, password, index, log) {
        this.o = o; this.user = user; this.password = password; this.index = index; this.log = (m) => log(`[${user}] ${m}`);
        this.rnd = seeded((o.seed ?? Date.now()) + index * 7919);
        this.mem = { pace: o.speed || 1 };
        this.view = null; this.vseq = 0; this.viewAt = 0;
        this.plan = null;        // the scheduled move: {timer, d, moment}
        this.pending = null;     // a sent move awaiting its ack: {op, a, at, key, tries, timer}
        this.stopped = false; this.ready = false; this.conn = 0; this.timers = new Set(); this.closedTables = new Set(); this.lookGen = 0;
        this.stats = { views: 0, acts: 0, acked: 0, refused: {}, errors: [] };
    }
    later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms); this.timers.add(t); return t; }
    cancel(t) { if (t) { clearTimeout(t); this.timers.delete(t); } }
    async openid() {
        if (this.o.mock) return { access_token: "mock", matrix_server_name: this.user.split(":")[1], token_type: "Bearer", expires_in: 3600 };
        const r = await request(this.o, "POST", `/_matrix/client/v3/user/${enc(this.user)}/openid/request_token`, {}, { Authorization: `Bearer ${this.mx.token}` });
        if (r.status !== 200) throw new Error(`no OpenID token (HTTP ${r.status})`);
        return r.json;
    }
    async signIn() {
        const o = this.o;
        if (o.mock) return;
        const cache = o.tokens ? readTokens(o.tokens) : {};
        const cached = cache[this.user];
        if (cached) {
            const who = await request(o, "GET", "/_matrix/client/v3/account/whoami", undefined, { Authorization: `Bearer ${cached.token}` });
            if (who.status === 200 && who.json?.user_id === this.user) { this.mx = cached; this.log("reusing its signed-in device"); }
        }
        if (!this.mx) {
            const login = await request(o, "POST", "/_matrix/client/v3/login", {
                type: "m.login.password", identifier: { type: "m.id.user", user: this.user }, password: this.password,
                initial_device_display_name: "Rig bot (lab)",
            });
            if (login.status !== 200) throw new Error(`sign-in refused (HTTP ${login.status} ${code(login.json?.errcode)})`);
            this.mx = { token: login.json.access_token, device: login.json.device_id };
            if (o.tokens) { const c = readTokens(o.tokens); c[this.user] = this.mx; writeTokens(o.tokens, c); }
            this.log("signed in (one new device)");
        }
        const join = await request(o, "POST", `/_matrix/client/v3/join/${enc(o.room)}`, {}, { Authorization: `Bearer ${this.mx.token}` });
        if (join.status !== 200) throw new Error(`can't join the room (HTTP ${join.status} ${code(join.json?.errcode)})`);
    }
    async callMembership(on) {
        if (this.o.mock || !this.mx) return;
        const sk = `_${this.user}_${this.mx.device}_m.call`;
        const content = on ? {
            application: "m.call", call_id: "", scope: "m.room", device_id: this.mx.device, created_ts: Date.now(), expires: CALL_EXPIRES_MS,
            focus_active: { type: "livekit", focus_selection: "oldest_membership" }, foci_preferred: [],
        } : {};
        const r = await request(this.o, "PUT", `/_matrix/client/v3/rooms/${enc(this.o.room)}/state/${CALL_MEMBER}/${enc(sk)}`, content, { Authorization: `Bearer ${this.mx.token}` });
        if (r.status !== 200) throw new Error(`call membership ${on ? "on" : "off"} refused (HTTP ${r.status} ${code(r.json?.errcode)})`);
        this.inCall = on;
    }
    // (re)opens the play session with a FRESH OpenID token each time (an old one may have expired)
    async playSession() {
        const o = this.o;
        const s = await request(o, "POST", "/api/play/v1/session", { openid: await this.openid(), user_id: this.user, client: { kind: "web", v: "rig-bot", pad: false } });
        if (s.status !== 200) throw new Error(`play session refused (HTTP ${s.status} ${code(s.json?.code)})`);
        this.session = s.json.session;
        const P = { Authorization: `Play ${this.session}` };
        const sp = await request(o, "GET", `/api/play/v1/rooms/${enc(o.room)}/space`, undefined, P);
        if (sp.status !== 200) throw new Error(`room space: HTTP ${sp.status} ${code(sp.json?.code)}`);
        this.space = sp.json.space;
        const wallets = s.json.wallets || (s.json.wallet ? [this.space] : []);
        if (!wallets.includes(this.space)) {
            const w = await request(o, "POST", "/api/play/v1/wallet", { space: this.space }, P);
            if (w.status !== 200 && w.status !== 201) throw new Error(`opt-in refused (HTTP ${w.status} ${code(w.json?.code)})`);
            this.log("opted in");
        }
    }
    async findTable() {
        const o = this.o, P = { Authorization: `Play ${this.session}` };
        if (o.table && !this.closedTables.has(o.table)) return o.table;
        const usable = (x) => x.game === "rig" && x.status !== "closed" && !this.closedTables.has(x.table);
        const list = async () => ((await request(o, "GET", `/api/play/v1/rooms/${enc(o.room)}/tables`, undefined, P)).json?.tables || []).find(usable)?.table ?? null;
        const t = await list();
        if (t || !o.create) return t;
        const c = await request(o, "POST", `/api/play/v1/rooms/${enc(o.room)}/tables`, { game: "rig", opts: { preset: "full", bankroll: 6, patch: true }, space: this.space }, P);
        if (c.status === 201) { this.log("opened a Rig table"); return c.json.table; }
        return list(); // another bot won the race
    }
    async connect() {
        if (this.stopped) return;
        const n = ++this.conn;
        this.ready = false;
        const ws = await wsConnect(this.o, "/api/play/v1/ws", (t) => n === this.conn && this.onFrame(t), () => n === this.conn && this.onClosed());
        if (this.stopped || n !== this.conn) { ws.close(); return; }
        this.ws = ws;
        this.send({ t: "auth", session: this.session, client: { kind: "web", pad: false } });
        this.send({ t: "sub", room: this.o.room });
        if (this.table) this.openTable();
        this.cancel(this.pinger);
        const ping = () => { this.send({ t: "ping" }); this.pinger = this.later(NET.ping_ms, ping); };
        this.pinger = this.later(NET.ping_ms, ping);
    }
    send(f) { return this.ws?.isOpen() ? this.ws.sendText(JSON.stringify(f)) : false; }
    // `open` the table, and again with a growing pause until a view arrives (it can be refused for a moment, e.g.
    // not-in-call before the server has seen the call membership just posted)
    openTable(wait = NET.open_retry_ms) {
        this.cancel(this.openTimer);
        if (this.stopped || !this.table) return;
        this.send({ t: "open", table: this.table });
        const conn = this.conn, since = this.viewAt;
        this.openTimer = this.later(wait, () => {
            if (conn === this.conn && this.viewAt === since && this.ready !== null) this.openTable(Math.min(wait * 2, NET.open_retry_max_ms));
        });
    }
    async start() {
        await this.signIn();
        await this.callMembership(true);
        await this.playSession();
        this.table = await this.findTable();
        await this.connect();
        if (!this.table) this.log("no Rig table in the room yet: waiting for one");
        if (!this.o.mock) { const refresh = () => { this.callMembership(true).catch((e) => this.log(e.message)); this.later(CALL_EXPIRES_MS / 2, refresh); }; this.later(CALL_EXPIRES_MS / 2, refresh); }
    }
    onClosed() {
        this.ready = false; this.ws = null;
        this.cancel(this.pinger);
        this.dropPlan();
        if (this.stopped) return;
        this.log("socket closed: reconnecting");
        this.cancel(this.reconnectTimer);
        this.reconnectTimer = this.later(NET.reconnect_min_ms + this.rnd() * (NET.reconnect_max_ms - NET.reconnect_min_ms), async () => {
            try { if (this.renewing) await this.renewing; await this.connect(); } catch (e) { this.log(e.message); this.onClosed(); }
        });
    }
    renewSession() {
        if (this.renewing) return this.renewing;
        this.renewing = this.playSession().then(() => { this.renewing = null; this.ws?.close(); }) // reconnect with the new one
            .catch((e) => { this.renewing = null; this.log(e.message); });
        return this.renewing;
    }
    onFrame(text) {
        let f;
        try { f = JSON.parse(text); } catch { return; }
        if (f.t === "hello") {
            this.ready = true;
            if (this.pending) this.resend(); // a move whose ack the old connection lost: same op, the server dedupes
        } else if (f.t === "room" && !this.table) {
            const rig = (f.tables || []).find((x) => x.game === "rig" && x.status !== "closed" && !this.closedTables.has(x.table));
            if (rig) { this.lookGen++; this.cancel(this.lookTimer); this.findingTable = false; this.table = rig.table; this.openTable(); }
        } else if (f.t === "view" && f.table === this.table) {
            this.cancel(this.openTimer); // any view of our table = the open worked (even one we already have)
            if (!Number.isInteger(f.vseq) || f.vseq <= this.vseq) return;
            this.vseq = f.vseq; this.view = f.view; this.viewAt = Date.now(); this.stats.views++;
            if (f.view?.status === "closed") return this.tableClosed();
            this.react();
        } else if (f.t === "ack") {
            const p = this.pending;
            if (!p || p.op !== f.op) return;
            this.cancel(p.timer);
            this.pending = null; this.stats.acked++;
            if (f.ok && p.key) this.mem.done[p.key] = true; // never resend an accepted move for the same moment
            if (!f.ok) {
                const c = code(f.code);
                this.stats.refused[c] = (this.stats.refused[c] || 0) + 1;
                if (p.key) this.mem.refused[p.key] = true;
                if (p.a.do === "join") { this.joinAt = Date.now(); this.later(NET.join_retry_ms, () => this.react()); }
                this.log(`${p.a.do} refused: ${c}`);
            }
            this.react();
        } else if (f.t === "error") {
            this.stats.errors.push(code(f.code)); this.log(`server error frame: ${code(f.code)}`);
        } else if (f.t === "bye") {
            this.log(`bye: ${code(f.code)}`);
            if (f.code === "session") this.renewSession();
        }
    }
    // the table closed (host closed it, everyone left, the space moved): drop it, then find (or, with --create,
    // open) another one; a listing that still shows the closed table is skipped
    tableClosed() {
        this.closedTables.add(this.table);
        this.log("the table closed: looking for another");
        this.dropPlan(); this.cancel(this.openTimer);
        if (this.pending) { this.cancel(this.pending.timer); this.pending = null; } // never resend it to another table
        this.table = null; this.view = null; this.vseq = 0;
        if (this.findingTable) return;
        this.findingTable = true;
        const gen = ++this.lookGen;
        const look = async () => {
            if (this.stopped || gen !== this.lookGen) return;
            try {
                const t = await this.findTable();
                if (this.stopped || gen !== this.lookGen) return; // a room frame picked a table meanwhile, or we stopped
                if (t) { this.findingTable = false; this.table = t; this.openTable(); return; }
            } catch (e) { this.log(e.message); }
            if (!this.stopped && gen === this.lookGen) this.lookTimer = this.later(NET.open_retry_max_ms, look);
        };
        look();
    }
    act(a, at, key, noAck) {
        const op = opId();
        if (!this.send({ t: "act", table: this.table, op, a, ...(at ? { at } : {}) })) return false;
        this.stats.acts++;
        if (!noAck) { this.pending = { op, a, at, key, tries: 0 }; this.armAck(); }
        if (a.do !== "dial") this.log(`${a.do}${a.do === "spin" ? ` ${a.bet ?? ""}` : a.do === "market" ? ` ${a.side}` : ""}`);
        return true;
    }
    armAck() {
        const p = this.pending;
        p.timer = this.later(NET.ack_ms, () => {
            if (this.pending !== p) return;
            if (p.tries >= NET.ack_resends) { this.log(`${p.a.do}: no ack, giving up on it`); this.pending = null; this.react(); return; }
            this.resend();
        });
    }
    resend() {
        const p = this.pending;
        if (!p || !this.ready) return;
        this.cancel(p.timer);
        p.tries++;
        this.send({ t: "act", table: this.table, op: p.op, a: p.a, ...(p.at ? { at: p.at } : {}) }); // same op: dup-safe
        this.armAck();
    }
    dropPlan() { if (this.plan) { this.cancel(this.plan.timer); this.plan = null; } }
    // the view as of NOW (its `now` moved on by the time since it arrived), so deadlines aren't counted twice
    current() { return this.view ? { ...this.view, now: (this.view.now ?? 0) + (Date.now() - this.viewAt) } : null; }
    react() {
        if (this.stopped || !this.view || this.pending || !this.ready) return;
        const v = this.current(), me = this.user;
        const seated = v.players?.some((p) => p.u === me && !p.left);
        if (!seated) {
            this.dropPlan();
            if (v.status !== "closed" && !(Date.now() - (this.joinAt || 0) < NET.join_retry_ms)) { this.joinAt = Date.now(); this.act({ do: "join", space: this.space }); }
            return;
        }
        if (this.o.start && v.host === me && (v.status === "lobby" || v.status === "end") && v.players.filter((p) => !p.left).length >= 3) {
            if (this.plan?.start) return;
            this.dropPlan();
            this.plan = { start: true, timer: this.later((3000 + this.rnd() * 4000) / (this.o.speed || 1), () => { this.plan = null; this.act({ do: "start", preset: "full", bankroll: 6, patch: true }); }) };
            return;
        }
        // a planned move for this same moment stays planned (re-deciding could drop it); a new moment re-plans
        if (this.plan && this.plan.view && sameMoment(this.plan.view, v)) return;
        this.dropPlan();
        const d = decide(v, me, this.mem, this.rnd);
        if (!d) return;
        const plan = { d, view: v };
        plan.timer = this.later(d.delay_ms, () => {
            if (this.plan !== plan) return;
            this.plan = null;
            const now = this.current();
            if (!now || !sameMoment(now, v) && v.round) return this.react(); // the table moved on: think again
            if (this.act(d.a, d.at, d.key, d.noAck) && d.noAck) { this.mem.done[d.key] = true; this.react(); }
        });
        this.plan = plan;
    }
    async stop() {
        this.stopped = true;
        this.lookGen++;
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
        if (this.table && this.ws?.isOpen()) this.ws.sendText(JSON.stringify({ t: "act", table: this.table, op: opId(), a: { do: "leave" } }));
        await new Promise((r) => setTimeout(r, 500));
        this.ws?.close();
        if (this.inCall) { try { await this.callMembership(false); } catch (e) { this.log(e.message); } }
        // with a token cache the device is kept for the next run (one sign-in per bot); otherwise sign out
        if (this.mx && !this.o.tokens) await request(this.o, "POST", "/_matrix/client/v3/logout", {}, { Authorization: `Bearer ${this.mx.token}` }).catch(() => {});
    }
}

// ------------------------------------------------------------------------------------------------------------ CLI
export function parseArgs(argv) {
    const o = { seats: 3, speed: 1 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i], v = () => argv[++i];
        if (k === "--base") o.base = v(); else if (k === "--connect") o.connect = v(); else if (k === "--room") o.room = v();
        else if (k === "--creds") o.creds = v(); else if (k === "--users") o.users = v().split(","); else if (k === "--seats") o.seats = Number(v());
        else if (k === "--table") o.table = v(); else if (k === "--speed") o.speed = Number(v()); else if (k === "--pidfile") o.pidfile = v();
        else if (k === "--seed") o.seed = Number(v()); else if (k === "--create") o.create = true; else if (k === "--start") o.start = true;
        else if (k === "--mock") o.mock = true; else if (k === "--stop") o.stop = true;
        else if (k === "--tokens") o.tokens = v(); else if (k === "--insecure") o.insecure = true;
        else throw new Error(`unknown option ${k}`);
    }
    return o;
}

// starts the bots; on any failure the ones already started are stopped again (memberships withdrawn)
export async function runBots(o, log = (m) => console.log(`${new Date().toISOString()} ${m}`), started = []) {
    if (!o.base || !o.room) throw new Error("--base and --room are required");
    if (!(o.seats >= 1 && o.seats <= 7)) throw new Error("--seats 1..7");
    if (!(o.speed > 0)) throw new Error("--speed > 0");
    let users = o.users, creds = {};
    if (!o.mock) {
        if (!o.creds) throw new Error("--creds FILE is required (or --mock)");
        creds = readCreds(o.creds);
        users ||= Object.keys(creds);
    }
    users = (users || []).slice(0, o.seats);
    if (users.length < o.seats) throw new Error(`${o.seats} seats but ${users.length} bot accounts`);
    const stopAll = async () => { for (const b of started) await b.stop(); };
    try {
        for (const [i, u] of users.entries()) {
            const b = new RigBot(o, u, creds[u], i, log);
            started.push(b);
            await b.start();
            await new Promise((r) => setTimeout(r, 300));
        }
    } catch (e) { await stopAll(); throw e; }
    log(`${started.length} bot(s) playing in ${o.room}${o.table ? ` table ${o.table}` : ""}`);
    return { bots: started, stop: stopAll };
}

// the PID file holds "pid instance-id"; --stop signals only a live process that is this tool, and removes the file
// only if it still names that same run
function procIsBot(pid) {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("play-bot-rig.mjs"); } catch { return false; }
}
async function stopRun(pidfile) {
    if (!existsSync(pidfile)) throw new Error("--stop needs an existing --pidfile");
    const line = readFileSync(pidfile, "utf8").trim();
    const [p, id] = line.split(/\s+/);
    const pid = Number(p);
    if (!Number.isInteger(pid) || pid <= 1) throw new Error("bad pid in the pidfile");
    const removeIfSame = () => { try { if (readFileSync(pidfile, "utf8").trim() === line) rmSync(pidfile); } catch { /* gone */ } };
    if (!procIsBot(pid)) { console.log(`pid ${pid} is not a running bot: removing the stale file`); removeIfSame(); return; }
    try { process.kill(pid, "SIGTERM"); } catch (e) { if (e.code === "ESRCH") { removeIfSame(); return; } throw new Error(`can't signal pid ${pid}: ${e.code}`); }
    for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (!procIsBot(pid)) { console.log(`stopped pid ${pid} (run ${id || "?"})`); removeIfSame(); return; }
    }
    console.log(`pid ${pid} STILL RUNNING after 15 s`);
    process.exitCode = 1;
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.stop) return stopRun(o.pidfile);
    const instance = randomBytes(6).toString("hex");
    if (o.pidfile) {
        if (existsSync(o.pidfile)) throw new Error(`pidfile ${o.pidfile} exists: stop that run first (--stop)`);
        writeFileSync(o.pidfile, `${process.pid} ${instance}\n`, { flag: "wx", mode: 0o600 });
    }
    const started = [];
    let stopping = false;
    const bye = async (codeOut) => {
        if (stopping) return; stopping = true;
        console.log("stopping: the bots leave the table and drop their call membership");
        for (const b of started) await b.stop().catch(() => {});
        if (o.pidfile) { try { if (readFileSync(o.pidfile, "utf8").trim().endsWith(instance)) rmSync(o.pidfile); } catch { /* gone */ } }
        process.exit(codeOut);
    };
    process.on("SIGTERM", () => bye(0)); // handlers before startup: a stop during startup cleans up too
    process.on("SIGINT", () => bye(0));
    try { await runBots(o, undefined, started); } catch (e) { console.error(`play-bot-rig: ${e.message}`); await bye(1); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((e) => { console.error(`play-bot-rig: ${e.message}`); process.exit(1); });
}
