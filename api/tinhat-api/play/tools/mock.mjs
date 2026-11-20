#!/usr/bin/env node
// The play MOCK (games v1 contract freeze): a tiny local stand-in for /api/play/v1 that the app lanes code against
// before the real engines land. Plain Node 22, no dependencies. It serves the frozen fixtures (vectors/views/) as
// scenarios: every act is checked against that step's allowed moves (and `at` against the current turn), answered
// with a real ack, and moves the table to the step the fixture names; views are re-projected for each person.
// NOT a game: numbers come from the fixtures. NEVER expose it beyond loopback (no auth: any user_id signs in).
//
//   node mock.mjs [--port 8787] [--host 127.0.0.1] [--views DIR] [--rig-phone] [--empty] [--quiet]
//
// Base URL for the apps: http://127.0.0.1:8787/api/play/v1   (socket: ws://127.0.0.1:8787/api/play/v1/ws)
// Mock-only controls (not part of the contract): socket frame {"t":"_mock", ...} or POST /api/play/v1/_mock with:
//   {"table":ID,"go":"04-flop"|"next"|"prev"|"reset"}   jump the table to a step (everyone gets the new view)
//   {"table":ID,"as":"seat6"|"spectator"|"ben"…}         which fixture person YOU are at that table (default: assigned in
//                                                        order of opening: the host's seat first)
//   {"rank":{"u":"@x:y","rank":3,"space":"!S"}}          set a rank (pushed to every socket as a rank frame; space
//                                                        default: every space)
//   {"post":{"table":ID,"kind":"invite|result|summary"}}  send a post frame to the host's sockets
//   {"wallet":{"u":"@x:y","space":"!S","balance":40}}    set a wallet (pushes a wallet frame)
// Spaces (rev 2): every room's game space is "!sp<hash>:<the room's server>", owned by the room's server, except test
// rooms whose id starts with !nospace (403 no-space), !remote (403 wrong-server, other.example) or !unavail (503).
//   GET /api/play/v1/_mock → tables, steps, who is who.  GET /api/play/v1/_mock/features → the well-known flags.
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { attachWs } from "../ws.mjs";
import { validate } from "../jsonschema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8787));
const HOST = opt("--host", "127.0.0.1");
const QUIET = flag("--quiet");
const RIG_PHONE = flag("--rig-phone");
const SEED_TABLES = !flag("--empty");
const VIEWS = opt("--views", [join(HERE, "../../vectors/views"), join(HERE, "../../test/vectors/play/views"), join(HERE, "views")].find((p) => existsSync(join(p, "schema.json"))));
if (!VIEWS) { console.error("mock: no views folder (pass --views DIR, the contract's vectors/views)"); process.exit(2); }
const log = (...a) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); };

const SCHEMA = JSON.parse(readFileSync(join(VIEWS, "schema.json"), "utf8"));
const HTTPX = JSON.parse(readFileSync(join(VIEWS, "http.json"), "utf8"));
const FIXT_NOW = 1763600000000;
const STEPS = {}; // game → [step]
for (const game of ["holdem", "rig"]) {
    STEPS[game] = readdirSync(join(VIEWS, game)).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(VIEWS, game, f), "utf8")));
}
const FIX_TABLE = { holdem: STEPS.holdem[0].views.spectator.table, rig: STEPS.rig[0].views.spectator.table };
const FIX_ROOM = STEPS.holdem[0].views.spectator.room;
const FIX_SPACE = STEPS.holdem[0].views.spectator.space;
const FIX_OWNER = STEPS.holdem[0].views.spectator.owner;
/** The room's game space as the mock pretends the owner decided it (§1.1): {space, server} or {code, …}. */
function spaceOf(room) {
    if (room.startsWith("!nospace")) return { code: "no-space", status: 403 };
    if (room.startsWith("!remote")) return { code: "wrong-server", status: 403, space: "!squad:other.example", server: "other.example" };
    if (room.startsWith("!unavail")) return { code: "unavailable", status: 503 };
    const server = room.slice(room.indexOf(":") + 1);
    return { space: `!sp${createHash("sha256").update(room).digest("hex").slice(0, 10)}:${server}`, server };
}
// steps that move on by themselves when their deadline passes (the fast phases); everything else waits for a move
const AUTO = { "holdem/06-showdown": "07-headsup-leaving", "rig/02-setup-lite": "03-turn-lite", "rig/06-land": "07-nudge-open",
    "rig/07-nudge-open": "08-payout", "rig/08-payout": "09-paused", "rig/10-reveal": "11-end" };
