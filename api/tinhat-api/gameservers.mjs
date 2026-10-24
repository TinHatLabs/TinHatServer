// gameservers.mjs — the Game servers widget's server side (Tin Hat 11.1, 2026-09-28; contract docs/GAMESERVERS.md,
// identical in both app repos). The ONE path from Tin Hat to the owner's Pelican panel: clients never talk to the
// panel, and the panel credential (a least-privilege subuser's client API key, restricted to this host's address) never
// leaves this process.
//
//   GET  /gameservers/status  Bearer = the caller's Matrix token → every configured server: state, uptime, CPU, memory,
//                             players (best effort), the join address + the join password, a line of info, whether
//                             friends outside can reach it, the cap, whether the caller may manage, the announcements
//                             room. 401 without a token, 403 {code:"not-member"} for anyone not joined to the governing
//                             space. The panel is asked at most every 10 s, whoever asks.
//   POST /gameservers/power   {server, action: "start"|"stop"|"restart", stopFirst?} — needs `manage_game_servers` in the
//                             governing space's roles (docs/RBAC.md §2, enforcement: server), checked here on EVERY call
//                             from the space's state (Synapse admin API, read-only, like moderation.mjs); a space without
//                             roles falls back to power level 100 there (its owner rank). At most `cap` (2) games at once
//                             and the memory limits must fit `memoryBudgetMB`; `stopFirst` stops that game, waits until it
//                             is offline, then starts `server` (a background job; 202). Every action is logged (who,
//                             what, when, result) to LOG_FILE.
//
// Players come from the servers' own console through the panel's websocket (Wings), one persistent socket per RUNNING
// server while anyone looked in the last 10 minutes: the panel hands out at most 5 websocket tokens a minute PER SERVER
// to everybody together, so a token is fetched only on connect and when Wings says it is expiring (≥ 30 s apart). The
// console ECHOES THE STARTUP COMMAND (admin passwords included) — lines are parsed in memory for the player list only,
// a line mentioning a password is dropped on arrival, and no console line is ever logged or sent anywhere.
//
// The join password: a strict allow-list names the ONE startup variable per game kind (KINDS); games that keep it in a
// config file the bot may not read (Project Zomboid) take it from this server's config (`joinPasswordText`). Nothing
// else of the startup variables leaves this file.
//
// Config: gameservers.json next to this file (mode 600: it can hold a join password), re-read when it changes (no
// restart). Pelican key: pelican.key next to it (mode 600). No npm dependency; Node ≥ 22 (global WebSocket, fetch).
import { readFileSync, statSync, appendFileSync } from "node:fs";
import { RateLimit, readJson, safe, noStore, isObj, mono, wall, UNSAFE_TEXT } from "./reachcommon.mjs";

export const GS = Object.freeze({
    PERM: "manage_game_servers",
    OWNER_RANK: 100,              // no roles in the space: power level 100 (the owner rank) manages
    SNAP_TTL_MS: 10_000,          // the panel is asked at most this often
    STALE_MAX_MS: 5 * 60_000,     // a failed refresh serves the last snapshot (stale: true) this long
    LIST_TTL_MS: 60_000,          // the server list (names, limits, ports, the password variable)
    SCHED_TTL_MS: 5 * 60_000,     // schedules (the next backup / restart)
    SPACE_TTL_MS: 10_000,         // the governing space's state (membership, roles)
    CONFIG_CHECK_MS: 5_000,       // how often the config file's mtime is looked at
    WANTED_MS: 10 * 60_000,       // player trackers run while someone asked this recently
    TOKEN_GAP_MS: 30_000,         // ≥ this between websocket tokens for one server (panel: 5/min/server, shared)
    RECONNECT_MS: [30_000, 60_000, 120_000, 300_000],
    REPLAY_QUIET_MS: 700,         // "send logs" replay: done after this long without a line …
    REPLAY_MAX_MS: 5_000,         // … or this long after it began, whatever comes first
    BUFFER_LINES: 2000,           // console lines kept per running server (memory only)
    LINE_MAX: 600,
    PENDING_MAX_MS: 3 * 60_000,   // a power action shows as pending until its goal state, at most this long
    SWITCH_STOP_WAIT_MS: 11 * 60_000, // stopFirst: wait this long for the first game to go offline (Wings kills a
                                      // server that ignores its stop command after 10 min: seen on Abiotic Factor)
    SWITCH_POLL_MS: 3_000,
    JOB_KEEP_MS: 5 * 60_000,      // a finished switch job stays in the status this long
    STATUS_PER_MIN: 40,           // per user
    POWER_PER_MIN: 10,            // per user
    STATUS_GLOBAL_PER_MIN: 1200,
    BODY_MAX: 2048,
    PANEL_TIMEOUT_MS: 8_000,
    PANEL_PER_MIN: 100,           // every panel call together (the panel allows the bot 120 a minute)
    POWER_FRESH_MS: 2_000,        // a power request plans on a snapshot at most this old (shared by concurrent requests)
});

/** Game kinds: the ONE startup variable that is the join password (null = none / not in the panel) and the console
 *  parser for players (null = none: the widget shows "—"). A server's config names its kind; nothing else may pick a
 *  variable. */
export const KINDS = Object.freeze({
    valheim: Object.freeze({ passwordVar: "PASSWORD", players: "valheim" }),
    pz: Object.freeze({ passwordVar: null, players: "pz" }),               // the join password lives in the server ini
    minecraft: Object.freeze({ passwordVar: null, players: "minecraft" }),
    palworld: Object.freeze({ passwordVar: "SERVER_PASSWORD", players: "palworld" }),
    abiotic: Object.freeze({ passwordVar: "SERVER_PASSWORD", players: null }),
    satisfactory: Object.freeze({ passwordVar: null, players: null }),
    other: Object.freeze({ passwordVar: null, players: null }),            // any other game: no password variable, no player list
});

