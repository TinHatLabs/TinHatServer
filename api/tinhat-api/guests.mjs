// guests.mjs — the guest room (contract: docs/GUESTS.md in the server repository). One optional "Guests" room per
// server: managers turn it on and off and renew its one link; someone with the link knocks from the guest page and
// waits at the door until a member lets them in (from the web or the desktop app); then a temporary account (12 h,
// the same as every guest account) is joined to the room. The room's state carries `dev.tinhat.guests` (on/off, never
// the link) and `dev.tinhat.guests.waiting` (who waits), written by the server's system account, so every app sees a
// change at once through sync.
//
//   GET  /guests                 bearer: the doc {available, room, alias, on, since, link, waiting, canManage, canAdmit, member}
//   POST /guests/on|off|link     bearer, manage: turn on (makes the room on first use), off, a new link
//   POST /guests/admit {id}      bearer, admit: let that guest in
//   POST /guests/turn-away {id}  bearer, admit
//   GET  /guest/door?g=KEY       the guest page: is this the current link, is the door open
//   POST /guest/knock {g, name}  the guest page: wait at the door → {ticket, every}
//   GET  /guest/ticket?t=TICKET  the guest page: waiting | in (+ the session, once) | turned-away | closed | expired
//
// Manage = a server admin (Synapse admin) or power level ≥ 50 in the Guests room; admit = any member of the room who
// isn't a guest (and has the room's invite level). Guests never manage, admit or see the link.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimit, readJson, safe, noStore, isObj, wall, clientIp, UNSAFE_TEXT } from "./reachcommon.mjs";

export const G = Object.freeze({
    STATE: "dev.tinhat.guests",
    WAITING: "dev.tinhat.guests.waiting",
    MAX_WAITING: 20,
    MAX_TICKETS: 500,             // waiting + recently answered, all together
    WAIT_MS: 10 * 60_000,         // a knock waits this long
    COLLECT_MS: 2 * 60_000,       // an admitted guest's page must pick the session up within this
    FINAL_KEEP_MS: 10 * 60_000,   // a ticket's final answer stays readable this long
    KNOCKS_PER_IP: 5,             // per 10 minutes
    KNOCK_WINDOW_MS: 10 * 60_000,
    ROLE_TTL_MS: 10_000,
    MANAGE_LEVEL: 50,
    NAME_MAX: 32,
    BODY_MAX: 1024,
    TICK_MS: 15_000,
});
const KEY_RE = /^[A-Za-z0-9_-]{24}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{32}$/;
const ID_RE = /^[A-Za-z0-9_-]{8}$/;
const rnd = (bytes) => randomBytes(bytes).toString("base64url");
const enc = encodeURIComponent;

