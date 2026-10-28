// The guest room (guests.mjs, docs/GUESTS.md): who may do what, the door, waiting, letting in, turning away, a new
// link, off/on, the limits and the timeouts. A scripted homeserver; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuests, cleanName, G } from "../guests.mjs";
import { call, bearer, clock } from "./helpers.mjs";

const SYS = "@tinhat-system:crew.example.org", OWNER = "@owner:crew.example.org", AMY = "@amy:crew.example.org";
const BOB = "@bob:crew.example.org", GUEST = "@guest-ab12cd:crew.example.org";

function world(extra = {}, seed = {}) {
    const s = { rooms: {}, admins: new Set([OWNER]), writes: [], kicks: [], deactivated: [], registered: 0, made: [], ...seed };
    const tokens = { towner: OWNER, tamy: AMY, tbob: BOB, tguest: GUEST };
    const hs = {
        async call(method, path, token, body) {
            assert.equal(token, "admintoken", `${method} ${path} uses the system account`);
            let m;
            if (path === "/_matrix/client/v3/account/whoami") return { ok: true, status: 200, body: { user_id: SYS } };
            if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
                const id = `!guests${Object.keys(s.rooms).length}:crew.example.org`;
                s.rooms[id] = { members: new Set([SYS]), pl: body.power_level_content_override };
                s.made.push(body);
                return { ok: true, status: 200, body: { room_id: id } };
            }
            if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/.exec(path))) {
                const r = s.rooms[decodeURIComponent(m[1])];
                return r ? { ok: true, status: 200, body: { joined: Object.fromEntries([...r.members].map((u) => [u, {}])) } } : { ok: false, status: 403, body: {} };
            }
            if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.power_levels\/$/.exec(path)) && method === "GET") {
                const r = s.rooms[decodeURIComponent(m[1])];
                return r ? { ok: true, status: 200, body: r.pl } : { ok: false, status: 403, body: { errcode: "M_FORBIDDEN" } };
            }
            if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.encryption\/$/.exec(path)) && method === "GET") {
                if (s.encryptCheckFails) throw new Error("connection reset");
                return s.forceEncryption ? { ok: true, status: 200, body: { algorithm: "m.megolm.v1.aes-sha2" } }
                    : { ok: false, status: 404, body: { errcode: "M_NOT_FOUND" } };
            }
            if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/([^/]+)\/$/.exec(path)) && method === "PUT") {
                s.writes.push({ type: decodeURIComponent(m[2]), content: body });
                const r = s.rooms[decodeURIComponent(m[1])];
                if (!r) return { ok: false, status: 403, body: { errcode: "M_FORBIDDEN" } };
                if (decodeURIComponent(m[2]) === "m.room.power_levels") {
                    if (s.plFails > 0) { s.plFails--; s.writes.pop(); return { ok: false, status: 503, body: { errcode: "M_UNKNOWN" } }; }
                    r.pl = body;
                }
                if (decodeURIComponent(m[2]) === G.WAITING && s.stallWaiting) { const gate = s.stallWaiting; s.stallWaiting = null; await gate; }
                (s.landed ||= []).push({ type: decodeURIComponent(m[2]), content: body });
                return { ok: true, status: 200, body: {} };
            }
            if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/kick$/.exec(path))) {
                s.rooms[decodeURIComponent(m[1])].members.delete(body.user_id);
                s.kicks.push(body.user_id);
                return { ok: true, status: 200, body: {} };
            }
            if ((m = /^\/_synapse\/admin\/v2\/users\/(.+)$/.exec(path))) return { ok: true, status: 200, body: { admin: s.admins.has(decodeURIComponent(m[1])) } };
            if ((m = /^\/_synapse\/admin\/v1\/join\/(.+)$/.exec(path))) {
                const r = s.rooms[decodeURIComponent(m[1])];
                if (!r) return { ok: false, status: 404, body: {} };
                r.members.add(body.user_id);
                return { ok: true, status: 200, body: { room_id: decodeURIComponent(m[1]) } };
            }
            throw new Error(`unexpected ${method} ${path}`);
        },
    };
    const auth = {
        async authenticate(req, res) {
            const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
            if (!tokens[t]) { res.status(401).json({ error: "bad token" }); return null; }
            return { user: tokens[t] };
        },
    };
    const now = clock();
    const logs = [];
    const g = createGuests({
        auth, hs, adminToken: "admintoken", serverName: "crew.example.org", publicBase: "https://crew.example.org",
        register: async (name) => { s.registered++; return { user: `@guest-${s.registered}:crew.example.org`, token: `gt${s.registered}`, device: "D", name }; },
        deactivate: async (u) => { s.deactivated.push(u); return true; },
        recordGuest: () => {},
        isGuest: (m) => /^@guest-/.test(m),
        isTemporary: (m) => /^@guest-\d+:/.test(m),  // the accounts this world's register() made
        revokeAll: async (room) => {
            const made = [...Array(s.registered).keys()].map((i) => `@guest-${i + 1}:crew.example.org`).filter((u) => !s.deactivated.includes(u));
            for (const u of made) { s.deactivated.push(u); for (const r of Object.values(s.rooms)) r.members.delete(u); }
            return made.length;
        },
        publishRoom: (room) => { s.published = room; },
        statePath: join(mkdtempSync(join(tmpdir(), "guests-")), "guests.json"),
        now, log: (l) => logs.push(l), ...extra,
    });
    const room = () => g._st().room;
    const join_ = (u) => s.rooms[room()].members.add(u);
    return { s, g, now, logs, room, join: join_ };
}
const ip = (a) => ({ "x-forwarded-for": a });
const keyOf = (link) => new URL(link).searchParams.get("g");

