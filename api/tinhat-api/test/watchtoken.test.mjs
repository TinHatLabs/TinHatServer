// calltoken.mjs watchHandler — Pad Watch's subscribe-only token (WATCH-LEASE/DESIGN.md §1). Driven through the real
// handler with a scripted Synapse (OpenID userinfo, the admin member list, the admin device lookup) and a scripted call
// server (RoomService ListParticipants). The minted token is verified with the secret and every grant field pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createCallToken, parseRequest, watchGrant, isWatchIdentity, CALLTOKEN } from "../calltoken.mjs";
import { permBool } from "../moderation.mjs";
import { parseIdentity } from "../identity.mjs";
import { fakeReq, clock } from "./helpers.mjs";

const SN = "home.test", KEY = "lkkey", SECRET = ["test", "only", "0123456789abcdef"].join("-");
const ALICE = `@alice:${SN}`, BOB = `@bob:${SN}`;
const ROOM = `!call:${SN}`, EMPTY = `!empty:${SN}`;

function setup({ lk = true } = {}) {
    const s = {
        local: { at: ALICE, ab: BOB },
        rooms: { [ROOM]: [ALICE, BOB], [EMPTY]: [ALICE] },
        devices: { [ALICE]: ["PHONE", "DESK", "OTHER"], [BOB]: ["BPHONE"] },
        // LiveKit participants per room
        sfu: { [ROOM]: [`${ALICE}:DESK`, `${BOB}:BPHONE`] },
        lkDown: false, hsDown: false,
    };
    const lkCalls = [], logs = [];
    const hs = {
        async get(path, token) {
            if (s.hsDown) throw new Error("ECONNREFUSED");
            let m;
            if ((m = /^\/_matrix\/federation\/v1\/openid\/userinfo\?access_token=(.*)$/.exec(path))) {
                const u = s.local[decodeURIComponent(m[1])];
                return u ? { ok: true, status: 200, body: { sub: u } } : { ok: false, status: 401, body: {} };
            }
            assert.equal(token, "admintoken");
            if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/members$/.exec(path))) {
                const room = decodeURIComponent(m[1]);
                if (!(room in s.rooms)) return { ok: false, status: 404, body: {} };
                return { ok: true, status: 200, body: { members: s.rooms[room] } };
            }
            if ((m = /^\/_synapse\/admin\/v2\/users\/([^/]+)\/devices\/([^/]+)$/.exec(path))) {
                const u = decodeURIComponent(m[1]), d = decodeURIComponent(m[2]);
                return (s.devices[u] || []).includes(d) ? { ok: true, status: 200, body: { device_id: d, user_id: u } } : { ok: false, status: 404, body: {} };
            }
            throw new Error(`unexpected ${path}`);
        },
    };
    async function fetchImpl(url, init) {
        if (url.startsWith("http://127.0.0.1:8070")) throw new Error("lk-jwt must never be asked for a Watch token");
        const m = /^http:\/\/127\.0\.0\.1:7880\/twirp\/livekit\.RoomService\/(ListParticipants|ListRooms|RemoveParticipant)$/.exec(url);
        assert.ok(m, url);
        assert.equal(init.redirect, "error");
        const auth = init.headers.Authorization.slice(7).split(".");
        assert.equal(createHmac("sha256", SECRET).update(`${auth[0]}.${auth[1]}`).digest("base64url"), auth[2]);
        const claims = JSON.parse(Buffer.from(auth[1], "base64url").toString());
        const body = JSON.parse(init.body);
        lkCalls.push({ method: m[1], body, claims });
        if (s.lkDown) return new Response("{}", { status: 500 });
        if (m[1] === "ListRooms") {
            assert.deepEqual(claims.video, { roomList: true });
            return new Response(JSON.stringify({ rooms: Object.keys(s.sfu).map((name) => ({ name, num_participants: s.sfu[name].length })) }), { status: 200 });
        }
        assert.deepEqual(claims.video, { room: body.room, roomAdmin: true });   // one room only
        if (!(body.room in s.sfu)) return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
        const asP = (x) => (typeof x === "string" ? { identity: x, permission: { can_subscribe: true, can_publish: !/[~#]/.test(x), can_publish_data: !/[~#]/.test(x) } } : x);
        if (m[1] === "RemoveParticipant") {
            if (s.removeFails) return new Response(JSON.stringify({ code: "unavailable" }), { status: 503 });
            if (!s.removeNoop) s.sfu[body.room] = s.sfu[body.room].filter((x) => asP(x).identity !== body.identity);
            return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ participants: s.sfu[body.room].map(asP) }), { status: 200 });
    }
    const wall = 1_800_000_000_000;
    const ct = createCallToken({
        hs, adminToken: "admintoken", serverName: SN, lkJwtUrl: "http://127.0.0.1:8070", fetchImpl, now: clock(1000),
        log: (l) => logs.push(l), enabled: () => false /* the owner's switch off: Watch still checks */,
        lkKey: lk ? KEY : "", lkSecret: lk ? SECRET : "", lkApiUrl: "http://127.0.0.1:7880", sfuUrl: "wss://home.test/livekit/sfu",
        wallNow: () => wall, sweep: false,
    });
    async function post(body, { method = "POST", ip = "192.0.2.10" } = {}) {
        const res = { statusCode: 200, headers: {}, body: undefined };
        res.status = (c) => { res.statusCode = c; return res; };
        res.set = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
        res.json = (o) => { res.body = o; return res; };
        res.end = () => res;
        await ct.watchHandler()(fakeReq({ method, headers: { "x-forwarded-for": ip }, body }), res);
        return res;
    }
    return { s, post, lkCalls, logs, wall, ct };
}
const ask = (over = {}) => ({ room: ROOM, openid_token: { access_token: "at", token_type: "Bearer", matrix_server_name: SN, expires_in: 3600 }, device_id: "PHONE", ...over });
function verify(jwt) {
    const [h, b, sig] = jwt.split(".");
    assert.equal(createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url"), sig, "signed with the LiveKit secret");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "HS256", typ: "JWT" });
    return JSON.parse(Buffer.from(b, "base64url").toString());
}

test("W01 a paired local member gets a subscribe-only token for that one room, distinct identity, 5 minutes", async () => {
    const { post, wall, logs } = setup();
    const r = await post(ask());
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.body.url, "wss://home.test/livekit/sfu");
    const p = verify(r.body.jwt);
    const nowS = Math.floor(wall / 1000);
    assert.match(p.sub, /^@alice:home\.test:PHONE~watch-[0-9a-f]{16}$/, "a fresh nonce on every Watch identity");
    assert.deepEqual(p, {
        iss: KEY, sub: p.sub, name: ALICE, nbf: nowS - 10, exp: nowS + 300,
        video: { room: ROOM, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, canPublishSources: [],
                 canUpdateOwnMetadata: false, hidden: false, recorder: false, agent: false },
        attributes: { "tinhat.watch": "1", "tinhat.person": ALICE, "tinhat.pad": "phone", "tinhat.mode": "watch" },
    });
    assert.ok(!logs.some((l) => l.includes(r.body.jwt.split(".")[2])), "the token is never logged");
});

test("W02 watchGrant has no publish right of any kind and no admin right", () => {
    const g = watchGrant({ key: KEY, user: ALICE, device: "X", room: ROOM, nowS: 100 });
    for (const k of ["canPublish", "canPublishData", "canUpdateOwnMetadata", "roomAdmin", "roomCreate", "roomList", "roomRecord", "ingressAdmin", "recorder", "agent", "hidden"])
        assert.ok(!g.video[k], k);
    assert.deepEqual(g.video.canPublishSources, []);
    assert.ok(isWatchIdentity(g.sub));
    assert.equal(g.exp - g.nbf, CALLTOKEN.WATCH_TTL_S + 10);
});

test("W06 a device that isn't the caller's -> refused", async () => {
    const t = setup();
    assert.equal((await t.post(ask({ device_id: "BPHONE" }))).body.reason, "not-your-device");
});

test("W07 not a joined member of the room -> refused, the call server never asked", async () => {
    const t = setup();
    t.s.rooms[ROOM] = [BOB];
    const r = await t.post(ask());
    assert.equal(r.body.reason, "not-member");
    assert.equal(t.lkCalls.length, 0);
});

test("W08 another server's account -> refused (local accounts only in v1)", async () => {
    const t = setup();
    const r = await t.post(ask({ openid_token: { access_token: "at", token_type: "Bearer", matrix_server_name: "other.test", expires_in: 3600 } }));
    assert.equal(r.statusCode, 403); assert.equal(r.body.reason, "watch-local-only");
});

test("W09 a bad sign-in -> 401", async () => {
    const t = setup();
    assert.equal((await t.post(ask({ openid_token: { access_token: "nope", token_type: "Bearer", matrix_server_name: SN, expires_in: 3600 } }))).statusCode, 401);
});

test("W10 the connection-test scratch room or a non-room id -> refused", async () => {
    const t = setup();
    assert.equal((await t.post(ask({ room: "tinhat-conntest-alice-1" }))).body.reason, "not-member");
});

test("W11 '~', '#' or ':' in a device id is refused on every route (no normal token can carry a watch identity)", async () => {
    const t = setup();
    for (const d of ["PHONE~watch-0123456789abcdef", "PHONE#watch", "A:B"]) {
        assert.equal((await t.post(ask({ device_id: d }))).statusCode, 400, d);
        assert.ok(parseRequest(JSON.stringify(ask({ device_id: d })), true).error, d);
    }
});

test("W18 a device id outside moderation's grammar is not served (every watcher must be disconnectable)", async () => {
    const t = setup();
    t.s.devices[ALICE].push("PHONE.1", "X".repeat(65));
    // (0.3.13 Step A: refused as a malformed request before the device lookup — never served either way)
    for (const d of ["PHONE.1", "X".repeat(65)]) {
        const r = await t.post(ask({ device_id: d }));
        assert.ok(r.statusCode === 400 || r.body.reason === "no-device", JSON.stringify([d, r.statusCode, r.body]));
        assert.equal(r.body.jwt, undefined);
    }
});

test("W19 every Watch request asks Synapse afresh (no cached sign-in: the API signs by itself)", async () => {
    const t = setup();
    const r1 = await t.post(ask());
    assert.equal(r1.statusCode, 200);
    delete t.s.local.at;  // the OpenID token expired on Synapse
    const r2 = await t.post(ask());
    assert.equal(r2.statusCode, 401, "the cache of the first answer is not used");
});

test("W20 isWatchIdentity: only ~watch with no '#' anywhere (LiveKit's publish=X appends #X with publish rights)", () => {
    assert.ok(isWatchIdentity(`${ALICE}:PHONE~watch-0123456789abcdef`));
    for (const id of [`${ALICE}:PHONE#watch`, `${ALICE}:PHONE~watch#watch`, `${ALICE}:PHONE#x~watch-0123456789abcdef`, `${ALICE}:PHONE`]) assert.ok(!isWatchIdentity(id), id);
});

test("W12 an MSC4195 body is not a Watch request", async () => {
    const t = setup();
    const r = await t.post({ room_id: ROOM, slot_id: "m.call#ROOM", openid_token: ask().openid_token, member: { id: "x", claimed_user_id: ALICE, claimed_device_id: "PHONE" } });
    assert.equal(r.statusCode, 400);
});

test("W13 fails closed: Synapse or the call server down -> 502, never a token", async () => {
    let t = setup(); t.s.lkDown = true;
    let r = await t.post(ask()); assert.equal(r.statusCode, 502); assert.equal(r.body.jwt, undefined);
    t = setup(); t.s.hsDown = true;
    r = await t.post(ask()); assert.equal(r.statusCode, 502);
});

test("W14 a server without the LiveKit key/secret: the route is absent (404), also for OPTIONS (= Watch not offered)", async () => {
    const t = setup({ lk: false });
    assert.equal((await t.post(ask())).statusCode, 404);
    assert.equal((await t.post(undefined, { method: "OPTIONS" })).statusCode, 404);
});

test("W15 OPTIONS answers 200 on a server that offers Watch; GET is 405", async () => {
    const t = setup();
    assert.equal((await t.post(undefined, { method: "OPTIONS" })).statusCode, 200);
    assert.equal((await t.post(undefined, { method: "GET" })).statusCode, 405);
});

test("W16 the owner's CALL_TOKEN_ROOM_CHECK=off doesn't open the Watch route (setup passes enabled=false)", async () => {
    const t = setup();
    t.s.rooms[ROOM] = [BOB];
    assert.equal((await t.post(ask())).statusCode, 403);
});

test("W17 moderation's permission copy: missing field = false (protojson omits false), {} = all false, none = refuse", () => {
    assert.equal(permBool({ canSubscribe: true }, "can_publish", "canPublish"), false);
    assert.equal(permBool({ canSubscribe: true, canPublish: true }, "can_publish", "canPublish"), true);
    assert.equal(permBool({ can_publish: false, can_subscribe: true }, "can_publish", "canPublish"), false);
    assert.equal(permBool({}, "can_publish", "canPublish"), false);
    assert.equal(permBool({ canPublish: "true" }, "can_publish", "canPublish"), false);
    for (const bad of [undefined, null, [], "x"]) assert.throws(() => permBool(bad, "can_publish", "canPublish"), String(bad));
});

const pub = (identity, extra = {}) => ({ identity, permission: { can_subscribe: true, can_publish: true, can_publish_data: true }, ...extra });
const sub = (identity, extra = {}) => ({ identity, permission: { can_subscribe: true, can_publish: false, can_publish_data: false, can_publish_sources: [] }, ...extra });

test("W21 a reserved identity holding publish rights in the call is removed BEFORE the Watch token exists (no resume onto it)", async () => {
    const t = setup();
    t.s.sfu[ROOM] = [`${ALICE}:DESK`, pub(`${ALICE}:PHONE~watch-0123456789abcdef`), `${BOB}:BPHONE`];
    const r = await t.post(ask());
    assert.equal(r.statusCode, 200);
    const rm = t.lkCalls.filter((c) => c.method === "RemoveParticipant");
    assert.deepEqual(rm.map((c) => c.body.identity), [`${ALICE}:PHONE~watch-0123456789abcdef`]);
    assert.ok(t.lkCalls.indexOf(rm[0]) < t.lkCalls.length, "removed during the check");
    assert.ok(!t.s.sfu[ROOM].some((x) => (x.identity ?? x) === `${ALICE}:PHONE~watch-0123456789abcdef`));
});

test("W22 the sweep: every call, every reserved identity with any right / a track / unreadable rights out; watchers and normal ones stay", async () => {
    const t = setup();
    t.s.sfu = {
        [ROOM]: [pub(`${ALICE}:DESK`), sub(`${ALICE}:PHONE~watch-0123456789abcdef`), pub(`${BOB}:B~watch-0123456789abcdef`), pub(`${BOB}:B#x`)],
        "!two:home.test": [sub(`${BOB}:T~watch-0123456789abcdef`, { tracks: [{ sid: "TR_1" }] }), { identity: `${BOB}:U~watch-0123456789abcdef` }, sub(`${BOB}:V~watch-0123456789abcdef`, { permission: { can_subscribe: true, can_update_metadata: true } }),
            sub(`${BOB}:W~watchx`), sub(`${BOB}:X#watch`), sub(`${BOB}:OK~watch-0123456789abcdef`)],
    };
    assert.equal(await t.ct.sweep(), 7);
    assert.deepEqual(t.s.sfu[ROOM].map((x) => x.identity), [`${ALICE}:DESK`, `${ALICE}:PHONE~watch-0123456789abcdef`]);
    assert.deepEqual(t.s.sfu["!two:home.test"].map((x) => x.identity), [`${BOB}:OK~watch-0123456789abcdef`]);
    t.s.lkDown = true;
    assert.equal(await t.ct.sweep(), 0, "never throws");
});

test("W24 moderation parses every identity a call can carry: IPv6 server names, ports, LAPTOP.1, ~watch-0123456789abcdef", () => {
    // (0.3.12 + Step A: identity.mjs parseIdentity is the ONE call-identity parser; a device takes DEVICE_RE, '+' '/' included)
    for (const [id, mx, dev, w] of [
        ["@a:[2001:db8::1]:PHONE~watch-0123456789abcdef", "@a:[2001:db8::1]", "PHONE", true],
        ["@a:[2001:db8::1]:8448:LAPTOP", "@a:[2001:db8::1]:8448", "LAPTOP", false],
        ["@a:h.test:8448:PHONE~watch-0123456789abcdef", "@a:h.test:8448", "PHONE", true],
        ["@a:h.test:Ab+c/D", "@a:h.test", "Ab+c/D", false],
    ]) {
        const m = parseIdentity(id);
        assert.ok(m, id);
        assert.deepEqual([m.mxid, m.device, m.watch === true], [mx, dev, w], id);
    }
    for (const bad of ["@a:h.test:PHONE#watch", "@a:h.test:PH~ONE", "@a:h.test:", "@a:h.test:PHONE~watch~watch-0123456789abcdef", "a:h.test:D", "@a:h.test:LAPTOP.1", "@a:h.test:P~watch-0123456789ABCDEF"]) assert.equal(parseIdentity(bad), null, bad);
});

test("W25 FAIL CLOSED: a reserved publishing identity that can't be removed → no Watch token (502), an ALERT in the log", async () => {
    const t = setup();
    t.s.sfu[ROOM] = [`${ALICE}:DESK`, pub(`${ALICE}:PHONE~watch`)];
    t.s.removeFails = true;
    const r = await t.post(ask());
    assert.equal(r.statusCode, 502);
    assert.equal(r.body.jwt, undefined);
    assert.ok(t.logs.some((l) => l.includes("ALERT")), t.logs.join("\n"));
});

test("W26 FAIL CLOSED: removal answered OK but the identity is still listed → no Watch token", async () => {
    const t = setup();
    t.s.sfu[ROOM] = [`${ALICE}:DESK`, pub(`${ALICE}:PHONE#watch`)];
    t.s.removeNoop = true;
    const r = await t.post(ask());
    assert.equal(r.statusCode, 502);
    assert.equal(r.body.jwt, undefined);
});

test("W27 the sweep logs an ALERT when a removal fails, keeps going with the other calls, never throws", async () => {
    const t = setup();
    t.s.sfu = { [ROOM]: [pub(`${BOB}:B~watch`)], "!two:home.test": [pub(`${BOB}:C#x`)] };
    t.s.removeFails = true;
    assert.equal(await t.ct.sweep(), 0);
    assert.equal(t.logs.filter((l) => l.includes("ALERT")).length, 2);
    t.s.removeFails = false;
    assert.equal(await t.ct.sweep(), 2);
});

test("W28 two Watch tokens for the same device never share an identity; the caller can't choose the nonce", async () => {
    const t = setup();
    const a = verify((await t.post(ask())).body.jwt).sub, b = verify((await t.post(ask())).body.jwt).sub;
    assert.notEqual(a, b);
    assert.equal((await t.post(ask({ device_id: "PHONE~watch-0123456789abcdef" }))).statusCode, 400);
});

test("W29 round 5: no pairing requirement — a joined member's own device may watch with no other device of theirs in the call", async () => {
    const t = setup();
    t.s.sfu[ROOM] = [`${BOB}:BPHONE`];
    assert.equal((await t.post(ask())).statusCode, 200);
    assert.equal((await t.post(ask({ room: EMPTY }))).statusCode, 200, "a call nobody is in yet");
});
