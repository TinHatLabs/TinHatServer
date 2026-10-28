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
                return { ok: true, status: 200, body: { members: s.rooms[room], total: s.rooms[room].length } };
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
    const ct = createCallToken({ hs, adminToken: "admintoken", serverName: SN, lkJwtUrl: "http://127.0.0.1:8070", fetchImpl, now, log: (l) => logs.push(l), enabled: () => enabled });
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
    return { s, now, ct, post, hsCalls, upCalls, logs };
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

test("federated_member_passes_and_a_federated_non_member_is_dropped", async () => {
    const { post, upCalls, logs } = setup();
    const r = await post("/sfu/get", legacy(ROOM, "rb1", "other.test"));
    assert.equal(r.statusCode, 200, "a member from another server, as this server sees the room");
    // @b2 is not in the room, but a member of their server is: lk-jwt is asked, its token is dropped
    const r2 = await post("/sfu/get", legacy(ROOM, "rb2", "other.test"));
    assert.deepEqual([r2.statusCode, r2.body], [403, NOT_MEMBER]);
    assert.equal(upCalls.length, 2);
    assert.ok(logs.some((l) => l.includes("dropped a minted token")));
    // nobody from that server in the room: refused before lk-jwt is asked (it never looks the server up)
    const r3 = await post("/sfu/get", legacy(OTHER, "rb1", "other.test"));
    assert.equal(r3.statusCode, 403);
    const r4 = await post("/sfu/get", legacy(ROOM, "x", "evil.example"));
    assert.equal(r4.statusCode, 403);
    assert.equal(upCalls.length, 2);
});

test("a_minted_token_for_another_identity_is_never_handed_out", async () => {
    const { s, post } = setup();
    s.forceIdentity = `${BOB}:DEV1`;  // lk-jwt answering for someone other than the caller checked (defence in depth)
    assert.deepEqual((await post("/sfu/get", legacy(ROOM, "at"))).body, NOT_MEMBER);
    s.forceIdentity = `${RB2}:DEV1`;
    assert.equal((await post("/sfu/get", legacy(ROOM, "rb1", "other.test"))).statusCode, 403);
});

test("msc4195_requests_are_refused_on_both_paths", async () => {
    const { post, upCalls, hsCalls } = setup();
    const UNSUPPORTED = { errcode: "M_FORBIDDEN", error: "this server's calls use /sfu/get", reason: "unsupported" };
    for (const [path, body] of [["/get_token", modern(ROOM, "at", ALICE)], ["/sfu/get", modern(ROOM, "at", ALICE)],
                                ["/get_token", modern(ROOM, "rb1", RB1, "other.test")]]) {
        const r = await post(path, body);
        assert.deepEqual([r.statusCode, r.body], [403, UNSUPPORTED], path);
    }
    assert.equal(upCalls.length, 0, "lk-jwt never asked: it would mint for a hashed room with a client-chosen identity");
    assert.equal(hsCalls.length, 0);
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
