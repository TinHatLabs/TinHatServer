// calltoken.mjs padHandler + padViolation — PAD-PHONE Step B (share claude/tinhat-pad/PAD-PHONE/DESIGN.md §8): the Pad
// Mic / Camera token, the device's earlier Pad sessions retired at mint, the generation, the person mute, the account
// limit, and the reserved-identity sweep's per-mode contract (hostile shapes: a source/type mismatch, extra rights,
// forged attributes, a stale generation). Driven through the real handler with a scripted Synapse and call server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createCallToken, padGrant, padViolation, reservedWithRights, PAD_ID_RE, CALLTOKEN } from "../calltoken.mjs";
import { createPadState } from "../padstate.mjs";
import { parseIdentity } from "../identity.mjs";
import { fakeReq, clock } from "./helpers.mjs";

const SN = "home.test", KEY = "lkkey", SECRET = ["test", "only", "0123456789abcdef"].join("-");
const ALICE = `@alice:${SN}`, BOB = `@bob:${SN}`;
const ROOM = `!call:${SN}`;
const NONCE = "0123456789abcdef";

/** a participant as LiveKit's room service lists it (protojson: enum names) */
function part(identity, { perm = {}, tracks = [], attributes = {} } = {}) {
    return { identity, permission: { can_subscribe: true, ...perm }, tracks, attributes };
}
const micPerm = { can_publish: true, can_publish_sources: ["MICROPHONE"] };
const camPerm = { can_publish: true, can_publish_sources: ["CAMERA"] };
const attrs = (mode, gen = "1", person = ALICE) => ({ "tinhat.person": person, "tinhat.pad": "phone", "tinhat.mode": mode, "tinhat.gen": gen });

function setup({ lk = true, padState, rotated } = {}) {
    const s = {
        local: { at: ALICE, ab: BOB },
        rooms: { [ROOM]: [ALICE, BOB] },
        devices: { [ALICE]: ["PHONE", "DESK", "P2", "P3", "P4", "P5", "P6", "P7"], [BOB]: ["BPHONE"] },
        sfu: { [ROOM]: [part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_data: true } }), part(`${BOB}:BPHONE`, { perm: { can_publish: true } })] },
        removeFails: false, removeNoop: false,
        state: {},          // room -> state events (the admin state API)
        onList: null,       // a hook run on every ListParticipants (races)
    };
    const lkCalls = [], logs = [];
    const hs = {
        async get(path, token) {
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
            if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/state$/.exec(path))) { if (s.stateFail) return { ok: false, status: s.stateFail, body: {} }; return { ok: true, status: 200, body: { state: s.state[decodeURIComponent(m[1])] || [] } }; }
            if ((m = /^\/_synapse\/admin\/v2\/users\/([^/]+)\/devices\/([^/]+)$/.exec(path))) {
                const u = decodeURIComponent(m[1]), d = decodeURIComponent(m[2]);
                return (s.devices[u] || []).includes(d) ? { ok: true, status: 200, body: { device_id: d, user_id: u } } : { ok: false, status: 404, body: {} };
            }
            throw new Error(`unexpected ${path}`);
        },
    };
    async function fetchImpl(url, init) {
        if (url.startsWith("http://127.0.0.1:8070")) throw new Error("lk-jwt must never be asked for a Pad token");
        const m = /^http:\/\/127\.0\.0\.1:7880\/twirp\/livekit\.RoomService\/(ListParticipants|ListRooms|RemoveParticipant|MutePublishedTrack|UpdateParticipant)$/.exec(url);
        assert.ok(m, url);
        const auth = init.headers.Authorization.slice(7).split(".");
        assert.equal(createHmac("sha256", SECRET).update(`${auth[0]}.${auth[1]}`).digest("base64url"), auth[2]);
        const body = JSON.parse(init.body);
        lkCalls.push({ method: m[1], body });
        if (m[1] === "ListRooms") return s.listRooms404 ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ rooms: Object.keys(s.sfu).map((name) => ({ name, num_participants: s.sfu[name].length })) }), { status: 200 });
        if (!(body.room in s.sfu)) return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
        if ((m[1] === "MutePublishedTrack" || m[1] === "UpdateParticipant") && s.updateFail) { s.updateFail -= 1; return new Response("{}", { status: 503 }); }
        if (m[1] === "MutePublishedTrack" || m[1] === "UpdateParticipant") {
            const pp = s.sfu[body.room].find((x) => x.identity === body.identity);
            if (pp && body.permission) pp.permission = body.permission;
            if (pp && body.track_sid) for (const tr of pp.tracks || []) if (tr.sid === body.track_sid) tr.muted = body.muted === true;
            return new Response("{}", { status: 200 });
        }
        if (m[1] === "ListParticipants" && s.onList) s.onList();
        if (m[1] === "RemoveParticipant") {
            if (s.removeFails) return new Response(JSON.stringify({ code: "unavailable" }), { status: 503 });
            if (!s.removeNoop) s.sfu[body.room] = s.sfu[body.room].filter((x) => x.identity !== body.identity);
            return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ participants: s.sfu[body.room] }), { status: 200 });
    }
    const wall = 1_800_000_000_000;
    const ct = createCallToken({
        hs, adminToken: "admintoken", serverName: SN, lkJwtUrl: "http://127.0.0.1:8070", fetchImpl, now: clock(1000),
        log: (l) => logs.push(l), enabled: () => false /* the owner's switch off: the Pad route still checks */,
        lkKey: lk ? KEY : "", lkSecret: lk ? SECRET : "", lkApiUrl: "http://127.0.0.1:7880", sfuUrl: "wss://home.test/livekit/sfu",
        wallNow: () => wall, sweep: false, padState: padState || createPadState(), rotated,
    });
    async function post(body, { handler = "pad", method = "POST", ip = "192.0.2.10" } = {}) {
        const res = { statusCode: 200, headers: {}, body: undefined };
        res.status = (c) => { res.statusCode = c; return res; };
        res.set = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
        res.json = (o) => { res.body = o; return res; };
        res.end = () => res;
        await (handler === "pad" ? ct.padHandler() : ct.watchHandler())(fakeReq({ method, headers: { "x-forwarded-for": ip }, body }), res);
        return res;
    }
    return { s, post, lkCalls, logs, wall, ct };
}
const ask = (over = {}) => ({ room: ROOM, openid_token: { access_token: "at", token_type: "Bearer", matrix_server_name: SN, expires_in: 3600 }, device_id: "PHONE", mode: "mic", ...over });
function verify(jwt) {
    const [h, b, sig] = jwt.split(".");
    assert.equal(createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url"), sig, "signed with the LiveKit secret");
    return JSON.parse(Buffer.from(b, "base64url").toString());
}
/** what LiveKit would list for a participant that joined with this token and published `tracks` */
const joined = (p, tracks = []) => part(p.sub, {
    perm: { can_publish: p.video.canPublish, can_publish_data: p.video.canPublishData, can_update_metadata: p.video.canUpdateOwnMetadata,
            can_publish_sources: p.video.canPublishSources.map((x) => x.toUpperCase()) },
    tracks, attributes: p.attributes,
});

test("B01 Mic: a fresh ~pad-mic identity, the microphone only, no data / metadata, every field explicit, the server's attributes", async () => {
    const { post, wall, logs } = setup();
    const r = await post(ask());
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.headers["cache-control"], "no-store");
    const p = verify(r.body.jwt);
    const nowS = Math.floor(wall / 1000);
    assert.match(p.sub, /^@alice:home\.test:PHONE~pad-mic-[0-9a-f]{16}$/);
    assert.deepEqual(p, {
        iss: KEY, sub: p.sub, name: ALICE, nbf: nowS - 10, exp: nowS + 300,
        video: { room: ROOM, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false, canPublishSources: ["microphone"],
                 canUpdateOwnMetadata: false, hidden: false, recorder: false, agent: false },
        attributes: { "tinhat.person": ALICE, "tinhat.pad": "phone", "tinhat.mode": "mic", "tinhat.gen": p.attributes["tinhat.gen"] },
    });
    assert.match(p.attributes["tinhat.gen"], /^[0-9]+$/);
    assert.deepEqual(parseIdentity(p.sub), { mxid: ALICE, device: "PHONE", pad: "mic" });
    assert.ok(!logs.some((l) => l.includes(r.body.jwt.split(".")[2])), "the token is never logged");
});

