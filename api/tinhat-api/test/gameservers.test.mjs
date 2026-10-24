// gameservers.mjs — docs/GAMESERVERS.md: config, the per-game player parsers (sample console lines), the join-password
// allow-list, membership + the manage_game_servers check, the cap and memory rules, the handlers (401/403/409/200/202)
// with a scripted homeserver and a scripted panel, the action log, and the websocket tracker (token budget, replay).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    GS, KINDS, parseConfig, cleanLine, cleanName, parsePlayers, mergeTail, governance, planPower, readList, nextSchedule,
    createGameServers,
} from "../gameservers.mjs";
import { createMatrixAuth } from "../reachcommon.mjs";
import { call, bearer, clock } from "./helpers.mjs";

const SPACE = "!space:example.org", TSPACE = "!testspace:example.org", ROOM = "!games:example.org", TROOM = "!testroom:example.org";
const ADMIN = "@owner:example.org", MEMBER = "@member:example.org", OUTSIDER = "@stranger:example.org", TESTER = "@tester:example.org";
const U = {
    valheim: "8e6c2f05-1a2b-4c3d-8e4f-5a6b7c8d9e01",
    pz: "6c3f9a02-2b3c-4d4e-9f50-6b7c8d9e0f12",
    abiotic: "a1c0de77-3c4d-4e5f-a061-7c8d9e0f1a23",
    palworld: "7d4a1b93-4d5e-4f60-b172-8d9e0f1a2b34",
    ftb: "e2b4c6d8-5e6f-4071-8283-9e0f1a2b3c45",
};
const id = (uuid) => uuid.slice(0, 8);

const CONFIG = {
    v: 1,
    space: SPACE,
    announceRoom: ROOM,
    joinHost: "mine.example.org",
    panel: { url: "http://10.0.0.41", wings: "ws://10.0.0.41:8080", origin: "https://game.example.org" },  // nothing is assumed
    cap: 2,
    memoryBudgetMB: 30720,
    hostCores: 16,
    servers: [
        { uuid: U.valheim, kind: "valheim", game: "Valheim", steamAppId: 892970, outside: true, info: "World Example · Steam only" },
        { uuid: U.pz, kind: "pz", game: "Project Zomboid", steamAppId: 108600, outside: true, joinPasswordText: "zomboid-pw", info: "Build 42.20.4" },
        { uuid: U.abiotic, kind: "abiotic", game: "Abiotic Factor", steamAppId: 427410 },
        { uuid: U.palworld, kind: "palworld", game: "Palworld", steamAppId: 1623730 },
        { uuid: U.ftb, kind: "minecraft", game: "Minecraft", label: "FTB Skies 2" },
    ],
    test: [{ users: [TESTER], space: TSPACE, announceRoom: TROOM }],
};

// ── config ──
test("config_validates_and_refuses_what_could_leak_or_break", () => {
    const c = parseConfig(JSON.stringify(CONFIG));
    assert.equal(c.servers.length, 5);
    assert.equal(c.cap, 2);
    assert.equal(c.servers[1].joinPasswordText, "zomboid-pw");
    assert.equal(c.panel.url, "http://10.0.0.41", "defaults");
    assert.ok(c.test[0].users.has(TESTER));
    const bad = (mut, re) => {
        const x = structuredClone(CONFIG);
        mut(x);
        assert.throws(() => parseConfig(JSON.stringify(x)), re);
    };
    bad((x) => { x.servers[0].kind = "doom"; }, /kind/);
    bad((x) => { x.servers[0].joinPasswordText = "x"; }, /joinPasswordText/, "a kind whose password is a panel variable can't carry a text");
    bad((x) => { x.servers.push({ ...x.servers[0] }); }, /listed twice/);
    bad((x) => { x.space = "jISj"; }, /space/);
    bad((x) => { x.v = 2; }, /v: 1/);
    bad((x) => { x.servers[0].info = "a‮b"; }, /info/);
    bad((x) => { x.test[0].users = ["nope"]; }, /mxids/);
    assert.throws(() => parseConfig("{"), /not JSON/);
});

test("the_password_allow_list_names_one_variable_per_kind", () => {
    assert.equal(KINDS.valheim.passwordVar, "PASSWORD");
    assert.equal(KINDS.palworld.passwordVar, "SERVER_PASSWORD");
    assert.equal(KINDS.abiotic.passwordVar, "SERVER_PASSWORD");
    for (const k of ["pz", "minecraft", "satisfactory"]) assert.equal(KINDS[k].passwordVar, null, k);
    assert.ok(Object.isFrozen(KINDS) && Object.isFrozen(KINDS.valheim));
});

// ── the panel list: only the allow-listed variable survives ──
function panelServer(uuid, name, { memory = 8192, cpu = 300, port = 2456, vars = {}, status = null } = {}) {
    return {
        attributes: {
            uuid, identifier: id(uuid), name, status, is_suspended: false, is_installing: false, is_transferring: false,
            limits: { memory, cpu },
            relationships: {
                allocations: { data: [{ attributes: { ip: "10.0.0.41", port: port + 1, is_default: false } }, { attributes: { ip: "10.0.0.41", port, is_default: true } }] },
                variables: { data: Object.entries(vars).map(([env_variable, server_value]) => ({ attributes: { env_variable, server_value, default_value: "dflt" } })) },
            },
        },
    };
}
const LIST = {
    data: [
        panelServer(U.valheim, "Valheim Vanilla", { vars: { PASSWORD: "sample-join-pw", SERVER_NAME: "Example", ADMIN_PASSWORD: "nope" } }),
        panelServer(U.pz, "Project Zomboid B42 Vanilla", { memory: 14336, cpu: 0, port: 16261, vars: { ADMIN_PASSWORD: "secret-admin", ADMIN_USER: "admin" } }),
        panelServer(U.abiotic, "Abiotic Factor", { memory: 6144, cpu: 400, port: 7779, vars: { SERVER_PASSWORD: "", ADMIN_PASSWORD: "x" } }),
        panelServer(U.palworld, "Palworld", { memory: 16384, cpu: 0, port: 8211, vars: { SERVER_PASSWORD: "pal-pw", ADMIN_PASSWORD: "rcon-secret" } }),
        panelServer(U.ftb, "FTB Skies 2", { memory: 10240, cpu: 600, port: 25565, vars: { API_KEY: "curseforge-key" } }),
        panelServer("5b2d7e40-6f70-4182-9394-0f1a2b3c4d56", "Satisfactory (not configured)", {}),
    ],
};

test("read_list_keeps_only_the_join_password_variable", () => {
    const m = readList(LIST, parseConfig(JSON.stringify(CONFIG)));
    assert.equal(m.size, 5, "a server that is not configured is never read");
    assert.equal(m.get(U.valheim).password, "sample-join-pw");
    assert.equal(m.get(U.valheim).port, 2456, "the default allocation");
    assert.equal(m.get(U.pz).password, null, "pz: no panel variable is the join password");
    assert.equal(m.get(U.abiotic).password, null, "an empty password = none");
    assert.equal(m.get(U.palworld).password, "pal-pw");
    assert.equal(m.get(U.ftb).password, null);
    const text = JSON.stringify([...m.values()]);
    for (const secret of ["secret-admin", "rcon-secret", "curseforge-key", "nope", "Example", "dflt"]) assert.ok(!text.includes(secret), secret);
    const inst = readList({ data: [panelServer(U.valheim, "V", { status: "installing" })] }, parseConfig(JSON.stringify(CONFIG)));
    assert.equal(inst.get(U.valheim).unavailable, "installing");
});

