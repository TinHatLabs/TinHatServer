// moderation.mjs — PAD-PHONE Step B: moderation covers the phone. A Pad Mic connection is muted / unmuted within its
// token's grant (never the normal mute's "every source but the mic" or the unmute's "every source", which the sweep would
// treat as a breach), a Watch / Camera connection has nothing to mute (409, or skipped in a person-wide action), a
// person-wide action covers every device and is answered per device, and a mute stays on the person (padstate.mjs) so
// the Pad route refuses them a Mic token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installModeration } from "../moderation.mjs";
import { createPadState } from "../padstate.mjs";
import { padViolation } from "../calltoken.mjs";
import { fakeReq, fakeRes } from "./helpers.mjs";

const b64u = (s) => Buffer.from(s).toString("base64url");
const OWNER = "@owner:example.org", BOB = "@bob:example.org";
const CALL = "!call:example.org";
const N = "0123456789abcdef";
const ev = (type, state_key, content, sender = OWNER) => ({ type, state_key, content, sender });
const state = [ev("m.room.power_levels", "", { users: { [OWNER]: 100 }, users_default: 0 }),
    ev("m.room.member", OWNER, { membership: "join" }, OWNER), ev("m.room.member", BOB, { membership: "join" }, BOB)];
const padAttrs = (mode) => ({ "tinhat.person": BOB, "tinhat.pad": "phone", "tinhat.mode": mode, "tinhat.gen": "1" });

function world({ failFor = "" } = {}) {
    const routes = new Map();
    const app = { post: (path, ...chain) => routes.set(path, chain) };
    const acted = [];
    const sfu = [
        { identity: `${BOB}:DESK`, tracks: [{ type: "AUDIO", sid: "TR_d", source: "MICROPHONE" }], permission: { can_subscribe: true, can_publish: true, can_publish_data: true } },
        { identity: `${BOB}:PHONE~pad-mic-${N}`, tracks: [{ type: "AUDIO", sid: "TR_p", source: "MICROPHONE" }], permission: { can_subscribe: true, can_publish: true, can_publish_sources: ["MICROPHONE"] }, attributes: padAttrs("mic") },
        { identity: `${BOB}:TAB~pad-cam-${N}`, tracks: [{ type: "VIDEO", sid: "TR_c", source: "CAMERA" }], permission: { can_subscribe: true, can_publish: true, can_publish_sources: ["CAMERA"] }, attributes: padAttrs("camera") },
        { identity: `${BOB}:OLD~watch-${N}`, tracks: [], permission: { can_subscribe: true } },
        { identity: `${OWNER}:DEV`, tracks: [], permission: { can_subscribe: true, can_publish: true } },
    ];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const method = String(url).split("/").pop();
        const body = JSON.parse(init.body);
        if (method === "ListParticipants") return { ok: true, status: 200, text: async () => JSON.stringify({ participants: sfu }) };
        acted.push([method, body.identity, body.permission ?? body.muted ?? null]);
        if (failFor && body.identity === failFor) return { ok: false, status: 503, text: async () => JSON.stringify({ msg: "unavailable" }) };
        return { ok: true, status: 200, text: async () => "{}" };
    };
    const padState = createPadState();
    installModeration(app, {
        requireMatrixUser: (req, _res, next) => { req.matrixUser = req.headers["x-user"]; return next(); },
        synapse: async () => ({ ok: true, status: 200, body: { state } }),
        adminToken: "a", lkApiUrl: "http://lk.invalid", lkKey: "k", lkSecret: "s", b64u, createHmac, log: () => {}, padState,
    });
    async function act(target, action, scope) {
        const req = fakeReq({ method: "POST", headers: { "x-user": OWNER } });
        req.body = { room_id: CALL, action, target, ...(scope ? { scope } : {}) };
        const res = fakeRes();
        const chain = routes.get("/moderation/call");
        let i = 0;
        const next = async () => { const h = chain[i++]; if (h) await h(req, res, next); };
        await next();
        return res;
    }
    return { act, acted, sfu, padState, restore: () => { globalThis.fetch = real; } };
}
async function inWorld(o, fn) { const w = world(o); try { await fn(w); } finally { w.restore(); } }

test("M01 muting a Pad Mic connection: its mic track muted, publishing taken away, NEVER the normal mute's camera/screen sources", async () => {
    await inWorld({}, async (w) => {
        const r = await w.act(`${BOB}:PHONE~pad-mic-${N}`, "mute");
        assert.equal(r.statusCode, 200, JSON.stringify(r.body));
        const upd = w.acted.find(([m]) => m === "UpdateParticipant");
        assert.deepEqual(upd[2], { can_subscribe: true, can_publish: false, can_publish_data: false, can_update_metadata: false, hidden: false, can_publish_sources: [] });
        assert.ok(w.acted.some(([m, id]) => m === "MutePublishedTrack" && id === `${BOB}:PHONE~pad-mic-${N}`));
        assert.ok(w.padState.isMuted(CALL, BOB), "the mute stays on the person");
        // the permission written keeps the session within its contract (the sweep would not remove it)
        assert.equal(padViolation({ identity: `${BOB}:PHONE~pad-mic-${N}`, permission: upd[2], tracks: [], attributes: padAttrs("mic") }), "");
    });
});

