// Writes the play contract to a directory (vectors/views/): schema.json, holdem/*.json, rig/*.json, frames.json,
// http.json, errors.json, malformed.json, cards.json, INDEX.json (md5 of every file). Deterministic: the same source
// gives the same bytes. Every example is checked against the schema before anything is written; a failure writes
// nothing. Usage: node play/contract/build.mjs OUTDIR
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SCHEMA, CODES, WHISPER_TEMPLATES } from "./schema.mjs";
import { allSteps, ROOM, SPACE, OWNER, HOLDEM_TABLE, RIG_TABLE, NOW, PEOPLE as P } from "./fixtures.mjs";
import { validate } from "../jsonschema.mjs";
import { listing } from "../views.mjs";

const out = process.argv[2];
if (!out) { console.error("usage: node build.mjs OUTDIR"); process.exit(2); }
const J = (x) => JSON.stringify(x, null, 1) + "\n";
const files = new Map(); // relative path → text
const problems = [];
const check = (def, value, where) => {
    for (const e of validate(SCHEMA, { $ref: `#/$defs/${def}` }, value)) problems.push(`${where}: ${e}`);
};

// ---- fixtures: one file per step
const steps = allSteps();
for (const s of steps) {
    for (const [who, view] of Object.entries(s.views)) check(s.game === "rig" ? "rigView" : "holdemView", view, `${s.game}/${s.id} (${who})`);
    files.set(`${s.game}/${s.id}.json`, J({ v: 1, game: s.game, step: s.id, about: s.about, people: s.people, views: s.views, moves: s.moves, next: s.next }));
}