// ── console lines ──
test("clean_line_drops_passwords_and_the_startup_echo", () => {
    assert.equal(cleanLine("\x1b[33m\x1b[1m[Pelican Daemon]:\x1b[39m Checking server disk space usage"), "[Pelican Daemon]: Checking server disk space usage");
    assert.equal(cleanLine(":/home/container$ ./ProjectZomboid64 -adminusername admin -adminpassword hunter2"), null);
    assert.equal(cleanLine("[LOG] rcon -p SeCrEt password=abc"), null);
    assert.equal(cleanLine("Server Password is set"), null);
    assert.equal(cleanLine("   "), null);
    assert.equal(cleanLine(42), null);
    assert.equal(cleanLine("x".repeat(5000)).length, GS.LINE_MAX);
});

test("clean_name_is_plain_and_short", () => {
    assert.equal(cleanName("  Darrow  "), "Darrow");
    assert.equal(cleanName("Evil‮Name"), "EvilName");
    assert.equal(cleanName("\x1b[31mRed\x1b[0m"), "Red");
    assert.equal([...cleanName("🎮".repeat(40))].length, 32);
    assert.equal(cleanName(""), null);
});

const VH = [
    "09/28/2026 04:38:14:  Connections 2 ZDOS:626353  sent:52 recv:473",
    "09/28/2026 04:46:37: Got connection SteamID 76561190000000001",
    "09/28/2026 04:46:40: Got handshake from client 76561190000000001",
    "09/28/2026 04:46:55: Got character ZDOID from Darrow : 1263726350:1",
    "09/28/2026 04:48:14:  Connections 3 ZDOS:626367  sent:600 recv:509",
    "09/28/2026 04:48:51: Got connection SteamID 76561190000000002",
    "09/28/2026 04:49:13: Got character ZDOID from Sable : 275064619:1",
    "09/28/2026 04:51:46: Got connection SteamID 76561190000000003",
    "09/28/2026 04:51:47: Closing socket 76561190000000003",
    "09/28/2026 04:55:01: Got character ZDOID from Sable : 0:0",
    "09/28/2026 04:55:07: Got character ZDOID from Sable : -400698980:1",
];

test("valheim_count_from_connections_names_from_character_lines", () => {
    // at 04:48 the count says 3 (two joined before the window + Darrow); Sable joins after: 4; a refused attempt and a
    // death / respawn change nothing
    assert.deepEqual(parsePlayers("valheim", VH), { count: 4, names: ["Darrow", "Sable"] });
    const leave = [...VH, "09/28/2026 05:38:49: Closing socket 76561190000000001"];
    assert.deepEqual(parsePlayers("valheim", leave), { count: 3, names: ["Sable"] });
    const later = [...leave, "09/28/2026 05:48:14:  Connections 1 ZDOS:626249  sent:305 recv:334"];
    assert.deepEqual(parsePlayers("valheim", later), { count: 1, names: ["Sable"] });
    const empty = ["09/28/2026 13:08:15:  Connections 0 ZDOS:626176  sent:0 recv:0"];
    assert.deepEqual(parsePlayers("valheim", empty), { count: 0, names: [] });
    // no count line yet (just started): the named peers
    assert.deepEqual(parsePlayers("valheim", VH.slice(1, 4)), { count: 1, names: ["Darrow"] });
    // a respawn of someone who joined before the window is still someone on
    assert.deepEqual(parsePlayers("valheim", ["Got character ZDOID from Wren : 12:1"]), { count: 1, names: ["Wren"] });
    // the count says fewer than the names we hold: the most recent names win
    assert.deepEqual(parsePlayers("valheim", [...VH, "09/28/2026 06:18:14:  Connections 1 ZDOS:626187  sent:0 recv:230"]),
        { count: 1, names: ["Sable"] });
});

test("minecraft_joined_and_left_the_game", () => {
    const L = [
        "[09:40:01] [Server thread/INFO] [minecraft/DedicatedServer]: Done (31.2s)! For help, type \"help\"",
        "[09:53:44] [Server thread/INFO] [minecraft/PlayerList]: Kestrel[/1.2.3.4:40242] logged in with entity id 872",
        "[09:53:44] [Server thread/INFO] [minecraft/MinecraftServer]: Kestrel joined the game",
        "[09:54:10] [Server thread/INFO]: Lark joined the game",
        "[09:58:55] [Server thread/INFO] [minecraft/MinecraftServer]: Kestrel left the game",
        "[09:59:00] [Server thread/INFO] [minecraft/MinecraftServer]: <Lark> Kestrel joined the game",
    ];
    assert.deepEqual(parsePlayers("minecraft", L.map(cleanLine)), { count: 1, names: ["Lark"] }, "chat that quotes a join line is not a join");
    assert.deepEqual(parsePlayers("minecraft", [L[0]]), { count: 0, names: [] });
});

test("palworld_joined_and_left_the_server", () => {
    const L = [
        "[2026-07-21 01:59:34] [LOG] Lark joined the server. (User id: steam_76561190000000001, Player id: FB5B67F0)",
        "[2026-07-21 02:07:13] [LOG] Wren joined the server. (User id: steam_76561190000000002, Player id: 33CA11A0)",
        "[2026-07-21 03:00:15] [LOG] Lark left the server. (User id: steam_76561190000000001)",
    ];
    assert.deepEqual(parsePlayers("palworld", L), { count: 1, names: ["Wren"] });
    assert.deepEqual(parsePlayers("palworld", L.slice(0, 2)), { count: 2, names: ["Lark", "Wren"] });
});

test("project_zomboid_connection_lines_or_unknown", () => {
    const CM = [
        "[28-09-26 12:00:01.000] LOG  : Network ... > ConnectionManager: [fully-connected] \"\" connection: guid=1 ip=x steam-id=y access=user username=\"Lark\" connection-type=\"UDPRakNet\"",
        "[28-09-26 12:00:05.000] LOG  : Network ... > ConnectionManager: [fully-connected] \"\" connection: guid=2 ip=x steam-id=y access=user username=\"MEGAmurph\" connection-type=\"UDPRakNet\"",
        "[28-09-26 12:30:00.000] LOG  : Network ... > ConnectionManager: [disconnect] \"receive-disconnect\" connection: guid=1 username=\"Lark\"",
    ];
    assert.deepEqual(parsePlayers("pz", CM), { count: 1, names: ["MEGAmurph"] });
    const EV = [
        "[04-09-26 05:39:25.038] event=\"receive-packet\" message=\"client-connect\" guid=\"1788500036998342\" ip=\"x\" steam-id=\"y\" role=\"user\" username=\"Lark\" connection-type=\"UDPRakNet\".",
        "[04-09-26 05:39:25.082] event=\"receive-packet\" message=\"client-connect\" guid=\"1788500036998349\" ip=\"x\" steam-id=\"y\" role=\"user\" username=\"MEGAmurph\" connection-type=\"UDPRakNet\".",
        "[04-09-26 05:39:50.026] event=\"RakNet\" message=\"disconnection-notification\" guid=\"1788500036998342\".",
    ];
    assert.deepEqual(parsePlayers("pz", EV), { count: 1, names: ["MEGAmurph"] });
    // 42.20's console: no username line at all → unknown, not "nobody"
    const CONSOLE = [
        "[04-09-26 05:39:23.727] LOG  : General      f:0 st:628,966,226> Steam client 76561190000000001 is initiating a connection..",
        "[04-09-26 05:39:25.040] LOG  : Network      f:0 st:628,967,540> Connected new client 1788500036998342 ID # 0.",
    ];
    assert.equal(parsePlayers("pz", CONSOLE), null);
});

