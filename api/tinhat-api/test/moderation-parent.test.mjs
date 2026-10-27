// moderation.mjs — which spaces govern a call (security review 2026-10-26, M4, and the second review): nobody below the
// call room's authority may change which policy applies (re-sending or clearing a parent link changes nothing), nobody
// may bring in a space of their own, a bound space that can't be read refuses (never falls back), several bound spaces
// must all allow, and a roles rank never beats the call room's power levels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installModeration } from "../moderation.mjs";
import { fakeReq, fakeRes } from "./helpers.mjs";

const b64u = (s) => Buffer.from(s).toString("base64url");
const OWNER = "@owner:example.org", MOD = "@mod:example.org", ALICE = "@alice:example.org", BOB = "@bob:example.org";
const CALL = "!call:example.org", EVIL = "!evil:example.org", SPACE = "!space:example.org", SPACE2 = "!space2:example.org";
const VIA = { via: ["example.org"] };

const ev = (type, state_key, content, sender = OWNER) => ({ type, state_key, content, sender });
const pl = (users, extra = {}) => ev("m.room.power_levels", "", { users, users_default: 0, state_default: 50,
    events: { "m.room.power_levels": 100, "m.space.child": 50, "m.space.parent": 50 }, ...extra });
const joined = (...who) => who.map((u) => ev("m.room.member", u, { membership: "join" }, u));
const roles = (defs, members) => [
    ev("dev.tinhat.role", "everyone", { name: "Everyone", rank: 0, permissions: [] }),
    ...Object.entries(defs).map(([id, d]) => ev("dev.tinhat.role", id, { name: id, ...d })),
    ...Object.entries(members).map(([mxid, list]) => ev("dev.tinhat.member_roles", mxid.slice(1), { roles: list })),
];
const parent = (space, content, sender) => ev("m.space.parent", space, content, sender);
const child = (room, content, sender = OWNER) => ev("m.space.child", room, content, sender);

/** Rooms by id (an object {status} for a room whose read fails); returns act(me, target, action, room). */
function world(rooms) {
    const routes = new Map();
    const app = { post: (path, ...chain) => routes.set(path, chain) };
    const acted = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const method = String(url).split("/").pop();
        const body = JSON.parse(init.body);
        if (method === "ListParticipants") return { ok: true, status: 200, text: async () => JSON.stringify({ participants:
            [OWNER, MOD, ALICE, BOB].map((u) => ({ identity: `${u}:DEV`, tracks: [{ type: "AUDIO", sid: "TR" }], permission: {} })) }) };
        acted.push([method, body.identity]);
        return { ok: true, status: 200, text: async () => "{}" };
    };
    installModeration(app, {
        requireMatrixUser: (req, _res, next) => { req.matrixUser = req.headers["x-user"]; return next(); },
        synapse: async (path) => {
            const m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/state$/.exec(path);
            const id = m && decodeURIComponent(m[1]);
            if (!id || !(id in rooms)) return { ok: false, status: 404, body: {} };
            if (!Array.isArray(rooms[id])) return { ok: false, status: rooms[id].status, body: {} };
            return { ok: true, status: 200, body: { state: rooms[id] } };
        },
        adminToken: "a", lkApiUrl: "http://lk.invalid", lkKey: "k", lkSecret: "s", b64u, createHmac, log: () => {},
    });
    async function act(me, target, action = "disconnect", room = CALL) {
        const req = fakeReq({ method: "POST", headers: { "x-user": me } });
        req.body = { room_id: room, action, target: `${target}:DEV` };
        const res = fakeRes();
        const chain = routes.get("/moderation/call");
        let i = 0;
        const next = async () => { const h = chain[i++]; if (h) await h(req, res, next); };
        await next();
        return res;
    }
    return { act, acted, restore: () => { globalThis.fetch = real; } };
}
async function inWorld(rooms, fn) {
    const w = world(rooms);
    try { await fn(w); } finally { w.restore(); }
}

// The call room: the owner runs it (100), ALICE and MOD are room moderators (50: the room's power levels alone would
// let them act on BOB at 0).
const callRoom = (...links) => [pl({ [OWNER]: 100, [ALICE]: 50, [MOD]: 50 }), ...joined(OWNER, MOD, ALICE, BOB), ...links];
// The owner's space: roles set up; ALICE has a role WITHOUT moderate_calls, MOD one with it.
const ownerSpace = (...extra) => [pl({ [OWNER]: 100 }), ...joined(OWNER, ALICE, MOD),
    ...roles({ helper: { rank: 50, permissions: ["manage_rooms"] }, mods: { rank: 50, permissions: ["moderate_calls"] } },
        { [ALICE]: ["helper"], [MOD]: ["mods"] }), ...extra];

