// push.mjs — REACH §3.1 + §3.4 with A2.5–A2.7 and A2.12: registrations (server-derived pushkeys, owner-only),
// the gateway's filters, wording, payload and headers, push-service answer handling (reject / retry / error),
// dedup, the SSRF guard, "don't buzz the phone while at a computer" with consent, the test endpoint, the
// gateway's own listener and the log discipline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPush, startGatewayServer, classify, word, payloadBytes, topicFor, clean, outcome, isCallKeySized, Gate, PUSH } from "../push.mjs";
import { b64u, decrypt, loadOrCreateVapid, pushkeyFor } from "../webpush.mjs";
import { call, bearer, clock, fakeHomeserver, authFor, fakeFetch } from "./helpers.mjs";

const A = "@alice:example.org", B = "@bob:example.org";
const DM = "!dm:example.org", GROUP = "!group:example.org";

function subscription(endpoint = "https://web.push.apple.com/abcdef") {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    return { ua, auth, endpoint, pushkey: pushkeyFor(endpoint), data: { endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth), v: 1 } };
}

function setup({ status = () => 201 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "reach-push-"));
    const now = clock(1000);
    const hs = fakeHomeserver({
        tokens: { ta: { user: A, device: "APHONE" }, ta2: { user: A, device: "ADESK" }, tb: { user: B, device: "BDEV" } },
        members: { [DM]: 2, [GROUP]: 5 },
    });
    const logs = [], errors = [];
    const fetchImpl = fakeFetch(status);
    const p = createPush({
        auth: authFor(hs, now), hs, adminToken: "admintoken", dir, fetchImpl, now, wallNow: () => 1_790_000_000_000 + now(),
        log: (s) => logs.push(s), logError: (s) => { logs.push(s); errors.push(s); }, pushTimeoutMs: 200,
    });
    const notify = (notification) => call(p.notify, { method: "POST", body: { notification } });
    const api = (h, tok, body, query) => call(h, { method: "POST", headers: bearer(tok), body, query });
    const q = (h, tok, query) => call(h, { headers: bearer(tok), query });
    const reg = (tok, sub, quietWhileActive = true) => api(p.register, tok, { ...sub.data, quietWhileActive });
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { dir, now, hs, logs, errors, fetchImpl, p, notify, api, q, reg, cleanup };
}

function note(sub, over = {}, tweaks = { sound: "default" }) {
    return {
        event_id: "$ev1", room_id: DM, type: "m.room.message", sender: B, sender_display_name: "Bob",
        room_name: "Bob", prio: "high", counts: { unread: 3 },
        content: { msgtype: "m.text", body: "hello   there\n\nfriend" },
        devices: [{ app_id: PUSH.APP_ID, pushkey: sub.pushkey, pushkey_ts: 1, data: sub.data, tweaks }],
        ...over,
    };
}
let evSeq = 0;
const fresh = (over = {}) => ({ event_id: `$ev${++evSeq}`, ...over }); // a new event each time (no dedup)
const sent = (fx, i = 0) => fx.fetchImpl.calls[i];
const open = (sub, c) => JSON.parse(decrypt(c.init.body, sub.ua.getPrivateKey(), sub.auth).toString("utf8"));

test("config_is_public_and_names_the_lan_gateway", async () => {
    const fx = setup();
    try {
        const r = await call(fx.p.config);
        assert.equal(r.statusCode, 200);
        assert.equal(r.headers["cache-control"], "no-store");
        assert.deepEqual(Object.keys(r.body).sort(), ["app_id", "gateway", "vapid"]);
        assert.equal(r.body.gateway, "http://127.0.0.1:3091/_matrix/push/v1/notify"); // the default; a server passes its own
        assert.equal(r.body.app_id, "dev.tinhat.web");
        assert.equal(Buffer.from(r.body.vapid, "base64url").length, 65);
        assert.equal(statSync(join(fx.dir, "vapid.json")).mode & 0o777, 0o600);
    } finally { fx.cleanup(); }
});

test("register_derives_the_pushkey_and_ownership_is_first_come", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        assert.equal((await call(fx.p.register, { method: "POST", body: sub.data })).statusCode, 401);
        let r = await fx.reg("ta", sub, true);
        assert.deepEqual([r.statusCode, r.body], [200, { ok: true, pushkey: sub.pushkey, quietWhileActive: true }]);
        assert.equal(r.body.pushkey, createHash("sha256").update(sub.endpoint).digest("base64url"), "base64url(sha256(endpoint))");
        const file = join(fx.dir, "push-owners.json");
        assert.equal(statSync(file).mode & 0o777, 0o600);
        const onDisk = JSON.parse(readFileSync(file, "utf8"))[sub.pushkey];
        assert.equal(onDisk.mxid, A);
        assert.equal(onDisk.endpoint, sub.endpoint, "the subscription is stored with its owner");
        r = await fx.reg("tb", sub, false);
        assert.deepEqual([r.statusCode, r.body], [409, { error: "pushkey_owned" }]);
        r = await fx.reg("ta", sub, false);
        assert.deepEqual(r.body, { ok: true, pushkey: sub.pushkey, quietWhileActive: false }, "the owner may update it");
        // refused subscriptions
        r = await fx.api(fx.p.register, "ta", { ...sub.data, endpoint: "https://evil.example/x" });
        assert.deepEqual([r.statusCode, r.body.error, r.body.reason], [400, "subscription_refused", "host_not_allowed"]);
        r = await fx.api(fx.p.register, "ta", { ...sub.data, p256dh: "AAAA" });
        assert.equal(r.statusCode, 400);
        r = await fx.api(fx.p.register, "ta", { ...sub.data, quietWhileActive: "yes" });
        assert.equal(r.statusCode, 400);
    } finally { fx.cleanup(); }
});