test("kinds_without_a_parser_and_empty_buffers_are_unknown", () => {
    assert.equal(parsePlayers("abiotic", ["LogNet: Join succeeded: Bob"]), null);
    assert.equal(parsePlayers("satisfactory", ["x"]), null);
    assert.equal(parsePlayers("valheim", []), null);
    assert.equal(parsePlayers("nope", ["x"]), null);
});

test("merge_tail_skips_the_replayed_overlap", () => {
    assert.deepEqual(mergeTail([], ["a", "b"]), ["a", "b"]);
    assert.deepEqual(mergeTail(["a", "b", "c"], ["b", "c", "d"]), ["a", "b", "c", "d"]);
    assert.deepEqual(mergeTail(["a", "b", "c"], ["a", "b", "c"]), ["a", "b", "c"]);
    assert.deepEqual(mergeTail(["a", "b"], ["x", "y"]), ["a", "b", "x", "y"], "no overlap: a gap, everything appended");
    assert.deepEqual(mergeTail(["a", "b", "c"], ["c", "d"], 3), ["b", "c", "d"], "keeps the last max");
});

// ── governance ──
const member = (mxid, membership = "join") => ({ type: "m.room.member", state_key: mxid, content: { membership } });
const role = (rid, rank, permissions) => ({ type: "dev.tinhat.role", state_key: rid, content: { name: rid, rank, permissions } });
const assign = (mxid, roles) => ({ type: "dev.tinhat.member_roles", state_key: mxid.slice(1), content: { roles } });
const pl = (users) => ({ type: "m.room.power_levels", state_key: "", content: { users, users_default: 0 } });

test("governance_membership_and_the_permission", () => {
    const roles = [role("everyone", 0, ["invite"]), role("admin", 100, ["kick", "manage_game_servers"]), role("moderator", 50, ["kick"])];
    const st = [member(ADMIN), member(MEMBER), member(OUTSIDER, "leave"), ...roles, assign(ADMIN, ["admin"]), assign(MEMBER, ["moderator"]), pl({ [ADMIN]: 100, [MEMBER]: 50 })];
    assert.deepEqual(governance(st, ADMIN), { member: true, canManage: true });
    assert.deepEqual(governance(st, MEMBER), { member: true, canManage: false });
    assert.deepEqual(governance(st, OUTSIDER), { member: false, canManage: false }, "left = not a member");
    assert.deepEqual(governance(st, "@nobody:example.org"), { member: false, canManage: false });
    // roles active: rank 100 WITHOUT the permission does not manage (exactly like moderate_calls)
    const noPerm = [member(ADMIN), role("everyone", 0, []), role("admin", 100, ["kick"]), assign(ADMIN, ["admin"]), pl({ [ADMIN]: 100 })];
    assert.equal(governance(noPerm, ADMIN).canManage, false);
    // the everyone role can grant it to all members
    const all = [member(MEMBER), role("everyone", 0, ["manage_game_servers"])];
    assert.equal(governance(all, MEMBER).canManage, true);
    // no roles: power level 100 (the owner rank) manages, 50 does not
    const plain = [member(ADMIN), member(MEMBER), pl({ [ADMIN]: 100, [MEMBER]: 50 })];
    assert.equal(governance(plain, ADMIN).canManage, true);
    assert.equal(governance(plain, MEMBER).canManage, false);
});

// ── the power rules ──
const S = (sid, name, state, memoryLimitMB, extra = {}) => ({ id: sid, name, state, memoryLimitMB, unavailable: null, pending: null, ...extra });
const plan = (servers, target, action, stopFirst = null) => planPower({ servers, target, action, stopFirst, cap: 2, budgetMB: 30720 });

test("cap_of_two_and_the_switch", () => {
    const three = [S("aaaaaaa1", "Valheim", "running", 8192), S("aaaaaaa2", "PZ", "running", 14336), S("aaaaaaa3", "Abiotic Factor", "offline", 6144)];
    const r = plan(three, "aaaaaaa3", "start");
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.code, "cap");
    assert.equal(r.error, "Two games are already running — stop one first");
    assert.deepEqual(r.running, ["aaaaaaa1", "aaaaaaa2"]);
    assert.deepEqual(plan(three, "aaaaaaa3", "start", "aaaaaaa1"), { ok: true, stopFirst: "aaaaaaa1" });
    // starting and stopping servers hold their place; a queued start counts too
    const busy = [S("aaaaaaa1", "Valheim", "stopping", 8192), S("aaaaaaa2", "PZ", "offline", 14336, { pending: { action: "start" } }), S("aaaaaaa3", "AF", "offline", 6144)];
    assert.equal(plan(busy, "aaaaaaa3", "start").code, "cap");
    assert.equal(plan([S("aaaaaaa1", "V", "running", 8192), S("aaaaaaa3", "AF", "offline", 6144)], "aaaaaaa3", "start").ok, true);
});

test("memory_must_fit_the_budget", () => {
    const s = [S("bbbbbbb1", "Palworld", "running", 16384), S("bbbbbbb2", "PZ", "offline", 14336), S("bbbbbbb3", "Big", "offline", 16384)];
    assert.equal(plan(s, "bbbbbbb2", "start").ok, true, "16 + 14 = 30 GB fits 30 GB exactly");
    const r = plan(s, "bbbbbbb3", "start");
    assert.equal(r.code, "memory");
    assert.equal(r.error, "Big needs 16 GB and only 14 GB is free — stop a game first");
    assert.equal(r.freeMB, 14336);
    // an unlimited server counts as the whole budget
    const u = [S("bbbbbbb1", "Unlimited", "running", 0), S("bbbbbbb2", "PZ", "offline", 14336)];
    assert.equal(plan(u, "bbbbbbb2", "start").code, "memory");
});

