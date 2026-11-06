// calltoken.mjs — call tokens only for rooms the caller is in (security review 2026-10-26, calls round M1b).
//
//   POST /calltoken/sfu/get     what Caddy sends /livekit/jwt and /livekit/jwt/sfu/get to (lk-jwt's /sfu/get)
//   POST /calltoken/get_token   ... and /livekit/jwt/get_token (lk-jwt's MSC4195 endpoint: refused, see below)
//   anything else under /calltoken/ -> 404 (only /livekit/jwt/healthz still goes to lk-jwt directly)
//
// A call membership names the LiveKit room its call runs in (`livekit_alias`), and every client joins the room the
// membership names. lk-jwt-service 0.4.0 checks WHO the caller is (their Matrix OpenID token) but not that they are in
// the Matrix room the LiveKit room belongs to, and Tin Hat's call moderation assumes LiveKit room = Matrix room id
// (moderation.mjs). So a member could point joiners at a LiveKit room outside the call's own room. This route sits in
// front of lk-jwt and lets a request through only when the LiveKit room is a Matrix room id in which the caller is
// JOINED on this server (a federated caller too, when this server sees their join); otherwise 403
// {"error":"not in that room","reason":"not-member"}. Old clients need no change.
//
// How the caller is known:
//   - a sign-in from this server (openid_token.matrix_server_name = SERVER_NAME): Synapse's own OpenID userinfo on its
//     internal address (the same answer lk-jwt gets through the box's Caddy), cached for at most a minute (and no
//     longer than the expires_in the client states; lk-jwt checks the token with Synapse again before it signs);
//   - from another server (0.3.8): resolved here too, through fedresolve.mjs (the Matrix spec's server discovery with
//     foreign.mjs's SSRF guards: public addresses only, pinned, no redirects outside the well-known's 3, byte caps, one
//     10 s deadline), cached like a local one. So lk-jwt is asked only for a caller already verified as a JOINED member
//     (its own lookup of that server then follows a path we have just walked), and never signs a token for a
//     non-member that is thrown away afterwards. A server that can't be reached is a 502 (fails closed, as before when
//     lk-jwt couldn't reach it); one whose name leads to a private address is refused (403). Users of other servers
//     still have restricted access in lk-jwt (LIVEKIT_FULL_ACCESS_HOMESERVERS = this server).
// Membership is read fresh for every request (concurrent ones for a room share one read): never a stale list, neither to
// let in someone who has left nor to refuse someone who has just joined.
// MSC4195 requests (`{room_id, slot_id, member}`, on either path; Element Call's newer method) are served as the
// `/sfu/get` request for the same call (0.3.8, translateToken): the room's own slot only, the claimed user must be the
// verified caller, then the same membership check. lk-jwt's own /get_token would mint for a hashed room name that call
// moderation can't govern, with a participant id the client chooses: it is never asked. (0.3.7 refused them.)
// The body is parsed the way lk-jwt parses it (exact field names, no unknown fields) and lk-jwt receives our own
// re-encoding of exactly what was checked, never the caller's bytes: Go's JSON decoder matches field names
// case-insensitively, so forwarding the original could make lk-jwt read a different room. A device id must match
// identity.mjs's DEVICE_RE (`[A-Za-z0-9_+/-]{1,64}`, 0.3.12): no ':' (the LiveKit identity `<mxid>:<device_id>` would be
// ambiguous) and nothing call moderation (moderation.mjs, the same rule) couldn't mute or remove.
// One exception: the apps' connection test (Settings → Calls) uses a scratch room `tinhat-conntest-<own localpart>-<n>`
// that is not a Matrix room; a caller from this server may have that one for their own name (as the apps write it).
// Fails closed: when Synapse can't be asked the answer is 502, never a pass-through.
// Owner switch: CALL_TOKEN_ROOM_CHECK=off (`tinhat api-limits CALL_TOKEN_ROOM_CHECK=off`) turns off ONLY the room
// membership check and this route's own rate limit (0.3.13, PAD-PHONE Step A): the request is still parsed, the caller
// verified, the device held to DEVICE_RE and the signed identity checked to be exactly `<verified mxid>:<device>`, and
// every token is re-minted with `tinhat.person` (0.3.12's offModeBody, the off-mode body check, is kept for reference:
// the off path no longer forwards a body of its own).
// Default on. What "off" opens up: docs/API.md "Call sign-ins".
// Nothing here logs a token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimit, clientKey, mono, ROOM_ID_RE, safe } from "./reachcommon.mjs";
import { createFedResolver } from "./fedresolve.mjs";
import { DEVICE_RE, MXID_RE } from "./identity.mjs";

export const CALLTOKEN = Object.freeze({
    MAX_BODY: 16 * 1024,
    PER_CLIENT_PER_MIN: 120,    // token requests per caller address (a whole home behind one IPv4 shares it)
    LOOKUPS_PER_CLIENT_MIN: 120, // sign-in lookups for tokens not seen before (and every other server's sign-in, which
    LOOKUPS_GLOBAL_MIN: 600,    // lk-jwt looks up), per caller address / for everyone together
    USER_TTL_MS: 60_000,        // a resolved sign-in, at most
    BAD_TTL_MS: 10_000,         // a refused sign-in
    UPSTREAM_MS: 15_000,
    WATCH_TTL_S: 300,           // a Watch token: 5 minutes to join (LiveKit refreshes a live connection's token itself)
    LK_API_MS: 5_000,           // the call server's room service (the pairing check)
    SWEEP_MS: 60_000,           // the reserved-identity sweep
});