test("M02 unmuting a Pad Mic connection restores exactly the microphone (never 'every source'); the person state clears", async () => {
    await inWorld({}, async (w) => {
        await w.act(`${BOB}:PHONE~pad-mic-${N}`, "mute");
        w.acted.length = 0;
        const r = await w.act(`${BOB}:PHONE~pad-mic-${N}`, "unmute");
        assert.equal(r.statusCode, 200);
        const upd = w.acted.find(([m]) => m === "UpdateParticipant");
        assert.deepEqual(upd[2], { can_subscribe: true, can_publish: true, can_publish_data: false, can_update_metadata: false, hidden: false, can_publish_sources: ["MICROPHONE"] });
        assert.equal(w.padState.isMuted(CALL, BOB), false);
        // negative control: the normal unmute's permission on a Pad Mic connection breaks its contract
        assert.equal(padViolation({ identity: `${BOB}:PHONE~pad-mic-${N}`, permission: { can_publish: true, can_publish_sources: [] }, tracks: [], attributes: padAttrs("mic") }), "rights");
    });
});

test("M03 a Camera / Watch connection: mute and unmute answer 409 (nothing to mute), disconnect works", async () => {
    await inWorld({}, async (w) => {
        assert.equal((await w.act(`${BOB}:TAB~pad-cam-${N}`, "mute")).body.reason, "camera-only");
        assert.equal((await w.act(`${BOB}:TAB~pad-cam-${N}`, "unmute")).statusCode, 409);
        assert.equal((await w.act(`${BOB}:OLD~watch-${N}`, "mute")).body.reason, "watching");
        assert.equal((await w.act(`${BOB}:TAB~pad-cam-${N}`, "disconnect")).statusCode, 200);
        assert.ok(w.acted.some(([m, id]) => m === "RemoveParticipant" && id === `${BOB}:TAB~pad-cam-${N}`));
    });
});

test("M04 person-wide mute: every mic of theirs (computer + phone), the camera and the watcher skipped, answered per device; nobody else", async () => {
    await inWorld({}, async (w) => {
        const r = await w.act(`${BOB}:DESK`, "mute", "person");
        assert.equal(r.statusCode, 200, JSON.stringify(r.body));
        assert.equal(r.body.scope, "person");
        assert.equal(r.body.done, 2);
        assert.equal(r.body.failed, 0);
        const by = Object.fromEntries(r.body.devices.map((d) => [d.identity, d.result]));
        assert.deepEqual(by, { [`${BOB}:DESK`]: "ok", [`${BOB}:PHONE~pad-mic-${N}`]: "ok", [`${BOB}:TAB~pad-cam-${N}`]: "skipped", [`${BOB}:OLD~watch-${N}`]: "skipped" });
        assert.ok(!w.acted.some(([, id]) => id === `${OWNER}:DEV`), "never another person");
        assert.ok(w.padState.isMuted(CALL, BOB));
    });
});

test("M05 person-wide remove: every connection of theirs incl. the phone's Pad ones", async () => {
    await inWorld({}, async (w) => {
        const r = await w.act(`${BOB}:PHONE~pad-mic-${N}`, "disconnect", "person");
        assert.equal(r.body.done, 4);
        assert.deepEqual(w.acted.filter(([m]) => m === "RemoveParticipant").map(([, id]) => id).sort(),
            [`${BOB}:DESK`, `${BOB}:OLD~watch-${N}`, `${BOB}:PHONE~pad-mic-${N}`, `${BOB}:TAB~pad-cam-${N}`].sort());
    });
});

test("M06 a partial failure is reported per device (\"1 of 2\"), not hidden; all failing -> 502", async () => {
    await inWorld({ failFor: `${BOB}:PHONE~pad-mic-${N}` }, async (w) => {
        const r = await w.act(`${BOB}:DESK`, "mute", "person");
        assert.equal(r.statusCode, 200);
        assert.equal(r.body.ok, false);
        assert.deepEqual([r.body.done, r.body.failed], [1, 1]);
        assert.equal(r.body.devices.find((d) => d.result === "failed").identity, `${BOB}:PHONE~pad-mic-${N}`);
    });
    await inWorld({ failFor: `${BOB}:DESK` }, async (w) => {
        w.sfu.splice(1, 3); // only the computer is left
        const r = await w.act(`${BOB}:DESK`, "disconnect", "person");
        assert.equal(r.statusCode, 502);
    });
});