function sameKey(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function cleanName(raw) {
    let n = String(raw ?? "").replace(new RegExp(UNSAFE_TEXT.source, "g"), "").replace(/\s+/g, " ").trim();
    n = [...n].slice(0, G.NAME_MAX).join("").trim();
    return n || "Guest";
}

/**
 * deps: {
 *   auth: createMatrixAuth(...)  — authenticate(req, res) → {user} | null (answered)
 *   hs: createHs(...)            — call(method, path, token, body) → {ok, status, body}
 *   adminToken                   — the system account's token (a Synapse admin, in the Guests room)
 *   serverName, publicBase       — "crew.tinhat.me", "https://crew.tinhat.me"
 *   webBase                      — where the web app is (the link and the hand-off), when it isn't publicBase: a
 *                                  domain whose front page is the owner's own site (default publicBase)
 *   register(displayName)        — a temporary account → {user, token, device}
 *   deactivate(user)             — true when done
 *   recordGuest({user, room, name}) — the 12-hour reaper's list
 *   isGuest(mxid)                — treat as a guest (fewer rights): a temporary account, or any @guest-… name
 *   isTemporary(mxid)            — an account the API itself made for a guest (only those are ever removed)
 *   revokeAll(room)              — deactivate every account the guest room made (in the room or not) → how many
 *   publishRoom(room)            — tell Synapse's tinhat_rules module which room guests may be in
 *   statePath                    — guests.json
 *   now, log, retryMs (the start-up publish's retry: 30 s)
 * }
 */
export function createGuests(deps) {
    const now = deps.now || wall;
    const log = deps.log || console.log;
    const hs = deps.hs;
    const T = deps.adminToken;
    let st = { v: 1, room: null, on: false, since: 0, key: null };
    try {
        const j = JSON.parse(readFileSync(deps.statePath, "utf8"));
        if (isObj(j)) st = { ...st, room: typeof j.room === "string" ? j.room : null, on: j.on === true,
            since: Number(j.since) || 0, key: typeof j.key === "string" && KEY_RE.test(j.key) ? j.key : null };
    } catch { /* first run */ }
    if (st.on && !st.key) st.on = false;
    const waiting = new Map();   // id → {id, name, at, ticket, key}
    const tickets = new Map();   // ticket → {id, state, at, done?, session?, sessionAt?, user?}
    const roles = new Map();     // mxid → {v, exp}
    const knocks = new RateLimit(G.KNOCKS_PER_IP, G.KNOCK_WINDOW_MS, now);
    let systemId = null;
    let busy = Promise.resolve(); // one change at a time (on/off/link/admit)

    const serial = (fn) => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; };
    function save() {
        const tmp = `${deps.statePath}.tmp`;
        writeFileSync(tmp, JSON.stringify(st, null, 1), { mode: 0o600 });
        renameSync(tmp, deps.statePath);
        deps.publishRoom?.(st.room || "");
    }
    const webBase = String(deps.webBase || deps.publicBase).replace(/\/+$/, "");
    const linkUrl = () => (st.on && st.key ? `${webBase}/call/?g=${st.key}` : null);
    const waitingList = () => [...waiting.values()].map(({ id, name, at }) => ({ id, name, at }));

    async function system() {
        if (systemId) return systemId;
        const r = await hs.call("GET", "/_matrix/client/v3/account/whoami", T);
        if (!r.ok || typeof r.body.user_id !== "string") throw new Error(`the system account's token didn't work (${r.status})`);
        return (systemId = r.body.user_id);
    }
    async function putState(type, content) {
        if (!st.room) return false;
        const r = await hs.call("PUT", `/_matrix/client/v3/rooms/${enc(st.room)}/state/${enc(type)}/`, T, content);
        if (!r.ok) log(`[guests] writing ${type} said ${r.status} ${r.body?.errcode || ""}`);
        return r.ok;
    }
    // The waiting list is written from several places (knocks, expiry, on/off, admit): one write at a time, each with
    // the list as it is when it is sent, so an older write never lands after a newer one.
    let waitingChain = Promise.resolve();
    function writeWaiting() {
        const p = waitingChain.then(() => putState(G.WAITING, { v: 1, waiting: waitingList() }));
        waitingChain = p.catch(() => {});
        return p;
    }
    const writeOn = () => putState(G.STATE, { v: 1, on: st.on, since: st.since });

    async function isAdmin(mxid) {
        const r = await hs.call("GET", `/_synapse/admin/v2/users/${enc(mxid)}`, T);
        return r.ok && r.body.admin === true;
    }
    async function roleOf(mxid, fresh = false) {
        const hit = roles.get(mxid);
        if (!fresh && hit && hit.exp > now()) return hit.v;
        const guest = deps.isGuest(mxid);
        let member = false, pl = 0, inviteLevel = 0, levelsKnown = false;
        if (st.room) {
            const m = await hs.call("GET", `/_matrix/client/v3/rooms/${enc(st.room)}/joined_members`, T);
            member = m.ok && isObj(m.body.joined) && Object.prototype.hasOwnProperty.call(m.body.joined, mxid);
            const p = await hs.call("GET", `/_matrix/client/v3/rooms/${enc(st.room)}/state/m.room.power_levels/`, T);
            if (p.ok) {
                levelsKnown = true;
                const users = isObj(p.body.users) ? p.body.users : {};
                pl = Number.isInteger(users[mxid]) ? users[mxid] : Number.isInteger(p.body.users_default) ? p.body.users_default : 0;
                inviteLevel = Number.isInteger(p.body.invite) ? p.body.invite : 0;
            }
        }
        const admin = guest ? false : await isAdmin(mxid);
        const v = {
            member, guest,
            // the room's levels unreadable: fail closed (only a server admin manages; nobody lets in)
            canAdmit: !guest && member && levelsKnown && pl >= inviteLevel,
            canManage: !guest && (admin || (member && levelsKnown && pl >= G.MANAGE_LEVEL)),
        };
        roles.set(mxid, { v, exp: now() + G.ROLE_TTL_MS });
        return v;
    }
    async function doc(mxid) {
        const r = await roleOf(mxid);
        const show = r.canAdmit || r.canManage;
        return {
            available: !!T, room: st.room, alias: `#guests:${deps.serverName}`, on: st.on, since: st.since,
            link: show ? linkUrl() : null, waiting: show ? waitingList() : [],
            canManage: r.canManage, canAdmit: r.canAdmit, member: r.member,
        };
    }

    function endWaiting(state) {
        for (const w of waiting.values()) {
            const t = tickets.get(w.ticket);
            if (t && t.state === "waiting") Object.assign(t, { state, done: now() });
        }
        waiting.clear();
    }
    async function roomUsable() {
        if (!st.room) return false;
        const r = await hs.call("GET", `/_matrix/client/v3/rooms/${enc(st.room)}/state/m.room.power_levels/`, T);
        return r.ok;
    }
    // The room's own state stays the server's: the types only the server writes need power level 100 there. A room
    // made by an earlier version may not name them yet (then they'd fall back to state_default, 50: a manager could
    // write them). The system account (100 in the room) raises them; best effort, logged.
    const SERVER_ONLY = [G.STATE, G.WAITING, "m.room.encryption"];
    // True when they are (or now are) at 100 or above; never lowers anything (a missing type counts at state_default).
    async function keepRoomRules() {
        if (!st.room) return true;
        const path = `/_matrix/client/v3/rooms/${enc(st.room)}/state/m.room.power_levels/`;
        const r = await hs.call("GET", path, T);
        if (!r.ok || !isObj(r.body)) {
            log(`[guests] reading the Guests room's power levels said ${r.status} ${r.body?.errcode || ""}`);
            return false;
        }
        const events = isObj(r.body.events) ? { ...r.body.events } : {};
        const level = (type) => Number(events[type] ?? r.body.state_default ?? 50);
        const low = SERVER_ONLY.filter((type) => !(level(type) >= 100));
        if (!low.length) return true;
        for (const type of low) events[type] = 100;
        const w = await hs.call("PUT", path, T, { ...r.body, events });
        log(w.ok ? `[guests] the Guests room: only the server writes ${low.join(", ")} now`
            : `[guests] couldn't keep ${low.join(", ")} to the server in the Guests room (${w.status} ${w.body?.errcode || ""})`);
        return w.ok;
    }
    // The Guests room is NOT end-to-end encrypted (decided 2026-10-23: new rooms are, except public rooms inside a
    // space, #general and this one): a guest's brand-new device could read nothing said before its keys reached people.
    // No m.room.encryption in it, and only the server (power level 100) could ever turn encryption on there. A chat
    // server set to encrypt every new room (a Synapse setting Tin Hat Server never sets:
    // appliance/tests/test_no_forced_encryption.py) would still encrypt it: that is logged.
    async function createRoom(caller) {
        const sys = await system();
        const body = {
            room_version: "10",
            creation_content: { "m.federate": false },  // only this server's accounts, never another server's
            name: "Guests",
            topic: "Guests someone let in join here; they're gone after 12 hours.",
            room_alias_name: "guests",
            preset: "public_chat",
            visibility: "private",
            initial_state: [
                { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "joined" } },
                { type: "m.room.guest_access", state_key: "", content: { guest_access: "forbidden" } },
            ],
            power_level_content_override: {
                users: { [sys]: 100, [caller]: G.MANAGE_LEVEL },  // the room's own state stays the server's
                events: { [G.STATE]: 100, [G.WAITING]: 100, "m.room.power_levels": 100, "m.room.encryption": 100,
                    "m.room.history_visibility": 100, "m.room.tombstone": 100, "m.room.server_acl": 100,
                    "m.room.join_rules": 100, "m.room.canonical_alias": 100 },
                kick: 50, ban: 50, redact: 50, invite: 0, state_default: 50,
            },
        };
        let r = await hs.call("POST", "/_matrix/client/v3/createRoom", T, body);
        if (!r.ok && r.body?.errcode === "M_ROOM_IN_USE") {  // someone owns #guests already: a room without the alias
            delete body.room_alias_name;
            r = await hs.call("POST", "/_matrix/client/v3/createRoom", T, body);
        }
        if (!r.ok || typeof r.body.room_id !== "string") throw new Error(`creating the Guests room said ${r.status} ${r.body?.errcode || ""}`);
        try {  // only a diagnostic: never fails the turning on (the room exists now)
            const e = await hs.call("GET", `/_matrix/client/v3/rooms/${enc(r.body.room_id)}/state/m.room.encryption/`, T);
            if (e.ok) log(`[guests] the chat server encrypted the new Guests room ${r.body.room_id} anyway (it forces encryption on new rooms): guests won't read what was said before they came in`);
        } catch { /* unknown: nothing to say */ }
        return r.body.room_id;
    }
    async function forceJoin(user) {
        const r = await hs.call("POST", `/_synapse/admin/v1/join/${enc(st.room)}`, T, { user_id: user });
        return r.ok;
    }

    async function turnOn(caller) {
        let made = false;
        if (!(await roomUsable())) {
            st.room = await createRoom(caller);
            made = true;
        } else {
            await keepRoomRules();
        }
        st.key = rnd(18);
        st.on = true;
        st.since = now();
        endWaiting("closed");
        save();
        roles.clear();
        if (made || !(await roleOf(caller)).member) await forceJoin(caller);
        roles.clear();
        await writeOn();
        await writeWaiting();
        log(`[guests] on by ${caller}${made ? ` (made ${st.room})` : ""}`);
    }
    async function turnOff(caller) {
        st.on = false;
        st.key = null;
        st.since = now();
        endWaiting("closed");
        save();
        await writeOn();
        await writeWaiting();
        let removed = 0;
        if (st.room) {
            // The guests still in the room are kicked at once (deactivation parts rooms only in the background), then
            // every account the guest room made goes, wherever it is (a guest who left first too); what fails is
            // retried by the reaper.
            const m = await hs.call("GET", `/_matrix/client/v3/rooms/${enc(st.room)}/joined_members`, T).catch(() => ({ body: {} }));
            for (const user of Object.keys(isObj(m.body?.joined) ? m.body.joined : {})) {
                if (!deps.isTemporary(user)) continue;  // never a real person who picked a guest-like name
                await hs.call("POST", `/_matrix/client/v3/rooms/${enc(st.room)}/kick`, T, { user_id: user, reason: "The guest room was turned off" }).catch(() => null);
            }
            removed = await deps.revokeAll(st.room);
        }
        log(`[guests] off by ${caller} (${removed} guest${removed === 1 ? "" : "s"} removed)`);
    }
    async function newLink(caller) {
        st.key = rnd(18);
        endWaiting("closed");
        save();
        await writeWaiting();
        log(`[guests] new link by ${caller}`);
    }
    async function admit(caller, id) {
        const w = waiting.get(id);
        if (!w || now() - w.at > G.WAIT_MS) return { status: 404, body: { error: "Nobody with that id is waiting (any more)." } };
        if (!st.on || !sameKey(w.key, st.key || "")) return { status: 410, body: { error: "The guest room's link changed or it was turned off." } };
        waiting.delete(id);
        const t = tickets.get(w.ticket);
        let acct;
        try {
            acct = await deps.register(`${w.name} (guest)`);
        } catch (e) {
            waiting.set(id, w);
            return { status: 502, body: { error: `Couldn't make the guest's account: ${e.message}` } };
        }
        deps.recordGuest({ user: acct.user, room: st.room, name: w.name });  // first: the 12-hour reaper always knows it
        let joined = false;
        try { joined = await forceJoin(acct.user); } catch { joined = false; }
        if (!joined) {
            await Promise.resolve(deps.deactivate(acct.user)).catch(() => false);
            waiting.set(id, w);
            return { status: 502, body: { error: "Couldn't bring the guest into the room." } };
        }
        const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${enc(v)}`).join("&");
        const session = { hs: deps.publicBase, user: acct.user, token: acct.token, device: acct.device, room: st.room,
            web: `${webBase}/#/guest-session?${q({ hs: deps.publicBase, user: acct.user, token: acct.token, device: acct.device, room: st.room })}` };
        if (t) Object.assign(t, { state: "in", session, sessionAt: now(), user: acct.user, done: now() });
        await writeWaiting();
        log(`[guests] ${caller} let in "${w.name}" (${acct.user})`);
        return { status: 200, body: { ok: true } };
    }
    async function turnAway(caller, id) {
        const w = waiting.get(id);
        if (!w) return { status: 404, body: { error: "Nobody with that id is waiting (any more)." } };
        waiting.delete(id);
        const t = tickets.get(w.ticket);
        if (t) Object.assign(t, { state: "turned-away", done: now() });
        await writeWaiting();
        log(`[guests] ${caller} turned away "${w.name}"`);
        return { status: 200, body: { ok: true } };
    }

    async function tick() {
        const t0 = now();
        let changed = false;
        for (const w of [...waiting.values()]) {
            if (t0 - w.at <= G.WAIT_MS) continue;
            waiting.delete(w.id);
            const t = tickets.get(w.ticket);
            if (t && t.state === "waiting") Object.assign(t, { state: "expired", done: t0 });
            changed = true;
        }
        for (const [k, t] of [...tickets]) {
            if (t.state === "in" && t.session && t0 - t.sessionAt > G.COLLECT_MS) {  // never picked up: withdraw it
                tickets.delete(k);
                await deps.deactivate(t.user);
                log(`[guests] ${t.user}'s session was never picked up: withdrawn`);
            } else if (t.state !== "waiting" && t.state !== "in" && t0 - (t.done || t.at) > G.FINAL_KEEP_MS) {
                tickets.delete(k);
            }
        }
        knocks.sweep();
        if (changed) await writeWaiting();
    }

    // ---- handlers ------------------------------------------------------------------------------------------------
    async function signedIn(req, res) {
        noStore(res);
        if (!T) { res.status(503).json({ error: "The guest room isn't available on this server." }); return null; }
        return deps.auth.authenticate(req, res);
    }
    async function bodyOf(req, res) {
        const b = await readJson(req, G.BODY_MAX);
        if (!b.ok) { res.status(b.status).json({ error: b.error }); return null; }
        return isObj(b.value) ? b.value : {};
    }
    const h = {
        doc: async (req, res) => {
            const who = await signedIn(req, res); if (!who) return;
            res.json(await doc(who.user));
        },
        manage: (what) => async (req, res) => {
            const who = await signedIn(req, res); if (!who) return;
            const r = await roleOf(who.user);
            if (!r.canManage) return res.status(403).json({ error: "Only a server admin or a moderator of the Guests room can do that." });
            if (what === "link" && !st.on) return res.status(409).json({ error: "Turn the guest room on first." });
            const out = await serial(async () => {
                if (!(await roleOf(who.user, true)).canManage) return 403;  // fresh, inside the queue: no stale rights
                if (what === "link" && !st.on) return 409;
                await (what === "on" ? turnOn(who.user) : what === "off" ? turnOff(who.user) : newLink(who.user));
                return 200;
            });
            if (out === 403) return res.status(403).json({ error: "Only a server admin or a moderator of the Guests room can do that." });
            if (out === 409) return res.status(409).json({ error: "Turn the guest room on first." });
            roles.delete(who.user);
            res.json(await doc(who.user));
        },
        decide: (what) => async (req, res) => {
            const who = await signedIn(req, res); if (!who) return;
            const body = await bodyOf(req, res); if (!body) return;
            const id = String(body.id || "");
            if (!ID_RE.test(id)) return res.status(400).json({ error: "Which guest?" });
            const r = await roleOf(who.user);
            if (!r.canAdmit) return res.status(403).json({ error: "Only members of the Guests room can let guests in." });
            const out = await serial(async () => {
                if (!(await roleOf(who.user, true)).canAdmit) return { status: 403, body: { error: "Only members of the Guests room can let guests in." } };
                return what === "admit" ? admit(who.user, id) : turnAway(who.user, id);
            });
            res.status(out.status).json(out.body);
        },
        door: async (req, res) => {
            noStore(res);
            const g = String(req.query?.g || "");
            if (!KEY_RE.test(g) || !st.key || !sameKey(g, st.key)) return res.status(404).json({ error: "This guest link isn't open any more. Ask whoever sent it for a new one." });
            res.json({ server: deps.serverName, room: "Guests", open: st.on });
        },
        knock: async (req, res) => {
            noStore(res);
            const body = await bodyOf(req, res); if (!body) return;
            const g = String(body.g || "");
            if (!KEY_RE.test(g) || !st.on || !st.key || !sameKey(g, st.key)) return res.status(410).json({ error: "This guest link isn't open any more. Ask whoever sent it for a new one.", closed: true });
            const ip = clientIp(req);
            if (!knocks.hit(ip)) { res.set("Retry-After", String(knocks.retryAfter(ip))); return res.status(429).json({ error: "That's a lot of knocking. Wait a few minutes, then try again." }); }
            if (waiting.size >= G.MAX_WAITING || tickets.size >= G.MAX_TICKETS) return res.status(429).json({ error: "Lots of people are waiting already. Try again in a few minutes." });
            const id = rnd(6), ticket = rnd(24), name = cleanName(body.name);
            waiting.set(id, { id, name, at: now(), ticket, key: st.key });
            tickets.set(ticket, { id, state: "waiting", at: now() });
            await writeWaiting();
            log(`[guests] "${name}" knocked (${id})`);
            res.json({ ticket, every: 2 });
        },
        ticket: async (req, res) => {
            noStore(res);
            const k = String(req.query?.t || "");
            const t = TICKET_RE.test(k) ? tickets.get(k) : null;
            if (!t) return res.status(404).json({ state: "expired" });
            if (t.state === "waiting" && now() - t.at > G.WAIT_MS) await tick();
            if (t.state === "in" && t.session && now() - t.sessionAt <= G.COLLECT_MS) {
                const session = t.session;
                tickets.delete(k);  // once: a copied ticket URL can't pick the session up again
                return res.json({ state: "in", session });
            }
            res.json({ state: t.state });
        },
    };
    // On start: Synapse's rules learn the room; the room's state says what is true now (on or off, and nobody waits:
    // the waiting list lived in this process), so every app reads it from sync, also right after an update.
    deps.publishRoom?.(st.room || "");
    // The chat server may not answer yet (after a restart the API can be up first): tried again every 30 s, 10 times,
    // in turn with on/off/link changes so an older answer never lands after a newer one.
    let tries = 0;
    const publishAtStart = () => serial(async () => {
        if (!st.room) return true;
        const rules = await keepRoomRules();  // each one is tried whatever the others said; any failure tries again
        const on = await writeOn();
        const waits = await writeWaiting();
        return rules && on && waits;
    }).catch((e) => { log(`[guests] publishing the Guests room's state: ${e.message}`); return false; })
        .then((ok) => { if (!ok && ++tries < 10) setTimeout(publishAtStart, deps.retryMs ?? 30_000).unref?.(); });
    const ready = st.room && T ? publishAtStart() : Promise.resolve();
    return { h, tick, _st: () => st, _waiting: waiting, _tickets: tickets, _ready: ready };
}

export function installGuests(app, deps) {
    const g = createGuests(deps);
    app.get("/guests", safe("guests", g.h.doc));
    app.post("/guests/on", safe("guests", g.h.manage("on")));
    app.post("/guests/off", safe("guests", g.h.manage("off")));
    app.post("/guests/link", safe("guests", g.h.manage("link")));
    app.post("/guests/admit", safe("guests", g.h.decide("admit")));
    app.post("/guests/turn-away", safe("guests", g.h.decide("turn-away")));
    app.get("/guest/door", safe("guests", g.h.door));
    app.post("/guest/knock", safe("guests", g.h.knock));
    app.get("/guest/ticket", safe("guests", g.h.ticket));
    setInterval(() => g.tick().catch((e) => (deps.log || console.log)(`[guests] tick: ${e.message}`)), G.TICK_MS).unref?.();
    (deps.log || console.log)("[guests] ready");
    return g;
}
