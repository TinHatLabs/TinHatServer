// calltoken.mjs — calls round M1b: a call token only for a Matrix room the caller is joined in. Driven through the real
// handlers with a scripted Synapse (OpenID userinfo + the admin member list), a scripted lk-jwt that mints like 0.4.0
// (identity `<mxid>:<device_id>`, room = the request's) and a hand-driven clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallToken, parseRequest, canonicalBody, isOwnConnTestRoom, CALLTOKEN } from "../calltoken.mjs";
import { fakeReq, clock } from "./helpers.mjs";

const SN = "home.test";
const ALICE = `@alice:${SN}`, BOB = `@bob:${SN}`, GUEST = `@guest-0a1b2c:${SN}`;
const RB1 = "@b1:other.test", RB2 = "@b2:other.test";
const ROOM = `!call:${SN}`, OTHER = `!other:${SN}`, V12 = "!AbCdEf0123456789-_AbCdEf0123456789AbCdEf012";

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwtFor = (identity, room) => `${b64u({ alg: "HS256" })}.${b64u({ sub: identity, video: { room, roomJoin: true } })}.sig`;

function setup({ enabled = true } = {}) {
    const now = clock(1000);
    const s = {
        local: { at: ALICE, ab: BOB, ag: GUEST },            // access token -> user (this server)
        remote: { rb1: RB1, rb2: RB2 },                      // what lk-jwt resolves through federation
        rooms: { [ROOM]: [ALICE, GUEST, RB1], [OTHER]: [BOB], [V12]: [ALICE] },
        down: false, jwtDown: false,
    };
    const hsCalls = [], upCalls = [], logs = [];
    const hs = {
        async get(path, token) {
            hsCalls.push(path);
            if (s.down) throw new Error("connect ECONNREFUSED");
            let m;
            if ((m = /^\/_matrix\/federation\/v1\/openid\/userinfo\?access_token=(.*)$/.exec(path))) {
                const u = s.local[decodeURIComponent(m[1])];
                return u ? { ok: true, status: 200, body: { sub: u } } : { ok: false, status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } };
            }
            if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/members$/.exec(path))) {
                assert.equal(token, "admintoken");
                const room = decodeURIComponent(m[1]);
                if (!(room in s.rooms)) return { ok: false, status: 404, body: { errcode: "M_NOT_FOUND" } };
                const members = [...s.rooms[room]]; // the list as it is when the read starts
                if (s.hold) await s.hold;
                return { ok: true, status: 200, body: { members, total: members.length } };
            }
            throw new Error(`unexpected ${path}`);
        },
    };
    async function fetchImpl(url, init) {
        upCalls.push({ url, body: init.body, redirect: init.redirect });
        if (s.jwtDown) throw new Error("ECONNREFUSED");
        let b;
        try { b = JSON.parse(init.body); } catch { return new Response(JSON.stringify({ errcode: "M_BAD_JSON" }), { status: 400 }); }
        const tok = b.openid_token?.access_token;
        const user = b.openid_token?.matrix_server_name === SN ? s.local[tok] : s.remote[tok];
        if (!user) return new Response(JSON.stringify({ errcode: "M_LOOKUP_FAILED" }), { status: 500 });
        const identity = s.forceIdentity || (url.endsWith("/sfu/get") && "room" in b ? `${user}:${b.device_id}` : b.member.id);
        const room = "room" in b ? b.room : "hashed";
        return new Response(JSON.stringify({ url: "wss://home.test/livekit/sfu", jwt: jwtFor(identity, room) }), { status: 200 });
    }
    // another server's sign-ins, as fedresolve answers them (its own tests: fedresolve.test.mjs)
    const fedCalls = [];
    const federation = {
        async userinfo(server, tok) {
            fedCalls.push(server);
            if (server === "private.test") throw Object.assign(new Error("not public"), { status: 403, reason: "not-public" });
            if (server === "down.test") throw Object.assign(new Error("no answer"), { status: 502 });
            const u = s.remote[tok];
            return u && u.endsWith(`:${server}`) ? { sub: u } : null;
        },
    };
    const ct = createCallToken({ hs, adminToken: "admintoken", serverName: SN, lkJwtUrl: "http://127.0.0.1:8070", fetchImpl, now, log: (l) => logs.push(l), enabled: () => enabled, federation });
    async function post(path, body, { method = "POST", ip = "192.0.2.10", raw } = {}) {
        const res = { statusCode: 200, headers: {}, body: undefined, text: undefined };
        res.status = (c) => { res.statusCode = c; return res; };
        res.set = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
        res.json = (o) => { res.body = o; return res; };
        res.send = (t) => { res.text = t; res.body = JSON.parse(t); return res; };
        res.end = () => res;
        await ct.handler(path)(fakeReq({ method, headers: { "x-forwarded-for": ip }, body: raw ?? body }), res);
        return res;
    }
    return { s, now, ct, post, hsCalls, upCalls, logs, fedCalls };
}
const legacy = (room, tok, server = SN, device = "DEV1", extra = {}) =>
    ({ room, openid_token: { access_token: tok, token_type: "Bearer", matrix_server_name: server, expires_in: 3600 }, device_id: device, ...extra });
