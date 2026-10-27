// webpush.mjs — RFC 8291 encryption (the §5 worked example, byte for byte), round trips, RFC 8292 VAPID JWTs,
// the endpoint allowlist (SSRF guard) and the sender's request shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, statSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    b64u, fromB64u, checkEndpoint, checkRelayEndpoint, relayOrigin, parseSubscription, encrypt, decrypt, vapidJwt, verifyVapidJwt,
    loadOrCreateVapid, sendWebPush, pushkeyFor, JWT_TTL_SEC,
} from "../webpush.mjs";

// RFC 8291 §5 + Appendix A.
const RFC = {
    plaintext: "When I grow up, I want to be a watermelon",
    authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
    uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
          "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
          "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    header86: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
              "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
};

test("rfc8291_section5_exact_ciphertext", () => {
    const out = encrypt(Buffer.from(RFC.plaintext), fromB64u(RFC.uaPublic), fromB64u(RFC.authSecret), {
        salt: fromB64u(RFC.salt), asPrivate: fromB64u(RFC.asPrivate),
    });
    assert.equal(b64u(out), RFC.body);
    // 86-byte header + 41-byte message + 0x02 + 16-byte tag = 144 (the RFC's "Content-Length: 145" is off by one;
    // its own base64url body decodes to 144 bytes)
    assert.equal(out.length, 144);
    assert.equal(b64u(out.subarray(0, 86)), RFC.header86);
});

test("rfc8291_section5_decrypts_with_the_receiver_key", () => {
    const pt = decrypt(fromB64u(RFC.body), fromB64u(RFC.uaPrivate), fromB64u(RFC.authSecret));
    assert.equal(pt.toString("utf8"), RFC.plaintext);
});

test("round_trip_random_keys_header_shape", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const msg = Buffer.from(JSON.stringify({ v: 1, title: "Tin Hat", body: "héllo 👋" }));
    const body = encrypt(msg, ua.getPublicKey(), auth);
    assert.equal(body.readUInt32BE(16), 4096, "rs 4096");
    assert.equal(body[20], 65, "idlen = uncompressed P-256 key");
    assert.equal(body[21], 0x04);
    assert.equal(body.length, 86 + msg.length + 1 + 16, "one record: payload + 0x02 delimiter + tag, no padding");
    assert.deepEqual(decrypt(body, ua.getPrivateKey(), auth), msg);
    // fresh salt + ephemeral key every time
    assert.notDeepEqual(encrypt(msg, ua.getPublicKey(), auth).subarray(0, 86), body.subarray(0, 86));
    // wrong auth secret -> the tag fails
    assert.throws(() => decrypt(body, ua.getPrivateKey(), randomBytes(16)));
});

test("payload_larger_than_one_record_is_refused", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    assert.throws(() => encrypt(Buffer.alloc(4096 - 16), ua.getPublicKey(), randomBytes(16)), /single record/);
    assert.doesNotThrow(() => encrypt(Buffer.alloc(4096 - 17), ua.getPublicKey(), randomBytes(16)));
});

function tmp() { return mkdtempSync(join(tmpdir(), "reach-vapid-")); }

