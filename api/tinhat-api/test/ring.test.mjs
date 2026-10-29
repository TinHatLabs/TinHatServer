// ring.mjs — DM ringing, server half (RINGING.md draft 3; docs/API.md "Ringing"): the pure rules (live sessions,
// the ring decision table, stop reasons, `rings` in a registration, VoIP endpoints) and the engine end to end through
// createPush with a scripted Synapse (room state, pushers, the module's push_muted) and a recording fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPush, PUSH, startGatewayServer, topicFor } from "../push.mjs";
import { RING, liveSessions, roomView, ringDecision, stopReason, parseRings, checkVoipEndpoint, ringTopic, ringPayload } from "../ring.mjs";
import { b64u, decrypt, pushkeyFor } from "../webpush.mjs";
import { call, bearer, clock, fakeHomeserver, authFor, fakeFetch } from "./helpers.mjs";

const SN = "example.org";
const A = "@alice:example.org", B = "@bob:example.org", C = "@carol:example.org", G = "@guest-abcdefabcdef:example.org";
const FED = "@fred:other.test";
const DM = "!dm:example.org", DM2 = "!dm2:example.org", GROUP = "!group:example.org";
const RELAY = "https://push.tinhat.test";
const WALL0 = 1_790_000_000_000;

// ── pure rules ────────────────────────────────────────────────────────────────────────────────────────────────────
const member = (user, membership = "join", displayname) => ({ type: "m.room.member", state_key: user, sender: user, content: { membership, ...(displayname ? { displayname } : {}) } });
const callMember = (user, device, createdTs, over = {}) => ({
    type: RING.MEMBER_TYPE, state_key: `_${user}_${device}_m.call`, sender: user, event_id: `$cm-${user}-${device}-${createdTs}`,
    origin_server_ts: createdTs,
    content: { application: "m.call", call_id: "", scope: "m.room", device_id: device, created_ts: createdTs, expires: 14_400_000,
        focus_active: { type: "livekit" }, foci_preferred: [], ...over },
});
const left = (user, device) => ({ type: RING.MEMBER_TYPE, state_key: `_${user}_${device}_m.call`, sender: user, event_id: `$left-${user}-${device}`, origin_server_ts: 1, content: {} });

test("live_sessions_follow_the_apps_rules", () => {
    const now = WALL0;
    const joined = new Set([A, B]);
    const s = liveSessions([
        callMember(B, "BDEV", now - 1000),
        callMember(A, "ADEV", now - 15_000_000), // expired (4 h)
        left(A, "AOLD"),
        { ...callMember(B, "BDEV2", now), state_key: `_${A}_BDEV2_m.call` }, // someone else's key
        callMember(B, "BDEV3", now, { application: "m.other" }),
        callMember(C, "CDEV", now), // not joined: never counts (a removed guest's leftover membership)
        { ...callMember(B, "", now) }, // no device
        { type: RING.MEMBER_TYPE, state_key: B, sender: B, event_id: "$legacy", origin_server_ts: now, content: { memberships: [{ device_id: "BLEG", created_ts: now, expires: 3600_000 }] } },
    ], now, joined);
    assert.deepEqual(s.map((x) => `${x.sender}|${x.device}`), [`${B}|BDEV`, `${B}|BLEG`]);
    assert.equal(s[0].eventId, `$cm-${B}-BDEV-${now - 1000}`, "the ring id is the state event's id");
    const v = roomView([member(A), member(B, "join", "Bob"), member(C, "leave"), callMember(B, "BDEV", now), callMember(C, "CDEV", now)], now);
    assert.deepEqual([...v.joined.keys()], [A, B]);
    assert.equal(v.joined.get(B), "Bob");
    assert.deepEqual(v.sessions.map((x) => x.sender), [B]);
});

