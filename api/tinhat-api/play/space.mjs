// A room's game space (GAMES-V1-SPEC §1.1, rev 2) and the ONE place the games code reads Synapse's admin API.
//
// launch-gate (2026-11-19 10:18, binding): the games' use of the Synapse admin API is READ-ONLY state lookups: an
// allow-listed set of GET endpoints in this ONE module, tested to refuse anything else (any other method or path). The
// games code never holds a general admin capability: it gets `createStateReader(...)`'s two read functions, never the
// token. Allowed: GET /_synapse/admin/v1/rooms/<room id>/state. Nothing else.
import { roomView } from "../ring.mjs";

// ---------------------------------------------------------------------------------------------- the pure rule
const cmpCodePoints = (a, b) => {
    const x = Array.from(a), y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = x[i].codePointAt(0) - y[i].codePointAt(0);
        if (d) return d;
    }
    return x.length - y.length;
};
const validVia = (c) => c && Array.isArray(c.via) && c.via.length >= 1 && c.via.length <= 20
    && c.via.every((v) => typeof v === "string" && [...v].length >= 1 && [...v].length <= 255);
const serverOfMxid = (m) => (typeof m === "string" && m.startsWith("@") && m.indexOf(":") > 1 ? m.slice(m.indexOf(":") + 1) : null);

/**
 * game_space (vectors/client-rules.json): ctx = {mode: "server"|"app", decider?, room: {id, create_type?, parents:
 * [{space, content}]}, spaces: {id: {create_sender, create_type, children: [{room, content}], partial?}}} →
 * {space, server, why} with why "" | "is-space" | "no-space" | "unavailable" | "wrong-server" (server mode).
 */
export function gameSpace(ctx) {
    const none = (why) => ({ space: null, server: null, why });
    const room = ctx.room || {};
    if (room.create_type === "m.space") return none("is-space");
    const cands = (room.parents || []).filter((p) => p && typeof p.space === "string" && validVia(p.content))
        .sort((a, b) => {
            const ca = a.content.canonical === true ? 0 : 1, cb = b.content.canonical === true ? 0 : 1;
            return ca - cb || cmpCodePoints(a.space, b.space);
        });
    for (const p of cands) {
        const s = (ctx.spaces || {})[p.space];
        if (!s || s.partial) return none("unavailable"); // never skipped: two deciders must never pick two economies
        if (s.create_type !== "m.space") continue;
        const back = (s.children || []).some((c) => c && c.room === room.id && validVia(c.content));
        if (!back) continue;
        const owner = serverOfMxid(s.create_sender);
        if (!owner) continue;
        if (ctx.mode === "server" && owner !== ctx.decider) return { space: p.space, server: owner, why: "wrong-server" };
        return { space: p.space, server: owner, why: "" };
    }
    return none("no-space");
}

/** rank_context (vectors/client-rules.json): which space's rank a surface shows. */
export function rankContext(surface) {
    if (surface?.kind === "room") return { space: surface.game_space ?? null };
    if (surface?.kind === "space") return { space: surface.space ?? null };
    return { space: null };
}

// ---------------------------------------------------------------------------------------------- the reader
export const ALLOWED = Object.freeze([{ method: "GET", path: /^\/_synapse\/admin\/v1\/rooms\/(?:!|%21)[A-Za-z0-9._~=+\-%]+\/state$/ }]);

/** Throws unless (method, path) is on the allow-list. Exported so the test can show it refuses everything else. */
export function checkAllowed(method, path) {
    const ok = ALLOWED.some((a) => a.method === method && a.path.test(path));
    if (!ok) throw Object.assign(new Error(`play: the games may not call ${method} ${path}`), { code: "refused" });
}

/**
 * The games' only handle on Synapse's admin API. `call(method, path, token)` is the HTTP client (reachcommon createHs's
 * `call`); the token stays inside this closure. Returns {roomState(roomId)}: the room's current state events, or null
 * when this server doesn't hold the room (404/403: unknown → "unavailable" upstream).
 */