const AUTO_MS = { "rig/08-payout": 2000 }; // phases without a deadline of their own
const RANK_OF_TEST = [0, 1, 2, 4, 6, 9, 13]; // a lab "<name>-testN" account → a rank per tier, so every token look is reachable

const check = (def, v) => validate(SCHEMA, { $ref: `#/$defs/${def}` }, v);
const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idFor = (game, room) => (game === "holdem" ? "tH" : "tR") + createHash("sha256").update(game + room).digest("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 14);

// ---------------------------------------------------------------- state
const sessions = new Map(); // session → { user, kind, rigHidden }
const wallets = new Map(); // "space|mxid" → { balance }
const ranks = new Map(); // "space|mxid" or "*|mxid" → rank
const wk = (space, u) => `${space}|${u}`;
const walletsOf = (u) => [...wallets.keys()].filter((k) => k.endsWith(`|${u}`)).map((k) => k.slice(0, k.lastIndexOf("|")));
const tables = new Map(); // id → { id, game, room, host, step, enteredAt, vseq, assign: Map(perspective → mxid), byUser: Map(mxid → perspective), openers: Set(conn), acks: Map }
const sockets = new Set();

function rankOf(space, u) {
    if (ranks.has(wk(space, u))) return ranks.get(wk(space, u));
    if (ranks.has(wk("*", u))) return ranks.get(wk("*", u));
    const m = /^@[a-z0-9]+-test(\d+):/.exec(u); // any "<name>-testN" lab account: one rank per token tier
    if (m) return RANK_OF_TEST[Number(m[1])] || 0;
    const fx = { "@ana:example.org": 1, "@dee:example.net": 3, "@eli:example.org": 13 };
    return fx[u] || 0;
}
const capOf = (space, u) => 100 + 50 * rankOf(space, u);
function walletFrame(space, u) { const w = wallets.get(wk(space, u)); return w ? { t: "wallet", space, balance: w.balance, holdings: w.balance, rank: rankOf(space, u), cap: capOf(space, u) } : null; }

function createTable(game, room, host) {
    const id = idFor(game, room);
    if (tables.has(id) && tables.get(id).status !== "closed") return null;
    const sp = spaceOf(room);
    const t = { id, game, room, space: sp.space, owner: sp.server, host, stepIdx: 0, enteredAt: Date.now(), vseq: 1, assign: new Map(), byUser: new Map(), openers: new Set(), acks: new Map(), timer: null, status: "open", dial: null, opts: null };
    tables.set(id, t);
    if (host) assign(t, host, null);
    return t;
}
function seedRoom(room) {
    if (!SEED_TABLES || spaceOf(room).code) return;
    for (const g of ["holdem", "rig"]) if (!tables.has(idFor(g, room))) createTable(g, room, null);
}
const stepOf = (t) => STEPS[t.game][t.stepIdx];
function perspectives(t) { return Object.keys(stepOf(t).views); }
function assign(t, u, want) {
    if (t.byUser.has(u) && !want) return t.byUser.get(u);
    const all = perspectives(t);
    let p = want && all.includes(want) ? want : null;
    if (!p) p = all.find((x) => x !== "spectator" && !t.assign.has(x)) || "spectator";
    if (t.byUser.has(u)) { const old = t.byUser.get(u); if (old !== "spectator") t.assign.delete(old); }
    if (p !== "spectator") { const prev = t.assign.get(p); if (prev) t.byUser.delete(prev); t.assign.set(p, u); }
    t.byUser.set(u, p);
    if (!t.host && p !== "spectator") t.host = u;
    return p;
}
// the fixture's people → the real people assigned to them; the time fields → this clock
function rewrite(t, obj) {
    const step = stepOf(t);
    let s = JSON.stringify(obj);
    for (const [p, fx] of Object.entries(step.people)) {
        const real = t.assign.get(p);
        if (real && real !== fx) s = s.split(JSON.stringify(fx)).join(JSON.stringify(real));
    }
    s = s.split(JSON.stringify(FIX_TABLE[t.game])).join(JSON.stringify(t.id)).split(JSON.stringify(FIX_ROOM)).join(JSON.stringify(t.room))
        .split(JSON.stringify(FIX_SPACE)).join(JSON.stringify(t.space)).split(JSON.stringify(FIX_OWNER)).join(JSON.stringify(t.owner));
    const shift = t.enteredAt - FIXT_NOW;
    const v = JSON.parse(s, (k, x) => (typeof x === "number" && ["deadline", "next_at", "at"].includes(k) ? x + shift : x));
    return v;
}
function viewFor(t, u) {
    const step = stepOf(t);
    const p = (u && t.byUser.get(u)) || "spectator";
    const v = rewrite(t, step.views[p] || step.views.spectator);
    v.vseq = t.vseq; v.now = Date.now();
    if (t.opts) v.opts = { ...v.opts, ...t.opts };
    if (t.dial && v.round && v.round.phase === "turn") v.round.dial = t.dial;
    // you.screens = the kinds of YOUR sockets that have this table open (a Pad among them hides the computer's cards)
    if (v.you && u) {
        const kinds = new Set();
        for (const c of t.openers) if (c.user === u && !c.closed) { kinds.add(c.kind); if (c.pad) kinds.add("pad"); }
        v.you.screens = [...kinds].sort();
    }
    return v;
}
function listingOf(t) {
    const v = viewFor(t, null);
    if (t.game === "rig") { const players = v.players.map((p) => p.u); return { table: t.id, game: "rig", status: v.status, host: v.host, seated: players.length, seats: 8, players, hand: null, round: v.round ? v.round.r : null, space: t.space, owner: t.owner }; }
    const players = v.seats.map((s) => s.u);
    return { table: t.id, game: "holdem", status: v.status, host: v.host, seated: players.length, seats: v.opts.seats, players, hand: v.hand ? v.hand.n : null, round: null, space: t.space, owner: t.owner };
}

// ---------------------------------------------------------------- frames out
function send(conn, f) {
    const errs = check("serverFrame", f);
    if (errs.length) { console.error(`mock BUG: outgoing ${f.t} fails the schema (NOT sent): ${errs.slice(0, 3).join("; ")}`); return; }
    conn.send(f);
}
function pushViews(t) {
    for (const c of t.openers) if (!c.closed) send(c, { t: "view", table: t.id, vseq: t.vseq, view: viewFor(t, c.user) });
    for (const c of sockets) if (c.subs?.has(t.room)) send(c, roomFrame(t.room));
}
const tablesIn = (room) => [...tables.values()].filter((t) => t.room === room).map(listingOf);
const roomFrame = (room) => { const sp = spaceOf(room); return { t: "room", room, space: sp.space, owner: sp.server, tables: tablesIn(room) }; };
function goTo(t, idx) {
    const n = STEPS[t.game].length;
    t.stepIdx = Math.max(0, Math.min(n - 1, idx));
    t.enteredAt = Date.now(); t.vseq += 1;
    clearTimeout(t.timer);
    t.dial = null;
    const step = stepOf(t);
    const key = `${t.game}/${step.step}`;
    const auto = AUTO[key];
    if (auto) {
        const dl = viewFor(t, null);
        const at = AUTO_MS[key] ? Date.now() + AUTO_MS[key] : t.game === "rig" ? dl.round?.deadline : dl.result?.next_at;
        t.timer = setTimeout(() => goToId(t, auto), Math.max(500, (at || Date.now() + 3000) - Date.now()));
        t.timer.unref?.();
    }
    log(`table ${t.id} (${t.game}) → ${step.step}`);
    pushViews(t);
}
function goToId(t, id) { const i = STEPS[t.game].findIndex((s) => s.step === id); if (i >= 0) goTo(t, i); }

// ---------------------------------------------------------------- moves
const TABLE_MOVES = new Set(SCHEMA["x-moves"].table_level);
function act(conn, f) {
    const t = tables.get(f.table);
    const ack = (ok, code = "") => {
        const a = { t: "ack", op: f.op, ok, code, dup: false };
        t?.acks.set(`${conn.user}|${f.op}`, a);
        send(conn, a);
    };
    if (!t) return ack(false, "no-table");
    const prev = t.acks.get(`${conn.user}|${f.op}`);
    if (prev) return send(conn, { ...prev, dup: true });
    if (t.game === "rig" && conn.rigHidden) return ack(false, "rig-hidden");
    const step = stepOf(t);
    let p = t.byUser.get(conn.user);
    const d = f.a.do;
    if (d === "sit" || d === "join") {
        if (!f.a.space) return ack(false, "bad");
        if (f.a.space !== t.space) return ack(false, "space-changed");
        if (!wallets.has(wk(t.space, conn.user))) return ack(false, "no-wallet");
    }
    if (!p && (d === "sit" || d === "join")) { p = assign(t, conn.user, null); }
    if (!p) return ack(false, "no-table");
    const allowed = step.moves[p] || [];
    const pub = viewFor(t, null);
    const atOk = () => {
        if (!f.at) return false;
        if (t.game === "holdem") return !!pub.hand?.to_act && f.at.hand === pub.hand.n && f.at.turn === pub.hand.to_act.turn;
        return !!pub.round && f.at.round === pub.round.r && f.at.spin === pub.round.spin && f.at.phase === pub.round.phase;
    };
    if (d === "dial" && t.game === "rig") {
        if (!allowed.includes("dial") || !atOk()) return; // dial gets no ack; a stale one is dropped
        t.dial = f.a.bet;
        for (const c of t.openers) send(c, { t: "live", table: t.id, vseq: t.vseq, dial: f.a.bet });
        return;
    }
    if (!TABLE_MOVES.has(d) && !atOk()) return ack(false, "stale");
    if (!allowed.includes(d)) {
        if (p === "spectator") return ack(false, "no-table");
        const hostMove = ["deal", "kick", "close", "start"].includes(d);
        if (hostMove && t.host !== conn.user) return ack(false, "host-only");
        if (t.game === "holdem" && ["fold", "check", "call", "raise", "allin"].includes(d)) return ack(false, pub.hand?.to_act ? "not-your-turn" : "phase");
        return ack(false, t.game === "rig" ? "phase" : "bad-action");
    }
    if (t.game === "holdem" && d === "raise") {
        const legal = viewFor(t, conn.user).you?.legal;
        if (!legal?.raise || !(f.a.to >= legal.raise.min && f.a.to <= legal.raise.max)) return ack(false, "bad-amount");
    }
    if (t.game === "holdem" && d === "check" && !viewFor(t, conn.user).you?.legal?.check) return ack(false, "bad-action");
    ack(true);
    const nx = step.next[d];
    if (nx) goToId(t, nx); else { t.vseq += 1; pushViews(t); } // a move that changes only its own panel: same step
}

// ---------------------------------------------------------------- mock controls
function control(conn, c) {
    if (c.rank) {
        ranks.set(wk(c.rank.space || "*", c.rank.u), c.rank.rank);
        const spaces = c.rank.space ? [c.rank.space] : [...new Set([...tables.values()].map((t) => t.space).filter(Boolean))];
        if (c.rank.rank > 0) for (const s of sockets) if (s.user) for (const sp of spaces) send(s, { t: "rank", space: sp, u: c.rank.u, rank: c.rank.rank });
        return { ok: true };
    }
    if (c.wallet) { if (!c.wallet.space) return { ok: false, code: "bad" }; wallets.set(wk(c.wallet.space, c.wallet.u), { balance: c.wallet.balance }); for (const s of sockets) if (s.user === c.wallet.u) send(s, walletFrame(c.wallet.space, s.user)); return { ok: true }; }
    const t = tables.get(c.table || c.post?.table);
    if (!t) return { ok: false, code: "no-table" };
    if (c.post) { for (const s of sockets) if (s.user === t.host) send(s, { t: "post", kind: c.post.kind, game: t.game, table: t.id, room: t.room, space: t.space, round: c.post.kind === "result" ? 1 : null }); return { ok: true }; }
    if (c.as && conn?.user) { const p = assign(t, conn.user, c.as); t.vseq += 1; pushViews(t); return { ok: true, as: p }; }
    if (c.as && c.user) { const p = assign(t, c.user, c.as); t.vseq += 1; pushViews(t); return { ok: true, as: p }; }
    if (c.go === "next") goTo(t, t.stepIdx + 1);
    else if (c.go === "prev") goTo(t, t.stepIdx - 1);
    else if (c.go === "reset") goTo(t, 0);
    else if (c.go) { const i = STEPS[t.game].findIndex((s) => s.step === c.go); if (i < 0) return { ok: false, code: "bad" }; goTo(t, i); }
    return { ok: true, step: stepOf(t).step };
}
function mockState() {
    return {
        mock: true, views: VIEWS, rig_phone_apps: RIG_PHONE,
        steps: Object.fromEntries(Object.entries(STEPS).map(([g, ss]) => [g, ss.map((s) => ({ step: s.step, about: s.about, perspectives: Object.keys(s.views) }))])),
        tables: [...tables.values()].map((t) => ({ table: t.id, game: t.game, room: t.room, space: t.space, host: t.host, step: stepOf(t).step, who: Object.fromEntries(t.byUser) })),
    };
}

// ---------------------------------------------------------------- HTTP
const BASE = "/api/play/v1";
function reply(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Cache-Control": "no-store" });
    res.end(body === null ? "" : JSON.stringify(body));
}
const err = (res, code, status, extra = {}) => reply(res, status, { code, error: code, ...extra });
const spaceErr = (res, sp) => err(res, sp.code, sp.status, sp.code === "wrong-server" ? { space: sp.space, server: sp.server } : {});
function readBody(req) {
    return new Promise((ok) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 16384) req.destroy(); }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok(undefined); } }); });
}
function me(space, u) {
    const w = wallets.get(wk(space, u));
    const seatedAt = [...tables.values()].find((t) => t.space === space && t.byUser.get(u) && t.byUser.get(u) !== "spectator");
    const day = new Date().toISOString().slice(0, 10);
    const next = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return { v: 1, space, user: u, balance: w.balance, holdings: w.balance, rank: rankOf(space, u), cap: capOf(space, u), at_table: seatedAt ? { table: seatedAt.id, game: seatedAt.game, room: seatedAt.room } : null, earned_today: 2, day_max: 8, accrual_s: 1260, chip_s: 3600, day, topup: { available: w.balance === 0, next_day: next } };
}
const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return reply(res, 204, null);
    if (!url.pathname.startsWith(BASE)) return err(res, "no-table", 404);
    const path = url.pathname.slice(BASE.length);
    log(`${req.method} ${path}`);
    if (path === "/_mock" && req.method === "GET") return reply(res, 200, mockState());
    if (path === "/_mock/features") return reply(res, 200, { play: true, play_rig_phone_apps: RIG_PHONE });
    if (path === "/_mock" && req.method === "POST") { const b = await readBody(req); return reply(res, 200, b ? control(null, b) : { ok: false, code: "bad" }); }
    if (path === "/session" && req.method === "POST") {
        const b = await readBody(req);
        if (!b || typeof b.user_id !== "string" || !/^@[^:\s]+:\S+$/.test(b.user_id)) return err(res, "bad", 400);
        if (/^@guest-/.test(b.user_id)) return err(res, "guest", 403);
        const kind = b.client?.kind || "web";
        const session = b64u(randomBytes(32));
        const rigHidden = (kind === "ios-app" || kind === "android-app") && !RIG_PHONE;
        sessions.set(session, { user: b.user_id, kind, rigHidden });
        return reply(res, 200, { v: 1, session, user: b.user_id, expires: Date.now() + 8 * 3600000, wallets: walletsOf(b.user_id), rig_hidden: rigHidden });
    }
    const m = /^Play ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    const s = m && sessions.get(m[1]);
    if (!s) return err(res, "session", 401);
    const u = s.user;
    const known = new Set([...tables.values()].map((t) => t.space).concat(walletsOf(u)));
    const ownedSpace = (sp) => typeof sp === "string" && /^![^:\s]+:\S+$/.test(sp) && !sp.endsWith(":other.example");
    if (path === "/wallet" && req.method === "POST") {
        const b = await readBody(req);
        if (!b || !ownedSpace(b.space)) return err(res, b && typeof b.space === "string" && b.space.endsWith(":other.example") ? "wrong-server" : "bad", b?.space ? 403 : 400);
        const had = wallets.has(wk(b.space, u)); if (!had) wallets.set(wk(b.space, u), { balance: 10 });
        for (const c of sockets) if (c.user === u) send(c, walletFrame(b.space, u));
        return reply(res, had ? 200 : 201, me(b.space, u));
    }
    const qs = url.searchParams.get("space");
    if (path === "/wallet" && req.method === "DELETE") {
        if (!qs) return err(res, "bad", 400);
        if ([...tables.values()].some((t) => t.space === qs && t.byUser.get(u) && t.byUser.get(u) !== "spectator")) return err(res, "seated", 409);
        wallets.delete(wk(qs, u)); return reply(res, 204, null);
    }
    if (path === "/me" || path === "/me/journal") {
        if (!qs) return err(res, "bad", 400);
        if (!wallets.has(wk(qs, u))) return err(res, "no-wallet", 404);
        return reply(res, 200, path === "/me" ? me(qs, u) : { ...HTTPX.endpoints.find((e) => e.path.startsWith("/me/journal")).res, space: qs });
    }
    if (path === "/ranks") {
        const us = url.searchParams.getAll("u");
        let space = qs;
        const room = url.searchParams.get("room");
        if (!space && room) { const sp = spaceOf(room); if (sp.code) return spaceErr(res, sp); space = sp.space; }
        if (!space || us.length > 100) return err(res, "bad", 400);
        void known;
        const out = {}; for (const x of us) { const r = rankOf(space, x); if (r > 0) out[x] = r; }
        return reply(res, 200, { v: 1, space, ranks: out });
    }
    let mm;
    if ((mm = /^\/rooms\/([^/]+)\/space$/.exec(path))) {
        const sp = spaceOf(decodeURIComponent(mm[1]));
        return sp.code ? spaceErr(res, sp) : reply(res, 200, { space: sp.space, server: sp.server });
    }
    if ((mm = /^\/rooms\/([^/]+)\/tables$/.exec(path))) {
        const room = decodeURIComponent(mm[1]);
        const sp = spaceOf(room);
        if (sp.code) return spaceErr(res, sp);
        if (req.method === "GET") { seedRoom(room); return reply(res, 200, { space: sp.space, owner: sp.server, tables: tablesIn(room) }); }
        const b = await readBody(req);
        if (!b || check("tableRequest", b).length) return err(res, "bad", 400);
        if (b.space !== sp.space) return err(res, "space-changed", 409);
        if (b.game === "rig" && s.rigHidden) return err(res, "rig-hidden", 403);
        if (!wallets.has(wk(sp.space, u))) return err(res, "no-wallet", 404);
        const t = createTable(b.game, room, u);
        if (!t) return err(res, "one-per-room", 409);
        if (b.opts && Object.keys(b.opts).length) t.opts = { ...b.opts };
        for (const c of sockets) if (c.user === u) send(c, { t: "post", kind: "invite", game: t.game, table: t.id, room, space: t.space, round: null });
        pushViews(t);
        return reply(res, 201, { table: t.id });
    }
    if ((mm = /^\/tables\/([A-Za-z0-9]+)(\/.*)?$/.exec(path))) {
        const t = tables.get(mm[1]);
        if (!t) return err(res, "no-table", 404);
        if (t.game === "rig" && s.rigHidden) return err(res, "rig-hidden", 403);
        const sub = mm[2] || "";
        if (sub === "") return reply(res, 200, viewFor(t, u));
        const ex = (p) => rewrite(t, HTTPX.endpoints.find((e) => e.path.startsWith(p)).res);
        const seated = t.byUser.get(u) && t.byUser.get(u) !== "spectator";
        if (sub === "/hands") return t.game === "holdem" && seated ? reply(res, 200, ex("/tables/{id}/hands")) : err(res, "no-table", 404);
        if (/^\/rounds\/\d+$/.test(sub)) {
            // only a FINISHED round (the fixture's round 2, once the table reached its reveal)
            const revealAt = STEPS.rig.findIndex((x) => x.step === "10-reveal");
            const ok = t.game === "rig" && Number(sub.split("/")[2]) === 2 && t.stepIdx >= revealAt;
            return ok ? reply(res, 200, ex("/tables/{id}/rounds")) : err(res, "no-table", 404);
        }
        if (sub === "/summary") { const x = ex("/tables/{id}/summary"); x.game = t.game; x.table = t.id; return reply(res, 200, x); }
    }
    return err(res, "no-table", 404);
});