test("state_rules_and_bad_requests", () => {
    const s = [S("ccccccc1", "Valheim", "running", 8192), S("ccccccc2", "AF", "offline", 6144), S("ccccccc3", "PZ", "starting", 14336),
        S("ccccccc4", "Inst", "offline", 1024, { unavailable: "installing" }), S("ccccccc5", "Busy", "running", 1024, { pending: { action: "restart" } })];
    assert.equal(plan(s, "ccccccc1", "start").code, "already");
    assert.equal(plan(s, "ccccccc2", "stop").code, "already");
    assert.equal(plan(s, "ccccccc2", "restart").code, "not-running");
    assert.equal(plan(s, "ccccccc3", "restart").code, "busy");
    assert.equal(plan(s, "ccccccc4", "start").code, "unavailable");
    assert.equal(plan(s, "ccccccc5", "stop").code, "busy");
    assert.equal(plan(s, "ccccccc1", "restart").ok, true);
    assert.equal(plan(s, "ccccccc1", "stop").ok, true);
    assert.equal(plan(s, "deadbeef", "start").code, "unknown");
    assert.equal(plan(s, "ccccccc2", "stop", "ccccccc1").code, "bad-request");
    assert.equal(plan(s, "ccccccc2", "start", "ccccccc2").code, "bad-request");
    assert.equal(plan(s, "ccccccc2", "start", "ccccccc4").code, "not-running");
    assert.equal(plan(s, "ccccccc2", "start", "ccccccc5").code, "busy");
});

test("next_schedule_backup_or_restart", () => {
    const now = Date.parse("2026-09-28T20:00:00Z");
    const sch = (name, at, tasks, extra = {}) => ({ attributes: { name, is_active: true, only_when_online: false, next_run_at: at, relationships: { tasks: { data: tasks.map((t) => ({ attributes: t })) } }, ...extra } });
    const j = { data: [
        sch("backup", "2026-09-29T14:40:00+00:00", [{ action: "backup", payload: "" }]),
        sch("restart", "2026-09-29T15:00:00+00:00", [{ action: "power", payload: "restart" }]),
        sch("say", "2026-09-28T21:00:00+00:00", [{ action: "command", payload: "say hi" }]),
        sch("off", "2026-09-28T20:30:00+00:00", [{ action: "backup" }], { is_active: false }),
    ] };
    assert.deepEqual(nextSchedule(j, true, now), { what: "backup", at: Date.parse("2026-09-29T14:40:00Z") });
    const onlyOnline = { data: [sch("r", "2026-09-28T21:00:00+00:00", [{ action: "power", payload: "restart" }], { only_when_online: true })] };
    assert.equal(nextSchedule(onlyOnline, false, now), null);
    assert.deepEqual(nextSchedule(onlyOnline, true, now), { what: "restart", at: Date.parse("2026-09-28T21:00:00Z") });
    assert.equal(nextSchedule(null, true, now), null);
});

// ── the handlers ──
function scripted() {
    const tokens = { tadmin: ADMIN, tmember: MEMBER, toutsider: OUTSIDER, ttester: TESTER };
    const rooms = {
        [SPACE]: [member(ADMIN), member(MEMBER), role("everyone", 0, ["invite"]), role("admin", 100, ["manage_game_servers"]), assign(ADMIN, ["admin"])],
        [TSPACE]: [member(TESTER), role("everyone", 0, []), role("admin", 100, ["manage_game_servers"]), assign(TESTER, ["admin"])],
    };
    const calls = [];
    const hs = {
        async get(path, token) {
            calls.push(path);
            if (path === "/_matrix/client/v3/account/whoami") {
                return tokens[token] ? { ok: true, status: 200, body: { user_id: tokens[token], device_id: "D" } } : { ok: false, status: 401, body: {} };
            }
            const m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/state$/.exec(path);
            if (m && token === "admintoken") {
                const r = rooms[decodeURIComponent(m[1])];
                return r ? { ok: true, status: 200, body: { state: r } } : { ok: false, status: 404, body: {} };
            }
            return { ok: false, status: 404, body: {} };
        },
    };
    return { hs, calls, rooms };
}

function fakePanel(states) {
    const calls = [];
    return {
        calls,
        states,
        async list() { calls.push("list"); return LIST; },
        async resources(sid) {
            calls.push(`resources ${sid}`);
            const st = states[sid] ?? "offline";
            if (st instanceof Error) throw st;
            const on = st !== "offline";
            return { attributes: { current_state: st, resources: { memory_bytes: on ? 2 * 1048576 * 1024 : 0, cpu_absolute: on ? 16.765 : 0, uptime: on ? 247717110 : 0 } } };
        },
        async schedules(sid) { calls.push(`schedules ${sid}`); return { data: [] }; },
        async power(sid, signal) { calls.push(`power ${sid} ${signal}`); if (states.powerError) throw Object.assign(new Error("panel said 502"), { status: 502 }); return null; },
        async wsToken(sid) { calls.push(`ws ${sid}`); return { data: { token: `jwt-${calls.length}`, socket: `wss://game.example.org:8080/api/servers/${Object.values(U).find((u) => id(u) === sid)}/ws` } }; },
    };
}

function service(states, over = {}) {
    const now = clock(1_000_000);
    const wallNow = () => 1_790_000_000_000 + now();
    const { hs, calls } = scripted();
    const panel = fakePanel(states);
    const dir = mkdtempSync(join(tmpdir(), "gs-"));
    const logFile = join(dir, "actions.log");
    const logs = [];
    const g = createGameServers({
        auth: createMatrixAuth({ hs, now }), hs, adminToken: "admintoken", configText: JSON.stringify(over.config || CONFIG),
        key: "pacc_test", panel, now, wallNow, log: (s) => logs.push(s), logFile, WebSocketImpl: over.WebSocketImpl ?? null,
    });
    const status = (tok) => call(g.status, { headers: tok ? bearer(tok) : {} });
    const power = (tok, body) => call(g.power, { method: "POST", headers: bearer(tok), body });
    const cleanup = () => { g.close(); rmSync(dir, { recursive: true, force: true }); };
    return { g, now, hs, calls, panel, status, power, logs, logFile, cleanup };
}

test("status_401_403_and_the_member_view", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        const r0 = await t.status(null);
        assert.equal(r0.statusCode, 401);
        assert.equal(r0.headers["cache-control"], "no-store");
        assert.equal((await t.status("bad")).statusCode, 401);
        const r1 = await t.status("toutsider");
        assert.deepEqual([r1.statusCode, r1.body], [403, { error: "Only members of this server's game space see its game servers", code: "not-member" }]);
        const r = await t.status("tmember");
        assert.equal(r.statusCode, 200);
        const b = r.body;
        assert.equal(b.v, 1);
        assert.equal(b.canManage, false);
        assert.equal(b.cap, 2);
        assert.equal(b.running, 1);
        assert.equal(b.space, SPACE);
        assert.equal(b.announceRoom, ROOM);
        assert.equal(b.memoryUsedMB, 8192);
        assert.equal(b.servers.length, 5);
        const v = b.servers[0];
        assert.deepEqual(Object.keys(v).sort(), ["calendar", "cpu", "emoji", "game", "id", "info", "join", "memory", "name", "next", "outside", "pending", "players", "state", "steamAppId", "unavailable", "uptimeMs"].sort());
        assert.equal(v.id, "8e6c2f05");
        assert.equal(v.name, "Valheim Vanilla");
        assert.equal(v.state, "running");
        assert.equal(v.uptimeMs, 247717110);
        assert.deepEqual(v.cpu, { used: 16.8, limit: 300 });
        assert.deepEqual(v.memory, { usedMB: 2048, limitMB: 8192 });
        assert.deepEqual(v.join, { address: "mine.example.org:2456", password: "sample-join-pw" });
        assert.equal(v.players, null, "no tracker (no websocket in this test)");
        const pz = b.servers[1];
        assert.deepEqual(pz.join, { address: "mine.example.org:16261", password: "zomboid-pw" }, "pz: the config's text");
        assert.deepEqual(pz.cpu, { used: 0, limit: 1600 }, "unlimited CPU = the host's cores");
        assert.equal(b.servers[4].name, "FTB Skies 2");
        const text = JSON.stringify(b);
        for (const secret of ["secret-admin", "rcon-secret", "curseforge-key", "pacc_test", U.abiotic.slice(0, 13), "nope"]) assert.ok(!text.includes(secret), secret);
        // a second member within 10 s: no new panel calls
        const before = t.panel.calls.length;
        await t.status("tadmin");
        assert.equal(t.panel.calls.length, before, "cached");
        t.now.advance(GS.SNAP_TTL_MS + 1);
        await t.status("tadmin");
        assert.ok(t.panel.calls.length > before, "asked again after 10 s");
        assert.equal((await t.status("tadmin")).body.canManage, true);
    } finally { t.cleanup(); }
});

