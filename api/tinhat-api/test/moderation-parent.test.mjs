// moderation.mjs — which spaces govern a call (security review 2026-10-26, M4, and the second review): nobody below the
// call room's authority may change which policy applies (re-sending or clearing a parent link changes nothing), nobody
// may bring in a space of their own, a bound space that can't be read refuses (never falls back), several bound spaces
// must all allow, and a roles rank never beats the call room's power levels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { callModerationDecision, canonicalJson, contentIntact, installModeration } from "../moderation.mjs";
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
function world(rooms, events = {}) {
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
            const fe = /^\/_synapse\/admin\/v1\/fetch_event\/([^/]+)$/.exec(path);
            const cx = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/context\/([^/?]+)\?limit=0$/.exec(path);
            if (fe || cx) {
                const e = events[decodeURIComponent((fe || cx)[fe ? 1 : 2])];
                if (!e) return { ok: false, status: 404, body: {} };
                if (e.status) return { ok: false, status: e.status, body: {} };
                const { _redacted_because: rb, _pruned: pruned, ...raw } = e;
                if (pruned) raw.content = {};
                if (fe) return { ok: true, status: 200, body: { event: raw } };
                if (decodeURIComponent(cx[1]) !== raw.room_id) return { ok: false, status: 404, body: {} };
                const { hashes: _h, signatures: _s, ...client } = raw;
                if (rb) { client.content = {}; client.unsigned = { ...(client.unsigned || {}), redacted_because: rb }; }
                return { ok: true, status: 200, body: { event: client } };
            }
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
async function inWorld(rooms, fn, events) {
    const w = world(rooms, events);
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
    const unlink = { ...parent(SPACE, {}, OWNER), event_id: "$owner-unlinks", room_id: CALL };
    await inWorld({ [CALL]: callRoom(unlink), [SPACE]: ownerSpace(child(CALL, VIA)) }, async (w) => {
        const r = await w.act(ALICE, BOB, "mute");
        assert.deepEqual([r.statusCode, r.body.rolesActive], [200, false]);
    }, { "$owner-unlinks": hashed(unlink, "1") });
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

test("room v1–11 with NO m.room.power_levels: the creator is at 100, everyone else at 0 (spec fallback; 0.3.16)", async () => {
    const R = "!nopl:example.org";
    const create = (content) => ev("m.room.create", "", content, OWNER);
    // v1–10 name the creator in `creator`; v11 dropped it (the create event's sender); a v11 `creator` field means nothing
    const cases = [
        ["1", create({ creator: OWNER })], ["10", create({ room_version: "10", creator: OWNER })],
        ["10, no creator field", create({ room_version: "10" })], ["11", create({ room_version: "11" })],
        ["11 + a planted creator field", create({ room_version: "11", creator: ALICE })],
    ];
    for (const [label, c] of cases) {
        await inWorld({ [R]: [c, ...joined(OWNER, MOD, ALICE, BOB)] }, async (w) => {
            const r = await w.act(OWNER, ALICE, "mute", R);
            assert.deepEqual([r.statusCode, r.body.rolesActive], [200, false], `${label}: ${JSON.stringify(r.body)}`);
            assert.equal((await w.act(ALICE, BOB, "mute", R)).statusCode, 403, `${label}: others are at 0`);
            assert.equal((await w.act(ALICE, OWNER, "mute", R)).statusCode, 403, `${label}: nobody moderates the creator`);
        });
    }
    // the shared rank rule (the call-token side asks it for raw mute records): the creator's record counts
    const st = [create({ room_version: "11" }), ...joined(OWNER, ALICE)];
    assert.equal((await callModerationDecision(R, st, OWNER, ALICE, async () => null)).allowed, true);
    assert.equal((await callModerationDecision(R, st, ALICE, OWNER, async () => null)).allowed, false);
    // the creator has the room's authority, so their parent link binds the space (its roles let MOD act)
    const space = [pl({ [OWNER]: 100 }), ...joined(OWNER, MOD), child(R, VIA),
        ...roles({ mods: { rank: 50, permissions: ["moderate_calls"] } }, { [MOD]: ["mods"] })];
    await inWorld({ [R]: [create({ room_version: "10", creator: OWNER }), ...joined(OWNER, MOD, ALICE, BOB),
        parent(SPACE, VIA, OWNER)], [SPACE]: space }, async (w) => {
        const r = await w.act(MOD, BOB, "mute", R);
        assert.deepEqual([r.statusCode, r.body.rolesActive], [200, true], JSON.stringify(r.body));
    });
    // controls: a power_levels event, even an empty one, ends the fallback (the creator is what it says: 0); a v12 room
    // keeps its own creator rule (unlimited, never moderated)
    await inWorld({ [R]: [create({ room_version: "10", creator: OWNER }), ev("m.room.power_levels", "", {}),
        ...joined(OWNER, ALICE)] }, async (w) => {
        assert.equal((await w.act(OWNER, ALICE, "mute", R)).statusCode, 403);
    });
    await inWorld({ [R]: [create({ room_version: "12" }), ...joined(OWNER, ALICE)] }, async (w) => {
        assert.equal((await w.act(OWNER, ALICE, "mute", R)).statusCode, 200);
        assert.equal((await w.act(ALICE, OWNER, "mute", R)).statusCode, 403);
    });
});

// ---- PAD-5 (0.3.16): who set a parent link is read from its history ---------------------------------------------------
// A space run by someone else (OTHER; the room's owner has no say in it): the owner bound the call room to it. ALICE (PL 50
// in the room, may send m.space.parent) re-sending, clearing or redacting that link used to make her its setter, so the
// link counted as hers, the space didn't govern (not run by the room) and her room power level let her moderate BOB.
const OTHER = "@other:example.org";
const otherSpace = () => [pl({ [OTHER]: 100 }), ...joined(OTHER, ALICE, MOD), child(CALL, VIA, OTHER),
    ...roles({ helper: { rank: 50, permissions: ["manage_rooms"] }, mods: { rank: 50, permissions: ["moderate_calls"] } },
        { [ALICE]: ["helper"], [MOD]: ["mods"] })];
const at = (e, id, replaces) => ({ ...e, event_id: id, room_id: CALL, ...(replaces ? { unsigned: { replaces_state: replaces } } : {}) });
const OWNER_LINK = at(parent(SPACE2, VIA, OWNER), "$owner-link");
// a raw (fetch_event) event with its real content hash (room v10 rules: event_id not hashed)
const hashed = (e, version = "10") => {
    const d = { ...e };
    for (const k of ["unsigned", "signatures", "hashes", ...(version === "1" || version === "2" ? [] : ["event_id"])]) delete d[k];
    return { ...e, hashes: { sha256: createHash("sha256").update(canonicalJson(d), "utf8").digest("base64").replace(/=+$/, "") } };
};
const v10 = ev("m.room.create", "", { room_version: "10", creator: OWNER });

test("PAD-5 baseline: the owner's link to a space run by someone else binds it (ALICE denied by its roles)", async () => {
    await inWorld({ [CALL]: callRoom(OWNER_LINK), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 403);
        assert.equal((await w.act(MOD, BOB, "mute")).statusCode, 200);
    });
});

test("PAD-5 ALICE re-sending the owner's link unchanged, clearing it or editing its via: still the owner's binding", async () => {
    const mine = (content, id, replaces) => at(parent(SPACE2, content, ALICE), id, replaces);
    const chains = {
        "re-sent unchanged": [mine(VIA, "$a1", "$owner-link")],
        "cleared": [mine({}, "$a1", "$owner-link")],
        "via edited": [mine({ via: ["elsewhere.example"] }, "$a1", "$owner-link")],
        "re-sent by ALICE, then MOD, then cleared by ALICE": [mine({}, "$a3", "$m2"),
            at(parent(SPACE2, VIA, MOD), "$m2", "$a1"), mine(VIA, "$a1", "$owner-link")],
    };
    for (const [label, [current, ...history]] of Object.entries(chains)) {
        const events = Object.fromEntries([OWNER_LINK, ...history].map((e) => [e.event_id, e]));
        await inWorld({ [CALL]: callRoom(current), [SPACE2]: otherSpace() }, async (w) => {
            const r = await w.act(ALICE, BOB, "mute");
            assert.deepEqual([r.statusCode, r.body.error], [403, "You can't moderate calls in this space"], `${label}: ${JSON.stringify(r.body)}`);
            assert.deepEqual(w.acted, [], `${label}: nothing reached the call server`);
        }, events);
    }
});

test("PAD-5 a redaction counts only by the room's authority (ALICE redacting the owner's link changes nothing)", async () => {
    const redacted = (by) => ({ ...parent(SPACE2, {}, OWNER), event_id: "$owner-link", room_id: CALL,
        unsigned: { redacted_because: { type: "m.room.redaction", sender: by, redacts: "$owner-link" } } });
    const events = { "$owner-link": OWNER_LINK };  // fetch_event (as_is) still holds the original content
    await inWorld({ [CALL]: callRoom(redacted(ALICE)), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 403, "redacted by ALICE: still bound");
    }, events);
    await inWorld({ [CALL]: callRoom(redacted(OWNER)), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 200, "redacted by the owner: a real unlink");
    }, events);
    await inWorld({ [CALL]: callRoom(redacted(ALICE)), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502, "the original is gone: refused, never a fall-back");
        assert.deepEqual(w.acted, []);
    }, { "$owner-link": { ...OWNER_LINK, content: {} } });
});