test("B02 Camera: ~pad-cam, the camera only", async () => {
    const { post } = setup();
    const p = verify((await post(ask({ mode: "camera" }))).body.jwt);
    assert.match(p.sub, /^@alice:home\.test:PHONE~pad-cam-[0-9a-f]{16}$/);
    assert.deepEqual(p.video.canPublishSources, ["camera"]);
    assert.equal(p.video.canPublishData, false);
    assert.equal(p.attributes["tinhat.mode"], "camera");
});

test("B03 padGrant: no admin right of any kind; an unknown mode throws; every nonce fresh", () => {
    const g = padGrant({ key: KEY, user: ALICE, device: "X", room: ROOM, nowS: 100, mode: "mic", gen: "7" });
    for (const k of ["canPublishData", "canUpdateOwnMetadata", "roomAdmin", "roomCreate", "roomList", "roomRecord", "ingressAdmin", "recorder", "agent", "hidden"]) assert.ok(!g.video[k], k);
    assert.ok(PAD_ID_RE.test(g.sub));
    assert.throws(() => padGrant({ key: KEY, user: ALICE, device: "X", room: ROOM, nowS: 100, mode: "watch", gen: "1" }));
    assert.throws(() => padGrant({ key: KEY, user: ALICE, device: "X", room: ROOM, nowS: 100, mode: "screen", gen: "1" }));
    const a = padGrant({ key: KEY, user: ALICE, device: "X", room: ROOM, nowS: 100, mode: "camera", gen: "1" }).sub;
    const b = padGrant({ key: KEY, user: ALICE, device: "X", room: ROOM, nowS: 100, mode: "camera", gen: "1" }).sub;
    assert.notEqual(a, b);
    assert.equal(g.exp - g.nbf, CALLTOKEN.PAD_TTL_S + 10);
});

test("B04 refusals: bad mode / watch mode / missing mode, another's device, not a member, another server, unknown fields, no key", async () => {
    const t = setup();
    for (const mode of ["watch", "screen", "", "MIC", 1, null]) assert.equal((await t.post(ask({ mode }))).statusCode, 400, `mode ${mode}`);
    const noMode = ask(); delete noMode.mode;
    assert.equal((await t.post(noMode)).statusCode, 400);
    assert.equal((await t.post(ask({ device_id: "BPHONE" }))).body.reason, "not-your-device");
    // a device id outside identity.mjs's DEVICE_RE never gets past the request parser (400), whatever the route
    for (const d of ["8448:EVIL", "X~pad", "X#publish", "", "X.1"]) assert.equal((await t.post(ask({ device_id: d }))).statusCode, 400, d);
    assert.equal((await t.post(ask({ openid_token: { access_token: "at", token_type: "Bearer", matrix_server_name: "other.test", expires_in: 3600 } }))).body.reason, "pad-local-only");
    assert.equal((await t.post(ask({ Mode: "mic" }))).statusCode, 400, "an unknown field (Go-style case fold) is refused");
    assert.equal((await t.post(ask({ room_id: ROOM }))).statusCode, 400);
    assert.equal((await t.post(ask({ openid_token: { access_token: "nobody", token_type: "Bearer", matrix_server_name: SN } }))).statusCode, 401);
    t.s.rooms[ROOM] = [BOB];
    assert.equal((await t.post(ask())).body.reason, "not-member");
    assert.equal((await setup({ lk: false }).post(ask())).statusCode, 404, "no call-server key: no Pad route at all");
});

test("B05 switching retires the device's earlier Pad sessions (Watch, Mic, Camera) before the new token exists; others untouched", async () => {
    const t = setup();
    const mic = verify((await t.post(ask())).body.jwt);
    t.s.sfu[ROOM].push(joined(mic, [{ sid: "TR_m", type: "AUDIO", source: "MICROPHONE" }]));
    // (another device's camera, of a generation the server handed out — one with no record would be swept: fail closed)
    t.s.sfu[ROOM].push(part(`${ALICE}:P2~pad-cam-${NONCE}`, { perm: camPerm, attributes: attrs("camera", t.ct.padState.advance(ROOM, ALICE, "P2")) }));
    t.s.sfu[ROOM].push(part(`${ALICE}:PHONE~watch-${NONCE}`, { perm: {}, attributes: { "tinhat.watch": "1" } }));
    t.lkCalls.length = 0;
    const cam = verify((await t.post(ask({ mode: "camera" }))).body.jwt);
    const removed = t.lkCalls.filter((c) => c.method === "RemoveParticipant").map((c) => c.body.identity);
    assert.deepEqual(removed.sort(), [mic.sub, `${ALICE}:PHONE~watch-${NONCE}`].sort(), "PHONE's Mic + Watch, never P2's camera or the computer");
    assert.ok(t.s.sfu[ROOM].some((p) => p.identity === `${ALICE}:DESK`));
    assert.ok(Number(cam.attributes["tinhat.gen"]) > Number(mic.attributes["tinhat.gen"]), "a new generation");
});

test("B06 a retirement that doesn't take -> 502, never a second publishing session (fail closed)", async () => {
    const t = setup();
    const mic = verify((await t.post(ask())).body.jwt);
    t.s.sfu[ROOM].push(joined(mic, [{ sid: "TR_m", type: "AUDIO", source: "MICROPHONE" }]));
    t.s.removeNoop = true;
    const r = await t.post(ask());
    assert.equal(r.statusCode, 502);
    assert.equal(r.body.reason, "check-failed");
    assert.ok(t.logs.some((l) => l.includes("ALERT pad")));
});

test("B07 the Watch route retires the device's Pad Mic session too (Mic -> Watch), and its token stays the 12.1.9 shape", async () => {
    const t = setup();
    const mic = verify((await t.post(ask())).body.jwt);
    t.s.sfu[ROOM].push(joined(mic, [{ sid: "TR_m", type: "AUDIO", source: "MICROPHONE" }]));
    const w = await t.post({ room: ROOM, openid_token: ask().openid_token, device_id: "PHONE" }, { handler: "watch" });
    assert.equal(w.statusCode, 200, JSON.stringify(w.body));
    assert.ok(!t.s.sfu[ROOM].some((p) => p.identity === mic.sub), "the Mic session left before the Watch token existed");
    assert.deepEqual(verify(w.body.jwt).attributes, { "tinhat.watch": "1", "tinhat.person": ALICE, "tinhat.pad": "phone", "tinhat.mode": "watch" }, "no tinhat.gen on Watch tokens");
});

test("B08 a person a moderator muted gets no Mic token and no Camera token (round 3 PAD-2); a computer's restricted permission alone no longer infers a mute (r2 P2 #5)", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    ps.setMuted(ROOM, ALICE, BOB);
    assert.equal((await t.post(ask())).body.reason, "server-muted");
    assert.equal((await t.post(ask({ mode: "camera" }))).body.reason, "server-muted", "a Camera session could carry a voice under another label: refused too");
    ps.clearMuted(ROOM, ALICE);
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200);
    // (an API restart keeps the mute: padstate.mjs persists it — R1-2) a restricted computer with no mute on record
    // (e.g. restricted by an older app's single-device mute that was later lifted elsewhere) doesn't refuse by itself
    const t2 = setup();
    t2.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_sources: ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"] } });
    assert.equal((await t2.post(ask())).statusCode, 200);
});

