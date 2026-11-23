// The play platform (GAMES-V1-SPEC §6): play sessions from OpenID, the HTTP API under /v1 (Caddy maps /api/play/* here),
// the play socket, and the tables: each table's engine state lives in memory behind a per-table queue and is written to
// the database with a compare-and-set on its version, in ONE transaction with every money effect and the move's op
// receipt (§2.5). Engines play with wallet ids; views go through adapt.mjs. Nothing here holds an admin capability:
// room/space state comes from space.mjs's read-only reader.
import { randomBytes, createHash, randomInt } from "node:crypto";
import { readJson, RateLimit, ipBucket, mono as monoClock } from "../reachcommon.mjs";
import { attachWs } from "./ws.mjs";
import { validate } from "./jsonschema.mjs";
import { SCHEMA, REACTIONS } from "./contract/schema.mjs";
import { inTx, Conflict } from "./db.mjs";
import * as L from "./ledger.mjs";
import * as rules from "./rules.mjs";
import * as Holdem from "./holdem.mjs";
import * as Rig from "./rig.mjs";
import { holdemContract, rigContract, mapReveal } from "./adapt.mjs";
import { rigProvisional } from "./provisional.mjs";
import { createAdmin, noticesOf } from "./admin.mjs";
import { createSide, sideOf } from "./side.mjs";

export const PLAY = Object.freeze({
    SESSION_MS: 8 * 3600_000,
    SESSIONS_PER_ACCOUNT_MIN: 30, SESSIONS_PER_ADDRESS_MIN: 120,
    REQ_PER_SESSION_MIN: 600,
    SOCKETS_PER_PERSON: 4, FRAMES_PER_S: 20, FRAME_BURST: 40, SILENT_MS: 60_000,
    // B2 (round 2): a Pad socket hides that person's cards on their other screens only while it is ALIVE: it counts
    // in `you.screens` only if it sent a frame (its 20 s ping) within SCREEN_STALE_MS; checked every PAD_SWEEP_MS. A
    // locked / backgrounded phone drops out in <= 30 s instead of the silent close's ~70 s.
    SCREEN_STALE_MS: 25_000, PAD_SWEEP_MS: 5_000, // the edge is a timer at the last frame + 25 s; the sweep is a backstop (astra r1 #16)
    // F7 table reactions (addendum §4.2): per person per table a bucket of REACT_BURST refilling one per REACT_REFILL_MS;
    // per table REACT_TABLE_PER_MIN in a rolling minute; people watching from the call may react too
    REACT_SPECTATORS: true, REACT_BURST: 3, REACT_REFILL_MS: 4_000, REACT_TABLE_PER_MIN: 40, REACT_DUP_MS: 60_000,
    MAX_FRAME: 16384, MAX_DEPTH: 32,
    BODY_LIMIT: 8192,
    DRAIN_MS: 30_000,
});
const ENGINES = { holdem: Holdem, rig: Rig };
/** v1.1 (addendum §7.3): the socket-only pieces this server has, in `hello.features` (apps gate on the names). */
export const PLAY_FEATURES = Object.freeze(["fresh-screens", "react", "away2"]);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const tableId = (game) => (game === "holdem" ? "tH" : "tR") + Array.from({ length: 14 }, () => B62[randomInt(62)]).join("");
const sha = (s) => createHash("sha256").update(s).digest("base64url");
const CLOSE_REASONS = new Set(["host", "idle", "no-call", "restart", "off", "end", "space-changed", "empty"]);
const closeReason = (r) => (CLOSE_REASONS.has(r) ? r : r === "void" ? "restart" : "host");
const check = (def, v) => validate(SCHEMA, { $ref: `#/$defs/${def}` }, v);
const MXID_RE = /^@[^:\s]+:\S+$/;
const ROOM_RE = /^![^:\s]+:\S+$/;
const depthOk = (v, d = 0) => d <= PLAY.MAX_DEPTH && (typeof v !== "object" || v === null || Object.values(v).every((x) => depthOk(x, d + 1)));
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

class Refusal extends Error { constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; } }

/**
 * deps: { pool, cfg (rules.configFromEnv), flags() → {play, rig_phone_apps}, spaces (space.mjs createSpaces),
 *   spaceInfo(spaceId) → {owner, joined:Set}|null, resolveOpenId({openid, user_id}) → mxid|null (throws {code:
 *   "remote-refused" | "unavailable"}),
 *   isGuest(mxid) → bool, serverName, salt, now, log, randomSeed }
 */