export const ACTIONS = new Set(["start", "stop", "restart"]);
const ID_RE = /^[0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM_RE = /^![A-Za-z0-9._~=+/-]{1,255}(?::[A-Za-z0-9.-]{1,255}(?::\d{1,5})?)?$/;
const MXID_RE = /^@[^:\s]{1,255}:[A-Za-z0-9.-]{1,255}(?::\d{1,5})?$/;
const STATES = new Set(["running", "starting", "stopping", "offline"]);

// ── config ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);

/** Validate the config text; throws with a readable reason. Unknown keys are ignored. */
export function parseConfig(text) {
    let c;
    try { c = JSON.parse(text); } catch (e) {
        // never the parser's own message: V8 quotes an excerpt of the text, which can hold a join password
        const at = /position (\d+)/.exec(String(e?.message))?.[1];
        throw new Error(`not JSON${at ? ` (near byte ${at})` : ""}`);
    }
    if (!isObj(c) || c.v !== 1) throw new Error("want an object with v: 1");
    if (typeof c.space !== "string" || !ROOM_RE.test(c.space)) throw new Error("space: a room id");
    if (c.announceRoom != null && (typeof c.announceRoom !== "string" || !ROOM_RE.test(c.announceRoom))) throw new Error("announceRoom: a room id or null");
    const panel = isObj(c.panel) ? c.panel : {};
    const cfg = {
        space: c.space,
        announceRoom: c.announceRoom ?? null,
        joinHost: str(c.joinHost, 253),  // the address players type (required: nothing is assumed)
        cap: Number.isInteger(c.cap) && c.cap >= 1 && c.cap <= 8 ? c.cap : 2,
        memoryBudgetMB: Number.isInteger(c.memoryBudgetMB) && c.memoryBudgetMB > 0 ? c.memoryBudgetMB : 30720,
        hostCores: Number.isInteger(c.hostCores) && c.hostCores > 0 && c.hostCores <= 1024 ? c.hostCores : 16,
        panel: {
            url: str(panel.url, 200),        // the panel's own address, as this server reaches it
            wings: str(panel.wings, 200),    // the Wings daemon's websocket (ws://host:8080)
            origin: str(panel.origin, 200),  // the panel's public origin (Wings checks the websocket's Origin)
        },
        servers: [],
        test: [],
    };
    if (!cfg.joinHost || !/^[A-Za-z0-9.-]+$/.test(cfg.joinHost)) throw new Error("joinHost: the host name players connect to");
    for (const k of ["url", "wings", "origin"]) {
        if (!/^(?:https?|wss?):\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(cfg.panel[k])) throw new Error(`panel.${k}: scheme://host[:port]`);
    }
    if (!Array.isArray(c.servers) || c.servers.length === 0 || c.servers.length > 32) throw new Error("servers: 1..32 entries");
    const seen = new Set();
    for (const [i, s] of c.servers.entries()) {
        const at = `servers[${i}]`;
        if (!isObj(s)) throw new Error(`${at}: an object`);
        if (typeof s.uuid !== "string" || !UUID_RE.test(s.uuid)) throw new Error(`${at}.uuid: the panel server uuid`);
        if (seen.has(s.uuid)) throw new Error(`${at}.uuid: listed twice`);
        seen.add(s.uuid);
        if (!Object.prototype.hasOwnProperty.call(KINDS, s.kind)) throw new Error(`${at}.kind: one of ${Object.keys(KINDS).join(", ")}`);
        const game = str(s.game, 64);
        if (!game || !game.trim()) throw new Error(`${at}.game: the game's name (1..64)`);
        if (s.steamAppId != null && !(Number.isInteger(s.steamAppId) && s.steamAppId > 0 && s.steamAppId < 1e9)) throw new Error(`${at}.steamAppId: an integer or null`);
        if (s.joinPasswordText != null) {
            if (KINDS[s.kind].passwordVar !== null) throw new Error(`${at}.joinPasswordText: only for kinds whose password is not a panel variable`);
            if (typeof s.joinPasswordText !== "string" || s.joinPasswordText.length > 64 || UNSAFE_TEXT.test(s.joinPasswordText)) throw new Error(`${at}.joinPasswordText: a short plain string`);
        }
        const info = s.info == null ? "" : str(s.info, 280);
        if (info === null || UNSAFE_TEXT.test(info)) throw new Error(`${at}.info: plain text, ≤ 280`);
        const label = s.label == null ? null : str(s.label, 64);
        if (s.label != null && (!label || !label.trim() || UNSAFE_TEXT.test(label))) throw new Error(`${at}.label: plain text, 1..64`);
        const emoji = s.emoji == null ? null : str(s.emoji, 16);
        if (s.emoji != null && (!emoji || UNSAFE_TEXT.test(emoji))) throw new Error(`${at}.emoji: plain text, ≤ 16`);
        cfg.servers.push({
            uuid: s.uuid,
            kind: s.kind,
            game: game.trim(),
            label: label ? label.trim() : null,
            steamAppId: s.steamAppId ?? null,
            emoji: emoji || null,
            outside: s.outside === true,
            calendar: s.calendar !== false,
            info,
            joinPasswordText: s.joinPasswordText ?? null,
        });
    }
    if (c.test != null) {
        if (!Array.isArray(c.test) || c.test.length > 8) throw new Error("test: an array (≤ 8)");
        for (const [i, t] of c.test.entries()) {
            const at = `test[${i}]`;
            if (!isObj(t) || !Array.isArray(t.users) || t.users.length === 0 || t.users.length > 16) throw new Error(`${at}.users: 1..16 mxids`);
            for (const u of t.users) if (typeof u !== "string" || !MXID_RE.test(u)) throw new Error(`${at}.users: mxids`);
            if (typeof t.space !== "string" || !ROOM_RE.test(t.space)) throw new Error(`${at}.space: a room id`);
            if (t.announceRoom != null && (typeof t.announceRoom !== "string" || !ROOM_RE.test(t.announceRoom))) throw new Error(`${at}.announceRoom: a room id or null`);
            cfg.test.push({ users: new Set(t.users), space: t.space, announceRoom: t.announceRoom ?? null });
        }
    }
    return cfg;
}

// ── console lines → players ──────────────────────────────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** A console line as the parsers see it: ANSI and control characters gone, trimmed, capped — or null when it must
 *  not be kept at all (a line mentioning a password, the container's echo of its startup command, an empty line). */
export function cleanLine(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.replace(ANSI, "").replace(CTRL, "").trim();
    if (!s) return null;
    if (/password|passwd/i.test(s)) return null;
    if (/^:\/home\/container\$/.test(s) || /^container@pterodactyl~/.test(s)) return null;
    return s.length > GS.LINE_MAX ? s.slice(0, GS.LINE_MAX) : s;
}

/** A player name as a game printed it: plain text, ≤ 32 characters, or null. */
export function cleanName(raw) {
    if (typeof raw !== "string") return null;
    let s = raw.replace(ANSI, "");
    s = [...s].filter((ch) => !UNSAFE_TEXT.test(ch)).join("").replace(/\s+/g, " ").trim();
    if (!s) return null;
    const cps = [...s];
    return cps.length > 32 ? cps.slice(0, 32).join("") : s;
}

const MAX_NAMES = 16;
const finish = (names, count) => {
    const n = Math.max(0, count);
    const list = names.length > n ? names.slice(names.length - n) : names;
    return { count: n, names: list.slice(-MAX_NAMES) };
};

const VH_COUNT = /Connections (\d{1,4}) ZDOS/;
const VH_CONN = /Got connection SteamID (\d{5,20})\b/;
const VH_CHAR = /Got character ZDOID from (.+?) : (-?\d+):(-?\d+)\s*$/;
const VH_CLOSE = /Closing socket (\d{5,20})\b/;

/** Valheim: "Connections N ZDOS" (every 10 min) is the count; "Got connection SteamID X" then "Got character ZDOID from
 *  NAME : a:b" is a join (0:0 = a death, not a join); "Closing socket X" is that player leaving. */
function parseValheim(lines) {
    let pendingSteam = null;
    const peers = new Map();           // steam id -> name, in join order
    const loose = [];                  // names seen without their connection line (joined before the window)
    let lastCount = null, joins = 0, leaves = 0;
    for (const line of lines) {
        let m;
        if ((m = VH_COUNT.exec(line))) { lastCount = Number(m[1]); joins = 0; leaves = 0; continue; }
        if ((m = VH_CONN.exec(line))) { pendingSteam = m[1]; continue; }
        if ((m = VH_CHAR.exec(line))) {
            const name = cleanName(m[1]);
            if (!name || (m[2] === "0" && m[3] === "0")) continue;
            if (pendingSteam) {
                if (!peers.has(pendingSteam)) joins += 1;
                peers.delete(pendingSteam);
                peers.set(pendingSteam, name);
                pendingSteam = null;
                const li = loose.indexOf(name);
                if (li >= 0) loose.splice(li, 1);
            } else if (![...peers.values()].includes(name)) {
                const li = loose.indexOf(name);
                if (li >= 0) loose.splice(li, 1);
                loose.push(name);
            }
            continue;
        }
        if ((m = VH_CLOSE.exec(line))) {
            if (pendingSteam === m[1]) pendingSteam = null;   // a refused / aborted attempt: no character came
            if (peers.has(m[1])) { peers.delete(m[1]); leaves += 1; }
        }
    }
    const names = [...loose, ...peers.values()];
    // the periodic count line is the truth (a disconnect can go unlogged); joins / leaves since it adjust it
    const count = lastCount === null ? names.length : lastCount + joins - leaves;
    return finish(names, count);
}

/** A join/leave set: `join` / `leave` regexes whose group 1 is the name. */
function parseSet(lines, join, leave) {
    const on = [];
    for (const line of lines) {
        let m;
        if ((m = join.exec(line))) {
            const n = cleanName(m[1]);
            if (!n) continue;
            const i = on.indexOf(n);
            if (i >= 0) on.splice(i, 1);
            on.push(n);
        } else if ((m = leave.exec(line))) {
            const n = cleanName(m[1]);
            const i = n ? on.indexOf(n) : -1;
            if (i >= 0) on.splice(i, 1);
        }
    }
    return finish(on, on.length);
}

const MC_JOIN = /\]: ([A-Za-z0-9_]{1,16}) joined the game\s*$/;
const MC_LEAVE = /\]: ([A-Za-z0-9_]{1,16}) left the game\s*$/;
const PAL_JOIN = /\[LOG\] (.{1,64}?) joined the server\./;
const PAL_LEAVE = /\[LOG\] (.{1,64}?) left the server\./;
const PZ_CM_JOIN = /ConnectionManager:\s*\[fully-connected\].*?username="([^"]{1,64})"/;
const PZ_CM_LEAVE = /ConnectionManager:\s*\[disconnect\].*?username="([^"]{1,64})"/;
const PZ_EV_JOIN = /message="(?:client-connect|fully-connected)".*?guid="(\d{1,24})".*?username="([^"]{1,64})"/;
const PZ_EV_LEAVE = /message="(?:disconnect|disconnection-notification|connection-lost|receive-disconnect)[^"]*".*?guid="(\d{1,24})"/;