test("B09 at most 6 live Pad connections per account per call (429 pad-limit); the device's own old one doesn't count", async () => {
    const t = setup();
    for (const d of ["P2", "P3", "P4", "P5", "P6", "P7"]) t.s.sfu[ROOM].push(part(`${ALICE}:${d}~watch-${NONCE}`, { attributes: { "tinhat.watch": "1" } }));
    const r = await t.post(ask());
    assert.equal(r.statusCode, 429);
    assert.equal(r.body.reason, "pad-limit");
    t.s.sfu[ROOM].pop();
    assert.equal((await t.post(ask())).statusCode, 200, "5 others + this one = 6");
});

test("B10 issuance is serialized per device: two concurrent requests -> two generations in order, the first session retired by the second", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.post(ask()), t.post(ask({ mode: "camera" }))]);
    const ga = Number(verify(a.body.jwt).attributes["tinhat.gen"]), gb = Number(verify(b.body.jwt).attributes["tinhat.gen"]);
    assert.ok(ga < gb);
    assert.equal(t.ct.padState.current(ROOM, ALICE, "PHONE"), String(gb));
});

// ---- the sweep's per-mode contract (padViolation / reservedWithRights) ----------------------------------------------

test("B20 a well-formed Mic / Camera session is NOT swept; its own media kind passes", () => {
    const ps = createPadState();
    const gen = ps.advance(ROOM, ALICE, "PHONE");
    const mic = part(`${ALICE}:PHONE~pad-mic-${NONCE}`, { perm: micPerm, attributes: attrs("mic", gen), tracks: [{ type: "AUDIO", source: "MICROPHONE" }] });
    assert.equal(padViolation(mic, ps, ROOM), "");
    assert.equal(reservedWithRights(mic, ps, ROOM), false);
    const micN = part(`${ALICE}:PHONE~pad-mic-${NONCE}`, { perm: { can_publish: true, can_publish_sources: [2] }, attributes: attrs("mic", gen), tracks: [{ source: 2 }] });
    assert.equal(padViolation(micN, ps, ROOM), "", "protojson numbers, a left-out AUDIO type");
    const cam = part(`${ALICE}:PHONE~pad-cam-${NONCE}`, { perm: camPerm, attributes: attrs("camera", gen), tracks: [{ type: "VIDEO", source: "CAMERA" }] });
    assert.equal(padViolation(cam, ps, ROOM), "");
    const mutedMic = part(`${ALICE}:PHONE~pad-mic-${NONCE}`, { perm: { can_publish: false, can_publish_sources: [] }, attributes: attrs("mic", gen) });
    assert.equal(padViolation(mutedMic, ps, ROOM), "", "a moderator took publishing away: within the contract");
});

test("B21 hostile shapes are swept: source/type mismatch, extra sources, data, metadata, hidden, forged or missing attributes", () => {
    const P = (id, o) => part(id, o);
    const id = `${ALICE}:PHONE~pad-mic-${NONCE}`, cid = `${ALICE}:PHONE~pad-cam-${NONCE}`;
    const cases = [
        ["audio labelled camera on a Camera session", P(cid, { perm: camPerm, attributes: attrs("camera"), tracks: [{ type: "AUDIO", source: "CAMERA" }] }), "track"],
        ["video labelled microphone on a Mic session", P(id, { perm: micPerm, attributes: attrs("mic"), tracks: [{ type: "VIDEO", source: "MICROPHONE" }] }), "track"],
        ["a screen share on a Mic session", P(id, { perm: micPerm, attributes: attrs("mic"), tracks: [{ type: "VIDEO", source: "SCREEN_SHARE" }] }), "track"],
        ["an UNKNOWN-source audio track (soundboard)", P(id, { perm: micPerm, attributes: attrs("mic"), tracks: [{ type: "AUDIO" }] }), "track"],
        ["a data track", P(id, { perm: micPerm, attributes: attrs("mic"), tracks: [{ type: "DATA", source: "MICROPHONE" }] }), "track"],
        ["every source (empty list while publishing)", P(id, { perm: { can_publish: true, can_publish_sources: [] }, attributes: attrs("mic") }), "rights"],
        ["mic + camera sources", P(id, { perm: { can_publish: true, can_publish_sources: ["MICROPHONE", "CAMERA"] }, attributes: attrs("mic") }), "rights"],
        ["data right", P(id, { perm: { ...micPerm, can_publish_data: true }, attributes: attrs("mic") }), "rights"],
        ["metadata right", P(id, { perm: { ...micPerm, can_update_metadata: true }, attributes: attrs("mic") }), "rights"],
        ["hidden", P(id, { perm: { ...micPerm, hidden: true }, attributes: attrs("mic") }), "rights"],
        ["recorder", P(id, { perm: { ...micPerm, recorder: true }, attributes: attrs("mic") }), "rights"],
        ["no permission reported", { identity: id, attributes: attrs("mic") }, "rights"],
        ["mode attribute says camera on a ~pad-mic identity", P(id, { perm: micPerm, attributes: attrs("camera") }), "attributes"],
        ["another person's tinhat.person", P(id, { perm: micPerm, attributes: attrs("mic", "1", BOB) }), "attributes"],
        ["no tinhat.pad", P(id, { perm: micPerm, attributes: { "tinhat.person": ALICE, "tinhat.mode": "mic", "tinhat.gen": "1" } }), "attributes"],
        ["no tinhat.gen", P(id, { perm: micPerm, attributes: { "tinhat.person": ALICE, "tinhat.pad": "phone", "tinhat.mode": "mic" } }), "attributes"],
        ["no attributes at all", { identity: id, permission: micPerm }, "attributes"],
        ["upper-case nonce", P(`${ALICE}:PHONE~pad-mic-0123456789ABCDEF`, { perm: micPerm, attributes: attrs("mic") }), null],
        ["publish=X form of a Pad identity", P(`${id}#X`, { perm: micPerm, attributes: attrs("mic") }), null],
        ["8448:EVIL device shape", P(`${ALICE}:8448:EVIL~pad-mic-${NONCE}`, { perm: micPerm, attributes: attrs("mic", "1", `${ALICE}:8448`) }), ""],
    ];
    for (const [what, p, why] of cases) {
        if (why === null) assert.equal(reservedWithRights(p), true, what);
        else if (why === "") assert.equal(padViolation(p), "", `${what} (a real mxid with a port: its own person, fine)`);
        else {
            assert.equal(padViolation(p), why, what);
            assert.equal(reservedWithRights(p), true, what);
        }
    }
});

test("B22 a stale generation is swept (a refreshed token of a session a switch replaced); a generation with no record too (fail closed)", () => {
    const ps = createPadState();
    const g1 = ps.advance(ROOM, ALICE, "PHONE");
    const old = part(`${ALICE}:PHONE~pad-mic-${NONCE}`, { perm: micPerm, attributes: attrs("mic", g1) });
    assert.equal(padViolation(old, ps, ROOM), "");
    ps.advance(ROOM, ALICE, "PHONE"); // a later token for the device (a switch, or Talk here's normal token)
    assert.equal(padViolation(old, ps, ROOM), "generation");
    assert.equal(padViolation(old, createPadState(), ROOM), "generation", "no record of the device: removed (review r1 P1 #5: never fail open)");
});

test("B23 a muted person's Mic session that may still publish is swept; one whose publishing was taken away is not", () => {
    const ps = createPadState();
    const g = ps.advance(ROOM, ALICE, "PHONE");
    ps.setMuted(ROOM, ALICE, BOB);
    const live = part(`${ALICE}:PHONE~pad-mic-${NONCE}`, { perm: micPerm, attributes: attrs("mic", g) });
    assert.equal(padViolation(live, ps, ROOM), "person-muted");
    const off = part(`${ALICE}:PHONE~pad-mic-${NONCE}`, { perm: { can_publish: false, can_publish_sources: [] }, attributes: attrs("mic", g) });
    assert.equal(padViolation(off, ps, ROOM), "");
    const cam = part(`${ALICE}:PHONE~pad-cam-${NONCE}`, { perm: camPerm, attributes: attrs("camera", g) });
    assert.equal(padViolation(cam, ps, ROOM), "", "a call mute leaves the camera");
});