test("baseline: the owner's space governs, and denies ALICE (no moderate_calls) although the room's power levels would allow", async () => {
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, OWNER)), [SPACE]: ownerSpace(child(CALL, VIA)) }, async (w) => {
        const r = await w.act(ALICE, BOB);
        assert.deepEqual([r.statusCode, r.body.error], [403, "You can't moderate calls in this space"]);
        const ok = await w.act(MOD, BOB, "mute");
        assert.deepEqual([ok.statusCode, ok.body.rolesActive], [200, true]);
    });
});

test("ALICE re-sends the parent link (same content, now hers): the space still governs", async () => {
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, ALICE)), [SPACE]: ownerSpace(child(CALL, VIA)) }, async (w) => {
        const r = await w.act(ALICE, BOB);
        assert.equal(r.statusCode, 403, JSON.stringify(r.body));
        assert.deepEqual(w.acted, [], "nothing reached the call server");
    });
});

test("ALICE clears the parent link (empty content): the space still governs, listed by the space or not", async () => {
    for (const spaceSide of [[child(CALL, VIA)], [], [child(CALL, {}, ALICE)]]) {
        await inWorld({ [CALL]: callRoom(parent(SPACE, {}, ALICE)), [SPACE]: ownerSpace(...spaceSide) }, async (w) => {
            const r = await w.act(ALICE, BOB);
            assert.equal(r.statusCode, 403, `space side ${JSON.stringify(spaceSide.map((e) => e.content))}: ${JSON.stringify(r.body)}`);
        });
    }
});

test("the owner unlinking (their own empty parent link) really unlinks: the room's power levels decide", async () => {
    await inWorld({ [CALL]: callRoom(parent(SPACE, {}, OWNER)), [SPACE]: ownerSpace(child(CALL, VIA)) }, async (w) => {
        const r = await w.act(ALICE, BOB, "mute");
        assert.deepEqual([r.statusCode, r.body.rolesActive], [200, false]);
    });
});

test("a space of ALICE's own (she runs it, the room's owner isn't in it) never governs, back-link and top role or not", async () => {
    const evil = [pl({ [ALICE]: 100, [OWNER]: 100 }), ...joined(ALICE), child(CALL, VIA, ALICE),
        ...roles({ boss: { rank: 100, permissions: ["moderate_calls"] } }, { [ALICE]: ["boss"] })];
    await inWorld({ [CALL]: callRoom(parent(EVIL, VIA, ALICE)), [EVIL]: evil }, async (w) => {
        const r = await w.act(ALICE, MOD);
        assert.equal(r.statusCode, 403, "her role would rank her above MOD; the room's power levels don't");
        const ok = await w.act(ALICE, BOB, "mute");
        assert.deepEqual([ok.statusCode, ok.body.rolesActive], [200, false], "the room's power levels, as before her space");
    });
    // ... nor does adding it next to the owner's space loosen or block anything
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, OWNER), parent(EVIL, VIA, ALICE)), [SPACE]: ownerSpace(child(CALL, VIA)), [EVIL]: evil }, async (w) => {
        assert.equal((await w.act(ALICE, BOB)).statusCode, 403);
        assert.equal((await w.act(MOD, BOB, "mute")).statusCode, 200, "her space can't veto the owner's moderators either");
    });
});

test("a link set by a role holder below the room's authority binds when the owner's space lists the room", async () => {
    // e.g. a channel made by someone whose role has manage_rooms, whose power level the roles later set to 50
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, MOD)), [SPACE]: ownerSpace(child(CALL, VIA, MOD)) }, async (w) => {
        assert.equal((await w.act(ALICE, BOB)).statusCode, 403);
        assert.equal((await w.act(MOD, BOB, "mute")).body.rolesActive, true);
    });
    // a one-sided link by a moderator (the space doesn't list the room) binds nothing
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, ALICE)), [SPACE]: ownerSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).body.rolesActive, false);
    });
});

test("a bound space that can't be read refuses (502), it never falls back; an unknown one is skipped", async () => {
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, OWNER)), [SPACE]: { status: 500 } }, async (w) => {
        const r = await w.act(ALICE, BOB);
        assert.equal(r.statusCode, 502);
        assert.deepEqual(w.acted, []);
    });
    await inWorld({ [CALL]: callRoom(parent("!elsewhere:other.example", VIA, OWNER), parent("not a room id", VIA, ALICE)) }, async (w) => {
        const r = await w.act(ALICE, BOB, "mute");
        assert.deepEqual([r.statusCode, r.body.rolesActive], [200, false], "the room's power levels");
    });
});