test("PAD-5 the owner's own later unlink still unlinks; ALICE re-linking after it binds nothing of a space the room doesn't run", async () => {
    const ownerUnlink = at(parent(SPACE2, {}, OWNER), "$owner-unlink", "$owner-link");
    const events = { "$owner-link": OWNER_LINK, "$owner-unlink": hashed(ownerUnlink) };
    await inWorld({ [CALL]: [v10, ...callRoom(ownerUnlink)], [SPACE2]: otherSpace() }, async (w) => {
        assert.deepEqual([(await w.act(ALICE, BOB, "mute")).statusCode], [200]);
    }, events);
    await inWorld({ [CALL]: [v10, ...callRoom(at(parent(SPACE2, VIA, ALICE), "$a1", "$owner-unlink"))], [SPACE2]: otherSpace() }, async (w) => {
        const r = await w.act(ALICE, BOB, "mute");
        assert.deepEqual([r.statusCode, r.body.rolesActive], [200, false], JSON.stringify(r.body));
    }, events);
    // a link nobody with authority ever set (ALICE's from the start, no history): today's rule, unchanged
    await inWorld({ [CALL]: callRoom(at(parent(SPACE2, VIA, ALICE), "$a0")), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 200);
    });
});

test("PAD-5 a history that can't be read, points elsewhere or is too long refuses (502); 64 earlier events are read", async () => {
    const cur = at(parent(SPACE2, VIA, ALICE), "$a1", "$gone");
    await inWorld({ [CALL]: callRoom(cur), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502, "unknown to the homeserver");
    });
    await inWorld({ [CALL]: callRoom(cur), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502, "the read fails");
    }, { "$gone": { status: 500 } });
    for (const wrong of [{ ...OWNER_LINK, state_key: SPACE }, { ...OWNER_LINK, room_id: EVIL }, { ...OWNER_LINK, type: "m.room.topic" }]) {
        await inWorld({ [CALL]: callRoom(cur), [SPACE2]: otherSpace() }, async (w) => {
            assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502, JSON.stringify(wrong));
        }, { "$gone": { ...wrong, event_id: "$gone" } });
    }
    const chain = (n) => {   // the current event + n earlier re-sends by ALICE, then the owner's link
        const evs = {};
        for (let i = n; i >= 1; i--) evs[`$r${i}`] = at(parent(SPACE2, VIA, ALICE), `$r${i}`, i === n ? "$owner-link" : `$r${i + 1}`);
        evs["$owner-link"] = OWNER_LINK;
        return [at(parent(SPACE2, VIA, ALICE), "$r0", n ? "$r1" : "$owner-link"), evs];
    };
    const [c63, e63] = chain(63);
    await inWorld({ [CALL]: callRoom(c63), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 403, "64 reads: the owner's link found, bound");
    }, e63);
    const [c64, e64] = chain(64);
    await inWorld({ [CALL]: callRoom(c64), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502, "longer: refused");
        assert.deepEqual(w.acted, []);
    }, e64);
});