test("registration_get_and_delete_are_owner_only", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        let r = await fx.q(fx.p.registration, "ta", { pushkey: sub.pushkey });
        assert.deepEqual([r.statusCode, r.body], [200, { registered: false, quietWhileActive: false }]);
        await fx.reg("ta", sub, true);
        r = await fx.q(fx.p.registration, "ta", { pushkey: sub.pushkey });
        assert.deepEqual(r.body, { registered: true, quietWhileActive: true });
        r = await fx.q(fx.p.registration, "tb", { pushkey: sub.pushkey });
        assert.deepEqual([r.statusCode, r.body], [403, { error: "not_owner" }]);
        r = await call(fx.p.unregister, { method: "DELETE", headers: bearer("tb"), query: { pushkey: sub.pushkey } });
        assert.deepEqual([r.statusCode, r.body], [403, { error: "not_owner" }]);
        r = await call(fx.p.unregister, { method: "DELETE", headers: bearer("ta"), query: { pushkey: sub.pushkey } });
        assert.deepEqual([r.statusCode, r.headers["cache-control"]], [204, "no-store"]);
        assert.equal(fx.p._regs.has(sub.pushkey), false);
        assert.equal((await call(fx.p.unregister, { method: "DELETE", headers: bearer("ta"), query: {} })).statusCode, 400);
        assert.equal((await fx.q(fx.p.registration, "ta", {})).statusCode, 400);
    } finally { fx.cleanup(); }
});

test("at_most_10_registrations_per_user_oldest_evicted", async () => {
    const fx = setup();
    try {
        const subs = Array.from({ length: 12 }, (_, i) => subscription(`https://fcm.googleapis.com/fcm/send/k${i}`));
        for (const s of subs) { await fx.reg("ta", s); fx.now.advance(1); }
        const mine = [...fx.p._regs.values()].filter((r) => r.mxid === A);
        assert.equal(mine.length, 10);
        assert.equal(fx.p._regs.has(subs[0].pushkey), false);
        assert.equal(fx.p._regs.has(subs[1].pushkey), false);
        assert.equal(fx.p._regs.has(subs[11].pushkey), true);
    } finally { fx.cleanup(); }
});

test("registrations_survive_a_restart_and_a_corrupt_file_starts_empty", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        await fx.reg("ta", sub, true);
        const vapid = loadOrCreateVapid(join(fx.dir, "vapid.json"));
        const mk = () => createPush({ auth: authFor(fx.hs, fx.now), hs: fx.hs, adminToken: "x", dir: fx.dir, vapid, fetchImpl: fx.fetchImpl, now: fx.now, log: () => {}, logError: (s) => fx.errors.push(s) });
        const again = mk();
        assert.equal(again._regs.get(sub.pushkey).mxid, A);
        assert.equal(again.vapidPublic, fx.p.vapidPublic, "same VAPID key after a restart");
        writeFileSync(join(fx.dir, "push-owners.json"), "{ not json");
        const third = mk();
        assert.equal(third._regs.size, 0);
        assert.ok(fx.errors.some((l) => /unreadable/.test(l)), "and it is logged");
    } finally { fx.cleanup(); }
});

test("dm_message_is_pushed_encrypted_with_contract_payload_and_headers", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        await fx.reg("ta", sub);
        const r = await fx.notify(note(sub, fresh()));
        assert.deepEqual([r.statusCode, r.body], [200, { rejected: [] }]);
        assert.equal(fx.fetchImpl.calls.length, 1);
        const c = sent(fx);
        assert.equal(c.url, sub.endpoint);
        assert.equal(c.init.headers.TTL, "3600");
        assert.equal(c.init.headers.Urgency, "high");
        assert.equal(c.init.headers.Topic, createHash("sha256").update(DM).digest("base64url").slice(0, 32));
        assert.equal(c.init.headers.Topic, topicFor(DM));
        assert.match(c.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
        assert.ok(!/Bearer|admintoken/.test(JSON.stringify(c.init.headers)), "never Matrix or admin auth outbound");
        const j = open(sub, c);
        assert.deepEqual(j, { v: 1, room: DM, event: j.event, kind: "message", title: "Bob", body: "hello there friend", unread: null, user: A },
            "unread is null since A5.10: the service worker keeps the badge, counts.unread is not it");
    } finally { fx.cleanup(); }
});

test("group_wording_urgency_always_high_and_user_empty_when_unregistered", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        await fx.notify(note(sub, fresh({ room_id: GROUP, room_name: "Game Night" }), { sound: "default" }));
        const j = open(sub, sent(fx));
        assert.deepEqual([j.title, j.body, j.user], ["Game Night", "Bob: hello there friend", ""]);
        assert.equal(sent(fx).init.headers.Urgency, "high", "every pushed event is high (A2.7)");
    } finally { fx.cleanup(); }
});

test("only_highlight_or_sound_is_pushed", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        for (const tw of [{}, { highlight: false }, { sound: "" }, { sound: null }, { sound: false }, "none"]) {
            const n = note(sub, fresh({ room_id: GROUP }), tw === "none" ? {} : tw);
            if (tw === "none") delete n.devices[0].tweaks;
            const r = await fx.notify(n);
            assert.deepEqual(r.body, { rejected: [] });
        }
        assert.equal(fx.fetchImpl.calls.length, 0, "plain group chatter: no push");
        await fx.notify(note(sub, fresh({ room_id: GROUP }), { highlight: true }));
        assert.equal(fx.fetchImpl.calls.length, 1, "a mention is");
    } finally { fx.cleanup(); }
});

