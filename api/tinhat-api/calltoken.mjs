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
// case-insensitively, so forwarding the original could make lk-jwt read a different room. A device id may not contain
// ":" (the LiveKit identity `<mxid>:<device_id>` would be ambiguous).
// One exception: the apps' connection test (Settings → Calls) uses a scratch room `tinhat-conntest-<own localpart>-<n>`
// that is not a Matrix room; a caller from this server may have that one for their own name (as the apps write it).
// Fails closed: when Synapse can't be asked the answer is 502, never a pass-through.
// Owner switch: CALL_TOKEN_ROOM_CHECK=off (`tinhat api-limits CALL_TOKEN_ROOM_CHECK=off`) hands every request to lk-jwt
// unchanged, as before 0.3.7. Default on.
// Nothing here logs a token.
import { createHash } from "node:crypto";
import { RateLimit, clientKey, mono, ROOM_ID_RE, safe } from "./reachcommon.mjs";
import { createFedResolver } from "./fedresolve.mjs";

export const CALLTOKEN = Object.freeze({
    MAX_BODY: 16 * 1024,
    PER_CLIENT_PER_MIN: 120,    // token requests per caller address (a whole home behind one IPv4 shares it)
    LOOKUPS_PER_CLIENT_MIN: 120, // sign-in lookups for tokens not seen before (and every other server's sign-in, which
    LOOKUPS_GLOBAL_MIN: 600,    // lk-jwt looks up), per caller address / for everyone together
    USER_TTL_MS: 60_000,        // a resolved sign-in, at most
    BAD_TTL_MS: 10_000,         // a refused sign-in
    UPSTREAM_MS: 15_000,
});

const LEGACY_KEYS = new Set(["room", "openid_token", "device_id"]);
// MSC4195 as lk-jwt 0.4.0 reads it, plus the delayed-leave fields current Element Call adds (delay_id, delay_timeout,
// delay_cs_api_url: element-call sdk/src/media-backend/livekit/auth/openID.ts; read and dropped, see translateToken)
const TOKEN_KEYS = new Set(["room_id", "slot_id", "openid_token", "member", "delayed_event_id", "delay_id", "delay_timeout", "delay_cs_api_url"]);
/** The one MatrixRTC slot Tin Hat calls run in (Element Call's room call). */
export const ROOM_SLOT = "m.call#ROOM";
const OPENID_KEYS = new Set(["access_token", "token_type", "matrix_server_name", "expires_in"]);
const MEMBER_KEYS = new Set(["id", "claimed_user_id", "claimed_device_id"]);
const MXID_RE = /^@[^:\s]{1,255}:([A-Za-z0-9.-]{1,255}(?::\d{1,5})?|\[[0-9A-Fa-f:.]{2,45}\](?::\d{1,5})?)$/;
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
            if (r.device_id.includes(":")) return { error: "device_id may not contain ':'" };
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
    if (r.member.claimed_device_id.includes(":")) return { status: 400, error: "claimed_device_id may not contain ':'" };
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

/** The payload of a JWT lk-jwt just minted (its own answer on loopback: decoded, not verified). */
function jwtPayload(jwt) {
    const p = String(jwt || "").split(".");
    if (p.length !== 3) return null;
    try { return JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")); } catch { return null; }
}

/**
 * deps: { hs: {get(path, token)} (createHs, the internal Synapse), adminToken, serverName, lkJwtUrl,
 *         enabled: () => bool, fetchImpl, now, log, federation?: {userinfo(server, token) -> {sub}|null} (fedresolve) }
 */
export function createCallToken(deps) {
    const { hs, adminToken, serverName, lkJwtUrl } = deps;
    const fetchImpl = deps.fetchImpl || fetch;
    const now = deps.now || mono;
    const log = deps.log || ((s) => console.log(s));
    const enabled = deps.enabled || (() => true);
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
    async function localUser(o, ip) {
        const key = sha(o.access_token);
        const hit = users.get(key);
        if (hit && hit.exp > now()) return hit.user;
        return once(`u:${key}`, async () => {
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

            if (!on) {  // the owner's switch: lk-jwt alone decides, as before 0.3.7
                const up = await pass(raw);
                return up ? relay(up) : undefined;
            }

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
                if (!local && !ROOM_ID_RE.test(room)) { log("[calltoken] refused: not a room id (remote caller)"); return refuse(res, "not-member"); }
                user = local ? await localUser(o, ip) : await remoteUser(o, ip);
                if (!user) return send(res, 401, { errcode: "M_UNAUTHORIZED", error: "The request could not be authorised." });
                // MSC4195: the member it claims to be must be the caller (lk-jwt's own rule for /get_token)
                if (r.msc4195 && r.claimed_user_id !== user) return send(res, 401, { errcode: "M_UNAUTHORIZED", error: "The request could not be authorised." });
                if (!(local && isOwnConnTestRoom(room, user))) {  // (the connection test's scratch room: this caller's own)
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

            const up = await pass(canonicalBody(r), r.msc4195 ? "/sfu/get" : path);
            if (!up) return undefined;
            // hand out lk-jwt's token only for the identity that was checked (defence in depth: lk-jwt resolved the
            // sign-in again itself)
            if (up.status === 200 && !(local && isOwnConnTestRoom(room, user))) {
                let ok = false;
                try {
                    const p = jwtPayload(JSON.parse(up.text).jwt);
                    const id = String(p?.sub || "");
                    const suffix = `:${r.device_id}`;
                    const mxid = id.endsWith(suffix) ? id.slice(0, id.length - suffix.length) : "";
                    if (p?.video?.room === room && mxid && serverOf(mxid) === o.matrix_server_name) ok = mxid === user;
                } catch { ok = false; }
                if (!ok) { log(`[calltoken] dropped a minted token: not a joined member (${where} caller)`); return refuse(res, "not-member"); }
            }
            return relay(up);
        };
    }

    return {
        handler,
        notFound: (_req, res) => send(res, 404, { errcode: "M_NOT_FOUND", error: "not found" }),
        _users: users,
    };
}

/** Mount on the API (registered before its shared limiter and JSON parser: this route reads its own body). */
export function installCallToken(app, deps) {
    const ct = createCallToken(deps);
    app.all("/calltoken/sfu/get", safe("calltoken", ct.handler("/sfu/get")));
    app.all("/calltoken/get_token", safe("calltoken", ct.handler("/get_token")));
    app.all(/^\/calltoken(?:\/|$)/, ct.notFound);
    return ct;
}