// ---- frames: every client and server frame, with an example each
const viewEx = steps.find((s) => s.game === "holdem" && s.id === "02-preflop").views.seat6;
const rigEx = steps.find((s) => s.game === "rig" && s.id === "04-turn-full");
const frames = {
    about: "Every WebSocket frame (JSON text, <= 16 KiB). The first client frame must be auth (the session never goes in the URL). Keep the newest vseq per table; a view is a full snapshot. Every act except dial gets an ack; a resend of an op already answered gets the same answer with dup: true. Apps ignore unknown fields and unknown frame types.",
    client: {
        auth: { t: "auth", session: "Q2hpcHNBcmVQbGF5TW9uZXlPbmx5LUFfVGVzdDAxMjM", client: { kind: "web", pad: false, v: "12.2.0" } },
        sub: { t: "sub", room: ROOM },
        unsub: { t: "unsub", room: ROOM },
        open: { t: "open", table: HOLDEM_TABLE },
        close: { t: "close", table: HOLDEM_TABLE },
        ping: { t: "ping" },
        act_holdem_raise: { t: "act", table: HOLDEM_TABLE, op: "op-7f3a9c21b4d0e855", at: { hand: 1, turn: 1 }, a: { do: "raise", to: 6 } },
        act_holdem_sit: { t: "act", table: HOLDEM_TABLE, op: "op-a1b2c3d4e5f60718", a: { do: "sit", seat: 3, space: SPACE } },
        act_rig_join: { t: "act", table: RIG_TABLE, op: "op-a1b2c3d4e5f6071a", a: { do: "join", space: SPACE } },
        act_holdem_away: { t: "act", table: HOLDEM_TABLE, op: "op-a1b2c3d4e5f60719", a: { do: "away", on: false } },
        act_rig_start: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516273", a: { do: "start", preset: "lite", bankroll: 6, patch: true } },
        act_rig_dial: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516274", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "dial", bet: 3 } },
        act_rig_spin: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516275", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "spin" } },
        act_rig_call: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516276", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "call", card: "underdog" } },
        act_rig_audit: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516277", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "audit", spin: 2 } },
        act_rig_keep: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516278", at: { round: 1, spin: 0, phase: "setup" }, a: { do: "keep", card: "skim" } },
        act_rig_market: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516279", at: { round: 1, spin: 0, phase: "setup" }, a: { do: "market", side: "up", stake: 2 } },
        act_rig_market_pass: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627a", at: { round: 1, spin: 0, phase: "setup" }, a: { do: "market", side: "pass" } },
        act_rig_mute: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627b", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "mute", armed: true } },
        act_rig_nudge: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627c", at: { round: 2, spin: 5, phase: "nudge" }, a: { do: "nudge", reel: 3, step: 1 } },
        act_rig_whisper_template: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627d", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "whisper", template: "bluffing", person: P.dee } },
        act_rig_whisper_text: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627e", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "whisper", text: "watch the lizard" } },
        act_rig_peek: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627f", at: { round: 2, spin: 3, phase: "turn" }, a: { do: "peek", mechanic: P.dee, card: "moon-monday" } },
        act_rig_patch: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516280", at: { round: 2, spin: 4, phase: "turn" }, a: { do: "patch" } },
        act_rig_walk: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f40516281", at: { round: 2, spin: 6, phase: "turn" }, a: { do: "walk" } },
        // v1.1 F7: reactions (table-level, no `at`; only toss takes `to`: a seat / the Rig player's order, or "pot")
        act_react_tip: { t: "act", table: HOLDEM_TABLE, op: "op-r2react000000001", a: { do: "react", r: "tip" } },
        act_react_toss: { t: "act", table: HOLDEM_TABLE, op: "op-r2react000000002", a: { do: "react", r: "toss", to: 4 } },
        act_react_rig: { t: "act", table: RIG_TABLE, op: "op-r2react000000003", a: { do: "react", r: "toss", to: "pot" } },
    },
    server: {
        hello: { t: "hello", v: 1, user: P.ana, now: NOW, rig_hidden: false, wallets: [SPACE], features: ["fresh-screens", "react", "away2"] },
        room: { t: "room", room: ROOM, space: SPACE, owner: OWNER, tables: [listing({ game: "holdem", table: HOLDEM_TABLE, space: SPACE, owner: OWNER, status: "hand", host: P.ana, opts: { seats: 8 }, seats: [{ u: P.ana }, { u: P.ben }, { u: P.dee }], hand: { n: 1 } }),
            listing({ game: "rig", table: RIG_TABLE, space: SPACE, owner: OWNER, status: "round", host: P.ana, players: [{ u: P.ana }, { u: P.ben }, { u: P.cy }], round: { r: 2 } })] },
        view: { t: "view", table: HOLDEM_TABLE, vseq: viewEx.vseq, view: viewEx },
        live: { t: "live", table: RIG_TABLE, vseq: rigEx.views.ben.vseq, dial: 3 },
        ack_ok: { t: "ack", op: "op-7f3a9c21b4d0e855", ok: true, code: "", dup: false },
        ack_dup: { t: "ack", op: "op-7f3a9c21b4d0e855", ok: true, code: "", dup: true },
        ack_refused: { t: "ack", op: "op-0c1d2e3f40516276", ok: false, code: "greyed", dup: false },
        wallet: { t: "wallet", space: SPACE, balance: 38, holdings: 40, rank: 1, cap: 150 },
        rank: { t: "rank", space: SPACE, u: P.dee, rank: 3 },
        post: { t: "post", kind: "invite", game: "holdem", table: HOLDEM_TABLE, room: ROOM, space: SPACE, round: null },
        post_result: { t: "post", kind: "result", game: "rig", table: RIG_TABLE, room: ROOM, space: SPACE, round: 2 },
        pong: { t: "pong", now: NOW },
        error: { t: "error", code: "not-in-call", room: ROOM },
        error_wrong_server: { t: "error", code: "wrong-server", room: ROOM, space: "!squad:other.example", server: "other.example" },
        bye: { t: "bye", code: "replaced" },
        // v1.1 F7
        react: { t: "react", table: HOLDEM_TABLE, u: P.ana, seat: 1, r: "toss", to: 4, at: NOW },
        react_watcher: { t: "react", table: HOLDEM_TABLE, u: P.cy, seat: null, r: "clap", at: NOW },
        ack_cooldown: { t: "ack", op: "op-r2react000000001", ok: false, code: "cooldown", dup: false, retry_ms: 2600 },
    },
};
for (const [k, f] of Object.entries(frames.client)) check("clientFrame", f, `frames.client.${k}`);
for (const [k, f] of Object.entries(frames.server)) check("serverFrame", f, `frames.server.${k}`);
files.set("frames.json", J(frames));