test("B24 the sweep removes violating Pad sessions and keeps good ones (through the real sweep)", async () => {
    const t = setup();
    const good = verify((await t.post(ask())).body.jwt);
    t.s.sfu[ROOM].push(joined(good, [{ sid: "TR_1", type: "AUDIO", source: "MICROPHONE" }]));
    const evil = part(`${ALICE}:P2~pad-cam-${NONCE}`, { perm: camPerm, attributes: attrs("camera"), tracks: [{ sid: "TR_2", type: "AUDIO", source: "CAMERA" }] });
    t.s.sfu[ROOM].push(evil);
    const n = await t.ct.sweep();
    assert.equal(n, 1);
    assert.ok(t.s.sfu[ROOM].some((p) => p.identity === good.sub), "the good Mic session stays");
    assert.ok(!t.s.sfu[ROOM].some((p) => p.identity === evil.identity), "audio on a Camera session is removed");
    // a later token for that device (Talk here: a normal token) makes the Mic session stale -> swept
    t.ct.padState.advance(ROOM, ALICE, "PHONE");
    assert.equal(await t.ct.sweep(), 1);
    assert.ok(!t.s.sfu[ROOM].some((p) => p.identity === good.sub));
});

test("B25 parseIdentity reads Pad identities exactly (one suffix, lower-case hex)", () => {
    assert.deepEqual(parseIdentity(`${ALICE}:PHONE~pad-cam-${NONCE}`), { mxid: ALICE, device: "PHONE", pad: "cam" });
    for (const bad of [`${ALICE}:PHONE~pad-mic-${NONCE}~watch-${NONCE}`, `${ALICE}:PHONE~watch-${NONCE}~pad-mic-${NONCE}`, `${ALICE}:PHONE~pad-scr-${NONCE}`,
        `${ALICE}:PHONE~pad-mic-${NONCE}0`, `${ALICE}:~pad-mic-${NONCE}`, `${ALICE}:PHONE~pad-mic-${NONCE}\n`]) assert.equal(parseIdentity(bad), null, bad);
});

// ---- Step B code review r1 (astra -e high): one regression test per finding ------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("R1-2 / R1-5 the person mute and the generations survive a restart; a generation is never handed out twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "padstate-"));
    try {
        const file = join(dir, "pad", "state.json");
        const a = createPadState({ file });
        a.setMuted(ROOM, ALICE, BOB);
        const g1 = a.advance(ROOM, ALICE, "PHONE");
        const b = createPadState({ file }); // the API restarted
        assert.equal(b.isMuted(ROOM, ALICE), true, "the mute holds after a restart");
        assert.equal(b.current(ROOM, ALICE, "PHONE"), g1, "the device's generation is known after a restart");
        const g2 = b.advance(ROOM, ALICE, "PHONE");
        assert.ok(Number(g2) > Number(g1), "a new generation is always newer, also after a restart");
        // a replayed Mic credential of generation g1 after the switch to g2 stays stale
        const old = part(`${ALICE}:PHONE~pad-mic-${NONCE}`, { perm: micPerm, attributes: attrs("mic", g1) });
        assert.equal(padViolation(old, b, ROOM), "generation");
        b.clearMuted(ROOM, ALICE);
        assert.equal(createPadState({ file }).isMuted(ROOM, ALICE), false, "only an unmute clears it");
        // negative control: an in-memory state (0.3.14 r1) forgets both
        assert.equal(createPadState().isMuted(ROOM, ALICE), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R1-3 a mute set while a Mic request waits on the call server refuses it (the last check before signing)", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    let n = 0;
    t.s.onList = () => { if (++n === 2) ps.setMuted(ROOM, ALICE, BOB); }; // during the request's own call-server reads
    const r = await t.post(ask());
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.reason, "server-muted");
});

test("R1-2b the apps' own mute record in the room (a moderator's dev.tinhat.call.moderation) refuses a Mic token; a member's own record doesn't", async () => {
    const t = setup();
    const ev = (sender, content) => ({ type: "dev.tinhat.call.moderation", state_key: ALICE.slice(1), sender, content });
    const pl = { type: "m.room.power_levels", state_key: "", sender: BOB, content: { users: { [BOB]: 100 }, users_default: 0 } };
    t.s.state[ROOM] = [pl, ev(BOB, { muted: true, by: BOB })];
    assert.equal((await t.post(ask())).body.reason, "server-muted");
    t.s.state[ROOM] = [pl, ev(ALICE, { muted: true })]; // someone without the power to write it
    assert.equal((await t.post(ask())).statusCode, 200);
    t.s.state[ROOM] = [pl, ev(BOB, {})]; // unmuted
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200);
});

test("R1-4 a person mute covers arrivals: the sweep re-applies it to a normal connection that can publish a mic", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    ps.setMuted(ROOM, ALICE, BOB);
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_data: true, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
    await t.ct.sweep();
    const muted = t.lkCalls.filter((c) => c.method === "MutePublishedTrack").map((c) => c.body.identity);
    assert.deepEqual(muted, [`${ALICE}:DESK`], "its (type-omitted = AUDIO) mic track muted");
    assert.deepEqual(t.s.sfu[ROOM][0].permission.can_publish_sources, ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]);
    assert.ok(!t.lkCalls.some((c) => c.method !== "ListRooms" && c.method !== "ListParticipants" && c.body.identity === `${BOB}:BPHONE`), "nobody else touched");
    t.lkCalls.length = 0;
    await t.ct.sweep();
    assert.ok(!t.lkCalls.some((c) => c.method === "UpdateParticipant"), "already muted: nothing more");
});

test("R1-4b a normal token while the person is muted is re-minted without the microphone (and only then)", async () => {
    const { remint, signLk } = await import("../calltoken.mjs");
    const lk = JSON.stringify({ url: "wss://x", jwt: signLk({ iss: KEY, sub: `${ALICE}:DESK`, video: { room: ROOM, roomJoin: true, canPublish: true, canSubscribe: true } }, SECRET) });
    const v = (t) => JSON.parse(Buffer.from(JSON.parse(t).jwt.split(".")[1], "base64url")).video;
    assert.deepEqual(v(remint(lk, SECRET, ALICE, "muted")).canPublishSources, ["camera", "screen_share", "screen_share_audio"]);
    assert.equal(v(remint(lk, SECRET, ALICE)).canPublishSources, undefined, "not muted: lk-jwt's grant untouched");
});

test("R1-6 the account limit counts tokens handed out but not used yet, and the Watch route counts too", async () => {
    const t = setup();
    for (const d of ["P2", "P3", "P4", "P5", "P6", "P7"]) assert.equal((await t.post(ask({ device_id: d, mode: "camera" }))).statusCode, 200, d);
    const r = await t.post(ask({ device_id: "PHONE" }));
    assert.equal(r.statusCode, 429, "the 7th device: refused although none of the six has joined");
    const w = await t.post({ room: ROOM, openid_token: ask().openid_token, device_id: "PHONE" }, { handler: "watch" });
    assert.equal(w.body.reason, "pad-limit", "Watch counts too");
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200, "a device already holding a slot may switch");
});

test("R1-8 a mute decodes LiveKit's track types (AUDIO = 0 / omitted; VIDEO never)", async () => {
    const { isAudioTrack } = await import("../callmute.mjs");
    assert.deepEqual([{ type: "AUDIO" }, { type: 0 }, { type: "0" }, {}, { type: "VIDEO" }, { type: 1 }, { type: "1" }, { type: "DATA" }].map(isAudioTrack), [true, true, true, true, false, false, false, false]);
});