test("status_serves_the_last_snapshot_while_the_panel_is_down_then_502", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        assert.equal((await t.status("tmember")).statusCode, 200);
        for (const k of Object.keys(t.panel.states)) t.panel.states[k] = new Error("down");
        for (const u of Object.values(U)) t.panel.states[id(u)] = new Error("down");
        t.now.advance(GS.SNAP_TTL_MS + 1);
        const r = await t.status("tmember");
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.stale, true);
        t.now.advance(GS.STALE_MAX_MS + 1);
        const r2 = await t.status("tmember");
        assert.deepEqual([r2.statusCode, r2.body.code], [502, "panel"]);
    } finally { t.cleanup(); }
});

test("power_needs_membership_and_the_permission", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        const body = { server: id(U.abiotic), action: "start" };
        assert.deepEqual((await t.power("toutsider", body)).body, { error: "Only members of this server's game space see its game servers", code: "not-member" });
        const r = await t.power("tmember", body);
        assert.deepEqual([r.statusCode, r.body], [403, { error: "You can't manage the game servers", code: "forbidden" }]);
        assert.equal(t.panel.calls.filter((c) => c.startsWith("power")).length, 0, "nothing reached the panel");
        const bad = await t.power("tadmin", { server: "x", action: "start" });
        assert.equal(bad.statusCode, 400);
        assert.equal((await t.power("tadmin", { server: id(U.abiotic), action: "kill" })).statusCode, 400);
        const log = readFileSync(t.logFile, "utf8");
        assert.match(log, /power @stranger:example.org start a1c0de77 -> 403 not a member/);
        assert.match(log, /power @member:example.org start a1c0de77 -> 403 no manage_game_servers/);
    } finally { t.cleanup(); }
});

test("power_start_reaches_the_panel_and_shows_pending_until_running", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        const r = await t.power("tadmin", { server: id(U.abiotic), action: "start" });
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.entry.pending.action, "start");
        assert.equal(r.body.entry.pending.by, ADMIN);
        assert.ok(t.panel.calls.includes(`power ${id(U.abiotic)} start`));
        assert.match(readFileSync(t.logFile, "utf8"), /power @owner:example.org start a1c0de77 -> 200 ok "Abiotic Factor"/);
        // busy until it runs
        assert.equal((await t.power("tadmin", { server: id(U.abiotic), action: "stop" })).body.code, "busy");
        t.panel.states[id(U.abiotic)] = "running";
        t.now.advance(GS.SNAP_TTL_MS + 1);
        const s = await t.status("tmember");
        assert.equal(s.body.servers.find((x) => x.id === id(U.abiotic)).pending, null, "goal reached");
        assert.equal(s.body.running, 2);
        // a third game: refused with the cap
        const r3 = await t.power("tadmin", { server: id(U.palworld), action: "start" });
        assert.deepEqual([r3.statusCode, r3.body.code], [409, "cap"]);
        assert.deepEqual(r3.body.running.sort(), [id(U.abiotic), id(U.valheim)].sort());
        assert.ok(!t.panel.calls.includes(`power ${id(U.palworld)} start`));
        assert.match(readFileSync(t.logFile, "utf8"), /start 7d4a1b93 -> 409 refused: cap/);
    } finally { t.cleanup(); }
});

test("power_panel_failure_is_a_502_and_logged", async () => {
    const t = service({ [id(U.valheim)]: "running", powerError: true });
    try {
        const r = await t.power("tadmin", { server: id(U.valheim), action: "restart" });
        assert.deepEqual([r.statusCode, r.body], [502, { error: "The game panel refused to restart Valheim Vanilla", code: "panel" }]);
        assert.match(readFileSync(t.logFile, "utf8"), /restart 8e6c2f05 -> 502 panel refused: 502/);
    } finally { t.cleanup(); }
});

test("switch_stops_the_first_then_starts_the_second", async () => {
    const t = service({ [id(U.valheim)]: "running", [id(U.pz)]: "running" });
    try {
        const r = await t.power("tadmin", { server: id(U.abiotic), action: "start", stopFirst: id(U.valheim) });
        assert.equal(r.statusCode, 202);
        assert.deepEqual(r.body, { ok: true, action: "start", server: id(U.abiotic), stopFirst: id(U.valheim), job: { step: "stopping" } });
        assert.ok(t.panel.calls.includes(`power ${id(U.valheim)} stop`));
        const mid = (await t.status("tmember")).body;
        assert.equal(mid.job.step, "stopping");
        assert.equal(mid.servers.find((x) => x.id === id(U.abiotic)).pending.queued, true);
        assert.equal(mid.servers.find((x) => x.id === id(U.valheim)).pending.action, "stop");
        t.panel.states[id(U.valheim)] = "offline";
        await new Promise((res) => setTimeout(res, GS.SWITCH_POLL_MS + 400));
        assert.ok(t.panel.calls.includes(`power ${id(U.abiotic)} start`));
        assert.equal(t.g._job().step, "done");
        const log = readFileSync(t.logFile, "utf8");
        assert.match(log, /-> 202 accepted: stop "Valheim Vanilla", then start "Abiotic Factor"/);
        assert.match(log, /switch @owner:example.org 8e6c2f05 -> a1c0de77 done/);
    } finally { t.cleanup(); }
});

test("a_switch_waits_out_wings_ten_minute_stop_then_gives_up", async () => {
    // Wings kills a server that ignores its stop command after 10 minutes (seen 2026-09-28: Abiotic Factor restarted 4 min after a start):
    // the switch waits that out, and gives up (starting nothing) only after SWITCH_STOP_WAIT_MS
    assert.ok(GS.SWITCH_STOP_WAIT_MS > 10 * 60_000);
    const t = service({ [id(U.valheim)]: "running", [id(U.pz)]: "running" });
    try {
        assert.equal((await t.power("tadmin", { server: id(U.abiotic), action: "start", stopFirst: id(U.valheim) })).statusCode, 202);
        t.panel.states[id(U.valheim)] = "stopping";
        await new Promise((res) => setTimeout(res, 50));               // the job has sent the stop and set its deadline
        t.now.advance(10 * 60_000);
        await new Promise((res) => setTimeout(res, GS.SWITCH_POLL_MS + 400));
        assert.equal(t.g._job().step, "stopping", "still waiting at 10 minutes");
        t.now.advance(GS.SWITCH_STOP_WAIT_MS - 10 * 60_000 + 1);
        await new Promise((res) => setTimeout(res, GS.SWITCH_POLL_MS + 400));
        const j = t.g._job();
        assert.equal(j.step, "failed");
        assert.equal(j.error, "Valheim Vanilla didn't stop within 11 minutes — nothing was started");
        assert.ok(!t.panel.calls.includes(`power ${id(U.abiotic)} start`));
        assert.equal(t.g._pending.size, 0, "the failed switch released both places");
    } finally { t.cleanup(); }
});

