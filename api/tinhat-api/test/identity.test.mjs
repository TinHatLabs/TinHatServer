// identity.mjs (0.3.12, identity fix finding A): ONE device-id rule for the call token route and call moderation, so a
// device can't get into a call that moderators can't mute or remove. Driven through the real calltoken handler (room
// check on AND off, both request shapes) and the real /moderation/call route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DEVICE_RE, parseIdentity, identityOf, isConnectionOf } from "../identity.mjs";
import { createCallToken, offModeBody } from "../calltoken.mjs";
import { installModeration } from "../moderation.mjs";
import { fakeReq, fakeRes, clock } from "./helpers.mjs";

const SN = "home.test";
const ALICE = `@alice:${SN}`, BOB = `@bob:${SN}`;
const ROOM = `!call:${SN}`;
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

// device ids someone could log in with (Synapse takes any client-chosen id up to 512 characters)
const BAD = ["8448:EVIL", "A:B", "X.1", "a b", "dev#1", "dev~1", "dev@x", "é", "Ａ", "", "x".repeat(65),
    "KEY+base64/cross=signing", " ABC", "ABC​", "pad=="];
// + "QR login" ids: the rust-sdk's QR login uses the device's Curve25519 key, unpadded base64 (43 characters)
const GOOD = ["ABCDEFGHIJ", "abcdefghij", "0123456789", "a_b-c", "_", "-", "x".repeat(64), "ECDEV", "TINHATDESK1",
    "dev/1", "dev+1", "q1w2E3r4+T5y6/U7i8O9p0AaSsDdFfGgHhJjKkLlZzX"];
// every printable ASCII character alone, and in the middle of a Synapse-style id: the corpus the agreement test walks
const CORPUS = [...GOOD, ...BAD];
for (let c = 0x20; c < 0x7f; c++) { const ch = String.fromCharCode(c); CORPUS.push(ch, `ABCDE${ch}FGHIJ`); }

function tokenRoute({ enabled }) {
    const upCalls = [];
    async function fetchImpl(url, init) {
        upCalls.push(url);
        const b = JSON.parse(init.body);
        const dev = b.device_id ?? b.member?.claimed_device_id;
        const identity = url.endsWith("/get_token") ? String(b.member?.id ?? "") : `${ALICE}:${dev}`;
        return new Response(JSON.stringify({ url: "wss://x", jwt: `${b64u({ alg: "HS256" })}.${b64u({ sub: identity, video: { room: b.room ?? "hashed" } })}.s` }), { status: 200 });
    }
    const hs = {
        async get(path) {
            if (path.startsWith("/_matrix/federation/v1/openid/userinfo")) return { ok: true, status: 200, body: { sub: ALICE } };
            return { ok: true, status: 200, body: { members: [ALICE, BOB] } };
        },
    };
    const ct = createCallToken({ hs, adminToken: "t", serverName: SN, lkJwtUrl: "http://lk", fetchImpl, now: clock(1), log: () => {}, enabled: () => enabled, federation: { userinfo: async () => null } });
    let ip = 0;
    async function post(path, body) {
        const res = { statusCode: 200, headers: {} };
        res.status = (c) => { res.statusCode = c; return res; };
        res.set = () => res; res.end = () => res;
        res.json = (o) => { res.body = o; return res; };
        res.send = (t) => { res.body = JSON.parse(t); return res; };
        // a fresh address per request: this test is about the device rule, not the per-address limit
        await ct.handler(path)(fakeReq({ method: "POST", headers: { "x-forwarded-for": `198.51.100.${(ip++ % 250) + 1}` }, body: typeof body === "string" ? body : JSON.stringify(body) }), res);
        return res;
    }
    return { post, upCalls };
}
const oid = { access_token: "at", token_type: "Bearer", matrix_server_name: SN, expires_in: 3600 };
const legacy = (device) => ({ room: ROOM, openid_token: oid, device_id: device });
const msc = (device) => ({ room_id: ROOM, slot_id: "m.call#ROOM", openid_token: oid, member: { id: "m1", claimed_user_id: ALICE, claimed_device_id: device } });