/** Project Zomboid: the ConnectionManager lines (`[fully-connected] … username="X"`, `[disconnect] … username="X"`) or
 *  the connection-event form (`message="client-connect" guid="G" … username="X"`, a leave by guid). A build whose
 *  console prints neither (42.20 writes them only to Zomboid/Logs) gives null: unknown, not "nobody". */
function parsePz(lines) {
    const on = [];
    const byGuid = new Map();
    let seen = false;
    const add = (n) => { const i = on.indexOf(n); if (i >= 0) on.splice(i, 1); on.push(n); };
    const drop = (n) => { const i = on.indexOf(n); if (i >= 0) on.splice(i, 1); };
    for (const line of lines) {
        let m;
        if ((m = PZ_CM_JOIN.exec(line))) { seen = true; const n = cleanName(m[1]); if (n) add(n); }
        else if ((m = PZ_CM_LEAVE.exec(line))) { seen = true; const n = cleanName(m[1]); if (n) drop(n); }
        else if ((m = PZ_EV_JOIN.exec(line))) { seen = true; const n = cleanName(m[2]); if (n) { byGuid.set(m[1], n); add(n); } }
        else if ((m = PZ_EV_LEAVE.exec(line))) { seen = true; const n = byGuid.get(m[1]); if (n) { byGuid.delete(m[1]); drop(n); } }
    }
    return seen ? finish(on, on.length) : null;
}

/** Players of a game kind from its console lines (already cleaned): {count, names} or null (no parser / no data). */
export function parsePlayers(kind, lines) {
    const p = KINDS[kind]?.players;
    if (!p || !Array.isArray(lines) || lines.length === 0) return null;
    if (p === "valheim") return parseValheim(lines);
    if (p === "pz") return parsePz(lines);
    if (p === "minecraft") return parseSet(lines, MC_JOIN, MC_LEAVE);
    if (p === "palworld") return parseSet(lines, PAL_JOIN, PAL_LEAVE);
    return null;
}

/** Append `batch` (a "send logs" replay: the log's tail, then anything newer) to `buf` without repeating the lines the
 *  buffer already ends with; keeps the last `max`. */
export function mergeTail(buf, batch, max = GS.BUFFER_LINES) {
    const n = buf.length, m = batch.length;
    let k = Math.min(n, m);
    for (; k > 0; k--) {
        let same = true;
        for (let i = 0; i < k; i++) if (buf[n - k + i] !== batch[i]) { same = false; break; }
        if (same) break;
    }
    const out = buf.concat(batch.slice(k));
    return out.length > max ? out.slice(out.length - max) : out;
}

// ── roles (the client's roles_model, as moderation.mjs reads it) ─────────────────────────────────────────────────────

const ROLE_TYPE = "dev.tinhat.role";
const MEMBER_ROLES_TYPE = "dev.tinhat.member_roles";

/** Who the governing space says the caller is: {member, canManage}. `state` = the admin API's state events. */
export function governance(state, mxid) {
    const member = state.some((e) => e.type === "m.room.member" && e.state_key === mxid && e.content?.membership === "join");
    if (!member) return { member: false, canManage: false };
    const roles = new Map();
    for (const e of state) {
        if (e.type !== ROLE_TYPE || !isObj(e.content) || !e.content.name) continue;
        roles.set(e.state_key, new Set(Array.isArray(e.content.permissions) ? e.content.permissions.map(String) : []));
    }
    if (roles.has("everyone")) {
        if (roles.get("everyone").has(GS.PERM)) return { member, canManage: true };
        const mine = state.find((e) => e.type === MEMBER_ROLES_TYPE && e.state_key === mxid.slice(1))?.content?.roles;
        const canManage = Array.isArray(mine) && mine.some((id) => roles.get(String(id))?.has(GS.PERM));
        return { member, canManage };
    }
    const pl = state.find((e) => e.type === "m.room.power_levels" && e.state_key === "")?.content || {};
    const users = isObj(pl.users) ? pl.users : {};
    const level = Object.prototype.hasOwnProperty.call(users, mxid) ? Number(users[mxid]) : Number(pl.users_default ?? 0);
    return { member, canManage: (Number.isFinite(level) ? level : 0) >= GS.OWNER_RANK };
}

// ── the power rules ──────────────────────────────────────────────────────────────────────────────────────────────────

const gb = (mb) => {
    const t = Math.round((mb / 1024) * 10) / 10;
    return `${Number.isInteger(t) ? t : t.toFixed(1)} GB`;
};
/** A server takes memory (and a place in the cap) unless it is offline with nothing queued for it. */
const isActive = (s) => s.state !== "offline" || s.pending?.action === "start" || s.pending?.action === "restart";

/**
 * May `action` run on `target` now? `servers` = the snapshot entries ({id, name, state, unavailable, memoryLimitMB,
 * pending}). {ok: true} or {ok: false, status, code, error, …}. Pure; the texts are what the clients show.
 */
export function planPower({ servers, target, action, stopFirst = null, cap, budgetMB }) {
    const t = servers.find((s) => s.id === target);
    if (!t) return { ok: false, status: 404, code: "unknown", error: "No such game server" };
    if (stopFirst != null && action !== "start") return { ok: false, status: 400, code: "bad-request", error: "stopFirst goes with start only" };
    if (t.pending) return { ok: false, status: 409, code: "busy", error: `${t.name} is busy — try again in a moment` };
    if (action === "stop") {
        if (t.state === "offline") return { ok: false, status: 409, code: "already", error: `${t.name} isn't running` };
        if (t.state === "stopping") return { ok: false, status: 409, code: "already", error: `${t.name} is already stopping` };
        return { ok: true };
    }
    if (action === "restart") {
        if (t.state === "running") return { ok: true };
        if (t.state === "offline") return { ok: false, status: 409, code: "not-running", error: `${t.name} isn't running — start it instead` };
        return { ok: false, status: 409, code: "busy", error: `${t.name} is ${t.state} — try again in a moment` };
    }
    // start
    if (t.unavailable) return { ok: false, status: 409, code: "unavailable", error: `${t.name} can't start right now (${t.unavailable})` };
    if (t.state !== "offline") return { ok: false, status: 409, code: "already", error: t.state === "stopping" ? `${t.name} is still stopping — try again in a moment` : `${t.name} is already running` };
    let first = null;
    if (stopFirst != null) {
        first = servers.find((s) => s.id === stopFirst);
        if (!first) return { ok: false, status: 404, code: "unknown", error: "No such game server" };
        if (first.id === t.id) return { ok: false, status: 400, code: "bad-request", error: "stopFirst must be another server" };
        if (first.pending) return { ok: false, status: 409, code: "busy", error: `${first.name} is busy — try again in a moment` };
        if (first.state === "offline") return { ok: false, status: 409, code: "not-running", error: `${first.name} isn't running` };
    }
    const active = servers.filter((s) => s.id !== t.id && (!first || s.id !== first.id) && isActive(s));
    if (active.length >= cap) {
        return {
            ok: false, status: 409, code: "cap",
            error: `${cap === 2 ? "Two" : cap} game${cap === 1 ? " is" : "s are"} already running — stop one first`,
            running: active.map((s) => s.id),
        };
    }
    const lim = (s) => (s.memoryLimitMB > 0 ? s.memoryLimitMB : budgetMB);
    const used = active.reduce((a, s) => a + lim(s), 0);
    const free = Math.max(0, budgetMB - used);
    if (used + lim(t) > budgetMB) {
        return {
            ok: false, status: 409, code: "memory",
            error: `${t.name} needs ${gb(lim(t))} and only ${gb(free)} is free — stop a game first`,
            needMB: lim(t), freeMB: free,
        };
    }
    return first ? { ok: true, stopFirst: first.id } : { ok: true };
}