test("test_override_users_answer_to_the_test_space", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        const r = await t.status("ttester");
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.space, TSPACE);
        assert.equal(r.body.announceRoom, TROOM);
        assert.equal(r.body.canManage, true);
        // without the override the tester is not a member of the real space
        const t2 = service({}, { config: { ...CONFIG, test: [] } });
        try { assert.equal((await t2.status("ttester")).statusCode, 403); } finally { t2.cleanup(); }
    } finally { t.cleanup(); }
});

test("status_rate_limit_per_user", async () => {
    const t = service({});
    try {
        for (let i = 0; i < GS.STATUS_PER_MIN; i++) assert.equal((await t.status("tmember")).statusCode, 200);
        const r = await t.status("tmember");
        assert.deepEqual([r.statusCode, r.body.code], [429, "rate"]);
        assert.equal((await t.status("tadmin")).statusCode, 200, "per user");
    } finally { t.cleanup(); }
});

// ── the websocket tracker ──
class FakeWs {
    static all = [];
    constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; FakeWs.all.push(this); queueMicrotask(() => this.onopen?.({})); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.closed = true; queueMicrotask(() => this.onclose?.({})); }
    emit(event, ...args) { this.onmessage?.({ data: JSON.stringify({ event, args }) }); }
}

test("tracker_reads_players_through_one_socket_and_respects_the_token_budget", async () => {
    FakeWs.all = [];
    const t = service({ [id(U.valheim)]: "running" }, { WebSocketImpl: FakeWs });
    try {
        await t.status("tmember");                              // starts the tracker
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(FakeWs.all.length, 1);
        const ws = FakeWs.all[0];
        assert.equal(ws.url, `ws://10.0.0.41:8080/api/servers/${U.valheim}/ws`);
        assert.deepEqual(ws.opts, { headers: { Origin: "https://game.example.org" } });
        assert.equal(ws.sent[0].event, "auth");
        ws.emit("auth success");
        assert.deepEqual(ws.sent[1], { event: "send logs", args: [null] });
        ws.emit("status", "running");
        for (const l of VH) ws.emit("console output", l);
        ws.emit("console output", ":/home/container$ ./valheim_server.x86_64 -password \"sample-join-pw\"");
        await new Promise((r) => setTimeout(r, GS.REPLAY_QUIET_MS + 100));
        t.now.advance(GS.SNAP_TTL_MS + 1);
        const b = (await t.status("tmember")).body;
        assert.deepEqual(b.servers[0].players, { count: 4, names: ["Darrow", "Sable"] });
        const tr = t.g._trackers.get(id(U.valheim));
        assert.ok(!tr.lines.some((l) => /sample-join-pw|password/i.test(l)), "the startup echo was never kept");
        // live lines after the replay
        ws.emit("console output", "09/28/2026 05:38:49: Closing socket 76561190000000001");
        t.now.advance(GS.SNAP_TTL_MS + 1);
        assert.deepEqual((await t.status("tmember")).body.servers[0].players, { count: 3, names: ["Sable"] });
        // token expiring right away: no second token inside 30 s, then one
        const tokensBefore = t.panel.calls.filter((c) => c.startsWith("ws ")).length;
        ws.emit("token expiring");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(t.panel.calls.filter((c) => c.startsWith("ws ")).length, tokensBefore, "≥ 30 s between tokens");
        t.now.advance(GS.TOKEN_GAP_MS + 1);
        ws.emit("token expired");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(t.panel.calls.filter((c) => c.startsWith("ws ")).length, tokensBefore + 1);
        assert.equal(ws.sent.at(-1).event, "auth");
        // the server stops → the tracker goes
        t.panel.states[id(U.valheim)] = "offline";
        t.now.advance(GS.SNAP_TTL_MS + 1);
        const off = (await t.status("tmember")).body.servers[0];
        assert.equal(off.players, null);
        assert.equal(t.g._trackers.size, 0);
        assert.equal(ws.closed, true);
    } finally { t.cleanup(); }
});

test("trackers_stop_when_nobody_looked_for_ten_minutes", async () => {
    FakeWs.all = [];
    const t = service({ [id(U.valheim)]: "running" }, { WebSocketImpl: FakeWs });
    try {
        await t.status("tmember");
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(t.g._trackers.size, 1);
        t.now.advance(GS.WANTED_MS + 1);
        t.g.sweep();
        assert.equal(t.g._trackers.size, 0);
    } finally { t.cleanup(); }
});

// ── hardening (review 2026-09-28) ──
test("concurrent_starts_cannot_both_pass_the_cap", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        const [a, b] = await Promise.all([
            t.power("tadmin", { server: id(U.abiotic), action: "start" }),
            t.power("tadmin", { server: id(U.palworld), action: "start" }),
        ]);
        const codes = [a.statusCode, b.statusCode].sort();
        assert.deepEqual(codes, [200, 409], "one slot left: exactly one start gets it");
        assert.equal([a, b].find((r) => r.statusCode === 409).body.code, "cap");
        assert.equal(t.panel.calls.filter((c) => / start$/.test(c)).length, 1);
    } finally { t.cleanup(); }
});