const modern = (room, tok, claimed, server = SN) =>
    ({ room_id: room, slot_id: "m.call#ROOM", openid_token: { access_token: tok, token_type: "Bearer", matrix_server_name: server, expires_in: 3600 },
       member: { id: "abc123", claimed_user_id: claimed, claimed_device_id: "DEV1" } });
const NOT_MEMBER = { errcode: "M_FORBIDDEN", error: "not in that room", reason: "not-member" };

test("member_of_the_room_gets_the_token_unchanged", async () => {
    const { post, upCalls } = setup();
    const r = await post("/sfu/get", legacy(ROOM, "at"));
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.url, "wss://home.test/livekit/sfu");
    assert.ok(r.body.jwt);
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.headers["access-control-allow-origin"], "*");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(upCalls.length, 1);
    assert.equal(upCalls[0].url, "http://127.0.0.1:8070/sfu/get");
    assert.equal(upCalls[0].redirect, "error", "never follow a redirect with a token in hand");
    assert.deepEqual(JSON.parse(upCalls[0].body), legacy(ROOM, "at"));
});

test("guest_in_the_guest_room_and_room_v12_ids", async () => {
    const { post } = setup();
    assert.equal((await post("/sfu/get", legacy(ROOM, "ag"))).statusCode, 200, "a guest joined in the room (0.3.6 guest flow)");
    assert.equal((await post("/sfu/get", legacy(V12, "at"))).statusCode, 200, "room v12 id (no server part)");
});

test("not_a_member_gets_403_and_lk_jwt_is_never_asked", async () => {
    const { post, upCalls, logs } = setup();
    const r = await post("/sfu/get", legacy(OTHER, "at"));
    assert.deepEqual([r.statusCode, r.body], [403, NOT_MEMBER]);
    const r2 = await post("/sfu/get", legacy("!nosuch:home.test", "at"));
    assert.deepEqual([r2.statusCode, r2.body], [403, NOT_MEMBER], "a room this server doesn't know");
    assert.equal(upCalls.length, 0);
    assert.ok(logs.every((l) => !l.includes("at\"") && !l.includes("access_token")));
});

test("an_alias_that_is_not_a_room_id_is_refused", async () => {
    const { post, upCalls } = setup();
    for (const room of ["anything", "some-other-room", `${ROOM}x y`, "#alias:home.test", "tinhat-conntest-bob-123"]) {
        const r = await post("/sfu/get", legacy(room, "at"));
        assert.deepEqual([r.statusCode, r.body], [403, NOT_MEMBER], room);
    }
    assert.equal(upCalls.length, 0);
});