test("vapid_keypair_created_once_0600_and_stable", () => {
    const dir = tmp();
    try {
        const path = join(dir, "vapid.json");
        const logs = [];
        const a = loadOrCreateVapid(path, (m) => logs.push(m));
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(fromB64u(a.publicKey).length, 65);
        assert.equal(fromB64u(a.publicKey)[0], 0x04);
        const b = loadOrCreateVapid(path);
        assert.equal(b.publicKey, a.publicKey, "loaded, not regenerated");
        assert.equal(logs.length, 1);
        // a too-open file is tightened
        chmodSync(path, 0o644);
        loadOrCreateVapid(path, () => {});
        assert.equal(statSync(path).mode & 0o777, 0o600);
        // a mismatched pair is refused
        const doc = JSON.parse(readFileSync(path, "utf8"));
        const other = loadOrCreateVapid(join(dir, "other.json"));
        writeFileSync(path, JSON.stringify({ ...doc, publicKey: other.publicKey }), { mode: 0o600 });
        assert.throws(() => loadOrCreateVapid(path), /does not match/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vapid_jwt_es256_verifies_with_the_public_key", () => {
    const dir = tmp();
    try {
        const v = loadOrCreateVapid(join(dir, "vapid.json"));
        const nowSec = 1_760_000_000;
        const jwt = vapidJwt({ audience: "https://web.push.apple.com", subject: "mailto:postmaster@example.org", privateKey: v.privateKey, nowSec });
        const [h, , s] = jwt.split(".");
        assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
        assert.equal(fromB64u(s).length, 64, "ieee-p1363 r||s, not DER");
        const claims = verifyVapidJwt(jwt, v.publicKey);
        assert.deepEqual(claims, { aud: "https://web.push.apple.com", exp: nowSec + 3600, sub: "mailto:postmaster@example.org" });
        assert.equal(JWT_TTL_SEC, 3600, "1 h: a captured header replays for an hour at most");
        assert.ok(JWT_TTL_SEC <= 24 * 3600, "RFC 8292: exp no more than 24 h ahead");
        assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "sub"], "standard claims only (the relay reads exp)");
        assert.ok(Number.isInteger(claims.exp), "exp is NumericDate seconds");
        // tampered claims / another key -> rejected
        const forged = jwt.split(".");
        forged[1] = b64u(JSON.stringify({ aud: "https://evil.example", exp: nowSec + 60, sub: "mailto:x@y" }));
        assert.equal(verifyVapidJwt(forged.join("."), v.publicKey), null);
        const other = loadOrCreateVapid(join(dir, "other.json"));
        assert.equal(verifyVapidJwt(jwt, other.publicKey), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rfc8292_example_token_verifies", () => {
    // RFC 8292 §2.4 Figure 1: t= and k= from the example request (signature by the RFC authors' key).
    const t = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
    const k = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
    assert.deepEqual(verifyVapidJwt(t, k), { aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" });
});

test("allowlist_accepts_the_push_services", () => {
    for (const u of [
        "https://web.push.apple.com/QGuQyavXutnMH-Xs8b4BO3yjs9YlLRHY1vXj7EvENlLNYzXIvSbhhgemGQVE8jGEUbJ9Xj5pYVL4P8nqeH7OSMmAhz",
        "https://api.push.apple.com/x",
        "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b",
        "https://android.googleapis.com/gcm/send/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA",
        "https://push.services.mozilla.com.push.services.mozilla.com/x",
        "https://db5p.notify.windows.com/w/?token=BQYAAA",
        "https://FCM.GoogleAPIs.com/fcm/send/x",
        "https://fcm.googleapis.com:443/fcm/send/x",
    ]) {
        const r = checkEndpoint(u);
        assert.equal(r.ok, true, u);
    }
    assert.equal(checkEndpoint("https://FCM.GoogleAPIs.com/a").url.href, "https://fcm.googleapis.com/a", "normalised href is what gets fetched");
});

test("allowlist_refuses_everything_else_including_tricks", () => {
    const cases = {
        "http://fcm.googleapis.com/fcm/send/x": "not_https",
        "https://evil@fcm.googleapis.com.evil.com/x": "userinfo",
        "https://fcm.googleapis.com@evil.com/x": "userinfo",
        "https://user:pw@fcm.googleapis.com/x": "userinfo",
        "https://fcm.googleapis.com.evil.com/x": "host_not_allowed",
        "https://fcm.googleapis.com%2eevil.com/x": "host_not_allowed",
        "https://evilgoogleapis.com/x": "host_not_allowed",
        "https://googleapis.com/x": "host_not_allowed",
        "https://push.apple.com/x": "host_not_allowed",
        "https://notify.windows.com/x": "host_not_allowed",
        "https://services.mozilla.com/x": "host_not_allowed",
        "https://fcm.googleapis.com./x": "host_not_allowed",
        "https://evil.com#.googleapis.com": "host_not_allowed",
        "https://evil.com?x=.googleapis.com": "host_not_allowed",
        "https://evil.com\\.googleapis.com/x": "host_not_allowed",
        "https://fcm.googleapis.com:8443/x": "port",
        "https://fcm.googleapis.com:80/x": "port",
        "https://127.0.0.1/x": "ip_literal",
        "https://2130706433/x": "ip_literal",
        "https://0x7f.1/x": "ip_literal",
        "https://[::1]/x": "ip_literal",
        "https://[::ffff:10.0.0.21]/x": "ip_literal",
        "https://10.0.0.21:8008/_synapse/admin/v1/users": "port",
        "https://localhost/x": "host_not_allowed",
        "file:///etc/passwd": "not_https",
        "javascript:alert(1)": "not_https",
        "wss://updates.push.services.mozilla.com/": "not_https",
        "": "bad_endpoint",
        "not a url": "bad_endpoint",
    };
    for (const [u, why] of Object.entries(cases)) assert.deepEqual(checkEndpoint(u), { ok: false, reason: why }, u);
    for (const v of [null, undefined, 42, {}, ["https://fcm.googleapis.com/x"], "https://fcm.googleapis.com/" + "a".repeat(2100)])
        assert.equal(checkEndpoint(v).ok, false);
});

test("subscription_keys_are_validated", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const good = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) };
    assert.equal(parseSubscription(good).ok, true);
    // browsers sometimes hand out padded / standard base64
    assert.equal(parseSubscription({ ...good, p256dh: ua.getPublicKey().toString("base64") }).ok, true);
    const offCurve = Buffer.concat([Buffer.from([4]), randomBytes(64)]);
    assert.equal(parseSubscription({ ...good, p256dh: b64u(offCurve) }).reason, "bad_p256dh");
    assert.equal(parseSubscription({ ...good, p256dh: b64u(ua.getPublicKey("buffer", "compressed")) }).reason, "bad_p256dh");
    assert.equal(parseSubscription({ ...good, p256dh: "!!" }).reason, "bad_p256dh");
    assert.equal(parseSubscription({ ...good, auth: b64u(randomBytes(12)) }).reason, "bad_auth");
    assert.equal(parseSubscription({ ...good, endpoint: "https://evil.example/x" }).reason, "host_not_allowed");
    assert.equal(parseSubscription(null).ok, false);
});

test("sender_request_shape_and_decryptable_body", async () => {
    const dir = tmp();
    try {
        const v = loadOrCreateVapid(join(dir, "vapid.json"));
        const ua = createECDH("prime256v1");
        ua.generateKeys();
        const auth = randomBytes(16);
        const sub = parseSubscription({ endpoint: "https://Updates.Push.Services.Mozilla.com/wpush/v2/abc", p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) });
        const seen = [];
        const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(null, { status: 201 }); };
        const payload = Buffer.from('{"v":1,"title":"Tin Hat"}');
        const r = await sendWebPush({ sub, payload, vapid: v, subject: "mailto:postmaster@example.org", ttl: 3600, urgency: "high", topic: "abc", fetchImpl, now: () => 5, wallNow: () => 1_760_000_000_000 });
        assert.equal(r.status, 201);
        assert.equal(seen.length, 1);
        const { url, init } = seen[0];
        assert.equal(url, "https://updates.push.services.mozilla.com/wpush/v2/abc");
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "manual", "never follow a redirect off the allowlist");
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.headers.TTL, "3600");
        assert.equal(init.headers.Urgency, "high");
        assert.equal(init.headers.Topic, "abc");
        assert.equal(init.headers["Content-Encoding"], "aes128gcm");
        const m = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
        assert.ok(m, init.headers.Authorization);
        assert.equal(m[2], v.publicKey);
        assert.deepEqual(verifyVapidJwt(m[1], v.publicKey), { aud: "https://updates.push.services.mozilla.com", exp: 1_760_000_000 + 3600, sub: "mailto:postmaster@example.org" });
        assert.deepEqual(decrypt(init.body, ua.getPrivateKey(), auth), payload);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("vapid_jwt_is_fresh_per_send_and_expires_within_an_hour", async () => {
    // Nothing caches a JWT: two sends an hour apart each carry their own exp = that send's wall time + 1 h, so no
    // header ever goes out that is already expired or valid for longer than an hour (security review 2026-10-26).
    const dir = tmp();
    try {
        const v = loadOrCreateVapid(join(dir, "vapid.json"));
        const ua = createECDH("prime256v1");
        ua.generateKeys();
        const sub = parseSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) });
        assert.equal(sub.ok, true);
        const exps = [];
        const fetchImpl = async (_url, init) => {
            const m = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
            exps.push(verifyVapidJwt(m[1], v.publicKey).exp);
            return new Response(null, { status: 201 });
        };
        let wall = 1_760_000_000_000;
        for (let i = 0; i < 2; i++) {
            const r = await sendWebPush({ sub, payload: Buffer.from("{}"), vapid: v, subject: "mailto:a@b", fetchImpl, wallNow: () => wall });
            assert.equal(r.status, 201);
            wall += 3600_000;
        }
        assert.deepEqual(exps, [1_760_000_000 + 3600, 1_760_003_600 + 3600]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sender_timeouts_and_errors_never_throw", async () => {
    const dir = tmp();
    try {
        const v = loadOrCreateVapid(join(dir, "vapid.json"));
        const ua = createECDH("prime256v1");
        ua.generateKeys();
        const sub = parseSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) });
        const hang = (_url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
        const t0 = Date.now();
        // AbortSignal.timeout() timers are unref'd: keep this test process alive until it fires (the server is).
        const keepAlive = setTimeout(() => {}, 5000);
        const r = await sendWebPush({ sub, payload: Buffer.from("{}"), vapid: v, subject: "mailto:a@b", fetchImpl: hang, timeoutMs: 80 });
        clearTimeout(keepAlive);
        assert.deepEqual([r.status, r.reason], [0, "timeout"]);
        assert.ok(Date.now() - t0 < 2000);
        const boom = async () => { throw new TypeError("fetch failed"); };
        const r2 = await sendWebPush({ sub, payload: Buffer.from("{}"), vapid: v, subject: "mailto:a@b", fetchImpl: boom });
        assert.deepEqual([r2.status, r2.reason], [0, "network"]);
        const gone = async () => new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
        const r3 = await sendWebPush({ sub, payload: Buffer.from("{}"), vapid: v, subject: "mailto:a@b", fetchImpl: gone });
        assert.deepEqual([r3.status, r3.reason], [410, "Unregistered"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pushkey_is_base64url_sha256_of_the_endpoint", () => {
    // sha256("abc") = ba7816bf…f20015ad (FIPS 180-2 vector)
    assert.equal(pushkeyFor("abc"), Buffer.from("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "hex").toString("base64url"));
    assert.equal(pushkeyFor("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});

test("allowlist_accepts_jmt17_google_com_exactly", () => {
    // what Chromium builds without Google API keys hand out
    assert.equal(checkEndpoint("https://jmt17.google.com/fcm/send/dGVzdA:APA91b").ok, true);
    assert.equal(checkEndpoint("https://jmt17.google.com:443/fcm/send/x").ok, true, "the default port is the same URL");
    for (const [u, why] of Object.entries({
        "https://jmt18.google.com/fcm/send/x": "host_not_allowed",
        "https://x.jmt17.google.com/fcm/send/x": "host_not_allowed",
        "https://jmt17.google.com.evil.com/fcm/send/x": "host_not_allowed",
        "https://google.com/fcm/send/x": "host_not_allowed",
        "https://www.google.com/fcm/send/x": "host_not_allowed",
        "https://jmt17.google.com:8443/fcm/send/x": "port",
        "http://jmt17.google.com/fcm/send/x": "not_https",
        "https://user@jmt17.google.com/fcm/send/x": "userinfo",
    })) assert.deepEqual(checkEndpoint(u), { ok: false, reason: why }, u);
});

test("relay_origin_and_relay_endpoints", () => {
    assert.equal(relayOrigin("https://push.tinhat.example"), "https://push.tinhat.example");
    assert.equal(relayOrigin(" https://Push.Tinhat.Example/ "), "https://push.tinhat.example");
    assert.equal(relayOrigin("https://push.tinhat.example:8443"), "https://push.tinhat.example:8443");
    assert.equal(relayOrigin("http://127.0.0.1:8098"), "http://127.0.0.1:8098", "a loopback lab relay");
    for (const bad of [undefined, null, "", "push.tinhat.example", "http://push.tinhat.example", "https://push.tinhat.example/x",
        "https://push.tinhat.example/?a", "https://u:p@push.tinhat.example", "ftp://push.tinhat.example"])
        assert.equal(relayOrigin(bad), null, String(bad));
    const R = "https://push.tinhat.example";
    const id = "AbCdEfGhIjKlMnOpQrStUv";
    assert.equal(checkRelayEndpoint(`${R}/w/${id}`, R).ok, true);
    assert.equal(checkRelayEndpoint(`${R}/w/${id}`, null).reason, "no_relay");
    for (const bad of [`${R}/w/${id}x`, `${R}/w/${id}#f`, `${R}/w/${id}?q`, `${R}/w/${id}/`, `${R}//w/${id}`,
        `https://u@push.tinhat.example/w/${id}`, `https://push.tinhat.example:444/w/${id}`, `https://other.example/w/${id}`,
        // equivalent spellings of the same endpoint would mean another pushkey / registration: refused (Astra 2026-10-26)
        `https://push.tinhat.example:443/w/${id}`, `${R}/x/../w/${id}`, `${R}/w/${id}?`, `${R}/w/${id}#`,
        `https://PUSH.tinhat.example/w/${id}`, `${R}/w/${id} `, ` ${R}/w/${id}`])
        assert.equal(checkRelayEndpoint(bad, R).ok, false, JSON.stringify(bad));
    // (whitespace around the value is trimmed; inside it, it is refused)
    for (const bad of ["https://push.tinhat.example\nPUSH_GATEWAY_HOST=0.0.0.0", "https://push.tinhat\t.example", "https://push .tinhat.example"])
        assert.equal(relayOrigin(bad), null, JSON.stringify(bad));
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) };
    const relaySub = { endpoint: `${R}/w/${id}`, ...keys };
    const browserSub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", ...keys };
    assert.equal(parseSubscription(relaySub).reason, "host_not_allowed", "browser kind (the default) never takes the relay");
    assert.equal(parseSubscription(relaySub, R, "relay").viaRelay, true);
    assert.equal(parseSubscription(browserSub, R, "relay").reason, "not_relay");
    assert.equal(parseSubscription(relaySub, R, "any").viaRelay, true);
    assert.equal(parseSubscription(browserSub, R, "any").viaRelay, false);
    assert.equal(parseSubscription(relaySub, null, "any").reason, "host_not_allowed");
    assert.equal(parseSubscription(browserSub).viaRelay, false);
});