test("never_count_only_reactions_edits_members_or_call_state", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        const cases = [
            { event_id: undefined, type: undefined, content: undefined },
            { event_id: "" },
            { content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$x", key: "👍" } }, type: "m.reaction" },
            { content: { body: "* fixed", "m.new_content": { body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$x" } } },
            { type: "m.room.encrypted", content: { algorithm: "m.megolm.v1.aes-sha2", "m.relates_to": { rel_type: "m.replace", event_id: "$x" } } },
            // 2026-10-23 (rooms encrypted by default): a poll vote / poll end / in-room verification step, encrypted
            { type: "m.room.encrypted", content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x", "m.relates_to": { rel_type: "m.reference", event_id: "$poll" } } },
            { type: "org.matrix.msc3381.poll.response", content: { "m.relates_to": { rel_type: "m.reference", event_id: "$poll" } } },
            { type: "org.matrix.msc3401.call.member", content: {} },
            { type: "m.room.member", membership: "join", user_is_target: false, content: { membership: "join" } },
            { type: "m.room.member", membership: "invite", user_is_target: false, content: { membership: "invite" } },
            { type: "m.room.member", membership: "invite", content: { membership: "invite" } },
            { type: "m.room.tombstone", content: { body: "upgraded" } },
        ];
        for (const over of cases) {
            const r = await fx.notify(note(sub, { ...fresh(), ...over }, { sound: "default", highlight: true }));
            assert.deepEqual([r.statusCode, r.body], [200, { rejected: [] }], JSON.stringify(over));
        }
        assert.equal(fx.fetchImpl.calls.length, 0);
    } finally { fx.cleanup(); }
});

test("other_app_ids_and_undeliverable_subscriptions_are_rejected_and_never_fetched", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        const bad = [
            "http://web.push.apple.com/x", "https://evil@fcm.googleapis.com.evil.com/x", "https://10.0.0.21:8008/_synapse/admin/v1/users",
            "https://127.0.0.1/x", "https://fcm.googleapis.com:8443/x", "https://example.com/x", "https://[::1]/x",
        ];
        const devices = [
            { app_id: "com.example.other", pushkey: "k-other", data: sub.data, tweaks: { sound: "default" } },
            ...bad.map((endpoint, i) => ({ app_id: PUSH.APP_ID, pushkey: `k-bad-${i}`, data: { ...sub.data, endpoint }, tweaks: { sound: "default" } })),
            { app_id: PUSH.APP_ID, pushkey: "k-nokeys", data: { endpoint: sub.endpoint }, tweaks: { sound: "default" } },
        ];
        assert.equal(devices.length, 9);
        const r = await fx.notify(note(sub, fresh({ devices })));
        assert.equal(r.statusCode, 200);
        assert.deepEqual(r.body.rejected, ["k-other", ...bad.map((_, i) => `k-bad-${i}`), "k-nokeys"]);
        assert.equal(fx.fetchImpl.calls.length, 0, "nothing off the allowlist is ever contacted");
    } finally { fx.cleanup(); }
});

test("at_most_10_devices_per_notification", async () => {
    const fx = setup();
    try {
        const subs = Array.from({ length: 12 }, (_, i) => subscription(`https://web.push.apple.com/d${i}`));
        const devices = subs.map((s) => ({ app_id: PUSH.APP_ID, pushkey: s.pushkey, data: s.data, tweaks: { sound: "default" } }));
        await fx.notify(note(subs[0], fresh({ devices })));
        assert.equal(fx.fetchImpl.calls.length, 10);
    } finally { fx.cleanup(); }
});

test("push_service_answers_reject_retry_or_log", async () => {
    const table = [[201, 200, []], [202, 200, []], [404, 200, "rej"], [410, 200, "rej"],
        [429, 502, null], [500, 502, null], [503, 502, null], [400, 200, []], [403, 200, []], [413, 200, []], [301, 200, []]];
    for (const [svc, toSynapse, rejected] of table) {
        const fx = setup({ status: () => svc });
        try {
            const sub = subscription();
            await fx.reg("ta", sub);
            const r = await fx.notify(note(sub, fresh()));
            assert.equal(r.statusCode, toSynapse, `push service ${svc}`);
            if (rejected === "rej") {
                assert.deepEqual(r.body.rejected, [sub.pushkey]);
                assert.equal(fx.p._regs.has(sub.pushkey), false, "registration dropped");
            } else if (rejected) assert.deepEqual(r.body, { rejected });
            if ([400, 403, 413, 301].includes(svc)) assert.equal(fx.errors.length, 1, `an error line for ${svc}`);
        } finally { fx.cleanup(); }
    }
    for (const err of [new TypeError("fetch failed")]) {
        const fx = setup({ status: () => err });
        try {
            const sub = subscription();
            assert.equal((await fx.notify(note(sub, fresh()))).statusCode, 502, "network error -> Synapse retries");
        } finally { fx.cleanup(); }
    }
    assert.equal(outcome({ status: 0, reason: "timeout" }), "retry");
    assert.equal(outcome({ status: 0, reason: "encrypt_failed" }), "error");
    assert.equal(outcome({ busy: true, status: 0 }), "retry");
});

test("a_timeout_is_a_retry", async () => {
    const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
    const fx = setup();
    try {
        const sub = subscription();
        const p = createPush({ auth: authFor(fx.hs, fx.now), hs: fx.hs, adminToken: "x", dir: fx.dir, fetchImpl: hang, log: () => {}, logError: () => {}, pushTimeoutMs: 50 });
        const keepAlive = setTimeout(() => {}, 5000);
        const r = await call(p.notify, { method: "POST", body: { notification: note(sub, fresh()) } });
        clearTimeout(keepAlive);
        assert.equal(r.statusCode, 502);
    } finally { fx.cleanup(); }
});

test("dedup_a_synapse_retry_never_alerts_twice", async () => {
    let flaky = 0;
    const fx = setup({ status: () => (++flaky === 2 ? 503 : 201) });
    try {
        const sub = subscription();
        const n = note(sub, fresh());
        assert.equal((await fx.notify(n)).statusCode, 200);
        assert.equal(fx.fetchImpl.calls.length, 1);
        assert.equal((await fx.notify(n)).statusCode, 200, "Synapse replays the same event (e.g. our 200 was lost)");
        assert.equal(fx.fetchImpl.calls.length, 1, "... and it is not sent again");
        // a failed delivery is NOT remembered: the retry goes through
        const n2 = note(sub, fresh());
        assert.equal((await fx.notify(n2)).statusCode, 502);
        assert.equal((await fx.notify(n2)).statusCode, 200);
        assert.equal(fx.fetchImpl.calls.length, 3);
        fx.now.advance(PUSH.DEDUP_MS + 1);
        await fx.notify(n);
        assert.equal(fx.fetchImpl.calls.length, 4, "15 min later it is a new alert");
    } finally { fx.cleanup(); }
});

test("malformed_and_oversized_gateway_bodies", async () => {
    const fx = setup();
    try {
        assert.equal((await call(fx.p.notify, { method: "POST", body: "{nope" })).statusCode, 400);
        assert.equal((await call(fx.p.notify, { method: "POST", body: { hello: 1 } })).statusCode, 400);
        const big = Buffer.from(JSON.stringify({ notification: { content: { body: "x".repeat(70_000) } } }));
        const r = await call(fx.p.notify, { method: "POST", body: big });
        assert.deepEqual([r.statusCode, r.body], [200, { rejected: [] }], "oversize: skipped (a retry can't help), never a backoff");
        const r2 = await call(fx.p.notify, { method: "POST", body: big, headers: { "content-length": "1" } });
        assert.deepEqual([r2.statusCode, r2.body], [200, { rejected: [] }], "a lying content-length is still capped while reading");
    } finally { fx.cleanup(); }
});

test("wording_rules", () => {
    const n = (over) => ({ event_id: "$e", room_id: GROUP, type: "m.room.message", sender: "@bob:example.org", sender_display_name: "Bob", room_name: "Room", content: {}, ...over });
    for (const [msgtype, text] of [["m.image", "sent a photo"], ["m.video", "sent a video"], ["m.file", "sent a file"], ["m.audio", "sent a voice message"]])
        assert.deepEqual(classify(n({ content: { msgtype, body: "IMG_0001.jpg" } })), { kind: "message", text });
    for (const msgtype of ["m.text", "m.notice", "m.emote"])
        assert.deepEqual(classify(n({ content: { msgtype, body: "waves" } })), { kind: "message", text: "waves" });
    assert.deepEqual(classify(n({ type: "m.room.encrypted", content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "…" } })), { kind: "message", text: "New message" });
    // an encrypted reply or thread message is a message; an encrypted reference (poll vote/end, verification) is not
    for (const rel of [{ "m.in_reply_to": { event_id: "$q" } }, { rel_type: "m.thread", event_id: "$root" }])
        assert.deepEqual(classify(n({ type: "m.room.encrypted", content: { ciphertext: "…", "m.relates_to": rel } })), { kind: "message", text: "New message" });
    assert.deepEqual(classify(n({ type: "m.room.encrypted", content: { ciphertext: "…", "m.relates_to": { rel_type: "m.reference", event_id: "$p" } } })), { skip: "relation" });
    // a plain message that references another one is still a message (only encrypted/other references are skipped)
    assert.deepEqual(classify(n({ content: { msgtype: "m.text", body: "see this", "m.relates_to": { rel_type: "m.reference", event_id: "$p" } } })), { kind: "message", text: "see this" });
    assert.deepEqual(classify(n({ type: "m.sticker", content: { body: "a cat" } })), { kind: "message", text: "a cat" });
    assert.equal(classify(n({ content: { msgtype: "m.text", body: "é".repeat(200) } })).text, "é".repeat(180) + "…");
    assert.equal(classify(n({ content: { msgtype: "m.text", body: "👋".repeat(181) } })).text, "👋".repeat(180) + "…", "cut by code point, never mid-surrogate");
    assert.equal(classify(n({ content: { msgtype: "m.text", body: " a\t\tb\n\n c " } })).text, "a b c");
    assert.equal(classify(n({ content: { msgtype: "m.text", body: "> <@a:b> quoted\n> more\n\nthe reply", "m.relates_to": { "m.in_reply_to": { event_id: "$q" } } } })).text, "the reply");
    assert.equal(classify(n({ content: { msgtype: "m.text", body: "> not a reply" } })).text, "> not a reply");
    // invites: only membership invite AND user_is_target true
    const inv = n({ type: "m.room.member", membership: "invite", user_is_target: true, content: { membership: "invite" }, room_name: "Game Night" });
    assert.deepEqual(classify(inv), { kind: "invite" });
    assert.deepEqual(word(inv, { kind: "invite" }, false), { title: "Tin Hat", body: "Bob invited you to Game Night" });
    assert.deepEqual(word({ ...inv, room_name: undefined }, { kind: "invite" }, false), { title: "Tin Hat", body: "Bob invited you to a chat" });
    assert.deepEqual(word({ ...inv, room_name: "Bob", content: { membership: "invite", is_direct: true } }, { kind: "invite" }, false),
        { title: "Tin Hat", body: "Bob invited you to a chat" }, "a DM invite's room_name is only the inviter's name");
    // missing names: "Someone" / "a chat"; DM vs group; control/bidi stripped
    assert.deepEqual(word(n({ sender_display_name: undefined }), { kind: "message", text: "hi" }, true), { title: "Someone", body: "hi" });
    assert.deepEqual(word(n({ room_name: undefined }), { kind: "message", text: "hi" }, false), { title: "a chat", body: "Bob: hi" });
    assert.deepEqual(word(n({ sender_display_name: "" , room_name: "" }), { kind: "message", text: "hi" }, false), { title: "a chat", body: "Someone: hi" });
    assert.equal(clean("A\u202eB\u0007C", 10), "A B C");
});