test("PAD-5 content hashes: Synapse's own signing vectors (room v1), and a pruned event no longer matches", () => {
    const minimal = { event_id: "$0:domain", origin_server_ts: 1000000, signatures: {}, type: "X", unsigned: { age_ts: 1000000 },
        hashes: { sha256: "A6Nco6sqoy18PPfPDVdYvoowfc0PVBk9g9OiyT3ncRM" } };
    const message = { content: { body: "Here is the message content" }, event_id: "$0:domain", origin_server_ts: 1000000,
        type: "m.room.message", room_id: "!r:domain", sender: "@u:domain", signatures: {}, unsigned: { age_ts: 1000000 },
        hashes: { sha256: "rDCeYBepPlI891h/RkI2/Lkf9bt7u0TxFku4tMs7WKk" } };
    assert.equal(contentIntact(minimal, "1"), true);
    assert.equal(contentIntact(message, "1"), true);
    assert.equal(contentIntact({ ...message, content: {} }, "1"), false, "pruned content");
    assert.equal(contentIntact(message, "10"), false, "v3+: event_id isn't part of the hashed event");
    assert.equal(contentIntact({ ...message, hashes: {} }, "1"), false, "no hash: unproven");
    assert.equal(canonicalJson({ b: 1, a: [true, null, "é\n"] }), '{"a":[true,null,"é\\n"],"b":1}');
});

