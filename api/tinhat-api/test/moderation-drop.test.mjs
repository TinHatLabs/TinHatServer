// dropFromCall (moderation.mjs): the guest room turned off / a guest's time is up → their call connections end now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installModeration } from "../moderation.mjs";

const b64u = (s) => Buffer.from(s).toString("base64url");
const G = "!guests:example.org", NEW = "@guest-aaaaaaaaaaaa:example.org";

test("drops every connection of the named accounts, nobody else's; an unknown room is 0", async () => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const method = url.split("/").pop(), body = JSON.parse(init.body);
        calls.push([method, body.identity ?? null]);
        if (method === "ListParticipants") {
            if (body.room !== G) return { ok: false, status: 404, text: async () => "{}" };
            return { ok: true, status: 200, text: async () => JSON.stringify({ participants: [
                { identity: `${NEW}:DEVICE1` }, { identity: "@alice:example.org:DEVICE2" }, { identity: NEW },
                { identity: `${NEW}x:DEVICE3` }] }) };
        }
        return { ok: true, status: 200, text: async () => "{}" };
    };
    try {
        const api = installModeration({ post() {} }, { requireMatrixUser() {}, synapse: async () => ({}), adminToken: "a",
            lkApiUrl: "http://lk.invalid", lkKey: "k", lkSecret: "s", b64u, createHmac, log: () => {} });
        assert.equal(await api.dropFromCall(G, [NEW]), 2);
        assert.deepEqual(calls.filter(([m]) => m === "RemoveParticipant").map(([, id]) => id), [`${NEW}:DEVICE1`, NEW]);
        assert.equal(await api.dropFromCall("!other:example.org", [NEW]), 0);
        assert.equal(await api.dropFromCall(G, []), 0);
    } finally { globalThis.fetch = real; }
});