export function createPlay(deps) {
    const { pool, cfg, spaces, serverName } = deps;
    const now = deps.now || Date.now;
    const mono = deps.mono || monoClock; // the transport clock (tests move it)
    const SCREEN_STALE_MS = deps.padFreshMs ?? PLAY.SCREEN_STALE_MS;
    const PAD_SWEEP_MS = deps.padSweepMs ?? PLAY.PAD_SWEEP_MS;
    const log = deps.log || ((s) => console.log(s));
    const flags = deps.flags || (() => ({ play: true, rig_phone_apps: false }));
    const isGuest = deps.isGuest || ((u) => /^@guest-/i.test(u));
    const newSeed = deps.randomSeed || (() => randomBytes(32));
    const sessions = new Map(); // sha(session) → {user, kind, exp}
    const tables = new Map(); // id → T
    const people = new Map(); // wid → mxid (wallets touched since start)
    const sockets = new Set();
    const roomSent = new Map(); // room → the last listing sent (only changes are broadcast)
    let draining = false;
    let ready = false; // routes and sockets answer `db` until recovery has finished (§1: tables never survive a restart)
    const perAccount = new RateLimit(PLAY.SESSIONS_PER_ACCOUNT_MIN, 60_000);
    const perAddress = new RateLimit(PLAY.SESSIONS_PER_ADDRESS_MIN, 60_000);
    const perSession = new RateLimit(PLAY.REQ_PER_SESSION_MIN, 60_000);
    /** Open money (§5.2): seated at a table, or chips in a pot / an escrow. */
    async function openMoney(c, wid) {
        const { rows } = await c.query("SELECT 1 FROM play_seats WHERE wid = $1 AND active", [wid]);
        if (rows.length) return true;
        return (await L.holdingsOf(c, wid)).atTable > 0;
    }
    // F8 (addendum §5): the admin money screen's API
    const admin = createAdmin({ pool, cfg, serverName, spaceInfo: deps.spaceInfo, isServerAdmin: deps.isServerAdmin || (async () => false), now, Refusal, RateLimit, openMoney,
        onWalletChanged: (wid, sid) => { pushWalletFor(wid, sid).catch(() => {}); } });
    // F9 (addendum §6): Tune In
    const side = createSide({ pool, cfg, serverName, spaceInfo: deps.spaceInfo, now, mono, Refusal, openMoney, rng: deps.sideRng,
        onWalletChanged: (wid, sid) => { pushWalletFor(wid, sid).catch(() => {}); } });

    // ------------------------------------------------------------------------------------ people + wallets
    async function widFor(c, sid, user) { const w = await L.widOfUser(c, sid, user); if (w) people.set(w, user); return w; }
    const mxOf = (wid) => people.get(wid) || null;
    // one table at a time per PERSON on this server, across spaces: a salted key per person in play_seats (never the id)
    const personKey = (u) => (u ? createHash("sha256").update(`${deps.salt}\0${u}`).digest("base64url") : null);
    /** The running result of the open Rig round this wallet is in (0 elsewhere): part of holdings (§2.1). */
    function provisionalOf(wid) {
        for (const T of tables.values()) if (!T.closed && T.game === "rig" && isSeated(T, wid)) return T.committing ? null : rigProvisional(T.st, wid);
        return 0;
    }
    async function walletInfo(c, wid, sid) {
        const { rows } = await c.query("SELECT rank FROM play_wallets WHERE wid = $1", [wid]);
        const h = await L.holdingsOf(c, wid, provisionalOf(wid) ?? 0);
        const rank = rows.length ? rows[0].rank : 0;
        const cap = rules.capOf(rank, await L.spaceCfg(c, sid, cfg)); // the space's own cap numbers (v1.1)
        return { holdings: h.holdings, balance: h.wallet, rank, cap, at_cap: h.holdings >= cap };
    }

    // ------------------------------------------------------------------------------------ access (§6.0)
    async function roomAccess(user, room, { fresh = false } = {}) {
        let r = await spaces.resolve(room, { fresh });
        if (!fresh && (!r.room || !r.room.joined.has(user) || !r.spaceJoined.has(user))) r = await spaces.resolve(room, { fresh: true }); // refusal path: look again
        if (!r.room || !r.room.joined.has(user)) throw new Refusal("not-member");
        if (r.why === "unavailable") throw new Refusal("unavailable");
        if (r.why && r.why !== "wrong-server") throw new Refusal("no-space");
        if (!r.spaceJoined.has(user)) throw new Refusal("not-member"); // naming nothing (§1.1), also for another server's space
        if (r.why === "wrong-server") throw new Refusal("wrong-server", { space: r.space, server: r.server });
        const inCall = r.room.sessions.some((s) => s.sender === user);
        return { space: r.space, owner: r.server, inCall, resolved: r };
    }
    async function sidFor(c, space, owner) { return L.ensureSpace(c, space, owner || serverName); }
    /** Watching / reopening an existing table: joined to its recorded room AND its bound space, and in the call (or
     *  seated there). A room that moved spaces mid-hand still lets its players back to the hand bound to the old one. */
    async function tableAccess(user, T) {
        let r = await spaces.resolve(T.room);
        // a cached answer may predate someone's join or call membership: look again before refusing (refusal path only)
        if (!r.room || !r.room.joined.has(user) || !r.room.sessions.some((x) => x.sender === user)) r = await spaces.resolve(T.room, { fresh: true });
        if (!r.room || !r.room.joined.has(user)) throw new Refusal("not-member");
        const info = await deps.spaceInfo(T.space).catch(() => null);
        if (!info || !info.joined.has(user)) throw new Refusal("not-member");
        if (T.members) T.members.add(user); // a fresh, successful check: the snapshot agrees until the next re-check
        return { inCall: r.room.sessions.some((x) => x.sender === user) };
    }

    // ------------------------------------------------------------------------------------ tables
    function T_of(id) { const T = tables.get(id); if (!T) throw new Refusal("no-table"); return T; }
    function seatedWids(T) {
        if (T.game === "holdem") return Object.values(T.st.seats || {}).map((x) => x.id);
        const R = T.st.round;
        return [...new Set([...(T.st.seats || []), ...(R ? [R.spinner, ...(R.house || [])] : [])])].filter(Boolean);
    }
    const isSeated = (T, wid) => !!wid && seatedWids(T).includes(wid);
    function connectedWid(T, wid) { const u = mxOf(wid); for (const c of T.openers) if (c.user === u && !c.closed) return true; return false; }
    /** B10 "gone" (addendum §8.1): when a seated person's last socket on the table went (game clock), cleared when one
     *  opens again; at a deal, anyone gone for GONE_MS is dealt out (reason gone). */
    function trackPresence(T, user) {
        const wid = user ? T.widByUser.get(user) : null;
        if (!wid || !T.goneAt) return;
        if (connectedWid(T, wid)) T.goneAt.delete(wid);
        else if (!T.goneAt.has(wid)) T.goneAt.set(wid, now());
    }
    function goneSet(T) {
        const out = new Set();
        if (!T.goneAt) return out;
        for (const w of seatedWids(T)) { const at = T.goneAt.get(w); if (at !== undefined && now() - at >= Holdem.HOLDEM.GONE_MS) out.add(w); }
        return out;
    }
    /** F7 (addendum §4.2): a reaction. Ephemeral: no wallet needed, no durable receipt (a resend of the same op within
     *  REACT_DUP_MS is answered from memory), not in the view, not stored, never activity for anything. */
    async function react(conn, f) {
        const ack = (ok, code = "", extra = {}) => sendFrame(conn, { t: "ack", op: f.op, ok, code, dup: false, ...extra });
        const T = tables.get(f.table);
        if (!T || T.closed || !conn.open.has(T.id) || !T.openers.has(conn)) return ack(false, "no-table");
        const t = mono();
        T.reactOps = T.reactOps || new Map();
        for (const [k, v] of T.reactOps) if (t - v.at > PLAY.REACT_DUP_MS) T.reactOps.delete(k);
        const key = `${conn.user}|${f.op}`;
        const seen = T.reactOps.get(key);
        if (seen) return sendFrame(conn, { t: "ack", op: f.op, ...seen.answer, dup: true });
        const answer = (ok, code = "", extra = {}) => { const a = { ok, code, ...extra }; T.reactOps.set(key, { at: t, answer: a }); return sendFrame(conn, { t: "ack", op: f.op, ...a, dup: false }); };
        const r = f.a.r;
        if (!REACTIONS.includes(r)) return answer(false, "bad");
        // who: a seat (Hold'em: the seat number; The Rig: the player's order) or, with REACT_SPECTATORS, a watcher
        const wid = T.widByUser.get(conn.user);
        const order = seatedWids(T);
        let seat = null;
        if (wid && order.includes(wid)) seat = T.game === "holdem" ? Number(Object.keys(T.st.seats).find((k) => T.st.seats[k].id === wid)) : order.indexOf(wid) + 1;
        if (seat === null && !PLAY.REACT_SPECTATORS) return answer(false, "not-in-call");
        if (seat === null) { // a watcher reacts only while in the room's call (§4.2 "watching from the call"; astra r1 #15)
            const rr = await spaces.resolve(T.room).catch(() => null);
            if (!rr || !rr.room || !rr.room.sessions.some((x) => x.sender === conn.user)) return answer(false, "not-in-call");
            const again = T.reactOps.get(key); // a resend that raced this one while we looked (astra r2 N2)
            if (again) return sendFrame(conn, { t: "ack", op: f.op, ...again.answer, dup: true });
        }
        let to;
        if (r === "toss") {
            to = f.a.to === undefined ? "pot" : f.a.to;
            if (to !== "pot") {
                const ok = T.game === "holdem" ? !!T.st.seats[to] : to >= 1 && to <= order.length;
                if (!ok) return answer(false, "bad");
            }
        } else if (f.a.to !== undefined) return answer(false, "bad");
        // the person's bucket (across all their sockets), then the table's rolling minute
        T.reactBucket = T.reactBucket || new Map();
        const b = T.reactBucket.get(conn.user) || { tokens: PLAY.REACT_BURST, at: t };
        b.tokens = Math.min(PLAY.REACT_BURST, b.tokens + (t - b.at) / PLAY.REACT_REFILL_MS); b.at = t;
        T.reactBucket.set(conn.user, b);
        if (b.tokens < 1) return answer(false, "cooldown", { retry_ms: Math.min(60_000, Math.ceil((1 - b.tokens) * PLAY.REACT_REFILL_MS)) });
        T.reactTimes = (T.reactTimes || []).filter((x) => t - x < 60_000);
        if (T.reactTimes.length >= PLAY.REACT_TABLE_PER_MIN) return answer(false, "cooldown", { retry_ms: Math.min(60_000, Math.max(1, T.reactTimes[0] + 60_000 - t)) });
        b.tokens -= 1; T.reactTimes.push(t);
        const frame = { t: "react", table: T.id, u: conn.user, seat, r, ...(to !== undefined ? { to } : {}), at: now() };
        for (const c of T.openers) if (!c.closed) sendFrame(c, frame);
        return answer(true);
    }
    /** A Pad socket that has gone quiet (a locked or backgrounded phone) no longer counts as a screen (B2). */
    const padFresh = (c) => !c.pad || mono() - c.last < SCREEN_STALE_MS; // the boundary itself is stale (astra r1 #16)
    function screensOf(T, wid) {
        const u = mxOf(wid); const k = new Set();
        for (const c of T.openers) if (c.user === u && !c.closed && padFresh(c)) { k.add(c.kind); if (c.pad) k.add("pad"); }
        return [...k].sort();
    }
    /** A Pad socket's freshness changed (gone quiet, or heard from again): the tables it has open get new views. */
    function padChanged(c) {
        const fresh = padFresh(c);
        if (c.padWasFresh === fresh) return;
        c.padWasFresh = fresh;
        for (const id of c.open) { const T = tables.get(id); if (T) pushViews(T).catch(() => {}); }
    }
    async function viewOf(T, user) {
        const wid = user ? T.widByUser.get(user) || null : null;
        const E = ENGINES[T.game];
        const v = E.viewFor(T.st, wid && isSeated(T, wid) ? wid : null, now());
        const spectators = [...new Set([...T.openers].filter((c) => !c.closed && !isSeated(T, T.widByUser.get(c.user))).map((c) => c.user))].length;
        const ctx = {
            room: T.room, owner: T.owner, now: now(), mx: (w) => mxOf(w) || "@someone:" + serverName, hostMx: mxOf(T.hostWid) || "@someone:" + serverName,
            connected: (w) => connectedWid(T, w), screens: (w) => screensOf(T, w), wallet: (w) => T.walletCache.get(w) || { holdings: 0, at_cap: false, cap: 100 },
            // B3: each seat's prestige rank in the table's space (public: the ranks API shows it to every member), so the
            // apps draw the token at the seat plates without a lookup; null (field left out) when the wallet isn't cached
            rank: (w) => { const x = T.walletCache.get(w); return x && Number.isInteger(x.rank) && x.rank >= 0 ? x.rank : null; },
            spectators, closedReason: T.closedReason, closedAt: T.closedAt, voidedHand: T.voidedHand,
        };
        return T.game === "holdem" ? holdemContract(v, T.st, wid, ctx) : rigContract(v, T.st, wid, ctx);
    }
    /**
     * The view for `user` with THEIR OWN vseq (games-rig's wiring rule, binding): a person's counter moves only when
     * their view's content moved, so nobody learns from a frame's timing or number that something changed in someone
     * else's secret panel (a Mute armed, a Peek placed). Monotonic per (table, person) across their sockets.
     * Returns {view, changed}.
     */
    async function personalView(T, user, { force = false } = {}) {
        const v = await viewOf(T, user);
        // clock readings (now, a paused Spinner's draining budget) never move a person's vseq
        const key = JSON.stringify({ ...v, now: 0, vseq: 0, round: v.round && v.round.paused ? { ...v.round, paused: { budget_ms: 0 } } : v.round });
        const k = user || "";
        const prev = T.seen.get(k);
        if (prev && prev.key === key && !force) { v.vseq = prev.vseq; return { view: v, changed: false }; }
        const vseq = (prev ? prev.vseq : 0) + 1;
        T.seen.set(k, { key, vseq });
        v.vseq = vseq;
        return { view: v, changed: true };
    }
    function listing(T) {
        const players = seatedWids(T).map(mxOf).filter(Boolean);
        const st = T.st;
        const status = T.closed ? "closed" : st.status === "round" ? "round" : st.status === "end" ? "end" : st.status === "hand" ? "hand" : st.status === "pause" ? "pause" : "lobby";
        return { table: T.id, game: T.game, status, host: mxOf(T.hostWid) || "@someone:" + serverName, seated: Math.min(8, players.length), seats: T.game === "holdem" ? T.opts.seats || 8 : 8, players: players.slice(0, 8), hand: T.game === "holdem" && st.hand ? st.hand.n : null, round: T.game === "rig" && st.round ? st.round.r : null, space: T.space, owner: T.owner };
    }
    const roomTables = (room) => [...tables.values()].filter((T) => T.room === room && !T.closed);

    async function refreshWallets(T) {
        await inTx(pool, async (c) => { for (const w of seatedWids(T)) T.walletCache.set(w, await walletInfo(c, w, T.sid)); });
    }
    async function pushViews(T) {
        await refreshWallets(T).catch((e) => log(`[play] wallet refresh: ${e.message}`));
        const byUser = new Map();
        for (const c of T.openers) {
            if (c.closed) continue;
            if (T.members && !T.members.has(c.user)) { dropOpener(T, c); continue; } // left / kicked / banned: no more views
            const live = sessions.get(c.sessionKey);
            if (!live || live.exp <= now()) { sendFrame(c, { t: "bye", code: "session" }); c.close(1008, "session"); continue; }
            if (!byUser.has(c.user)) byUser.set(c.user, await personalView(T, c.user));
            const pv = byUser.get(c.user);
            if (pv.changed || c.needsView) { c.needsView = false; sendFrame(c, { t: "view", table: T.id, vseq: pv.view.vseq, view: pv.view }); }
        }
        const lst = roomTables(T.room).map(listing);
        const lkey = JSON.stringify(lst);
        if (roomSent.get(T.room) !== lkey) { // never a frame when nothing public changed (no timing of secret moves)
            roomSent.set(T.room, lkey);
            for (const c of sockets) if (c.subs.has(T.room)) sendFrame(c, { t: "room", room: T.room, space: T.space, owner: T.owner, tables: lst });
        }
    }
    /** Someone no longer joined to the table's room or its bound space: their sockets stop getting the table (§6.0). */
    function dropOpener(T, c) {
        T.openers.delete(c); c.open.delete(T.id); trackPresence(T, c.user);
        sendFrame(c, { t: "error", code: "not-member", table: T.id });
    }
    /** §6.0 "Membership is re-checked … and when the server sees a leave, kick or ban": every REVALIDATE_MS (and on
     *  demand) the room's and the bound space's current members; anyone else watching is dropped at once, and a seated
     *  person who left leaves the table (their hand or round plays out by the rules: a leave). */
    const memberIds = (j) => (j instanceof Map ? [...j.keys()] : [...j]);
    async function revalidate(T) {
        if (T.closed) return;
        const seq = (T.memberSeq = (T.memberSeq || 0) + 1); // allocated BEFORE the reads: a slower, older check never wins
        const r = await spaces.resolve(T.room, { fresh: true }).catch(() => null);
        const info = await deps.spaceInfo(T.space).catch(() => null);
        if (!r || !r.room || !info) return; // unknown right now: keep the last answer (never a guess)
        if (T.memberApplied && seq < T.memberApplied) return; // an older, slower check never overwrites a newer one
        T.memberApplied = seq;
        // ids only: room state gives `joined` as a Map (mxid -> display name); spreading it gave [mxid, name] pairs, so
        // nobody matched and every joined member was cut after the first re-check (lab7 12:33)
        T.members = new Set(memberIds(r.room.joined).filter((u) => info.joined.has(u)));
        for (const c of [...T.openers]) if (!c.closed && !T.members.has(c.user)) dropOpener(T, c);
        for (const c of sockets) if (c.user && c.subs.has(T.room) && !T.members.has(c.user)) { c.subs.delete(T.room); sendFrame(c, { t: "error", code: "not-member", room: T.room }); }
        for (const w of seatedWids(T)) {
            const u = mxOf(w);
            if (u && !T.members.has(u)) enqueue(T, async () => { // re-checked when it runs: someone who rejoined stays
                const r2 = await spaces.resolve(T.room, { fresh: true }).catch(() => null);
                const i2 = await deps.spaceInfo(T.space).catch(() => null);
                if (!r2 || !r2.room || !i2 || (r2.room.joined.has(u) && i2.joined.has(u))) return;
                await runEngine(T, w, { do: "leave" }, "move");
            }).catch(() => {});
        }
    }
    function schedule(T) {
        clearTimeout(T.timer);
        if (T.closed) return;
        const at = ENGINES[T.game].nextDeadline(T.st);
        if (at === null || at === undefined || !Number.isFinite(at)) return;
        T.timer = setTimeout(() => enqueue(T, () => runEngine(T, null, null, "tick")).catch((e) => { log(`[play] tick ${T.id}: ${e.message}`); setTimeout(() => schedule(T), 2000).unref?.(); }), Math.max(10, at - now()));
        T.timer.unref?.();
    }
    function enqueue(T, fn) { const p = T.queue.then(fn, fn); T.queue = p.catch(() => {}); return p; }

    async function admittedFor(T) {
        try { const r = await spaces.resolve(T.room, { fresh: true }); return r.why === "" && r.space === T.space; }
        catch { return false; }
    }
    /** Wallet chips for the engine. Top-ups only where §2.4 says: the person sitting / joining, and everyone seated when
     *  a hand or round may start (topupAll). */
    async function balancesFor(T, actorWid, { topupActor = false, topupAll = false } = {}) {
        const wids = [...new Set([...seatedWids(T), ...(actorWid ? [actorWid] : [])])];
        const out = {};
        await inTx(pool, async (c) => {
            await L._impl.lockWallets(c, wids); // one sorted pass first: never a lock order that can cycle with commit()
            for (const w of [...wids].sort()) {
                if (topupAll || (topupActor && w === actorWid)) await L.topupIfDue(c, { sid: T.sid, wid: w, cfg, now: now() });
                out[w] = await L.balance(c, L.acct.w(w));
            }
        });
        return out;
    }
    /** Seated people still joined to the room AND the table's own space (§6.0: re-checked at every hand / round start). */
    async function departedMembers(T) {
        const r = await spaces.resolve(T.room, { fresh: true }).catch(() => null);
        const info = await deps.spaceInfo(T.space).catch(() => null);
        if (!r || !r.room || !info) return [];
        return seatedWids(T).filter((w) => { const u = mxOf(w); return u && !(r.room.joined.has(u) && info.joined.has(u)); });
    }

    /** One engine call (a move or a tick) as one transaction. Returns {ok, code}. */
    const debug = deps.debug || (() => {});
    async function runEngine(T, wid, a, kind, retried = false) {
        debug(`run ${T.id} ${kind} ${a ? a.do : ""}`);
        if (T.closed) return { ok: false, code: "no-table" };
        const E = ENGINES[T.game];
        const t = now();
        // any call can start a hand / round (a move runs the due timers first), so every call carries the admission check
        // (never while draining); the dial is a live value and never starts anything
        const live = a && a.do === "dial";
        const mayStart = !live;
        const between = ["lobby", "pause", "end"].includes(T.st.status) || T.st.round?.phase === "reveal"; // a start may be due
        const ctx = { now: t, balances: await balancesFor(T, wid, { topupActor: a && (a.do === "sit" || a.do === "join"), topupAll: !live && (kind === "tick" || a?.do === "deal" || a?.do === "start" || between) }),
            admitted: live ? true : (!draining && await admittedFor(T)), newSeed, randomInt, ...(T.game === "holdem" ? { gone: goneSet(T) } : {}) };
        debug(`  ctx ready`);
        // run the timers that are due first (a move after its deadline is stale), then the move
        let st = T.st; const fx = [];
        // people who left the room or the table's space leave BEFORE a hand / round can start with them (§6.0)
        if (mayStart && between) {
            for (const w of await departedMembers(T)) { const lv = E.act(st, w, { do: "leave" }, ctx); if (lv.ok !== false && lv.state) { st = lv.state; fx.push(...(lv.effects || [])); } }
        }
        // (a tick answers {state, effects}, ok unless it says ok: false; an unchanged state = nothing was due)
        // (an "I'm back" goes BEFORE the due timers: it wins over a pending instant act, addendum §8.1; astra r1 #11)
        const H0 = T.game === "holdem" ? T.st.hand : null;
        const instantMine = !!(H0 && !H0.done && H0.instantTurn === H0.turn && wid && Object.values(T.st.seats || {}).some((x, i) => x.id === wid && Number(Object.keys(T.st.seats)[i]) === H0.b?.toAct));
        const back = (a && a.do === "away" && a.on === false) || (instantMine && ["fold", "check", "call", "raise", "allin"].includes(a?.do));
        if (kind !== "tick" && !live && !back) { const tk = E.tick(st, ctx); if (tk.ok !== false && tk.state !== st) { st = tk.state; fx.push(...(tk.effects || [])); } }
        const r0 = kind === "tick" ? E.tick(st, ctx) : E.act(st, wid, a, ctx);
        const r = { ...r0, ok: r0.ok !== false, effects: r0.effects || [] };
        debug(`  engine ${r.ok} ${r.code || ""} effects ${JSON.stringify((r.effects || []).map((e) => e.t || e.k))}`);
        if (!r.ok && st === T.st) return { ok: false, code: r.code || "bad" }; // refused and nothing was due: no write
        if (r.ok) { st = r.state; fx.push(...r.effects); }
        // people who left the room or the table's space since: they leave at the start of the next hand / round (§6.0)
        if (st === T.st) { if (kind === "tick") schedule(T); return { ok: r.ok, code: r.code || "" }; }
        const answer = { ok: r.ok, code: r.ok ? "" : (r.code || "bad") };
        const admit = r.ok && a && (a.do === "sit" || a.do === "join") ? { wid, person: personKey(mxOf(wid)) } : null;
        const res = await commit(T, st, fx, kind === "tick" ? null : { wid, op: a?.__op, answer }, admit);
        if (res && res.conflict) { // another writer moved the table: the durable state was reloaded; run this call again once
            if (!retried) {
                if (a?.__op && wid) {
                    const { rows } = await pool.query("SELECT answer FROM play_ops WHERE table_id = $1 AND wid = $2 AND op_id = $3", [T.id, wid, a.__op]);
                    if (rows.length) return { ok: !!rows[0].answer.ok, code: rows[0].answer.code || "", dup: true };
                }
                return runEngine(T, wid, a, kind, true);
            }
            if (kind === "tick") schedule(T);
            return { ok: false, code: "stale", transient: true };
        }
        if (res && res.refused) return { ok: false, code: res.refused, transient: res.refused === "db" };
        return answer;
    }

    /** Make the new state + its effects durable (CAS on the table's version), then send views/posts. */
    async function commit(T, st, effects, receipt, admit = null) {
        const posts = [], lefts = [], ranks = [];
        let closed = null;
        T.committing = true; // provisional holdings aren't read while durable and in-memory state may disagree
        try { await inTx(pool, async (c) => {
            const { rows } = await c.query("SELECT version FROM play_tables WHERE id = $1 FOR UPDATE", [T.id]);
            if (!rows.length || Number(rows[0].version) !== T.version) throw new Conflict("table version moved");
            // every wallet this commit touches, locked in sorted order (deletion and the sampler serialise on these rows);
            // a wallet that was deleted meanwhile can't be debited: the whole move is refused
            const touched = new Set();
            for (const e of effects) for (const k of ["who"]) if (typeof e[k] === "string") touched.add(e[k]);
            for (const e of effects) for (const m of [e.payouts, e.refunds, e.to, e.from]) for (const w of Object.keys(m || {})) touched.add(w);
            for (const e of effects) if (T.game === "rig" && ["settle", "void"].includes(e.t || e.k) && e.round != null) {
                const { rows: owners } = await c.query("SELECT DISTINCT wid FROM play_accounts WHERE id LIKE $1 AND wid IS NOT NULL", [`esc:${T.id}:${e.round}:%`]);
                for (const o of owners) touched.add(o.wid);
            }
            if (admit) touched.add(admit.wid);
            const locked = await L._impl.lockWallets(c, [...touched]);
            const have = new Set(locked.map((w) => w.wid));
            for (const e of effects) if (((e.t || e.k) === "sit" || (e.t || e.k) === "credit" || (e.t || e.k) === "escrow") && !have.has(e.who)) throw new Refusal("no-wallet");
            if (admit && (!have.has(admit.wid) || !admit.person)) throw new Refusal("no-wallet"); // deleted meanwhile
            if (admit) { // the seat is reserved in THIS transaction: one table at a time per person, across every space
                try { await c.query("INSERT INTO play_seats (table_id, wid, sid, person) VALUES ($1,$2,$3,$4)", [T.id, admit.wid, T.sid, admit.person]); }
                catch (e) { if (e.code === "23505") throw new Refusal("seated-elsewhere"); throw e; }
            }
            for (const e of effects) {
                const out = await applyEffect(c, T, st, e);
                if (out?.post) posts.push(out.post);
                if (out?.left) lefts.push(out.left);
                if (out?.closed) closed = out.closed;
            }
            // an engine that closed the table by its state (The Rig sets status "closed"; Hold'em also sends an effect)
            if (!closed && st.status === "closed") closed = closeReason(st.closed_reason || st.closeReason || "host");
            for (const w of lefts) {
                const p = await L.prestigeCheck(c, { sid: T.sid, wid: w, cfg, now: now() });
                if (p.why === "prestige") ranks.push({ wid: w, rank: p.rank });
                await c.query("UPDATE play_seats SET active = false, left_at = now() WHERE table_id = $1 AND wid = $2 AND active", [T.id, w]);
            }
            // a closed table keeps only what its summary needs of the engine state (no round internals, no Whisper words)
            const stored = closed ? { host: st.host ?? null, rounds: st.rounds ?? 0 } : st;
            await c.query("UPDATE play_tables SET state = $2, version = version + 1, status = $3, closed_at = CASE WHEN $3 = 'closed' THEN now() ELSE closed_at END, closed_reason = COALESCE($4, closed_reason) WHERE id = $1",
                [T.id, JSON.stringify(stored), closed ? "closed" : "open", closed]);
            if (closed) { await forgetWhispers(c, T.id); await c.query("UPDATE play_seats SET active = false, left_at = now() WHERE table_id = $1 AND active", [T.id]); }
            if (receipt?.op) await c.query("INSERT INTO play_ops (table_id, wid, op_id, answer) VALUES ($1,$2,$3,$4)", [T.id, receipt.wid, receipt.op, JSON.stringify(receipt.answer || { ok: true, code: "" })]);
        }, { tries: 1 }); } catch (e) {
            T.committing = false;
            if (e instanceof Refusal) return { refused: e.code };
            if (e instanceof Conflict) { // another process moved the table: take the durable state (the caller re-runs)
                const { rows } = await pool.query("SELECT state, version, status FROM play_tables WHERE id = $1", [T.id]);
                if (rows.length) { T.st = rows[0].state; T.version = Number(rows[0].version); if (rows[0].status === "closed") T.closed = true; }
                return { conflict: true };
            }
            throw e;
        }
        debug(`  committed`);
        T.st = st; T.version += 1; T.committing = false;
        if (closed) { T.closed = true; T.closedReason = closed; T.closedAt = now(); clearTimeout(T.timer); }
        await pushViews(T);
        for (const p of posts) askToPost(T, p);
        for (const x of ranks) pushRank(T, x.wid, x.rank);
        for (const w of lefts) pushWallet(T, w);
        schedule(T);
        if (T.closed) setTimeout(() => { for (const c of T.openers) c.open.delete(T.id); tables.delete(T.id); }, 60_000).unref?.();
        return null;
    }

    async function applyEffect(c, T, st, e) {
        const kind = e.t || e.k;
        const sid = T.sid;
        const W = (w) => L.acct.w(w);
        const mv = (k, idem, from, to, amount) => (amount > 0 ? L.move(c, { sid, kind: k, idem, ref: T.id, cfg, now: now(), from, to, amount }) : null);
        const rev = T.version + 1;
        switch (kind) {
            // ---- Hold'em (docs/PLAY-HOLDEM-ENGINE.md "Effects → the ledger")
            case "sit": case "credit":
                await mv(kind === "sit" ? "sit" : "sit", `${kind}:${T.id}:${e.who}:${rev}:${e.seat}`, W(e.who), L.acct.seat(T.id, e.who), e.amount); return null;
            case "deal":
                await c.query("INSERT INTO play_games (id, table_id, sid, kind, n) VALUES ($1,$2,$3,'hand',$4) ON CONFLICT DO NOTHING", [`${T.id}:${e.hand}`, T.id, sid, e.hand]); return null;
            case "bet":
                await mv("bet", `bet:${T.id}:${e.hand}:${e.turn}${e.turn === 0 ? ":" + e.a : ""}:${e.seat}`, L.acct.seat(T.id, e.who), L.acct.pot(T.id, e.hand, e.who), e.amount); return null;
            case "settle": {
                if (T.game === "rig") return rigSettle(c, T, e);
                const entries = [];
                for (const [w, n] of Object.entries(e.from || {})) if (n) entries.push([L.acct.pot(T.id, e.hand, w), -n]);
                for (const [w, n] of Object.entries(e.to || {})) if (n) entries.push([L.acct.seat(T.id, w), n]);
                const g = await c.query("UPDATE play_games SET disposition = 'settled', finished_at = now(), log = $3 WHERE id = $1 AND disposition = 'open' AND table_id = $2", [`${T.id}:${e.hand}`, T.id, JSON.stringify(Holdem.handRecord ? Holdem.handRecord(st) : null)]);
                if (!g.rowCount) throw new Conflict("hand already finished");
                await L.post(c, { sid, kind: "hand", idem: `hand:${T.id}:${e.hand}`, ref: T.id, day: rules.dayOf(now(), cfg.tz), entries });
                return null;
            }
            case "void": {
                if (T.game === "rig") return rigVoid(c, T, e);
                const entries = [];
                for (const [w, n] of Object.entries(e.refunds || {})) if (n) { entries.push([L.acct.pot(T.id, e.hand, w), -n]); entries.push([L.acct.seat(T.id, w), n]); }
                await c.query("UPDATE play_games SET disposition = 'voided', finished_at = now() WHERE id = $1 AND disposition = 'open'", [`${T.id}:${e.hand}`]);
                await L.post(c, { sid, kind: "void", idem: `void:${T.id}:${e.hand}`, ref: T.id, day: rules.dayOf(now(), cfg.tz), entries });
                T.voidedHand = e.hand;
                return null;
            }
            case "cashout": {
                const bal = await L.balance(c, L.acct.seat(T.id, e.who));
                await mv("cashout", `cashout:${T.id}:${e.who}:${rev}`, L.acct.seat(T.id, e.who), W(e.who), bal);
                return null;
            }
            case "left": return { left: e.who };
            case "table-end":
                await c.query("UPDATE play_tables SET summary = $2 WHERE id = $1", [T.id, JSON.stringify(e.summary || { leaderboard: e.leaderboard, pit_boss: e.pit_boss })]); return null;
            case "post": return { post: { kind: e.kind, round: e.round ?? null } };
            case "closed": return { closed: closeReason(e.reason) };
            // ---- The Rig (docs/GAMES-RIG-ENGINE.md "Effects")
            case "escrow": {
                await c.query("INSERT INTO play_games (id, table_id, sid, kind, n) VALUES ($1,$2,$3,'round',$4) ON CONFLICT DO NOTHING", [`${T.id}:${e.round}`, T.id, sid, e.round]);
                await mv("rig-escrow", `rig:${T.id}:${e.round}:esc:${e.kind}:${e.who}:${rev}`, W(e.who), L.acct.esc(T.id, e.round, e.kind, e.who), e.amount);
                return null;
            }
            case "live": return null; // sent by the socket layer (the dial)
            case "forget-whispers": // §5.1 12: free text lives only until the table ends; the round logs keep "a Whisper was sent"
                await forgetWhispers(c, T.id); return null;
            default: log(`[play] unknown effect ${kind}`); return null;
        }
    }
    async function forgetWhispers(c, tableId) {
        await c.query(`UPDATE play_games SET log = jsonb_set(log, '{reveal,whispers}',
            COALESCE((SELECT jsonb_agg(w - 'text' || CASE WHEN w ? 'text' THEN '{"text_removed": true}'::jsonb ELSE '{}'::jsonb END)
                      FROM jsonb_array_elements(log->'reveal'->'whispers') w), '[]'::jsonb))
            WHERE table_id = $1 AND kind = 'round' AND log ? 'reveal' AND jsonb_typeof(log->'reveal'->'whispers') = 'array'`, [tableId]);
    }
    async function escrowsOf(c, T, round) {
        const { rows } = await c.query("SELECT id, balance FROM play_accounts WHERE id LIKE $1 AND balance <> 0", [`esc:${T.id}:${round}:%`]);
        return rows.map((r) => [r.id, Number(r.balance)]);
    }
    async function rigSettle(c, T, e) {
        const entries = (await escrowsOf(c, T, e.round)).map(([id, b]) => [id, -b]);
        for (const [w, n] of Object.entries(e.payouts || {})) if (n) entries.push([L.acct.w(w), n]);
        if (e.bank) entries.push([L.acct.bank(T.sid), e.bank]);
        const g = await c.query("UPDATE play_games SET disposition = 'settled', finished_at = now(), log = $2 WHERE id = $1 AND disposition = 'open'", [`${T.id}:${e.round}`, JSON.stringify({ reveal: e.reveal || null, net: e.net || null })]);
        if (!g.rowCount) throw new Conflict("round already finished");
        await L.post(c, { sid: T.sid, kind: "rig-settle", idem: e.idem || `rig:${T.id}:${e.round}:settle`, ref: T.id, day: rules.dayOf(now(), cfg.tz), entries });
        return null;
    }
    async function rigVoid(c, T, e) {
        const entries = [];
        for (const [id, b] of await escrowsOf(c, T, e.round)) { entries.push([id, -b]); entries.push([L.acct.w(id.slice(id.lastIndexOf(":") + 1)), b]); }
        await c.query("UPDATE play_games SET disposition = 'voided', finished_at = now() WHERE id = $1 AND disposition = 'open'", [`${T.id}:${e.round}`]);
        await L.post(c, { sid: T.sid, kind: "void", idem: `rig:${T.id}:${e.round}:void`, ref: T.id, day: rules.dayOf(now(), cfg.tz), entries });
        return null;
    }

    function askToPost(T, p) {
        const hostU = mxOf(T.hostWid);
        const targets = [hostU, ...seatedWids(T).map(mxOf)].filter(Boolean);
        for (const u of targets) {
            const c = [...sockets].find((s) => s.user === u && !s.closed);
            if (c) { sendFrame(c, { t: "post", kind: p.kind === "summary" ? "summary" : p.kind === "result" ? "result" : "invite", game: T.game, table: T.id, room: T.room, space: T.space, round: p.round ?? null }); return; }
        }
    }
    /** After an earned chip (the sampler): the person's `wallet` frame for that space, to their own sockets only. */
    async function pushWalletFor(wid, sid) {
        const u = mxOf(wid) || (await pool.query("SELECT user_id FROM play_people WHERE wid = $1", [wid])).rows[0]?.user_id;
        if (!u || ![...sockets].some((c) => c.user === u && !c.closed)) return;
        people.set(wid, u);
        const sp = (await pool.query("SELECT space_id FROM play_spaces WHERE sid = $1", [sid])).rows[0]?.space_id;
        const w = await inTx(pool, (c) => walletInfo(c, wid, sid)).catch(() => null);
        const { rows } = await pool.query("SELECT earned_today, day FROM play_wallets WHERE wid = $1", [wid]);
        if (!sp || !w || !rows.length) return;
        const earned = rows[0].day === rules.dayOf(now(), cfg.tz) ? Math.min(200, rows[0].earned_today) : 0;
        for (const c of sockets) if (c.user === u && !c.closed) sendFrame(c, { t: "wallet", space: sp, balance: w.balance, holdings: w.holdings, rank: w.rank, cap: w.cap, earned_today: earned });
    }
    async function pushWallet(T, wid) {
        const u = mxOf(wid); if (!u) return;
        const w = await inTx(pool, (c) => walletInfo(c, wid, T.sid)).catch(() => null);
        if (!w) return;
        for (const c of sockets) if (c.user === u && !c.closed) sendFrame(c, { t: "wallet", space: T.space, balance: w.balance, holdings: w.holdings, rank: w.rank, cap: w.cap });
    }
    async function pushRank(T, wid, rank) {
        const u = mxOf(wid); if (!u || rank < 1) return;
        const info = await deps.spaceInfo(T.space).catch(() => null);
        const members = info?.joined || new Set();
        if (!members.has(u)) return;
        for (const c of sockets) if (c.user && !c.closed && members.has(c.user)) sendFrame(c, { t: "rank", space: T.space, u, rank });
    }

    async function createTableFor(user, room, body, session) {
        if (draining || !flags().play) throw new Refusal("off");
        const acc = await roomAccess(user, room, { fresh: true });
        if (body.space !== acc.space) throw new Refusal("space-changed");
        if (!acc.inCall) throw new Refusal("not-in-call");
        if (body.game === "rig" && session.rigHidden) throw new Refusal("rig-hidden");
        if (roomTables(room).some((T) => T.game === body.game)) throw new Refusal("one-per-room");
        const id = tableId(body.game);
        const E = ENGINES[body.game];
        return inTx(pool, async (c) => {
            const sid = await sidFor(c, acc.space, acc.owner);
            const wid = await widFor(c, sid, user);
            if (!wid) throw new Refusal("no-wallet");
            if (body.game === "rig") await notSeatedElsewhere(c, user, null);
            const opts = body.game === "holdem" ? { seats: body.opts?.seats || 8 } : { preset: body.opts?.preset || "lite", bankroll: body.opts?.bankroll || 6, patch: body.opts?.patch !== false };
            const st = body.game === "holdem" ? E.createTable({ table: id, room, space: acc.space, host: wid, now: now(), opts }) : E.createTable({ table: id, room, space: acc.space, host: wid, now: now(), opts });
            if (body.game === "rig" && st.opts) Object.assign(st.opts, opts);
            try {
                await c.query("INSERT INTO play_tables (id, game, room, space_id, sid, owner, opts, state, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)", [id, body.game, room, acc.space, sid, acc.owner, JSON.stringify(opts), JSON.stringify(st)]);
            } catch (e) { if (e.code === "23505") throw new Refusal("one-per-room"); throw e; }
            if (body.game === "rig") {
                const lk = await L._impl.lockWallets(c, [wid]); // serialised with "Delete my chips"
                if (!lk.length) throw new Refusal("no-wallet");
                try { await c.query("INSERT INTO play_seats (table_id, wid, sid, person) VALUES ($1,$2,$3,$4)", [id, wid, sid, personKey(user)]); }
                catch (e) { if (e.code === "23505") throw new Refusal("seated-elsewhere"); throw e; }
            }
            const T = { id, game: body.game, room, space: acc.space, owner: acc.owner, sid, hostWid: wid, opts, st, version: 0, queue: Promise.resolve(), timer: null, openers: new Set(), widByUser: new Map([[user, wid]]), walletCache: new Map(), closed: false, acks: new Map(), seen: new Map(), goneAt: new Map() };
            tables.set(id, T);
            return T;
        }).then(async (T) => { await pushViews(T); askToPost(T, { kind: "invite" }); log(`[play] table ${T.game} opened (${roomTables(room).length} in that room)`); return T; });
    }
    async function notSeatedElsewhere(c, user, exceptTable) {
        const { rows } = await c.query("SELECT s.table_id FROM play_seats s JOIN play_people p ON p.wid = s.wid WHERE p.user_id = $1 AND s.active", [user]);
        if (rows.some((r) => r.table_id !== exceptTable)) throw new Refusal("seated-elsewhere");
    }

    /** A move from a socket. Returns the ack fields. */
    async function move(conn, f) {
        const T = T_of(f.table);
        const user = conn.user;
        if (T.game === "rig" && conn.rigHidden && ["join", "start"].includes(f.a.do)) throw new Refusal("rig-hidden");
        const key = `${user}|${f.op}`;
        if (T.acks.has(key)) return { ...T.acks.get(key), dup: true };
        let wid = T.widByUser.get(user);
        if (!wid) wid = await inTx(pool, (c) => widFor(c, T.sid, user)); // (for the receipt lookup; admission comes after)
        if (wid) { // a move already answered for good is answered again from its durable receipt, before anything else
            const { rows } = await pool.query("SELECT answer FROM play_ops WHERE table_id = $1 AND wid = $2 AND op_id = $3", [T.id, wid, f.op]);
            if (rows.length) return { ok: !!rows[0].answer.ok, code: rows[0].answer.code || "", dup: true };
        }
        const a = { ...f.a, ...(f.at ? { at: f.at } : {}), __op: f.op };
        // the contract's SETUP is spin 0 (the engine counts it as its first spin): map the move's `at` back
        if (T.game === "rig" && a.at && a.at.phase === "setup" && a.at.spin === 0 && T.st.round) a.at = { ...a.at, spin: T.st.round.spin };
        if (a.do === "sit" || a.do === "join") {
            const acc = await roomAccess(user, T.room, { fresh: true });
            if (acc.space !== T.space || a.space !== T.space) throw new Refusal("space-changed");
            if (!acc.inCall) throw new Refusal("not-in-call");
            wid = await inTx(pool, async (c) => { const w = await widFor(c, T.sid, user); if (!w) throw new Refusal("no-wallet"); await notSeatedElsewhere(c, user, T.id); return w; });
            T.widByUser.set(user, wid);
            // present only with a socket on the table; seated without one = gone from now (astra r1 #14)
            if (T.goneAt) { if (connectedWid(T, wid)) T.goneAt.delete(wid); else if (!T.goneAt.has(wid)) T.goneAt.set(wid, now()); }
        }
        if (!wid) throw new Refusal(T.game === "holdem" ? "not-your-turn" : "phase");
        if (T.members && !T.members.has(user) && !["leave", "away"].includes(f.a.do)) throw new Refusal("not-member"); // leave is always allowed
        // people named in a move are mapped to their wallet ids at this table (unknown = bad)
        for (const k of ["u", "person", "mechanic"]) if (a[k] !== undefined) { const w = T.widByUser.get(a[k]); if (!w) throw new Refusal("bad"); a[k] = w; }
        if (a.do === "kick" && a.u) { /* the engine checks host + phase */ }
        delete a.__op;
        if ((T.qlen || 0) >= 64) throw new Refusal("rate"); // bounded work per table
        T.qlen = (T.qlen || 0) + 1;
        const r = await enqueue(T, async () => {
            try {
                const live = sessions.get(conn.sessionKey);
                if (conn.closed || !live || live.exp <= now()) return { ok: false, code: "session", transient: true };
                const { rows } = await pool.query("SELECT answer FROM play_ops WHERE table_id = $1 AND wid = $2 AND op_id = $3", [T.id, wid, f.op]);
                debug(`receipt lookup ${T.id} ${wid} ${f.op}: ${rows.length}`);
                if (rows.length) return { ...rows[0].answer, dup: true };
                return await runEngine(T, wid, { ...a, __op: f.op }, "move");
            } finally { T.qlen -= 1; }
        });
        if (r.dup) return { ok: !!r.ok, code: r.code || "", dup: true };
        const ans = { ok: r.ok, code: r.ok ? "" : (r.code || "bad") };
        if (r.ok && deps.onMove) deps.onMove(user); // a game move counts as showing life (the sampler's anti-AFK rule)
        if (!r.transient) T.acks.set(key, ans); // a stale-after-conflict or db answer is never cached: a resend is a real retry
        if (T.acks.size > 5000) T.acks.delete(T.acks.keys().next().value);
        return { ...ans, dup: false };
    }

    // ------------------------------------------------------------------------------------ HTTP
    function cors(res) {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.set("Cache-Control", "no-store");
    }
    const sendErr = (res, code, extra = {}) => res.status(SCHEMA["x-codes"][code] || 400).json({ code, error: code, ...extra });
    function sessionOf(req) {
        const m = /^Play ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") || "");
        const s = m && sessions.get(sha(m[1]));
        if (!s || s.exp <= now()) return null;
        return s;
    }
    const wrap = (fn, { auth = true } = {}) => async (req, res) => {
        cors(res);
        try {
            if (!flags().play) return sendErr(res, "off");
            if (!ready) return sendErr(res, "db");
            let s = null;
            if (auth) {
                s = sessionOf(req);
                if (!s) return sendErr(res, "session");
                if (!perSession.hit(s.key)) return sendErr(res, "rate");
            }
            await fn(req, res, s);
        } catch (e) {
            if (e instanceof Refusal) return sendErr(res, e.code, e.extra);
            if (e && (e.code === "ECONNREFUSED" || /connect|terminat|Connection/.test(String(e.message)))) { log(`[play] db: ${e.message}`); return sendErr(res, "db"); }
            log(`[play] ${req.method} ${req.path}: ${e && e.stack ? e.stack : e}`);
            return sendErr(res, "db");
        }
    };
    const body = async (req) => { const r = await readJson(req, PLAY.BODY_LIMIT); if (!r.ok || r.value === null || typeof r.value !== "object" || Array.isArray(r.value)) throw new Refusal("bad"); return r.value; };
    const qSpace = (req) => { const s = req.query.space; if (typeof s !== "string" || !ROOM_RE.test(s)) throw new Refusal("bad"); return s; };

    function routes(router) {
        router.options(/.*/, (_req, res) => { cors(res); res.status(204).end(); });
        router.post("/v1/session", wrap(async (req, res) => {
            const b = await body(req);
            if (check("sessionRequest", b).length) throw new Refusal("bad");
            if (!perAddress.hit(ipBucket(req.ip)) || !perAccount.hit(b.user_id)) return sendErr(res, "rate");
            if (isGuest(b.user_id)) throw new Refusal("guest");
            let user;
            try { user = await deps.resolveOpenId({ openid: b.openid, user_id: b.user_id }); }
            catch (e) { if (e && (e.code === "remote-refused" || e.code === "unavailable")) throw new Refusal(e.code); throw e; }
            if (!user || user !== b.user_id) throw new Refusal("session");
            if (isGuest(user)) throw new Refusal("guest");
            const token = randomBytes(32).toString("base64url");
            const kind = b.client.kind;
            const rigHidden = (kind === "ios-app" || kind === "android-app") && flags().rig_phone_apps !== true;
            for (const [k, v] of sessions) if (v.exp <= now()) sessions.delete(k);
            sessions.set(sha(token), { key: sha(token), user, kind, rigHidden, exp: now() + PLAY.SESSION_MS });
            const wallets = await inTx(pool, (c) => L.walletSpaces(c, user));
            res.json({ v: 1, session: token, user, expires: now() + PLAY.SESSION_MS, wallets, rig_hidden: rigHidden });
        }, { auth: false }));
        router.post("/v1/wallet", wrap(async (req, res, s) => {
            const b = await body(req);
            if (check("walletRequest", b).length) throw new Refusal("bad");
            const info = await deps.spaceInfo(b.space);
            if (!info) throw new Refusal("unavailable");
            if (!info.joined.has(s.user)) throw new Refusal("not-member");
            if (info.owner !== serverName) throw new Refusal("wrong-server", { space: b.space, server: info.owner });
            const out = await inTx(pool, async (c) => {
                const sid = await sidFor(c, b.space, serverName);
                const r = await L.createWallet(c, { sid, user: s.user, cfg, now: now(), salt: deps.salt });
                people.set(r.wid, s.user);
                return { created: r.created, me: await L.me(c, { sid, spaceId: b.space, user: s.user, cfg, now: now() }) };
            });
            res.status(out.created ? 201 : 200).json(out.me);
        }));
        router.delete("/v1/wallet", wrap(async (req, res, s) => {
            const space = qSpace(req);
            const r = await inTx(pool, async (c) => { const sid = await L.sidOf(c, space); if (!sid) return { ok: false, code: "no-wallet" }; return L.deleteWallet(c, { sid, user: s.user, now: now(), salt: deps.salt }); });
            if (!r.ok) throw new Refusal(r.code);
            people.delete(r.wid);
            // their sessions, sockets and every cache that named them at a table go too (they sign in again for anything else)
            for (const [k, v] of sessions) if (v.user === s.user) sessions.delete(k);
            for (const c of sockets) if (c.user === s.user) { sendFrame(c, { t: "bye", code: "session" }); c.close(1000, "deleted"); }
            for (const T of tables.values()) {
                if (T.widByUser.get(s.user) === r.wid) T.widByUser.delete(s.user);
                for (const k of [...T.acks.keys()]) if (k.startsWith(`${s.user}|`)) T.acks.delete(k);
                T.seen.delete(s.user);
            }
            res.status(204).end();
        }));
        router.get("/v1/me", wrap(async (req, res, s) => {
            const space = qSpace(req);
            const m = await inTx(pool, async (c) => {
                const sid = await L.sidOf(c, space); if (!sid) return null;
                const wid = await widFor(c, sid, s.user);
                const T = wid ? [...tables.values()].find((x) => !x.closed && isSeated(x, wid)) : null;
                const m = await L.me(c, { sid, spaceId: space, user: s.user, cfg, now: now(), atTable: T ? { table: T.id, game: T.game, room: T.room } : null, provisional: wid ? () => provisionalOf(wid) : 0 });
                if (m && wid) m.notices = await noticesOf(c, wid); // v1.1 F8 (§5.5)
                if (m && wid) m.side = await sideOf(c, { sid, wid, cfg, now: now(), openMoney }); // v1.1 F9 (§6.4)
                return m;
            });
            if (!m) throw new Refusal("no-wallet");
            res.json(m);
        }));
        router.post("/v1/me/notices/seen", wrap(async (req, res, s) => {
            const b = await body(req);
            if (!b || typeof b.space !== "string" || !ROOM_RE.test(b.space) || !Number.isSafeInteger(b.upto) || b.upto < 0) throw new Refusal("bad");
            const n = await inTx(pool, async (c) => { const sid = await L.sidOf(c, b.space); const wid = sid && await widFor(c, sid, s.user); if (!wid) return null;
                return (await c.query("UPDATE play_notices SET seen = true WHERE wid = $1 AND id <= $2 AND NOT seen", [wid, b.upto])).rowCount; });
            if (n === null) throw new Refusal("no-wallet");
            res.json({ v: 1, seen: n });
        }));
        // F9 Tune In (addendum §6.4); never activity (no onMove)
        router.post("/v1/side/tune", wrap(async (req, res, s) => { res.status(201).json(await side.start(s.user, await body(req))); }));
        router.post("/v1/side/tune/:run", wrap(async (req, res, s) => { res.json(await side.tune(s.user, req.params.run, await body(req))); }));
        // F8 admin (addendum §5.3): server-checked on every request (adminOf)
        router.get("/v1/admin/spaces/:space", wrap(async (req, res, s) => { res.json(await admin.getSpace(s.user, req.params.space)); }));
        router.post("/v1/admin/spaces/:space/wallets", wrap(async (req, res, s) => { res.json(await admin.changeWallets(s.user, req.params.space, await body(req))); }));
        router.put("/v1/admin/spaces/:space/economy", wrap(async (req, res, s) => { res.json(await admin.changeEconomy(s.user, req.params.space, await body(req))); }));
        router.get("/v1/admin/spaces/:space/log", wrap(async (req, res, s) => { res.json(await admin.getLog(s.user, req.params.space, { before: req.query.before, limit: req.query.limit })); }));
        router.get("/v1/me/journal", wrap(async (req, res, s) => {
            const space = qSpace(req);
            const j = await inTx(pool, async (c) => { const sid = await L.sidOf(c, space); const wid = sid && await widFor(c, sid, s.user); return wid ? L.journal(c, { wid, before: typeof req.query.before === "string" ? req.query.before : null, limit: req.query.limit }) : null; });
            if (!j) throw new Refusal("no-wallet");
            res.json({ v: 1, space, ...j });
        }));
        router.get("/v1/ranks", wrap(async (req, res, s) => {
            const us = [].concat(req.query.u || []).filter((u) => typeof u === "string" && MXID_RE.test(u));
            if (us.length > 100) throw new Refusal("bad");
            let space, members;
            if (typeof req.query.room === "string") {
                const acc = await roomAccess(s.user, req.query.room); space = acc.space; members = acc.resolved.spaceJoined;
            } else {
                space = qSpace(req);
                const info = await deps.spaceInfo(space);
                if (!info || !info.joined.has(s.user)) throw new Refusal("not-member");
                members = info.joined;
            }
            const r = await inTx(pool, async (c) => { const sid = await L.sidOf(c, space); return sid ? L.ranks(c, { sid, users: us.filter((u) => members.has(u)) }) : {}; });
            res.json({ v: 1, space, ranks: r });
        }));
        router.get("/v1/rooms/:room/space", wrap(async (req, res, s) => {
            const room = req.params.room;
            if (!ROOM_RE.test(room)) throw new Refusal("bad");
            const r = await spaces.resolve(room);
            if (!r.room || !r.room.joined.has(s.user)) throw new Refusal("not-member");
            if (r.why === "unavailable") throw new Refusal("unavailable");
            if (r.why && r.why !== "wrong-server") throw new Refusal("no-space");
            if (!r.spaceJoined.has(s.user)) throw new Refusal("not-member");
            if (r.why === "wrong-server") throw new Refusal("wrong-server", { space: r.space, server: r.server });
            res.json({ space: r.space, server: r.server });
        }));
        router.get("/v1/rooms/:room/tables", wrap(async (req, res, s) => {
            const acc = await roomAccess(s.user, req.params.room);
            res.json({ space: acc.space, owner: acc.owner, tables: roomTables(req.params.room).map(listing) });
        }));
        router.post("/v1/rooms/:room/tables", wrap(async (req, res, s) => {
            const b = await body(req);
            if (check("tableRequest", b).length) throw new Refusal("bad");
            const T = await createTableFor(s.user, req.params.room, b, s);
            res.status(201).json({ table: T.id });
        }));
        router.get("/v1/tables/:id", wrap(async (req, res, s) => {
            const T = T_of(req.params.id);
            if (T.game === "rig" && s.rigHidden) throw new Refusal("rig-hidden");
            const acc = await tableAccess(s.user, T);
            if (!acc.inCall && !isSeated(T, T.widByUser.get(s.user))) throw new Refusal("not-in-call");
            await refreshWallets(T);
            res.json((await personalView(T, s.user)).view);
        }));
        router.get("/v1/tables/:id/summary", wrap(async (req, res, s) => {
            const row = await tableRow(req.params.id);
            await roomMember(s.user, row.room);
            const sum = row.summary || {};
            const net = {};
            for (const [w, n] of Object.entries(sum.net || {})) net[await histName(w)] = n;
            res.json({ v: 1, table: row.id, game: row.game, room: row.room, space: row.space_id, owner: row.owner, host: await histName(row.state?.host), status: row.status === "closed" ? "closed" : "open",
                opened: new Date(row.created_at).getTime(), closed: row.closed_at ? new Date(row.closed_at).getTime() : null, hands: sum.hands || 0, rounds: row.game === "rig" ? (row.state?.rounds || 0) : 0,
                biggest_pot: sum.biggest || 0, net, leaderboard: await Promise.all((sum.leaderboard || []).map(async (x) => ({ u: await histName(x.u), net: x.net }))), pit_boss: sum.pit_boss ? await histName(Array.isArray(sum.pit_boss) ? sum.pit_boss[0] : sum.pit_boss) : null });
        }));
        router.get("/v1/tables/:id/rounds/:r", wrap(async (req, res, s) => {
            const row = await tableRow(req.params.id);
            if (row.game !== "rig") throw new Refusal("no-table");
            await roomMember(s.user, row.room);
            const { rows } = await pool.query("SELECT log FROM play_games WHERE id = $1 AND disposition = 'settled'", [`${row.id}:${Number(req.params.r)}`]);
            if (!rows.length || !rows[0].log?.reveal) throw new Refusal("no-table");
            const names = new Map(); let n = 0;
            const hist = (w) => { const u = mxOf(w); if (u) return u; if (!names.has(w)) names.set(w, `~${++n}`); return names.get(w); };
            const rv = mapReveal(rows[0].log.reveal, hist);
            res.json({ v: 1, table: row.id, r: Number(req.params.r), spinner: hist(rows[0].log.reveal.spinner || ""), preset: rows[0].log.reveal.preset || "lite", history: rows[0].log.reveal.history || [], reveal: rv });
        }));
        router.get("/v1/tables/:id/hands", wrap(async (req, res, s) => {
            const row = await tableRow(req.params.id);
            if (row.game !== "holdem") throw new Refusal("no-table");
            await roomMember(s.user, row.room);
            const sid = row.sid;
            const wid = await inTx(pool, (c) => widFor(c, sid, s.user));
            const { rows } = await pool.query("SELECT n, log, created_at FROM play_games WHERE table_id = $1 AND disposition = 'settled' AND log IS NOT NULL ORDER BY n DESC LIMIT 50", [row.id]);
            const hands = [];
            for (const g of rows) {
                const h = wid && Holdem.historyFor ? Holdem.historyFor(g.log, wid) : null;
                if (!h) continue;
                const names = new Map(); let k = 0;
                const hist = (w) => { const u = mxOf(w); if (u) return u; if (!names.has(w)) names.set(w, `~${++k}`); return names.get(w); };
                hands.push(historyContract(h, g, hist));
            }
            res.json({ v: 1, hands: hands.filter(Boolean), next: null });
        }));
    }
    function historyContract(h, g, hist) {
        try {
            const seats = {}; for (const [k, w] of Object.entries(h.seats || {})) seats[k] = hist(w);
            const net = {}; for (const [w, n] of Object.entries(h.net || {})) net[hist(w)] = n;
            return { n: g.n, at: new Date(g.created_at).getTime(), button: h.button, board: [...(h.board || [])], you: { seat: h.you.seat, cards: [...h.you.cards] },
                actions: (h.actions || []).map((x) => ({ street: x.street, seat: x.seat, a: x.a, ...(x.to !== undefined ? { to: x.to } : {}) })), shown: h.shown || {}, seats, net, voided: !!h.voided };
        } catch { return null; }
    }
    async function tableRow(id) {
        if (typeof id !== "string" || !/^t[HR][A-Za-z0-9]{14}$/.test(id)) throw new Refusal("no-table");
        const { rows } = await pool.query("SELECT * FROM play_tables WHERE id = $1", [id]);
        if (!rows.length) throw new Refusal("no-table");
        return rows[0];
    }
    async function roomMember(user, room) {
        const r = await spaces.resolve(room);
        if (!r.room || !r.room.joined.has(user)) throw new Refusal("no-table"); // a table id alone grants nothing
    }
    async function histName(w) { return w ? (mxOf(w) || "~1") : "~1"; }

    // ------------------------------------------------------------------------------------ the socket
    function sendFrame(conn, f) {
        if (conn.sessionKey && f.t !== "bye") { // every delivery to a signed-in socket: its session must still be live
            const s = sessions.get(conn.sessionKey);
            if (!s || s.exp <= now()) { if (!conn.closed) { conn.send({ t: "bye", code: "session" }); conn.close(1008, "session"); } return; }
        }
        const errs = check("serverFrame", f);
        if (errs.length) {
            // name the exact field: a view is checked against its own game's view, its round against rigRound
            const detail = f.t === "view" && f.view ? [...check(`${f.view.game}View`, f.view), ...(f.view.round ? check("rigRound", f.view.round) : [])] : errs;
            log(`[play] BUG: a ${f.t} frame fails the contract (not sent): ${detail.slice(0, 4).join("; ")}`);
            return;
        }
        conn.send(f);
    }
    function onConnection(conn) {
        // transport timing runs on a monotonic clock (never the game clock, which tests move)
        Object.assign(conn, { user: null, kind: "web", pad: false, rigHidden: false, subs: new Set(), open: new Set(), tokens: PLAY.FRAME_BURST, last: mono(), lastFill: mono() });
        sockets.add(conn);
        const silent = setInterval(() => { if (mono() - conn.last > PLAY.SILENT_MS) conn.close(1000, "silent"); }, 10_000);
        silent.unref?.();
        conn.on("close", () => {
            clearInterval(silent); clearInterval(conn.padSweep); clearTimeout(conn.padEdge); sockets.delete(conn);
            for (const id of conn.open) { const T = tables.get(id); if (T) { T.openers.delete(conn); trackPresence(T, conn.user); pushViews(T).catch(() => {}); if (T.game === "rig") enqueue(T, () => onlineChanged(T, conn.user)).catch(() => {}); } }
        });
        conn.on("message", (text) => {
            conn.last = mono();
            if (conn.pad && conn.padWasFresh === false) padChanged(conn); // the phone is back
            if (conn.pad && conn.padEdge) { clearTimeout(conn.padEdge); conn.padEdge = setTimeout(() => padChanged(conn), SCREEN_STALE_MS); conn.padEdge.unref?.(); }
            const el = (mono() - conn.lastFill) / 1000; conn.lastFill = mono();
            conn.tokens = Math.min(PLAY.FRAME_BURST, conn.tokens + el * PLAY.FRAMES_PER_S);
            if (conn.tokens < 1) { sendFrame(conn, { t: "bye", code: "rate" }); return conn.close(1008, "rate"); }
            conn.tokens -= 1;
            let f;
            try { f = JSON.parse(text); } catch { sendFrame(conn, { t: "bye", code: "bad" }); return conn.close(1008, "bad"); }
            if (!depthOk(f) || loneSurrogate.test(text) || check("clientFrame", f).length) return sendFrame(conn, { t: "error", code: "bad" });
            if (f.t === "act" && f.a.do === "dial") { // the live dial: at most 10 a second, over = dropped
                const t = mono(); conn.dialAt = conn.dialAt || []; conn.dialAt = conn.dialAt.filter((x) => t - x < 1000);
                if (conn.dialAt.length >= 10) return; conn.dialAt.push(t);
            }
            const heavy = f.t === "act" || f.t === "open" || f.t === "sub";
            if (heavy && (conn.pending || 0) >= 16) { sendFrame(conn, { t: "error", code: "rate" }); return; } // answered, not fatal
            if (heavy) conn.pending = (conn.pending || 0) + 1;
            handle(conn, f).finally(() => { if (heavy) conn.pending -= 1; }).catch((e) => {
                if (e instanceof Refusal) {
                    if (f.t === "act") return sendFrame(conn, { t: "ack", op: f.op, ok: false, code: e.code, dup: false });
                    return sendFrame(conn, { t: "error", code: e.code, ...(f.table ? { table: f.table } : {}), ...(f.room ? { room: f.room } : {}), ...(e.extra || {}) });
                }
                log(`[play] socket ${f.t}: ${e && e.stack ? e.stack : e}`);
                if (f.t === "act") sendFrame(conn, { t: "ack", op: f.op, ok: false, code: "db", dup: false });
            });
        });
    }
    async function onlineChanged(T, user) {
        const wid = T.widByUser.get(user);
        if (!wid || T.closed) return;
        const online = [...T.openers].some((c) => c.user === user && !c.closed);
        const r = ENGINES[T.game].setOnline(T.st, wid, online, { now: now(), balances: {}, admitted: true, newSeed });
        if (r.ok && r.state !== T.st) await commit(T, r.state, r.effects || [], null);
    }
    async function handle(conn, f) {
        if (!flags().play) { sendFrame(conn, { t: "bye", code: "off" }); return conn.close(1000, "off"); }
        if (!ready) throw new Refusal("db");
        if (f.t === "auth") {
            const s = sessions.get(sha(f.session));
            if (!s || s.exp <= now() || conn.user) { sendFrame(conn, { t: "bye", code: "session" }); return conn.close(1008, "session"); }
            Object.assign(conn, { user: s.user, kind: f.client.kind, pad: !!f.client.pad, rigHidden: s.rigHidden, sessionKey: sha(f.session) });
            if (conn.pad) {
                conn.padWasFresh = true;
                // the edge: a timer at the last frame + SCREEN_STALE_MS (re-armed on every frame), plus a slow sweep as a backstop
                conn.padEdge = setTimeout(() => padChanged(conn), SCREEN_STALE_MS); conn.padEdge.unref?.();
                conn.padSweep = setInterval(() => padChanged(conn), PAD_SWEEP_MS); conn.padSweep.unref?.();
            }
            const mine = [...sockets].filter((c) => c.user === s.user && !c.closed);
            if (mine.length > PLAY.SOCKETS_PER_PERSON) { const old = mine[0]; sendFrame(old, { t: "bye", code: "replaced" }); old.close(1000, "replaced"); }
            const wallets = await inTx(pool, (c) => L.walletSpaces(c, s.user));
            sendFrame(conn, { t: "hello", v: 1, user: s.user, now: now(), rig_hidden: s.rigHidden, wallets, features: PLAY_FEATURES });
            return;
        }
        if (!conn.user) { sendFrame(conn, { t: "bye", code: "session" }); return conn.close(1008, "session"); }
        const live = sessions.get(conn.sessionKey);
        if (!live || live.exp <= now()) { sendFrame(conn, { t: "bye", code: "session" }); return conn.close(1008, "session"); }
        if (f.t === "ping") return sendFrame(conn, { t: "pong", now: now() });
        if (f.t === "sub") {
            const acc = await roomAccess(conn.user, f.room);
            conn.subs.add(f.room);
            return sendFrame(conn, { t: "room", room: f.room, space: acc.space, owner: acc.owner, tables: roomTables(f.room).map(listing) });
        }
        if (f.t === "unsub") { conn.subs.delete(f.room); return; }
        if (f.t === "open") {
            const T = T_of(f.table);
            if (T.game === "rig" && conn.rigHidden) throw new Refusal("rig-hidden");
            const acc = await tableAccess(conn.user, T);
            const w0 = T.widByUser.get(conn.user) || await inTx(pool, (c) => L.widOfUser(c, T.sid, conn.user));
            if (!acc.inCall && !isSeated(T, w0)) throw new Refusal("not-in-call");
            const still = sessions.get(conn.sessionKey);
            if (conn.closed || !still || still.exp <= now()) return; // revoked while we looked: add nothing back
            if (w0 && !T.widByUser.has(conn.user)) { T.widByUser.set(conn.user, w0); people.set(w0, conn.user); }
            T.openers.add(conn); conn.open.add(T.id); trackPresence(T, conn.user);
            conn.needsView = true; // a socket that just opened the table always gets the current view
            await pushViews(T);
            if (T.game === "rig") enqueue(T, () => onlineChanged(T, conn.user)).catch(() => {});
            return;
        }
        if (f.t === "close") { const T = tables.get(f.table); if (T && T.openers.delete(conn)) { conn.open.delete(T.id); trackPresence(T, conn.user); await pushViews(T); } return; }
        if (f.t === "act" && f.a.do === "react") return react(conn, f); // F7: ephemeral, before any wallet or receipt
        if (f.t === "act") {
            const T = T_of(f.table);
            if (f.a.do === "dial" && T.game === "rig") { // no ack; the bet dial is a live value
                const wid = T.widByUser.get(conn.user);
                const r = await enqueue(T, () => runEngine(T, wid, { ...f.a, at: f.at }, "move"));
                if (r.ok) for (const c of T.openers) if (!c.closed) { const pv = T.seen.get(c.user || ""); if (pv) sendFrame(c, { t: "live", table: T.id, vseq: pv.vseq, dial: f.a.bet }); }
                return;
            }
            const ack = await move(conn, f);
            return sendFrame(conn, { t: "ack", op: f.op, ok: ack.ok, code: ack.code, dup: ack.dup });
        }
    }

    // ------------------------------------------------------------------------------------ retention (§2.5)
    /** Hand and Rig round logs 30 days; then only the per-table summary for 90 days; then the table row (and with it the
     *  link to the room) goes. Deletion tombstones 30 days. The journal stays (balances depend on it); its `ref`s name
     *  table ids only, which nothing can join to a room once the table row is gone. */
    async function sweep() {
        const day = 86400_000;
        const r1 = await pool.query("UPDATE play_games SET log = NULL WHERE log IS NOT NULL AND finished_at < $1", [new Date(now() - 30 * day)]);
        const old = await pool.query("SELECT id FROM play_tables WHERE status = 'closed' AND closed_at < $1", [new Date(now() - 90 * day)]);
        for (const { id } of old.rows) {
            await inTx(pool, async (c) => {
                await c.query("DELETE FROM play_ops WHERE table_id = $1", [id]);
                await c.query("DELETE FROM play_seats WHERE table_id = $1", [id]);
                await c.query("DELETE FROM play_games WHERE table_id = $1 AND disposition <> 'open'", [id]);
                await c.query("DELETE FROM play_tables WHERE id = $1 AND status = 'closed'", [id]);
            });
        }
        const r3 = await pool.query("DELETE FROM play_tombstones WHERE deleted_on < $1", [new Date(now() - 30 * day)]);
        if (r1.rowCount || old.rowCount || r3.rowCount) log(`[play] retention: ${r1.rowCount} game log(s) cleared, ${old.rowCount} table(s) removed, ${r3.rowCount} tombstone(s) dropped`);
        const r4 = await admin.sweep(); // the admin log's 180 days (v1.1 §5.4)
        return { logs: r1.rowCount, tables: old.rowCount, tombstones: r3.rowCount, admin_log: r4.log };
    }

    // ------------------------------------------------------------------------------------ start / drain
    /** §1: tables never survive a restart. Every open game is called off from the ledger alone (pot:/esc: back to
     *  their owners), every table closes, every seat is cashed out, and the leaves get their prestige checks. */
    async function recover() {
        const leavers = new Map(); // wid → sid: everyone recovery removes from a table gets one prestige check at the end
        const { rows: open } = await pool.query("SELECT id, table_id, sid, kind, n FROM play_games WHERE disposition = 'open'");
        for (const g of open) {
            await inTx(pool, async (c) => {
                const prefix = g.kind === "hand" ? `pot:${g.table_id}:${g.n}:` : `esc:${g.table_id}:${g.n}:`;
                const { rows } = await c.query("SELECT id, balance FROM play_accounts WHERE id LIKE $1 AND balance > 0", [prefix + "%"]);
                const entries = [];
                for (const r of rows) {
                    const wid = r.id.slice(r.id.lastIndexOf(":") + 1);
                    leavers.set(wid, Number(g.sid));
                    entries.push([r.id, -Number(r.balance)]);
                    entries.push([g.kind === "hand" ? L.acct.seat(g.table_id, wid) : L.acct.w(wid), Number(r.balance)]);
                }
                const u = await c.query("UPDATE play_games SET disposition = 'voided', finished_at = now() WHERE id = $1 AND disposition = 'open'", [g.id]);
                if (!u.rowCount) return;
                await L.post(c, { sid: Number(g.sid), kind: "void", idem: g.kind === "hand" ? `void:${g.table_id}:${g.n}` : `rig:${g.table_id}:${g.n}:void`, ref: g.table_id, day: rules.dayOf(now(), cfg.tz), entries });
            });
        }
        const { rows: seats } = await pool.query("SELECT id, sid, balance FROM play_accounts WHERE kind = 'seat' AND balance > 0");
        for (const s of seats) {
            await inTx(pool, async (c) => {
                const wid = s.id.slice(s.id.lastIndexOf(":") + 1);
                const table = s.id.split(":")[1];
                await L.move(c, { sid: Number(s.sid), kind: "cashout", idem: `cashout:${table}:${wid}:restart`, ref: table, cfg, now: now(), from: s.id, to: L.acct.w(wid), amount: Number(s.balance) });
            });
            leavers.set(s.id.slice(s.id.lastIndexOf(":") + 1), Number(s.sid));
        }
        const { rows: stillSeated } = await pool.query("SELECT wid, sid FROM play_seats WHERE active");
        for (const x of stillSeated) leavers.set(x.wid, Number(x.sid));
        for (const [wid, sid] of leavers) await inTx(pool, (c) => L.prestigeCheck(c, { sid, wid, cfg, now: now() })); // a failure throws: not ready, retried
        const closing = await pool.query("SELECT id FROM play_tables WHERE status = 'open'");
        for (const { id } of closing.rows) await inTx(pool, (c) => forgetWhispers(c, id));
        const closed = await pool.query("UPDATE play_tables SET status = 'closed', closed_at = now(), closed_reason = 'restart', version = version + 1, state = jsonb_build_object('host', state->'host', 'rounds', state->'rounds') WHERE status = 'open'");
        await pool.query("UPDATE play_seats SET active = false, left_at = now() WHERE active");
        log(`[play] start: ${open.length} game(s) called off, ${seats.length} seat(s) cashed out, ${closed.rowCount} table(s) closed`);
        ready = true;
    }
    /** Games off / the updater's drain: call off what's in progress after `ms`, close every table. */
    async function drain(ms = PLAY.DRAIN_MS, reason = "off") {
        draining = true;
        await new Promise((r) => setTimeout(r, Math.min(ms, 5000)).unref?.());
        for (const T of [...tables.values()]) {
            if (T.closed) continue;
            await enqueue(T, async () => {
                for (let i = 0; i < 3 && !T.closed; i++) { // a conflict reloads the durable state: call it off from that
                    const r = ENGINES[T.game].voidRound(T.st, { now: now(), reason, balances: {}, admitted: true, newSeed });
                    const res = await commit(T, r.state, [...(r.effects || []), ...(!(r.effects || []).some((e) => (e.t || e.k) === "closed") ? [{ t: "closed", reason }] : [])], null);
                    if (!res || (!res.conflict && !res.refused)) break;
                }
                // if it still isn't closed for good, the next start's recovery calls it off from the ledger (§1)
            }).catch((e) => log(`[play] drain ${T.id}: ${e.message}`));
        }
        for (const c of sockets) { sendFrame(c, { t: "bye", code: reason === "restart" ? "restart" : "off" }); c.close(1001, reason); }
    }

    return {
        routes, recover, drain, sweep, provisionalOf, pushWalletFor,
        /** the membership re-check for every open table (install.mjs runs it every 15 s) */
        revalidateAll: async () => { for (const T of [...tables.values()]) if (!T.closed && (T.openers.size || seatedWids(T).length)) await revalidate(T).catch((e) => log(`[play] membership check: ${e.message}`)); },
        attach(server) { for (const path of ["/v1/ws", "/api/play/v1/ws"]) attachWs(server, { path, maxBytes: PLAY.MAX_FRAME, onConnection }); },
        _tables: tables, _sessions: sessions,
        /** run whatever is due on a table now (what its timer does; tests move the clock) */
        _tickNow: (id) => { const T = tables.get(id); return T ? enqueue(T, () => runEngine(T, null, null, "tick")) : null; },
    };
}
