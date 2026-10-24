// presence.mjs — opt-in presence for Tin Hat (Reach, 10.6; contract docs/REACH.md §2.3 + A2.3, A2.4, A4.4).
//
//   PUT    /presence              {state: "online"|"away", call: "<room id>"|null, client: "desktop"|"web", refresh?: true}
//                                 -> 200 {ok: true, every: 30, ttl: 90}  |  409 {error: "not_sharing"}
//   DELETE /presence              -> 204  the off switch: every entry of the caller + their cached opt-in
//   DELETE /presence?device=this  -> 204  sign-out: only the calling device
//   GET    /presence              -> 200 {users: {"<mxid>": {state, room?, status?}}, every: 20}
//                                    state "online"|"away"|"call"; status {text, emoji, color} (A4)
//   GET    /presence?tz=1         -> the same + `tz` ("<IANA zone>") for every user who shares a joined room with the
//                                    reader and whose `dev.tinhat.presence_tz` says share: true — a user who shares a
//                                    time zone but not presence is listed with `tz` only (no state) (A7, widgets W1)
//   DELETE /presence?what=tz      -> 204  the time zone's off switch: the caller's cached zone goes at once (A7)
//   Authorization: Bearer <Matrix access token>   (Synapse whoami -> user + device; 401 without / when rejected)
//
// The promise to users (§2.1 / A2.1): off by default, nothing kept, gone at once when switched off. So:
//   • the opt-in is checked HERE, from the account data `dev.tinhat.presence` {share, v} read with the admin
//     token (only a positive answer is cached, 20 s; the same read carries `dev.tinhat.presence_status`);
//     a client that keeps beating after its owner switched off gets 409 and every entry of that user goes;
//   • a per-user revocation GENERATION is retired by every off switch and every not_sharing drop (A2.3); requests
//     hold the generation they started under, account-data reads, their cache writes and their coalescing are tied
//     to it, so a read that raced a revocation is thrown away and a beat that raced one is not stored; generations
//     live only while a request references them (no per-user record is kept afterwards);
//   • entries live in memory only, 90 s TTL on a monotonic clock, swept every 30 s;
//   • a reader sees a user only if both are joined to at least one common room (admin joined_rooms, 30 s;
//     a lookup error = not listed); `room` (which call) only if the reader is joined to that room;
//   • logs carry counts, never who or what.
// Only IDENTICAL beats from one device < 5 s apart are acknowledged without processing; a changed state is
// always applied (A2.3). `refresh: true` re-reads the account data now (at most once per 5 s per user) so a
// status or share change shows at once (A4.4).
// Time zones (A7, widgets W1 "Friends' clocks", 2026-09-28; sharing is opt-OUT in the apps):
// served only to readers that ask (`?tz=1`, so older apps get exactly the old answer), only for users whose account
// data `dev.tinhat.presence_tz` says `share: true` with a valid zone, and only to readers sharing a joined room with
// them (the members of the reader's rooms, admin API, 60 s per room; a lookup error = not listed). A user's answer is
// cached 20 s (share or not — a negative answer can only hide), tied to a per-user generation that the owner's
// `DELETE ?what=tz` (sent right after they write share: false) retires at once. Logs carry counts only.
import { RateLimit, isObj, mono, noStore, readJson, ROOM_ID_RE, safe, UNSAFE_TEXT, wall } from "./reachcommon.mjs";

export const PRESENCE = Object.freeze({
    TTL_MS: 90_000,
    PUT_EVERY: 30,
    GET_EVERY: 20,
    COALESCE_MS: 5_000,
    REFRESH_MIN_MS: 5_000,
    SHARE_CACHE_MS: 20_000,
    ROOMS_CACHE_MS: 30_000,
    GET_MIN_MS: 5_000,
    BODY_LIMIT: 1024,
    MAX_DEVICES: 16,
    SWEEP_MS: 30_000,
});
export const PRESENCE_ACCOUNT_DATA = "dev.tinhat.presence";
export const STATUS_ACCOUNT_DATA = "dev.tinhat.presence_status";
export const TZ_ACCOUNT_DATA = "dev.tinhat.presence_tz";
export const TZ = Object.freeze({ CACHE_MS: 20_000, MEMBERS_CACHE_MS: 60_000, MAX_ROOMS: 200, MAX_PEOPLE: 500 });
const TZ_RE = /^(UTC|[A-Za-z][A-Za-z0-9_+-]{0,30}(\/[A-Za-z0-9_+-]{1,30}){1,2})$/;