test("connection_test_scratch_room_only_for_the_callers_own_name", async () => {
    const { post, upCalls } = setup();
    assert.equal((await post("/sfu/get", legacy("tinhat-conntest-alice-4242", "at"))).statusCode, 200);
    assert.equal(upCalls.length, 1);
    assert.equal((await post("/sfu/get", legacy("tinhat-conntest-alice-4242", "ab"))).statusCode, 403, "someone else's name");
    assert.equal((await post("/sfu/get", legacy("tinhat-conntest-alice-123456", "at"))).statusCode, 403, "suffix is at most 5 digits");
    assert.equal(isOwnConnTestRoom("tinhat-conntest-guest-0a1b2c-77", GUEST), true);
    assert.equal(isOwnConnTestRoom("tinhat-conntest-ab-1", "@a.b:x"), true, "the apps drop characters outside [A-Za-z0-9_-]");
    assert.equal(isOwnConnTestRoom("tinhat-conntest-user-1", "@...:x"), true, "web's fallback name");
    assert.equal(isOwnConnTestRoom("tinhat-conntest--1", "@...:x"), true, "desktop's empty name");
    assert.equal(upCalls.length, 1);
});

test("malformed_bodies_are_400", async () => {
    const { post, upCalls } = setup();
    const cases = [
        ["not json", "{"],
        ["array", "[]"],
        ["unknown field", JSON.stringify({ ...legacy(ROOM, "at"), extra: 1 })],
        ["a field name in another case (Go would read it)", JSON.stringify({ ...legacy(ROOM, "at"), ROOM: "elsewhere-x" })],
        ["mixed shapes", JSON.stringify({ ...legacy(ROOM, "at"), room_id: ROOM })],
        ["missing room", JSON.stringify({ openid_token: legacy(ROOM, "at").openid_token })],
        ["room not a string", JSON.stringify({ ...legacy(ROOM, "at"), room: 5 })],
        ["control character", JSON.stringify({ ...legacy(ROOM, "at"), device_id: "a\u0000b" })],
        ["broken UTF-16", JSON.stringify(legacy(ROOM, "at")).replace("DEV1", "\\ud800")],
        ["no openid token", JSON.stringify({ room: ROOM, device_id: "D" })],
        ["openid token unknown field", JSON.stringify({ ...legacy(ROOM, "at"), openid_token: { ...legacy(ROOM, "at").openid_token, x: 1 } })],
        ["expires_in not an integer", JSON.stringify({ ...legacy(ROOM, "at"), openid_token: { ...legacy(ROOM, "at").openid_token, expires_in: "3600" } })],
    ];
    for (const [what, raw] of cases) {
        const r = await post("/sfu/get", undefined, { raw });
        assert.equal(r.statusCode, 400, what);
        assert.equal(r.body.errcode, "M_BAD_JSON", what);
    }
    assert.equal((await post("/sfu/get", legacy(ROOM, "at", SN, "DEV:1"))).statusCode, 400, "a device id with ':' (ambiguous identity)");
    assert.equal(upCalls.length, 0);
});

test("what_lk_jwt_receives_is_the_checked_request_re_encoded", async () => {
    const { post, upCalls } = setup();
    // duplicate keys: JSON.parse and Go both keep the last; lk-jwt still gets our own encoding, never the bytes
    const raw = `{"room":"elsewhere","room":"${ROOM}","openid_token":{"access_token":"at","matrix_server_name":"${SN}"},"device_id":"D"}`;
    assert.equal((await post("/sfu/get", undefined, { raw })).statusCode, 200);
    assert.equal(upCalls[0].body, JSON.stringify({ room: ROOM, openid_token: { access_token: "at", token_type: "", matrix_server_name: SN, expires_in: 0 }, device_id: "D" }));
    assert.deepEqual(parseRequest(canonicalBody(parseRequest(upCalls[0].body, true)), true), parseRequest(upCalls[0].body, true));
});

test("a_rejected_sign_in_is_401", async () => {
    const { post, upCalls } = setup();
    const r = await post("/sfu/get", legacy(ROOM, "nope"));
    assert.equal(r.statusCode, 401);
    assert.equal(upCalls.length, 0);
});