test("several bound spaces: every one must allow", async () => {
    const second = [pl({ [OWNER]: 100 }), ...joined(OWNER, MOD), child(CALL, VIA),
        ...roles({ quiet: { rank: 50, permissions: [] } }, { [MOD]: ["quiet"] })];
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, OWNER), parent(SPACE2, VIA, OWNER)), [SPACE]: ownerSpace(child(CALL, VIA)), [SPACE2]: second }, async (w) => {
        const r = await w.act(MOD, BOB, "mute");
        assert.deepEqual([r.statusCode, r.body.error], [403, "You can't moderate calls in this space"]);
    });
});

test("too many parent links: refused, never a partial read", async () => {
    const many = Array.from({ length: 33 }, (_, i) => parent(`!junk${i}:example.org`, VIA, ALICE));
    await inWorld({ [CALL]: callRoom(...many) }, async (w) => {
        assert.equal((await w.act(MOD, BOB, "mute")).statusCode, 403);
    });
});

test("a roles rank never beats a target at power level 100, nor a higher one", async () => {
    const space = [pl({ [OWNER]: 100 }), ...joined(OWNER), child(CALL, VIA),
        ...roles({ top: { rank: 90, permissions: ["moderate_calls"] }, low: { rank: 10, permissions: [] } }, { [MOD]: ["top"], [OWNER]: ["low"], [ALICE]: ["low"] })];
    await inWorld({ [CALL]: callRoom(parent(SPACE, VIA, OWNER)), [SPACE]: space }, async (w) => {
        assert.equal((await w.act(MOD, OWNER)).statusCode, 403, "rank 90 over rank 10, but the owner is PL 100 in the call room");
        assert.equal((await w.act(MOD, ALICE, "mute")).statusCode, 200, "rank 90 over rank 10 at the same power level (50)");
        assert.deepEqual(w.acted.map(([m]) => m).includes("RemoveParticipant"), false);
    });
    const twoAdmins = [pl({ [OWNER]: 100, [MOD]: 100 }), ...joined(OWNER, MOD, ALICE, BOB), parent(SPACE, VIA, OWNER)];
    await inWorld({ [CALL]: twoAdmins, [SPACE]: space }, async (w) => {
        assert.equal((await w.act(MOD, OWNER, "mute")).statusCode, 403, "two PL-100 admins: a role doesn't let one moderate the other");
    });
});

test("no parent at all: the room's power levels; room v12 ids are accepted", async () => {
    const V12 = "!AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=_-";
    await inWorld({ [V12]: callRoom() }, async (w) => {
        const r = await w.act(ALICE, BOB, "mute", V12);
        assert.deepEqual([r.statusCode, r.body.rolesActive], [200, false], JSON.stringify(r.body));
        assert.equal((await w.act(ALICE, MOD, "mute", V12)).statusCode, 403, "same power level");
    });
});

test("room v12: the creator (and additional_creators) are the room's top authority (review of 116d103, #8)", async () => {
    const V12 = "!AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefgh";
    const create = (version, extra = {}) => ev("m.room.create", "", { room_version: version, ...extra }, OWNER);
    // the creator is never in power_levels in a v12 room; ALICE and MOD at 50
    const v12Room = (version, ...links) => [create(version, { additional_creators: [BOB] }), pl({ [ALICE]: 50, [MOD]: 50 }),
        ...joined(OWNER, MOD, ALICE, BOB), ...links];
    const space = [pl({ [OWNER]: 100 }), ...joined(OWNER, ALICE), child(V12, VIA),
        ...roles({ helper: { rank: 50, permissions: [] } }, { [ALICE]: ["helper"] })];
    // the creator's own link binds (they have the room's authority), so the space denies ALICE although PL 50 would allow
    await inWorld({ [V12]: v12Room("12", parent(SPACE, VIA, OWNER)), [SPACE]: space }, async (w) => {
        assert.equal((await w.act(ALICE, MOD, "mute", V12)).statusCode, 403);
        assert.equal((await w.act(ALICE, OWNER, "mute", V12)).statusCode, 403, "nobody moderates the creator");
    });
    // without a space: the creator moderates anyone (power levels model), creators can't moderate each other
    await inWorld({ [V12]: v12Room("12") }, async (w) => {
        assert.equal((await w.act(OWNER, ALICE, "mute", V12)).statusCode, 200);
        assert.equal((await w.act(OWNER, BOB, "mute", V12)).statusCode, 403, "one creator can't moderate another");
        assert.equal((await w.act(ALICE, OWNER, "mute", V12)).statusCode, 403);
        assert.equal((await w.act(MOD, BOB, "mute", V12)).statusCode, 403, "nor an additional creator");
        assert.equal((await w.act(MOD, ALICE, "mute", V12)).statusCode, 403, "same power level (50)");
    });
    // a v10 room: the creator is whatever power_levels says (here: not listed = 0)
    await inWorld({ [V12]: v12Room("10") }, async (w) => {
        assert.equal((await w.act(OWNER, ALICE, "mute", V12)).statusCode, 403);
    });
});