/** `dev.tinhat.presence_tz` content -> the zone it shares, or null: `share === true` and `tz` an IANA-shaped name
 *  (Area/Location[/Sub], or UTC; ≤ 64 characters). Anything else shares nothing. */
export function sharedZone(v) {
    if (!isObj(v) || v.share !== true || typeof v.tz !== "string") return null;
    const tz = v.tz;
    return tz.length <= 64 && TZ_RE.test(tz) ? tz : null;
}
export const PALETTE = Object.freeze(["blurple", "teal", "purple", "orange", "red", "blue", "grey", "pink", "yellow", "lime", "cyan", "white"]);
const PALETTE_SET = new Set(PALETTE);

/** A PUT body -> {state, call, client, refresh} or null when malformed. */
export function validateBeat(v) {
    if (!isObj(v)) return null;
    if (v.state !== "online" && v.state !== "away") return null;
    const call = v.call ?? null;
    if (call !== null && (typeof call !== "string" || !ROOM_ID_RE.test(call))) return null;
    const client = v.client ?? null;
    if (client !== null && client !== "desktop" && client !== "web") return null;
    if (v.refresh !== undefined && typeof v.refresh !== "boolean") return null;
    return { state: v.state, call, client, refresh: v.refresh === true };
}

/**
 * A custom status (A4.4) -> {text, emoji, color, until} or null. Invalid is ignored, never an error:
 * text 1–40 characters after trim, emoji ≤ 16 UTF-8 bytes, color a palette key, until null or in the future.
 */
export function validStatus(s, nowWall) {
    if (!isObj(s) || typeof s.text !== "string") return null;
    const text = s.text.trim();
    const n = Array.from(text).length;
    if (n < 1 || n > 40 || UNSAFE_TEXT.test(text)) return null;
    const emoji = s.emoji ?? "";
    if (typeof emoji !== "string" || Buffer.byteLength(emoji, "utf8") > 16 || UNSAFE_TEXT.test(emoji)) return null;
    if (typeof s.color !== "string" || !PALETTE_SET.has(s.color)) return null;
    const until = s.until ?? null;
    if (until !== null && !(typeof until === "number" && Number.isFinite(until) && until > nowWall)) return null;
    return { text, emoji, color: s.color, until };
}

/** Live devices of one user -> {state, room?}: any call -> call (newest beat's room); else any online; else away. */
export function aggregate(devices) {
    let inCall = null, online = false;
    for (const d of devices) {
        if (d.call) { if (!inCall || d.at > inCall.at) inCall = d; }
        else if (d.state === "online") online = true;
    }
    if (inCall) return { state: "call", room: inCall.call };
    return { state: online ? "online" : "away" };
}

/**
 * Revocation generations (A2.3), compared by IDENTITY, never by number. A request acquire()s the current generation
 * of a key before its first await and release()s it when done; revoke() retires it, so every holder sees that it is
 * no longer current(). The map keeps a key only while some request references its generation — nothing about a user
 * or a device outlives the requests — and a retired or forgotten generation is never handed out again (the next
 * acquire() creates a new object), so a holder can never see its old generation become current again (no ABA).
 */
export class Generations {
    constructor() { this.m = new Map(); }
    acquire(key) {
        let g = this.m.get(key);
        if (!g) { g = { refs: 0 }; this.m.set(key, g); }
        g.refs++;
        return g;
    }
    release(key, g) {
        g.refs--;
        if (g.refs <= 0 && this.m.get(key) === g) this.m.delete(key);
    }
    isCurrent(key, g) { return this.m.get(key) === g; }
    revoke(key) { this.m.delete(key); }
    get size() { return this.m.size; }
}

/**
 * The store + handlers, without Express. deps: {auth, hs, adminToken, now? (monotonic ms), wallNow?, log?,
 * getMinMs? (tests only)}.
 * Handlers take (req, res) with req.headers/req.query/body stream and res.status().json()/.end()/.set().
 */