test("payload_never_exceeds_3kb", () => {
    const huge = "𝒳".repeat(5000);
    const buf = payloadBytes({ room: "!" + "r".repeat(250) + ":example.org", event: "$" + "e".repeat(250), kind: "message", title: huge, body: huge, unread: 99, user: "@" + "u".repeat(250) + ":example.org" });
    assert.ok(buf.length <= 3072, String(buf.length));
    const j = JSON.parse(buf.toString("utf8"));
    assert.equal(j.v, 1);
    assert.equal(j.room.length > 200, true, "room/event/user are never cut — title and body are");
    const cls = classify({ event_id: "$e", room_id: GROUP, type: "m.room.message", content: { body: "\\\"".repeat(2000) } });
    const w = word({ sender_display_name: "\"".repeat(500), room_name: "\\".repeat(500) }, cls, false);
    assert.ok(payloadBytes({ room: GROUP, event: "$e", kind: "message", ...w, unread: 1, user: A }).length <= 3072);
});

test("suppression_foreground_and_active_elsewhere_with_consent", async () => {
    const fx = setup();
    try {
        const phone = subscription("https://web.push.apple.com/phone");
        await fx.reg("ta", phone, true);
        const push = async () => { const before = fx.fetchImpl.calls.length; await fx.notify(note(phone, fresh())); return fx.fetchImpl.calls.length - before; };

        assert.equal(await push(), 1, "nobody active: pushed");
        // consent endpoint
        assert.deepEqual((await fx.q(fx.p.quietWanted, "ta", {})).body, { wanted: true });
        assert.deepEqual((await fx.q(fx.p.quietWanted, "tb", {})).body, { wanted: false });
        // 1. the phone's own page is in the foreground
        let r = await fx.api(fx.p.active, "ta", { pushkey: phone.pushkey, visible: true, instance: "phone1" });
        assert.deepEqual([r.statusCode, r.body], [200, { ok: true, ttl: 35, wanted: true }]);
        assert.equal(await push(), 0, "K itself foreground-active");
        await fx.api(fx.p.active, "ta", { pushkey: phone.pushkey, visible: false, instance: "phone1" });
        assert.equal(await push(), 1, "visible:false clears at once");
        // 2. the desktop app reports alice at a computer
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desk-a" });
        assert.equal(await push(), 0, "quietWhileActive + a computer active");
        fx.now.advance(35_001);
        assert.equal(await push(), 1, "35 s TTL");
        // instances: two app instances on one device; visible:false clears only its own
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desk-a" });
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desk-b" });
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: false, instance: "desk-a" });
        assert.equal(await push(), 0, "desk-b is still active");
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: false, instance: "desk-b" });
        assert.equal(await push(), 1);
        // 3. another user's activity never matters
        await fx.api(fx.p.active, "tb", { pushkey: null, visible: true, instance: "x" });
        assert.equal(await push(), 1);
        // 4. consent: with quietWhileActive off, "at a computer" isn't even kept
        await fx.reg("ta", phone, false);
        r = await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desk-a" });
        assert.deepEqual(r.body, { ok: true, ttl: 35, wanted: false });
        assert.equal([...fx.p._active.values()].filter((e) => e.mxid === A && e.pushkey === null).length, 0, "not stored without consent");
        assert.equal(await push(), 1, "quiet off: the computer doesn't hold the phone back");
        // pushkeys must be the caller's own registration
        r = await fx.api(fx.p.active, "tb", { pushkey: phone.pushkey, visible: true, instance: "x" });
        assert.deepEqual([r.statusCode, r.body.error], [403, "not_owner"]);
        r = await fx.api(fx.p.active, "ta", { pushkey: "unknown-key", visible: true, instance: "x" });
        assert.deepEqual([r.statusCode, r.body.error], [403, "not_owner"], "an unregistered pushkey isn't the caller's");
        assert.equal((await fx.api(fx.p.active, "ta", { pushkey: phone.pushkey, instance: "x" })).statusCode, 400, "visible is required");
        assert.equal((await fx.api(fx.p.active, "ta", { pushkey: null, visible: true, instance: "bad id!" })).statusCode, 400);
    } finally { fx.cleanup(); }
});

