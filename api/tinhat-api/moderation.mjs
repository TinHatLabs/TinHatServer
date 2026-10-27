// Call moderation — the ONE privileged path into LiveKit that Tin Hat clients may call.
//
//   POST /moderation/call   { room_id, action: "mute"|"unmute"|"disconnect", target: "<mxid>:<DEVICE>" }
//   Authorization: Bearer <the caller's Matrix access token>
//
// Why this lives here: a moderator muting someone in a call cannot be a client-side request
// (the muted client could simply ignore it). Real enforcement is LiveKit's RoomService, which
// needs the SFU admin secret — and this process already holds it, next to the Synapse admin
// token that lets it read room state. Nothing about the secret or the token ever leaves.
//
// Who may do what is decided from the SPACE's roles (docs/RBAC.md in the client repo):
//   dev.tinhat.role          state_key = role id     {name, rank, permissions:[...]}
//   dev.tinhat.member_roles  state_key = mxid sans @ {roles:[...]}
// A caller needs the `moderate_calls` permission and a HIGHER rank than the target. When a space
// has no roles yet, the Matrix power levels of the call room decide instead
// (caller ≥ events["dev.tinhat.call.moderation"] ?? 50, and caller > target).
//
// Which spaces govern (security review 2026-10-26, M4; reworked after the second review): a room's m.space.parent is
// written by the room's own members (Tin Hat's roles map manage_rooms onto it), so nobody below the room's own
// authority may change which policy applies, and nobody may bring a space of their own in:
//   - "the room's authority" = whoever may change its power levels (their power level reaches m.room.power_levels');
//     "a space run by the room" = among its JOINED members with authority there is someone with the room's authority.
//   - Every m.space.parent event of the room counts, whatever its content now: clearing a link only replaces its
//     content, the event stays.
//     - set by the room's authority: a link binds; an emptied one is a real unlink;
//     - set by anyone else, and only for a space run by the room: a link binds when the space lists the room too
//       (m.space.child with a `via`, or emptied by someone without authority in the space); an emptied link STILL binds
//       (fail closed: a moderator clearing or re-sending the link changes nothing).
//   - Every bound space whose roles are set up must allow (the stricter outcome when there are several); a bound space
//     that can't be read refuses the request (502), it never falls back. No bound space: the room's power levels decide.
// And a roles rank never beats the call room's power levels: a target whose power level there is higher than the
// caller's, or who is at 100 like the caller, can't be moderated by them.
//
// LiveKit facts this relies on (verified 2026-09-17 against lk-jwt-service logs): the LiveKit
// room name is the Matrix room id, and a participant identity is `<mxid>:<DEVICE_ID>`.

const CALL_MOD_TYPE = "dev.tinhat.call.moderation";
const ROLE_TYPE = "dev.tinhat.role";
const MEMBER_ROLES_TYPE = "dev.tinhat.member_roles";
const EVERYONE = "everyone";

// `!opaque:server`, or a room v12 id (`!` + the create event's hash, no server part): reachcommon's.
const ROOM_ID_RE = /^![A-Za-z0-9._~=+/-]{1,255}(?::[A-Za-z0-9.-]{1,255}(?::\d{1,5})?)?$/;
const IDENTITY_RE = /^(@[^:\s]+:[A-Za-z0-9.-]+(?::\d+)?):([A-Za-z0-9_-]{1,64})$/;

const ACTIONS = new Set(["mute", "unmute", "disconnect"]);
const MAX_PARENT_LINKS = 32;

// Everything but the microphone (and the "unknown"-source soundboard/music tracks, which are
// deliberately NOT listed: a server-muted person is silent, full stop — same as Discord).
const MUTED_PUBLISH_SOURCES = ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"];

/** A tiny TTL cache: key -> {v, exp}. */
class Ttl {
    constructor(ms) { this.ms = ms; this.m = new Map(); }
    get(k) { const e = this.m.get(k); if (!e) return undefined; if (e.exp < Date.now()) { this.m.delete(k); return undefined; } return e.v; }
    set(k, v) { this.m.set(k, { v, exp: Date.now() + this.ms }); if (this.m.size > 512) this.m.delete(this.m.keys().next().value); return v; }
}

/**
 * Mount the endpoint. `deps` are the host process' own helpers so this file holds no secret
 * of its own: { requireMatrixUser, synapse, adminToken, lkApiUrl, lkKey, lkSecret, b64u, createHmac, log }.
 */