test("only a server admin turns the guest room on the first time; it makes the room and joins them", async () => {
    const w = world();
    let r = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("tamy") });
    assert.equal(r.statusCode, 403);
    r = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.on, true);
    assert.ok(r.body.room && w.s.rooms[r.body.room].members.has(OWNER));
    assert.match(r.body.link, /^https:\/\/crew\.example\.org\/call\/\?g=[A-Za-z0-9_-]{24}$/);
    const made = w.s.made[0];
    assert.equal(made.name, "Guests");
    assert.equal(made.room_alias_name, "guests");
    assert.ok(!made.initial_state.some((e) => e.type === "m.room.encryption"), "the Guests room is not encrypted");
    assert.ok(!JSON.stringify(made).includes("megolm"));
    assert.equal(made.power_level_content_override.events["m.room.encryption"], 100, "only the server could turn it on");
    assert.ok(!w.logs.some((l) => l.includes("encrypted the new Guests room")));
    assert.ok(made.initial_state.some((e) => e.type === "m.room.history_visibility" && e.content.history_visibility === "joined"));
    assert.equal(made.power_level_content_override.users[OWNER], 50, "managers manage; the room's own state stays the server's");
    assert.equal(made.room_version, "10");
    assert.equal(made.creation_content["m.federate"], false);
    assert.equal(w.s.published, r.body.room, "Synapse's guest rules learn the room");
    assert.equal(made.power_level_content_override.events[G.WAITING], 100);
    assert.deepEqual(w.s.writes.find((x) => x.type === G.STATE).content.on, true);
    assert.ok(!JSON.stringify(w.s.writes).includes(keyOf(r.body.link)), "the link is never written into the room");
});

