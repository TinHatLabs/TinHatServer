// guestcalls.mjs: a guest's call memberships are withdrawn as the guest before its account goes (guest-leave, 0.3.7).
import test from "node:test";
import assert from "node:assert/strict";
import { clearGuestCalls, LOGIN_TTL_MS } from "../guestcalls.mjs";

const ROOM = "!guests:crew.example.org", G1 = "@guest-ab:crew.example.org", AMY = "@amy:crew.example.org";
const live = (sender, dev, extra = {}) => ({ type: "org.matrix.msc3401.call.member", state_key: `_${sender}_${dev}_m.call`, sender,
    content: { application: "m.call", call_id: "", scope: "m.room", device_id: dev, created_ts: 1, expires: 14400000, ...extra } });

function hs(state, { loginFails = false, putFails = false, stateFails = false } = {}) {
    const s = { calls: [], puts: [], loggedOut: [] };
    s.call = async (method, path, token, body) => {
        s.calls.push(`${method} ${path} ${token}`);
        if (method === "GET" && path === `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/state`) {
            assert.equal(token, "admintoken");
            return stateFails ? { ok: false, status: 403, body: {} } : { ok: true, status: 200, body: state };
        }
        if (method === "POST" && path === `/_synapse/admin/v1/users/${encodeURIComponent(G1)}/login`) {
            assert.equal(token, "admintoken");
            s.loginBody = body;
            return loginFails ? { ok: false, status: 404, body: {} } : { ok: true, status: 200, body: { access_token: "puppet" } };
        }
        if (method === "PUT") {
            assert.equal(token, "puppet", "the membership is written as the guest");
            assert.deepEqual(body, {});
            s.puts.push(decodeURIComponent(path.split("/").slice(-2).join("/")));
            return putFails ? { ok: false, status: 500, body: {} } : { ok: true, status: 200, body: { event_id: "$x" } };
        }
        if (method === "POST" && path === "/_matrix/client/v3/logout") { s.loggedOut.push(token); return s.logoutFails ? { ok: false, status: 500, body: {} } : { ok: true, status: 200, body: {} }; }
        throw new Error(`unexpected ${method} ${path}`);
    };
    return s;
}
const run = (s, user = G1) => clearGuestCalls({ call: s.call, adminToken: "admintoken", user, room: ROOM, log: () => {} });

test("every live call membership the guest sent is tombstoned as the guest; the token is logged out after", async () => {
    const st = [live(G1, "DEV1"), live(G1, "DEV2"), { ...live(G1, "OLD"), content: {} }, live(AMY, "A"),
        { type: "m.call.member", state_key: G1, sender: G1, content: { memberships: [{ call_id: "" }] } },
        { type: "m.room.member", state_key: G1, sender: G1, content: { membership: "join" } }];
    const s = hs(st);
    assert.equal(await run(s), 3);
    assert.deepEqual(s.puts.sort(), [`m.call.member/${G1}`, `org.matrix.msc3401.call.member/_${G1}_DEV1_m.call`, `org.matrix.msc3401.call.member/_${G1}_DEV2_m.call`].sort());
    assert.deepEqual(s.loggedOut, ["puppet"]);
});

test("nothing live: no log-in as the guest at all", async () => {
    const s = hs([{ ...live(G1, "D"), content: {} }, live(AMY, "A")]);
    assert.equal(await run(s), 0);
    assert.ok(!s.calls.some((c) => c.includes("/login")));
});

test("failures never throw: state unreadable, log-in refused, a PUT refused (token still logged out)", async () => {
    assert.equal(await run(hs([live(G1, "D")], { stateFails: true })), 0);
    assert.equal(await run(hs([live(G1, "D")], { loginFails: true })), 0);
    const s = hs([live(G1, "D")], { putFails: true });
    assert.equal(await run(s), 0);
    assert.deepEqual(s.loggedOut, ["puppet"]);
    const boom = { call: async () => { throw new Error("fetch failed"); } };
    assert.equal(await clearGuestCalls({ ...boom, adminToken: "admintoken", user: G1, room: ROOM }), 0);
});

test("the token used to act as the guest expires by itself, and a failed logout is logged", async () => {
    const h = hs([live(G1, "GDEV")]);
    h.logoutFails = true;
    const logs = [];
    const t0 = Date.now();
    const n = await clearGuestCalls({ call: h.call, adminToken: "admintoken", user: G1, room: ROOM, log: (l) => logs.push(l) });
    assert.equal(n, 1, "the membership was still withdrawn");
    const until = h.loginBody?.valid_until_ms;
    assert.ok(Number.isSafeInteger(until) && until > t0 && until <= Date.now() + LOGIN_TTL_MS, `valid_until_ms ${until}`);
    assert.ok(logs.some((l) => /logging out the token .* said 500; it expires within 2 min/.test(l)), logs.join("\n"));
});