test("PAD-5 an owner event in the history that reads as 'no link' is an unlink only if its content hash proves it", async () => {
    const unlink = { ...parent(SPACE2, {}, OWNER), event_id: "$owner-unlink", room_id: CALL };
    const cur = at(parent(SPACE2, VIA, ALICE), "$a1", "$owner-unlink");
    await inWorld({ [CALL]: [v10, ...callRoom(cur)], [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 200, "a real unlink: ALICE's re-link binds nothing");
    }, { "$owner-unlink": hashed(unlink) });
    // the owner's LINK, pruned by the homeserver after ALICE redacted it (content {}, hash of the original)
    const pruned = { ...hashed({ ...parent(SPACE2, VIA, OWNER), event_id: "$owner-unlink", room_id: CALL }), content: {} };
    await inWorld({ [CALL]: [v10, ...callRoom(cur)], [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502, "pruned: refused, never read as an unlink");
        assert.deepEqual(w.acted, []);
    }, { "$owner-unlink": pruned });
    // the current owner event redacted by ALICE whose original really was an unlink (hash intact): unlinked
    const redactedUnlink = { ...unlink, unsigned: { redacted_because: { type: "m.room.redaction", sender: ALICE } } };
    await inWorld({ [CALL]: [v10, ...callRoom(redactedUnlink)], [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 200);
    }, { "$owner-unlink": hashed(unlink) });
});

test("PAD-5 the owner redacting ALICE's current re-send is the owner's unlink", async () => {
    const resend = { ...at(parent(SPACE2, {}, ALICE), "$a1", "$owner-link"),
        unsigned: { replaces_state: "$owner-link", redacted_because: { type: "m.room.redaction", sender: OWNER } } };
    await inWorld({ [CALL]: callRoom(resend), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 200);
    }, { "$owner-link": OWNER_LINK });
    // control: ALICE redacting her own re-send changes nothing (the owner's link still binds)
    const own = { ...resend, unsigned: { replaces_state: "$owner-link", redacted_because: { type: "m.room.redaction", sender: ALICE } } };
    await inWorld({ [CALL]: callRoom(own), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 403);
    }, { "$owner-link": OWNER_LINK });
});

