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
// LiveKit facts this relies on (verified 2026-09-17 against lk-jwt-service logs): the LiveKit
// room name is the Matrix room id, and a participant identity is `<mxid>:<DEVICE_ID>`.

const CALL_MOD_TYPE = "dev.tinhat.call.moderation";
const ROLE_TYPE = "dev.tinhat.role";
const MEMBER_ROLES_TYPE = "dev.tinhat.member_roles";
const EVERYONE = "everyone";

const ROOM_ID_RE = /^![A-Za-z0-9._~-]{1,80}:[A-Za-z0-9.-]{1,80}$/;
const IDENTITY_RE = /^(@[^:\s]+:[A-Za-z0-9.-]+(?::\d+)?):([A-Za-z0-9_-]{1,64})$/;

const ACTIONS = new Set(["mute", "unmute", "disconnect"]);

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

    function powerLevel(state, mxid) {
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

    /** The room whose roles govern this room: its canonical (else first) joined-via parent space, else itself. */
    function containerOf(roomId, state) {
        const parents = state.filter((e) => e.type === "m.space.parent" && Array.isArray(e.content?.via) && e.content.via.length > 0);
        parents.sort((a, b) => (b.content?.canonical === true) - (a.content?.canonical === true));
        return parents[0]?.state_key || roomId;
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

        // Authorise: roles from the container space when they exist, power levels otherwise.
        const container = containerOf(roomId, state);
        let containerState = state;
        if (container !== roomId) {
            try { containerState = (await roomState(container)) || state; } catch { containerState = state; }
        }
        const roles = rolesOf(containerState);
        let allowed, why;
        if (roles.active) {
            const mine = roles.rankOf(me), theirs = roles.rankOf(targetMxid);
            if (!roles.has(me, "moderate_calls")) { allowed = false; why = "You can't moderate calls in this space"; }
            else if (mine <= theirs) { allowed = false; why = "They rank at or above you"; }
            else allowed = true;
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
            return res.json({ ok: true, action, target, tracksMuted, rolesActive: roles.active });
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
