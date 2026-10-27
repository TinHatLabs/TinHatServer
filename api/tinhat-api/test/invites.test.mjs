// invites.mjs — the invite codes the operators mint (the apps parse this exact shape: TH-XXXX-XXXX).
import { test } from "node:test";
import assert from "node:assert/strict";
import { INVITE_PREFIX, installInvites, mintInviteCode, codeHint } from "../invites.mjs";
import { fakeReq, fakeRes } from "./helpers.mjs";

const SHAPE = /^TH-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

test("a code is TH- and two groups of four, without look-alikes, in Synapse's token charset", () => {
    assert.equal(INVITE_PREFIX, "TH-");
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
        const c = mintInviteCode();
        assert.match(c, SHAPE);
        assert.match(c, /^[A-Za-z0-9._~-]{1,64}$/);
        seen.add(c);
    }
    assert.ok(seen.size > 495, "codes are random");
});

/** Express-shaped app that keeps each route's middleware chain, so a route runs as Express would run it. */
function fakeApp() {
    const routes = new Map();
    const add = (m) => (path, ...chain) => routes.set(`${m} ${path}`, chain);
    return {
        get: add("GET"), post: add("POST"), delete: add("DELETE"),
        async run(key, opts) {
            const req = fakeReq(opts);
            req.body = opts.body;
            req.params = opts.params || {};
            const res = fakeRes();
            const chain = routes.get(key);
            let i = 0;
            const next = async () => { const h = chain[i++]; if (h) await h(req, res, next); };
            await next();
            return res;
        },
    };
}

test("POST /admin/invites asks Synapse for a TH- code", async () => {
    const app = fakeApp();
    const asked = [];
    installInvites(app, {
        requireMatrixUser: (req, _res, next) => { req.matrixUser = "@owner:example.org"; return next(); },
        synapse: async (path, init) => {
            asked.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
            return { ok: true, status: 200, body: { ...JSON.parse(init.body), pending: 0, completed: 0 } };
        },
        adminToken: "x", operators: new Set(["@owner:example.org"]), serverName: "example.org",
    });
    const r = await app.run("POST /admin/invites", { method: "POST", body: { uses: 1, days: 7 } });
    assert.equal(r.statusCode, 200);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].path, "/_synapse/admin/v1/registration_tokens/new");
    assert.match(asked[0].body.token, SHAPE);
    assert.match(r.body.invite.code, SHAPE);
});

test("the log names a minted or revoked code by its first five characters only (security review 2026-10-26)", async () => {
    const app = fakeApp();
    const lines = [];
    installInvites(app, {
        requireMatrixUser: (req, _res, next) => { req.matrixUser = "@owner:example.org"; return next(); },
        synapse: async (path, init) => (path.endsWith("/new")
            ? { ok: true, status: 200, body: { ...JSON.parse(init.body), pending: 0, completed: 0 } }
            : { ok: true, status: 200, body: {} }),
        adminToken: "x", operators: new Set(["@owner:example.org"]), serverName: "example.org",
        log: (...a) => lines.push(a.join(" ")),
    });
    const r = await app.run("POST /admin/invites", { method: "POST", body: { uses: 5, days: 30 } });
    const code = r.body.invite.code;
    await app.run("DELETE /admin/invites/:code", { method: "DELETE", params: { code } });
    const said = lines.filter((l) => /minted|revoked/.test(l));
    assert.equal(said.length, 2, lines.join("\n"));
    for (const l of said) {
        assert.ok(!l.includes(code), l);
        assert.ok(l.includes(codeHint(code)), l);
    }
    assert.equal(codeHint("TH-ABCD-EFGH"), "TH-AB…");
});