test("federated_member_passes_and_a_federated_non_member_never_reaches_lk_jwt", async () => {
    const { post, upCalls, logs, fedCalls } = setup();
    const r = await post("/sfu/get", legacy(ROOM, "rb1", "other.test"));
    assert.equal(r.statusCode, 200, "a member from another server, as this server sees the room");
    assert.equal(upCalls.length, 1);
    assert.deepEqual(fedCalls, ["other.test"], "resolved here, through fedresolve");
    // @b2 is not in the room although a member of their server is: refused BEFORE lk-jwt is asked (0.3.8; 0.3.7 let
    // lk-jwt sign a token and dropped it)
    const r2 = await post("/sfu/get", legacy(ROOM, "rb2", "other.test"));
    assert.deepEqual([r2.statusCode, r2.body], [403, NOT_MEMBER]);
    assert.equal(upCalls.length, 1, "lk-jwt never signs for a non-member");
    assert.ok(!logs.some((l) => l.includes("dropped a minted token")));
    // a room with nobody from there; a token that server doesn't know; a server that vouches for someone elsewhere
    assert.equal((await post("/sfu/get", legacy(OTHER, "rb1", "other.test"))).statusCode, 403);
    assert.equal((await post("/sfu/get", legacy(ROOM, "x", "evil.example"))).statusCode, 401);
    assert.equal((await post("/sfu/get", legacy(ROOM, "rb1", "evil.example"))).statusCode, 401, "evil.example can't vouch for @b1:other.test");
    assert.equal(upCalls.length, 1);
});

test("a_remote_server_on_a_private_address_or_unreachable_is_refused_closed", async () => {
    const { post, upCalls } = setup();
    const p = await post("/sfu/get", legacy(ROOM, "rb1", "private.test"));
    assert.deepEqual([p.statusCode, p.body.reason], [403, "remote-refused"]);
    const d = await post("/sfu/get", legacy(ROOM, "rb1", "down.test"));
    assert.deepEqual([d.statusCode, d.body.reason], [502, "check-failed"]);
    // an alias that isn't a room id from another server: refused without any lookup
    const { post: post2, fedCalls } = setup();
    assert.equal((await post2("/sfu/get", legacy("lobby", "rb1", "other.test"))).statusCode, 403);
    assert.deepEqual(fedCalls, []);
    assert.equal(upCalls.length, 0);
});

test("a_remote_sign_in_is_cached_and_counts_against_the_lookup_budget", async () => {
    const { post, fedCalls, now } = setup();
    for (let i = 0; i < 3; i++) assert.equal((await post("/sfu/get", legacy(ROOM, "rb1", "other.test"))).statusCode, 200);
    assert.equal(fedCalls.length, 1, "one lookup per minute for the same sign-in");
    now.advance(CALLTOKEN.USER_TTL_MS);
    await post("/sfu/get", legacy(ROOM, "rb1", "other.test"));
    assert.equal(fedCalls.length, 2);
    // the same token string from another server is another sign-in
    await post("/sfu/get", legacy(ROOM, "rb1", "third.test"));
    assert.equal(fedCalls.length, 3);
});

test("a_minted_token_for_another_identity_is_never_handed_out", async () => {
    const { s, post } = setup();
    s.forceIdentity = `${BOB}:DEV1`;  // lk-jwt answering for someone other than the caller checked (defence in depth)
    assert.deepEqual((await post("/sfu/get", legacy(ROOM, "at"))).body, NOT_MEMBER);
    s.forceIdentity = `${RB2}:DEV1`;
    assert.equal((await post("/sfu/get", legacy(ROOM, "rb1", "other.test"))).statusCode, 403);
});

// Element Call's newer method, exactly as its current source sends it (element-call main 6793a4b, 2026-10-28:
// sdk/src/media-backend/livekit/auth/openID.ts getLiveKitJWT; member.id is a uuid in Matrix 2.0 mode, else
// `${userId}:${deviceId}` (RTCParticipation.ts); delay_* only when delegating a delayed leave).
const ecToken = (room, tok, user, server = SN, { memberId = "3f0c8a52-6b0e-4d0e-9a8e-1c2d3e4f5a6b", device = "ECDEV", delay = false, slot = "m.call#ROOM" } = {}) => ({
    room_id: room, slot_id: slot,
    openid_token: { access_token: tok, token_type: "Bearer", matrix_server_name: server, expires_in: 3600 },
    member: { id: memberId, claimed_user_id: user, claimed_device_id: device },
    ...(delay ? { delay_id: "syd_abc", delay_timeout: 10000, delay_cs_api_url: `https://${server}` } : {}),
});