// ---------------------------------------------------------------- the socket
attachWs(server, {
    path: `${BASE}/ws`,
    onConnection(conn) {
        sockets.add(conn);
        conn.subs = new Set(); conn.user = null;
        const silent = setInterval(() => { if (Date.now() - (conn.last || 0) > 60000) conn.close(1000, "silent"); }, 10000);
        conn.last = Date.now();
        conn.on("close", () => { clearInterval(silent); sockets.delete(conn); for (const t of tables.values()) if (t.openers.delete(conn)) { t.vseq += 1; pushViews(t); } });
        conn.on("message", (text) => {
            conn.last = Date.now();
            let f; try { f = JSON.parse(text); } catch { send(conn, { t: "bye", code: "bad" }); return conn.close(1008, "bad"); }
            if (f && f.t === "_mock") { const r = control(conn, f); conn.send({ t: "_mock", ...r }); return; }
            const errs = check("clientFrame", f);
            if (errs.length) { log(`bad frame: ${errs.slice(0, 2).join("; ")}`); return send(conn, { t: "error", code: "bad" }); }
            if (!conn.user && f.t !== "auth") { send(conn, { t: "bye", code: "session" }); return conn.close(1008, "session"); }
            if (f.t === "auth") {
                const s = sessions.get(f.session);
                if (!s) { send(conn, { t: "bye", code: "session" }); return conn.close(1008, "session"); }
                conn.user = s.user; conn.rigHidden = s.rigHidden; conn.kind = f.client?.kind || s.kind; conn.pad = !!f.client?.pad;
                const mine = [...sockets].filter((c) => c.user === s.user);
                if (mine.length > 4) { const old = mine[0]; send(old, { t: "bye", code: "replaced" }); old.close(1000, "replaced"); }
                send(conn, { t: "hello", v: 1, user: s.user, now: Date.now(), rig_hidden: s.rigHidden, wallets: walletsOf(s.user) });
                for (const sp of walletsOf(s.user)) send(conn, walletFrame(sp, s.user));
                return;
            }
            if (f.t === "ping") return send(conn, { t: "pong", now: Date.now() });
            if (f.t === "sub") {
                const sp = spaceOf(f.room);
                if (sp.code) return send(conn, { t: "error", code: sp.code, room: f.room, ...(sp.code === "wrong-server" ? { space: sp.space, server: sp.server } : {}) });
                conn.subs.add(f.room); seedRoom(f.room); return send(conn, roomFrame(f.room));
            }
            if (f.t === "unsub") { conn.subs.delete(f.room); return; }
            if (f.t === "open") {
                const t = tables.get(f.table);
                if (!t) return send(conn, { t: "error", code: "no-table", table: f.table });
                if (t.game === "rig" && conn.rigHidden) return send(conn, { t: "error", code: "rig-hidden", table: f.table });
                t.openers.add(conn);
                if (!t.byUser.has(conn.user)) assign(t, conn.user, null);
                t.vseq += 1; pushViews(t); return; // everyone's view changes (screens, spectators)
            }
            if (f.t === "close") { const t = tables.get(f.table); if (t?.openers.delete(conn)) { t.vseq += 1; pushViews(t); } return; }
            if (f.t === "act") return act(conn, f);
        });
    },
});

server.listen(PORT, HOST, () => {
    console.log(`play mock on http://${HOST}:${PORT}${BASE} (socket ws://${HOST}:${PORT}${BASE}/ws), views ${VIEWS}${RIG_PHONE ? ", Rig shown in phone apps" : ""}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); process.exit(0); });