test("a Guests room from an earlier version: at start only the server may write its state, and the on/off state is published", async () => {
    const ROOM = "!older:crew.example.org";
    const statePath = join(mkdtempSync(join(tmpdir(), "guests-")), "guests.json");
    writeFileSync(statePath, JSON.stringify({ v: 1, room: ROOM, on: true, since: 5, key: "K".repeat(24) }));
    const pl = { users: { [SYS]: 100, [OWNER]: 50 }, state_default: 50,
        events: { "m.room.power_levels": 100, "m.room.encryption": 100, "x.another.type": 100 } };
    const w = world({ statePath }, { rooms: { [ROOM]: { members: new Set([SYS, OWNER]), pl } } });
    await w.g._ready;
    const ev = w.s.rooms[ROOM].pl.events;
    assert.deepEqual([ev[G.STATE], ev[G.WAITING], ev["m.room.encryption"]], [100, 100, 100], "only the server writes them");
    assert.equal(ev["x.another.type"], 100, "the rest stays as it was");
    assert.equal(ev["org.matrix.msc3401.call.member"], 0, "guests (level 0) may join the room's call, in the same write");
    assert.equal(w.s.rooms[ROOM].pl.users[OWNER], 50);
    assert.deepEqual(w.s.writes.find((x) => x.type === G.STATE)?.content, { v: 1, on: true, since: 5 }, "on, from sync");
    assert.deepEqual(w.s.writes.find((x) => x.type === G.WAITING)?.content, { v: 1, waiting: [] });
    // a room that already has them: no power-levels write at all (also when it is turned on again)
    const plWrites = () => w.s.writes.filter((x) => x.type === "m.room.power_levels").length;
    assert.equal(plWrites(), 1);
    const w2 = world({ statePath }, { rooms: { [ROOM]: { members: new Set([SYS, OWNER]), pl: w.s.rooms[ROOM].pl } } });
    await w2.g._ready;
    assert.equal(w2.s.writes.filter((x) => x.type === "m.room.power_levels").length, 0);
    const r = await call(w2.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    assert.equal(r.statusCode, 200);
    assert.equal(w2.s.made.length, 0, "the same room");
    assert.equal(w2.s.writes.filter((x) => x.type === "m.room.power_levels").length, 0);
});

test("the server's own state types are never lowered: a missing one counts at state_default", async () => {
    const ROOM = "!strict:crew.example.org";
    const statePath = join(mkdtempSync(join(tmpdir(), "guests-")), "guests.json");
    writeFileSync(statePath, JSON.stringify({ v: 1, room: ROOM, on: false, since: 5, key: null }));
    const pl = { users: { [SYS]: 150 }, state_default: 150, events: { "m.room.power_levels": 150 } };
    const w = world({ statePath }, { rooms: { [ROOM]: { members: new Set([SYS]), pl } } });
    await w.g._ready;
    // the one write only opens the call (a missing type counted at 150): the server's own types stay at 150
    assert.equal(w.s.writes.filter((x) => x.type === "m.room.power_levels").length, 1);
    assert.equal(w.s.rooms[ROOM].pl.events[G.STATE], undefined);
    assert.equal(w.s.rooms[ROOM].pl.events["m.room.power_levels"], 150);
    assert.equal(w.s.rooms[ROOM].pl.events["org.matrix.msc3401.call.member"], 0);
    assert.equal(w.s.rooms[ROOM].pl.state_default, 150);
});

test("a failed power-levels fix at start is tried again, even when the state writes worked", async () => {
    const ROOM = "!older:crew.example.org";
    const statePath = join(mkdtempSync(join(tmpdir(), "guests-")), "guests.json");
    writeFileSync(statePath, JSON.stringify({ v: 1, room: ROOM, on: true, since: 5, key: "K".repeat(24) }));
    const pl = { users: { [SYS]: 100 }, state_default: 50, events: { "m.room.power_levels": 100 } };
    const w = world({ statePath, retryMs: 5 }, { rooms: { [ROOM]: { members: new Set([SYS]), pl } }, plFails: 1 });
    await w.g._ready;
    assert.equal(w.s.rooms[ROOM].pl.events[G.STATE], undefined, "the first try failed");
    assert.ok(w.s.writes.some((x) => x.type === G.STATE), "the on/off state went out all the same");
    assert.ok(w.logs.some((l) => l.includes("couldn't keep")));
    for (let i = 0; i < 50 && w.s.rooms[ROOM].pl.events[G.STATE] !== 100; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.s.rooms[ROOM].pl.events[G.STATE], 100, "the retry raised it");
});

test("waiting-list writes go out one at a time, the last one with the list as it is now", async () => {
    const ROOM = "!older:crew.example.org";
    const statePath = join(mkdtempSync(join(tmpdir(), "guests-")), "guests.json");
    const KEY = "K".repeat(24);
    writeFileSync(statePath, JSON.stringify({ v: 1, room: ROOM, on: true, since: 5, key: KEY }));
    const pl = { users: { [SYS]: 100 }, state_default: 50, events: { [G.STATE]: 100, [G.WAITING]: 100, "m.room.encryption": 100 } };
    let release;
    const gate = new Promise((r) => { release = r; });
    const w = world({ statePath }, { rooms: { [ROOM]: { members: new Set([SYS]), pl } }, stallWaiting: gate });
    await new Promise((r) => setTimeout(r, 5));  // the start-up write of the (empty) list is now held up
    const k = call(w.g.h.knock, { method: "POST", body: { g: KEY, name: "Ana" }, headers: ip("203.0.113.5") });
    await new Promise((r) => setTimeout(r, 5));
    release();
    assert.equal((await k).statusCode, 200);
    await w.g._ready;
    for (let i = 0; i < 50 && w.s.landed.filter((x) => x.type === G.WAITING).length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    const lists = w.s.landed.filter((x) => x.type === G.WAITING).map((x) => x.content.waiting.map((p) => p.name));
    assert.deepEqual(lists, [[], ["Ana"]], "the held-up older list landed first, the newest last");
});

test("turning on again in a room an earlier version made also raises the server's own state types", async () => {
    const ROOM = "!older:crew.example.org";
    const statePath = join(mkdtempSync(join(tmpdir(), "guests-")), "guests.json");
    writeFileSync(statePath, JSON.stringify({ v: 1, room: ROOM, on: false, since: 5, key: null }));
    const pl = { users: { [SYS]: 100 }, state_default: 50, events: { "m.room.power_levels": 100 } };
    const w = world({ statePath, adminToken: "admintoken" }, { rooms: { [ROOM]: { members: new Set([SYS, OWNER]), pl } } });
    await w.g._ready;
    w.s.rooms[ROOM].pl = pl;  // as if the start-up write hadn't happened
    const r = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    assert.equal(r.statusCode, 200);
    assert.equal(w.s.rooms[ROOM].pl.events[G.STATE], 100);
    assert.equal(w.s.rooms[ROOM].pl.events[G.WAITING], 100);
    assert.equal(w.s.rooms[ROOM].pl.events["org.matrix.msc3401.call.member"], 0);
});

test("the web app's address is used as its canonical origin (the door compares it with location.origin)", async () => {
    const w = world({ webBase: "https://Web.Example.org:443/" });
    const on = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    assert.match(on.body.link, /^https:\/\/web\.example\.org\/call\/\?g=/);
    assert.equal((await call(w.g.h.door, { query: { g: keyOf(on.body.link) } })).body.web, "https://web.example.org");
});

test("a new Guests room: guests (level 0) may join its call, the server's own state stays the server's", async () => {
    const w = world();
    assert.equal((await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") })).statusCode, 200);
    const pl = w.s.made[0].power_level_content_override;
    assert.equal(pl.events["org.matrix.msc3401.call.member"], 0);
    assert.equal(pl.users_default ?? 0, 0);
    assert.deepEqual([pl.events[G.STATE], pl.events[G.WAITING], pl.events["m.room.encryption"]], [100, 100, 100]);
});

test("a Guests room whose call is open already: no power-levels write", async () => {
    const ROOM = "!open:crew.example.org";
    const statePath = join(mkdtempSync(join(tmpdir(), "guests-")), "guests.json");
    writeFileSync(statePath, JSON.stringify({ v: 1, room: ROOM, on: false, since: 5, key: null }));
    const pl = { users: { [SYS]: 100 }, state_default: 50,
        events: { [G.STATE]: 100, [G.WAITING]: 100, "m.room.encryption": 100, "org.matrix.msc3401.call.member": 0 } };
    const w = world({ statePath }, { rooms: { [ROOM]: { members: new Set([SYS]), pl } } });
    await w.g._ready;
    assert.equal(w.s.writes.filter((x) => x.type === "m.room.power_levels").length, 0);
});

test("a chat server that forces encryption on new rooms: the Guests room is made all the same, and that is logged", async () => {
    for (const how of ["forceEncryption", "encryptCheckFails"]) {
        const w = world();
        w.s[how] = true;
        const r = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
        assert.equal(r.statusCode, 200, how);
        assert.equal(r.body.on, true);
        assert.equal(w.s.made.length, 1, "one room");
        assert.equal(w.logs.some((l) => l.includes("encrypted the new Guests room")), how === "forceEncryption", how);
    }
});

test("knock, wait, let in: a session once; turn away; who may", async () => {
    const w = world();
    const on = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    const g = keyOf(on.body.link);
    assert.deepEqual((await call(w.g.h.door, { query: { g } })).body, { server: "crew.example.org", room: "Guests", open: true, web: "https://crew.example.org" });
    assert.equal((await call(w.g.h.door, { query: { g: "x".repeat(24) } })).statusCode, 404);
    const k1 = await call(w.g.h.knock, { method: "POST", body: { g, name: "Ana" }, headers: ip("203.0.113.5") });
    assert.equal(k1.statusCode, 200);
    assert.equal(k1.body.every, 2);
    const waitingWrite = w.s.writes.filter((x) => x.type === G.WAITING).at(-1).content.waiting;
    assert.equal(waitingWrite.length, 1);
    assert.equal(waitingWrite[0].name, "Ana");
    assert.equal((await call(w.g.h.ticket, { query: { t: k1.body.ticket } })).body.state, "waiting");
    // Amy isn't in the room yet: no link, can't let in
    let d = await call(w.g.h.doc, { headers: bearer("tamy") });
    assert.equal(d.body.link, null);
    assert.equal(d.body.canAdmit, false);
    const id = waitingWrite[0].id;
    assert.equal((await call(w.g.h.decide("admit"), { method: "POST", body: { id }, headers: bearer("tamy") })).statusCode, 403);
    // a guest in the room still can't
    w.join(GUEST);
    assert.equal((await call(w.g.h.decide("admit"), { method: "POST", body: { id }, headers: bearer("tguest") })).statusCode, 403);
    assert.equal((await call(w.g.h.doc, { headers: bearer("tguest") })).body.link, null);
    // Amy joins: she sees the link and the waiting list, and lets Ana in
    w.join(AMY);
    w.now.advance(11_000);  // past the role cache
    d = await call(w.g.h.doc, { headers: bearer("tamy") });
    assert.equal(d.body.canAdmit, true);
    assert.equal(d.body.canManage, false);
    assert.equal(d.body.link, on.body.link);
    assert.equal(d.body.waiting[0].name, "Ana");
    const a = await call(w.g.h.decide("admit"), { method: "POST", body: { id }, headers: bearer("tamy") });
    assert.deepEqual([a.statusCode, a.body], [200, { ok: true }]);
    assert.ok(w.s.rooms[w.room()].members.has("@guest-1:crew.example.org"));
    const t1 = await call(w.g.h.ticket, { query: { t: k1.body.ticket } });
    assert.equal(t1.body.state, "in");
    assert.equal(t1.body.session.user, "@guest-1:crew.example.org");
    assert.match(t1.body.session.web, /^https:\/\/crew\.example\.org\/#\/guest-session\?hs=https%3A%2F%2Fcrew\.example\.org&user=/);
    assert.equal((await call(w.g.h.ticket, { query: { t: k1.body.ticket } })).statusCode, 404, "the session is handed out once");
    // turn away
    const k2 = await call(w.g.h.knock, { method: "POST", body: { g, name: "Mallory" }, headers: ip("203.0.113.6") });
    const id2 = w.s.writes.filter((x) => x.type === G.WAITING).at(-1).content.waiting[0].id;
    assert.equal((await call(w.g.h.decide("turn-away"), { method: "POST", body: { id: id2 }, headers: bearer("tamy") })).statusCode, 200);
    assert.equal((await call(w.g.h.ticket, { query: { t: k2.body.ticket } })).body.state, "turned-away");
    assert.equal((await call(w.g.h.decide("admit"), { method: "POST", body: { id: id2 }, headers: bearer("tamy") })).statusCode, 404);
    assert.equal(w.s.writes.filter((x) => x.type === G.WAITING).at(-1).content.waiting.length, 0);
});

test("a new link kills the old one and turns away whoever waited with it; off removes the guests; on again = another link", async () => {
    const w = world();
    const on = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    const g1 = keyOf(on.body.link);
    const k = await call(w.g.h.knock, { method: "POST", body: { g: g1, name: "Ana" }, headers: ip("203.0.113.5") });
    const nl = await call(w.g.h.manage("link"), { method: "POST", headers: bearer("towner") });
    const g2 = keyOf(nl.body.link);
    assert.notEqual(g1, g2);
    assert.equal((await call(w.g.h.door, { query: { g: g1 } })).statusCode, 404);
    assert.equal((await call(w.g.h.knock, { method: "POST", body: { g: g1, name: "Late" }, headers: ip("203.0.113.7") })).statusCode, 410);
    assert.equal((await call(w.g.h.ticket, { query: { t: k.body.ticket } })).body.state, "closed");
    // someone in, then off
    await call(w.g.h.knock, { method: "POST", body: { g: g2, name: "Bea" }, headers: ip("203.0.113.8") });
    const id = w.s.writes.filter((x) => x.type === G.WAITING).at(-1).content.waiting[0].id;
    await call(w.g.h.decide("admit"), { method: "POST", body: { id }, headers: bearer("towner") });
    w.join("@guest-lookalike:crew.example.org");  // a real account whose owner picked a guest-like name
    const off = await call(w.g.h.manage("off"), { method: "POST", headers: bearer("towner") });
    assert.ok(w.s.rooms[w.room()].members.has("@guest-lookalike:crew.example.org"), "never kicked");
    assert.ok(!w.s.deactivated.includes("@guest-lookalike:crew.example.org"), "never deactivated");
    assert.equal(off.body.on, false);
    assert.equal(off.body.link, null);
    assert.ok(w.s.deactivated.includes("@guest-1:crew.example.org"), "every account the room made is revoked");
    assert.equal((await call(w.g.h.knock, { method: "POST", body: { g: g2, name: "X" }, headers: ip("203.0.113.9") })).statusCode, 410);
    assert.equal((await call(w.g.h.manage("link"), { method: "POST", headers: bearer("towner") })).statusCode, 409);
    const again = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    assert.ok(![g1, g2].includes(keyOf(again.body.link)), "an old link never comes back");
    assert.equal(w.s.made.length, 1, "the same room");
});

test("limits: 20 waiting, 5 knocks per address per 10 minutes; names are cleaned", async () => {
    const w = world();
    const g = keyOf((await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") })).body.link);
    for (let i = 0; i < 5; i++) assert.equal((await call(w.g.h.knock, { method: "POST", body: { g, name: `A${i}` }, headers: ip("198.51.100.1") })).statusCode, 200);
    const sixth = await call(w.g.h.knock, { method: "POST", body: { g, name: "A5" }, headers: ip("198.51.100.1") });
    assert.equal(sixth.statusCode, 429);
    assert.ok(Number(sixth.headers["retry-after"]) >= 1);
    for (let i = 0; i < 15; i++) assert.equal((await call(w.g.h.knock, { method: "POST", body: { g, name: `B${i}` }, headers: ip(`198.51.100.${10 + i}`) })).statusCode, 200);
    assert.equal((await call(w.g.h.knock, { method: "POST", body: { g, name: "C" }, headers: ip("198.51.100.99") })).statusCode, 429, "20 wait already");
    // an IPv6 home is one caller: five knocks from its /64, whatever the addresses, then 429 (security review 2026-10-26)
    const w6 = world();
    const g6 = keyOf((await call(w6.g.h.manage("on"), { method: "POST", headers: bearer("towner") })).body.link);
    for (let i = 0; i < 5; i++) assert.equal((await call(w6.g.h.knock, { method: "POST", body: { g: g6, name: `V${i}` }, headers: ip(`2001:db8:7:8::${i + 1}`) })).statusCode, 200);
    assert.equal((await call(w6.g.h.knock, { method: "POST", body: { g: g6, name: "V5" }, headers: ip("2001:db8:7:8:abcd::1") })).statusCode, 429);
    assert.equal((await call(w6.g.h.knock, { method: "POST", body: { g: g6, name: "W" }, headers: ip("2001:db8:7:9::1") })).statusCode, 200, "the next /64 is somebody else");
    assert.equal(cleanName("  Ana‮\u0000  Banana  "), "Ana Banana");
    assert.equal(cleanName(""), "Guest");
    assert.equal([...cleanName("x".repeat(80))].length, G.NAME_MAX);
});

test("a wait expires after 10 minutes; a session nobody picks up is withdrawn after 2", async () => {
    const w = world();
    const g = keyOf((await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") })).body.link);
    const k = await call(w.g.h.knock, { method: "POST", body: { g, name: "Slow" }, headers: ip("203.0.113.5") });
    w.now.advance(G.WAIT_MS + 1000);
    await w.g.tick();
    assert.equal((await call(w.g.h.ticket, { query: { t: k.body.ticket } })).body.state, "expired");
    assert.equal(w.s.writes.filter((x) => x.type === G.WAITING).at(-1).content.waiting.length, 0);
    const k2 = await call(w.g.h.knock, { method: "POST", body: { g, name: "Gone" }, headers: ip("203.0.113.6") });
    const id = w.s.writes.filter((x) => x.type === G.WAITING).at(-1).content.waiting[0].id;
    await call(w.g.h.decide("admit"), { method: "POST", body: { id }, headers: bearer("towner") });
    w.now.advance(G.COLLECT_MS + 1000);
    await w.g.tick();
    assert.ok(w.s.deactivated.includes("@guest-1:crew.example.org"), "withdrawn");
    assert.equal((await call(w.g.h.ticket, { query: { t: k2.body.ticket } })).statusCode, 404);
});

test("without a token: 401; a bad id: 400; signed-in non-members see no link", async () => {
    const w = world();
    assert.equal((await call(w.g.h.doc, {})).statusCode, 401);
    await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    assert.equal((await call(w.g.h.decide("admit"), { method: "POST", body: { id: "../../x" }, headers: bearer("towner") })).statusCode, 400);
    const d = await call(w.g.h.doc, { headers: bearer("tbob") });
    assert.equal(d.statusCode, 200);
    assert.equal(d.body.on, true);
    assert.equal(d.body.link, null);
    assert.deepEqual(d.body.waiting, []);
});

test("a web app address of its own: the link, the door and the hand-off go there (its own origin as the homeserver)", async () => {
    const w = world({ webBase: "https://web.example.org/" });
    const on = await call(w.g.h.manage("on"), { method: "POST", headers: bearer("towner") });
    assert.match(on.body.link, /^https:\/\/web\.example\.org\/call\/\?g=[A-Za-z0-9_-]{24}$/);
    const g = keyOf(on.body.link);
    // The door on the server's own name sends the guest to the web app's address (door.js).
    assert.equal((await call(w.g.h.door, { query: { g } })).body.web, "https://web.example.org");
    const k = await call(w.g.h.knock, { method: "POST", body: { g, name: "Ana" }, headers: ip("203.0.113.5") });
    const id = w.s.writes.filter((x) => x.type === G.WAITING).at(-1).content.waiting[0].id;
    assert.equal((await call(w.g.h.decide("admit"), { method: "POST", body: { id }, headers: bearer("towner") })).statusCode, 200);
    const t = await call(w.g.h.ticket, { query: { t: k.body.ticket } });
    assert.equal(t.body.session.hs, "https://crew.example.org");
    // The web app takes the hand-off only with its own origin as hs (web core/bearer homeserverAllowed): on 0.3.5 a
    // guest let in on a server with a web app address of its own got the sign-in screen while hs was the server's name.
    assert.match(t.body.session.web, /^https:\/\/web\.example\.org\/#\/guest-session\?hs=https%3A%2F%2Fweb\.example\.org&user=/);
    const hs = new URLSearchParams(new URL(t.body.session.web).hash.replace(/^#\/guest-session\?/, "")).get("hs");
    assert.equal(new URL(hs).origin, new URL(t.body.session.web).origin);
});