test("test_endpoint_own_registration_only_and_rate_limited", async () => {
    const fx = setup();
    try {
        const sub = subscription("https://fcm.googleapis.com/fcm/send/abc");
        await fx.reg("ta", sub);
        assert.equal((await call(fx.p.test, { method: "POST", body: { pushkey: sub.pushkey } })).statusCode, 401);
        let r = await fx.api(fx.p.test, "tb", { pushkey: sub.pushkey });
        assert.deepEqual([r.statusCode, r.body.error], [403, "not_owner"]);
        r = await fx.api(fx.p.test, "ta", { pushkey: "nope" });
        assert.deepEqual([r.statusCode, r.body.error], [404, "not_registered"]);
        assert.equal(fx.fetchImpl.calls.length, 0);
        r = await fx.api(fx.p.test, "ta", { pushkey: sub.pushkey, endpoint: "https://evil.example/ignored" });
        assert.deepEqual([r.statusCode, r.body], [200, { ok: true, status: 201 }]);
        assert.equal(sent(fx).url, sub.endpoint, "sent to the REGISTERED subscription, never to a body-supplied endpoint");
        assert.deepEqual(open(sub, sent(fx)), { v: 1, room: "", event: "", kind: "message", title: "Tin Hat", body: "Notifications work on this device.", unread: null, user: A });
        r = await fx.api(fx.p.test, "ta", { pushkey: sub.pushkey });
        assert.equal(r.statusCode, 429, "1 per 10 s per user");
        assert.ok(r.body.retry_after >= 1);
        fx.now.advance(10_000);
        r = await fx.api(fx.p.test, "ta", { pushkey: sub.pushkey });
        assert.equal(r.statusCode, 200, "10 s later: allowed again");
    } finally { fx.cleanup(); }
    const gone = setup({ status: () => 410 });
    try {
        const sub = subscription();
        await gone.reg("ta", sub);
        const r = await gone.api(gone.p.test, "ta", { pushkey: sub.pushkey });
        assert.deepEqual([r.statusCode, r.body.ok, r.body.status, r.body.gone], [502, false, 410, true]);
        assert.equal(gone.p._regs.has(sub.pushkey), false, "a gone subscription is dropped");
    } finally { gone.cleanup(); }
});

test("concurrency_is_capped", async () => {
    let inFlight = 0, peak = 0;
    const fx = setup();
    try {
        const slow = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return new Response(null, { status: 201 }); };
        const p = createPush({ auth: authFor(fx.hs, fx.now), hs: fx.hs, adminToken: "x", dir: fx.dir, fetchImpl: slow, now: fx.now, log: () => {}, logError: () => {} });
        const subs = Array.from({ length: 10 }, (_, i) => subscription(`https://web.push.apple.com/s${i}`));
        const devices = subs.map((s) => ({ app_id: PUSH.APP_ID, pushkey: s.pushkey, data: s.data, tweaks: { sound: "default" } }));
        const rs = await Promise.all([0, 1, 2].map(() => call(p.notify, { method: "POST", body: { notification: note(subs[0], fresh({ devices })) } })));
        for (const r of rs) assert.equal(r.statusCode, 200);
        assert.equal(peak, PUSH.CONCURRENCY);
    } finally { fx.cleanup(); }
});