test("element_calls_newer_token_method_gets_the_rooms_own_call", async () => {
    const { post, upCalls } = setup();
    for (const [path, opts] of [["/get_token", {}], ["/get_token", { delay: true }], ["/sfu/get", {}], ["/get_token", { memberId: `${ALICE}:ECDEV` }]]) {
        const n = upCalls.length;
        const r = await post(path, ecToken(ROOM, "at", ALICE, SN, opts));
        assert.equal(r.statusCode, 200, `${path} ${JSON.stringify(opts)}`);
        const p = JSON.parse(Buffer.from(r.body.jwt.split(".")[1], "base64url"));
        assert.deepEqual([p.video.room, p.sub], [ROOM, `${ALICE}:ECDEV`], "the room the call runs in, the verified identity");
        assert.equal(upCalls.length, n + 1);
        assert.ok(upCalls.at(-1).url.endsWith("/sfu/get"), "asked as /sfu/get");
        assert.deepEqual(JSON.parse(upCalls.at(-1).body), { room: ROOM, openid_token: ecToken(ROOM, "at", ALICE).openid_token, device_id: "ECDEV" },
            "exactly the checked legacy request: no member.id, no slot, no delay fields");
    }
});

test("element_calls_newer_method_from_another_server_is_checked_the_same_way", async () => {
    const { post, upCalls } = setup();
    const r = await post("/get_token", ecToken(ROOM, "rb1", RB1, "other.test"));
    assert.equal(r.statusCode, 200, "a federated member subscribing to this server's call server");
    const r2 = await post("/get_token", ecToken(ROOM, "rb2", RB2, "other.test"));
    assert.deepEqual([r2.statusCode, r2.body], [403, NOT_MEMBER]);
    assert.equal(upCalls.length, 1);
});

test("the_newer_method_is_refused_where_it_would_be_unsafe", async () => {
    const { post, upCalls } = setup();
    const cases = [
        ["claims to be someone else", ecToken(ROOM, "at", BOB), 401],
        ["a room the caller isn't in", ecToken(OTHER, "at", ALICE), 403],
        ["not a room id", ecToken("lobby", "at", ALICE), 403],
        ["another slot", ecToken(ROOM, "at", ALICE, SN, { slot: "m.call#other" }), 403],
        ["a device with ':'", ecToken(ROOM, "at", ALICE, SN, { device: "A:B" }), 400],
        ["an unknown field", { ...ecToken(ROOM, "at", ALICE), extra: 1 }, 400],
        ["a non-integer delay_timeout", { ...ecToken(ROOM, "at", ALICE, SN, { delay: true }), delay_timeout: "10" }, 400],
        ["missing member", { ...ecToken(ROOM, "at", ALICE), member: undefined }, 400],
        ["a nested key in another case (Go would read it)", { ...ecToken(ROOM, "at", ALICE), member: { ID: "x", claimed_user_id: ALICE, claimed_device_id: "D" } }, 400],
        ["a top-level key in another case", { ...ecToken(ROOM, "at", ALICE), Room_Id: OTHER }, 400],
    ];
    for (const [name, body, want] of cases) assert.equal((await post("/get_token", body)).statusCode, want, name);
    const slot = await post("/get_token", ecToken(ROOM, "at", ALICE, SN, { slot: "m.call#other" }));
    assert.equal(slot.body.reason, "unsupported");
    assert.equal(upCalls.length, 0, "lk-jwt never asked");
    assert.equal((await post("/get_token", legacy(ROOM, "at"))).statusCode, 400, "/get_token takes only the MSC4195 shape");
});

test("kill_switch_off_hands_everything_to_lk_jwt_unchanged", async () => {
    const { post, upCalls, hsCalls } = setup({ enabled: false });
    const raw = JSON.stringify(legacy("anything-else", "at"));
    const r = await post("/sfu/get", undefined, { raw });
    assert.equal(r.statusCode, 200);
    assert.equal(upCalls[0].body.toString(), raw, "the caller's own bytes");
    const bad = await post("/sfu/get", undefined, { raw: "{" });
    assert.equal(bad.statusCode, 400, "lk-jwt's own answer is relayed");
    assert.equal(hsCalls.length, 0, "nothing checked");
});