test("DEVICE_RE and parseIdentity: last ':' split, ports and IPv6 kept, QR-login base64 ids in, anything else moderation can't target refused", () => {
    for (const d of GOOD) assert.ok(DEVICE_RE.test(d), d);
    for (const d of BAD) assert.ok(!DEVICE_RE.test(d), JSON.stringify(d));
    assert.deepEqual(parseIdentity("@a:h.test:DEV"), { mxid: "@a:h.test", device: "DEV" });
    assert.deepEqual(parseIdentity("@a:h.test:8448:DEV"), { mxid: "@a:h.test:8448", device: "DEV" }, "a server with a port");
    assert.deepEqual(parseIdentity("@a:[::1]:8448:DEV"), { mxid: "@a:[::1]:8448", device: "DEV" }, "an IPv6 literal");
    // the ambiguity: `@a:H` + device `8448:EVIL` vs `@a:H:8448` + `EVIL`: only the second is an identity we mint
    assert.equal(identityOf("@a:h.test", "8448:EVIL"), null);
    assert.equal(identityOf("@a:h.test:8448", "EVIL"), "@a:h.test:8448:EVIL");
    for (const bad of ["@a:h.test:X.1", "@a:h.test", "@a:h.test:", "a:h.test:DEV", "@a b:h.test:DEV", 5, null])
        assert.equal(parseIdentity(bad), null, String(bad));
    // the guest drop's rule: the account's own connections, a pre-0.3.12 odd device included, never a port look-alike's
    assert.ok(isConnectionOf("@g:h.test:DEV", "@g:h.test"));
    assert.ok(isConnectionOf("@g:h.test:X.1", "@g:h.test"), "made before 0.3.12");
    assert.ok(isConnectionOf("@g:h.test", "@g:h.test"));
    assert.ok(!isConnectionOf("@g:h.test:8448:DEV", "@g:h.test"));
    assert.ok(isConnectionOf("@g:h.test:8448:DEV", "@g:h.test:8448"));
    assert.ok(!isConnectionOf("@g:h.test:", "@g:h.test"));
    assert.ok(!isConnectionOf("@g:h.testx:DEV", "@g:h.test"));
    assert.ok(!isConnectionOf("@g:h.test:DEV", ""));
});

for (const enabled of [true, false]) {
    const mode = enabled ? "room check on" : "room check off";
    test(`a call sign-in for a device outside [A-Za-z0-9_+/-]{1,64} is refused, both shapes (${mode}); lk-jwt never asked`, async () => {
        const { post, upCalls } = tokenRoute({ enabled });
        for (const d of BAD) {
            for (const [path, body] of [["/sfu/get", legacy(d)], ["/sfu/get", msc(d)], ["/get_token", msc(d)]]) {
                const r = await post(path, body);
                assert.equal(r.statusCode, 400, `${mode} ${path} ${body.room ? "legacy" : "msc4195"} ${JSON.stringify(d)}`);
                assert.equal(r.body.errcode, "M_BAD_JSON");
            }
        }
        assert.equal(upCalls.length, 0, "lk-jwt was never asked for a bad device");
        for (const d of GOOD) {
            assert.equal((await post("/sfu/get", legacy(d))).statusCode, 200, `${mode} legacy ${d}`);
            assert.equal((await post("/sfu/get", msc(d))).statusCode, 200, `${mode} msc4195 ${d}`);
        }
    });
}

test("room check off: the device rule reads field names the way lk-jwt (Go) does: any case, every duplicate", async () => {
    const { post, upCalls } = tokenRoute({ enabled: false });
    const cases = [
        ["Device_ID in another case", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"Device_ID":"X.1"}`],
        ["a good device_id and a bad DEVICE_ID", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"OK","DEVICE_ID":"8448:EVIL"}`],
        ["a duplicate key, the bad one last (both JS and Go read the last)", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"OK","device_id":"a:b"}`],
        ["no device at all (lk-jwt would mint `<mxid>:`)", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)}}`],
        ["ROOM in another case, no device", `{"ROOM":"${ROOM}","openid_token":${JSON.stringify(oid)}}`],
        ["a device that is not a string", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":5}`],
        ["Member / Claimed_Device_ID in another case", JSON.stringify({ ...msc("OK"), member: undefined, Member: { id: "m", claimed_user_id: ALICE, Claimed_Device_ID: "X.1" } })],
        ["an MSC4195 member without a device", JSON.stringify({ ...msc("OK"), member: { id: "m", claimed_user_id: ALICE } })],
        // Go folds non-ASCII letters: unicode.ToUpper(unicode.ToLower('ı')) = 'I', 'İ' -> 'I', 'ſ' -> 'S'
        ["devıce_id with a dotless i (Go reads it as device_id)", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"OK","devıce_id":"X.1"}`],
        ["DEVİCE_ID with a dotted capital I", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"OK","DEVİCE_ID":"a:b"}`],
        ["claımed_devıce_ıd in the member", JSON.stringify({ ...msc("OK"), member: { id: "m", claimed_user_id: ALICE, claimed_device_id: "OK", "claımed_devıce_ıd": "X.1" } })],
        ["trailing data after the object (Go's Decoder reads the first value only)", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"X.1"} junk`],
        ["two objects", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"X.1"}{}`],
        ["a device_id of null after a bad one (Go keeps the earlier value)", `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"X.1","Device_ID":null}`],
        ["a member that is not an object", JSON.stringify({ ...msc("OK"), member: undefined, Member: "x" })],
    ];
    for (const [what, raw] of cases) {
        assert.ok(offModeBody(raw).error, what);
        assert.equal((await post("/sfu/get", raw)).statusCode, 400, what);
    }
    assert.equal(upCalls.length, 0);
    // not one JSON object: refused here too (400, as lk-jwt answers it), never handed on
    assert.ok(offModeBody("{").error);
    assert.ok(offModeBody("[]").error);
    // a good request goes through as it was (a canonical body re-encodes to itself)
    const good = JSON.stringify(legacy("ABCDEFGHIJ"));
    assert.equal(offModeBody(good).body, good);
    // duplicate keys: lk-jwt gets only the value checked here. `"member":{…X.1…},"member":null` would leave Go with the
    // first member (null changes nothing there) while JSON.parse keeps null: re-encoded, Go sees null too
    const dup = `{"room_id":"${ROOM}","slot_id":"m.call#ROOM","openid_token":${JSON.stringify(oid)},"member":{"id":"m","claimed_user_id":"${ALICE}","claimed_device_id":"X.1"},"member":null}`;
    assert.ok(offModeBody(dup).error, "a null member is refused (JSON.parse would hide the first one)");
    assert.equal((await post("/get_token", dup)).statusCode, 400);
    // exact duplicates otherwise collapse to the value checked here: lk-jwt never sees the other one
    const dup2 = `{"room":"${ROOM}","openid_token":${JSON.stringify(oid)},"device_id":"BADBUT:IGNORED","device_id":"OKDEV"}`;
    const out = offModeBody(dup2);
    assert.ok(!out.error);
    assert.ok(!out.body.includes("BADBUT"), "only the checked value is forwarded");
    assert.equal(upCalls.length, 0);
    assert.equal((await post("/sfu/get", dup2)).statusCode, 200);
    assert.equal(upCalls.length, 1);
});

