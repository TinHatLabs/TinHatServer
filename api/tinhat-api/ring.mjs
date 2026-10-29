// ring.mjs — DM ringing, the server half (RINGING.md draft 3; contract docs/API.md "Ringing", docs/PHONE-PUSH.md).
//
// A DM call rings the callee's phones and browsers even when no app is open. Nobody sends ring events: call membership
// (`org.matrix.msc3401.call.member`) is plaintext room state, so the server sees "someone started a call in this DM"
// with the apps' own rules and pushes it, encrypted per device like every push (push.mjs), to the callee's registrations.
//
//   POST /_tinhat/v1/call-member {room_id, event_id}   the Synapse module's poke (manager/synapse/tinhat_calls.py), on
//                                                      the push gateway's own listener (Synapse only). It carries
//                                                      nothing we trust: the room is read again through the admin API.
//   POST /push/ring/decline {room, ring}  (bearer)     the callee declined on a device: its other devices stop.
//
// Who may ring whom (the safer reading of the draft, written down in docs/API.md):
//   - only a DM: exactly 2 joined members (push.mjs's DM rule), read from the room's state at that moment;
//   - only members: a call membership counts only while its sender is joined (the guest-leave rule), and it must be
//     live and well-owned (the apps' liveness + state-key rule: callrules.ts sessionsFrom);
//   - no guests on either side (`@guest-…`, the guest room's temporary accounts);
//   - only local callees with a registration whose Synapse pusher still exists (a signed-out device's registration
//     never rings), and only when the callee has NOT muted the room (read from Synapse; unknown = no ring);
//   - the rising edge only: the first live membership of someone else, at most 20 s old, the callee not in the call
//     themselves, and no ring for this DM to this callee in the last 45 s; at most 6 rings a minute per callee;
//   - bounded: TTL 30 s, the devices stop by themselves at 25 s, a ring can be stopped for 60 s.
import { createHmac } from "node:crypto";
import { RateLimit, ROOM_ID_RE, isObj, mono, noStore, readJson, wall } from "./reachcommon.mjs";
import { b64u, parseSubscription, pushkeyFor } from "./webpush.mjs";