// ── the panel (Pelican client API, as the bot) ───────────────────────────────────────────────────────────────────────

export function createPanel({ url, key, fetchImpl = fetch, timeoutMs = GS.PANEL_TIMEOUT_MS }) {
    async function call(method, path, body) {
        const headers = { Authorization: `Bearer ${key()}`, Accept: "application/json" };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const r = await fetchImpl(url + path, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await r.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!r.ok) {
            const e = new Error(`panel ${method} ${path.split("?")[0].replace(/[0-9a-f]{8}(?=\/|$)/, "<id>")} said ${r.status}`);
            e.status = r.status;
            throw e;
        }
        return json;
    }
    return {
        list: async () => {   // every page (100 a page; the config names at most 32 of them, anywhere in the list)
            const first = await call("GET", "/api/client?per_page=100");
            const pages = Math.min(Number(first?.meta?.pagination?.total_pages) || 1, 10);
            const data = Array.isArray(first?.data) ? [...first.data] : [];
            for (let p = 2; p <= pages; p++) {
                const more = await call("GET", `/api/client?per_page=100&page=${p}`);
                if (Array.isArray(more?.data)) data.push(...more.data);
            }
            return { ...first, data };
        },
        resources: (id) => call("GET", `/api/client/servers/${id}/resources`),
        schedules: (id) => call("GET", `/api/client/servers/${id}/schedules`),
        power: (id, signal) => call("POST", `/api/client/servers/${id}/power`, { signal }),
        wsToken: (id) => call("GET", `/api/client/servers/${id}/websocket`),
    };
}

/** The panel's server list → uuid → {id, name, memoryMB, cpuLimit, port, unavailable, password(kind)}. Only the ONE
 *  allow-listed variable of each configured kind is read; every other variable is dropped here. */
export function readList(json, cfg) {
    const out = new Map();
    const kindOf = new Map(cfg.servers.map((s) => [s.uuid, s.kind]));
    for (const item of Array.isArray(json?.data) ? json.data : []) {
        const a = item?.attributes;
        if (!isObj(a) || typeof a.uuid !== "string" || !kindOf.has(a.uuid) || typeof a.identifier !== "string" || !ID_RE.test(a.identifier)) continue;
        const allocs = Array.isArray(a.relationships?.allocations?.data) ? a.relationships.allocations.data : [];
        const primary = allocs.map((x) => x?.attributes).find((x) => isObj(x) && x.is_default) || allocs[0]?.attributes;
        const pv = KINDS[kindOf.get(a.uuid)].passwordVar;
        let password = null;
        if (pv) {
            const v = (Array.isArray(a.relationships?.variables?.data) ? a.relationships.variables.data : [])
                .map((x) => x?.attributes).find((x) => isObj(x) && x.env_variable === pv);
            const val = v ? (v.server_value ?? v.default_value) : null;
            password = typeof val === "string" && val.length > 0 && val.length <= 128 ? val : null;
        }
        const st = typeof a.status === "string" ? a.status : null;
        out.set(a.uuid, {
            id: a.identifier,
            name: typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 64) : a.identifier,
            memoryMB: Number.isFinite(Number(a.limits?.memory)) ? Math.max(0, Math.round(Number(a.limits.memory))) : 0,
            cpuLimit: Number.isFinite(Number(a.limits?.cpu)) ? Math.max(0, Math.round(Number(a.limits.cpu))) : 0,
            port: Number.isInteger(primary?.port) ? primary.port : null,
            unavailable: a.is_transferring ? "moving" : st === "suspended" || a.is_suspended ? "suspended"
                : st === "installing" || st === "install_failed" || st === "reinstall_failed" || a.is_installing ? "installing"
                : st === "restoring_backup" ? "restoring a backup" : null,
            password,
        });
    }
    return out;
}

/** The next backup / restart a server's schedules will run: {what, at} or null. */
export function nextSchedule(json, online, nowWall) {
    let best = null;
    for (const item of Array.isArray(json?.data) ? json.data : []) {
        const a = item?.attributes;
        if (!isObj(a) || a.is_active !== true) continue;
        if (a.only_when_online === true && !online) continue;
        const at = Date.parse(a.next_run_at);
        if (!Number.isFinite(at) || at <= nowWall) continue;
        const tasks = (Array.isArray(a.relationships?.tasks?.data) ? a.relationships.tasks.data : []).map((x) => x?.attributes).filter(isObj);
        const what = tasks.some((t) => t.action === "power" && t.payload === "restart") ? "restart"
            : tasks.some((t) => t.action === "backup") ? "backup" : null;
        if (!what) continue;
        if (!best || at < best.at) best = { what, at };
    }
    return best;
}

// ── a player tracker: one websocket per running server ───────────────────────────────────────────────────────────────