test("ring_decision_table", () => {
    const now = WALL0;
    const bob = { sender: B, device: "BDEV", createdTs: now - 2000, eventId: "$b" };
    const old = { ...bob, createdTs: now - RING.FRESH_MS - 1 };
    const me = { sender: A, device: "ADEV", createdTs: now - 5000, eventId: "$a" };
    const guest = { sender: G, device: "GDEV", createdTs: now, eventId: "$g" };
    const cases = [
        ["first live membership of someone else", { sessions: [bob] }, { ring: bob }],
        ["never looked + fresh", { sessions: [bob], prev: undefined }, { ring: bob }],
        ["was empty + fresh", { sessions: [bob], prev: false }, { ring: bob }],
        ["already ringing / in progress", { sessions: [bob], prev: true }, { skip: "not_rising" }],
        ["callee already in the call (started it, or answered)", { sessions: [me, bob] }, { skip: "in_call" }],
        ["nobody in the call", { sessions: [] }, { skip: "no_call" }],
        ["only the callee", { sessions: [me] }, { skip: "in_call" }],
        ["a guest caller never rings", { sessions: [guest] }, { skip: "guest_caller" }],
        ["an old membership (API restart, long-running call) is no new call", { sessions: [old] }, { skip: "stale" }],
        ["re-join within 45 s", { sessions: [bob], lastRing: now - RING.GAP_MS + 1 }, { skip: "gap" }],
        ["re-join after 45 s", { sessions: [bob], lastRing: now - RING.GAP_MS }, { ring: bob }],
        ["the earliest other member is the caller", { sessions: [{ ...bob, sender: C, createdTs: now - 1000, eventId: "$c" }, bob] }, { ring: bob }],
    ];
    for (const [name, input, want] of cases) assert.deepEqual(ringDecision({ me: A, now, ...input }), want, name);
    assert.deepEqual(ringDecision({ me: G, sessions: [bob], now }), { skip: "guest_callee" }, "a guest is never rung");
    assert.equal(stopReason({ me: A, sessions: [bob, me] }), "answered");
    assert.equal(stopReason({ me: A, sessions: [] }), "ended");
    assert.equal(stopReason({ me: A, sessions: [guest] }), "ended", "only a guest left: nobody is calling");
    assert.equal(stopReason({ me: A, sessions: [bob] }), null);
});

test("rings_in_a_registration_and_voip_endpoints", () => {
    const voip = `${RELAY}/v/${"V".repeat(22)}`;
    assert.deepEqual(parseRings(undefined, { relay: RELAY, viaRelay: true }), { ok: true, rings: null });
    assert.deepEqual(parseRings({ v: 1, stop: true }, { relay: RELAY, viaRelay: false }), { ok: true, rings: { v: 1, stop: true } });
    assert.deepEqual(parseRings({ v: 2, anything: 1 }, { relay: RELAY, viaRelay: true }), { ok: true, rings: null }, "a newer version = the downgrade, never a refusal");
    assert.deepEqual(parseRings({ v: 1 }, { relay: RELAY, viaRelay: true }), { ok: false, reason: "bad_rings" });
    assert.deepEqual(parseRings("yes", { relay: RELAY, viaRelay: true }), { ok: false, reason: "bad_rings" });
    assert.deepEqual(parseRings({ v: 1, stop: true, voip }, { relay: RELAY, viaRelay: false }), { ok: false, reason: "voip_needs_relay" });
    assert.deepEqual(parseRings({ v: 1, stop: false, voip }, { relay: RELAY, viaRelay: true }), { ok: true, rings: { v: 1, stop: false, voip } });
    for (const bad of [`${RELAY}/w/${"V".repeat(22)}`, `${RELAY}/v/${"V".repeat(21)}`, `${RELAY}:443/v/${"V".repeat(22)}`, `https://evil.test/v/${"V".repeat(22)}`,
        `${RELAY}/v/${"V".repeat(22)}?x`, `${RELAY}/x/../v/${"V".repeat(22)}`])
        assert.equal(checkVoipEndpoint(bad, RELAY).ok, false, bad);
    assert.equal(checkVoipEndpoint(voip, null).ok, false, "no relay, no VoIP");
    assert.equal(checkVoipEndpoint(voip, RELAY).ok, true);
});

test("ring_payload_fits_and_cuts_only_the_title", () => {
    const f = { kind: "ring", room: DM, ring: "$r", caller: B, title: "B".repeat(5000), body: "Incoming call", ts: WALL0, busy: false, user: A };
    const buf = ringPayload(f, 2560);
    assert.ok(buf.length <= 2560);
    const p = JSON.parse(buf);
    assert.deepEqual([p.v, p.kind, p.room, p.ring, p.caller, p.user, p.busy], [1, "ring", DM, "$r", B, A, false]);
});

// ── the engine ────────────────────────────────────────────────────────────────────────────────────────────────────
function subscription(endpoint) {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    return { ua, auth, endpoint, pushkey: pushkeyFor(endpoint), data: { endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth), v: 1 } };
}
const phoneSub = (id) => subscription(`${RELAY}/w/${id.padEnd(22, "x").slice(0, 22)}`);
const open = (sub, c) => JSON.parse(decrypt(c.init.body, sub.ua.getPrivateKey(), sub.auth).toString("utf8"));