/** /moderation/call, an owner of the room (PL 100) acting on whatever identity the token route minted. */
function modRoute() {
    const routes = new Map();
    const app = { post: (path, ...chain) => routes.set(path, chain) };
    let present = "";
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const method = String(url).split("/").pop();
        if (method === "ListParticipants") return { ok: true, status: 200, text: async () => JSON.stringify({ participants: [{ identity: present, tracks: [], permission: {} }] }) };
        return { ok: true, status: 200, text: async () => "{}" };
    };
    // the route allows a moderator 30 requests a minute: the corpus is spread over 40 owners of the room
    const ev = (type, state_key, content, sender = BOB) => ({ type, state_key, content, sender });
    const mods = Array.from({ length: 40 }, (_, i) => `@mod${i}:${SN}`);
    const state = [ev("m.room.power_levels", "", { users: Object.fromEntries(mods.map((u) => [u, 100])), users_default: 0 }),
        ...mods.map((u) => ev("m.room.member", u, { membership: "join" }, u)), ev("m.room.member", ALICE, { membership: "join" }, ALICE)];
    let n = 0;
    installModeration(app, {
        requireMatrixUser: (req, _res, next) => { req.matrixUser = mods[n++ % mods.length]; return next(); },
        synapse: async () => ({ ok: true, status: 200, body: { state } }),
        adminToken: "a", lkApiUrl: "http://lk.invalid", lkKey: "k", lkSecret: "s", b64u, createHmac, log: () => {},
    });
    async function act(identity) {
        present = identity;
        const req = fakeReq({ method: "POST" });
        req.body = { room_id: ROOM, action: "disconnect", target: identity };
        const res = fakeRes();
        const chain = routes.get("/moderation/call");
        let i = 0;
        const next = async () => { const h = chain[i++]; if (h) await h(req, res, next); };
        await next();
        return res;
    }
    return { act, restore: () => { globalThis.fetch = real; } };
}

test("agreement: moderation can act on EVERY identity the token route mints, and the token route mints nothing it can't (on and off)", async () => {
    const mod = modRoute();
    try {
        for (const enabled of [true, false]) {
            const { post } = tokenRoute({ enabled });
            let minted = 0;
            for (const d of CORPUS) {
                const r = await post("/sfu/get", legacy(d));
                const tokenOk = r.statusCode === 200;
                const id = `${ALICE}:${d}`;
                const m = await mod.act(id);
                // acted on, and on ALICE: `@alice:home.test` + device `8448:EVIL` reads as the identity of another
                // user (`@alice:home.test:8448`, device `EVIL`): that is exactly the ambiguity the token route refuses
                const modOk = m.statusCode === 200 && parseIdentity(id)?.mxid === ALICE;
                assert.equal(modOk, tokenOk, `${enabled ? "on" : "off"} device ${JSON.stringify(d)}: token ${r.statusCode}, moderation ${m.statusCode} ${m.body?.error ?? ""}`);
                if (tokenOk) minted++;
            }
            assert.ok(minted >= GOOD.length + 60, `the corpus exercised real tokens (${minted})`);
        }
        // users on a server with a port or an IPv6 literal can be moderated too (the old IDENTITY_RE refused IPv6)
        for (const u of ["@carol:home.test:8448", "@dave:[2001:db8::1]:8448"]) assert.equal(parseIdentity(`${u}:DEV`)?.mxid, u);
    } finally { mod.restore(); }
});