export function installModeration(app, deps) {
    const { requireMatrixUser, synapse, adminToken, lkApiUrl, lkKey, lkSecret, b64u, createHmac } = deps;
    const log = deps.log || ((s) => console.log(s));
    if (!adminToken || !lkSecret) {
        console.error("[moderation] synapse-admin.token / livekit.secret missing -> call moderation DISABLED");
        app.post("/moderation/call", (_req, res) => res.status(503).json({ error: "Call moderation isn't set up on this server" }));
        return { dropFromCall: async () => 0 };
    }

    const stateCache = new Ttl(10_000);   // room id -> state events (admin API)
    const rate = new Map();               // mxid -> [timestamps]

    function mintRoomAdminToken(room) {
        const now = Math.floor(Date.now() / 1000);
        const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
        const payload = b64u(JSON.stringify({
            iss: lkKey, sub: "tinhat-moderation", nbf: now - 10, exp: now + 60,
            video: { room, roomAdmin: true },
        }));
        const sig = b64u(createHmac("sha256", lkSecret).update(`${header}.${payload}`).digest());
        return `${header}.${payload}.${sig}`;
    }

    async function twirp(method, room, body) {
        const r = await fetch(`${lkApiUrl}/twirp/livekit.RoomService/${method}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${mintRoomAdminToken(room)}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        });
        const text = await r.text();
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        if (!r.ok) throw new Error(`${method} said ${r.status} ${json.msg || json.error || ""}`.trim());
        return json;
    }

    /** All state events of a room via the admin API (cached 10 s). null = room unknown. */
    async function roomState(roomId) {
        const hit = stateCache.get(roomId);
        if (hit !== undefined) return hit;
        const r = await synapse(`/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`, {}, adminToken);
        if (r.status === 404) return stateCache.set(roomId, null);
        if (!r.ok) throw new Error(`room state said ${r.status}`);
        return stateCache.set(roomId, r.body.state || []);
    }

    function membership(state, mxid) {
        const ev = state.find((e) => e.type === "m.room.member" && e.state_key === mxid);
        return ev?.content?.membership || "leave";
    }

    /** Room v12 and later (and its draft, org.matrix.hydra.11): the creator and additional_creators have unlimited power
     *  and are never listed in power_levels (review of 116d103, #8: they were ignored). Others: nobody. */
    function creatorsOf(state) {
        const c = state.find((e) => e.type === "m.room.create" && e.state_key === "");
        if (!c) return new Set();
        const v = String(c.content?.room_version ?? "1");
        if (!((/^\d+$/.test(v) && Number(v) >= 12) || v === "org.matrix.hydra.11")) return new Set();
        const out = new Set(typeof c.sender === "string" ? [c.sender] : []);
        for (const u of Array.isArray(c.content?.additional_creators) ? c.content.additional_creators : []) if (typeof u === "string") out.add(u);
        return out;
    }

    function powerLevel(state, mxid) {
        if (creatorsOf(state).has(mxid)) return Infinity;
        const pl = state.find((e) => e.type === "m.room.power_levels" && e.state_key === "")?.content || {};
        const users = pl.users || {};
        const v = Object.prototype.hasOwnProperty.call(users, mxid) ? users[mxid] : (pl.users_default ?? 0);
        return Number(v) || 0;
    }

    function modThreshold(state) {
        const pl = state.find((e) => e.type === "m.room.power_levels" && e.state_key === "")?.content || {};
        const ev = pl.events || {};
        return Object.prototype.hasOwnProperty.call(ev, CALL_MOD_TYPE) ? Number(ev[CALL_MOD_TYPE]) : 50;
    }

    /** The power level a state event of `type` needs in a room (events[type] ?? state_default ?? 50). */
    function stateLevel(state, type) {
        const pl = state.find((e) => e.type === "m.room.power_levels" && e.state_key === "")?.content || {};
        const ev = pl.events || {};
        if (Object.prototype.hasOwnProperty.call(ev, type)) return Number(ev[type]) || 0;
        return Number(pl.state_default ?? 50) || 0;
    }

    /** Users with authority in a room (their power level reaches m.room.power_levels'), joined ones only when asked. */
    function authorities(state, joinedOnly) {
        const need = stateLevel(state, "m.room.power_levels");
        const pl = state.find((e) => e.type === "m.room.power_levels" && e.state_key === "")?.content || {};
        const out = new Set();
        for (const u of [...creatorsOf(state), ...Object.keys(pl.users || {})]) {
            if (powerLevel(state, u) < need) continue;
            if (joinedOnly && membership(state, u) !== "join") continue;
            out.add(u);
        }
        return out;
    }

    /**
     * The spaces whose roles govern this room: [{id, state}] (see the rule at the top). Throws when a space the room
     * names can't be read (the caller answers 502: an established binding never fails open).
     */
    async function governingSpaces(roomId, state) {
        const links = state.filter((e) => e.type === "m.space.parent" && typeof e.state_key === "string" && e.state_key !== roomId
            && ROOM_ID_RE.test(e.state_key));                        // a key that can't be a room is no space
        if (!links.length) return [];
        // every link is read (none may be skipped: skipping one could drop a binding), so their number is bounded
        if (links.length > MAX_PARENT_LINKS) throw Object.assign(new Error("too many parent links"), { status: 403 });
        const roomAuthority = stateLevel(state, "m.room.power_levels");
        const roomRunners = authorities(state, false);
        const out = [];
        for (const link of links) {
            const linked = Array.isArray(link.content?.via) && link.content.via.length > 0;
            const byAuthority = typeof link.sender === "string" && powerLevel(state, link.sender) >= roomAuthority;
            if (byAuthority && !linked) continue;                    // the room's own authority unlinked it
            const ps = await roomState(link.state_key);              // throws -> 502
            if (!ps) continue;                                       // not on this server: nothing to read roles from
            if (!byAuthority) {
                // someone below the room's authority set (or cleared) this link: only a space run by the room counts
                const spaceRunners = authorities(ps, true);
                if (![...spaceRunners].some((u) => roomRunners.has(u))) continue;
                if (linked) {
                    const child = ps.find((e) => e.type === "m.space.child" && e.state_key === roomId);
                    const listed = !!child && Array.isArray(child.content?.via) && child.content.via.length > 0;
                    const unlistedByNobody = !!child && !listed && !(typeof child.sender === "string"
                        && powerLevel(ps, child.sender) >= stateLevel(ps, "m.room.power_levels"));
                    if (!listed && !unlistedByNobody) continue;      // a one-sided link by a moderator binds nothing
                }
                // an emptied link set by someone below the room's authority still binds (fail closed)
            }
            out.push({ id: link.state_key, state: ps });
        }
        return out;
    }

    /** Roles as the client's roles_model sees them. active=false when the space never set roles up. */
    function rolesOf(state) {
        const roles = new Map();
        for (const e of state) {
            if (e.type !== ROLE_TYPE || !e.content || !e.content.name) continue;
            roles.set(e.state_key, {
                rank: e.state_key === EVERYONE ? 0 : Math.max(0, Math.min(100, Number(e.content.rank) || 0)),
                perms: new Set(Array.isArray(e.content.permissions) ? e.content.permissions.map(String) : []),
            });
        }
        const members = new Map();
        for (const e of state) {
            if (e.type !== MEMBER_ROLES_TYPE || !e.content) continue;
            const list = Array.isArray(e.content.roles) ? e.content.roles.map(String) : [];
            members.set("@" + e.state_key, list);
        }
        const active = roles.has(EVERYONE);
        const rankOf = (mxid) => (members.get(mxid) || []).reduce((m, id) => Math.max(m, roles.get(id)?.rank ?? 0), 0);
        const has = (mxid, perm) => {
            if (roles.get(EVERYONE)?.perms.has(perm)) return true;
            return (members.get(mxid) || []).some((id) => roles.get(id)?.perms.has(perm));
        };
        return { active, rankOf, has };
    }

    function rateLimited(mxid) {
        const now = Date.now();
        const arr = (rate.get(mxid) || []).filter((t) => now - t < 60_000);
        arr.push(now);
        rate.set(mxid, arr);
        return arr.length > 30;
    }

    async function findParticipant(room, identity) {
        const { participants = [] } = await twirp("ListParticipants", room, { room });
        return participants.find((p) => p.identity === identity) || null;
    }

    async function doMute(room, p) {
        let tracksMuted = 0;
        for (const t of p.tracks || []) {
            const type = String(t.type || "");
            if (type !== "AUDIO" && type !== "1") continue;
            await twirp("MutePublishedTrack", room, { room, identity: p.identity, track_sid: t.sid, muted: true });
            tracksMuted += 1;
        }
        const cur = p.permission || {};
        await twirp("UpdateParticipant", room, {
            room, identity: p.identity,
            permission: {
                can_subscribe: cur.can_subscribe ?? cur.canSubscribe ?? true,
                can_publish: true,
                can_publish_data: cur.can_publish_data ?? cur.canPublishData ?? true,
                can_update_metadata: cur.can_update_metadata ?? cur.canUpdateMetadata ?? false,
                hidden: cur.hidden ?? false,
                can_publish_sources: MUTED_PUBLISH_SOURCES,
            },
        });
        return tracksMuted;
    }

    async function doUnmute(room, p) {
        const cur = p.permission || {};
        await twirp("UpdateParticipant", room, {
            room, identity: p.identity,
            permission: {
                can_subscribe: cur.can_subscribe ?? cur.canSubscribe ?? true,
                can_publish: true,
                can_publish_data: cur.can_publish_data ?? cur.canPublishData ?? true,
                can_update_metadata: cur.can_update_metadata ?? cur.canUpdateMetadata ?? false,
                hidden: cur.hidden ?? false,
                can_publish_sources: [],   // empty = every source again
            },
        });
    }

    app.post("/moderation/call", requireMatrixUser, async (req, res) => {
        const me = req.matrixUser;
        const { room_id: roomId, action, target } = req.body || {};
        const m = typeof target === "string" ? IDENTITY_RE.exec(target) : null;
        if (typeof roomId !== "string" || !ROOM_ID_RE.test(roomId) || !ACTIONS.has(action) || !m) {
            return res.status(400).json({ error: "room_id, action (mute|unmute|disconnect) and target (<mxid>:<device>) are required" });
        }
        const targetMxid = m[1];
        const line = (status, extra = "") => log(`[moderation] ${me} ${action} ${target} in ${roomId} -> ${status}${extra ? " " + extra : ""}`);
        if (targetMxid === me) { line(400, "self"); return res.status(400).json({ error: "You can't moderate yourself" }); }
        if (rateLimited(me)) { line(429); return res.status(429).json({ error: "Slow down — too many moderation requests" }); }

        let state;
        try {
            state = await roomState(roomId);
        } catch (e) {
            line(502, e.message); return res.status(502).json({ error: "Couldn't read the room from the homeserver" });
        }
        if (!state) { line(404, "no such room"); return res.status(404).json({ error: "No such room" }); }
        if (membership(state, me) !== "join") { line(403, "not joined"); return res.status(403).json({ error: "You're not in that room" }); }

        // Authorise: roles from every governing space whose roles are set up (all must allow), power levels otherwise.
        let governing;
        try { governing = await governingSpaces(roomId, state); } catch (e) {
            if (e.status === 403) { line(403, e.message); return res.status(403).json({ error: "This room links to too many spaces to tell who may moderate its calls" }); }
            line(502, `space: ${e.message}`); return res.status(502).json({ error: "Couldn't read the room's space from the homeserver" });
        }
        const active = governing.map((g) => rolesOf(g.state)).filter((r) => r.active);
        let allowed, why;
        if (active.length) {
            const myPl = powerLevel(state, me), theirPl = powerLevel(state, targetMxid);
            allowed = true;
            for (const roles of active) {
                const mine = roles.rankOf(me), theirs = roles.rankOf(targetMxid);
                if (!roles.has(me, "moderate_calls")) { allowed = false; why = "You can't moderate calls in this space"; break; }
                if (mine <= theirs) { allowed = false; why = "They rank at or above you"; break; }
            }
            // a roles rank never beats the call room's own power levels (M4)
            if (allowed && (theirPl > myPl || (theirPl >= 100 && theirPl >= myPl))) { allowed = false; why = "They rank at or above you"; }
        } else {
            const mine = powerLevel(state, me), theirs = powerLevel(state, targetMxid);
            if (mine < modThreshold(state)) { allowed = false; why = "You can't moderate calls in this room"; }
            else if (mine <= theirs) { allowed = false; why = "They rank at or above you"; }
            else allowed = true;
        }
        if (!allowed) { line(403, why); return res.status(403).json({ error: why }); }

        // Act on the SFU.
        try {
            const p = await findParticipant(roomId, target);
            if (!p) { line(404, "not in call"); return res.status(404).json({ error: "They're not in the call" }); }
            let tracksMuted = 0;
            if (action === "mute") tracksMuted = await doMute(roomId, p);
            else if (action === "unmute") await doUnmute(roomId, p);
            else await twirp("RemoveParticipant", roomId, { room: roomId, identity: target });
            line(200, action === "mute" ? `${tracksMuted} track(s)` : "");
            return res.json({ ok: true, action, target, tracksMuted, rolesActive: active.length > 0 });
        } catch (e) {
            line(502, e.message);
            return res.status(502).json({ error: `The call server refused: ${e.message}` });
        }
    });

    /** Take these accounts out of a room's call now (every device of theirs): the guest room turned off, or a guest's
     *  12 hours are over. A deactivated account can't renew its call token, but one already connected stays until the
     *  call server is told. Returns how many connections were dropped; an empty or unknown room is 0. */
    async function dropFromCall(room, mxids) {
        if (!room || !mxids?.length) return 0;
        let list;
        try { ({ participants: list = [] } = await twirp("ListParticipants", room, { room })); } catch { return 0; }
        let n = 0;
        for (const p of list) {
            const id = String(p.identity || "");
            if (!mxids.some((m) => id === m || id.startsWith(`${m}:`))) continue;
            try { await twirp("RemoveParticipant", room, { room, identity: id }); n += 1; } catch (e) { log(`[moderation] drop ${id}: ${e.message}`); }
        }
        return n;
    }
    return { dropFromCall };
}