// ---- Step B code review r2 (astra -e high) ------------------------------------------------------------------------------

import { writeFileSync, chmodSync, mkdirSync } from "node:fs";

test("R2-1 a change that can't be written doesn't count: the mint fails and the generation stays; a corrupt file = Pad refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "padstate-"));
    try {
        const file = join(dir, "pad", "state.json");
        const ps = createPadState({ file });
        const t = setup({ padState: ps });
        const g1 = verify((await t.post(ask())).body.jwt).attributes["tinhat.gen"];
        chmodSync(join(dir, "pad"), 0o500); // unwritable from now on
        const r = await t.post(ask({ mode: "camera" }));
        chmodSync(join(dir, "pad"), 0o700);
        if (process.getuid?.() !== 0) {
            assert.equal(r.statusCode, 502, "the token isn't handed out when its generation couldn't be committed");
            assert.equal(ps.current(ROOM, ALICE, "PHONE"), g1, "and the old generation stays current");
        }
        assert.throws(() => { chmodSync(join(dir, "pad"), 0o500); try { if (process.getuid?.() !== 0) ps.setMuted(ROOM, ALICE, BOB); else throw new Error("root"); } finally { chmodSync(join(dir, "pad"), 0o700); } });
        writeFileSync(file, "{ not json");
        const broken = createPadState({ file });
        assert.equal(broken.ok(), false);
        const tb = setup({ padState: broken });
        assert.equal((await tb.post(ask())).statusCode, 503, "Pad Mic refused while the state can't be read");
        assert.equal((await tb.post({ room: ROOM, openid_token: ask().openid_token, device_id: "PHONE" }, { handler: "watch" })).statusCode, 503, "Watch too");
        writeFileSync(file, JSON.stringify({ v: 2, last: 1, gens: { x: { gen: "zz", at: 1 } } }));
        assert.equal(createPadState({ file }).ok(), false, "an entry that doesn't validate = corrupt");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R2-2 the sweep's state-dependent steps run under the person's lock: a moderation step in progress is never undone by it", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    ps.setMuted(ROOM, ALICE, BOB);
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
    // a moderation step (an unmute) holds ALICE's lock while the sweep runs: the sweep waits, then re-reads (unmuted)
    let release;
    const held = ps.serial(ROOM, ALICE, () => new Promise((r) => { release = r; }));
    const sw = t.ct.sweep();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!t.lkCalls.some((c) => c.method === "UpdateParticipant"), "nothing written while the person's lock is held");
    ps.clearMuted(ROOM, ALICE);
    release();
    await held; await sw;
    assert.ok(!t.lkCalls.some((c) => c.method === "UpdateParticipant" || c.method === "MutePublishedTrack"), "after the unmute the sweep re-read the state and muted nothing");
});

test("R2-3 a v12 additional creator's mute record counts (unlimited power, never in power_levels)", async () => {
    const t = setup();
    const CAROL = `@carol:${SN}`;
    t.s.state[ROOM] = [
        { type: "m.room.create", state_key: "", sender: BOB, content: { room_version: "12", additional_creators: [CAROL] } },
        { type: "m.room.power_levels", state_key: "", sender: BOB, content: { users: {}, users_default: 0 } },
        { type: "dev.tinhat.call.moderation", state_key: ALICE.slice(1), sender: CAROL, content: { muted: true }, origin_server_ts: 1 },
    ];
    assert.equal((await t.post(ask())).body.reason, "server-muted");
});

test("R2-5 an explicit unmute through the API supersedes an older mute record in the room", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    t.s.state[ROOM] = [
        { type: "m.room.power_levels", state_key: "", sender: BOB, content: { users: { [BOB]: 100 }, users_default: 0 } },
        { type: "dev.tinhat.call.moderation", state_key: ALICE.slice(1), sender: BOB, content: { muted: true }, origin_server_ts: Date.now() - 60_000 },
    ];
    assert.equal((await t.post(ask())).body.reason, "server-muted");
    ps.setMuted(ROOM, ALICE, BOB);
    ps.clearMuted(ROOM, ALICE);
    assert.equal((await t.post(ask())).statusCode, 200);
});

test("R2-4 one current session per device: a replaced Watch identity of the device is swept (seven Watch tokens of one device can't all stay)", async () => {
    const t = setup();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(verify((await t.post({ room: ROOM, openid_token: ask().openid_token, device_id: "PHONE" }, { handler: "watch" })).body.jwt).sub);
    for (const id of ids) t.s.sfu[ROOM].push(part(id, { perm: {}, attributes: { "tinhat.watch": "1" } }));
    await t.ct.sweep();
    const left = t.s.sfu[ROOM].filter((p) => p.identity.includes("~watch-")).map((p) => p.identity);
    assert.deepEqual(left, [ids[2]], "only the device's latest Watch identity stays");
    // a Watch session from before 0.3.14 (no record) is left alone (it can't publish)
    t.s.sfu[ROOM].push(part(`${ALICE}:OLDPHONE~watch-${NONCE}`, { perm: {}, attributes: { "tinhat.watch": "1" } }));
    await t.ct.sweep();
    assert.ok(t.s.sfu[ROOM].some((p) => p.identity === `${ALICE}:OLDPHONE~watch-${NONCE}`));
});

test("R2-6 the sweep keeps a live session's records alive (no expiry under a connected Pad session); normal tokens of non-Pad devices don't fill the state", async () => {
    let t0 = 1_800_000_000_000;
    const ps = createPadState({ now: () => t0 });
    const t = setup({ padState: ps });
    const mic = verify((await t.post(ask())).body.jwt);
    t.s.sfu[ROOM].push(joined(mic));
    t0 += 2 * 3600_000;
    await t.ct.sweep();
    assert.equal(ps._gens.get(`${ROOM}\n${ALICE}\nPHONE`).at, t0, "touched by the sweep");
    assert.equal(ps.advanceIfKnown(ROOM, ALICE, "DESK"), null, "a device that never used Pad: no record");
    assert.ok(ps.advanceIfKnown(ROOM, ALICE, "PHONE"), "a Pad device: advanced (Talk here)");
});

test("R2-7 sweeps never overlap (a second call while one runs joins it)", async () => {
    const t = setup();
    const a = t.ct.sweep(), b = t.ct.sweep();
    assert.equal(a, b);
    await a;
});

test("R2 the muted re-mint never widens lk-jwt's own source list (intersection)", async () => {
    const { remint, signLk } = await import("../calltoken.mjs");
    const mk = (srcs) => JSON.stringify({ url: "wss://x", jwt: signLk({ iss: KEY, sub: `${ALICE}:DESK`, video: { room: ROOM, roomJoin: true, canPublish: true, canPublishSources: srcs } }, SECRET) });
    const v = (t) => JSON.parse(Buffer.from(JSON.parse(t).jwt.split(".")[1], "base64url")).video;
    assert.deepEqual(v(remint(mk(["camera", "microphone"]), SECRET, ALICE, "muted")).canPublishSources, ["camera"]);
    const none = v(remint(mk(["microphone"]), SECRET, ALICE, "muted"));
    assert.equal(none.canPublish, false, "nothing left: no publishing at all");
});

// ---- Step B code review r3 ----------------------------------------------------------------------------------------------

test("R3-1 the sweep applies a mute recorded only in the room (an upgrade from 0.3.13: no Pad state record)", async () => {
    const t = setup();
    t.s.state[ROOM] = [
        { type: "m.room.power_levels", state_key: "", sender: BOB, content: { users: { [BOB]: 100 }, users_default: 0 } },
        { type: "dev.tinhat.call.moderation", state_key: ALICE.slice(1), sender: BOB, content: { muted: true }, origin_server_ts: 1 },
    ];
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
    await t.ct.sweep();
    assert.ok(t.lkCalls.some((c) => c.method === "MutePublishedTrack" && c.body.identity === `${ALICE}:DESK`));
});