// ---- HTTP: every endpoint with a request and an answer
const meEx = { v: 1, space: SPACE, user: P.ana, balance: 38, holdings: 40, rank: 1, cap: 150, at_table: { table: HOLDEM_TABLE, game: "holdem", room: ROOM }, earned_today: 3, day_max: 16, accrual_s: 420, chip_s: 900, chip_minutes: 15, day: "2026-11-19", topup: { available: false, next_day: "2026-11-20" } , notices: { items: [{ id: 812, at: NOW - 60000, action: "grant", amount: 5, reason: "birthday" }], more: 0 }, side: { on: true, eligible: false, reason: "not-broke", left_today: 10, day_max: 10, broke_max: 4 } };
const http = {
    about: "Base: https://<server>/api/play/v1 (the room's own server, rankServerFor). Header Authorization: Play <session> on everything but POST /session. CORS *, no cookies. Errors: {code, error} with the status in errors.json. All bodies JSON.",
    endpoints: [
        { method: "POST", path: "/session", def_req: "sessionRequest", def: "sessionAnswer", status: 200,
            req: { openid: { access_token: "<from POST /_matrix/client/v3/user/{me}/openid/request_token>", matrix_server_name: "example.org", token_type: "Bearer", expires_in: 3600 }, user_id: P.ana, client: { kind: "desktop", v: "12.2.0", pad: false } },
            res: { v: 1, session: "Q2hpcHNBcmVQbGF5TW9uZXlPbmx5LUFfVGVzdDAxMjM", user: P.ana, expires: NOW + 8 * 3600 * 1000, wallets: [SPACE], rig_hidden: false } },
        { method: "GET", path: "/rooms/{room}/space", def: "spaceAnswer", status: 200, about: "the room's game space as THIS server decides it (game_space, server mode). Errors: 403 not-member (naming nothing: not joined to the room AND its space), 403 no-space, 403 is-space never (a space is no-space here), 403 wrong-server {space, server} (the app shows it, never follows it), 503 unavailable.", req: null, res: { space: SPACE, server: OWNER },
            errors: [{ status: 403, body: { code: "wrong-server", error: "this room's chips are kept by another server", space: "!squad:other.example", server: "other.example" } }, { status: 403, body: { code: "no-space", error: "games live in spaces" } }, { status: 503, body: { code: "unavailable", error: "this server can't see the room's space in full yet" } }, { status: 403, body: { code: "not-member", error: "not a member" } }] },
        { method: "POST", path: "/wallet", def_req: "walletRequest", def: "me", status: 201, about: "opt in to that space (after the app's one-time line); answers /me. Again when the wallet exists: 200, same answer. 403 not-member unless joined to the space; 403 wrong-server unless this server keeps it.", req: { space: SPACE }, res: { ...meEx, balance: 10, holdings: 10, rank: 0, cap: 100, at_table: null, earned_today: 0, accrual_s: 0, topup: { available: false, next_day: "2026-11-20" } } },
        { method: "DELETE", path: "/wallet?space={space}", status: 204, about: "Delete my chips in that space. 409 seated / open-money while anything of yours is in play there.", req: null, res: null },
        { method: "GET", path: "/me?space={space}", def: "me", status: 200, about: "runs the top-up check; 404 no-wallet before opting in", req: null, res: meEx },
        { method: "GET", path: "/me/journal?space={space}&before=<tx>&limit=50", def: "journal", status: 200, req: null,
            res: { v: 1, space: SPACE, entries: [{ tx: "x9TQ2", at: null, day: "2026-11-19", delta: 1, reason: "earn", ref: null }, { tx: "x9TQ1", at: NOW - 60000, day: "2026-11-19", delta: -40, reason: "sit", ref: HOLDEM_TABLE }, { tx: "x9TQ0", at: NOW - 86400000, day: "2026-11-18", delta: 10, reason: "start", ref: null }], next: null } },
        { method: "GET", path: "/ranks?space={space}&u=@ana:example.org&u=@dee:example.net (or ?room={room}&u=…)", def: "ranks", status: 200, about: "<= 100 ids; the caller joined to the space (or the room); only ranks above 0, only current space members with a wallet there (frozen wallets: no rank), nothing else", req: null, res: { v: 1, space: SPACE, ranks: { [P.ana]: 1, [P.dee]: 3 } } },
        { method: "GET", path: "/rooms/{room}/tables", def: "tables", status: 200, req: null, res: { space: SPACE, owner: OWNER, tables: frames.server.room.tables } },
        { method: "POST", path: "/rooms/{room}/tables", def_req: "tableRequest", def: "tableCreated", status: 201, about: "space = the one the app showed; 409 space-changed if the server's own answer differs (before any chip moves)", req: { game: "holdem", space: SPACE, opts: { seats: 8 } }, res: { table: HOLDEM_TABLE } },
        { method: "POST", path: "/rooms/{room}/tables", def_req: "tableRequest", def: "tableCreated", status: 201, req: { game: "rig", space: SPACE, opts: { preset: "lite", bankroll: 6, patch: true } }, res: { table: RIG_TABLE } },
        { method: "GET", path: "/tables/{id}", def: "view", status: 200, about: "the caller's view (same as a view frame's view)", req: null, res: viewEx },
        { method: "GET", path: "/tables/{id}/hands?before=<n>&limit=50", def: "hands", status: 200, req: null,
            res: { v: 1, hands: [{ n: 1, at: NOW, button: 6, board: ["2c", "9d", "Ts", "Kh", "5s"], you: { seat: 1, cards: ["As", "Kd"] },
                actions: [{ street: "preflop", seat: 1, a: "sb", to: 1 }, { street: "preflop", seat: 4, a: "bb", to: 2 }, { street: "preflop", seat: 6, a: "raise", to: 6 }, { street: "preflop", seat: 1, a: "call", to: 6 }, { street: "preflop", seat: 4, a: "call", to: 6 }],
                shown: { 1: ["As", "Kd"], 4: ["9h", "9c"], 6: ["Qs", "Jc"] }, seats: { 1: P.ana, 4: P.ben, 6: P.dee }, net: { [P.ana]: -20, [P.ben]: -20, [P.dee]: 40 }, voided: false }], next: null } },
        { method: "GET", path: "/tables/{id}/rounds/{r}", def: "round", status: 200, about: "a FINISHED Rig round only (404 no-table before its reveal)", req: null,
            res: (() => { const rv = steps.find((s) => s.game === "rig" && s.id === "10-reveal").views.spectator.round; return { v: 1, table: RIG_TABLE, r: rv.r, spinner: rv.spinner, preset: rv.preset, history: rv.history, reveal: rv.reveal }; })() },
        { method: "GET", path: "/tables/{id}/summary", def: "summary", status: 200, about: "what a chat card renders; hands for Hold'em, rounds + leaderboard + pit_boss for The Rig", req: null,
            res: { v: 1, table: HOLDEM_TABLE, game: "holdem", room: ROOM, space: SPACE, owner: OWNER, host: P.ana, status: "closed", opened: NOW - 3600000, closed: NOW, hands: 24, rounds: 0, biggest_pot: 60, net: { [P.ana]: -12, [P.ben]: -10, [P.dee]: 22 }, leaderboard: [], pit_boss: null } },
        // ---- v1.1 F8 (addendum §5.3): only the space's own server answers; admins = power level 100 in the space or the server owner
        { method: "GET", path: "/admin/spaces/{space}", def: "adminSpace", status: 200, about: "the admin screen's data (403 not-admin | not-member | wrong-server). Someone with open money: balance null, open true.", req: null,
            res: { v: 1, space: SPACE, you: { admin: true, why: "space-admin" }, economy: { chip_minutes: { value: 15, source: "default" }, day_max: { value: 16, source: "default" }, start: { value: 10, source: "default" }, topup_to: { value: 5, source: "default" }, cap_base: { value: 100, source: "default" }, cap_per_rank: { value: 50, source: "default" }, side_day_max: { value: 10, source: "default" }, side_on: { value: true, source: "space" } },
                wallets: [{ u: P.ana, balance: 38, rank: 1, cap: 150, open: false }, { u: P.ben, balance: null, rank: 0, cap: 100, open: true }] } },
        { method: "POST", path: "/admin/spaces/{space}/wallets", def_req: "adminWalletsRequest", def: "adminWallets", status: 200, about: "grant | remove | set | reset | rank; who = a list (all-or-nothing) or \"everyone\" (skips listed). A resend of the same op: the first answer, dup true; the op with another request: 409 op-reused.",
            req: { op: "op-r2admin00000001", action: "grant", who: [P.ana, P.ben], amount: 5, reason: "birthday" },
            res: { done: [{ u: P.ana, before: { balance: 38, rank: 1 }, after: { balance: 43, rank: 1 } }, { u: P.ben, before: { granted: 5 }, after: { granted: 5 } }], skipped: [], log: 812, dup: false },
            errors: [{ status: 409, body: { code: "at-table", error: "at-table", who: [P.ben] } }, { status: 404, body: { code: "no-wallet", error: "no-wallet", who: [P.cy] } }, { status: 400, body: { code: "bad-reason", error: "bad-reason" } }] },
        { method: "PUT", path: "/admin/spaces/{space}/economy", def_req: "adminEconomyRequest", def: "adminEconomy", status: 200, about: "set and/or reset keys (bounds in rules.mjs ECONOMY_BOUNDS); nothing retroactive",
            req: { op: "op-r2admin00000002", set: { chip_minutes: 10, day_max: 20 }, reset: ["start"], reason: "game night" },
            res: { economy: { chip_minutes: { value: 10, source: "space" }, day_max: { value: 20, source: "space" }, start: { value: 10, source: "default" }, topup_to: { value: 5, source: "default" }, cap_base: { value: 100, source: "default" }, cap_per_rank: { value: 50, source: "default" }, side_day_max: { value: 10, source: "default" }, side_on: { value: true, source: "default" } }, log: 813, dup: false },
            errors: [{ status: 400, body: { code: "bad-value", error: "bad-value", key: "day_max", min: 1, max: 200 } }] },
        { method: "GET", path: "/admin/spaces/{space}/log?before=<id>&limit=50", def: "adminLog", status: 200, about: "newest first; who = \"someone\" once that wallet was deleted", req: null,
            res: { v: 1, space: SPACE, entries: [{ id: 813, at: NOW, by: P.ana, by_role: "space-admin", action: "economy", who: "economy", amount: null, before: {}, after: { chip_minutes: 10, day_max: 20 }, reason: "game night", count: 0 },
                { id: 812, at: NOW - 60000, by: P.ana, by_role: "space-admin", action: "grant", who: P.ben, amount: 5, before: { granted: 5 }, after: { granted: 5 }, reason: "birthday", count: 1 }] } },
        { method: "POST", path: "/me/notices/seen", def_req: "noticesSeenRequest", def: "noticesSeen", status: 200, about: "acknowledge /me.notices up to that id (this wallet only)", req: { space: SPACE, upto: 812 }, res: { v: 1, seen: 1 } },
        // ---- v1.1 F9 (addendum §6.4)
        { method: "POST", path: "/side/tune", def_req: "sideStartRequest", def: "sideRun", status: 201, about: "start a run (409 not-broke | open-money | day-max, 403 side-off | not-member | wrong-server, 404 no-wallet); a new run cancels your old one",
            req: { space: SPACE }, res: { run: "sRq7Wb2kLmN4pX8zT1", lo: 1, hi: 100, tries_left: 7, expires: NOW + 90000, pay: [3, 3, 3, 3, 2, 2, 1], left_today: 10 } },
        { method: "POST", path: "/side/tune/{run}", def_req: "sideTuneRequest", def: "sideTune", status: 200, about: "one try (400 bad outside lo..hi, costs nothing; 404 no-run; 409 stale; 429 rate: 1 try / 300 ms). secret only when found, lost or cancelled.",
            req: { op: "op-r2side000000001", guess: 50 }, res: { result: "higher", lo: 51, hi: 100, tries_left: 6, paid: 0, dup: false } },
        { method: "POST", path: "/side/tune/{run}", def_req: "sideTuneRequest", def: "sideTune", status: 200, req: { op: "op-r2side000000002", guess: 62 },
            res: { result: "found", lo: 51, hi: 74, tries_left: 4, paid: 3, secret: 62, wallet: { balance: 3, holdings: 3 }, dup: false } },
    ],
};
for (const e of http.endpoints) {
    if (e.def_req) check(e.def_req, e.req, `http ${e.method} ${e.path} req`);
    if (e.def) check(e.def, e.res, `http ${e.method} ${e.path} res`);
    for (const [i, x] of (e.errors || []).entries()) check("httpError", x.body, `http ${e.method} ${e.path} errors[${i}]`);
}
files.set("http.json", J(http));