test("kill_switch_off_also_drops_this_routes_own_rate_limit", async () => {
    const { post, upCalls } = setup({ enabled: false });
    const raw = JSON.stringify(legacy("anything-else", "at"));
    let ok = 0;
    for (let i = 0; i < CALLTOKEN.PER_CLIENT_PER_MIN + 5; i++) if ((await post("/sfu/get", undefined, { raw })).statusCode === 200) ok++;
    assert.equal(ok, CALLTOKEN.PER_CLIENT_PER_MIN + 5, "lk-jwt alone decides, as before 0.3.7");
    assert.equal(upCalls.length, CALLTOKEN.PER_CLIENT_PER_MIN + 5);
});

test("the apps_connection_test_room_is_the_12x_name_tinhat_conntest", async () => {
    assert.equal(isOwnConnTestRoom("tinhat-conntest-alice-4242", "@alice:home.test"), true);
    assert.equal(isOwnConnTestRoom("tinhat-conntest-alice-4242", "@bob:home.test"), false);
    assert.equal(isOwnConnTestRoom("conntest-alice-4242", "@alice:home.test"), false);
});

test("fails_closed_when_synapse_or_lk_jwt_cannot_be_asked", async () => {
    const { s, post, upCalls } = setup();
    s.down = true;
    const r = await post("/sfu/get", legacy(ROOM, "at"));
    assert.deepEqual([r.statusCode, r.body.reason], [502, "check-failed"]);
    assert.equal(upCalls.length, 0);
    s.down = false;
    s.jwtDown = true;
    assert.equal((await post("/sfu/get", legacy(ROOM, "at"))).statusCode, 502);
});

test("someone removed from the room is refused at once: a member list never lets anyone in from cache", async () => {
    const { s, post, hsCalls } = setup();
    assert.equal((await post("/sfu/get", legacy(ROOM, "at"))).statusCode, 200);
    s.rooms[ROOM] = s.rooms[ROOM].filter((m) => m !== ALICE);  // kicked
    assert.deepEqual((await post("/sfu/get", legacy(ROOM, "at"))).body, NOT_MEMBER, "no 3 s of grace for a leaver");
    assert.equal(hsCalls.filter((p) => p.includes("/members")).length, 2, "read fresh for every token handed out");
});

test("caches_a_sign_in_up_to_a_minute_and_never_a_member_list", async () => {
    const { s, now, post, hsCalls } = setup();
    const userinfo = () => hsCalls.filter((p) => p.includes("openid/userinfo")).length;
    const memberLists = () => hsCalls.filter((p) => p.includes("/members")).length;
    assert.equal((await post("/sfu/get", legacy(OTHER, "at"))).statusCode, 403);
    s.rooms[OTHER].push(ALICE);  // she joins
    assert.equal((await post("/sfu/get", legacy(OTHER, "at"))).statusCode, 200, "a fresh joiner gets in at once (no cached refusal)");
    assert.equal(userinfo(), 1, "one sign-in lookup for both");
    assert.equal(memberLists(), 2, "the member list is read for every request");
    now.advance(CALLTOKEN.USER_TTL_MS);
    await post("/sfu/get", legacy(OTHER, "at"));
    assert.equal(userinfo(), 2, "looked up again after a minute");
    // a token that expires sooner is kept only that long
    const short = legacy(ROOM, "ab");
    short.openid_token.expires_in = 2;
    s.rooms[ROOM].push(BOB);
    await post("/sfu/get", short);
    now.advance(2001);
    await post("/sfu/get", short);
    assert.equal(userinfo(), 4);
});