test("R3-2 a v2 state file with a map of the wrong shape (muted: []) is broken, not empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "padstate-"));
    try {
        const file = join(dir, "state.json");
        for (const bad of [{ muted: [] }, { gens: null }, { issued: 5 }, { watch: undefined }]) {
            writeFileSync(file, JSON.stringify({ v: 2, last: 1, gens: {}, watch: {}, muted: {}, unmuted: {}, issued: {}, ...bad }));
            assert.equal(createPadState({ file }).ok(), false, JSON.stringify(bad));
        }
        writeFileSync(file, JSON.stringify({ v: 2, last: 1, gens: {}, watch: {}, muted: { "no-newline": { by: "", at: 1 } }, unmuted: {}, issued: {} }));
        assert.equal(createPadState({ file }).ok(), false, "a key of the wrong form");
        writeFileSync(file, JSON.stringify({ v: 2, last: 1, gens: {}, watch: {}, muted: {}, unmuted: {}, issued: {} }));
        assert.equal(createPadState({ file }).ok(), true, "control: a well-formed empty state loads");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R3-4 any later token for the device retires its Watch identity (Watch A, then Mic B: A is swept)", async () => {
    const t = setup();
    const wA = verify((await t.post({ room: ROOM, openid_token: ask().openid_token, device_id: "PHONE" }, { handler: "watch" })).body.jwt);
    const mB = verify((await t.post(ask())).body.jwt);
    t.s.sfu[ROOM].push(part(wA.sub, { perm: {}, attributes: wA.attributes }), joined(mB));
    await t.ct.sweep();
    assert.ok(!t.s.sfu[ROOM].some((p) => p.identity === wA.sub), "the earlier Watch identity is gone");
    assert.ok(t.s.sfu[ROOM].some((p) => p.identity === mB.sub), "the current Mic session stays");
});

test("R3-7 a full sweep asked while a room-only sweep runs covers every room before it settles", async () => {
    const t = setup();
    const ROOM2 = `!other:${SN}`;
    t.s.sfu[ROOM2] = [part(`${BOB}:X~pad-cam-${NONCE}`, { perm: camPerm, attributes: attrs("camera", "1", BOB), tracks: [{ type: "AUDIO", source: "CAMERA" }] })];
    const a = t.ct.sweep(new Set([ROOM]));
    const b = t.ct.sweep();
    await a; await b;
    assert.equal(t.s.sfu[ROOM2].length, 0, "the violator in the other room was removed by the merged full sweep");
});

test("R3-8 records are reclaimed only after a complete sweep, and never a live session's", async () => {
    let t0 = 1_800_000_000_000;
    const ps = createPadState({ now: () => t0 });
    const t = setup({ padState: ps });
    const mic = verify((await t.post(ask())).body.jwt);
    ps.advance(ROOM, ALICE, "GONE");
    t.s.sfu[ROOM].push(joined(mic));
    t0 += 8 * 24 * 3600_000; // the API was away 8 days
    ps.advance(ROOM, BOB, "BPHONE"); // unrelated issuance first: nothing of a live session goes
    assert.ok(ps.current(ROOM, ALICE, "PHONE"));
    await t.ct.sweep();
    assert.ok(t.s.sfu[ROOM].some((p) => p.identity === mic.sub), "the live session stays");
    assert.equal(ps.current(ROOM, ALICE, "GONE"), null, "a device with no session anywhere is reclaimed");
});

test("R3-9 a touch that can't be committed leaves the record as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "padstate-"));
    try {
        let t0 = 1_800_000_000_000;
        const file = join(dir, "pad", "state.json");
        const ps = createPadState({ file, now: () => t0 });
        ps.advance(ROOM, ALICE, "PHONE");
        const at = ps._gens.get(`${ROOM}\n${ALICE}\nPHONE`).at;
        t0 += 2 * 3600_000;
        chmodSync(join(dir, "pad"), 0o500);
        try { ps.touch(ROOM, ALICE, "PHONE"); } finally { chmodSync(join(dir, "pad"), 0o700); }
        if (process.getuid?.() !== 0) assert.equal(ps._gens.get(`${ROOM}\n${ALICE}\nPHONE`).at, at);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Step B code review r4 ----------------------------------------------------------------------------------------------

const roomMute = (ts = 1) => [
    { type: "m.room.power_levels", state_key: "", sender: BOB, content: { users: { [BOB]: 100 }, users_default: 0 } },
    { type: "dev.tinhat.call.moderation", state_key: ALICE.slice(1), sender: BOB, content: { muted: true }, origin_server_ts: ts },
];

test("R4-1 a room-only mute removes a publishing Pad Mic session at the sweep (the effective mute reaches the Pad check)", async () => {
    const t = setup();
    const mic = verify((await t.post(ask())).body.jwt);
    t.s.sfu[ROOM].push(joined(mic, [{ sid: "TR_m", type: "AUDIO", source: "MICROPHONE" }]));
    t.s.state[ROOM] = roomMute();
    await t.ct.sweep();
    assert.ok(!t.s.sfu[ROOM].some((p) => p.identity === mic.sub));
});

test("R4-3 an unusable Pad state = mutes unknown: everyone counts as muted (no Pad Mic; the sweep enforces)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "padstate-"));
    try {
        const file = join(dir, "state.json");
        writeFileSync(file, "garbage");
        const t = setup({ padState: createPadState({ file }) });
        t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
        await t.ct.sweep();
        assert.ok(t.lkCalls.some((c) => c.method === "MutePublishedTrack" && c.body.identity === `${ALICE}:DESK`), "muted (fail closed)");
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R4-4 the mute is read under the person's lock: an unmute that completes while the sweep waits is not undone", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    t.s.state[ROOM] = roomMute(Date.now() - 60_000);
    ps.setMuted(ROOM, ALICE, BOB);
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
    let release;
    const held = ps.serial(ROOM, ALICE, () => new Promise((r) => { release = r; }));
    const sw = t.ct.sweep();
    await new Promise((r) => setTimeout(r, 50));
    ps.clearMuted(ROOM, ALICE); // the unmute (newer than the room record)
    release();
    await held; await sw;
    assert.ok(!t.lkCalls.some((c) => c.method === "MutePublishedTrack"), "nothing re-muted after the unmute");
});

test("R4-6 a room list that answers 404 is not 'no calls': nothing is reclaimed", async () => {
    let t0 = 1_800_000_000_000;
    const ps = createPadState({ now: () => t0 });
    const t = setup({ padState: ps });
    ps.advance(ROOM, ALICE, "PHONE");
    t0 += 8 * 24 * 3600_000;
    t.s.listRooms404 = true;
    await t.ct.sweep();
    assert.ok(ps.current(ROOM, ALICE, "PHONE"), "kept");
});

// ---- Step B code review r5 ----------------------------------------------------------------------------------------------

test("R5-1 a room-state 404 is unknown, never 'nobody muted': no Pad Mic token", async () => {
    const t = setup();
    t.s.stateFail = 404;
    assert.notEqual((await t.post(ask())).statusCode, 200);
});

test("R5-2 a restriction the sweep applied while the mute was unknown is lifted once a read shows no mute", async () => {
    const t = setup();
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
    t.s.stateFail = 503;
    await t.ct.sweep();
    assert.deepEqual(t.s.sfu[ROOM][0].permission.can_publish_sources, ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"], "unknown: enforced");
    t.s.stateFail = 0;
    await t.ct.sweep();
    assert.deepEqual(t.s.sfu[ROOM][0].permission.can_publish_sources, [], "known again, not muted: lifted");
});


// ---- Step B code review r9: the stateless restriction model ------------------------------------------------------------

test("R9-1 the sweep's mute writes the mute sources (other bits kept); a fresh no-mute read lifts it to the token's own grant", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    ps.setMuted(ROOM, ALICE, BOB);
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_data: false, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
    await t.ct.sweep();
    assert.deepEqual(t.s.sfu[ROOM][0].permission.can_publish_sources, ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]);
    ps.clearMuted(ROOM, ALICE);
    t.s.updateFail = 1;
    await t.ct.sweep(); // the lift fails once
    await t.ct.sweep(); // and is simply done again (no state to lose)
    assert.deepEqual(t.s.sfu[ROOM][0].permission.can_publish_sources, []);
    assert.equal(t.s.sfu[ROOM][0].permission.can_publish_data, false, "never more than the token's own grant");
});

test("R9-2 a connection of a person still muted (state or the room's record) keeps the restriction; unknown keeps it too", async () => {
    const t = setup();
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_sources: ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"] } });
    t.s.state[ROOM] = roomMute();
    await t.ct.sweep();
    t.s.state[ROOM] = [];
    t.s.stateFail = 503;
    await t.ct.sweep();
    assert.ok(!t.lkCalls.some((c) => c.method === "UpdateParticipant" && c.body.identity === `${ALICE}:DESK`), "muted, then unknown: nothing lifted");
    // (unknown = enforced muted for EVERYONE in that call: the friend's mic is restricted too while the room can't be read)
    assert.deepEqual(t.s.sfu[ROOM][1].permission.can_publish_sources, ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]);
    t.s.stateFail = 0;
    await t.ct.sweep();
    assert.deepEqual(t.s.sfu[ROOM][0].permission.can_publish_sources, [], "known and not muted: lifted");
    assert.deepEqual(t.s.sfu[ROOM][1].permission.can_publish_sources, [], "and the friend's too");
});