class Tracker {
    constructor(id, kind, deps) {
        this.id = id; this.kind = kind; this.d = deps;
        this.active = false; this.ws = null; this.lines = []; this.version = 0; this.gotLogs = false;
        this.replay = null; this.replayTimer = null; this.replayDeadline = 0; this.retry = 0; this.timer = null;
        this.memo = { version: -1, value: null }; this.sentLogs = false;
    }
    start() { if (this.active) return; this.active = true; this.connect(); }
    stop() {
        this.active = false;
        clearTimeout(this.timer); clearTimeout(this.replayTimer); this.timer = null; this.replayTimer = null;
        const ws = this.ws; this.ws = null;
        try { ws?.close(); } catch { /* already gone */ }
        this.lines = []; this.version += 1; this.gotLogs = false; this.replay = null; this.sentLogs = false;
    }
    later(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.connect(); }, ms);
        this.timer.unref?.();
    }
    backoff() {
        const ms = GS.RECONNECT_MS[Math.min(this.retry, GS.RECONNECT_MS.length - 1)];
        this.retry += 1;
        if (this.active) this.later(ms);
    }
    async token() {
        // the cooldown is per SERVER and outlives this tracker (a stop / start must not reset it: the panel's 5 tokens a
        // minute per server are shared with everybody)
        const wait = this.d.lastToken(this.id) + GS.TOKEN_GAP_MS - this.d.now();
        if (wait > 0) return { wait };
        this.d.setLastToken(this.id, this.d.now());
        const j = await this.d.panel.wsToken(this.id);
        const token = j?.data?.token, socket = j?.data?.socket;
        if (typeof token !== "string" || typeof socket !== "string") throw new Error("no websocket token");
        const path = new URL(socket).pathname;
        if (!/^\/api\/servers\/[0-9a-f-]{36}\/ws$/.test(path)) throw new Error("unexpected websocket path");
        return { token, path };
    }
    async connect() {
        if (!this.active || this.ws) return;
        let t;
        try { t = await this.token(); } catch (e) { this.d.log(`[gameservers] ${this.id}: websocket token failed (${e.message})`); this.backoff(); return; }
        if (t.wait) { this.later(t.wait); return; }
        if (!this.active || this.ws) return;
        let ws;
        try { ws = new this.d.WebSocketImpl(this.d.wings + t.path, { headers: { Origin: this.d.origin } }); } catch (e) {
            this.d.log(`[gameservers] ${this.id}: websocket failed (${e.message})`); this.backoff(); return;
        }
        this.ws = ws; this.sentLogs = false;
        const guard = (fn) => (ev) => { try { fn(ev); } catch (e) { this.d.log(`[gameservers] ${this.id}: socket handler error (${e.message})`); } };
        ws.onopen = guard(() => ws.send(JSON.stringify({ event: "auth", args: [t.token] })));
        ws.onmessage = guard((ev) => this.onMessage(ws, ev));
        ws.onerror = guard(() => { /* close follows */ });
        ws.onclose = guard(() => {
            if (this.ws !== ws) return;
            this.ws = null;
            if (this.active) this.backoff();
        });
    }
    async renew(ws) {
        let t;
        try { t = await this.token(); } catch (e) { this.d.log(`[gameservers] ${this.id}: token renewal failed (${e.message})`); try { ws.close(); } catch { /* */ } return; }
        if (t.wait) { const tm = setTimeout(() => { if (this.ws === ws) this.renew(ws).catch(() => {}); }, t.wait); tm.unref?.(); return; }
        if (this.ws === ws) ws.send(JSON.stringify({ event: "auth", args: [t.token] }));
    }
    onMessage(ws, ev) {
        if (this.ws !== ws) return;
        const text = typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
        if (text.length > 64 * 1024) return;
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (!isObj(msg) || typeof msg.event !== "string") return;
        const arg = Array.isArray(msg.args) ? msg.args[0] : undefined;
        switch (msg.event) {
            case "auth success":
                this.retry = 0;
                if (!this.sentLogs) {
                    this.sentLogs = true;
                    this.replay = [];
                    this.replayDeadline = this.d.now() + GS.REPLAY_MAX_MS;
                    this.armReplay();
                    ws.send(JSON.stringify({ event: "send logs", args: [null] }));
                }
                break;
            case "console output": {
                const line = cleanLine(arg);
                if (line === null) break;
                if (this.replay) {
                    this.replay.push(line);
                    if (this.replay.length > GS.BUFFER_LINES) this.replay.splice(0, this.replay.length - GS.BUFFER_LINES);
                    this.armReplay();
                } else this.push(line);
                break;
            }
            case "token expiring":
            case "token expired":
                this.renew(ws).catch(() => {});
                break;
            case "status":
                if (arg === "offline" || arg === "stopping") { this.lines = []; this.version += 1; this.gotLogs = false; }
                this.d.onState?.(this.id, arg);
                break;
            case "jwt error":
                try { ws.close(); } catch { /* */ }
                break;
            default:
                break;
        }
    }
    /** The replay ends after REPLAY_QUIET_MS without a line, and at the latest REPLAY_MAX_MS after it began (a console
     *  that never pauses can't keep it open, and it never holds more than BUFFER_LINES). */
    armReplay() {
        clearTimeout(this.replayTimer);
        const wait = Math.max(0, Math.min(GS.REPLAY_QUIET_MS, this.replayDeadline - this.d.now()));
        this.replayTimer = setTimeout(() => this.endReplay(), wait);
        this.replayTimer.unref?.();
    }
    endReplay() {
        clearTimeout(this.replayTimer);
        this.replayTimer = null;
        const batch = this.replay || [];
        this.replay = null;
        this.lines = mergeTail(this.lines, batch);
        this.version += 1; this.gotLogs = true;
    }
    push(line) {
        this.lines.push(line);
        // trimmed in batches: one copy per BUFFER_LINES lines, never one per line
        if (this.lines.length > 2 * GS.BUFFER_LINES) this.lines = this.lines.slice(this.lines.length - GS.BUFFER_LINES);
        this.version += 1; this.gotLogs = true;
    }
    players() {
        if (!this.gotLogs) return null;
        if (this.memo.version !== this.version) {
            const lines = this.lines.length > GS.BUFFER_LINES ? this.lines.slice(this.lines.length - GS.BUFFER_LINES) : this.lines;
            this.memo = { version: this.version, value: parsePlayers(this.kind, lines) };
        }
        return this.memo.value;
    }
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A one-lane lock: planning + reserving a power action never interleave (two starts can't both pass the cap). */
function mutex() {
    let tail = Promise.resolve();
    return (fn) => {
        const run = tail.then(fn, fn);
        tail = run.then(() => {}, () => {});
        return run;
    };
}

/**
 * deps: { auth (reachcommon createMatrixAuth), hs (createHs: the pinned internal homeserver), adminToken,
 *         configPath | configText (tests), keyPath | key (tests), panel? (tests), fetchImpl?, WebSocketImpl?,
 *         now? (mono), wallNow?, log?, logFile? (null = none) }
 */
export function createGameServers(deps) {
    const { auth, hs, adminToken } = deps;
    const now = deps.now || mono;
    const wallNow = deps.wallNow || wall;
    const log = deps.log || ((s) => console.log(s));
    const logFile = deps.logFile === undefined ? "/var/log/tinhat-gameservers.log" : deps.logFile;
    /** The action log: validated fields only (ids, actions, mxids, fixed words, server names from the config/panel). */
    const record = (line) => {
        const safeLine = String(line).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
        log(`[gameservers] ${safeLine}`);
        if (logFile) { try { appendFileSync(logFile, `${new Date(wallNow()).toISOString()} ${safeLine}\n`, { mode: 0o640 }); } catch (e) { log(`[gameservers] log file: ${e.message}`); } }
    };

    // ── config: re-read when the file changes; a broken file keeps the last good one; a missing file = off ──
    // every (re)load is a new version: a snapshot is only ever served under the version it was built for, and a request
    // authorises and reads under ONE version (a reload between the two answers "reloading", never the old servers)
    let snap = null, snapAt = -Infinity, inflight = null, failAt = -Infinity;
    let cfg = null, cfgMtime = -1, cfgCheckedAt = -Infinity, listCache = null, cfgVersion = 0;
    let keyCache = null, keyAt = -Infinity;
    let onAdopt = null;   // set once the trackers exist: a new config restarts them (Wings, Origin or a kind may differ)
    // A new config re-reads the key too: the dashboard writes both when the panel changes, and the old key must never
    // go to a new panel address (it was cached for a minute).
    const adopt = (next) => { cfgVersion += 1; next.version = cfgVersion; cfg = next; listCache = null; snap = null; snapAt = -Infinity;
        keyCache = null; keyAt = -Infinity; onAdopt?.(); };
    function config() {
        if (deps.configText !== undefined) { if (!cfg) adopt(parseConfig(deps.configText)); return cfg; }
        if (cfg && now() - cfgCheckedAt < GS.CONFIG_CHECK_MS) return cfg;
        cfgCheckedAt = now();
        let m;
        try { m = statSync(deps.configPath).mtimeMs; } catch (e) {
            if (cfg) record(`config gone (${e.code || "unreadable"}) — game servers OFF until it is back`);
            cfg = null; cfgMtime = -1; listCache = null; snap = null; snapAt = -Infinity;
            throw new Error(`no config (${e.code || "unreadable"})`);
        }
        if (m === cfgMtime && cfg) return cfg;
        try {
            const next = parseConfig(readFileSync(deps.configPath, "utf8"));
            const first = !cfg;
            adopt(next); cfgMtime = m;
            record(`config ${first ? "loaded" : "reloaded"}: ${cfg.servers.length} servers, space ${cfg.space}, cap ${cfg.cap}, budget ${cfg.memoryBudgetMB} MB${cfg.test.length ? `, ${cfg.test.length} test override(s)` : ""}`);
        } catch (e) {
            if (m !== cfgMtime) { cfgMtime = m; record(`config NOT ${cfg ? "reloaded" : "loaded"} (${e.message})${cfg ? " — keeping the previous one" : ""}`); }
            if (!cfg) throw e;
        }
        return cfg;
    }
    const key = () => {
        if (deps.key !== undefined) return deps.key;
        if (keyCache && now() - keyAt < 60_000) return keyCache;
        const k = readFileSync(deps.keyPath, "utf8").trim();
        if (!k) throw new Error("empty panel key");
        keyCache = k; keyAt = now();
        return k;
    };

    // ── the panel, behind ONE budget for every call (the bot may make 120 a minute; we stay under PANEL_PER_MIN) ──
    const budget = new RateLimit(GS.PANEL_PER_MIN, 60_000, now);
    let panelObj = null, panelUrl = null;
    function rawPanel() {
        if (deps.panel) return deps.panel;
        const u = config().panel.url;
        if (!panelObj || panelUrl !== u) { panelObj = createPanel({ url: u, key, fetchImpl: deps.fetchImpl || fetch }); panelUrl = u; }
        return panelObj;
    }
    const spend = () => { if (!budget.hit("all")) throw new Error("panel call budget spent"); };
    const panel = {
        list: async () => { spend(); return rawPanel().list(); },
        resources: async (id) => { spend(); return rawPanel().resources(id); },
        schedules: async (id) => { spend(); return rawPanel().schedules(id); },
        power: async (id, signal) => { spend(); return rawPanel().power(id, signal); },
        wsToken: async (id) => { spend(); return rawPanel().wsToken(id); },
    };

    // ── the governing space (admin API; one read per space at a time, cached; a failure answers fast for 5 s) ──
    const spaceCache = new Map();   // space id -> {exp, state | null, fail?}
    const spaceInflight = new Map();
    async function spaceState(spaceId) {
        const hit = spaceCache.get(spaceId);
        if (hit && hit.exp > now()) { if (hit.fail) throw new Error(hit.fail); return hit.state; }
        if (spaceInflight.has(spaceId)) return spaceInflight.get(spaceId);
        const p = (async () => {
            try {
                const r = await hs.get(`/_synapse/admin/v1/rooms/${encodeURIComponent(spaceId)}/state`, adminToken);
                let state;
                if (r.status === 404) state = null;
                else if (!r.ok) throw new Error(`space state said ${r.status}`);
                else state = Array.isArray(r.body?.state) ? r.body.state : [];
                spaceCache.set(spaceId, { exp: now() + GS.SPACE_TTL_MS, state });
                return state;
            } catch (e) {
                spaceCache.set(spaceId, { exp: now() + 5_000, state: null, fail: e.message });
                throw e;
            } finally {
                spaceInflight.delete(spaceId);
                if (spaceCache.size > 32) spaceCache.delete(spaceCache.keys().next().value);
            }
        })();
        spaceInflight.set(spaceId, p);
        return p;
    }
    async function whoIs(mxid, c = config()) {
        const t = c.test.find((x) => x.users.has(mxid));
        const space = t ? t.space : c.space;
        const announceRoom = t ? t.announceRoom : c.announceRoom;
        const state = await spaceState(space);
        const g = state ? governance(state, mxid) : { member: false, canManage: false };
        return { ...g, space, announceRoom, test: !!t };
    }

    // ── the snapshot ──
    const schedCache = new Map();   // id -> {at, json}
    const pending = new Map();      // server id -> {action, by, since (mono), sinceWall, queued?, job?}
    let job = null;                 // the latest switch: {id, from, to, by, since, sinceWall, step, ok?, error?, endedAt?}
    let jobSeq = 0;
    const liveJobs = new Set();     // ids of the switches still running (each keeps its reservations)
    let lastWanted = -Infinity;
    const trackers = new Map();     // server id -> Tracker
    onAdopt = () => { for (const [id, tr] of trackers) { tr.stop(); trackers.delete(id); } };
    const tokenAt = new Map();      // server id -> when its last websocket token was fetched (outlives the trackers)
    const WebSocketImpl = deps.WebSocketImpl === undefined ? globalThis.WebSocket : deps.WebSocketImpl;
    const missingLogged = new Set();

    async function list() {
        const c = config();
        if (listCache && now() - listCache.at < GS.LIST_TTL_MS) return listCache.map;
        const map = readList(await panel.list(), c);
        for (const sc of c.servers) {
            if (!map.has(sc.uuid) && !missingLogged.has(sc.uuid)) { missingLogged.add(sc.uuid); record(`configured server ${sc.uuid.slice(0, 8)} is not in the panel's list (starts are refused until it is back or out of the config)`); }
        }
        listCache = { at: now(), map };
        return map;
    }
    async function schedulesOf(id) {
        const hit = schedCache.get(id);
        if (hit && now() - hit.at < GS.SCHED_TTL_MS) return hit.json;
        try {
            const json = await panel.schedules(id);
            schedCache.set(id, { at: now(), json });
            return json;
        } catch {
            schedCache.set(id, { at: now(), json: hit?.json ?? null });   // ask again in 5 min, keep the last answer
            return hit?.json ?? null;
        }
    }

    function goalReached(p, s) {
        if (p.queued) return false;
        if (p.action === "start") return s.state === "running";
        if (p.action === "stop") return s.state === "offline";
        if (p.action === "restart") return s.state === "running" && s.uptimeMs < wallNow() - p.sinceWall;
        return true;
    }
    const jobLive = (p) => p.job != null && liveJobs.has(p.job);

    async function build() {
        const c = config();
        const map = await list();
        const prev = new Map((snap?.servers || []).map((s) => [s.id, s]));
        let failures = 0, asked = 0;
        const missing = c.servers.filter((sc) => !map.has(sc.uuid)).map((sc) => sc.label || sc.game);
        const servers = await Promise.all(c.servers.map(async (sc) => {
            const p = map.get(sc.uuid);
            if (!p) return null;
            asked += 1;
            let r = null;
            try { r = (await panel.resources(p.id))?.attributes ?? null; } catch { failures += 1; }
            if (r && !STATES.has(r.current_state)) r = null;
            const old = prev.get(p.id);
            const state = r ? r.current_state : (old?.state ?? "offline");
            const res = r?.resources || {};
            const on = state !== "offline";
            const num = (v, f) => (r && on && Number.isFinite(Number(v)) ? f(Number(v)) : r ? 0 : null);
            const sched = await schedulesOf(p.id);
            return {
                id: p.id,
                uuid: sc.uuid,
                kind: sc.kind,
                name: sc.label || p.name,
                game: sc.game,
                steamAppId: sc.steamAppId,
                emoji: sc.emoji,
                state,
                unknown: !r,                 // this server's state could not be read now (the last one is shown)
                unavailable: p.unavailable,
                uptimeMs: num(res.uptime, (x) => Math.max(0, Math.round(x))) ?? (old?.uptimeMs ?? 0),
                cpu: {
                    used: num(res.cpu_absolute, (x) => Math.max(0, Math.round(x * 10) / 10)) ?? (old?.cpu.used ?? 0),
                    limit: p.cpuLimit > 0 ? p.cpuLimit : c.hostCores * 100,
                },
                memory: {
                    usedMB: num(res.memory_bytes, (x) => Math.max(0, Math.round(x / 1048576))) ?? (old?.memory.usedMB ?? 0),
                    limitMB: p.memoryMB,
                },
                memoryLimitMB: p.memoryMB,
                join: {
                    address: p.port ? `${c.joinHost}:${p.port}` : c.joinHost,
                    password: KINDS[sc.kind].passwordVar ? p.password : sc.joinPasswordText,
                },
                info: sc.info,
                outside: sc.outside,
                calendar: sc.calendar,
                next: nextSchedule(sched, on, wallNow()),
            };
        }));
        if (asked > 0 && failures === asked) throw new Error("the panel answered for no server");
        const list2 = servers.filter(Boolean);
        for (const s of list2) {
            const p = pending.get(s.id);
            if (!p || jobLive(p)) continue;   // a live switch owns its reservations until it ends
            if (goalReached(p, s) || now() - p.since > GS.PENDING_MAX_MS) pending.delete(s.id);
        }
        return { at: wallNow(), servers: list2, missing, cfgV: c.version };
    }

    const staleOr = (e) => {
        if (snap && snap.cfgV === cfgVersion && now() - snapAt < GS.STALE_MAX_MS) return { ...snap, stale: true };
        throw e;
    };
    /** The snapshot, at most `maxAge` old; concurrent callers share one build; after a failure the panel rests SNAP_TTL. */
    async function snapshot(maxAge = GS.SNAP_TTL_MS) {
        if (snap && snap.cfgV === cfgVersion && now() - snapAt < maxAge) return snap;
        if (inflight) return inflight;
        if (now() - failAt < GS.SNAP_TTL_MS) return staleOr(new Error("the panel failed a moment ago"));
        const p = (async () => {
            try {
                const s = await build();
                snap = s; snapAt = now(); failAt = -Infinity;
                syncTrackers();
                return s;
            } catch (e) {
                failAt = now();
                log(`[gameservers] refresh failed: ${e.message}`);
                return staleOr(e);
            }
        })();
        inflight = p;
        try { return await p; } finally { if (inflight === p) inflight = null; }
    }

    function syncTrackers() {
        if (!snap || !WebSocketImpl) return;
        const wanted = now() - lastWanted < GS.WANTED_MS;
        const c = config();
        const live = new Set();
        for (const s of snap.servers) {
            if (!KINDS[s.kind]?.players) continue;
            if (wanted && (s.state === "running" || s.state === "starting")) {
                live.add(s.id);
                if (!trackers.has(s.id)) {
                    const t = new Tracker(s.id, s.kind, {
                        panel, now, log, WebSocketImpl, wings: c.panel.wings, origin: c.panel.origin,
                        onState: () => { snapAt = -Infinity; },
                        lastToken: (id) => tokenAt.get(id) ?? -Infinity,
                        setLastToken: (id, t) => tokenAt.set(id, t),
                    });
                    trackers.set(s.id, t);
                    t.start();
                }
            }
        }
        for (const [id, t] of trackers) if (!live.has(id)) { t.stop(); trackers.delete(id); }
    }

    const entriesOf = (s) => s.servers.map((e) => ({ ...e, pending: pending.get(e.id) || null }));

    /** What a caller sees (no panel secret ever; the join password is meant for every member). */
    function view(s, who, c) {
        const all = entriesOf(s);
        const servers = all.map((e) => {
            const t = trackers.get(e.id);
            const p = e.pending;
            return {
                id: e.id,
                name: e.name,
                game: e.game,
                steamAppId: e.steamAppId,
                emoji: e.emoji,
                state: e.state,
                unavailable: e.unavailable,
                uptimeMs: e.uptimeMs,
                cpu: e.cpu,
                memory: e.memory,
                players: e.state === "running" && t ? t.players() : null,
                join: e.join,
                info: e.info,
                outside: e.outside,
                calendar: e.calendar,
                pending: p ? { action: p.action, by: p.by, since: p.sinceWall, queued: !!p.queued } : null,
                next: e.next,
            };
        });
        const active = all.filter(isActive);
        return {
            v: 1,
            at: s.at,
            space: who.space,
            announceRoom: who.announceRoom,
            canManage: who.canManage,
            cap: c.cap,
            running: active.length,
            memoryBudgetMB: c.memoryBudgetMB,
            memoryUsedMB: active.reduce((a, e) => a + (e.memoryLimitMB > 0 ? e.memoryLimitMB : c.memoryBudgetMB), 0),
            stale: !!s.stale,
            servers,
            job: job && (!job.endedAt || now() - job.endedAt < GS.JOB_KEEP_MS)
                ? { from: job.from, to: job.to, by: job.by, since: job.sinceWall, step: job.step, ok: job.ok ?? null, error: job.error ?? null }
                : null,
        };
    }

    /** The config (and the key) a request needs, or a 503 already sent. */
    function ready(res, user) {
        try { config(); key(); return true; } catch (e) {
            res.status(503).json({ error: "Game servers aren't set up on this server", code: "off" });
            if (quietLog.hit(`r:${user}`)) log(`[gameservers] not ready: ${e.message}`);
            return false;
        }
    }

    const statusLimit = new RateLimit(GS.STATUS_PER_MIN, 60_000, now);
    const statusGlobal = new RateLimit(GS.STATUS_GLOBAL_PER_MIN, 60_000, now);
    const powerLimit = new RateLimit(GS.POWER_PER_MIN, 60_000, now);
    const quietLog = new RateLimit(1, 60_000, now);   // one console line per user per minute for refusals we don't file
    const serial = mutex();

    async function status(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        if (!statusLimit.hit(who.user) || !statusGlobal.hit("all")) {
            res.set("Retry-After", String(statusLimit.retryAfter(who.user)));
            return res.status(429).json({ error: "Too many requests — try again shortly", code: "rate" });
        }
        if (!ready(res, who.user)) return;
        const c = config();
        let g;
        try { g = await whoIs(who.user, c); } catch (e) {
            if (quietLog.hit(`m:${who.user}`)) log(`[gameservers] membership check failed: ${e.message}`);
            return res.status(502).json({ error: "Couldn't check that you're a member of this server's game space", code: "homeserver" });
        }
        if (!g.member) return res.status(403).json({ error: "Only members of this server's game space see its game servers", code: "not-member" });
        lastWanted = now();
        let s;
        try { s = await snapshot(); } catch {
            return res.status(502).json({ error: "Can't reach the game panel", code: "panel" });
        }
        if (s.cfgV !== c.version || cfg !== c) return res.status(503).json({ error: "Game servers are reloading — try again in a moment", code: "reloading" });
        syncTrackers();
        return res.json(view(s, g, c));
    }

    async function power(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        // the limit comes before the body is read; a 429 is never filed (a flood can't grow the log)
        if (!powerLimit.hit(who.user)) {
            res.set("Retry-After", String(powerLimit.retryAfter(who.user)));
            if (quietLog.hit(`p:${who.user}`)) log(`[gameservers] power ${who.user} -> 429 (further ones this minute not logged)`);
            return res.status(429).json({ error: "Slow down — too many power requests", code: "rate" });
        }
        if (!ready(res, who.user)) return;
        const c0 = config();
        const body = await readJson(req, GS.BODY_MAX);
        const b = body.ok && isObj(body.value) ? body.value : null;
        const target = b && typeof b.server === "string" && ID_RE.test(b.server) ? b.server : null;
        const action = b && typeof b.action === "string" && ACTIONS.has(b.action) ? b.action : null;
        const stopFirst = b && b.stopFirst != null ? (typeof b.stopFirst === "string" && ID_RE.test(b.stopFirst) ? b.stopFirst : false) : null;
        if (!target || !action || stopFirst === false) {
            record(`power ${who.user} (invalid request) -> 400`);
            return res.status(body.ok ? 400 : body.status).json({ error: "server (8 hex), action (start|stop|restart) and an optional stopFirst are required", code: "bad-request" });
        }
        // from here on every field is validated: safe to file
        const what = `${action} ${target}${stopFirst ? ` (stop ${stopFirst} first)` : ""}`;
        const line = (st, extra) => record(`power ${who.user} ${what} -> ${st}${extra ? ` ${extra}` : ""}`);
        let g;
        try { g = await whoIs(who.user, c0); } catch {
            line(502, "membership check failed");
            return res.status(502).json({ error: "Couldn't check that you're a member of this server's game space", code: "homeserver" });
        }
        if (!g.member) { line(403, "not a member"); return res.status(403).json({ error: "Only members of this server's game space see its game servers", code: "not-member" }); }
        if (!g.canManage) { line(403, "no manage_game_servers"); return res.status(403).json({ error: "You can't manage the game servers", code: "forbidden" }); }
        lastWanted = now();
        // plan + reserve under one lock: two starts can never both pass the cap / the memory check
        const decided = await serial(async () => {
            let s;
            try { s = await snapshot(GS.POWER_FRESH_MS); } catch { return { st: 502, why: "panel unreachable", body: { error: "Can't reach the game panel", code: "panel" } }; }
            if (s.stale) return { st: 502, why: "panel: stale snapshot", body: { error: "Can't reach the game panel", code: "panel" } };
            const c = config();
            if (c !== c0 || s.cfgV !== c.version) return { st: 503, why: "config reloaded mid-request", body: { error: "Game servers are reloading — try again in a moment", code: "reloading" } };
            const entries = entriesOf(s);
            const name = (id) => entries.find((e) => e.id === id)?.name || id;
            if (action === "start") {
                const unknown = entries.filter((e) => e.unknown).map((e) => e.name).concat(s.missing || []);
                if (unknown.length) return { st: 409, why: "refused: unknown state", body: { error: `Couldn't read ${unknown.join(", ")} right now — try again in a moment`, code: "panel" } };
            }
            const plan = planPower({ servers: entries, target, action, stopFirst, cap: c.cap, budgetMB: c.memoryBudgetMB });
            if (!plan.ok) {
                const { ok: _ok, status: st, ...rest } = plan;
                return { st, why: `refused: ${plan.code}`, body: rest };
            }
            const nowM = now(), nowW = wallNow();
            if (plan.stopFirst) {
                const from = plan.stopFirst;
                const id = ++jobSeq;
                job = { id, from, to: target, by: who.user, since: nowM, sinceWall: nowW, step: "stopping" };
                liveJobs.add(id);
                pending.set(from, { action: "stop", by: who.user, since: nowM, sinceWall: nowW, job: id });
                pending.set(target, { action: "start", by: who.user, since: nowM, sinceWall: nowW, queued: true, job: id });
                return { job, name };
            }
            const mine = { action, by: who.user, since: nowM, sinceWall: nowW };
            pending.set(target, mine);   // reserved BEFORE the panel is asked
            return { mine, s, name };
        });
        if (decided.st) { line(decided.st, decided.why); return res.status(decided.st).json(decided.body); }
        if (decided.job) {
            const j = decided.job;
            line(202, `accepted: stop "${decided.name(j.from)}", then start "${decided.name(target)}"`);
            runSwitch(j, decided.name).catch((e) => record(`switch ${who.user} ${j.from} -> ${j.to} crashed: ${e.message}`));
            return res.status(202).json({ ok: true, action: "start", server: target, stopFirst: j.from, job: { step: "stopping" } });
        }
        try {
            await panel.power(target, action);
        } catch (e) {
            // a definite refusal (the panel answered an HTTP error) gives the reservation back; no answer (a timeout, a
            // dropped connection) may still have run the action: the reservation stays until the state or its timeout
            // settles it, so the cap can't be passed meanwhile
            if (e.status && pending.get(target) === decided.mine) pending.delete(target);
            snapAt = -Infinity;
            line(502, e.status ? `panel refused: ${e.status}` : "panel: no answer (reservation kept until the state settles)");
            return res.status(502).json({ error: e.status ? `The game panel refused to ${action} ${decided.name(target)}` : `The game panel didn't answer — ${decided.name(target)} may still ${action}`, code: "panel" });
        }
        snapAt = -Infinity;
        line(200, `ok "${decided.name(target)}"`);
        const entry = view(decided.s, g, c0).servers.find((e) => e.id === target) || null;
        return res.json({ ok: true, action, server: target, entry });
    }

    async function runSwitch(j, name) {
        const who = j.by;
        const own = (id) => { const p = pending.get(id); return p && p.job === j.id; };
        const release = () => { if (own(j.from)) pending.delete(j.from); if (own(j.to)) pending.delete(j.to); };
        const fail = (error) => {
            j.step = "failed"; j.ok = false; j.error = error; j.endedAt = now();
            release();
            liveJobs.delete(j.id);
            record(`switch ${who} ${j.from} -> ${j.to} failed: ${error}`);
        };
        try { await panel.power(j.from, "stop"); } catch (e) {
            return fail(`Couldn't stop ${name(j.from)} (${e.status || "no answer"}) — nothing was started`);
        }
        const deadline = now() + GS.SWITCH_STOP_WAIT_MS;
        for (;;) {
            await new Promise((r) => { const t = setTimeout(r, GS.SWITCH_POLL_MS); t.unref?.(); });
            let st = null;
            try { st = (await panel.resources(j.from))?.attributes?.current_state ?? null; } catch { st = null; }
            if (st === "offline") break;
            if (now() > deadline) return fail(`${name(j.from)} didn't stop within ${Math.round(GS.SWITCH_STOP_WAIT_MS / 60_000)} minutes — nothing was started`);
        }
        await serial(async () => {
            let s;
            try { s = await snapshot(0); } catch { s = null; }
            if (!s || s.stale) return fail(`${name(j.from)} stopped, but the game panel stopped answering — nothing was started`);
            if (!own(j.to)) return fail(`${name(j.to)} was taken by another request — nothing was started`);
            if (own(j.from)) pending.delete(j.from);
            j.step = "starting";
            const c = config();
            const entries = entriesOf(s).map((e) => (e.id === j.to ? { ...e, pending: null } : e));
            const unknown = entries.filter((e) => e.unknown).map((e) => e.name).concat(s.missing || []);
            if (unknown.length) return fail(`Couldn't read ${unknown.join(", ")} — ${name(j.to)} was not started`);
            const plan = planPower({ servers: entries, target: j.to, action: "start", cap: c.cap, budgetMB: c.memoryBudgetMB });
            if (!plan.ok) return fail(plan.error);
            if (own(j.to)) pending.set(j.to, { action: "start", by: who, since: now(), sinceWall: wallNow(), job: j.id });
            try { await panel.power(j.to, "start"); } catch (e) {
                return fail(`${name(j.from)} stopped, but the panel refused to start ${name(j.to)} (${e.status || "no answer"})`);
            }
            j.step = "done"; j.ok = true; j.endedAt = now();
            // the start's reservation now ends like any start (running, or PENDING_MAX_MS)
            const p = pending.get(j.to);
            if (p && p.job === j.id) pending.set(j.to, { action: "start", by: who, since: now(), sinceWall: wallNow() });
            liveJobs.delete(j.id);
            snapAt = -Infinity;
            record(`switch ${who} ${j.from} -> ${j.to} done: "${name(j.from)}" offline, "${name(j.to)}" starting`);
        });
    }

    function sweep() {
        if (now() - lastWanted >= GS.WANTED_MS) for (const [id, t] of trackers) { t.stop(); trackers.delete(id); }
        statusLimit.sweep(); statusGlobal.sweep(); powerLimit.sweep(); quietLog.sweep(); budget.sweep();
    }
    function close() { for (const [id, t] of trackers) { t.stop(); trackers.delete(id); } }

    return { status, power, sweep, close, config, _pending: pending, _trackers: trackers, _snapshot: snapshot, _job: () => job };
}

/** Mount GET /gameservers/status and POST /gameservers/power. Both skip the app-wide per-IP bucket and body parser in
 *  server.mjs (they limit per user and read their own 2 KB body). */
export function installGameServers(app, deps) {
    if (!deps.adminToken) {
        console.error("[gameservers] synapse-admin.token missing -> game servers DISABLED");
        const off = (_req, res) => { noStore(res); res.status(503).json({ error: "Game servers aren't set up on this server", code: "off" }); };
        app.get("/gameservers/status", off); app.post("/gameservers/power", off);
        return null;
    }
    // a missing / broken config or key answers 503 per request and is picked up without a restart once fixed
    const g = createGameServers(deps);
    app.get("/gameservers/status", safe("gameservers", g.status));
    app.post("/gameservers/power", safe("gameservers", g.power));
    setInterval(() => { try { g.sweep(); } catch { /* never fatal */ } }, 60_000).unref?.();
    try { g.config(); } catch (e) { console.error(`[gameservers] config: ${e.message}`); }
    (deps.log || console.log)("[gameservers] ready — /gameservers/status + /gameservers/power (docs/GAMESERVERS.md)");
    return g;
}
