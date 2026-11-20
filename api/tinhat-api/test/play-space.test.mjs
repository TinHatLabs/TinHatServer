// play/space.mjs: the game_space + rank_context rules against client-rules.json (with planted wrong rules), the admin
// API allow-list (launch-gate 10:18: read-only GET state lookups only, everything else refused), and resolving a room
// from fake room state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gameSpace, rankContext, checkAllowed, createStateReader, createSpaces } from "../play/space.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const R = JSON.parse(readFileSync(join(HERE, "vectors/play/client-rules.json"), "utf8"));

function runGameSpace(fn) {
    const bad = [];
    for (const c of R.game_space.cases) {
        const got = fn(c.ctx);
        const want = { space: c.expect.space, server: c.expect.server, why: c.expect.why };
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${c.id}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
    return bad;
}

test("game_space: all 24 vectors (server and app mode); rank_context: all 4", () => {
    assert.equal(R.game_space.cases.length, 27);
    assert.deepEqual(runGameSpace(gameSpace), []);
    for (const c of R.rank_context.cases) assert.deepEqual(rankContext(c.surface), c.expect, c.id);
});

test("game_space: planted wrong rules each FAIL the vectors", () => {
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const plants = {
        "child-only fallback": (ctx) => { const r = gameSpace(ctx); if (r.why === "no-space") { const s = Object.entries(ctx.spaces || {}).find(([, v]) => (v.children || []).some((c) => c.room === ctx.room.id)); if (s) return { space: s[0], server: s[1].create_sender.split(":")[1], why: "" }; } return r; },
        "skip an unknown candidate": (ctx) => { const c = clone(ctx); c.room.parents = (c.room.parents || []).filter((p) => c.spaces?.[p.space] && !c.spaces[p.space].partial); return gameSpace(c); },
        "owner from via": (ctx) => { const r = gameSpace(ctx); const p = (ctx.room.parents || []).find((x) => x.space === r.space); return r.space && p ? { ...r, server: p.content.via[0] } : r; },
        "truthy canonical": (ctx) => { const c = clone(ctx); for (const p of c.room.parents || []) if (p.content.canonical) p.content.canonical = true; return gameSpace(c); },
        "no space-type check": (ctx) => { const c = clone(ctx); for (const s of Object.values(c.spaces || {})) s.create_type = "m.space"; return gameSpace(c); },
        "any child link counts": (ctx) => { const c = clone(ctx); for (const sp of Object.values(c.spaces || {})) if ((sp.children || []).length) sp.children = sp.children.map((x) => ({ ...x, room: c.room.id })); return gameSpace(c); },
        "canonical ignored": (ctx) => { const c = clone(ctx); for (const p of c.room.parents || []) delete p.content.canonical; return gameSpace(c); },
        "accept a wrong-server space": (ctx) => { const r = gameSpace(ctx); return r.why === "wrong-server" ? { ...r, why: "" } : r; },
        "plain string order": (ctx) => { const c = clone(ctx); return gameSpace({ ...c, room: { ...c.room, parents: (c.room.parents || []).map((p) => ({ ...p, content: { ...p.content, canonical: undefined } })) } }); },
    };
    for (const [name, fn] of Object.entries(plants)) assert.notDeepEqual(runGameSpace(fn), [], `plant "${name}" passed`);
});

test("canonical must be the literal true (our own case: the shared vectors' one has the string on the LOWER id, so code-point order hides a truthy reading; reported to the PM)", () => {
    const ctx = { mode: "server", decider: "play.test", room: { id: "!r", parents: [{ space: "!A", content: { via: ["play.test"] } }, { space: "!B", content: { via: ["play.test"], canonical: "true" } }] },
        spaces: { "!A": { create_sender: "@x:play.test", create_type: "m.space", children: [{ room: "!r", content: { via: ["play.test"] } }] }, "!B": { create_sender: "@y:play.test", create_type: "m.space", children: [{ room: "!r", content: { via: ["play.test"] } }] } } };
    assert.equal(gameSpace(ctx).space, "!A");
    const truthy = (c) => { const d = JSON.parse(JSON.stringify(c)); for (const p of d.room.parents) if (p.content.canonical) p.content.canonical = true; return gameSpace(d); };
    assert.equal(truthy(ctx).space, "!B", "the plant reads it as canonical (so this case can fail)");
});

test("a candidate that isn't an m.space is skipped (our own case: the shared vectors' non-space sorts AFTER the real space, so dropping the type check passes them; reported)", () => {
    const ctx = { mode: "server", decider: "play.test", room: { id: "!r", parents: [{ space: "!A", content: { via: ["play.test"] } }, { space: "!S", content: { via: ["play.test"] } }] },
        spaces: { "!A": { create_sender: "@x:play.test", create_type: null, children: [{ room: "!r", content: { via: ["play.test"] } }] }, "!S": { create_sender: "@y:play.test", create_type: "m.space", children: [{ room: "!r", content: { via: ["play.test"] } }] } } };
    assert.equal(gameSpace(ctx).space, "!S");
    const noTypeCheck = (c) => { const d = JSON.parse(JSON.stringify(c)); for (const v of Object.values(d.spaces)) v.create_type = "m.space"; return gameSpace(d); };
    assert.equal(noTypeCheck(ctx).space, "!A", "the plant picks the non-space (so this case can fail)");
});

test("the admin API allow-list: GET room state only; any other method or path is refused before a request is made", async () => {
    const calls = [];
    const reader = createStateReader({ call: async (m, p, t) => { calls.push([m, p, t]); return { ok: true, status: 200, body: { state: [] } }; }, adminToken: "tok-not-real" });
    assert.deepEqual(await reader.roomState("!r:play.test"), []);
    assert.deepEqual(calls, [["GET", "/_synapse/admin/v1/rooms/!r%3Aplay.test/state", "tok-not-real"]].map(([m, p, t]) => [m, p.replace("!r%3Aplay.test", encodeURIComponent("!r:play.test")), t]));
    // the reader has nothing else on it: no general call, no token
    assert.deepEqual(Object.keys(reader), ["roomState"]);
    assert.ok(!JSON.stringify(reader).includes("tok-not-real"));
    const refused = [
        ["POST", "/_synapse/admin/v1/rooms/!r/state"], ["PUT", "/_synapse/admin/v1/rooms/!r/state"], ["DELETE", "/_synapse/admin/v1/rooms/!r"],
        ["GET", "/_synapse/admin/v1/rooms/!r"], ["GET", "/_synapse/admin/v1/rooms/!r/members"], ["GET", "/_synapse/admin/v2/users/@a:x"],
        ["GET", "/_synapse/admin/v1/rooms/!r/state/../../users"], ["GET", "/_synapse/admin/v1/rooms/!r/state?x=1"], ["GET", "/_matrix/client/v3/rooms/!r/state"],
        ["GET", "/_synapse/admin/v1/rooms/!r/messages"], ["POST", "/_synapse/admin/v1/purge_history/!r"], ["GET", "/_synapse/admin/v1/rooms/ !r/state"],
    ];
    for (const [m, p] of refused) assert.throws(() => checkAllowed(m, p), /may not call/, `${m} ${p} must be refused`);
    assert.doesNotThrow(() => checkAllowed("GET", "/_synapse/admin/v1/rooms/%21r%3Aplay.test/state"));
});

test("resolving a room from state: two-way link → the space + who is joined + live call sessions; a space it doesn't hold → unavailable", async () => {
    const now = Date.parse("2026-11-19T20:00:00Z");
    const st = {
        "!r:play.test": [
            { type: "m.room.create", state_key: "", sender: "@a:play.test", content: {} },
            { type: "m.space.parent", state_key: "!S:play.test", content: { via: ["play.test"], canonical: true } },
            { type: "m.room.member", state_key: "@a:play.test", content: { membership: "join" } },
            { type: "m.room.member", state_key: "@b:play.test", content: { membership: "leave" } },
            { type: "org.matrix.msc3401.call.member", state_key: "_@a:play.test_DEV1_m.call", sender: "@a:play.test", origin_server_ts: now - 1000, content: { application: "m.call", scope: "m.room", device_id: "DEV1", created_ts: now - 1000, expires: 14400000 } },
        ],
        "!S:play.test": [
            { type: "m.room.create", state_key: "", sender: "@owner:play.test", content: { type: "m.space" } },
            { type: "m.space.child", state_key: "!r:play.test", content: { via: ["play.test"] } },
            { type: "m.room.member", state_key: "@a:play.test", content: { membership: "join" } },
        ],
        "!r2:play.test": [
            { type: "m.room.create", state_key: "", sender: "@a:play.test", content: {} },
            { type: "m.space.parent", state_key: "!unknown:else.test", content: { via: ["else.test"] } },
        ],
    };
    const reader = { roomState: async (id) => st[id] || null };
    const sp = createSpaces({ reader, serverName: "play.test", now: () => now });
    const r = await sp.resolve("!r:play.test");
    assert.equal(r.space, "!S:play.test"); assert.equal(r.server, "play.test"); assert.equal(r.why, "");
    assert.ok(r.room.joined.has("@a:play.test")); assert.ok(!r.room.joined.has("@b:play.test"));
    assert.equal(r.room.sessions.length, 1); assert.ok(r.spaceJoined.has("@a:play.test"));
    assert.equal((await sp.resolve("!r2:play.test")).why, "unavailable");
    assert.equal((await sp.resolve("!nope:play.test")).why, "unavailable");
});