function setup({ muted = () => false, ignored = () => undefined, adminToken = "admintoken", status = () => 201, fetchImpl: customFetch, joinedDown = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ring-"));
    const now = clock(1000);
    const wallNow = () => WALL0 + now();
    const base = fakeHomeserver({ tokens: { ta: { user: A, device: "APHONE" }, ta2: { user: A, device: "ADESK" }, tb: { user: B, device: "BDEV" }, tc: { user: C, device: "CDEV" } } });
    const rooms = new Map(); // room -> state events
    const pushers = new Map(); // mxid -> [{pushkey, app_id}]
    const calls = [];
    const hs = {
        calls,
        async get(path, token) {
            calls.push(path);
            let m;
            if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/state$/.exec(path))) {
                const st = rooms.get(decodeURIComponent(m[1]));
                return st ? { ok: true, status: 200, body: { state: st } } : { ok: false, status: 404, body: {} };
            }
            if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)$/.exec(path))) {
                const st = rooms.get(decodeURIComponent(m[1]));
                if (!st) return { ok: false, status: 404, body: {} };
                return { ok: true, status: 200, body: { joined_members: st.filter((e) => e.type === "m.room.member" && e.content.membership === "join").length } };
            }
            if ((m = /^\/_synapse\/admin\/v1\/users\/([^/]+)\/joined_rooms$/.exec(path))) {
                const u = decodeURIComponent(m[1]);
                if (joinedDown) return { ok: false, status: 500, body: {} };
                const list = [...rooms].filter(([, st]) => st.some((e) => e.type === "m.room.member" && e.state_key === u && e.content.membership === "join")).map(([r]) => r);
                return { ok: true, status: 200, body: { joined_rooms: list, total: list.length } };
            }
            if ((m = /^\/_synapse\/admin\/v1\/users\/([^/]+)\/pushers$/.exec(path))) {
                const p = pushers.get(decodeURIComponent(m[1])) || [];
                return { ok: true, status: 200, body: { pushers: p, total: p.length } };
            }
            if (path.startsWith(RING.MUTED_PATH + "?")) {
                assert.equal(token, adminToken, "push_muted is asked with the admin token");
                const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
                const v = muted(q.get("user_id"), q.get("room_id"));
                const ig = ignored(q.get("user_id"), q.get("caller"));  // undefined = a module that doesn't answer it
                return v === "down" ? { ok: false, status: 404, body: {} } : { ok: true, status: 200, body: { muted: v, ...(ig === undefined ? {} : { ignored: ig }) } };
            }
            return base.get(path, token);
        },
    };
    const logs = [];
    const fetchImpl = customFetch || fakeFetch(status);
    const p = createPush({
        auth: authFor(base, now), hs, adminToken, dir, fetchImpl, now, wallNow, relay: RELAY, serverName: SN,
        log: (s) => logs.push(s), logError: (s) => logs.push(s), pushTimeoutMs: 200,
    });
    const api = (h, tok, body) => call(h, { method: "POST", headers: bearer(tok), body });
    const reg = (tok, sub, extra = {}) => api(p.register, tok, { ...sub.data, quietWhileActive: true, ...extra });
    const pusher = (mxid, sub, appId = "dev.tinhat.android") => pushers.set(mxid, [...(pushers.get(mxid) || []), { pushkey: sub.pushkey, app_id: appId, kind: "http" }]);
    const poke = (room, event_id = "$x") => call(p.callHook, { method: "POST", body: { room_id: room, event_id } });
    const dm = (room = DM, a = A, b = B, extra = []) => rooms.set(room, [member(a, "join", "Alice"), member(b, "join", "Bob"), ...extra]);
    const addCall = (room, user, device, ts = wallNow()) => {
        const st = rooms.get(room).filter((e) => !(e.type === RING.MEMBER_TYPE && e.state_key === `_${user}_${device}_m.call`));
        st.push(callMember(user, device, ts));
        rooms.set(room, st);
    };
    const leaveCall = (room, user, device) => rooms.set(room, rooms.get(room).map((e) => (e.type === RING.MEMBER_TYPE && e.state_key === `_${user}_${device}_m.call` ? left(user, device) : e)));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { now, wallNow, hs, rooms, pushers, logs, fetchImpl, p, api, reg, pusher, poke, dm, addCall, leaveCall, cleanup };
}