export const RING = Object.freeze({
    HOOK_PATH: "/_tinhat/v1/call-member",
    MUTED_PATH: "/_synapse/tinhat/v1/push_muted",
    MEMBER_TYPE: "org.matrix.msc3401.call.member",
    MEMBERSHIP_EXPIRES_MS: 14_400_000,
    FRESH_MS: 20_000, // a membership older than this is no new call (and devices drop a ring older than this)
    GAP_MS: 45_000, // DM_RING_GAP_MS of the apps (REACH A5.7)
    STOP_MS: 60_000, // a ring can be stopped (answered / ended / declined) this long after it went out
    LENGTH_MS: 25_000, // the apps' ring length: devices end by themselves; the server sends nothing for a timeout
    TTL: 30, // seconds, for ring + ring_stop (a late ring is wrong) and for the downgraded "Incoming call" message
    PER_USER_PER_MIN: 6,
    HOOK_PER_MIN: 1200,
    MUTED_CACHE_MS: 15_000,
    SKEW_MS: 60_000, // a membership "created" further in the future than this is ignored for busy tracking
    ROOMS_PER_USER: 50, // busy tracking: rooms remembered per local user
    BUSY_ROOMS_MAX: 30, // a VoIP ring checks at most this many of the callee's other rooms; more = unknown
    BIG_ROOM: 500, // a room with more joined members is never a DM; its state isn't read (busy tracking skips it)
    TRACK_MAX: 20_000,
    BODY_LIMIT: 4096,
    PAYLOAD_MAX: 3072,
    PHONE_PAYLOAD_MAX: 2560,
    NAME_MAX: 64,
});

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const cleanName = (s) => {
    const t = String(s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    const cps = Array.from(t);
    return cps.length > RING.NAME_MAX ? cps.slice(0, RING.NAME_MAX).join("") + "…" : t;
};
export const localpart = (mxid) => String(mxid).replace(/^@/, "").split(":")[0];
export const isGuestId = (mxid) => /^@guest-/i.test(String(mxid));

/** The apps' liveness rule for one session-shaped object (callrules.ts entryLive). */
function entryLive(c, originTs, now) {
    if (!isObj(c) || Object.keys(c).length === 0) return false;
    const created = num(c.created_ts) ?? (originTs > 0 ? originTs : null);
    if (created === null) return true;
    return now <= created + (num(c.expires) ?? RING.MEMBERSHIP_EXPIRES_MS);
}

/** callrules.ts / keyrules.ts stateKeyOwned: the state key belongs to the sender and that device. */
export function stateKeyOwned(stateKey, sender, device, arrayForm) {
    if (!sender) return false;
    if (arrayForm) return stateKey === sender;
    if (!device) return false;
    return stateKey === `_${sender}_${device}_m.call` || stateKey === `_${sender}_${device}`
        || stateKey === `${sender}_${device}` || stateKey === `${sender}_${device}_m.call`;
}

/**
 * Live call sessions among a room's state events (callrules.ts sessionsFrom: typed session form + legacy
 * memberships[], one per (user, device), application m.call / scope m.room, owned state key), each with the event id
 * of the state event it came from. `joined` (a Set) = the room's joined members: a session counts only while its
 * sender is joined (12.1.1's roster rule; a removed guest's leftover membership never rings anyone).
 */
export function liveSessions(events, now, joined) {
    const out = [];
    const seen = new Set();
    for (const ev of events) {
        if (!isObj(ev) || ev.type !== RING.MEMBER_TYPE || typeof ev.state_key !== "string") continue;
        const sender = typeof ev.sender === "string" ? ev.sender : "";
        if (!sender || (joined && !joined.has(sender))) continue;
        const c = isObj(ev.content) ? ev.content : {};
        const origin = num(ev.origin_server_ts) ?? 0;
        const arrayForm = Array.isArray(c.memberships);
        const entries = arrayForm ? c.memberships.filter((m) => isObj(m) && entryLive(m, origin, now)) : entryLive(c, origin, now) ? [c] : [];
        for (const e of entries) {
            if (e.application !== undefined && e.application !== "m.call") continue;
            if (e.scope !== undefined && e.scope !== "m.room") continue;
            const dev = typeof e.device_id === "string" ? e.device_id : "";
            if (!dev || !stateKeyOwned(ev.state_key, sender, dev, arrayForm)) continue;
            const k = `${sender}|${dev}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const created = num(e.created_ts) ?? origin;
            out.push({ sender, device: dev, createdTs: created, eventId: typeof ev.event_id === "string" ? ev.event_id : "",
                expiresAt: created + (num(e.expires) ?? RING.MEMBERSHIP_EXPIRES_MS) });
        }
    }
    return out;
}

/** {joined: Map mxid -> display name, sessions} from a room's state (the admin API's `state` list). */
export function roomView(events, now) {
    const joined = new Map();
    for (const ev of events) {
        if (!isObj(ev) || ev.type !== "m.room.member" || typeof ev.state_key !== "string") continue;
        const c = isObj(ev.content) ? ev.content : {};
        if (c.membership === "join") joined.set(ev.state_key, typeof c.displayname === "string" ? c.displayname : "");
    }
    return { joined, sessions: liveSessions(events, now, new Set(joined.keys())) };
}

/**
 * The ring decision for one callee R of a DM (pure; the table in test/ring.test.mjs). `prev` = whether someone other
 * than R was in the call when we last looked (undefined = never looked: the freshness check alone decides), `lastRing`
 * = when R last got a ring for this room (wall ms). -> {ring: caller session} or {skip: reason}.
 */
export function ringDecision({ me, sessions, prev, lastRing, now, isGuest = isGuestId }) {
    if (isGuest(me)) return { skip: "guest_callee" };
    if (sessions.some((s) => s.sender === me)) return { skip: "in_call" };
    const others = sessions.filter((s) => s.sender !== me && !isGuest(s.sender)).sort((a, b) => a.createdTs - b.createdTs);
    if (!others.length) return { skip: sessions.length ? "guest_caller" : "no_call" };
    if (prev === true) return { skip: "not_rising" };
    const caller = others[0];
    if (now - caller.createdTs > RING.FRESH_MS) return { skip: "stale" };
    if (lastRing !== undefined && now - lastRing < RING.GAP_MS) return { skip: "gap" };
    return { ring: caller };
}

/** Why a live ring stops now (answered: the callee is in the call on any device; ended: nobody else is), or null. */
export function stopReason({ me, sessions, isGuest = isGuestId }) {
    if (sessions.some((s) => s.sender === me)) return "answered";
    if (!sessions.some((s) => s.sender !== me && !isGuest(s.sender))) return "ended";
    return null;
}

/** ring and ring_stop share this Topic (keyed, per subscription, room and ring): on iOS the stop replaces the ring. */
export const ringTopic = (key, pushkey, room, ring) =>
    b64u(createHmac("sha256", key).update(["ring", pushkey, room, ring].map(String).join("\0")).digest()).slice(0, 32);

/** A ring / ring_stop payload as UTF-8, ≤ max bytes (the title is cut first, never room/ring/user). */
export function ringPayload(fields, max) {
    let title = String(fields.title ?? "");
    for (let i = 0; i < 50; i++) {
        const buf = Buffer.from(JSON.stringify({ v: 1, ...fields, title }), "utf8");
        if (buf.length <= max) return buf;
        const n = Array.from(title).length;
        if (n <= 4) break;
        title = Array.from(title).slice(0, Math.floor(n * 0.75)).join("") + "…";
    }
    return Buffer.from(JSON.stringify({ v: 1, kind: fields.kind, room: "", ring: "", title: "Tin Hat", body: "Incoming call", user: "" }), "utf8");
}

const VOIP_RE = /^[A-Za-z0-9_-]{22}$/;
/** A VoIP endpoint at the relay: exactly `<relay>/v/<22 chars>` (iOS PushKit; the relay's apns-voip platform). */
export function checkVoipEndpoint(raw, relay) {
    if (!relay) return { ok: false, reason: "no_relay" };
    if (typeof raw !== "string" || raw.length > 2048) return { ok: false, reason: "bad_voip" };
    const prefix = `${relay}/v/`;
    if (!raw.startsWith(prefix) || !VOIP_RE.test(raw.slice(prefix.length))) return { ok: false, reason: "bad_voip" };
    let u;
    try { u = new URL(raw); } catch { return { ok: false, reason: "bad_voip" }; }
    return u.href === raw ? { ok: true, url: u } : { ok: false, reason: "bad_voip" };
}

/**
 * `rings` of a registration (RINGING.md §6): {v: 1, stop: bool, voip?: "<relay>/v/<id>"}. -> {ok, rings: {...}|null}
 * or {ok: false, reason}. A version this server doesn't speak is taken as "no rings" (the device gets the downgrade),
 * so a newer app still registers; the answer says what was taken. `voip` only with a relay registration.
 */
export function parseRings(v, { relay, viaRelay }) {
    if (v === undefined || v === null) return { ok: true, rings: null };
    if (!isObj(v)) return { ok: false, reason: "bad_rings" };
    if (v.v !== 1) return { ok: true, rings: null };
    if (typeof v.stop !== "boolean") return { ok: false, reason: "bad_rings" };
    const out = { v: 1, stop: v.stop };
    if (v.voip !== undefined && v.voip !== null) {
        if (!viaRelay) return { ok: false, reason: "voip_needs_relay" };
        const c = checkVoipEndpoint(v.voip, relay);
        if (!c.ok) return { ok: false, reason: c.reason };
        out.voip = v.voip;
    }
    return { ok: true, rings: out };
}

/**
 * The engine. ctx (from createPush): {hs, adminToken, serverName, relay, topicKey, kindOf, regs (Map), send(sub,
 * payload, topic, ttl), outcome, dropGone(pk, endpoint), clearVoip(pk, voip), suppressed(pk, t), messagePayload, messageTopic,
 * auth, now, wallNow, log, logError, isGuest?}.
 */
export function createRing(ctx) {
    const { hs, adminToken } = ctx;
    const now = ctx.now || mono;
    const wallNow = ctx.wallNow || wall;
    const log = ctx.log || ((s) => console.log(s));
    const logError = ctx.logError || log;
    const isGuest = ctx.isGuest || isGuestId;
    const serverName = String(ctx.serverName || "");
    const isLocal = (mxid) => !!serverName && String(mxid).endsWith(`:${serverName}`);
    const P = RING;

    const prevOthers = new Map(); // room -> Map user -> until (wall): someone else was in the call when we looked, live till then
    const lastRing = new Map(); // room\0user -> wall ms
    const live = new Map(); // room\0user -> {ring, room, user, caller, title, at (wall), targets, stopped}
    const inCall = new Map(); // local user -> Map room -> expiresAt (wall)
    const mutedCache = new Map(); // user\0room -> {at, muted}
    const running = new Map(); // room -> {again: bool}
    const hookLimit = new RateLimit(P.HOOK_PER_MIN, 60_000, now);
    const userLimit = new RateLimit(P.PER_USER_PER_MIN, 60_000, now);
    const declineLimit = new RateLimit(30, 60_000, now);
    const stats = { pokes: 0, rooms: 0, rings: 0, stops: 0, declines: 0, downgraded: 0, skip: {} };
    const skip = (why) => { stats.skip[why] = (stats.skip[why] || 0) + 1; };
    const enc = encodeURIComponent;

    async function roomState(room) {
        // a big room is never a DM: one light read keeps its (large) state from being fetched for busy tracking
        const d = await hs.get(`/_synapse/admin/v1/rooms/${enc(room)}`, adminToken);
        if (!d.ok) return null;
        if (Number.isInteger(d.body?.joined_members) && d.body.joined_members > P.BIG_ROOM) return { big: true };
        const r = await hs.get(`/_synapse/admin/v1/rooms/${enc(room)}/state`, adminToken);
        return r.ok && Array.isArray(r.body?.state) ? { events: r.body.state } : null;
    }

    /** The user's Synapse pushers (pushkey -> app_id), read fresh before every ring and every stop: a device that
     *  signed out a second ago gets nothing. null = couldn't be read. */
    async function pushersOf(user) {
        const r = await hs.get(`/_synapse/admin/v1/users/${enc(user)}/pushers`, adminToken);
        if (!r.ok || !Array.isArray(r.body?.pushers)) return null;
        const keys = new Map();
        for (const p of r.body.pushers) if (isObj(p) && typeof p.pushkey === "string" && typeof p.app_id === "string") keys.set(p.pushkey, p.app_id);
        return keys;
    }

    /** Is the user in a call in another room right now, read from Synapse (for a VoIP ring, which can't be quiet):
     *  true / false, null = can't tell (too many rooms, a big room, a read failed). */
    async function busyNow(user, room) {
        const r = await hs.get(`/_synapse/admin/v1/users/${enc(user)}/joined_rooms`, adminToken);
        if (!r.ok || !Array.isArray(r.body?.joined_rooms)) return null;
        const others = r.body.joined_rooms.filter((x) => typeof x === "string" && x !== room);
        if (others.length > P.BUSY_ROOMS_MAX) return null;
        let unknown = false;
        for (const o of others) {
            const st = await roomState(o);
            if (!st || st.big) { unknown = true; continue; }
            if (roomView(st.events, wallNow()).sessions.some((x) => x.sender === user)) return true;
        }
        return unknown ? null : false;
    }

    /** true / false, or null when it can't be told (then nobody is rung: a VoIP push can't be taken back); "ignored" when
     *  the user ignores the caller (m.ignored_user_list: Synapse pushes nothing of an ignored user, so no ring either;
     *  assembly-038 review). A module without the answer (older) = not ignored. */
    async function mutedFor(user, room, caller) {
        const k = `${user}\0${room}\0${caller}`;
        const c = mutedCache.get(k);
        if (c && now() - c.at < P.MUTED_CACHE_MS) return c.muted;
        let muted = null;
        try {
            const r = await hs.get(`${P.MUTED_PATH}?user_id=${enc(user)}&room_id=${enc(room)}&caller=${enc(caller)}`, adminToken);
            if (r.ok && typeof r.body?.muted === "boolean") muted = r.body.ignored === true ? "ignored" : r.body.muted;
        } catch { muted = null; }
        if (muted !== null) mutedCache.set(k, { at: now(), muted });
        return muted;
    }

    /** The user's registrations that may get a ring: their Synapse pusher still exists, their subscription parses. */
    async function targetsFor(user) {
        const pushers = await pushersOf(user);
        if (!pushers) return null;
        const out = [];
        for (const [pk, reg] of ctx.regs) {
            if (reg.mxid !== user || !pushers.has(pk)) continue;
            const kind = ctx.kindOf(pushers.get(pk));
            if (!kind) continue;
            const sub = parseSubscription(reg, ctx.relay, kind);
            if (!sub.ok || pushkeyFor(reg.endpoint) !== pk) continue;
            let voip = null;
            if (reg.rings?.voip && sub.viaRelay) {
                // the VoIP subscription is encrypted to the same keys as the registration's own (RINGING.md §6)
                const u = checkVoipEndpoint(reg.rings.voip, ctx.relay);
                if (u.ok) voip = { ...sub, endpoint: u.url, pk: pushkeyFor(reg.rings.voip) };
            }
            out.push({ pk, sub, endpoint: reg.endpoint, phone: sub.viaRelay, rings: reg.rings || null, voip, appId: pushers.get(pk) });
        }
        return out;
    }

    /** One push, one shot (a ring is never retried: a late ring is wrong). `t` = the target (its registration). */
    async function push(t, sub, payload, topic, label, isVoip = false) {
        const r = await ctx.send(sub, payload, topic, P.TTL);
        const o = ctx.outcome(r);
        const pk = isVoip ? sub.pk : t.pk;
        (o === "error" ? logError : log)(`[ring] ${label} ${sub.endpoint.hostname} ${r.status || r.reason} ${r.ms}ms k=${String(pk).slice(0, 6)}${o === "gone" ? " -> gone" : ""}`);
        if (o === "gone") { if (isVoip) ctx.clearVoip(t.pk, t.voip.endpoint.href); else ctx.dropGone(t.pk, t.endpoint); }
        return o;
    }

    async function ring(room, user, caller, title, busy) {
        const targets = await targetsFor(user);
        if (!targets || !targets.length) { skip(targets ? "no_device" : "pushers_unknown"); return; }
        const muted = await mutedFor(user, room, caller.sender);
        if (muted === "ignored") { skip("ignored"); return; }
        if (muted !== false) { skip(muted ? "muted" : "muted_unknown"); return; }
        // A VoIP ring can't be quiet: when nothing we saw says "busy", ask Synapse; can't tell = an alert ring instead
        let voipOk = !busy;
        if (!busy && targets.some((t) => t.rings && t.voip)) {
            const b = await busyNow(user, room);
            if (b === true) busy = true;
            voipOk = b === false;
        }
        // the lookups took time: the call must still be new (a late ring is wrong)
        if (wallNow() - caller.createdTs > P.FRESH_MS) { skip("stale_late"); return; }
        if (!userLimit.hit(user)) { skip("user_limit"); return; }
        const at = wallNow();
        const rec = { ring: caller.eventId, room, user, title, at, stopped: false, stops: [], sending: null };
        live.set(`${room}\0${user}`, rec);
        lastRing.set(`${room}\0${user}`, at);
        stats.rings++;
        const fields = { kind: "ring", room, ring: caller.eventId, caller: caller.sender, title, body: "Incoming call", ts: at, busy, user };
        const jobs = [];
        for (const t of targets) {
            if (!t.rings) {
                // today's apps and service workers: an ordinary message push, today's rules (quiet while at a computer)
                const why = ctx.suppressed(t.pk, now());
                if (why) { skip(why); continue; }
                stats.downgraded++;
                const payload = ctx.messagePayload({ room, event: caller.eventId, title, body: "Incoming call", user }, t.phone);
                jobs.push(push(t, t.sub, payload, ctx.messageTopic(t.pk, room, caller.eventId, t.phone), "message"));
                continue;
            }
            if (t.voip && voipOk) {
                // iOS phase 2: only a non-busy ring goes to PushKit, and never anything else (each becomes a CallKit call)
                const payload = ringPayload(fields, P.PHONE_PAYLOAD_MAX);
                jobs.push(push(t, t.voip, payload, ringTopic(ctx.topicKey, t.voip.pk, room, caller.eventId), "ring voip", true));
                continue;
            }
            const payload = ringPayload(fields, t.phone ? P.PHONE_PAYLOAD_MAX : P.PAYLOAD_MAX);
            jobs.push(push(t, t.sub, payload, ringTopic(ctx.topicKey, t.pk, room, caller.eventId), busy ? "ring busy" : "ring"));
            if (t.rings.stop) rec.stops.push(t);
        }
        rec.sending = Promise.all(jobs);
        await rec.sending;
    }

    async function stop(rec, why) {
        if (rec.stopped) return;
        rec.stopped = why;
        if (wallNow() - rec.at > P.STOP_MS) return;
        // never before the ring itself went out: a stop the push service took first would be replaced by the late ring
        await rec.sending?.catch(() => {});
        // only to devices that are still this person's (registration unchanged, Synapse pusher still there)
        const pushers = rec.stops.length ? await pushersOf(rec.user) : null;
        const to = rec.stops.filter((t) => pushers?.has(t.pk) && ctx.regs.get(t.pk)?.mxid === rec.user && ctx.regs.get(t.pk)?.endpoint === t.endpoint);
        if (!to.length) return;
        stats.stops++;
        const fields = { kind: "ring_stop", room: rec.room, ring: rec.ring, why, title: rec.title, user: rec.user };
        await Promise.all(to.map((t) => push(t, t.sub, ringPayload(fields, t.phone ? P.PHONE_PAYLOAD_MAX : P.PAYLOAD_MAX),
            ringTopic(ctx.topicKey, t.pk, rec.room, rec.ring), `ring_stop ${why}`)));
    }

    function trackInCall(room, sessions) {
        const t = wallNow();
        for (const [u, rooms] of inCall) {
            if (rooms.has(room) && !sessions.some((s) => s.sender === u)) rooms.delete(room);
            if (!rooms.size) inCall.delete(u);
        }
        for (const s of sessions) {
            if (!isLocal(s.sender) || s.expiresAt <= t || s.createdTs > t + P.SKEW_MS) continue;
            if (!inCall.has(s.sender)) {
                if (inCall.size >= P.TRACK_MAX) continue;
                inCall.set(s.sender, new Map());
            }
            const rooms = inCall.get(s.sender);
            if (!rooms.has(room) && rooms.size >= P.ROOMS_PER_USER) continue;
            // the sender's own numbers can't keep an entry for longer than one membership's life from now
            rooms.set(room, Math.min(t + P.MEMBERSHIP_EXPIRES_MS, Math.max(rooms.get(room) || 0, s.expiresAt)));
        }
    }
    const busyElsewhere = (user, room) => {
        const rooms = inCall.get(user);
        if (!rooms) return false;
        const t = wallNow();
        for (const [r, exp] of rooms) if (r !== room && exp > t) return true;
        return false;
    };

    async function processRoom(room) {
        stats.rooms++;
        const st = await roomState(room);
        if (!st) { skip("state_unreadable"); return; }
        if (st.big) { skip("big_room"); return; }
        const t = wallNow();
        const { joined, sessions } = roomView(st.events, t);
        trackInCall(room, sessions);
        // stops first: a live ring for anyone in this room
        for (const [k, rec] of live) {
            if (rec.room !== room || rec.stopped) continue;
            const why = joined.has(rec.user) ? stopReason({ me: rec.user, sessions, isGuest }) : "ended";
            if (why) await stop(rec, why);
        }
        // The edge memory is kept for DMs only (a room that becomes one later starts from "never looked": freshness
        // decides), and only as long as the memberships it saw stay live: a caller whose client died (membership
        // expired, no event) rings again with their next call.
        const isDm = joined.size === 2;
        if (!isDm) { prevOthers.delete(room); return; }
        let edges = prevOthers.get(room);
        if (!edges) {
            if (prevOthers.size >= P.TRACK_MAX) prevOthers.delete(prevOthers.keys().next().value);
            edges = new Map();
            prevOthers.set(room, edges);
        }
        for (const u of edges.keys()) if (!joined.has(u)) edges.delete(u);
        for (const user of joined.keys()) {
            if (!isLocal(user)) continue;
            const k = `${room}\0${user}`;
            const until = edges.get(user);
            const prev = until === undefined ? undefined : until > t;
            const others = sessions.filter((s) => s.sender !== user && !isGuest(s.sender));
            if (others.length) edges.set(user, Math.min(t + P.MEMBERSHIP_EXPIRES_MS, Math.max(...others.map((s) => s.expiresAt))));
            else edges.set(user, 0);
            const d = ringDecision({ me: user, sessions, prev, lastRing: lastRing.get(k), now: t, isGuest });
            if (d.skip) { if (d.skip !== "no_call" && d.skip !== "not_rising") skip(d.skip); continue; }
            const name = cleanName(joined.get(d.ring.sender)) || localpart(d.ring.sender) || "Someone";
            await ring(room, user, d.ring, name, busyElsewhere(user, room));
        }
    }

    /** One room at a time; a poke while it runs makes it run once more afterwards (a burst = at most two reads). */
    function schedule(room) {
        const r = running.get(room);
        if (r) { r.again = true; return r.done; }
        const entry = { again: false, done: null };
        running.set(room, entry);
        entry.done = (async () => {
            try {
                do { entry.again = false; await processRoom(room); } while (entry.again);
            } catch (e) {
                logError(`[ring] ${String(e?.message || e).slice(0, 200)}`);
            } finally { running.delete(room); }
        })();
        return entry.done;
    }

    // ── handlers ──
    async function callHook(req, res) {
        noStore(res);
        const b = await readJson(req, P.BODY_LIMIT);
        if (!b.ok) return res.status(b.status).json({ error: b.error });
        const v = b.value;
        if (!isObj(v) || typeof v.room_id !== "string" || !ROOM_ID_RE.test(v.room_id)) return res.status(400).json({ error: "expected {room_id, event_id}" });
        stats.pokes++;
        if (!adminToken) { skip("no_admin_token"); return res.json({}); }
        if (!hookLimit.hit("all")) { skip("hook_limit"); return res.status(429).json({ error: "too many" }); }
        const done = schedule(v.room_id);
        res.json({});
        return done; // tests await the work; the listener has answered already
    }

    async function decline(req, res) {
        noStore(res);
        const who = await ctx.auth.authenticate(req, res);
        if (!who) return;
        if (!declineLimit.hit(who.user)) { res.set("Retry-After", String(declineLimit.retryAfter(who.user))); return res.status(429).json({ error: "too many requests" }); }
        const b = await readJson(req, P.BODY_LIMIT);
        if (!b.ok) return res.status(b.status).json({ error: b.error });
        const v = b.value;
        if (!isObj(v) || typeof v.room !== "string" || !ROOM_ID_RE.test(v.room) || typeof v.ring !== "string" || !v.ring || v.ring.length > 255)
            return res.status(400).json({ error: 'expected {"room": "!…", "ring": "$…"}' });
        const rec = live.get(`${v.room}\0${who.user}`);
        if (!rec || rec.ring !== v.ring || wallNow() - rec.at > P.STOP_MS) return res.status(404).json({ error: "no_ring" });
        const st = await roomState(v.room);
        if (!st || st.big) return res.status(503).json({ error: "couldn't read the room, try again" });
        if (!roomView(st.events, wallNow()).joined.has(who.user)) return res.status(403).json({ error: "not_member" });
        if (rec.stopped) return res.json({ ok: true, already: rec.stopped });
        stats.declines++;
        await stop(rec, "declined");
        res.json({ ok: true });
    }

    function sweep() {
        const t = wallNow();
        for (const [k, rec] of live) if (t - rec.at > P.STOP_MS) live.delete(k);
        for (const [k, at] of lastRing) if (t - at >= P.GAP_MS) lastRing.delete(k);
        for (const [u, rooms] of inCall) { for (const [r, exp] of rooms) if (exp <= t) rooms.delete(r); if (!rooms.size) inCall.delete(u); }
        const m = now();
        for (const [r, edges] of prevOthers) { for (const [u, until] of edges) if (until <= t) edges.delete(u); if (!edges.size) prevOthers.delete(r); }
        for (const [k, c] of mutedCache) if (m - c.at >= P.MUTED_CACHE_MS) mutedCache.delete(k);
        hookLimit.sweep(); userLimit.sweep(); declineLimit.sweep();
    }

    function report() {
        const s = JSON.parse(JSON.stringify(stats));
        for (const k of Object.keys(stats)) stats[k] = k === "skip" ? {} : 0;
        if (!s.pokes && !s.declines) return;
        const skips = Object.entries(s.skip).map(([k, n]) => `${k} ${n}`).join(", ");
        log(`[ring] last period: ${s.pokes} pokes, ${s.rooms} room reads, ${s.rings} rings (${s.downgraded} as messages), ${s.stops} stops, ` +
            `${s.declines} declines; skipped: ${skips || "none"}`);
    }

    return { callHook, decline, sweep, report, schedule, _live: live, _inCall: inCall };
}