test("a_server_whose_state_cannot_be_read_blocks_starts_not_stops", async () => {
    const t = service({ [id(U.valheim)]: "running", [id(U.palworld)]: new Error("wings down") });
    try {
        const r = await t.power("tadmin", { server: id(U.abiotic), action: "start" });
        assert.deepEqual([r.statusCode, r.body.code], [409, "panel"]);
        assert.match(r.body.error, /^Couldn't read Palworld right now/);
        assert.equal((await t.power("tadmin", { server: id(U.valheim), action: "stop" })).statusCode, 200, "a stop needs no capacity");
    } finally { t.cleanup(); }
});

test("a_configured_server_missing_from_the_panel_blocks_starts", async () => {
    const cfg = structuredClone(CONFIG);
    cfg.servers.push({ uuid: "11111111-2222-3333-4444-555555555555", kind: "satisfactory", game: "Satisfactory" });
    const t = service({}, { config: cfg });
    try {
        const r = await t.power("tadmin", { server: id(U.abiotic), action: "start" });
        assert.deepEqual([r.statusCode, r.body.code], [409, "panel"]);
        assert.match(readFileSync(t.logFile, "utf8"), /configured server 11111111 is not in the panel's list/);
    } finally { t.cleanup(); }
});

test("invalid_requests_are_filed_without_echoing_them_and_429s_are_not_filed", async () => {
    const t = service({});
    try {
        await t.power("tadmin", { server: "8e6c2f05\n2026-01-01T00:00:00Z power @owner fake", action: "start" });
        await t.power("tadmin", { server: id(U.abiotic), action: "st\nart" });
        for (let i = 0; i < GS.POWER_PER_MIN; i++) await t.power("tmember", { server: id(U.abiotic), action: "start" });
        const log = readFileSync(t.logFile, "utf8");
        assert.ok(!/fake|st\nart/.test(log), "nothing from the body is written unvalidated");
        assert.equal((log.match(/\(invalid request\) -> 400/g) || []).length, 2);
        const lines = log.trim().split("\n").length;
        for (let i = 0; i < 5; i++) assert.equal((await t.power("tmember", { server: id(U.abiotic), action: "start" })).statusCode, 429);
        assert.equal(readFileSync(t.logFile, "utf8").trim().split("\n").length, lines, "a flood of 429s never grows the log");
    } finally { t.cleanup(); }
});

test("config_errors_never_quote_the_file", () => {
    const text = '{"v":1,"space":"!s:x","servers":[{"joinPasswordText":"hunter2", }]}';
    try { parseConfig(text); assert.fail("should throw"); } catch (e) { assert.ok(!/hunter2/.test(e.message), e.message); assert.match(e.message, /^not JSON/); }
});

test("status_requests_at_cache_expiry_share_one_space_read", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        await t.status("tmember");
        t.now.advance(GS.SPACE_TTL_MS + 1);
        const before = t.calls.filter((c) => c.includes("/state")).length;
        await Promise.all([t.status("tmember"), t.status("tadmin"), t.status("tmember")]);
        assert.equal(t.calls.filter((c) => c.includes("/state")).length, before + 1);
    } finally { t.cleanup(); }
});

test("every_panel_call_spends_one_budget", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        await t.status("tmember");
        // forced refreshes inside one minute (each: 5 resources; the list and schedules are cached)
        for (let i = 0; i < 40; i++) await t.g._snapshot(0).catch(() => null);
        assert.ok(t.panel.calls.length <= GS.PANEL_PER_MIN, `≤ ${GS.PANEL_PER_MIN} panel calls a minute (made ${t.panel.calls.length})`);
        const s = await t.g._snapshot(0).catch(() => null);
        assert.equal(s?.stale, true, "past the budget the last snapshot is served, stale");
        t.now.advance(60_001);
        const before = t.panel.calls.length;
        assert.equal((await t.g._snapshot(0)).stale, undefined, "a new minute, a new budget");
        assert.ok(t.panel.calls.length > before);
    } finally { t.cleanup(); }
});

test("a_switch_keeps_its_reservations_past_the_pending_timeout", async () => {
    const t = service({ [id(U.valheim)]: "running", [id(U.pz)]: "running" });
    try {
        assert.equal((await t.power("tadmin", { server: id(U.abiotic), action: "start", stopFirst: id(U.valheim) })).statusCode, 202);
        t.now.advance(GS.PENDING_MAX_MS + 1);                      // the job is still waiting for Valheim to stop
        t.now.advance(GS.SNAP_TTL_MS + 1);
        const mid = (await t.status("tmember")).body;
        assert.equal(mid.servers.find((x) => x.id === id(U.abiotic)).pending.queued, true, "still reserved");
        const r = await t.power("tadmin", { server: id(U.palworld), action: "start" });
        assert.equal(r.body.code, "cap", "the queued start still holds its place");
    } finally { t.cleanup(); }
});

test("config_removed_means_off_and_back_means_on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-cfg-"));
    const cfgPath = join(dir, "gameservers.json");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync(cfgPath, JSON.stringify(CONFIG));
    const now = clock(1_000_000);
    const { hs } = scripted();
    const g = createGameServers({ auth: createMatrixAuth({ hs, now }), hs, adminToken: "admintoken", configPath: cfgPath, key: "k", panel: fakePanel({}), now, log: () => {}, logFile: null, WebSocketImpl: null });
    try {
        assert.equal((await call(g.status, { headers: bearer("tmember") })).statusCode, 200);
        unlinkSync(cfgPath);
        now.advance(GS.CONFIG_CHECK_MS + 1);
        const off = await call(g.status, { headers: bearer("tmember") });
        assert.deepEqual([off.statusCode, off.body.code], [503, "off"]);
        writeFileSync(cfgPath, JSON.stringify(CONFIG));
        now.advance(GS.CONFIG_CHECK_MS + 1);
        assert.equal((await call(g.status, { headers: bearer("tmember") })).statusCode, 200);
    } finally { g.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a_console_that_never_pauses_cannot_hold_the_replay_open_or_grow_it", async () => {
    FakeWs.all = [];
    const t = service({ [id(U.valheim)]: "running" }, { WebSocketImpl: FakeWs });
    try {
        await t.status("tmember");
        await new Promise((r) => setTimeout(r, 20));
        const ws = FakeWs.all[0];
        ws.emit("auth success");
        const tr = t.g._trackers.get(id(U.valheim));
        for (let i = 0; i < 3 * GS.BUFFER_LINES; i++) ws.emit("console output", `line ${i}`);
        assert.ok(tr.replay.length <= GS.BUFFER_LINES, "the replay is capped");
        t.now.advance(GS.REPLAY_MAX_MS + 1);
        ws.emit("console output", "one more");                   // re-arms with the deadline passed → ends at once
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(tr.replay, null, "ended by its deadline");
        for (let i = 0; i < 3 * GS.BUFFER_LINES; i++) ws.emit("console output", `live ${i}`);
        assert.ok(tr.lines.length <= 2 * GS.BUFFER_LINES, "live lines trimmed in batches");
        assert.deepEqual(tr.players(), { count: 0, names: [] });
    } finally { t.cleanup(); }
});

// ── the shared plan vectors (docs/GAMESERVERS.md §3.4): the server's rules = both apps' preview ──
test("plan_vectors_agree_with_the_server_rules", () => {
    // the shared vectors (the desktop repo's crates/widgets/testvectors/widgets/gameservers, copied here)
    const file = new URL("./vectors/gameservers/plan.json", import.meta.url);
    const { cases } = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(cases.length > 100);
    for (const [i, c] of cases.entries()) {
        const raw = Array.isArray(c.status.servers) ? c.status.servers : [];
        const seen = new Set();
        const servers = [];
        for (const s of raw) {
            if (!s || typeof s !== "object" || typeof s.id !== "string" || !/^[0-9a-f]{8}$/.test(s.id) || seen.has(s.id)) continue;
            seen.add(s.id);
            servers.push({
                id: s.id, name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : s.id,
                state: ["running", "starting", "stopping", "offline"].includes(s.state) ? s.state : "offline",
                unavailable: typeof s.unavailable === "string" && s.unavailable ? s.unavailable : null,
                memoryLimitMB: Number.isFinite(s.memory?.limitMB) && s.memory.limitMB >= 0 ? Math.floor(s.memory.limitMB + 0.5) : 0,
                pending: s.pending && ["start", "stop", "restart"].includes(s.pending.action) ? { action: s.pending.action } : null,
            });
        }
        const cap = Number.isInteger(c.status.cap) && c.status.cap >= 1 && c.status.cap <= 8 ? c.status.cap : 2;
        const budgetMB = Number.isFinite(c.status.memoryBudgetMB) && c.status.memoryBudgetMB >= 0 ? Math.floor(c.status.memoryBudgetMB + 0.5) : 0;
        const p = planPower({ servers, target: c.target, action: "start", stopFirst: c.first, cap, budgetMB });
        const got = p.ok ? { kind: "ok" }
            : p.code === "unknown" ? { kind: "unknown" }
            : p.code === "cap" ? { kind: "cap", running: p.running }
            : p.code === "memory" ? { kind: "memory", needMB: p.needMB, freeMB: p.freeMB, text: p.error }
            : { kind: "refused", text: p.error };
        assert.deepEqual(got, c.expect, `plan.json #${i}`);
    }
});