test("a_dm_call_rings_the_callee_and_answering_stops_it", async () => {
    const fx = setup();
    try {
        const phone = phoneSub("AlicePhone");
        let r = await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
        assert.deepEqual([r.statusCode, r.body.rings], [200, { v: 1, stop: true }], "the answer says what was taken");
        fx.pusher(A, phone);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        r = await fx.poke(DM);
        assert.equal(r.statusCode, 200);
        assert.equal(fx.fetchImpl.calls.length, 1, "one ring");
        const c = fx.fetchImpl.calls[0];
        assert.equal(c.url, phone.endpoint);
        assert.equal(c.init.headers.TTL, "30");
        assert.equal(c.init.headers.Urgency, "high");
        const ring = open(phone, c);
        const ringId = `$cm-${B}-BDEV-${fx.wallNow()}`;
        assert.deepEqual(ring, { v: 1, kind: "ring", room: DM, ring: ringId, caller: B, title: "Bob", body: "Incoming call", ts: fx.wallNow(), busy: false, user: A });
        assert.equal(c.init.headers.Topic, ringTopic(fx.p._topicKey, phone.pushkey, DM, ringId));
        // the caller's client refreshes its membership: no second ring
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 1);
        // Alice answers on her desktop: the phone's ring stops, same Topic
        fx.now.advance(3000);
        fx.addCall(DM, A, "ADESK");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 2);
        const stop = fx.fetchImpl.calls[1];
        assert.deepEqual(open(phone, stop), { v: 1, kind: "ring_stop", room: DM, ring: ringId, why: "answered", title: "Bob", user: A });
        assert.equal(stop.init.headers.Topic, c.init.headers.Topic, "ring and ring_stop share the Topic");
        assert.equal(stop.init.headers.TTL, "30");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 2, "a ring stops once");
        assert.ok(!fx.logs.join("\n").includes(phone.endpoint), "endpoints are never logged");
    } finally { fx.cleanup(); }
});

test("the_caller_hanging_up_stops_the_ring_and_the_45_s_gap_holds", async () => {
    const fx = setup();
    try {
        const phone = phoneSub("AlicePhone");
        await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
        fx.pusher(A, phone);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        fx.now.advance(10_000);
        fx.leaveCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 2);
        assert.equal(open(phone, fx.fetchImpl.calls[1]).why, "ended");
        // Bob calls again 10 s later (a reconnect): the gap holds
        fx.now.advance(10_000);
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 2, "no ring inside 45 s");
        fx.leaveCall(DM, B, "BDEV");
        await fx.poke(DM);
        fx.now.advance(RING.GAP_MS);
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 3, "a call after 45 s rings again");
        assert.equal(open(phone, fx.fetchImpl.calls[2]).kind, "ring");
    } finally { fx.cleanup(); }
});

test("decline_stops_every_device_once_and_is_checked", async () => {
    const fx = setup();
    try {
        const phone = phoneSub("AlicePhone"), tablet = phoneSub("AliceTablet");
        await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
        await fx.reg("ta2", tablet, { rings: { v: 1, stop: true } });
        fx.pusher(A, phone); fx.pusher(A, tablet);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 2, "both devices ring");
        const ringId = open(phone, fx.fetchImpl.calls[0]).ring;
        assert.equal((await call(fx.p.ringDecline, { method: "POST", body: { room: DM, ring: ringId } })).statusCode, 401, "bearer only");
        assert.equal((await fx.api(fx.p.ringDecline, "ta", { room: DM })).statusCode, 400);
        assert.equal((await fx.api(fx.p.ringDecline, "ta", { room: "not-a-room", ring: ringId })).statusCode, 400);
        assert.equal((await fx.api(fx.p.ringDecline, "ta", { room: DM, ring: "$other" })).statusCode, 404, "only the live ring");
        assert.equal((await fx.api(fx.p.ringDecline, "tb", { room: DM, ring: ringId })).statusCode, 404, "the caller has no ring to decline");
        let r = await fx.api(fx.p.ringDecline, "ta", { room: DM, ring: ringId });
        assert.deepEqual([r.statusCode, r.body], [200, { ok: true }]);
        assert.equal(fx.fetchImpl.calls.length, 4, "a stop to each device");
        for (const [i, sub] of [[2, phone], [3, tablet]].map(([i, s]) => [i, s])) {
            const c = fx.fetchImpl.calls.find((x) => x.url === sub.endpoint && open(sub, x).kind === "ring_stop");
            assert.equal(open(sub, c).why, "declined", `device ${i}`);
        }
        r = await fx.api(fx.p.ringDecline, "ta", { room: DM, ring: ringId });
        assert.deepEqual([r.statusCode, r.body], [200, { ok: true, already: "declined" }], "idempotent");
        fx.leaveCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 4, "no second stop after a decline");
        fx.now.advance(RING.STOP_MS + 1);
        assert.equal((await fx.api(fx.p.ringDecline, "ta", { room: DM, ring: ringId })).statusCode, 404, "a ring can be declined for 60 s only");
    } finally { fx.cleanup(); }
});