test("PAD-5 one decision reads at most 128 history events over all of a room's links", async () => {
    const chainTo = (space, tag, n) => {   // the current event + n earlier re-sends by ALICE, then the owner's link
        const evs = {}, top = at(parent(space, VIA, OWNER), `$${tag}-owner`);
        for (let i = n; i >= 1; i--) evs[`$${tag}${i}`] = at(parent(space, VIA, ALICE), `$${tag}${i}`, i === n ? top.event_id : `$${tag}${i + 1}`);
        evs[top.event_id] = top;
        return [at(parent(space, VIA, ALICE), `$${tag}0`, n ? `$${tag}1` : top.event_id), evs];
    };
    const [c1, e1] = chainTo(SPACE2, "x", 63), [c2, e2] = chainTo(SPACE, "y", 63), [c3, e3] = chainTo(EVIL, "z", 0);
    await inWorld({ [CALL]: callRoom(c1, c2), [SPACE2]: otherSpace(), [SPACE]: ownerSpace(child(CALL, VIA)) }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 403, "128 reads: both links found, bound");
    }, { ...e1, ...e2 });
    await inWorld({ [CALL]: callRoom(c1, c2, c3), [SPACE2]: otherSpace(), [SPACE]: ownerSpace(child(CALL, VIA)) }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502, "129: refused");
    }, { ...e1, ...e2, ...e3 });
});

test("PAD-5 canonical JSON sorts keys by code point (an independently made hash: Python's json, sort_keys)", () => {
    const e = { type: "m.space.parent", state_key: "!space2:example.org", room_id: "!call:example.org", sender: "@owner:example.org",
        origin_server_ts: 1700000000000, depth: 12, prev_events: ["$p"], auth_events: ["$a"],
        content: { "": 1, "\u{10000}": 2, via: [] }, event_id: "$not-hashed", hashes: { sha256: "nOcUv9g9xBcBrDQzpv6GQL8mAXCeUQw8/DefHFdeBTE" } };
    assert.equal(contentIntact(e, "10"), true, "U+10000 sorts after U+E000 (UTF-16 order would put it first)");
});

test("PAD-5 the CURRENT owner event reading as 'no link' is an unlink only with an intact hash (a pruned copy refuses)", async () => {
    const link = { ...parent(SPACE2, VIA, OWNER), event_id: "$owner-cur", room_id: CALL };
    const prunedCopy = { ...hashed(link), content: {} };           // arrived pruned: no redaction marker anywhere
    await inWorld({ [CALL]: [v10, ...callRoom(prunedCopy)], [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 502);
        assert.deepEqual(w.acted, []);
    }, { "$owner-cur": prunedCopy });
    const unlink = hashed({ ...parent(SPACE2, {}, OWNER), event_id: "$owner-cur", room_id: CALL });
    await inWorld({ [CALL]: [v10, ...callRoom(unlink)], [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 200, "a real unlink");
    }, { "$owner-cur": unlink });
});

test("PAD-5 an owner redaction in the history is the owner's unlink: ALICE re-sending after it brings nothing back", async () => {
    // owner links -> ALICE re-sends -> the owner redacts ALICE's event -> ALICE re-sends again
    const a1 = { ...at(parent(SPACE2, VIA, ALICE), "$a1", "$owner-link"), _redacted_because: { type: "m.room.redaction", sender: OWNER } };
    const a2 = at(parent(SPACE2, VIA, ALICE), "$a2", "$a1");
    await inWorld({ [CALL]: callRoom(a2), [SPACE2]: otherSpace() }, async (w) => {
        const r = await w.act(ALICE, BOB, "mute");
        assert.deepEqual([r.statusCode, r.body.rolesActive], [200, false], JSON.stringify(r.body));
    }, { "$owner-link": OWNER_LINK, "$a1": a1 });
    // the owner redacting their OWN old link, then ALICE re-sending its content: unlinked too
    const own = { ...OWNER_LINK, _redacted_because: { type: "m.room.redaction", sender: OWNER } };
    await inWorld({ [CALL]: callRoom(at(parent(SPACE2, VIA, ALICE), "$a1", "$owner-link")), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 200);
    }, { "$owner-link": own });
    // control: ALICE redacting the owner's old link changes nothing (its original is read back)
    const byAlice = { ...OWNER_LINK, _redacted_because: { type: "m.room.redaction", sender: ALICE } };
    await inWorld({ [CALL]: callRoom(at(parent(SPACE2, VIA, ALICE), "$a1", "$owner-link")), [SPACE2]: otherSpace() }, async (w) => {
        assert.equal((await w.act(ALICE, BOB, "mute")).statusCode, 403);
    }, { "$owner-link": byAlice });
});