test("R9-3 a connection that may not publish at all (another server's user) never gains publishing from a lift", async () => {
    const t = setup();
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: false, can_publish_sources: ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"] } });
    await t.ct.sweep();
    assert.equal(t.s.sfu[ROOM][0].permission.can_publish, false);
});

// ---- round 3 security review, PAD-1: a mute record counts only when its sender could mute that person ------------------
// (the room's dev.tinhat.call.moderation records can be written as raw state from any Matrix client: the sender is held
// to /moderation/call's own rule — moderate_calls and a HIGHER rank, never above the room's power levels)

const CAROL = `@carol:${SN}`;
const plOf = (users, extra = {}) => ({ type: "m.room.power_levels", state_key: "", sender: BOB, content: { users, users_default: 0, ...extra } });
const muteRec = (sender, who = ALICE, ts = 1) => ({ type: "dev.tinhat.call.moderation", state_key: who.slice(1), sender, content: { muted: true }, origin_server_ts: ts });

test("PAD1-1 a PL-50 moderator's record doesn't mute the room's owner (PL 100) or an equal; it does mute a member below", async () => {
    const t = setup();
    t.s.state[ROOM] = [plOf({ [ALICE]: 100, [CAROL]: 50 }), muteRec(CAROL)];
    assert.equal((await t.post(ask())).statusCode, 200, "the owner keeps the mic");
    t.s.state[ROOM] = [plOf({ [ALICE]: 50, [CAROL]: 50 }), muteRec(CAROL)];
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200, "an equal rank: not muted");
    t.s.state[ROOM] = [plOf({ [ALICE]: 0, [CAROL]: 50 }), muteRec(CAROL)];
    assert.equal((await t.post(ask({ device_id: "P3" }))).body.reason, "server-muted", "a member below: muted");
});

test("PAD1-2 a v12 creator is never muted by a non-creator's record (even at PL 100); one's own record mutes nobody", async () => {
    const t = setup();
    const create = { type: "m.room.create", state_key: "", sender: ALICE, content: { room_version: "12" } };
    t.s.state[ROOM] = [create, plOf({ [CAROL]: 100 }), muteRec(CAROL)];
    assert.equal((await t.post(ask())).statusCode, 200, "the creator keeps the mic");
    t.s.state[ROOM] = [plOf({ [ALICE]: 100 }), muteRec(ALICE)];
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200, "a record about oneself isn't a moderator's mute");
});

test("PAD1-3 the event level lowered to 0 (as the apps may): any member can WRITE a record, but one about an equal counts for nothing", async () => {
    const t = setup();
    const low = { events: { "dev.tinhat.call.moderation": 0 }, state_default: 0 };
    t.s.state[ROOM] = [plOf({}, low), muteRec(CAROL)];
    assert.equal((await t.post(ask())).statusCode, 200, "PL 0 about PL 0: not muted");
    t.s.state[ROOM] = [plOf({ [CAROL]: 10 }, low), muteRec(CAROL)];
    assert.equal((await t.post(ask({ device_id: "P2" }))).body.reason, "server-muted", "ranked above, at or over the call-moderation level (0 here): counts");
});

test("PAD1-4 a space with roles governs: a record by someone without moderate_calls (or not ranked above) doesn't count", async () => {
    const t = setup();
    const SPACE = `!space:${SN}`;
    const parent = { type: "m.space.parent", state_key: SPACE, sender: BOB, content: { via: [SN] } };
    const role = (id, rank, permissions) => ({ type: "dev.tinhat.role", state_key: id, sender: BOB, content: { name: id, rank, permissions } });
    const has = (who, roles) => ({ type: "dev.tinhat.member_roles", state_key: who.slice(1), sender: BOB, content: { roles } });
    const spaceState = (carolPerms, carolRank, aliceRank) => [
        plOf({ [BOB]: 100 }),
        { type: "m.room.member", state_key: BOB, sender: BOB, content: { membership: "join" } },
        { type: "m.space.child", state_key: ROOM, sender: BOB, content: { via: [SN] } },
        role("everyone", 0, []), role("mod", carolRank, carolPerms), role("vip", aliceRank, []),
        has(CAROL, ["mod"]), has(ALICE, ["vip"]),
    ];
    t.s.state[ROOM] = [plOf({ [BOB]: 100, [CAROL]: 50 }), parent, muteRec(CAROL)];
    t.s.state[SPACE] = spaceState([], 60, 10);
    assert.equal((await t.post(ask())).statusCode, 200, "no moderate_calls in the space: the record doesn't count");
    t.s.state[SPACE] = spaceState(["moderate_calls"], 60, 70);
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200, "ranked below the target: doesn't count");
    t.s.state[SPACE] = spaceState(["moderate_calls"], 60, 10);
    assert.equal((await t.post(ask({ device_id: "P3" }))).body.reason, "server-muted", "allowed by the space's roles: counts");
});

test("PAD1-5 the sweep doesn't apply a lower moderator's record to the owner's computer", async () => {
    const t = setup();
    t.s.state[ROOM] = [plOf({ [ALICE]: 100, [CAROL]: 50 }), muteRec(CAROL)];
    t.s.sfu[ROOM][0] = part(`${ALICE}:DESK`, { perm: { can_publish: true, can_publish_data: true, can_publish_sources: [] }, tracks: [{ sid: "TR_d", source: "MICROPHONE" }] });
    await t.ct.sweep();
    assert.ok(!t.lkCalls.some((c) => (c.method === "MutePublishedTrack" || c.method === "UpdateParticipant") && c.body.identity === `${ALICE}:DESK`), "the owner's mic untouched");
    t.s.state[ROOM] = [plOf({ [ALICE]: 0, [CAROL]: 50 }), muteRec(CAROL)];
    await t.ct.sweep();
    assert.ok(t.lkCalls.some((c) => c.method === "MutePublishedTrack" && c.body.identity === `${ALICE}:DESK`), "a member below is muted by it");
});