test("decline_requires_the_callee_still_in_the_room", async () => {
    const fx = setup();
    try {
        const phone = phoneSub("AlicePhone");
        await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
        fx.pusher(A, phone);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        const ringId = open(phone, fx.fetchImpl.calls[0]).ring;
        fx.rooms.set(DM, fx.rooms.get(DM).map((e) => (e.type === "m.room.member" && e.state_key === A ? member(A, "leave") : e)));
        assert.equal((await fx.api(fx.p.ringDecline, "ta", { room: DM, ring: ringId })).statusCode, 403);
    } finally { fx.cleanup(); }
});

test("who_may_ring_whom", async () => {
    const run = async (name, prep, want, opts) => {
        const fx = setup(opts);
        try {
            const phone = phoneSub("AlicePhone");
            await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
            fx.pusher(A, phone);
            await prep(fx, phone);
            assert.equal(fx.fetchImpl.calls.length, want, name);
        } finally { fx.cleanup(); }
    };
    await run("a DM rings", async (fx) => { fx.dm(); fx.addCall(DM, B, "BDEV"); await fx.poke(DM); }, 1);
    await run("a group call doesn't ring", async (fx) => {
        fx.rooms.set(GROUP, [member(A), member(B), member(C)]); fx.addCall(GROUP, B, "BDEV"); await fx.poke(GROUP);
    }, 0);
    await run("a federated caller in a DM rings", async (fx) => { fx.dm(DM, A, FED); fx.addCall(DM, FED, "FDEV"); await fx.poke(DM); }, 1);
    await run("a remote callee isn't ours to ring", async (fx) => {
        fx.dm(DM, FED, B); fx.pushers.set(FED, [{ pushkey: "x", app_id: "dev.tinhat.android" }]); fx.addCall(DM, B, "BDEV"); await fx.poke(DM);
    }, 0);
    await run("a guest caller never rings", async (fx) => { fx.dm(DM, A, G); fx.addCall(DM, G, "GDEV"); await fx.poke(DM); }, 0);
    await run("a caller who isn't joined never rings", async (fx) => {
        fx.rooms.set(DM, [member(A), member(C), member(B, "leave")]); fx.addCall(DM, B, "BDEV"); await fx.poke(DM);
    }, 0);
    await run("a muted DM doesn't ring", async (fx) => { fx.dm(); fx.addCall(DM, B, "BDEV"); await fx.poke(DM); }, 0, { muted: () => true });
    await run("a caller the callee ignores doesn't ring (assembly-038)", async (fx) => { fx.dm(); fx.addCall(DM, B, "BDEV"); await fx.poke(DM); }, 0,
        { ignored: (user, caller) => user === A && caller === B });
    await run("someone else ignored: the caller still rings", async (fx) => { fx.dm(); fx.addCall(DM, B, "BDEV"); await fx.poke(DM); }, 1,
        { ignored: (user, caller) => caller === C });
    await run("muted unknown (module missing) = no ring", async (fx) => { fx.dm(); fx.addCall(DM, B, "BDEV"); await fx.poke(DM); }, 0, { muted: () => "down" });
    await run("a registration whose Synapse pusher is gone (signed out) doesn't ring", async (fx) => {
        fx.pushers.clear(); fx.dm(); fx.addCall(DM, B, "BDEV"); await fx.poke(DM);
    }, 0);
    await run("a stale membership (20 s+) doesn't ring", async (fx) => { fx.dm(); fx.addCall(DM, B, "BDEV", fx.wallNow() - RING.FRESH_MS - 1); await fx.poke(DM); }, 0);
    await run("a call the callee is already in doesn't ring", async (fx) => {
        fx.dm(); fx.addCall(DM, A, "ADESK"); await fx.poke(DM); fx.addCall(DM, B, "BDEV"); await fx.poke(DM);
    }, 0);
    await run("without the admin token nothing rings", async (fx) => { fx.dm(); fx.addCall(DM, B, "BDEV"); await fx.poke(DM); }, 0, { adminToken: "" });
    await run("a room that can't be read doesn't ring", async (fx) => { await fx.poke("!nowhere:example.org"); }, 0);
});