test("M07 a device mute sets the person state too (their phone can't take the mic); scope is validated", async () => {
    await inWorld({}, async (w) => {
        await w.act(`${BOB}:DESK`, "mute");
        assert.ok(w.padState.isMuted(CALL, BOB));
        assert.equal((await w.act(`${BOB}:DESK`, "mute", "room")).statusCode, 400);
        assert.equal((await w.act(`${BOB}:DESK~pad-mic-zzzz`, "mute")).statusCode, 400);
    });
});

test("R1-1 a person-wide action never rebuilds the permission of a reserved form it can't parse (…~pad-mic-…#X): it is removed", async () => {
    await inWorld({}, async (w) => {
        w.sfu.push({ identity: `${BOB}:PHONE~pad-mic-${N}#X`, tracks: [], permission: { can_subscribe: true, can_publish: true, can_publish_sources: ["MICROPHONE"] } });
        for (const action of ["unmute", "mute"]) {
            w.acted.length = 0;
            await w.act(`${BOB}:DESK`, action, "person");
            assert.ok(!w.acted.some(([m, id]) => m === "UpdateParticipant" && id.endsWith("#X")), `${action}: no permission written for the #X form`);
            assert.ok(w.acted.some(([m, id]) => m === "RemoveParticipant" && id.endsWith("#X")), `${action}: removed instead`);
        }
    });
});

test("R1-3b a connection that arrives during a person-wide mute is muted too (the second listing)", async () => {
    await inWorld({}, async (w) => {
        const late = { identity: `${BOB}:LATE`, tracks: [{ type: "AUDIO", sid: "TR_l" }], permission: { can_subscribe: true, can_publish: true } };
        let lists = 0;
        const real = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            if (String(url).endsWith("/ListParticipants") && ++lists === 2) w.sfu.push(late);
            return real(url, init);
        };
        const r = await w.act(`${BOB}:DESK`, "mute", "person");
        assert.ok(r.body.devices.some((d) => d.identity === `${BOB}:LATE` && d.result === "ok"), JSON.stringify(r.body.devices));
    });
});

test("R1-8b a mute mutes numeric / omitted AUDIO tracks and never a VIDEO track", async () => {
    await inWorld({}, async (w) => {
        w.sfu[0].tracks = [{ type: 0, sid: "TR_a0" }, { sid: "TR_aomit" }, { type: 1, sid: "TR_v1" }, { type: "VIDEO", sid: "TR_v" }];
        await w.act(`${BOB}:DESK`, "mute");
        const tr = w.acted.filter(([m]) => m === "MutePublishedTrack");
        assert.equal(tr.length, 2);
    });
});

test("R2-5b (amended r8) a device unmute also gives the person's other normal connections back exactly what the server's mute took", async () => {
    await inWorld({}, async (w) => {
        w.sfu.push({ identity: `${BOB}:LAPTOP`, sid: "PA_l", tracks: [], permission: { can_subscribe: true, can_publish: true, can_publish_sources: [] } });
        await w.act(`${BOB}:DESK`, "mute", "person"); // the server restricts (and records) the laptop too
        const lap = w.sfu.find((p) => p.identity === `${BOB}:LAPTOP`);
        lap.permission = w.acted.find(([m, id]) => m === "UpdateParticipant" && id === `${BOB}:LAPTOP`)[2];
        w.acted.length = 0;
        await w.act(`${BOB}:DESK`, "unmute");
        assert.ok(w.acted.some(([m, id, perm]) => m === "UpdateParticipant" && id === `${BOB}:LAPTOP` && Array.isArray(perm?.can_publish_sources) && perm.can_publish_sources.length === 0), JSON.stringify(w.acted));
    });
});


test("R9-4 a moderator's mute / unmute of a normal connection: the mute sources, then every source, the other bits kept", async () => {
    await inWorld({}, async (w) => {
        w.sfu[0].permission = { can_subscribe: true, can_publish: true, can_publish_data: false };
        await w.act(`${BOB}:DESK`, "mute");
        const m = w.acted.find(([x, id]) => x === "UpdateParticipant" && id === `${BOB}:DESK`)[2];
        assert.deepEqual(m.can_publish_sources, ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"]);
        w.sfu[0].permission = m;
        w.acted.length = 0;
        await w.act(`${BOB}:DESK`, "unmute");
        const u = w.acted.find(([x, id]) => x === "UpdateParticipant" && id === `${BOB}:DESK`)[2];
        assert.deepEqual([u.can_publish_sources, u.can_publish_data], [[], false]);
    });
});