// ── second review ──
test("a_reload_never_serves_the_previous_configs_servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-rl-"));
    const cfgPath = join(dir, "gameservers.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cfgPath, JSON.stringify(CONFIG));
    const now = clock(1_000_000);
    const { hs } = scripted();
    const g = createGameServers({ auth: createMatrixAuth({ hs, now }), hs, adminToken: "admintoken", configPath: cfgPath, key: "k", panel: fakePanel({}), now, log: () => {}, logFile: null, WebSocketImpl: null });
    try {
        const a = await call(g.status, { headers: bearer("tmember") });
        assert.equal(a.body.servers.length, 5);
        // the operator drops Palworld (and its password) from the config: the next answer never carries it
        const next = structuredClone(CONFIG);
        next.servers = next.servers.filter((x) => x.kind !== "palworld");
        writeFileSync(cfgPath, JSON.stringify(next));
        now.advance(GS.CONFIG_CHECK_MS + 1);                       // well inside the snapshot's 10 s
        const b = await call(g.status, { headers: bearer("tmember") });
        assert.equal(b.statusCode, 200);
        assert.equal(b.body.servers.length, 4);
        assert.ok(!JSON.stringify(b.body).includes("pal-pw"));
    } finally { g.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a_start_without_an_answer_keeps_its_reservation", async () => {
    const t = service({ [id(U.valheim)]: "running" });
    try {
        const orig = t.panel.power;
        t.panel.power = async (sid, signal) => { t.panel.calls.push(`power ${sid} ${signal}`); throw new Error("The operation was aborted due to timeout"); };
        const r = await t.power("tadmin", { server: id(U.abiotic), action: "start" });
        assert.deepEqual([r.statusCode, r.body.code], [502, "panel"]);
        assert.match(r.body.error, /didn't answer/);
        t.panel.power = orig;
        const r2 = await t.power("tadmin", { server: id(U.palworld), action: "start" });
        assert.equal(r2.body.code, "cap", "the uncertain start still holds its place");
        // a definite refusal gives it back
        const t2 = service({ [id(U.valheim)]: "running", powerError: true });
        try {
            assert.equal((await t2.power("tadmin", { server: id(U.abiotic), action: "start" })).statusCode, 502);
            t2.panel.states.powerError = false;
            assert.equal((await t2.power("tadmin", { server: id(U.palworld), action: "start" })).statusCode, 200);
        } finally { t2.cleanup(); }
    } finally { t.cleanup(); }
});

test("a_second_switch_does_not_strip_the_first_ones_reservations", async () => {
    // cap 3 so two switches can run at once (with cap 2 the second is refused: both places are held)
    const t = service({ [id(U.valheim)]: "running", [id(U.pz)]: "running" }, { config: { ...CONFIG, cap: 3 } });
    try {
        assert.equal((await t.power("tadmin", { server: id(U.abiotic), action: "start", stopFirst: id(U.valheim) })).statusCode, 202);
        const r = await t.power("tadmin", { server: id(U.palworld), action: "start", stopFirst: id(U.pz) });
        assert.equal(r.statusCode, 202);
        t.now.advance(GS.PENDING_MAX_MS + 1);
        t.now.advance(GS.SNAP_TTL_MS + 1);
        const b = (await t.status("tmember")).body;
        assert.equal(b.servers.find((x) => x.id === id(U.abiotic)).pending?.queued, true, "job 1 still owns its start");
        assert.equal(b.servers.find((x) => x.id === id(U.palworld)).pending?.queued, true, "job 2 too");
    } finally { t.cleanup(); }
});

test("the_websocket_token_cooldown_outlives_a_tracker", async () => {
    FakeWs.all = [];
    const t = service({ [id(U.valheim)]: "running" }, { WebSocketImpl: FakeWs });
    try {
        await t.status("tmember");
        await new Promise((r) => setTimeout(r, 20));
        const tokens = () => t.panel.calls.filter((c) => c.startsWith("ws ")).length;
        assert.equal(tokens(), 1);
        // the server stops and starts again within 30 s: the new tracker waits for the cooldown
        t.panel.states[id(U.valheim)] = "offline";
        t.now.advance(GS.SNAP_TTL_MS + 1);
        await t.status("tmember");
        t.panel.states[id(U.valheim)] = "running";
        t.now.advance(GS.SNAP_TTL_MS + 1);
        await t.status("tmember");
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(tokens(), 1, "no second token inside 30 s");
    } finally { t.cleanup(); }
});

test("a new config re-reads the key: an old key never goes to a new panel address (review G2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-key-"));
    const cfgPath = join(dir, "gameservers.json"), keyPath = join(dir, "pelican.key");
    const { writeFileSync, utimesSync } = await import("node:fs");
    const cfg = (url) => JSON.stringify({ ...CONFIG, panel: { ...CONFIG.panel, url } });
    writeFileSync(cfgPath, cfg("http://panel-a.example.org")); writeFileSync(keyPath, "pacc_oldkey000000000000\n");
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push([new URL(url).host, init.headers.Authorization]); return { ok: false, status: 500, text: async () => "" }; };
    const now = clock(1_000_000);
    const { hs } = scripted();
    const g = createGameServers({ auth: createMatrixAuth({ hs, now }), hs, adminToken: "admintoken", configPath: cfgPath, keyPath, fetchImpl, now, log: () => {}, logFile: null, WebSocketImpl: null });
    try {
        await call(g.status, { headers: bearer("tmember") });
        assert.deepEqual(seen.at(-1), ["panel-a.example.org", "Bearer pacc_oldkey000000000000"]);
        writeFileSync(keyPath, "pacc_newkey000000000000\n");                 // the dashboard: the key first, then the config
        writeFileSync(cfgPath, cfg("http://panel-b.example.org"));
        utimesSync(cfgPath, new Date(), new Date(Date.now() + 5000));       // a different mtime, whatever the clock's grain
        now.advance(Math.max(GS.CONFIG_CHECK_MS, GS.SNAP_TTL_MS) + 1);      // past the failure's pause, well inside the key's minute
        await call(g.status, { headers: bearer("tmember") });
        const toB = seen.filter(([host]) => host === "panel-b.example.org");
        assert.ok(toB.length > 0, "the new panel was asked");
        assert.ok(toB.every(([, auth]) => auth === "Bearer pacc_newkey000000000000"), "only with the new key");
    } finally { g.close(); rmSync(dir, { recursive: true, force: true }); }
});
