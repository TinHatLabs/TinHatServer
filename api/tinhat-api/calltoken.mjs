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
//   - from another server: no request leaves this process for a member-named host (lk-jwt does that lookup, as it
//     always has). The room must have a joined member from the token's server before lk-jwt is asked, and the token
//     lk-jwt mints is handed out only when the identity in it (`<mxid>:<device_id>`) is a joined member; otherwise it is
//     dropped and the answer is 403. (So for that one case lk-jwt signs a token that is then thrown away: resolving a
//     foreign token here would mean a new outbound fetcher to a member-named host.) Users of other servers have
//     restricted access in lk-jwt (LIVEKIT_FULL_ACCESS_HOMESERVERS = this server): nothing is created on the call
//     server for them.
// Membership is read fresh for every request (concurrent ones for a room share one read): never a stale list, neither to
// let in someone who has left nor to refuse someone who has just joined.
// MSC4195 requests (`{room_id, slot_id, member}`, on either path) are refused (403 "unsupported"): lk-jwt mints those for
// a hashed room name that call moderation can't govern, with a participant id the client chooses. No Tin Hat app uses
// them; the owner's switch below lets them through again.
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
const TOKEN_KEYS = new Set(["room_id", "slot_id", "openid_token", "member", "delayed_event_id"]);
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
 *         enabled: () => bool, fetchImpl, now, log }
 */
export function createCallToken(deps) {
    const { hs, adminToken, serverName, lkJwtUrl } = deps;
    const fetchImpl = deps.fetchImpl || fetch;
    const now = deps.now || mono;
    const log = deps.log || ((s) => console.log(s));
    const enabled = deps.enabled || (() => true);
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

    /**
     * Whether `test(the room's joined members)` holds, as this server sees the room (false: no such room here). Always
     * read fresh: nobody who left or was removed gets a token from a stale list, and nobody who has just joined is
     * refused from one (a cached "no" refused a newcomer whose call join came within 3 s of anyone else's: a guest let
     * in, an invite accepted; assembly-037 gates). Concurrent reads of one room share one request.
     */
    async function isMember(room, test) {
        const set = await once(`r:${room}`, async () => {
            const r = await hs.get(`/_synapse/admin/v1/rooms/${encodeURIComponent(room)}/members`, adminToken);
            let v;
            if (r.status === 404 || r.status === 400) v = null;
            else if (r.ok && Array.isArray(r.body?.members)) v = new Set(r.body.members.filter((m) => typeof m === "string"));
            else throw new Error(`room members said ${r.status}`);
            return v;
        });
        return !!set && test(set);
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
            const pass = async (body) => {
                try { return await upstream(path, body); } catch {
                    send(res, 502, { errcode: "M_UNKNOWN", error: "the call sign-in service isn't answering" });
                    return null;
                }
            };
            const relay = (up) => { res.set("Content-Type", "application/json"); return res.status(up.status).send(up.text); };

            if (!on) {  // the owner's switch: lk-jwt alone decides, as before 0.3.7
                const up = await pass(raw);
                return up ? relay(up) : undefined;
            }

            const r = parseRequest(raw.toString("utf8"), legacyOk);
            if (r.error) return send(res, 400, { errcode: "M_BAD_JSON", error: r.error });
            if (r.kind === "token") {
                log("[calltoken] refused: an MSC4195 request (not supported while the room check is on)");
                return send(res, 403, { errcode: "M_FORBIDDEN", error: "this server's calls use /sfu/get", reason: "unsupported" });
            }
            const o = r.openid;
            const room = r.room;
            const local = o.matrix_server_name === serverName;
            const where = local ? "local" : "remote";

            let user = null;      // the caller, when known before lk-jwt is asked (a sign-in from this server)
            try {
                if (local) {
                    user = await localUser(o, ip);
                    if (!user) return send(res, 401, { errcode: "M_UNAUTHORIZED", error: "The request could not be authorised." });
                } else if (!lookupsClient.hit(ip) || !lookupsGlobal.hit("all")) {
                    throw new Error("busy");  // lk-jwt will look this sign-in up at the server it names
                }
                if (!(local && isOwnConnTestRoom(room, user))) {  // (the connection test's scratch room: this caller's own)
                    if (!ROOM_ID_RE.test(room)) { log(`[calltoken] refused: not a room id (${where} caller)`); return refuse(res, "not-member"); }
                    const ok = await isMember(room, user ? (set) => set.has(user) : (set) => [...set].some((m) => serverOf(m) === o.matrix_server_name));
                    if (!ok) { log(`[calltoken] refused: not a joined member (${where} caller)`); return refuse(res, "not-member"); }
                }
            } catch (e) {
                if (e?.message === "busy") { res.set("Retry-After", "10"); return send(res, 429, { errcode: "M_LIMIT_EXCEEDED", error: "too many call sign-in checks, try again shortly" }); }
                log(`[calltoken] check failed: ${e?.message || e}`);
                return send(res, 502, { errcode: "M_UNKNOWN", error: "couldn't check the room", reason: "check-failed" });
            }

            const up = await pass(canonicalBody(r));
            if (!up) return undefined;
            // lk-jwt resolved the caller itself: hand out its token only for the identity that was checked (this
            // server's caller) or that is a joined member (another server's, read fresh)
            if (up.status === 200 && !(local && isOwnConnTestRoom(room, user))) {
                let ok = false;
                try {
                    const p = jwtPayload(JSON.parse(up.text).jwt);
                    const id = String(p?.sub || "");
                    const suffix = `:${r.device_id}`;
                    const mxid = id.endsWith(suffix) ? id.slice(0, id.length - suffix.length) : "";
                    if (p?.video?.room === room && mxid && serverOf(mxid) === o.matrix_server_name) {
                        if (user) ok = mxid === user;
                        else ok = await isMember(room, (set) => set.has(mxid));
                    }
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
