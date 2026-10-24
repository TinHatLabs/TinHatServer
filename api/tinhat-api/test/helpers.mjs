// Test doubles for the Reach server modules: Express-shaped req/res, a scripted homeserver, a recording
// fetch and a hand-driven clock. No npm dependency (express is not installed next to the vendored copy).
import { Readable } from "node:stream";
import { createMatrixAuth } from "../reachcommon.mjs";

export function clock(start = 1_700_000_000_000) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; return t; };
    return now;
}

export function fakeReq({ method = "GET", headers = {}, query = {}, body } = {}) {
    const buf = body === undefined ? Buffer.alloc(0)
        : Buffer.isBuffer(body) ? body
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = Readable.from(buf.length ? [buf] : [], { objectMode: false });
    req.method = method;
    req.headers = { ...headers };
    if (buf.length && req.headers["content-length"] === undefined) req.headers["content-length"] = String(buf.length);
    req.query = query;
    return req;
}

export function fakeRes() {
    const res = { statusCode: 200, headers: {}, body: undefined, ended: false, headersSent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.json = (o) => { res.body = o; res.ended = res.headersSent = true; return res; };
    res.end = () => { res.ended = res.headersSent = true; return res; };
    return res;
}

export async function call(handler, opts = {}) {
    const res = fakeRes();
    await handler(fakeReq(opts), res);
    return res;
}

export const bearer = (token) => ({ authorization: `Bearer ${token}` });

/**
 * A scripted homeserver. `state` is mutable by the test:
 *   tokens:   token -> {user, device}
 *   share:    mxid -> bool (account data dev.tinhat.presence.share; absent = no account data)
 *   rooms:    mxid -> [room ids]
 *   members:  room -> joined member count
 *   pushers:  mxid -> [{app_id, pushkey}]
 *   tz:       mxid -> dev.tinhat.presence_tz content (widgets W1 "Friends' clocks"; absent = no such account data)
 *   membersDown: room ids whose member list lookup fails
 *   down:     true -> every call throws (Synapse unreachable)
 */
export function fakeHomeserver(state = {}) {
    const s = { tokens: {}, share: {}, rooms: {}, members: {}, pushers: {}, tz: {}, membersDown: [], down: false, ...state };
    const calls = [];
    const userOf = (token) => s.tokens[token];
    async function get(path, token) {
        calls.push(path);
        if (s.down) throw new Error("connect ECONNREFUSED");
        let m;
        if (path === "/_matrix/client/v3/account/whoami") {
            const u = userOf(token);
            return u ? { ok: true, status: 200, body: { user_id: u.user, device_id: u.device } }
                : { ok: false, status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } };
        }
        if (path === "/_matrix/client/v3/pushers") {
            const u = userOf(token);
            if (!u) return { ok: false, status: 401, body: {} };
            return { ok: true, status: 200, body: { pushers: s.pushers[u.user] || [] } };
        }
        if ((m = /^\/_synapse\/admin\/v1\/users\/([^/]+)\/accountdata$/.exec(path))) {
            const mxid = decodeURIComponent(m[1]);
            const global = mxid in s.share ? { "dev.tinhat.presence": { share: s.share[mxid], asked: true, v: 1 } } : {};
            if (mxid in s.tz) global["dev.tinhat.presence_tz"] = s.tz[mxid];
            return { ok: true, status: 200, body: { account_data: { global, rooms: {} } } };
        }
        if ((m = /^\/_synapse\/admin\/v1\/users\/([^/]+)\/joined_rooms$/.exec(path))) {
            const rooms = s.rooms[decodeURIComponent(m[1])] || [];
            return { ok: true, status: 200, body: { joined_rooms: rooms, total: rooms.length } };
        }
        if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)\/members$/.exec(path))) {
            const room = decodeURIComponent(m[1]);
            if (s.membersDown.includes(room)) return { ok: false, status: 500, body: {} };
            const members = Object.entries(s.rooms).filter(([, rs]) => rs.includes(room)).map(([u]) => u);
            return { ok: true, status: 200, body: { members, total: members.length } };
        }
        if ((m = /^\/_synapse\/admin\/v1\/rooms\/([^/]+)$/.exec(path))) {
            const room = decodeURIComponent(m[1]);
            if (!(room in s.members)) return { ok: false, status: 404, body: {} };
            return { ok: true, status: 200, body: { room_id: room, joined_members: s.members[room] } };
        }
        return { ok: false, status: 404, body: {} };
    }
    const count = (re) => calls.filter((p) => re.test(p)).length;
    return { state: s, calls, count, get };
}

export function authFor(hs, now) {
    return createMatrixAuth({ hs, now });
}

/** A fetch double: statusFor(url, init) -> status (default 201); records every call. */
export function fakeFetch(statusFor = () => 201) {
    const calls = [];
    const f = async (url, init) => {
        calls.push({ url, init });
        const status = statusFor(url, init);
        if (status instanceof Error) throw status;
        return new Response(status === 204 ? null : JSON.stringify(status >= 300 ? { reason: "BadDeviceToken" } : {}), { status });
    };
    f.calls = calls;
    return f;
}