test("gateway_listener_serves_only_the_notify_path", async () => {
    const fx = setup();
    const server = startGatewayServer(fx.p, { host: "127.0.0.1", port: 0, log: () => {} });
    try {
        await new Promise((r) => server.once("listening", r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const sub = subscription();
        let r = await fetch(`${base}/_matrix/push/v1/notify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notification: note(sub, fresh()) }) });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { rejected: [] });
        assert.equal(r.headers.get("cache-control"), "no-store");
        for (const [method, path] of [["GET", "/_matrix/push/v1/notify"], ["POST", "/push/register"], ["POST", "/presence"], ["POST", "/_matrix/push/v1/notify/x"], ["POST", "/"]]) {
            r = await fetch(base + path, { method, body: method === "POST" ? "{}" : undefined });
            assert.equal(r.status, 404, `${method} ${path}`);
            await r.text();
        }
    } finally { server.close(); fx.cleanup(); }
});

test("log_lines_carry_no_content_endpoint_or_whole_pushkey", async () => {
    const fx = setup({ status: () => 410 });
    try {
        const sub = subscription("https://web.push.apple.com/SECRET-TOKEN-PART");
        await fx.notify(note(sub, fresh({ content: { msgtype: "m.text", body: "my secret plans" }, sender_display_name: "Bobby", room_name: "Hideout" })));
        await fx.notify(note(sub, fresh({ devices: [{ app_id: "evil\napp", pushkey: "x".repeat(40), data: {}, tweaks: {} }] })));
        fx.p.report();
        const all = fx.logs.join("\n");
        assert.ok(fx.logs.some((l) => /^\[push\] dev\.tinhat\.web web\.push\.apple\.com 410 BadDeviceToken \d+(\.\d+)?ms k=\S{6} -> rejected$/.test(l)), all);
        for (const secret of ["SECRET-TOKEN-PART", "my secret plans", "Bobby", "Hideout", sub.pushkey, sub.data.p256dh, sub.data.auth, "x".repeat(7), "\napp", A])
            assert.ok(!all.includes(secret), `log leaked ${secret}`);
    } finally { fx.cleanup(); }
});

test("real_synapse_fixtures_invite_encrypted_dm_group_mention_count_only", async () => {
    const fx = JSON.parse(readFileSync(new URL("./fixtures/synapse-notify.json", import.meta.url), "utf8"));
    const env = setup();
    try {
        const sub = subscription("https://web.push.apple.com/fixture");
        await env.reg("ta", sub);
        const fill = (f) => {
            const n = structuredClone(f.notification);
            for (const d of n.devices) { d.pushkey = sub.pushkey; d.data = sub.data; }
            return n;
        };
        env.hs.state.members[fx.encrypted_dm.notification.room_id] = 2;   // the DM: test1 + test2
        env.hs.state.members[fx.mention.notification.room_id] = 4;        // Test Room
        const results = {};
        for (const name of ["invite", "encrypted_dm", "group_message", "mention", "count_only"]) {
            const before = env.fetchImpl.calls.length;
            const r = await env.notify(fill(fx[name]));
            assert.deepEqual([r.statusCode, r.body], [200, { rejected: [] }], name);
            results[name] = env.fetchImpl.calls.length > before ? open(sub, env.fetchImpl.calls[before]) : null;
        }
        assert.deepEqual(results.invite, { v: 1, room: fx.invite.notification.room_id, event: fx.invite.notification.event_id,
            kind: "invite", title: "Tin Hat", body: "alice invited you to a chat", unread: null, user: A });
        assert.deepEqual([results.encrypted_dm.kind, results.encrypted_dm.title, results.encrypted_dm.body], ["message", "alice", "New message"]);
        assert.equal(results.group_message, null, "plain group chatter (highlight false, no sound): no push");
        assert.deepEqual([results.mention.title, results.mention.body], ["Test Room", "alice: bob: Reach server test, mention fixture (please ignore)"]);
        assert.equal(results.count_only, null, "count-only: no push (iOS allows no silent push)");
    } finally { env.cleanup(); }
});

test("a5_9_call_key_sized_encrypted_events_are_dropped_outside_dms", async () => {
    const fx = setup();
    try {
        const sub = subscription();
        const key = (room, len = 403) => note(sub, fresh({ room_id: room, type: "m.room.encrypted",
            content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "A".repeat(len), device_id: "D", sender_key: "k", session_id: "s" } }));
        assert.equal(isCallKeySized(key(GROUP)), true);
        assert.equal(isCallKeySized(key(GROUP, 404)), false);
        let r = await fx.notify(key(GROUP));
        assert.deepEqual([r.statusCode, r.body, fx.fetchImpl.calls.length], [200, { rejected: [] }, 0], "group room: dropped");
        await fx.notify(key(GROUP, 404));
        assert.equal(fx.fetchImpl.calls.length, 1, "any other length in a group: still 'New message'");
        await fx.notify(key(DM));
        assert.equal(fx.fetchImpl.calls.length, 2, "a DM keeps it (a real DM message may have that length)");
        await fx.notify(key("!unknown:example.org"));
        assert.equal(fx.fetchImpl.calls.length, 3, "room size unknown (lookup failed): never a reason to drop");
        fx.p.report();
        const line = fx.logs.find((l) => l.includes("last period"));
        assert.match(line, /call_key 1/, "drops are logged as a count only");
        assert.ok(!fx.logs.some((l) => l.includes("A".repeat(20))), "no ciphertext in logs");
    } finally { fx.cleanup(); }
});

// ── Astra review 2026-09-25 (reach-server-astra.md) ──────────────────────────────────────────────────────────────

test("f2_a_pushkey_must_be_the_hash_of_the_endpoint_it_arrives_with", async () => {
    const fx = setup();
    try {
        const victim = subscription("https://web.push.apple.com/victim");
        await fx.reg("ta", victim, true);
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desk" }); // victim at a computer
        const attacker = subscription("https://updates.push.services.mozilla.com/wpush/v2/attacker");
        // the attacker's own pusher, carrying the victim's pushkey (Synapse forwards pusher pushkey + data as set)
        const n = note(attacker, fresh({ devices: [{ app_id: PUSH.APP_ID, pushkey: victim.pushkey, data: attacker.data, tweaks: { sound: "default" } }] }));
        let r = await fx.notify(n);
        assert.deepEqual([r.statusCode, r.body], [200, { rejected: [victim.pushkey] }], "rejected: Synapse removes that pusher");
        assert.equal(fx.fetchImpl.calls.length, 0, "nothing sent: no victim mxid, no delivered-vs-suppressed signal");
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: false, instance: "desk" });
        r = await fx.notify(n);
        assert.deepEqual(r.body, { rejected: [victim.pushkey] }, "same answer whatever the victim is doing");
        assert.ok(fx.logs.some((l) => l.includes("rejected:pushkey_mismatch")));
        assert.equal(fx.p._regs.get(victim.pushkey).mxid, A, "the victim's registration is untouched");
        // the real pusher still works
        r = await fx.notify(note(victim, fresh()));
        assert.deepEqual([r.body, fx.fetchImpl.calls.length], [{ rejected: [] }, 1]);
        assert.equal(open(victim, sent(fx)).user, A);
    } finally { fx.cleanup(); }
});

function failingFs(state) {
    return {
        writeFileSync: (...a) => { if (state.fail) { const e = new Error("ENOSPC: no space left on device"); e.code = "ENOSPC"; throw e; } return writeFileSync(...a); },
    };
}

test("f5_registration_changes_are_acknowledged_only_once_they_are_on_disk", async () => {
    const fx = setup();
    try {
        const state = { fail: false };
        const vapid = loadOrCreateVapid(join(fx.dir, "vapid.json"));
        const mk = () => createPush({ auth: authFor(fx.hs, fx.now), hs: fx.hs, adminToken: "x", dir: fx.dir, vapid, fetchImpl: fx.fetchImpl,
            now: fx.now, log: () => {}, logError: (s) => fx.errors.push(s), fsImpl: failingFs(state) });
        let p = mk();
        const sub = subscription();
        const reg = (q = true) => call(p.register, { method: "POST", headers: bearer("ta"), body: { ...sub.data, quietWhileActive: q } });
        const unreg = () => call(p.unregister, { method: "DELETE", headers: bearer("ta"), query: { pushkey: sub.pushkey } });
        state.fail = true;
        let r = await reg();
        assert.deepEqual([r.statusCode, r.body.error], [503, "could not save the registration, try again"]);
        assert.equal(p._regs.has(sub.pushkey), false, "nothing registered in memory either");
        state.fail = false;
        assert.equal((await reg()).statusCode, 200);
        state.fail = true;
        r = await unreg();
        assert.equal(r.statusCode, 503, "a deletion that did not reach the disk is not a 204");
        assert.equal(p._regs.has(sub.pushkey), true);
        p = mk();
        assert.equal(p._regs.has(sub.pushkey), true, "after a restart it is (still, honestly) there");
        state.fail = false;
        assert.equal((await unreg()).statusCode, 204, "the retry writes");
        p = mk();
        assert.equal(p._regs.has(sub.pushkey), false, "and a restart agrees");
        assert.ok(fx.errors.some((l) => /ENOSPC/.test(l)), "failures are logged");
    } finally { fx.cleanup(); }
});

test("f6_concurrent_copies_of_a_notification_share_one_delivery", async () => {
    let gate;
    const fx = setup({ status: () => 201 });
    try {
        const slow = async (url, init) => { await gate; fx.fetchImpl.calls.push({ url, init }); return new Response(null, { status: 201 }); };
        const p = createPush({ auth: authFor(fx.hs, fx.now), hs: fx.hs, adminToken: "x", dir: fx.dir, fetchImpl: slow, now: fx.now, log: () => {}, logError: () => {} });
        const sub = subscription();
        const n = note(sub, fresh());
        let open_; gate = new Promise((r) => { open_ = r; });
        const both = [call(p.notify, { method: "POST", body: { notification: n } }), call(p.notify, { method: "POST", body: { notification: n } })];
        const twice = call(p.notify, { method: "POST", body: { notification: { ...n, devices: [n.devices[0], n.devices[0]] } } });
        await new Promise((r) => setImmediate(r));
        open_();
        for (const r of [...(await Promise.all(both)), await twice]) assert.deepEqual([r.statusCode, r.body], [200, { rejected: [] }]);
        assert.equal(fx.fetchImpl.calls.length, 1, "one send for two overlapping copies + a duplicate device entry");
    } finally { fx.cleanup(); }
});

test("f6_a_failed_delivery_is_shared_then_released_so_the_retry_sends", async () => {
    let gate, status = 503;
    const fx = setup();
    try {
        let sends = 0;
        const slow = async () => { await gate; sends++; return new Response(null, { status }); };
        const p = createPush({ auth: authFor(fx.hs, fx.now), hs: fx.hs, adminToken: "x", dir: fx.dir, fetchImpl: slow, now: fx.now, log: () => {}, logError: () => {} });
        const sub = subscription();
        const n = note(sub, fresh());
        let open_; gate = new Promise((r) => { open_ = r; });
        const both = [call(p.notify, { method: "POST", body: { notification: n } }), call(p.notify, { method: "POST", body: { notification: n } })];
        await new Promise((r) => setImmediate(r));
        open_();
        for (const r of await Promise.all(both)) assert.equal(r.statusCode, 502, "both learn it must be retried");
        assert.equal(sends, 1);
        status = 201;
        assert.equal((await call(p.notify, { method: "POST", body: { notification: n } })).statusCode, 200);
        assert.equal(sends, 2, "the reservation was released: Synapse's retry is delivered");
        assert.equal((await call(p.notify, { method: "POST", body: { notification: n } })).statusCode, 200);
        assert.equal(sends, 2, "and a success is remembered");
    } finally { fx.cleanup(); }
});

test("f7_the_send_gate_never_exceeds_its_slots", async () => {
    for (const max of [1, 2, 8]) {
        const gate = new Gate(max, 1000);
        let running = 0, peak = 0;
        const job = async () => { running++; peak = Math.max(peak, running); for (let i = 0; i < 3; i++) await Promise.resolve(); running--; };
        const all = [];
        for (let i = 0; i < 60; i++) {
            let p = Promise.resolve();
            for (let d = 0; d < i % 7; d++) p = p.then(() => {}); // callers arrive at every microtask depth
            all.push(p.then(() => gate.run(job)));
        }
        await Promise.all(all);
        assert.equal(peak, max, `max ${max}: peak ${peak}`);
        assert.equal(gate.active, 0);
        assert.equal(gate.q.length, 0);
    }
    const g = new Gate(1, 1);
    const hold = g.run(() => new Promise((r) => setTimeout(r, 20)));
    const waiting = g.run(async () => "second");
    assert.deepEqual(await g.run(async () => "third"), { busy: true }, "queue full: busy");
    await hold;
    assert.equal(await waiting, "second");
});

test("f8_losing_the_last_quiet_registration_drops_computer_activity_at_once", async () => {
    const fx = setup({ status: () => 410 });
    try {
        const nulls = () => [...fx.p._active.values()].filter((e) => e.mxid === A && e.pushkey === null).length;
        const ping = () => fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desk" });
        const phone = subscription("https://web.push.apple.com/phone-f8");
        // unregister
        await fx.reg("ta", phone, true); await ping(); assert.equal(nulls(), 1);
        await call(fx.p.unregister, { method: "DELETE", headers: bearer("ta"), query: { pushkey: phone.pushkey } });
        assert.equal(nulls(), 0, "unregister");
        // preference switched to false
        await fx.reg("ta", phone, true); await ping(); assert.equal(nulls(), 1);
        await fx.reg("ta", phone, false);
        assert.equal(nulls(), 0, "quietWhileActive -> false");
        // eviction of the only quiet registration by the 10-per-user cap
        await fx.reg("ta", phone, true); await ping(); assert.equal(nulls(), 1);
        for (let i = 0; i < 10; i++) { fx.now.advance(1); await fx.reg("ta", subscription(`https://fcm.googleapis.com/fcm/send/e${i}`), false); }
        assert.equal(fx.p._regs.has(phone.pushkey), false);
        assert.equal(nulls(), 0, "evicted");
        // a gone subscription (push service 410). The gateway would hold this push back (the computer is active),
        // so the test endpoint — which always sends — hits the 410.
        await fx.reg("ta", phone, true); await ping(); assert.equal(nulls(), 1);
        const r = await fx.api(fx.p.test, "ta", { pushkey: phone.pushkey });
        assert.deepEqual([r.statusCode, r.body.gone], [502, true]);
        assert.equal(fx.p._regs.has(phone.pushkey), false);
        assert.equal(nulls(), 0, "gone");
    } finally { fx.cleanup(); }
});

// ── A6.1 (2026-09-25): cross-device quieting counts only user-level "at a computer" activity ─────────────────────

function a61() {
    const fx = setup();
    const phone = subscription("https://web.push.apple.com/a61-phone");       // K
    const tab = subscription("https://fcm.googleapis.com/fcm/send/a61-desk");  // another device of the same user, push on
    const push = async () => { const before = fx.fetchImpl.calls.length; await fx.notify(note(phone, fresh(), { highlight: true })); return fx.fetchImpl.calls.length - before; };
    return { fx, phone, tab, push };
}

test("a6_1_another_devices_own_foreground_report_never_quiets_k", async () => {
    const { fx, phone, tab, push } = a61();
    try {
        await fx.reg("ta", phone, true);
        await fx.reg("ta2", tab, false);
        // the desktop tab is on screen (idle or not) and reports ITS OWN pushkey — A6: sent whenever it is visible
        const r = await fx.api(fx.p.active, "ta2", { pushkey: tab.pushkey, visible: true, instance: "desk-tab" });
        assert.deepEqual([r.statusCode, r.body.ok], [200, true]);
        assert.equal(await push(), 1, "the phone still buzzes: an own-pushkey report only ever holds that pushkey");
        await fx.reg("ta2", tab, true);
        assert.equal(await push(), 1, "whatever the tab's own quiet preference");
    } finally { fx.cleanup(); }
});

test("a6_1_at_a_computer_quiets_k_only_when_k_is_quiet", async () => {
    const { fx, phone, push } = a61();
    try {
        await fx.reg("ta", phone, true);
        const r = await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desktop-app" });
        assert.deepEqual(r.body, { ok: true, ttl: 35, wanted: true });
        assert.equal(await push(), 0, "user-level 'at a computer' + K quietWhileActive: held back");
        await fx.reg("ta", phone, false);
        await fx.api(fx.p.active, "ta2", { pushkey: null, visible: true, instance: "desktop-app" });
        assert.equal(await push(), 1, "K not quiet: the computer never holds it");
    } finally { fx.cleanup(); }
});

test("a6_1_k_own_foreground_report_quiets_k", async () => {
    const { fx, phone, push } = a61();
    try {
        await fx.reg("ta", phone, false);                  // no quiet consent needed for a device's own report (A6)
        const r = await fx.api(fx.p.active, "ta", { pushkey: phone.pushkey, visible: true, instance: "phone-page" });
        assert.deepEqual(r.body, { ok: true, ttl: 35, wanted: false });
        assert.equal(await push(), 0, "K's own page is on screen: K is held back");
        await fx.api(fx.p.active, "ta", { pushkey: phone.pushkey, visible: false, instance: "phone-page" });
        assert.equal(await push(), 1);
    } finally { fx.cleanup(); }
});