export function createPresence(deps) {
    const { auth, hs, adminToken } = deps;
    const now = deps.now || mono;
    const wallNow = deps.wallNow || wall;
    const log = deps.log || ((s) => console.log(s));
    const C = PRESENCE;

    const users = new Map();       // mxid -> Map(device -> {state, call, client, at})
    const gens = new Generations();    // mxid: revoked by DELETE and by every not_sharing drop (A2.3)
    const devGens = new Generations(); // mxid\0device: revoked by DELETE ?device=this
    const optCache = new Map();    // mxid -> {exp, status}   positive opt-in answers only
    const roomsCache = new Map();  // mxid -> {rooms: Set, exp}
    const lastRefresh = new Map(); // mxid -> t
    const roomsInflight = new Map(); // mxid -> Promise (joined rooms are not consent: plain coalescing is fine)
    const putLimit = new RateLimit(60, 60_000, now);          // per user
    const getLimit = new RateLimit(1, deps.getMinMs ?? C.GET_MIN_MS, now); // per token (A2.4)
    const stats = { beats: 0, coalesced: 0, notSharing: 0, deletes: 0, gets: 0, adminReads: 0, errors: 0, limited: 0, tzGets: 0, tzListed: 0, tzOff: 0 };
    const tzCache = new Map();      // mxid -> {exp, tz|null}   (both answers, 20 s; the owner's DELETE ?what=tz drops it)
    const tzGens = new Generations(); // mxid: retired by DELETE ?what=tz (a read that raced it is not cached)
    const membersCache = new Map(); // room -> {members: Set, exp}
    const membersInflight = new Map();

    const live = (e, t) => t - e.at <= C.TTL_MS;

    function sweep() {
        const t = now();
        for (const [u, devs] of users) {
            for (const [d, e] of devs) if (!live(e, t)) devs.delete(d);
            if (!devs.size) users.delete(u);
        }
        for (const [k, v] of optCache) if (v.exp <= t) optCache.delete(k);
        for (const [k, v] of roomsCache) if (v.exp <= t) roomsCache.delete(k);
        for (const [k, v] of tzCache) if (v.exp <= t) tzCache.delete(k);
        for (const [k, v] of membersCache) if (v.exp <= t) membersCache.delete(k);
        for (const [k, v] of lastRefresh) if (t - v >= C.REFRESH_MIN_MS) lastRefresh.delete(k);
        putLimit.sweep();
        getLimit.sweep();
    }
    /** The off switch / a not_sharing answer: entries, cached opt-in and the generation all go at once. */
    function dropUser(mxid) {
        users.delete(mxid);
        optCache.delete(mxid);
        gens.revoke(mxid);
    }

    /**
     * {share, status} for a user, read under generation `g` (which the caller holds). A positive answer is cached
     * 20 s (with the status from the same read); a negative one never. Concurrent reads coalesce only within one
     * generation, and a read that was revoked while it ran never touches the cache (its caller refuses it too).
     * `fresh` skips the cache. Throws if Synapse can't be asked.
     */
    function optIn(mxid, g, fresh = false) {
        if (!fresh) {
            const c = optCache.get(mxid);
            if (c && c.exp > now()) return Promise.resolve({ share: true, status: c.status });
        }
        const slot = fresh ? "freshRead" : "read";
        if (g[slot]) return g[slot];
        const p = (async () => {
            stats.adminReads++;
            const r = await hs.get(`/_synapse/admin/v1/users/${encodeURIComponent(mxid)}/accountdata`, adminToken);
            let share = false, status = null;
            if (r.status !== 404) {
                if (!r.ok) throw new Error(`accountdata said ${r.status}`);
                const global = r.body?.account_data?.global || {};
                share = global[PRESENCE_ACCOUNT_DATA]?.share === true;
                status = share ? validStatus(global[STATUS_ACCOUNT_DATA], wallNow()) : null;
            }
            if (gens.isCurrent(mxid, g)) {
                if (share) optCache.set(mxid, { exp: now() + C.SHARE_CACHE_MS, status });
                else optCache.delete(mxid);
            }
            return { share, status };
        })();
        g[slot] = p;
        const clear = () => { if (g[slot] === p) g[slot] = null; };
        p.then(clear, clear);
        return p;
    }

    /** The user's joined rooms (admin API), cached 30 s. Throws if Synapse fails. */
    async function joinedRooms(mxid) {
        const c = roomsCache.get(mxid);
        if (c && c.exp > now()) return c.rooms;
        if (roomsInflight.has(mxid)) return roomsInflight.get(mxid);
        const p = (async () => {
            stats.adminReads++;
            const r = await hs.get(`/_synapse/admin/v1/users/${encodeURIComponent(mxid)}/joined_rooms`, adminToken);
            if (!r.ok) throw new Error(`joined_rooms said ${r.status}`);
            const rooms = new Set(Array.isArray(r.body?.joined_rooms) ? r.body.joined_rooms : []);
            roomsCache.set(mxid, { rooms, exp: now() + C.ROOMS_CACHE_MS });
            return rooms;
        })();
        roomsInflight.set(mxid, p);
        const clear = () => { if (roomsInflight.get(mxid) === p) roomsInflight.delete(mxid); };
        p.then(clear, clear);
        return p;
    }

    /** The joined members of `room` (admin API), cached 60 s. Throws if Synapse fails. */
    async function roomMembers(room) {
        const c = membersCache.get(room);
        if (c && c.exp > now()) return c.members;
        if (membersInflight.has(room)) return membersInflight.get(room);
        const p = (async () => {
            stats.adminReads++;
            const r = await hs.get(`/_synapse/admin/v1/rooms/${encodeURIComponent(room)}/members`, adminToken);
            if (!r.ok) throw new Error(`members said ${r.status}`);
            const members = new Set(Array.isArray(r.body?.members) ? r.body.members.filter((m) => typeof m === "string") : []);
            membersCache.set(room, { members, exp: now() + TZ.MEMBERS_CACHE_MS });
            return members;
        })();
        membersInflight.set(room, p);
        const clear = () => { if (membersInflight.get(room) === p) membersInflight.delete(room); };
        p.then(clear, clear);
        return p;
    }

    /** The zone `mxid` shares (null = none), read under generation `g` (held by the caller); cached 20 s unless the
     *  generation was retired while the read ran. Throws if Synapse can't be asked. */
    async function tzOf(mxid, g) {
        const c = tzCache.get(mxid);
        if (c && c.exp > now()) return c.tz;
        stats.adminReads++;
        const r = await hs.get(`/_synapse/admin/v1/users/${encodeURIComponent(mxid)}/accountdata`, adminToken);
        let tz = null;
        if (r.status !== 404) {
            if (!r.ok) throw new Error(`accountdata said ${r.status}`);
            tz = sharedZone(r.body?.account_data?.global?.[TZ_ACCOUNT_DATA]);
        }
        if (tzGens.isCurrent(mxid, g)) tzCache.set(mxid, { tz, exp: now() + TZ.CACHE_MS });
        return tz;
    }

    /** Everyone sharing a joined room with `reader` (the reader included) -> the zone each shares. Fail closed: a room
     *  whose members can't be read adds nobody, a user whose account data can't be read is not listed. */
    async function zonesFor(reader, mine) {
        const people = new Set([reader]);
        const rooms = [...mine].slice(0, TZ.MAX_ROOMS);
        const lists = await Promise.all(rooms.map((r) => roomMembers(r).catch(() => { stats.errors++; return new Set(); })));
        for (const l of lists) for (const m of l) if (people.size < TZ.MAX_PEOPLE) people.add(m);
        const held = [...people].map((m) => [m, tzGens.acquire(m)]);
        try {
            const zones = await Promise.all(held.map(async ([m, g]) => {
                try { return [m, g, await tzOf(m, g)]; } catch { stats.errors++; return [m, g, null]; }
            }));
            const out = new Map();
            for (const [m, g, tz] of zones) if (tz && tzGens.isCurrent(m, g)) out.set(m, tz);
            return out;
        } finally {
            for (const [m, g] of held) tzGens.release(m, g);
        }
    }

    const tooMany = (res, lim, key) => {
        stats.limited++;
        res.set("Retry-After", String(lim.retryAfter(key)));
        return res.status(429).json({ error: "too many requests" });
    };
    const OK_PUT = () => ({ ok: true, every: C.PUT_EVERY, ttl: C.TTL_MS / 1000 });

    async function put(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        if (!putLimit.hit(who.user)) return tooMany(res, putLimit, who.user);
        const b = await readJson(req, C.BODY_LIMIT);
        if (!b.ok) return res.status(b.status).json({ error: b.error });
        const beat = validateBeat(b.value);
        if (!beat) return res.status(400).json({ error: 'expected {"state": "online"|"away", "call": "<room id>"|null, "client": "desktop"|"web"}' });

        const t = now();
        let fresh = false;
        if (beat.refresh && t - (lastRefresh.get(who.user) ?? -Infinity) >= C.REFRESH_MIN_MS) {
            fresh = true;
            lastRefresh.set(who.user, t);
        }
        const e = users.get(who.user)?.get(who.device);
        if (!fresh && e && live(e, t) && t - e.at < C.COALESCE_MS
            && e.state === beat.state && e.call === beat.call && e.client === beat.client) {
            stats.coalesced++;
            return res.json(OK_PUT());
        }

        const devKey = who.user + "\0" + who.device;
        const g = gens.acquire(who.user), dg = devGens.acquire(devKey);
        try {
            let opt;
            try { opt = await optIn(who.user, g, fresh); } catch { stats.errors++; return res.status(502).json({ error: "homeserver unreachable" }); }
            // The off switch (or another device's not_sharing) landed while we were asking Synapse: it wins (A2.3),
            // whatever that now-obsolete read said.
            if (!gens.isCurrent(who.user, g)) { stats.notSharing++; return res.status(409).json({ error: "not_sharing" }); }
            if (!opt.share) {
                dropUser(who.user);
                stats.notSharing++;
                return res.status(409).json({ error: "not_sharing" });
            }
            // This device signed out meanwhile: acknowledge, keep nothing.
            if (!devGens.isCurrent(devKey, dg)) return res.json(OK_PUT());

            let devs = users.get(who.user);
            if (!devs) users.set(who.user, (devs = new Map()));
            devs.set(who.device, { state: beat.state, call: beat.call, client: beat.client, at: now() });
            if (devs.size > C.MAX_DEVICES) {
                let oldest = null;
                for (const [d, x] of devs) if (!oldest || x.at < oldest[1].at) oldest = [d, x];
                devs.delete(oldest[0]);
            }
            stats.beats++;
            res.json(OK_PUT());
        } finally {
            gens.release(who.user, g);
            devGens.release(devKey, dg);
        }
    }

    async function del(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        const which = req.query?.device;
        const what = req.query?.what;
        if (what !== undefined && what !== "tz") return res.status(400).json({ error: 'what must be "tz" (or absent)' });
        if (what === "tz") {
            // the time zone's off switch (A7): the caller's cached zone goes, a read racing this is not cached
            tzCache.delete(who.user);
            tzGens.revoke(who.user);
            stats.tzOff++;
            return res.status(204).end();
        }
        if (which !== undefined && which !== "this") return res.status(400).json({ error: 'device must be "this" (or absent for every device)' });
        if (which === "this") {
            // Sign-out of ONE device: only its entry, and only a beat of that device racing this is voided.
            // (The user's generation is left alone: retiring it would 409 the user's other devices, which then stop.)
            const devs = users.get(who.user);
            devs?.delete(who.device);
            if (devs && !devs.size) users.delete(who.user);
            devGens.revoke(who.user + "\0" + who.device);
        } else {
            dropUser(who.user);
        }
        stats.deletes++;
        res.status(204).end();
    }

    async function get(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        if (!getLimit.hit(who.key)) return tooMany(res, getLimit, who.key);

        // Hold every candidate's generation from the start, look everything up, then build the answer in ONE
        // synchronous pass: a user who switched off (or a device that signed out or expired) while some other
        // lookup was still pending can't slip into a row that was built earlier.
        const t0 = now();
        const held = [];
        for (const [mxid, devs] of users) if ([...devs.values()].some((e) => live(e, t0))) held.push([mxid, gens.acquire(mxid)]);
        try {
            let mine;
            try { mine = await joinedRooms(who.user); } catch { stats.errors++; return res.status(502).json({ error: "homeserver unreachable" }); }
            const checked = await Promise.all(held.map(async ([mxid, g]) => {
                try {
                    const opt = await optIn(mxid, g);
                    if (!opt.share) {
                        if (gens.isCurrent(mxid, g)) { dropUser(mxid); stats.notSharing++; }
                        return null;
                    }
                    if (mxid !== who.user) {
                        const theirs = await joinedRooms(mxid);
                        const [small, big] = theirs.size < mine.size ? [theirs, mine] : [mine, theirs];
                        let common = false;
                        for (const r of small) if (big.has(r)) { common = true; break; }
                        if (!common) return null;
                    }
                    return { mxid, g, status: opt.status };
                } catch { stats.errors++; return null; /* fail closed: someone we can't check is simply absent */ }
            }));
            const wantTz = req.query?.tz === "1";
            const zones = wantTz ? await zonesFor(who.user, mine) : null;
            const t = now(), w = wallNow(), out = {};
            for (const c of checked) {
                if (!c || !gens.isCurrent(c.mxid, c.g)) continue;
                const devs = [...(users.get(c.mxid)?.values() || [])].filter((e) => live(e, t));
                if (!devs.length) continue;
                const agg = aggregate(devs);
                const row = { state: agg.state };
                if (agg.state === "call" && agg.room && mine.has(agg.room)) row.room = agg.room;
                const st = c.status;
                if (st && (st.until === null || st.until > w)) row.status = { text: st.text, emoji: st.emoji, color: st.color };
                out[c.mxid] = row;
            }
            if (zones) {
                // a zone re-checked against its generation at the answer (a DELETE ?what=tz during the lookups wins)
                for (const [m, tz] of zones) {
                    if (tzCache.get(m)?.tz !== tz) continue;
                    (out[m] ??= {}).tz = tz;
                    stats.tzListed++;
                }
                stats.tzGets++;
            }
            stats.gets++;
            res.json({ users: out, every: C.GET_EVERY });
        } finally {
            for (const [mxid, g] of held) gens.release(mxid, g);
        }
    }

    function counts() {
        const t = now();
        let devices = 0, people = 0;
        for (const d of users.values()) {
            const n = [...d.values()].filter((e) => live(e, t)).length;
            devices += n;
            if (n) people++;
        }
        return { users: people, devices };
    }

    /** One count-only line (never who/what); resets the counters. Silent when nothing happened. */
    function report() {
        const c = counts();
        const s = { ...stats };
        for (const k of Object.keys(stats)) stats[k] = 0;
        if (!c.users && !Object.values(s).some(Boolean)) return;
        log(`[presence] live ${c.users} user(s) / ${c.devices} device(s); last period: ${s.beats} beats (+${s.coalesced} coalesced), ` +
            `${s.notSharing} not sharing, ${s.deletes} off/sign-out, ${s.gets} reads, ${s.adminReads} admin lookups, ` +
            `${s.limited} rate-limited, ${s.errors} errors; time zones: ${s.tzGets} reads listing ${s.tzListed}, ${s.tzOff} off`);
    }

    return { put, del, get, counts, report, sweep, _users: users, _optCache: optCache, _gens: gens, _devGens: devGens, _tzCache: tzCache, _tzGens: tzGens };
}

/**
 * Mount on the Express app. deps: {auth, hs, adminToken, log?, reportEveryMs?}.
 */
export function installPresence(app, deps) {
    if (!deps.adminToken) {
        console.error("[presence] synapse-admin.token missing -> presence DISABLED");
        const off = (_req, res) => { noStore(res); res.status(503).json({ error: "presence isn't set up on this server" }); };
        app.put("/presence", off); app.delete("/presence", off); app.get("/presence", off);
        return null;
    }
    const p = createPresence(deps);
    app.put("/presence", safe("presence", p.put));
    app.delete("/presence", safe("presence", p.del));
    app.get("/presence", safe("presence", p.get));
    setInterval(() => { try { p.sweep(); deps.auth.sweep?.(); } catch { /* never fatal */ } }, PRESENCE.SWEEP_MS).unref?.();
    const every = deps.reportEveryMs ?? 10 * 60_000;
    if (every > 0) setInterval(() => { try { p.report(); } catch { /* never fatal */ } }, every).unref?.();
    (deps.log || console.log)("[presence] ready — opt-in via account data dev.tinhat.presence, memory only, TTL 90 s; time zones on ?tz=1 (dev.tinhat.presence_tz)");
    return p;
}