// ---- errors: every code, its HTTP status, when it happens
const WHEN = {
    session: "no / expired / unknown play session (HTTP) or a frame before auth (socket: bye session)",
    guest: "a guest account, the Memories recorder or the system account tried to sign in",
    "not-member": "not joined to the room (as this server sees it), or the room isn't this server's",
    "not-in-call": "needs a live call membership in the room (open a table, sit, join, watch)",
    "remote-refused": "the user's server is not on this server's federation list",
    "rig-hidden": "The Rig from an ios-app/android-app session while the owner's switch is off",
    "no-space": "the room has no game space (in no space, or a space itself): games live in spaces",
    "wrong-server": "the room's game space is kept by another server (the body names space + server: show it, never follow it)",
    "space-changed": "the space you sent (create / wallet / sit / join) isn't the room's game space any more: refresh what you show",
    unavailable: "this server can't see the room's space in full (state unknown or still filling in): try again later",
    "no-table": "no such table (or not visible to you; a table id alone grants nothing)",
    "no-wallet": "you haven't opted in on this server (POST /wallet first)",
    "seated-elsewhere": "one table at a time per person per server",
    "table-full": "every seat taken (Hold'em) / 8 players (The Rig)",
    "one-per-room": "an open table of that game already exists in this room",
    seated: "delete refused while you're at a table",
    "open-money": "delete / prestige wait: something of yours is still in play",
    rate: "too many requests or frames (socket: over the limit again = closed)",
    off: "games are turned off on this server (the dashboard switch), or draining",
    db: "the games database is unavailable",
    stale: "the move named another turn (hand+turn / round+spin+phase): refresh from the newest view",
    "not-your-turn": "not your turn (or not your role)",
    phase: "not allowed in this phase",
    bad: "malformed request or frame",
    "bad-action": "a move that isn't allowed now (check facing a bet, Walk before walk_from, …)",
    "bad-amount": "raise below the minimum / above your stack; dial outside 1..3 or above the bankroll; stake outside its range",
    "no-chips": "not enough chips (sit with 0 and no top-up, Call needs bankroll >= 2, Peek needs 2, …)",
    limit: "a per-round count used up (Calls, Audit, Mutes, Nudge, Whisper, Peek)",
    locked: "Peek after the lock (after spin peek_lock_after)",
    window: "the Nudge window has closed",
    taken: "someone else's Nudge already won this spin",
    rules: "a Patch / keep that would break the machine rules (bites > 6, two Taxes, a card twice)",
    greyed: "that card is dead, busted or wrongly called (can't be Called or Patched in)",
    "host-only": "only the table's host can do that",
    // v1.1
    cooldown: "a reaction too soon (your bucket, or the table's minute is full): the ack carries retry_ms; the socket stays open",
    "op-reused": "an admin write's op was already used for a different request",
    "bad-reason": "an admin why-text that is empty, too long, has control characters or a link, or looks like a Matrix id",
    "bad-value": "an economy value outside its bounds (the answer names the key, min and max)",
    "at-table": "the person has open money (at a table, in a round): only a grant is allowed",
    "not-admin": "you aren't an admin of that space (power level 100 in the space) nor the server owner",
    "not-broke": "Tune In is only for people at or below the broke line (4 chips)",
    "day-max": "today's Tune In chips are used up",
    "side-off": "Tune In is switched off for this space (or this server)",
    "no-run": "no such Tune In run for you (expired, finished, or the server restarted)",
};
const errors = { about: "Every code: HTTP status (an HTTP error body is {code, error}; a socket ack carries code only), and when.", codes: Object.fromEntries(Object.entries(CODES).map(([c, s]) => [c, { http: s, when: WHEN[c] }])) };
for (const c of Object.keys(CODES)) if (!WHEN[c]) problems.push(`errors: no WHEN for ${c}`);
for (const c of Object.keys(CODES)) check("httpError", { code: c, error: WHEN[c] }, `errors.${c}`);
files.set("errors.json", J(errors));