export function createStateReader({ call, adminToken }) {
    async function get(path) {
        checkAllowed("GET", path);
        return call("GET", path, adminToken);
    }
    return {
        async roomState(roomId) {
            const r = await get(`/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`);
            if (r.status === 404 || r.status === 403 || r.status === 400) return null;
            if (!r.ok) throw new Error(`room state answered ${r.status}`);
            return Array.isArray(r.body?.state) ? r.body.state : null;
        },
    };
}

// ---------------------------------------------------------------------------------------------- resolving a room
const SPACE_TYPES = { parent: "m.space.parent", child: "m.space.child", create: "m.room.create" };
function createOf(events) {
    const c = events.find((e) => e?.type === SPACE_TYPES.create && e.state_key === "");
    return c ? { sender: c.sender, type: c.content?.type ?? null } : null;
}
/** The ctx the pure rule takes, from this server's current full state of the room and of its candidate spaces. */
export async function stateCtx(reader, roomId, decider) {
    const ev = await reader.roomState(roomId);
    if (!ev) return { unknownRoom: true };
    const create = createOf(ev);
    const parents = ev.filter((e) => e?.type === SPACE_TYPES.parent && typeof e.state_key === "string").map((e) => ({ space: e.state_key, content: e.content || {} }));
    const spaces = {};
    for (const p of parents) {
        if (spaces[p.space]) continue;
        const sev = await reader.roomState(p.space);
        if (!sev) continue; // not held: the rule says "unavailable" if it gets to this candidate
        const sc = createOf(sev);
        if (!sc) continue; // no create event = not held in full
        spaces[p.space] = {
            create_sender: sc.sender, create_type: sc.type,
            children: sev.filter((e) => e?.type === SPACE_TYPES.child && typeof e.state_key === "string").map((e) => ({ room: e.state_key, content: e.content || {} })),
            members: sev,
        };
    }
    return { mode: "server", decider, room: { id: roomId, create_type: create ? create.type : null, parents }, spaces, roomEvents: ev };
}

/**
 * spaceInfo(spaceId) → {owner, joined: Set of mxids} | null: a space's creator's server and its joined members, from this
 * server's current full state (null when the room isn't held or isn't a space). `joined` holds ids only.
 */
export function createSpaceInfo(reader, { now = Date.now } = {}) {
    return async function spaceInfo(spaceId) {
        const ev = await reader.roomState(spaceId);
        if (!ev) return null;
        const create = ev.find((e) => e?.type === "m.room.create" && e.state_key === "");
        if (!create || create.content?.type !== "m.space") return null;
        const owner = typeof create.sender === "string" ? create.sender.slice(create.sender.indexOf(":") + 1) : null;
        return { owner, joined: new Set(roomView(ev, now()).joined.keys()) };
    };
}

/**
 * createSpaces({reader, serverName, now}) → {resolve(room, {fresh}) → {space, server, why, room: {joined, sessions},
 * spaceJoined}} with a 30 s cache for listings (admission passes fresh: true: current state, §1.1).
 */
export function createSpaces({ reader, serverName, now = Date.now, ttlMs = 30_000 }) {
    const cache = new Map();
    async function resolve(roomId, { fresh = false } = {}) {
        const hit = cache.get(roomId);
        if (!fresh && hit && hit.exp > now()) return hit.v;
        const ctx = await stateCtx(reader, roomId, serverName);
        let v;
        if (ctx.unknownRoom) v = { space: null, server: null, why: "unavailable", room: null, spaceJoined: new Set() };
        else {
            const g = gameSpace(ctx);
            const rv = roomView(ctx.roomEvents, now());
            // BRB (§2.3 3): dev.tinhat.afk state with away: true, per person
            rv.away = new Set(ctx.roomEvents.filter((e) => e?.type === "dev.tinhat.afk" && typeof e.state_key === "string" && e.content?.away === true).map((e) => e.state_key));
            const sp = g.space && ctx.spaces[g.space] ? roomView(ctx.spaces[g.space].members, now()) : null;
            v = { ...g, room: rv, spaceJoined: sp ? new Set(sp.joined.keys()) : new Set() };
        }
        cache.set(roomId, { exp: now() + ttlMs, v });
        if (cache.size > 2000) cache.delete(cache.keys().next().value);
        return v;
    }
    return { resolve, forget: (roomId) => cache.delete(roomId) };
}