test("old_registrations_get_an_ordinary_message_and_never_a_stop", async () => {
    const fx = setup();
    try {
        const browser = subscription("https://web.push.apple.com/abcdef");
        let r = await fx.reg("ta2", browser);
        assert.equal(r.body.rings, undefined, "no rings asked, none answered (today's answer, unchanged)");
        fx.pusher(A, browser, PUSH.APP_ID);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 1);
        const c = fx.fetchImpl.calls[0];
        const ringId = `$cm-${B}-BDEV-${fx.wallNow()}`;
        assert.deepEqual(open(browser, c), { v: 1, room: DM, event: ringId, kind: "message", title: "Bob", body: "Incoming call", unread: null, user: A });
        assert.equal(c.init.headers.Topic, topicFor(fx.p._topicKey, browser.pushkey, DM), "a browser's per-room Topic, like a message");
        assert.equal(c.init.headers.TTL, "30");
        fx.addCall(DM, A, "ADESK");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 1, "no ring_stop for an old registration");
    } finally { fx.cleanup(); }
});

test("quiet_while_active_holds_the_downgrade_but_never_a_ring", async () => {
    const fx = setup();
    try {
        const oldPhone = phoneSub("OldPhone"), newPhone = phoneSub("NewPhone");
        await fx.reg("ta", oldPhone);
        await fx.reg("ta", newPhone, { rings: { v: 1, stop: true } });
        fx.pusher(A, oldPhone); fx.pusher(A, newPhone);
        // Alice is at a computer (user-level activity)
        assert.equal((await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desk" })).statusCode, 200);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.deepEqual(fx.fetchImpl.calls.map((c) => c.url), [newPhone.endpoint], "the ring goes; the old app's message is held");
    } finally { fx.cleanup(); }
});

test("busy_rings_are_quiet_and_voip_takes_only_non_busy_rings", async () => {
    const fx = setup();
    try {
        const voip = `${RELAY}/v/${"P".repeat(22)}`;
        const iphone = phoneSub("AliceIphone");
        const r = await fx.reg("ta", iphone, { rings: { v: 1, stop: true, voip } });
        assert.deepEqual(r.body.rings, { v: 1, stop: true, voip });
        fx.pusher(A, iphone, "dev.tinhat.ios");
        // not busy: the ring goes to PushKit only, and nothing goes there after it
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.deepEqual(fx.fetchImpl.calls.map((c) => c.url), [voip]);
        assert.equal(open(iphone, fx.fetchImpl.calls[0]).kind, "ring", "encrypted to the registration's keys");
        assert.equal(fx.fetchImpl.calls[0].init.headers.Topic, ringTopic(fx.p._topicKey, pushkeyFor(voip), DM, open(iphone, fx.fetchImpl.calls[0]).ring));
        fx.addCall(DM, A, "AIPHONE");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 1, "no ring_stop over VoIP (and none to the alert endpoint that never rang)");
        // busy: Alice is in that call when Carol calls in another DM -> an alert ring with busy: true, never VoIP
        fx.rooms.set(DM2, [member(A, "join", "Alice"), member(C, "join", "Carol")]);
        fx.addCall(DM2, C, "CDEV");
        await fx.poke(DM2);
        assert.deepEqual(fx.fetchImpl.calls.map((c) => c.url), [voip, iphone.endpoint]);
        const busy = open(iphone, fx.fetchImpl.calls[1]);
        assert.deepEqual([busy.kind, busy.busy, busy.title], ["ring", true, "Carol"]);
        // Carol hangs up: the stop goes to the alert endpoint
        fx.leaveCall(DM2, C, "CDEV");
        await fx.poke(DM2);
        assert.deepEqual(fx.fetchImpl.calls.map((c) => c.url), [voip, iphone.endpoint, iphone.endpoint]);
        assert.equal(open(iphone, fx.fetchImpl.calls[2]).why, "ended");
    } finally { fx.cleanup(); }
});

test("a_gone_voip_subscription_is_forgotten_and_a_gone_alert_one_dropped", async () => {
    const voip = `${RELAY}/v/${"G".repeat(22)}`;
    const fx = setup({ status: (url) => (url === voip ? 410 : 201) });
    try {
        const iphone = phoneSub("AliceIphone");
        await fx.reg("ta", iphone, { rings: { v: 1, stop: true, voip } });
        fx.pusher(A, iphone, "dev.tinhat.ios");
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.p._regs.get(iphone.pushkey).rings.voip, undefined, "the VoIP half goes, the registration stays");
        assert.deepEqual(fx.p._regs.get(iphone.pushkey).rings, { v: 1, stop: true });
    } finally { fx.cleanup(); }
});