// ---- chat cards (§6.6): the event content and the exact plain-text bodies (no amounts, ever)
const cards = {
    about: "Chat cards are ordinary m.room.message events (msgtype m.text). Readers render from the room's own server's record (GET /tables/{id}/summary or /rounds/{r}); a card whose server differs from the room's server shows \"Couldn't load this game\". Show the first card per (table, kind, round); ignore repeats. Bodies NEVER carry amounts. {name} = the poster's display name.",
    content_key: "dev.tinhat.game",
    examples: [
        { body: "{name} opened a Texas Hold'em table: join from the call.", "dev.tinhat.game": { v: 1, kind: "invite", game: "holdem", server: OWNER, space: SPACE, table: HOLDEM_TABLE } },
        { body: "{name} opened a table of The Rig: join from the call.", "dev.tinhat.game": { v: 1, kind: "invite", game: "rig", server: OWNER, space: SPACE, table: RIG_TABLE } },
        { body: "Texas Hold'em results are in: open this in Tin Hat.", "dev.tinhat.game": { v: 1, kind: "summary", game: "holdem", server: OWNER, space: SPACE, table: HOLDEM_TABLE } },
        { body: "Game results are in: open this in Tin Hat.", "dev.tinhat.game": { v: 1, kind: "result", game: "rig", server: OWNER, space: SPACE, table: RIG_TABLE, round: 2 } },
        { body: "Game results are in: open this in Tin Hat.", "dev.tinhat.game": { v: 1, kind: "summary", game: "rig", server: OWNER, space: SPACE, table: RIG_TABLE } },
    ],
    hidden_rig_line: "A game is on in this call.",
    whisper_templates: WHISPER_TEMPLATES,
};
for (const [i, c] of cards.examples.entries()) check("chatCard", c["dev.tinhat.game"], `cards.examples[${i}]`);
files.set("cards.json", J(cards));

