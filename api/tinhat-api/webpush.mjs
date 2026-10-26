// webpush.mjs — Web Push for the Tin Hat push gateway (Reach, 10.6; contract docs/REACH.md §3.1).
//
//   • RFC 8291 message encryption: aes128gcm, ONE record, rs 4096, padding delimiter 0x02.
//   • RFC 8292 VAPID: ES256 JWT {aud: endpoint origin, exp: now + 12 h, sub: mailto:…}, sent as
//     `Authorization: vapid t=<jwt>, k=<raw public key>`.
//   • The endpoint ALLOWLIST — the SSRF guard. The gateway is unauthenticated by spec (anyone can POST a
//     notification naming any "endpoint"), so nothing leaves this process unless the URL is https, has no
//     userinfo, no port, no IP literal and a host on the list below. Redirects are never followed.
//
// node:crypto only: this service deliberately has ONE npm dependency (express), and this file has none.
import {
    createCipheriv, createDecipheriv, createECDH, createHash, createPrivateKey, createPublicKey,
    generateKeyPairSync, hkdfSync, randomBytes, sign, verify,
} from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const RECORD_SIZE = 4096;
export const JWT_TTL_SEC = 12 * 3600;

export const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** Strict base64url (or padded/standard base64) -> Buffer; null for anything else. */
export function fromB64u(s) {
    if (typeof s !== "string" || s.length === 0 || s.length > 4096) return null;
    const t = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (!/^[A-Za-z0-9_-]+$/.test(t) || t.length % 4 === 1) return null;
    return Buffer.from(t, "base64url");
}

// ── endpoint allowlist (SSRF guard) ─────────────────────────────────────────────────────────────────
// jmt17.google.com: what Chromium builds without Google API keys hand out (exact host only — no *.google.com).
const EXACT_HOSTS = new Set(["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "jmt17.google.com"]);
const HOST_SUFFIXES = [".push.apple.com", ".googleapis.com", ".push.services.mozilla.com", ".notify.windows.com"];

/**
 * Is this a push endpoint we may POST to? {ok: true, url} with the NORMALISED URL (always fetch url.href,
 * never the raw string, so the host that was checked is the host that is contacted), else {ok: false, reason}.
 */
export function checkEndpoint(raw) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return { ok: false, reason: "bad_endpoint" };
    let u;
    try { u = new URL(raw); } catch { return { ok: false, reason: "bad_endpoint" }; }
    if (u.protocol !== "https:") return { ok: false, reason: "not_https" };
    if (u.username !== "" || u.password !== "") return { ok: false, reason: "userinfo" };
    if (u.port !== "") return { ok: false, reason: "port" };
    const host = u.hostname; // lower-cased, percent-decoded and IDNA-mapped by the WHATWG parser
    if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return { ok: false, reason: "ip_literal" };
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes(".."))
        return { ok: false, reason: "host_not_allowed" };
    const allowed = EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((sfx) => host.endsWith(sfx));
    if (!allowed) return { ok: false, reason: "host_not_allowed" };
    return { ok: true, url: u };
}

// ── the phone apps' relay (docs/PHONE-PUSH.md) ───────────────────────────────────────────────────────
// The Tin Hat phone apps subscribe at ONE relay (Web Push in, APNs / FCM out); a server takes their endpoints only
// when its PUSH_RELAY names that relay, and only for the phone app ids. Unset = phone pushers are refused, as before.

/** PUSH_RELAY → the relay's origin ("https://push.example"; http only for a loopback lab relay), or null. */
export function relayOrigin(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    // the URL parser would quietly drop tabs/newlines (and keep what follows): no whitespace or controls at all
    if (/[\u0000-\u0020\u007f]/.test(raw.trim())) return null;
    let u;
    try { u = new URL(raw.trim()); } catch { return null; }
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    if (u.username !== "" || u.password !== "" || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
}

/**
 * A relay endpoint: the RAW string is exactly `<relay origin>/w/<22-char id>` (relay = relayOrigin()'s canonical form),
 * so one subscription has one spelling and one pushkey: no `:443`, no `/x/../w/…`, no empty `?` or `#`, no case games.
 * {ok: true, url} or {ok: false, reason}.
 */
export function checkRelayEndpoint(raw, relay) {
    if (!relay) return { ok: false, reason: "no_relay" };
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return { ok: false, reason: "bad_endpoint" };
    const prefix = `${relay}/w/`;
    if (!raw.startsWith(prefix) || !/^[A-Za-z0-9_-]{22}$/.test(raw.slice(prefix.length))) return { ok: false, reason: "not_relay" };
    let u;
    try { u = new URL(raw); } catch { return { ok: false, reason: "bad_endpoint" }; }
    if (u.href !== raw) return { ok: false, reason: "not_relay" };
    return { ok: true, url: u };
}

/** A P-256 point in uncompressed form that really lies on the curve (OpenSSL checks it on import). */
function isP256Point(buf) {
    if (!Buffer.isBuffer(buf) || buf.length !== 65 || buf[0] !== 0x04) return false;
    try {
        createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(buf.subarray(1, 33)), y: b64u(buf.subarray(33)) }, format: "jwk" });
        return true;
    } catch { return false; }
}