test("registration_rings_are_checked_owned_and_kept", async () => {
    const fx = setup();
    try {
        const voip = `${RELAY}/v/${"O".repeat(22)}`;
        const browser = subscription("https://web.push.apple.com/abcdef");
        assert.deepEqual((await fx.reg("ta", browser, { rings: { v: 1, stop: true, voip } })).body, { error: "rings_refused", reason: "voip_needs_relay" });
        assert.equal((await fx.reg("ta", browser, { rings: { v: 1, stop: "yes" } })).statusCode, 400);
        assert.deepEqual((await fx.reg("ta", browser, { rings: { v: 9 } })).body.rings, null, "an unknown version registers, without rings");
        const a = phoneSub("AlicePhone"), b = phoneSub("BobPhone");
        assert.equal((await fx.reg("ta", a, { rings: { v: 1, stop: true, voip } })).statusCode, 200);
        assert.deepEqual((await fx.reg("tb", b, { rings: { v: 1, stop: true, voip } })).body, { error: "voip_owned" }, "a VoIP endpoint is one person's");
        const g = await call(fx.p.registration, { headers: bearer("ta"), query: { pushkey: a.pushkey } });
        assert.deepEqual(g.body, { registered: true, quietWhileActive: true, rings: { v: 1, stop: true, voip } });
        // re-registering without rings clears them
        assert.equal((await fx.reg("ta", a)).statusCode, 200);
        assert.equal(fx.p._regs.get(a.pushkey).rings, undefined);
    } finally { fx.cleanup(); }
});

test("rings_survive_a_restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ring-persist-"));
    try {
        const now = clock(1000);
        const base = fakeHomeserver({ tokens: { ta: { user: A, device: "APHONE" } } });
        const mk = () => createPush({ auth: authFor(base, now), hs: base, adminToken: "t", dir, fetchImpl: fakeFetch(), now, relay: RELAY, serverName: SN, log: () => {}, logError: () => {} });
        const a = phoneSub("AlicePhone");
        const p1 = mk();
        await call(p1.register, { method: "POST", headers: bearer("ta"), body: { ...a.data, rings: { v: 1, stop: false } } });
        const p2 = mk();
        assert.deepEqual(p2._regs.get(a.pushkey).rings, { v: 1, stop: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the_hook_takes_only_a_room_id_and_answers_at_once", async () => {
    const fx = setup();
    try {
        assert.equal((await call(fx.p.callHook, { method: "POST", body: { event_id: "$x" } })).statusCode, 400);
        assert.equal((await call(fx.p.callHook, { method: "POST", body: { room_id: "nope" } })).statusCode, 400);
        assert.equal((await call(fx.p.callHook, { method: "POST", body: "x".repeat(5000) })).statusCode, 413);
        assert.equal((await fx.poke(DM)).statusCode, 200, "an unknown room: read, nothing to do");
        // config advertises ringing
        assert.equal((await call(fx.p.config)).body.ring, 1);
    } finally { fx.cleanup(); }
});

test("the_hook_is_served_on_the_gateway_listener_only", async () => {
    const fx = setup();
    let srv;
    try {
        srv = startGatewayServer(fx.p, { host: "127.0.0.1", port: 0, log: () => {} });
        await new Promise((r) => srv.once("listening", r));
        const base = `http://127.0.0.1:${srv.address().port}`;
        let r = await fetch(base + RING.HOOK_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room_id: DM, event_id: "$x" }) });
        assert.equal(r.status, 200);
        r = await fetch(base + RING.HOOK_PATH);
        assert.equal(r.status, 404, "POST only");
        r = await fetch(base + "/_tinhat/v1/other", { method: "POST", body: "{}" });
        assert.equal(r.status, 404);
    } finally { srv?.close(); fx.cleanup(); }
});