/** The LiveKit identity of a Watch connection (Pad Watch, WATCH-LEASE/DESIGN.md §1.3): `<mxid>:<device>~watch`. Not `#`:
 *  LiveKit's own `/rtc?publish=X` turns any identity into `<identity>#X` WITH the token's publish rights (Astra design
 *  round 2 #1), so an identity with `#` is never a watcher. `~` can't come from LiveKit, and no normal-token route
 *  hands out an identity with `~` or `#` (reservedIdentity). */
export const WATCH_SUFFIX = "~watch";
/** Round 5 (migration): every Watch token's identity ends in a FRESH nonce, `<mxid>:<device>~watch-<16 hex>`, so it can
 *  never equal an identity that existed before (a pre-upgrade `…~watch` session, a LiveKit `#X` form) — a Watch token
 *  can only ever resume a session that this same token created. */
export const WATCH_ID_RE = /^[^#]*~watch-[0-9a-f]{16}$/;
export const isWatchIdentity = (id) => WATCH_ID_RE.test(String(id));
/**
 * A participant (as LiveKit's room service lists it) with a reserved identity (`~` or `#` anywhere) that holds a
 * publish or data right, or has a track, or whose rights can't be read (fail closed). Only the Watch route's own
 * subscribe-only `~watch` connections may carry a reserved identity (DESIGN §1.3).
 */
export function reservedWithRights(p) {
    const id = String(p?.identity || "");
    if (!/[~#]/.test(id)) return false;
    if ((p?.tracks || []).length) return true;
    const perm = p?.permission;
    if (!perm || typeof perm !== "object") return true;
    const b = (s, c) => (perm[s] ?? perm[c]) === true;
    const sources = perm.can_publish_sources ?? perm.canPublishSources;
    return b("can_publish", "canPublish") || b("can_publish_data", "canPublishData") || b("can_update_metadata", "canUpdateMetadata")
        || !isWatchIdentity(id) || (Array.isArray(sources) && sources.length > 0);
}

/** A device id the Watch route serves (the same grammar call moderation parses, so every watcher can be disconnected). */
export const WATCH_DEVICE_RE = DEVICE_RE; // (identity.mjs: the ONE device rule, 0.3.12)

/**
 * The grant of a Watch token (DESIGN §1.3): one room, subscribe only. No publish of any track, no data, no metadata
 * or attribute changes of its own. Pure (tests pin every field).
 */
export function watchGrant({ key, user, device, room, nowS, nonce = randomBytes(8).toString("hex") }) {
    return {
        iss: key, sub: `${user}:${device}${WATCH_SUFFIX}-${nonce}`, name: user, nbf: nowS - 10, exp: nowS + CALLTOKEN.WATCH_TTL_S,
        video: {
            room, roomJoin: true, canSubscribe: true,
            canPublish: false, canPublishData: false, canPublishSources: [],
            canUpdateOwnMetadata: false, hidden: false, recorder: false, agent: false,
        },
        // Pad on the phone (share claude/tinhat-pad/PAD-PHONE/DESIGN.md, Step A): the chip and the person grouping come ONLY
        // from these server-minted attributes (canUpdateOwnMetadata false: no participant can set or change its own)
        attributes: { "tinhat.watch": "1", "tinhat.person": user, "tinhat.pad": "phone", "tinhat.mode": "watch" },
    };
}

/** Pad on the phone, Step A: every call sign-in's device id (normal and Watch, MSC4195's claimed device too), whatever the
 *  room check says — so a signed identity `<verified mxid>:<device>` can be read back to exactly one person. */
export const CALL_DEVICE_RE = DEVICE_RE; // (identity.mjs: the ONE device rule, 0.3.12)

const b64uJson = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** HS256 the way LiveKit's own SDKs sign. */
export function signLk(payload, secret) {
    const head = b64uJson({ alg: "HS256", typ: "JWT" });
    const body = b64uJson(payload);
    return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

/** A call-server token's payload if `secret` really signed it (HS256 only), else null. */
export function verifyLk(jwt, secret) {
    const p = String(jwt || "").split(".");
    if (p.length !== 3 || !secret) return null;
    let head;
    try { head = JSON.parse(Buffer.from(p[0], "base64url").toString("utf8")); } catch { return null; }
    if (head?.alg !== "HS256") return null;
    const want = createHmac("sha256", secret).update(`${p[0]}.${p[1]}`).digest();
    let got;
    try { got = Buffer.from(p[2], "base64url"); } catch { return null; }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try { return JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")); } catch { return null; }
}

/**
 * Pad on the phone, Step A (DESIGN.md "STEP A — decisions after review 4", P2): lk-jwt's answer `text` ({url, jwt, …})
 * with its token RE-MINTED: the same header, identity, room, exp, nbf, every other claim and every grant exactly as
 * lk-jwt wrote them (an omitted grant stays omitted: LiveKit's defaults keep applying) — the only changes: the
 * attribute `tinhat.person` = the verified user (any `tinhat.*` attribute it may have carried is dropped first) and a
 * `canUpdateOwnMetadata: true` turned into false (no participant may set its own attributes). The response keeps
 * every other field. -> the new response text, or null (not lk-jwt's token: never relayed).
 */
export function remint(text, secret, user) {
    let o;
    try { o = JSON.parse(text); } catch { return null; }
    if (!o || typeof o !== "object" || typeof o.jwt !== "string") return null;
    const p = verifyLk(o.jwt, secret);
    if (!p || typeof p !== "object" || !p.video || typeof p.video !== "object") return null;
    // a null-prototype map: an attribute named "__proto__" is copied as an attribute, never into the prototype (review P1)
    const attrs = Object.create(null);
    if (p.attributes && typeof p.attributes === "object") for (const [k, v] of Object.entries(p.attributes)) if (!k.startsWith("tinhat.")) attrs[k] = v;
    attrs["tinhat.person"] = user;
    const out = { ...p, attributes: attrs };
    if (p.video.canUpdateOwnMetadata === true) out.video = { ...p.video, canUpdateOwnMetadata: false };
    const head = o.jwt.split(".")[0];
    const body = Buffer.from(JSON.stringify(out)).toString("base64url");
    const jwt = `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
    return JSON.stringify({ ...o, jwt });
}

const LEGACY_KEYS = new Set(["room", "openid_token", "device_id"]);
// MSC4195 as lk-jwt 0.4.0 reads it, plus the delayed-leave fields current Element Call adds (delay_id, delay_timeout,
// delay_cs_api_url: element-call sdk/src/media-backend/livekit/auth/openID.ts; read and dropped, see translateToken)
const TOKEN_KEYS = new Set(["room_id", "slot_id", "openid_token", "member", "delayed_event_id", "delay_id", "delay_timeout", "delay_cs_api_url"]);
/** The one MatrixRTC slot Tin Hat calls run in (Element Call's room call). */
export const ROOM_SLOT = "m.call#ROOM";
const OPENID_KEYS = new Set(["access_token", "token_type", "matrix_server_name", "expires_in"]);
const MEMBER_KEYS = new Set(["id", "claimed_user_id", "claimed_device_id"]);
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token",
};

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A string field as lk-jwt has it: absent or null = "" (Go's zero value); anything but a string = malformed. */
function str(o, k) {
    const v = o[k];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string" || !v.isWellFormed() || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(k);
    return v;
}
function keysIn(o, allowed) {
    for (const k of Object.keys(o)) if (!allowed.has(k)) return false;
    return true;
}
function openid(o) {
    const t = o.openid_token;
    if (t === undefined || t === null) return { access_token: "", token_type: "", matrix_server_name: "", expires_in: 0 };
    if (!isObj(t) || !keysIn(t, OPENID_KEYS)) throw new Error("openid_token");
    const e = t.expires_in;
    if (!(e === undefined || e === null || Number.isSafeInteger(e))) throw new Error("expires_in");
    return { access_token: str(t, "access_token"), token_type: str(t, "token_type"), matrix_server_name: str(t, "matrix_server_name"), expires_in: e ?? 0 };
}

const DEVICE_ERR = (k) => `${k} must be 1-64 letters, digits, '_', '-', '+' or '/'`;

/**
 * Every value of `o` whose key Go's encoding/json could match to the field `name`, in document order. Go matches field
 * names case-insensitively and folds a non-ASCII letter with unicode.ToUpper(unicode.ToLower(r)), so `ı` (dotless i),
 * `İ`, `ſ` (long s) and `K` (Kelvin) all match ASCII letters. Read as a superset: an ASCII character must equal the
 * name's ignoring case, and ANY non-ASCII character counts as a match for its position (a key no Go fold could match
 * is checked too: that only refuses more).
 */
const foldedValues = (o, name) => Object.keys(o).filter((k) => {
    const cs = [...k];
    return cs.length === name.length && cs.every((c, i) => c.codePointAt(0) >= 0x80 || c.toLowerCase() === name[i]);
}).map((k) => o[k]);

/**
 * With the owner's switch off: the one check that stays, 0.3.12. -> {error} | {body: what lk-jwt receives}.
 * - The body must be one JSON object (Go's json.Decoder reads the first value and ignores what follows, so
 *   `{…"device_id":"X.1"} junk` would otherwise reach lk-jwt unchecked).
 * - Every device id lk-jwt could read must match DEVICE_RE: every `device_id` variant (any case, Go's Unicode folds),
 *   and in every `member` object every `claimed_device_id` variant; a `room` needs a device id, a `member` object too.
 *   A device field that isn't a string, or a `member` that isn't an object (null included), is refused.
 * - lk-jwt receives JSON.stringify of the parsed object, not the caller's bytes: duplicate keys collapse to the one
 *   value checked here (Go would keep an earlier value under a later `null`, e.g. `"member":{…X.1…},"member":null`),
 *   while the key variants that stay separate were each checked above (Go merges them in order: every non-null one
 *   passed, and a `null` one changes nothing).
 * Nothing else is checked: lk-jwt alone decides, as before 0.3.7.
 */
export function offModeBody(text) {
    let v;
    try { v = JSON.parse(text); } catch { return { error: "body is not valid JSON" }; }
    if (!isObj(v)) return { error: "body must be a JSON object" };
    const devOk = (d) => typeof d === "string" && DEVICE_RE.test(d);
    const devs = foldedValues(v, "device_id");
    if (foldedValues(v, "room").length && !devs.length) return { error: DEVICE_ERR("device_id") };
    if (!devs.every(devOk)) return { error: DEVICE_ERR("device_id") };
    for (const m of foldedValues(v, "member")) {
        if (!isObj(m)) return { error: "member is malformed" };  // null too: Go would keep an earlier member under it
        const c = foldedValues(m, "claimed_device_id");
        if (!c.length || !c.every(devOk)) return { error: DEVICE_ERR("claimed_device_id") };
    }
    return { body: JSON.stringify(v) };
}

/**
 * The request as lk-jwt 0.4.0 would read it: {kind: "legacy", room, device_id, openid} | {kind: "token", room_id,
 * slot_id, member, delayed_event_id, openid} | {error} (400). `legacyOk`: /sfu/get takes either shape, /get_token only
 * the second. Stricter than lk-jwt on purpose: a field name differing only in case, a string with control characters
 * or broken UTF-16, or a non-integer expires_in is refused instead of being read some other way.
 */
export function parseRequest(text, legacyOk) {
    let v;
    try { v = JSON.parse(text); } catch { return { error: "body is not valid JSON" }; }
    if (!isObj(v)) return { error: "body must be a JSON object" };
    try {
        if (legacyOk && keysIn(v, LEGACY_KEYS)) {
            const r = { kind: "legacy", room: str(v, "room"), openid: openid(v), device_id: str(v, "device_id") };
            if (!r.room) return { error: "Missing room parameter" };
            if (!DEVICE_RE.test(r.device_id)) return { error: DEVICE_ERR("device_id") };
            if (!r.openid.access_token || !r.openid.matrix_server_name) return { error: "Missing OpenID token parameters" };
            return r;
        }
        if (keysIn(v, TOKEN_KEYS)) {
            const m = v.member ?? {};
            if (!isObj(m) || !keysIn(m, MEMBER_KEYS)) return { error: "member is malformed" };
            const r = {
                kind: "token", room_id: str(v, "room_id"), slot_id: str(v, "slot_id"), openid: openid(v),
                member: { id: str(m, "id"), claimed_user_id: str(m, "claimed_user_id"), claimed_device_id: str(m, "claimed_device_id") },
                delayed_event_id: str(v, "delayed_event_id"),
            };
            str(v, "delay_id"); str(v, "delay_cs_api_url");
            if (!(v.delay_timeout === undefined || v.delay_timeout === null || Number.isSafeInteger(v.delay_timeout))) throw new Error("delay_timeout");
            if (!r.room_id || !r.slot_id) return { error: "The request body is missing `room_id` or `slot_id`" };
            if (!r.member.id || !r.member.claimed_user_id || !r.member.claimed_device_id) return { error: "The request body `member` is missing a `id`, `claimed_user_id` or `claimed_device_id`" };
            if (!r.openid.access_token || !r.openid.matrix_server_name) return { error: "The request body `openid_token` is missing a `access_token` or `matrix_server_name`" };
            return r;
        }
    } catch (e) {
        return { error: `malformed field ${e.message}` };
    }
    return { error: "The request body was malformed, missing required fields, or contained unknown fields" };
}

/**
 * An MSC4195 request (`/get_token`, Element Call's newer method: subscribers to another server's call server, and older
 * Element Call / Element X for every join) as the `/sfu/get` request for the same call (0.3.8): room = the Matrix room
 * id, device = the claimed device. lk-jwt 0.4.0's own `/get_token` mints for room sha256(room_id|slot_id), a LiveKit room
 * nobody publishing through `/sfu/get` is in and call moderation can't govern, with `member.id` (client-chosen) as the
 * identity; `/sfu/get` gives the room the call really runs in and the identity `<verified user>:<device>`. Element Call
 * reads both from the token it gets back (types.ts extractFullConfigFromToken), so nothing else changes for it. Only
 * the room's own slot; delayed-leave delegation (delay_*, delayed_event_id) isn't supported by lk-jwt 0.4.0 and is
 * dropped. -> {legacy request} | {error, status, reason}.
 */
export function translateToken(r) {
    if (r.slot_id !== ROOM_SLOT) return { status: 403, error: "only the room's call slot (m.call#ROOM) is served here", reason: "unsupported" };
    if (!DEVICE_RE.test(r.member.claimed_device_id)) return { status: 400, error: DEVICE_ERR("claimed_device_id") };
    return { kind: "legacy", room: r.room_id, openid: r.openid, device_id: r.member.claimed_device_id, claimed_user_id: r.member.claimed_user_id, msc4195: true };
}

/** What lk-jwt receives: exactly the fields that were checked, re-encoded. */
export function canonicalBody(r) {
    if (r.kind === "legacy") return JSON.stringify({ room: r.room, openid_token: r.openid, device_id: r.device_id });
    return JSON.stringify({ room_id: r.room_id, slot_id: r.slot_id, openid_token: r.openid, member: r.member, delayed_event_id: r.delayed_event_id });
}

export const serverOf = (mxid) => { const m = MXID_RE.exec(String(mxid)); return m ? m[1] : null; };

/** The apps' connection-test scratch room for this user (web: extras.ts runConnectionTest; desktop: call_ctl.rs). */
export function isOwnConnTestRoom(room, mxid) {
    const m = /^tinhat-conntest-([A-Za-z0-9_-]*)-(\d{1,5})$/.exec(room);
    if (!m) return false;
    const lp = String(mxid).slice(1, String(mxid).indexOf(":")).replace(/[^A-Za-z0-9_-]/g, "");
    return m[1] === lp || (lp === "" && m[1] === "user");
}

/** Whether lk-jwt's answer is a token whose identity has a `~` or `#` (reserved: only the Watch route mints `…~watch`;
 *  `#` is what LiveKit itself appends), or can't be read at all (then it isn't handed out either). */
export function reservedIdentity(text) {
    let p = null;
    try { p = jwtPayload(JSON.parse(text).jwt); } catch { return true; }
    return !p || typeof p.sub !== "string" || /[~#]/.test(p.sub);
}

/** The payload of a JWT lk-jwt just minted (its own answer on loopback: decoded, not verified). */
function jwtPayload(jwt) {
    const p = String(jwt || "").split(".");
    if (p.length !== 3) return null;
    try { return JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")); } catch { return null; }
}

/**
 * deps: { hs: {get(path, token)} (createHs, the internal Synapse), adminToken, serverName, lkJwtUrl,
 *         enabled: () => bool, fetchImpl, now, log, federation?: {userinfo(server, token) -> {sub}|null} (fedresolve),
 *         Watch (§ watchHandler): lkKey, lkSecret, lkApiUrl (the call server's HTTP API), sfuUrl (what clients connect
 *         to, = lk-jwt's LIVEKIT_URL), wallNow? (epoch ms) — without key/secret/API the Watch route answers 404 }
 */
export function createCallToken(deps) {
    const { hs, adminToken, serverName, lkJwtUrl } = deps;
    const fetchImpl = deps.fetchImpl || fetch;
    const now = deps.now || mono;
    const log = deps.log || ((s) => console.log(s));
    const enabled = deps.enabled || (() => true);
    const wallNow = deps.wallNow || Date.now;   // JWT times (seconds since the epoch); `now` is the monotonic clock
    const federation = deps.federation || createFedResolver();
    const perClient = new RateLimit(CALLTOKEN.PER_CLIENT_PER_MIN, 60_000, now);
    const lookupsClient = new RateLimit(CALLTOKEN.LOOKUPS_PER_CLIENT_MIN, 60_000, now);
    const lookupsGlobal = new RateLimit(CALLTOKEN.LOOKUPS_GLOBAL_MIN, 60_000, now);
    const users = new Map();     // sha256(access token) -> {user|null, exp}
    const inflight = new Map();  // "u:"+key | "r:"+room -> Promise

    function once(key, fn) {
        if (inflight.has(key)) return inflight.get(key);
        const p = fn().finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }
    function trim(map) {
        if (map.size <= 5000) return;
        const t = now();
        for (const [k, e] of map) if (e.exp <= t) map.delete(k);
        while (map.size > 5000) map.delete(map.keys().next().value);
    }

    /** The user a sign-in from this server belongs to; null = refused; throws "busy" / anything when Synapse fails. */
    async function localUser(o, ip, fresh = false) {
        const key = sha(o.access_token);
        const hit = users.get(key);
        if (!fresh && hit && hit.exp > now()) return hit.user;
        // fresh (the Watch route, which signs by itself: no second check by lk-jwt; Astra design round 2 #2): Synapse is
        // asked now, never a cached answer whose life the caller's expires_in set
        return once(`${fresh ? "f" : "u"}:${key}`, async () => {
            if (!lookupsClient.hit(ip) || !lookupsGlobal.hit("all")) throw new Error("busy");
            const r = await hs.get(`/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(o.access_token)}`);
            if (r.ok && typeof r.body?.sub === "string" && serverOf(r.body.sub) === serverName) {
                const life = o.expires_in > 0 ? Math.min(CALLTOKEN.USER_TTL_MS, o.expires_in * 1000) : CALLTOKEN.USER_TTL_MS;
                users.set(key, { user: r.body.sub, exp: now() + life });
                trim(users);
                return r.body.sub;
            }
            if (r.status === 401 || r.status === 403 || r.ok) {
                users.set(key, { user: null, exp: now() + CALLTOKEN.BAD_TTL_MS });
                trim(users);
                return null;
            }
            throw new Error(`userinfo said ${r.status}`);
        });
    }

    /** The user a sign-in from another server belongs to (fedresolve: SSRF-guarded); null = refused by that server;
     *  throws "busy", {status: 403} (a private or malformed server name) or anything (can't be asked). */
    async function remoteUser(o, ip) {
        const key = sha(`${o.matrix_server_name}\0${o.access_token}`);
        const hit = users.get(key);
        if (hit && hit.exp > now()) return hit.user;
        return once(`u:${key}`, async () => {
            if (!lookupsClient.hit(ip) || !lookupsGlobal.hit("all")) throw new Error("busy");
            const r = await federation.userinfo(o.matrix_server_name, o.access_token);
            const user = r && serverOf(r.sub) === o.matrix_server_name ? r.sub : null;
            const life = user ? (o.expires_in > 0 ? Math.min(CALLTOKEN.USER_TTL_MS, o.expires_in * 1000) : CALLTOKEN.USER_TTL_MS) : CALLTOKEN.BAD_TTL_MS;
            users.set(key, { user, exp: now() + life });
            trim(users);
            return user;
        });
    }

    /**
     * Whether `test(the room's joined members)` holds, as this server sees the room (false: no such room here). Always
     * read fresh: nobody who left or was removed gets a token from a stale list, and nobody who has just joined is
     * refused from one (a cached "no" refused a newcomer whose call join came within 3 s of anyone else's: a guest let
     * in, an invite accepted; assembly-037 gates). Concurrent reads of one room share one request; a "no" from a shared one
     * is read again on its own (it may predate this caller's join).
     */
    async function isMember(room, test) {
        const read = async () => {
            const r = await hs.get(`/_synapse/admin/v1/rooms/${encodeURIComponent(room)}/members`, adminToken);
            if (r.status === 404 || r.status === 400) return null;
            if (r.ok && Array.isArray(r.body?.members)) return new Set(r.body.members.filter((m) => typeof m === "string"));
            throw new Error(`room members said ${r.status}`);
        };
        // a read already running may have started before this caller joined (assembly-038 review): its "no" is
        // checked once more with a read of our own; a "yes" is a yes either way
        const shared = inflight.has(`r:${room}`);
        const set = await once(`r:${room}`, read);
        if ((!!set && test(set)) || !shared) return !!set && test(set);
        const own = await read();
        return !!own && test(own);
    }

    async function upstream(path, body) {
        const r = await fetchImpl(`${lkJwtUrl}${path}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
            redirect: "error", signal: AbortSignal.timeout(CALLTOKEN.UPSTREAM_MS),
        });
        return { status: r.status, text: await r.text() };
    }

    function readBody(req) {
        return new Promise((resolve) => {
            const declared = Number(req.headers?.["content-length"]);
            if (Number.isFinite(declared) && declared > CALLTOKEN.MAX_BODY) { req.resume?.(); return resolve(null); }
            const chunks = [];
            let n = 0, over = false;
            req.on("data", (c) => { if (over) return; n += c.length; if (n > CALLTOKEN.MAX_BODY) { over = true; chunks.length = 0; } else chunks.push(c); });
            req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
            req.on("error", () => resolve(null));
        });
    }

    const send = (res, status, obj) => res.status(status).json(obj);
    const refuse = (res, reason) => send(res, 403, { errcode: "M_FORBIDDEN", error: "not in that room", reason });

    /** path: "/sfu/get" | "/get_token" (lk-jwt's). */
    function handler(path) {
        const legacyOk = path === "/sfu/get";
        return async (req, res) => {
            res.set("Cache-Control", "no-store");
            for (const [k, v] of Object.entries(CORS)) res.set(k, v);
            if (req.method === "OPTIONS") return res.status(200).end();
            if (req.method !== "POST") return res.status(405).end();
            const ip = clientKey(req);
            const on = enabled();  // the owner's switch off: no limit of this route's own (lk-jwt alone decides)
            if (on && !perClient.hit(ip)) { req.resume?.(); res.set("Retry-After", "10"); return send(res, 429, { errcode: "M_LIMIT_EXCEEDED", error: "too many call sign-ins, try again shortly" }); }
            const raw = await readBody(req);
            if (!raw) return send(res, 413, { errcode: "M_TOO_LARGE", error: "request too large" });
            /** lk-jwt's answer, or null after a 502 was sent. */
            const pass = async (body, to = path) => {
                try { return await upstream(to, body); } catch {
                    send(res, 502, { errcode: "M_UNKNOWN", error: "the call sign-in service isn't answering" });
                    return null;
                }
            };
            const relay = (up) => { res.set("Content-Type", "application/json"); return res.status(up.status).send(up.text); };

            // Pad on the phone, Step A (DESIGN.md "STEP A — review 2" #1): the request is parsed, the caller verified and the
            // identity canonical on EVERY path. The owner's switch (CALL_TOKEN_ROOM_CHECK=off) turns off only the room
            // membership check and this route's own rate limit; lk-jwt's /get_token (a client-chosen identity) is never asked.
            let r = parseRequest(raw.toString("utf8"), legacyOk);
            if (r.error) return send(res, 400, { errcode: "M_BAD_JSON", error: r.error });
            if (r.kind === "token") {
                const t = translateToken(r);
                if (t.error) {
                    log(`[calltoken] refused: an MSC4195 request (${t.reason || "malformed"})`);
                    return send(res, t.status, t.status === 400 ? { errcode: "M_BAD_JSON", error: t.error } : { errcode: "M_FORBIDDEN", error: t.error, reason: t.reason });
                }
                r = t;
            }
            const o = r.openid;
            const room = r.room;
            const local = o.matrix_server_name === serverName;
            const where = local ? "local" : "remote";

            let user = null;      // the caller, verified before lk-jwt is asked (this server's or another's)
            try {
                if (on && !local && !ROOM_ID_RE.test(room)) { log("[calltoken] refused: not a room id (remote caller)"); return refuse(res, "not-member"); }
                user = local ? await localUser(o, ip) : await remoteUser(o, ip);
                if (!user) return send(res, 401, { errcode: "M_UNAUTHORIZED", error: "The request could not be authorised." });
                // MSC4195: the member it claims to be must be the caller (lk-jwt's own rule for /get_token)
                if (r.msc4195 && r.claimed_user_id !== user) return send(res, 401, { errcode: "M_UNAUTHORIZED", error: "The request could not be authorised." });
                if (on && !(local && isOwnConnTestRoom(room, user))) {  // (the connection test's scratch room: this caller's own)
                    if (!ROOM_ID_RE.test(room)) { log(`[calltoken] refused: not a room id (${where} caller)`); return refuse(res, "not-member"); }
                    const ok = await isMember(room, (set) => set.has(user));
                    if (!ok) { log(`[calltoken] refused: not a joined member (${where} caller)`); return refuse(res, "not-member"); }
                }
            } catch (e) {
                if (e?.message === "busy") { res.set("Retry-After", "10"); return send(res, 429, { errcode: "M_LIMIT_EXCEEDED", error: "too many call sign-in checks, try again shortly" }); }
                if (e?.status === 403) { log(`[calltoken] refused: ${e.reason || "remote server"} (remote caller)`); return refuse(res, "remote-refused"); }
                log(`[calltoken] check failed: ${e?.message || e}`);
                return send(res, 502, { errcode: "M_UNKNOWN", error: "couldn't check the room", reason: "check-failed" });
            }

            const up = await pass(canonicalBody(r), "/sfu/get");  // (Step A: lk-jwt's /get_token is never asked)
            if (!up) return undefined;
            // hand out lk-jwt's token only for the identity that was checked (defence in depth: lk-jwt resolved the
            // sign-in again itself)
            // whatever the request was, a normal token never carries a Watch identity (`#`: DESIGN §1.3, Astra d1 #1)
            if (up.status === 200 && reservedIdentity(up.text)) { log(`[calltoken] dropped a minted token: a reserved (Watch) identity (${where} caller)`); return refuse(res, "reserved-identity"); }
            if (up.status !== 200) return relay(up);  // lk-jwt's own errors, as it wrote them
            // Step A: the identity signed is EXACTLY `<verified user>:<device>` for exactly this room — every path, the
            // connection test's room too (a mismatch is never handed out)
            let ok = false;
            try {
                const p = jwtPayload(JSON.parse(up.text).jwt);
                ok = p?.sub === `${user}:${r.device_id}` && p?.video?.room === room && serverOf(user) === o.matrix_server_name;
            } catch { ok = false; }
            if (!ok) { log(`[calltoken] dropped a minted token: not exactly the caller's account + device (${where} caller)`); return refuse(res, "not-member"); }
            // no call-server key configured: FAIL CLOSED — lk-jwt's token is never handed out unchecked (Step A code review P1)
            if (!deps.lkSecret) { log(`[calltoken] no call-server key configured: refused (${where} caller)`); return send(res, 502, { errcode: "M_UNKNOWN", error: "the call sign-in couldn't be completed", reason: "no-key" }); }
            // Step A: re-minted with the server's own `tinhat.person` (the only attribute grouping trusts); on ANY failure
            // an error — lk-jwt's token is never relayed instead
            const out = remint(up.text, deps.lkSecret, user);
            if (!out) { log(`[calltoken] couldn't re-mint lk-jwt's token (${where} caller): refused`); return send(res, 502, { errcode: "M_UNKNOWN", error: "the call sign-in couldn't be completed", reason: "remint-failed" }); }
            res.set("Content-Type", "application/json");
            return res.status(200).send(out);
        };
    }

    /** The call server's room service (twirp), signed per request with a room-admin token for that one room. */
    /** `room` "" = a room-list token (ListRooms), else a room-admin token for that one room. */
    async function lkRoomService(method, room, body) {
        const nowS = Math.floor(wallNow() / 1000);
        const video = room ? { room, roomAdmin: true } : { roomList: true };
        const tok = signLk({ iss: deps.lkKey, sub: "tinhat-api-watch", nbf: nowS - 10, exp: nowS + 60, video }, deps.lkSecret);
        const r = await fetchImpl(`${deps.lkApiUrl}/twirp/livekit.RoomService/${method}`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
            body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(CALLTOKEN.LK_API_MS),
        });
        if (r.status === 404) return null;   // no such room on the call server (nobody is in that call)
        if (!r.ok) throw new Error(`call server said ${r.status}`);
        return r.json();
    }

    /** Remove every reserved identity (`~` or `#`) of `participants` that holds any publish right or a track. */
    /**
     * Remove every reserved identity (`~` or `#`) of `participants` that holds a publish right, a track or unreadable
     * rights, then LIST THE CALL AGAIN and confirm none is left (round 4 P1: fail closed). Throws when one couldn't be
     * removed or is still there; the Watch route then refuses to sign (502) and the sweep logs an alert.
     */
    async function removeReserved(room, participants) {
        const bad = participants.filter(reservedWithRights);
        if (!bad.length) return 0;
        const failed = [];
        for (const p of bad) {
            try {
                await lkRoomService("RemoveParticipant", room, { room, identity: p.identity });
                log("[calltoken] watch sweep: removed a reserved identity holding publish rights");
            } catch (e) {
                failed.push(e?.message || String(e));
            }
        }
        const again = await lkRoomService("ListParticipants", room, { room });
        const left = (again?.participants || []).filter(reservedWithRights).length;
        if (failed.length || left) {
            log(`[calltoken] ALERT watch sweep: ${left} reserved identit${left === 1 ? "y" : "ies"} with publish rights still in a call (${failed.length} removal(s) failed${failed.length ? `: ${failed[0]}` : ""})`);
            throw new Error("reserved-identity removal failed");
        }
        return bad.length;
    }

    /** The sweep (Astra r3 #1): every call on the call server, every reserved identity with publish rights out. At start
     *  and every SWEEP_MS. Returns how many were removed; never throws (a failed removal is logged as an ALERT). */
    async function sweep() {
        let removed = 0;
        try {
            const rooms = (await lkRoomService("ListRooms", "", {}))?.rooms || [];
            for (const r of rooms) {
                if (!(Number(r?.num_participants ?? r?.numParticipants ?? 1) > 0) || typeof r?.name !== "string") continue;
                try {
                    const list = await lkRoomService("ListParticipants", r.name, { room: r.name });
                    removed += await removeReserved(r.name, list?.participants || []);
                } catch (e) {
                    // (a failed removal has logged its own ALERT; anything else — the list itself failed — is one here)
                    if (e?.message !== "reserved-identity removal failed") log(`[calltoken] ALERT watch sweep: one call couldn't be checked: ${e?.message || e}`);
                }
            }
        } catch (e) {
            log(`[calltoken] ALERT watch sweep failed: ${e?.message || e}`);
        }
        return removed;
    }

    /**
     * POST /calltoken/watch (public /livekit/jwt/watch): a subscribe-only token for a Pad Watch join (WATCH-LEASE/DESIGN.md
     * §1). Always checked (the owner's switch doesn't reach it), local accounts only, the caller's own device, a JOINED
     * member (round 5: no pairing requirement — DESIGN T6). No lk-jwt fallback: lk-jwt can't mint a restricted grant. The apps learn that this
     * server offers Watch from the well-known (features.pad_watch); OPTIONS answers 200 too (a hint only).
     */
    function watchHandler() {
        const watchOk = !!(deps.lkKey && deps.lkSecret && deps.lkApiUrl);
        return async (req, res) => {
            res.set("Cache-Control", "no-store");
            for (const [k, v] of Object.entries(CORS)) res.set(k, v);
            if (!watchOk) { req.resume?.(); return send(res, 404, { errcode: "M_NOT_FOUND", error: "not found" }); }
            if (req.method === "OPTIONS") return res.status(200).end();
            if (req.method !== "POST") return res.status(405).end();
            const ip = clientKey(req);
            if (!perClient.hit(ip)) { req.resume?.(); res.set("Retry-After", "10"); return send(res, 429, { errcode: "M_LIMIT_EXCEEDED", error: "too many call sign-ins, try again shortly" }); }
            const raw = await readBody(req);
            if (!raw) return send(res, 413, { errcode: "M_TOO_LARGE", error: "request too large" });
            const r = parseRequest(raw.toString("utf8"), true);
            if (r.error) return send(res, 400, { errcode: "M_BAD_JSON", error: r.error });
            if (r.kind !== "legacy") return send(res, 400, { errcode: "M_BAD_JSON", error: "a Watch request is {room, openid_token, device_id}" });
            const o = r.openid, room = r.room, device = r.device_id;
            const no = (reason, why) => { log(`[calltoken] watch refused: ${why}`); return send(res, 403, { errcode: "M_FORBIDDEN", error: "can't watch that call", reason }); };
            if (o.matrix_server_name !== serverName) return no("watch-local-only", "not an account of this server");
            if (!WATCH_DEVICE_RE.test(device)) return no("no-device", "no device id the Watch route serves");
            let user;
            try {
                user = await localUser(o, ip, true);
                if (!user) return send(res, 401, { errcode: "M_UNAUTHORIZED", error: "The request could not be authorised." });
                if (!ROOM_ID_RE.test(room)) return no("not-member", "not a room id");
                if (!(await isMember(room, (set) => set.has(user)))) return no("not-member", "not a joined member");
                const d = await hs.get(`/_synapse/admin/v2/users/${encodeURIComponent(user)}/devices/${encodeURIComponent(device)}`, adminToken);
                if (d.status === 404) return no("not-your-device", "the device isn't the caller's");
                if (!d.ok || d.body?.device_id !== device) throw new Error(`device lookup said ${d.status}`);
                const list = await lkRoomService("ListParticipants", room, { room });
                // a reserved identity holding publish rights in this call (one issued before ~ was reserved, or LiveKit's
                // publish=X form) is removed BEFORE a Watch token exists, so the token can never resume it (Astra r3 #1)
                await removeReserved(room, list?.participants || []);
                // (round 5: no "another device of yours is in this call" requirement any more — it was a UX tie, not a
                // security property (DESIGN T6), and it refused the intended use: watching while your computer isn't in
                // the call. A joined member's own device gets subscribe-only rights: strictly less than /sfu/get gives it.)
            } catch (e) {
                if (e?.message === "busy") { res.set("Retry-After", "10"); return send(res, 429, { errcode: "M_LIMIT_EXCEEDED", error: "too many call sign-in checks, try again shortly" }); }
                log(`[calltoken] watch check failed: ${e?.message || e}`);
                return send(res, 502, { errcode: "M_UNKNOWN", error: "couldn't check the call", reason: "check-failed" });
            }
            const jwt = signLk(watchGrant({ key: deps.lkKey, user, device, room, nowS: Math.floor(wallNow() / 1000) }), deps.lkSecret);
            log("[calltoken] watch token minted (local caller)");
            return send(res, 200, { url: deps.sfuUrl, jwt });
        };
    }

    if (deps.lkKey && deps.lkSecret && deps.lkApiUrl && deps.sweep !== false) {
        setTimeout(() => void sweep(), 5_000).unref?.();
        setInterval(() => void sweep(), CALLTOKEN.SWEEP_MS).unref?.();
    }
    return {
        handler,
        watchHandler,
        sweep,
        notFound: (_req, res) => send(res, 404, { errcode: "M_NOT_FOUND", error: "not found" }),
        _users: users,
    };
}

/** Mount on the API (registered before its shared limiter and JSON parser: this route reads its own body). */
export function installCallToken(app, deps) {
    const ct = createCallToken(deps);
    app.all("/calltoken/sfu/get", safe("calltoken", ct.handler("/sfu/get")));
    app.all("/calltoken/get_token", safe("calltoken", ct.handler("/get_token")));
    app.all("/calltoken/watch", safe("calltoken", ct.watchHandler()));
    app.all(/^\/calltoken(?:\/|$)/, ct.notFound);
    return ct;
}
