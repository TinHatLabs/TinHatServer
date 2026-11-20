// A play sign-in's OpenID token, resolved by play/install.mjs createOpenIdResolver over the REAL fedresolve client
// (createFedResolver with a scripted resolver and https.request, as test/fedresolve.test.mjs does: nothing on the
// network) and a real network.json. G3 (games-gates 21:48): fedresolve.userinfo() answers {sub}, an OBJECT; the play
// resolver read it as a string, so EVERY federated player got 401 `session`. Plus truthful refusals: the SSRF guard =
// remote-refused (403), a server that doesn't answer = unavailable (503), never `db`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFedResolver } from "../fedresolve.mjs";
import { createOpenIdResolver } from "../play/install.mjs";

const HERE = "games.example", FAR = "far.example", LAN = "lan.example", DEAD = "dead.example";
const UI = "/_matrix/federation/v1/openid/userinfo?access_token=";

function fed() {
    const A = { [FAR]: ["93.184.216.34"], [LAN]: ["192.168.1.5"], [DEAD]: ["93.184.216.40"] };
    const resolver = () => ({
        resolve4: async (h) => { if (A[h]) return A[h]; throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
        resolve6: async () => { throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); },
        resolveSrv: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
        cancel: () => {},
    });
    const web = (r) => {
        if (r.host === DEAD) return { dead: true };
        if (r.path.startsWith(UI)) {
            const tok = decodeURIComponent(r.path.slice(UI.length));
            if (tok === "good-far") return { status: 200, body: { sub: "@player:far.example" } };
            if (tok === "good-other-server") return { status: 200, body: { sub: "@player:elsewhere.example" } };
            return { status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } };
        }
        return { status: 404, body: {} }; // no well-known: <name>:8448
    };
    function request(opts, cb) {
        const req = new EventEmitter();
        const rec = { host: opts.host, path: opts.path };
        req.destroy = () => {};
        req.end = () => setImmediate(() => {
            const a = web(rec);
            if (a.dead) return req.emit("error", new Error("ECONNREFUSED"));
            const res = new EventEmitter();
            res.statusCode = a.status;
            res.headers = { "content-type": "application/json" };
            res.destroy = () => {};
            cb(res);
            setImmediate(() => { res.emit("data", Buffer.from(JSON.stringify(a.body ?? {}))); res.emit("end"); });
        });
        return req;
    }
    return createFedResolver({ resolver, request, budgets: { TIMEOUT_MS: 3000, WELLKNOWN_MS: 1000 } });
}

function setup(connected) {
    const conf = mkdtempSync(join(tmpdir(), "play-openid-"));
    writeFileSync(join(conf, "network.json"), JSON.stringify({ v: 1, mode: "connected", issued: Math.floor(Date.now() / 1000), connected, blocked: [] }));
    const hs = { get: async () => ({ ok: true, status: 200, body: { sub: `@local:${HERE}` } }) };
    return { conf, resolve: createOpenIdResolver({ hs, serverName: HERE, conf, federation: fed() }) };
}
const oid = (server, token) => ({ openid: { access_token: token, matrix_server_name: server, token_type: "Bearer", expires_in: 60 } });

test("a federated player from a connected server is who their server says (fedresolve's REAL {sub} answer)", async () => {
    const { conf, resolve } = setup([FAR, LAN, DEAD]);
    try {
        assert.equal(await resolve({ ...oid(FAR, "good-far"), user_id: "@player:far.example" }), "@player:far.example");
        // and nothing else gets through
        assert.equal(await resolve({ ...oid(FAR, "good-far"), user_id: "@someone-else:far.example" }), null, "the token is another person's");
        assert.equal(await resolve({ ...oid(FAR, "bad-token"), user_id: "@player:far.example" }), null, "the server refused the token");
        assert.equal(await resolve({ ...oid(FAR, "good-other-server"), user_id: "@player:elsewhere.example" }), null, "an id of another server");
        // the local path still works
        assert.equal(await resolve({ ...oid(HERE, "x"), user_id: `@local:${HERE}` }), `@local:${HERE}`);
    } finally { rmSync(conf, { recursive: true, force: true }); }
});

test("refusals are truthful: not connected / the SSRF guard = remote-refused; no answer = unavailable", async () => {
    const { conf, resolve } = setup([FAR, LAN, DEAD]);
    try {
        await assert.rejects(resolve({ ...oid("not-connected.example", "good-far"), user_id: "@player:not-connected.example" }), (e) => e.code === "remote-refused");
        await assert.rejects(resolve({ ...oid(LAN, "good-far"), user_id: "@player:lan.example" }), (e) => e.code === "remote-refused", "a private address: the SSRF guard");
        await assert.rejects(resolve({ ...oid(DEAD, "good-far"), user_id: "@player:dead.example" }), (e) => e.code === "unavailable", "the server doesn't answer");
    } finally { rmSync(conf, { recursive: true, force: true }); }
});

// astra round 4: the server part is matched exactly, and a bug is never reported as the other server's outage
test("an id whose server only ENDS like the token's server is refused; a bug here is rethrown, not 'unavailable'", async () => {
    const conf = mkdtempSync(join(tmpdir(), "play-openid-"));
    writeFileSync(join(conf, "network.json"), JSON.stringify({ mode: "connected", issued: Math.floor(Date.now() / 1000), connected: [FAR], blocked: [] }));
    try {
        const lookalike = { userinfo: async () => ({ sub: "@p:evil:far.example" }) }; // (fedresolve itself refuses this too)
        const r1 = createOpenIdResolver({ hs: null, serverName: HERE, conf, federation: lookalike });
        assert.equal(await r1({ ...oid(FAR, "t"), user_id: "@p:evil:far.example" }), null);
        const buggy = { userinfo: async () => { throw new TypeError("x is not a function"); } };
        const r2 = createOpenIdResolver({ hs: null, serverName: HERE, conf, federation: buggy });
        await assert.rejects(r2({ ...oid(FAR, "t"), user_id: "@p:far.example" }), (e) => e instanceof TypeError && !e.code);
        const local = { get: async () => ({ ok: true, status: 200, body: { sub: `@someone-else:${HERE}` } }) };
        const r3 = createOpenIdResolver({ hs: local, serverName: HERE, conf, federation: null });
        assert.equal(await r3({ ...oid(HERE, "t"), user_id: `@me:${HERE}` }), null, "a local token for another person");
    } finally { rmSync(conf, { recursive: true, force: true }); }
});