test("a_burst_of_pokes_reads_the_room_at_most_twice", async () => {
    const fx = setup();
    try {
        fx.dm();
        const n0 = fx.hs.calls.filter((p) => p.endsWith("/state")).length;
        await Promise.all([fx.poke(DM), fx.poke(DM), fx.poke(DM), fx.poke(DM), fx.poke(DM)]);
        const n = fx.hs.calls.filter((p) => p.endsWith("/state")).length - n0;
        assert.ok(n >= 1 && n <= 2, `state reads: ${n}`);
    } finally { fx.cleanup(); }
});

test("an_expired_call_no_longer_holds_the_edge", async () => {
    const fx = setup();
    try {
        const phone = phoneSub("AlicePhone");
        await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
        fx.pusher(A, phone);
        fx.dm();
        // Bob's client dies mid-ring: its membership just expires (no event)
        const st = fx.rooms.get(DM);
        st.push(callMember(B, "BDEV", fx.wallNow(), { expires: 30_000 }));
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 1);
        fx.now.advance(RING.GAP_MS + 1000);
        // Bob calls again from another device: a new call, it rings (the old edge expired with its membership)
        fx.addCall(DM, B, "BDEV2");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.filter((c) => open(phone, c).kind === "ring").length, 2);
    } finally { fx.cleanup(); }
});

test("a_stop_never_overtakes_its_ring", async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) await held; // the ring's push is slow
        return new Response(null, { status: 201 });
    };
    fetchImpl.calls = calls;
    const fx = setup({ fetchImpl });
    try {
        const phone = phoneSub("AlicePhone");
        await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
        fx.pusher(A, phone);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        const poking = fx.poke(DM);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(calls.length, 1, "the ring is on its way");
        const ringId = open(phone, calls[0]).ring;
        const declining = fx.api(fx.p.ringDecline, "ta", { room: DM, ring: ringId });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(calls.length, 1, "the stop waits for the ring");
        release();
        assert.equal((await declining).statusCode, 200);
        await poking;
        assert.deepEqual(calls.map((c) => open(phone, c).kind), ["ring", "ring_stop"]);
    } finally { fx.cleanup(); }
});

test("a_stop_goes_only_to_devices_still_signed_in", async () => {
    const fx = setup();
    try {
        const phone = phoneSub("AlicePhone"), tablet = phoneSub("AliceTablet");
        await fx.reg("ta", phone, { rings: { v: 1, stop: true } });
        await fx.reg("ta2", tablet, { rings: { v: 1, stop: true } });
        fx.pusher(A, phone); fx.pusher(A, tablet);
        fx.dm();
        fx.addCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.equal(fx.fetchImpl.calls.length, 2);
        // the tablet signs out (Synapse deletes its pusher) before the call ends
        fx.pushers.set(A, fx.pushers.get(A).filter((p) => p.pushkey !== tablet.pushkey));
        fx.leaveCall(DM, B, "BDEV");
        await fx.poke(DM);
        assert.deepEqual(fx.fetchImpl.calls.slice(2).map((c) => c.url), [phone.endpoint]);
    } finally { fx.cleanup(); }
});

test("a_voip_ring_asks_synapse_whether_the_callee_is_busy", async () => {
    const voip = `${RELAY}/v/${"B".repeat(22)}`;
    for (const [name, prep, want] of [
        ["in a call in a room the API never saw (after a restart): an alert ring, busy", (fx) => {
            fx.rooms.set(GROUP, [member(A), member(C), member("@dan:example.org"), callMember(A, "AIPHONE", fx.wallNow() - 600_000)]);
        }, { url: "alert", busy: true }],
        ["in no call: VoIP", () => {}, { url: "voip", busy: false }],
        ["can't tell (joined rooms unreadable): an alert ring, not busy", null, { url: "alert", busy: false }],
    ]) {
        const fx = setup({ joinedDown: prep === null });
        try {
            const iphone = phoneSub("AliceIphone");
            await fx.reg("ta", iphone, { rings: { v: 1, stop: true, voip } });
            fx.pusher(A, iphone, "dev.tinhat.ios");
            fx.dm();
            prep?.(fx);
            fx.addCall(DM, B, "BDEV");
            await fx.poke(DM);
            assert.equal(fx.fetchImpl.calls.length, 1, name);
            const c = fx.fetchImpl.calls[0];
            assert.equal(c.url, want.url === "voip" ? voip : iphone.endpoint, name);
            assert.equal(open(iphone, c).busy, want.busy, name);
        } finally { fx.cleanup(); }
    }
});