test("rate_limits_per_caller_address", async () => {
    const { post } = setup();
    for (let i = 0; i < CALLTOKEN.PER_CLIENT_PER_MIN; i++) assert.equal((await post("/sfu/get", legacy(ROOM, "at"), { ip: "2001:db8:1:2::5" })).statusCode, 200);
    const r = await post("/sfu/get", legacy(ROOM, "at"), { ip: "2001:db8:1:2::99" });
    assert.equal(r.statusCode, 429, "the same /64");
    assert.equal(r.headers["retry-after"], "10");
    assert.equal((await post("/sfu/get", legacy(ROOM, "at"), { ip: "192.0.2.99" })).statusCode, 200, "someone else");
});

test("sign_in_lookups_have_their_own_budget", async () => {
    const { post } = setup();
    for (let i = 0; i < CALLTOKEN.LOOKUPS_PER_CLIENT_MIN; i++) assert.equal((await post("/sfu/get", legacy(ROOM, `junk${i}`))).statusCode, 401);
    assert.equal((await post("/sfu/get", legacy(ROOM, "junk-more"))).statusCode, 429);
});

test("preflight_and_other_methods", async () => {
    const { post } = setup();
    const o = await post("/sfu/get", undefined, { method: "OPTIONS" });
    assert.equal(o.statusCode, 200);
    assert.equal(o.headers["access-control-allow-methods"], "POST");
    assert.equal((await post("/sfu/get", undefined, { method: "GET" })).statusCode, 405);
    const big = await post("/sfu/get", undefined, { raw: "x".repeat(CALLTOKEN.MAX_BODY + 1) });
    assert.equal(big.statusCode, 413);
});

test("a_newcomer_whose_call_join_follows_someone_elses_within_seconds_is_let_in", async () => {
    // the assembly-037 gate race: Bob's token read the member list, Alice joins the room a moment later, her call join
    // must not be refused from Bob's read (a guest let in, an invite accepted and the call joined right away)
    const { s, post } = setup();
    if (!s.rooms[OTHER].includes(BOB)) s.rooms[OTHER].push(BOB);
    assert.equal((await post("/sfu/get", legacy(OTHER, "ab"))).statusCode, 200, "Bob (a member) reads the list");
    s.rooms[OTHER].push(ALICE);
    assert.equal((await post("/sfu/get", legacy(OTHER, "at"))).statusCode, 200);
});

test("a joiner whose request shares a member read that started before the join is not refused (assembly-038)", async () => {
    const { s, post, hsCalls } = setup();
    const memberLists = () => hsCalls.filter((p) => p.includes("/members")).length;
    let release;
    s.hold = new Promise((r) => { release = r; });
    const ticks = async (n) => { for (let k = 0; k < n; k++) await new Promise((r) => setImmediate(r)); };
    const bob = post("/sfu/get", legacy(OTHER, "ab"));            // Bob's read starts: OTHER = [Bob]
    for (let k = 0; k < 200 && memberLists() < 1; k++) await ticks(1);
    assert.equal(memberLists(), 1, "Bob's read is running");
    s.rooms[OTHER].push(ALICE);                                  // Alice joins while it runs
    const alice = post("/sfu/get", legacy(OTHER, "at"));         // her request shares Bob's read
    await ticks(50);
    assert.equal(memberLists(), 1, "her request shares it (no read of its own yet)");
    s.hold = null;
    release();
    assert.equal((await bob).statusCode, 200);
    assert.equal((await alice).statusCode, 200, "the shared read's no is read again");
    assert.equal(memberLists(), 2, "one extra read, only for the shared no");
    // someone really not in the room is still refused when they share a read (after the one extra read)
    s.hold = new Promise((r) => { release = r; });
    const b2 = post("/sfu/get", legacy(OTHER, "ab"));
    for (let k = 0; k < 200 && memberLists() < 3; k++) await ticks(1);
    const stranger = post("/sfu/get", legacy(OTHER, "ag"));      // the guest isn't in OTHER
    await ticks(50);
    assert.equal(memberLists(), 3, "the stranger shares Bob's second read");
    s.hold = null;
    release();
    assert.equal((await b2).statusCode, 200);
    assert.deepEqual((await stranger).body, NOT_MEMBER);
    assert.equal(memberLists(), 4, "one read of its own, then the no stands");
});