// ---- malformed: views/frames an app MUST reject (mutations of valid fixtures)
const mut = (x, f) => { const y = JSON.parse(JSON.stringify(x)); f(y); return y; };
const hv = steps.find((s) => s.game === "holdem" && s.id === "03-preflop-raised").views.seat1;
const rv = rigEx.views.cy;
const malformed = {
    about: "Each must FAIL the schema (and an app's view parser). A valid fixture with one thing broken.",
    cases: [
        { id: "holdem-three-hole-cards", def: "holdemView", value: mut(hv, (v) => { v.you.cards.push("2c"); }) },
        { id: "holdem-bad-card", def: "holdemView", value: mut(hv, (v) => { v.you.cards[0] = "1s"; }) },
        { id: "holdem-seat-9", def: "holdemView", value: mut(hv, (v) => { v.seats[0].seat = 9; }) },
        { id: "holdem-vseq-0", def: "holdemView", value: mut(hv, (v) => { v.vseq = 0; }) },
        { id: "holdem-unknown-status", def: "holdemView", value: mut(hv, (v) => { v.status = "dealing"; }) },
        { id: "holdem-deadline-string", def: "holdemView", value: mut(hv, (v) => { v.hand.to_act.deadline = String(v.hand.to_act.deadline); }) },
        { id: "holdem-negative-stack", def: "holdemView", value: mut(hv, (v) => { v.seats[1].stack = -1; }) },
        { id: "holdem-missing-table", def: "holdemView", value: mut(hv, (v) => { delete v.table; }) },
        { id: "holdem-unsafe-integer", def: "holdemView", value: mut(hv, (v) => { v.now = 2 ** 53; }) },
        { id: "holdem-fractional-chips", def: "holdemView", value: mut(hv, (v) => { v.seats[0].stack = 2.5; }) },
        { id: "rig-unknown-phase", def: "rigView", value: mut(rv, (v) => { v.round.phase = "dance"; }) },
        { id: "rig-four-reels", def: "rigView", value: mut(rv, (v) => { v.round.history[0].reels.push("hat"); }) },
        { id: "rig-unknown-symbol", def: "rigView", value: mut(rv, (v) => { v.round.history[0].reels[0] = "star"; }) },
        { id: "rig-unknown-card", def: "rigView", value: mut(rv, (v) => { v.round.board[0].card = "joker"; }) },
        { id: "rig-unknown-role", def: "rigView", value: mut(rv, (v) => { v.you.role = "dealer"; }) },
        { id: "rig-dial-4", def: "rigView", value: mut(rv, (v) => { v.round.dial = 4; }) },
        { id: "rig-whisper-61", def: "rigView", value: mut(rigEx.views.ben, (v) => { v.you.whispers[1].text = "x".repeat(61); }) },
        { id: "rig-sharp-with-card", def: "rigView", value: mut(rigEx.views.ana, (v) => { v.you.card = { card: "skim", bite: 2 }; }) },
        { id: "rig-board-owner-on-open-card", def: "rigView", value: mut(rv, (v) => { v.round.board.find((b) => b.state === "open").owner = P.dee; }) },
        { id: "holdem-no-space", def: "holdemView", value: mut(hv, (v) => { delete v.space; }) },
        { id: "rank-frame-no-space", def: "serverFrame", value: { t: "rank", u: P.dee, rank: 3 } },
        { id: "chat-card-no-space", def: "chatCard", value: { v: 1, kind: "invite", game: "holdem", server: OWNER, table: HOLDEM_TABLE } },
        { id: "frame-ack-unknown-code", def: "serverFrame", value: { t: "ack", op: "op-7f3a9c21b4d0e855", ok: false, code: "nope", dup: false } },
        { id: "frame-act-short-op", def: "clientFrame", value: { t: "act", table: HOLDEM_TABLE, op: "short", a: { do: "fold" } } },
        { id: "frame-sit-without-space", def: "clientFrame", value: { t: "act", table: HOLDEM_TABLE, op: "op-a1b2c3d4e5f60718", a: { do: "sit", seat: 3 } } },
        { id: "frame-fold-without-at", def: "clientFrame", value: { t: "act", table: HOLDEM_TABLE, op: "op-a1b2c3d4e5f60718", a: { do: "fold" } } },
        { id: "frame-deal-with-at", def: "clientFrame", value: { t: "act", table: HOLDEM_TABLE, op: "op-a1b2c3d4e5f60718", at: { hand: 1, turn: 1 }, a: { do: "deal" } } },
        { id: "frame-rig-move-on-holdem-table", def: "clientFrame", value: { t: "act", table: HOLDEM_TABLE, op: "op-a1b2c3d4e5f60718", at: { round: 1, spin: 1, phase: "turn" }, a: { do: "spin" } } },
        { id: "frame-whisper-text-and-template", def: "clientFrame", value: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627d", at: { round: 2, spin: 5, phase: "turn" }, a: { do: "whisper", template: "bet-size", text: "x" } } },
        { id: "frame-market-pass-with-stake", def: "clientFrame", value: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627a", at: { round: 1, spin: 0, phase: "setup" }, a: { do: "market", side: "pass", stake: 1 } } },
        { id: "me-earned-201", def: "me", value: { ...meEx, earned_today: 201 } }, // v1.1: the day max goes to 200
        { id: "frame-act-bad-step", def: "clientFrame", value: { t: "act", table: RIG_TABLE, op: "op-0c1d2e3f4051627c", at: { round: 2, spin: 5, phase: "nudge" }, a: { do: "nudge", reel: 3, step: 2 } } },
    ],
};
malformed.tolerated = [
    { id: "unknown-frame-type", def: "serverFrame", why: "a later server may add frame types: ignore it", value: { t: "hint", v: 1 } },
    { id: "unknown-view-field", def: "holdemView", why: "a later server may add fields: ignore them (the v1 server never sends one: its tests check the strict schema)", value: mut(hv, (v) => { v.theme = "felt"; }) },
    { id: "unknown-seat-field", def: "holdemView", why: "as above, nested", value: mut(hv, (v) => { v.seats[0].badge = "pit-boss"; }) },
];
for (const c of malformed.cases) {
    if (validate(SCHEMA, { $ref: `#/$defs/${c.def}` }, c.value).length === 0) problems.push(`malformed ${c.id} PASSES the schema (it must fail)`);
}
for (const c of malformed.tolerated) {
    if (validate(SCHEMA, { $ref: `#/$defs/${c.def}` }, c.value).length === 0) problems.push(`tolerated ${c.id} passes the strict schema (it must fail there: apps tolerate it, the server never sends it)`);
}
files.set("malformed.json", J(malformed));
files.set("schema.json", J(SCHEMA));
files.set("README.md", readFileSync(fileURLToPath(new URL("./README.views.md", import.meta.url)), "utf8"));

if (problems.length) { console.error(problems.join("\n")); console.error(`${problems.length} problem(s): nothing written`); process.exit(1); }
const index = {};
for (const [rel, text] of [...files].sort()) index[rel] = createHash("md5").update(text).digest("hex");
files.set("INDEX.json", J({ v: 1, about: "md5 of every file in this folder (byte-identical in every repo that copies it)", files: index }));
for (const [rel, text] of files) {
    const p = join(out, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
}
console.log(`wrote ${files.size} files to ${out} (${steps.length} steps, ${malformed.cases.length} malformed cases)`);