test("PAD1-6 too many parent links: the room's power levels decide (the owner's mute still counts, a lower moderator's about the owner doesn't)", async () => {
    const t = setup();
    const links = Array.from({ length: 33 }, (_, i) => ({ type: "m.space.parent", state_key: `!s${i}:${SN}`, sender: CAROL, content: {} }));
    t.s.state[ROOM] = [plOf({ [BOB]: 100, [CAROL]: 50 }), ...links, muteRec(BOB)];
    assert.equal((await t.post(ask())).body.reason, "server-muted", "the owner's record isn't dropped by a flood of links");
    t.s.state[ROOM] = [plOf({ [ALICE]: 100, [CAROL]: 50 }), ...links, muteRec(CAROL)];
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200);
    assert.ok(t.logs.some((l) => /too many spaces/.test(l)));
});

test("PAD1-7 a moderator kicked or banned since holds nobody muted; one who left on their own still does", async () => {
    const t = setup();
    const member = (who, membership, by = who) => ({ type: "m.room.member", state_key: who, sender: by, content: { membership } });
    t.s.state[ROOM] = [plOf({ [CAROL]: 50 }), member(CAROL, "leave", BOB), muteRec(CAROL)];
    assert.equal((await t.post(ask())).statusCode, 200, "kicked");
    t.s.state[ROOM] = [plOf({ [CAROL]: 50 }), member(CAROL, "ban", BOB), muteRec(CAROL)];
    assert.equal((await t.post(ask({ device_id: "P2" }))).statusCode, 200, "banned");
    t.s.state[ROOM] = [plOf({ [CAROL]: 50 }), member(CAROL, "leave"), muteRec(CAROL)];
    assert.equal((await t.post(ask({ device_id: "P3" }))).body.reason, "server-muted", "left on their own: the mute stays");
});

test("PAD1-8 (cost guard for the new rule) the governing spaces are worked out once per room read, not once per record", async () => {
    const t = setup();
    const SPACE = `!space2:${SN}`;
    const others = Array.from({ length: 20 }, (_, i) => `@m${i}:${SN}`);
    t.s.state[ROOM] = [plOf({ [BOB]: 100 }), { type: "m.space.parent", state_key: SPACE, sender: BOB, content: { via: [SN] } },
        ...others.map((o) => muteRec(BOB, o)), muteRec(BOB)];
    t.s.state[SPACE] = [plOf({ [BOB]: 100 })];
    let reads = 0;
    const orig = t.s.state;
    t.s.state = new Proxy(orig, { get(o, k) { if (k === SPACE) reads++; return o[k]; } });
    assert.equal((await t.post(ask())).body.reason, "server-muted");
    assert.ok(reads <= 2, `the space was read ${reads} times for 21 records`);
});

test("PAD1-9 (cost guard) thousands of records in one room are judged in one pass over its state", async () => {
    const t = setup();
    const many = Array.from({ length: 3000 }, (_, i) => `@m${i}:${SN}`);
    t.s.state[ROOM] = [plOf({ [BOB]: 100 }), ...many.map((o) => ({ type: "m.room.member", state_key: o, sender: o, content: { membership: "join" } })),
        ...many.map((o) => muteRec(BOB, o)), muteRec(BOB)];
    const t0 = performance.now();
    assert.equal((await t.post(ask())).body.reason, "server-muted");
    assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});

// ---- round 3 security review, PAD-2 (server half): no Pad Camera token while the person is muted -----------------------

test("PAD2-1 a mute recorded only in the room refuses a Camera token too; an unmute lets it through", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    t.s.state[ROOM] = [
        { type: "m.room.power_levels", state_key: "", sender: BOB, content: { users: { [BOB]: 100 }, users_default: 0 } },
        { type: "dev.tinhat.call.moderation", state_key: ALICE.slice(1), sender: BOB, content: { muted: true }, origin_server_ts: 1 },
    ];
    const r = await t.post(ask({ mode: "camera" }));
    assert.deepEqual([r.statusCode, r.body.reason], [403, "server-muted"]);
    assert.ok(!t.logs.some((l) => /pad camera token minted/.test(l)), "nothing was signed");
    ps.setMuted(ROOM, ALICE, BOB);
    ps.clearMuted(ROOM, ALICE);  // an explicit unmute through the API, newer than the record
    assert.equal((await t.post(ask({ mode: "camera" }))).statusCode, 200);
});

test("PAD2-2 a mute set while a Camera request waits on the call server refuses it (the last check before signing)", async () => {
    const ps = createPadState();
    const t = setup({ padState: ps });
    let n = 0;
    t.s.onList = () => { if (++n === 2) ps.setMuted(ROOM, ALICE, BOB); };
    const r = await t.post(ask({ mode: "camera" }));
    assert.deepEqual([r.statusCode, r.body.reason], [403, "server-muted"]);
});

// ---- round 3 security review, PAD-3: nothing is attributed to a person before the key pair has been replaced ----------

test("PAD3-1 not rotated yet: Pad Mic and Camera are refused (503 not-rotated), nothing is signed", async () => {
    const t = setup({ rotated: false });
    for (const mode of ["mic", "camera"]) {
        const r = await t.post(ask({ mode }));
        assert.deepEqual([r.statusCode, r.body.reason], [503, "not-rotated"], mode);
    }
    assert.ok(!t.logs.some((l) => /token minted/.test(l)));
    assert.equal((await setup({}).post(ask())).statusCode, 200, "rotated (the default here): minted");
});

test("PAD3-2 not rotated yet: a Watch token carries the watch mark alone (as before 0.3.13), no person / Pad attributes", async () => {
    const t = setup({ rotated: false });
    const w = await t.post({ room: ROOM, openid_token: ask().openid_token, device_id: "PHONE" }, { handler: "watch" });
    assert.equal(w.statusCode, 200, JSON.stringify(w.body));
    assert.deepEqual(verify(w.body.jwt).attributes, { "tinhat.watch": "1" });
    const w2 = await setup({}).post({ room: ROOM, openid_token: ask().openid_token, device_id: "PHONE" }, { handler: "watch" });
    assert.equal(verify(w2.body.jwt).attributes["tinhat.person"], ALICE, "rotated: the person attributes");
});

test("PAD3-3 not rotated yet: a normal token is re-minted without tinhat.person (and lk-jwt's tinhat.* still dropped)", async () => {
    const { remint, signLk } = await import("../calltoken.mjs");
    const lk = JSON.stringify({ url: "wss://x", jwt: signLk({ iss: KEY, sub: `${ALICE}:DESK`, attributes: { "tinhat.person": BOB, keep: "1" },
        video: { room: ROOM, roomJoin: true, canPublish: true, canSubscribe: true } }, SECRET) });
    const attrs = (t) => JSON.parse(Buffer.from(JSON.parse(t).jwt.split(".")[1], "base64url")).attributes;
    assert.deepEqual({ ...attrs(remint(lk, SECRET, ALICE, null, { person: false })) }, { keep: "1" });
    assert.deepEqual({ ...attrs(remint(lk, SECRET, ALICE)) }, { keep: "1", "tinhat.person": ALICE });
});

test("PAD3-4 the API reads LK_ROTATED as the manager writes it: on a Tin Hat Server only an exact 1 counts", async () => {
    const { rotatedFromEnv } = await import("../calltoken.mjs");
    const box = (v) => rotatedFromEnv({ TINHAT_BOX: "1", ...(v === undefined ? {} : { LK_ROTATED: v }) });
    assert.deepEqual([box("1"), box(" 1 "), box("0"), box(""), box(undefined), box("yes"), box("true"), box("10")], [true, true, false, false, false, false, false, false]);
    const other = (v) => rotatedFromEnv(v === undefined ? {} : { LK_ROTATED: v });
    assert.deepEqual([other(undefined), other("1"), other("0")], [true, true, false], "a standalone API: only an explicit 0");
});