/**
 * Pusher data {endpoint, p256dh, auth} -> {ok: true, endpoint: URL, p256dh: Buffer(65), auth: Buffer(16), viaRelay}
 * or {ok: false, reason}. The allowlist is applied here, so an invalid subscription is never fetched.
 * `kind`: "browser" = the push-service allowlist only (a browser's subscription; the default), "relay" = the phone
 * apps' relay only (`relay` = its origin from relayOrigin()), "any" = either (a registration, which names no app id).
 */
export function parseSubscription(data, relay = null, kind = "browser") {
    if (!data || typeof data !== "object") return { ok: false, reason: "no_data" };
    let ep, viaRelay = false;
    if (kind === "relay") {
        ep = checkRelayEndpoint(data.endpoint, relay);
        viaRelay = true;
    } else {
        ep = checkEndpoint(data.endpoint);
        if (!ep.ok && kind === "any" && relay) {
            const r = checkRelayEndpoint(data.endpoint, relay);
            if (r.ok) { ep = r; viaRelay = true; }
        }
    }
    if (!ep.ok) return ep;
    const p256dh = fromB64u(data.p256dh);
    if (!p256dh || !isP256Point(p256dh)) return { ok: false, reason: "bad_p256dh" };
    const auth = fromB64u(data.auth);
    if (!auth || auth.length !== 16) return { ok: false, reason: "bad_auth" };
    return { ok: true, endpoint: ep.url, p256dh, auth, viaRelay };
}

/** The pushkey the web client derives from its endpoint (REACH §3.2): base64url(sha256(endpoint)). */
export const pushkeyFor = (endpoint) => b64u(createHash("sha256").update(String(endpoint)).digest());

// ── RFC 8291 ────────────────────────────────────────────────────────────────────────────────────────
function deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt) {
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
    const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));
    return { cek, nonce };
}

/**
 * Encrypt one push message for a subscription (ua_public = p256dh, auth_secret = auth). Returns the full
 * aes128gcm body: salt(16) | rs(4) | idlen(1) | as_public(65) | ciphertext+tag. `opts.salt` and
 * `opts.asPrivate` exist for the RFC 8291 §5 test vector only; production always uses fresh random ones.
 */
export function encrypt(plaintext, uaPublic, authSecret, opts = {}) {
    const rs = opts.rs ?? RECORD_SIZE;
    const pt = Buffer.from(plaintext);
    if (pt.length + 1 + 16 > rs) throw new Error("payload too large for a single record");
    const salt = opts.salt ?? randomBytes(16);
    const ecdh = createECDH("prime256v1");
    if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
    else ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey(); // uncompressed, 65 bytes
    const { cek, nonce } = deriveKeys(ecdh.computeSecret(uaPublic), authSecret, uaPublic, asPublic, salt);
    const cipher = createCipheriv("aes-128-gcm", cek, nonce);
    const ct = Buffer.concat([cipher.update(Buffer.concat([pt, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(rs, 16);
    header[20] = asPublic.length;
    return Buffer.concat([header, asPublic, ct]);
}

/** The receiving side (what a browser does). Used by the tests' round trip; single-record bodies only. */
export function decrypt(body, uaPrivate, authSecret) {
    const buf = Buffer.from(body);
    const salt = buf.subarray(0, 16);
    const idlen = buf[20];
    const asPublic = buf.subarray(21, 21 + idlen);
    const ct = buf.subarray(21 + idlen);
    // http_ece (the Python reference) encodes an EMPTY message as a header with no record at all; accept that.
    if (ct.length === 0) return Buffer.alloc(0);
    if (ct.length < 17) throw new Error("truncated record");
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(uaPrivate);
    const { cek, nonce } = deriveKeys(ecdh.computeSecret(asPublic), authSecret, ecdh.getPublicKey(), asPublic, salt);
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    let i = rec.length - 1;
    while (i >= 0 && rec[i] === 0) i--;
    if (i < 0 || rec[i] !== 0x02) throw new Error("bad padding delimiter (expected 0x02 for the last record)");
    return rec.subarray(0, i);
}

// ── RFC 8292 (VAPID) ────────────────────────────────────────────────────────────────────────────────
export function vapidJwt({ audience, subject, privateKey, nowSec = Math.floor(Date.now() / 1000), ttlSec = JWT_TTL_SEC }) {
    const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const body = b64u(JSON.stringify({ aud: audience, exp: nowSec + ttlSec, sub: subject }));
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${head}.${body}.${b64u(sig)}`;
}

/** Verify an ES256 JWT against a raw uncompressed P-256 public key; claims or null. (Tests + tooling.) */
export function verifyVapidJwt(jwt, publicKeyB64u) {
    const parts = String(jwt).split(".");
    if (parts.length !== 3) return null;
    const pub = fromB64u(publicKeyB64u);
    if (!pub || !isP256Point(pub)) return null;
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
    const ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, fromB64u(parts[2]) || Buffer.alloc(0));
    if (!ok) return null;
    try {
        const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        if (header.alg !== "ES256") return null;
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch { return null; }
}

/** A private KeyObject from the raw public point + the private scalar (both base64url). Throws if they don't match. */
export function vapidKeyFrom(publicKeyB64u, privateD) {
    const pub = fromB64u(publicKeyB64u);
    if (!pub || !isP256Point(pub)) throw new Error("vapid: bad public key");
    const d = fromB64u(privateD);
    if (!d || d.length !== 32) throw new Error("vapid: bad private key");
    // A JWK import keeps whatever x/y it is given, so derive the point from d ourselves and compare.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey().equals(pub)) throw new Error("vapid: private key does not match the public key");
    return createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: privateD }, format: "jwk" });
}

/**
 * Load the VAPID keypair from `path`, generating it once (mode 0600, exclusive create) when missing.
 * Returns {publicKey: base64url raw 65-byte point, privateKey: KeyObject}. The private half never leaves.
 */
export function loadOrCreateVapid(path, log = () => {}) {
    let raw;
    try { raw = readFileSync(path, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (raw === undefined) {
        const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const jwk = privateKey.export({ format: "jwk" });
        const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
        const doc = { v: 1, created: new Date().toISOString(), publicKey: b64u(pub), privateKey: jwk.d };
        try {
            writeFileSync(path, JSON.stringify(doc, null, 1) + "\n", { mode: 0o600, flag: "wx" });
            log("generated a new VAPID keypair");
        } catch (e) { if (e.code !== "EEXIST") throw e; }
        raw = readFileSync(path, "utf8");
    }
    if ((statSync(path).mode & 0o077) !== 0) {
        chmodSync(path, 0o600);
        log("vapid key file was readable by others — reset to 0600");
    }
    const doc = JSON.parse(raw);
    return { publicKey: doc.publicKey, privateKey: vapidKeyFrom(doc.publicKey, doc.privateKey) };
}

// ── sending ─────────────────────────────────────────────────────────────────────────────────────────
/** Read at most `cap` bytes of a response body, then drop the rest (a push service answers in bytes). */
async function readCapped(r, cap = 4096) {
    if (!r.body || typeof r.body.getReader !== "function") {
        try { return Buffer.from(await r.arrayBuffer()).subarray(0, cap); } catch { return Buffer.alloc(0); }
    }
    const reader = r.body.getReader();
    const chunks = [];
    let n = 0;
    try {
        while (n < cap) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            n += value.length;
        }
    } catch { /* aborted / reset — the status is what counts */ }
    try { await reader.cancel(); } catch { /* already closed */ }
    return Buffer.concat(chunks).subarray(0, cap);
}

/** A short machine reason from a push service's error body ("BadDeviceToken", "errno 102", …) — never raw text. */
function reasonOf(buf) {
    try {
        const j = JSON.parse(buf.toString("utf8"));
        const r = j.reason ?? (j.errno != null ? `errno ${j.errno}` : null) ?? j.error?.status ?? j.error;
        return typeof r === "string" || typeof r === "number" ? String(r).replace(/[^\w .:-]/g, "").slice(0, 60) : "";
    } catch { return ""; }
}

/**
 * POST one encrypted message. Never throws: {status, ms, reason?} with status 0 for network errors/timeouts.
 * `sub` must come from parseSubscription (so it already passed the allowlist). Never carries Matrix/admin auth.
 */
export async function sendWebPush({
    sub, payload, vapid, subject, ttl = 3600, urgency = "normal", topic,
    fetchImpl = fetch, timeoutMs = 5000, now = Date.now, wallNow = Date.now,
}) {
    const t0 = now();
    let body;
    try { body = encrypt(Buffer.from(payload), sub.p256dh, sub.auth); }
    catch { return { status: 0, ms: Math.round(now() - t0), reason: "encrypt_failed" }; }
    // `now` only times the request (may be monotonic); the JWT expiry needs real wall-clock time.
    const jwt = vapidJwt({ audience: sub.endpoint.origin, subject, privateKey: vapid.privateKey, nowSec: Math.floor(wallNow() / 1000) });
    const headers = {
        TTL: String(ttl),
        Urgency: urgency,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    };
    if (topic) headers.Topic = topic;
    try {
        const r = await fetchImpl(sub.endpoint.href, {
            method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        });
        const text = r.status >= 300 ? await readCapped(r) : (await readCapped(r, 256), Buffer.alloc(0));
        return { status: r.status, ms: Math.round(now() - t0), reason: r.status >= 300 ? reasonOf(text) : "" };
    } catch (e) {
        return { status: 0, ms: Math.round(now() - t0), reason: e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "network" };
    }
}
