// push.mjs — Tin Hat web push: the Matrix push gateway + its helper endpoints (Reach, 10.6; contract
// docs/REACH.md §3.1, §3.4 and amendments A2.5–A2.7, A2.12).
//
//   GET    /push/config                          -> {vapid, gateway, app_id}                     (no auth)
//   POST   /push/register  {endpoint, p256dh, auth, quietWhileActive}   (bearer)
//                          -> 200 {ok, pushkey, quietWhileActive}; the SERVER derives pushkey = base64url(sha256(endpoint));
//                             409 {error: "pushkey_owned"} when another account registered that subscription;
//                             503 when the registration couldn't be saved (nothing changed — try again)
//   GET    /push/register?pushkey=…              (bearer, owner only) -> {registered, quietWhileActive}
//   DELETE /push/register?pushkey=…              (bearer, owner only) -> 204 once it is gone from disk too (503 if not)
//   GET    /push/quiet-wanted                    (bearer) -> {wanted}: does any registration of mine want §3.4?
//   POST   /push/active    {pushkey|null, visible, instance}   (bearer) -> {ok, ttl: 35, wanted}
//   POST   /push/test      {pushkey}             (bearer, own registration only, 1 per 10 s per user)
//   POST   /_matrix/push/v1/notify               Matrix Push Gateway API — NOT on the public app: served by its own
//                                                listener (deps.gatewayListen) that only Synapse reaches (A2.5).
//                                                Body ≤ 64 KB.
//
// What is pushed (per device, ≤ 10 per request, with app_id dev.tinhat.web and valid data {endpoint, p256dh, auth}):
// notifications with an event (no count-only: iOS allows no silent push), not reactions/edits, not references other
// than a plain m.room.message (poll votes and ends, in-room verification steps: encrypted, one keeps its m.relates_to
// in the clear), with tweaks.highlight or tweaks.sound, of a type we can word (m.room.message, m.sticker,
// m.room.encrypted, an invite for this user), not suppressed by §3.4, not already delivered (15-min dedup of
// pushkey+event, so a Synapse retry never alerts twice), and not an Element Call key event outside a DM (A5.9: an
// m.room.encrypted notification whose ciphertext has the key-event length, in a room that is positively not a 2-member
// DM, is dropped and counted).
// Payload {v, room, event, kind, title, body, unread: null, user} ≤ 3 KB — `unread` is null since A5.10: the service
// worker keeps the badge itself; headers TTL 3600, Urgency high, Topic = a keyed per-subscription label: HMAC-SHA256 with
// this server's secret (push-topic.key, 0600) over (pushkey, room) for browsers — newest replaces per room — and over
// (pushkey, room, event) for the phone apps. Unkeyed hashes would be the same for every recipient (the Topic travels
// outside the encrypted body, RFC 8030 §5.4) and would let a push service or the relay link people to an event.
// Push-service answers (A2.7): 2xx ok · 404/410 -> `rejected` + registration dropped · 429/5xx/timeout/network (or
// our own queue full) -> 502 to Synapse so it retries with its backoff · any other answer -> 200 + an error line.
// Other app_ids, undeliverable subscriptions (bad keys, endpoint off the allowlist — never fetched) and pushkeys that
// are not base64url(sha256(their own endpoint)) -> rejected, before dedup, suppression or any owner lookup.
// A delivery reserves its (pushkey, event) dedup key before its first await; concurrent copies share its outcome.
//
// Logging: one line per push attempt — app_id, push-service host, HTTP status (+ the service's reason code), ms and
// 6 chars of the pushkey. Never content, never endpoints, never a whole pushkey. Skips are counted every 10 min.
import { createServer } from "node:http";
import { join } from "node:path";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { RateLimit, isObj, mono, noStore, readJson, safe, wall } from "./reachcommon.mjs";
import { b64u, loadOrCreateVapid, parseSubscription, pushkeyFor, relayOrigin, sendWebPush } from "./webpush.mjs";

export const PUSH = Object.freeze({
    APP_ID: "dev.tinhat.web",
    // The Tin Hat phone apps (docs/PHONE-PUSH.md): their pushers are taken only with an endpoint at the relay named by
    // PUSH_RELAY (deps.relay), never a browser push service; without PUSH_RELAY they are refused like any other app id.
    PHONE_APP_IDS: Object.freeze(["dev.tinhat.ios", "dev.tinhat.android"]),
    GATEWAY_URL: "http://127.0.0.1:3091/_matrix/push/v1/notify", // deps.gatewayUrl: where Synapse reaches the gateway
    GATEWAY_PATH: "/_matrix/push/v1/notify",
    SUBJECT: "https://tinhat.dev", // deps.subject: VAPID's contact (an https URL or a mailto:); the project's site by default
    ACTIVE_TTL_MS: 35_000,
    API_BODY_LIMIT: 4096,
    GATEWAY_BODY_LIMIT: 64 * 1024,
    TEXT_MAX: 180,
    TITLE_MAX: 100,
    NAME_MAX: 64,
    PAYLOAD_MAX: 3072,
    PHONE_PAYLOAD_MAX: 2560, // the relay's 2 900-byte body cap keeps base64url(body) + the APNs/FCM envelope under 4 KB
    DM_CACHE_MS: 5 * 60_000,
    DM_FAIL_CACHE_MS: 30_000,
    DEDUP_MS: 15 * 60_000,
    DEDUP_MAX: 20_000,
    MAX_DEVICES_PER_NOTIFY: 10,
    MAX_REGISTRATIONS_PER_USER: 10,
    CONCURRENCY: 8,
    QUEUE_MAX: 64,
    PUSH_TIMEOUT_MS: 5000,
    PUSH_TTL: 3600,
    TEST_INTERVAL_MS: 10_000,
    SWEEP_MS: 30_000,
    // A5.9: Megolm ciphertext length (base64 chars) of an io.element.call.encryption_keys room event, measured from Synapse
    // metadata on 2026-09-25: 3245 of the encrypted events of the last 30 days had exactly 403 (1485 of them within 2 min
    // of the same sender's call.member event); the next most common length (296) had 220, almost never near a call.
    CALL_KEY_CIPHERTEXT_LENGTHS: Object.freeze([403]),
});

/** An m.room.encrypted notification whose ciphertext has an Element Call key-event length (A5.9). */
export const isCallKeySized = (n) => n.type === "m.room.encrypted" && isObj(n.content)
    && typeof n.content.ciphertext === "string" && PUSH.CALL_KEY_CIPHERTEXT_LENGTHS.includes(n.content.ciphertext.length);

// ── wording (pure; mirrored by the tests) ───────────────────────────────────────────────────────────
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Collapse whitespace, drop control/bidi characters, cut at `max` code points + "…". */
export function clean(s, max) {
    const t = String(s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    const cps = Array.from(t);
    return cps.length > max ? cps.slice(0, max).join("") + "…" : t;
}

/** Strip a reply fallback ("> <@a:b> quoted\n> …\n\nreply") when the event is a reply. */
function stripReplyFallback(body, content) {
    if (!isObj(content["m.relates_to"]) || !isObj(content["m.relates_to"]["m.in_reply_to"])) return body;
    const lines = body.split("\n");
    let i = 0;
    while (i < lines.length && lines[i].startsWith(">")) i++;
    return i > 0 && i < lines.length && lines[i] === "" ? lines.slice(i + 1).join("\n") : body;
}

const MEDIA_TEXT = { "m.image": "sent a photo", "m.video": "sent a video", "m.file": "sent a file", "m.audio": "sent a voice message" };
const bodyText = (content) => clean(typeof content.body === "string" ? stripReplyFallback(content.body, content) : "", PUSH.TEXT_MAX);

/**
 * Notification-level decision: {skip: reason} or {kind: "message", text} / {kind: "invite"}.
 * Branch on the event type, then on content.msgtype (A2.7). Per-device checks happen in the gateway.
 */
export function classify(n) {
    if (typeof n.event_id !== "string" || n.event_id === "") return { skip: "count_only" };
    if (typeof n.room_id !== "string" || n.room_id === "") return { skip: "no_room" };
    const content = isObj(n.content) ? n.content : {};
    const rel = isObj(content["m.relates_to"]) ? content["m.relates_to"].rel_type : undefined;
    // reactions and edits; and references that aren't a plain message (poll votes/ends, verification steps: encrypted,
    // their m.relates_to stays in the clear, and they'd say "New message")
    if (rel === "m.annotation" || rel === "m.replace") return { skip: "relation" };
    if (rel === "m.reference" && n.type !== "m.room.message") return { skip: "relation" };
    switch (n.type) {
        case "m.room.member": {
            const membership = n.membership ?? content.membership;
            return membership === "invite" && n.user_is_target === true ? { kind: "invite" } : { skip: "member" };
        }
        case "m.room.encrypted":
            return { kind: "message", text: "New message" };
        case "m.room.message": {
            if (MEDIA_TEXT[content.msgtype]) return { kind: "message", text: MEDIA_TEXT[content.msgtype] };
            // m.text / m.notice / m.emote (and anything else carrying a body) -> the body
            return { kind: "message", text: bodyText(content) || "New message" };
        }
        case "m.sticker":
            return { kind: "message", text: bodyText(content) || "New message" };
        default:
            // Call state, polls, tombstones, … : nothing a person wants buzzed with, and no wording in the contract.
            return { skip: "unsupported_type" };
    }
}

/** {title, body} for a classified notification. `dm` = the room has exactly 2 joined members. */
export function word(n, cls, dm) {
    const sender = clean(n.sender_display_name, PUSH.NAME_MAX) || "Someone";
    const roomName = clean(n.room_name, PUSH.TITLE_MAX);
    if (cls.kind === "invite") {
        const content = isObj(n.content) ? n.content : {};
        // An unnamed DM's room_name is the inviter's own name — "Sam invited you to Sam" helps nobody.
        const where = content.is_direct === true || !roomName ? "a chat" : roomName;
        return { title: "Tin Hat", body: `${sender} invited you to ${where}` };
    }
    if (dm) return { title: sender, body: cls.text };
    return { title: roomName || "a chat", body: `${sender}: ${cls.text}` };
}

/** The JSON payload as UTF-8, guaranteed ≤ PAYLOAD_MAX bytes (title and body are cut first, never room/event/user). */
export function payloadBytes({ room, event, kind, title, body, unread, user }, max = PUSH.PAYLOAD_MAX) {
    const enc = (t, b) => Buffer.from(JSON.stringify({ v: 1, room, event, kind, title: t, body: b, unread, user }), "utf8");
    const cut = (s, n) => Array.from(s).slice(0, n).join("") + "…";
    let t = String(title), b = String(body);
    for (let i = 0; i < 100; i++) {
        const buf = enc(t, b);
        if (buf.length <= max) return buf;
        const bl = Array.from(b).length, tl = Array.from(t).length;
        if (bl > 8) b = cut(b, Math.floor(bl * 0.75));
        else if (tl > 8) t = cut(t, Math.floor(tl * 0.75));
        else break;
    }
    // only reachable with absurd ids: still one valid, visible notification
    return Buffer.from(JSON.stringify({ v: 1, room: "", event: "", kind, title: "Tin Hat", body: "New activity", unread, user: "" }), "utf8");
}

const keyedTopic = (key, ...parts) => b64u(createHmac("sha256", key).update(parts.map(String).join("\0")).digest()).slice(0, 32);
/** A browser's Topic: one per (subscription, room), keyed — the newest message of a room replaces the older one there. */
export const topicFor = (key, pushkey, room) => keyedTopic(key, "room", pushkey, room);
/** The phones' Topic: one per (subscription, event), keyed — a retry replaces itself; a room's messages stack. */
export const topicForEvent = (key, pushkey, room, event) => keyedTopic(key, "event", pushkey, room, event);

/** The Topic secret (32 random bytes, 0600 next to vapid.json): made once, kept across restarts. */
export function loadOrCreateTopicKey(path, log = () => {}) {
    try {
        const b = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
        if (b.length === 32) return b;
        log(`push-topic.key isn't 32 bytes — not replacing it; Topic labels can't be made`);
        throw new Error("bad push-topic.key");
    } catch (e) {
        if (e?.code !== "ENOENT") throw e;
    }
    const key = randomBytes(32);
    try {
        writeFileSync(path, key.toString("base64url") + "\n", { mode: 0o600, flag: "wx" }); // never over another's key
        log("made push-topic.key");
        return key;
    } catch (e) {
        if (e?.code === "EEXIST") return loadOrCreateTopicKey(path, log);
        throw e;
    }
}

const safeTag = (s) => String(s ?? "-").replace(/[^\w.:-]/g, "?").slice(0, 64) || "-";
const INSTANCE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A counting gate: at most `max` sends in flight, `queueMax` waiting; beyond that -> {busy: true}. A finishing job
 * hands its slot straight to the next waiter (the count never drops in between, so nothing can slip past the cap);
 * the count goes down only when nobody is waiting.
 */
export class Gate {
    constructor(max, queueMax) { this.max = max; this.queueMax = queueMax; this.active = 0; this.q = []; }
    async run(fn) {
        if (this.active >= this.max) {
            if (this.q.length >= this.queueMax) return { busy: true };
            await new Promise((r) => this.q.push(r)); // woken only by a finishing job, which hands over its slot
        } else {
            this.active++;
        }
        try { return await fn(); } finally {
            const next = this.q.shift();
            if (next) next();
            else this.active--;
        }
    }
}

/** How the gateway treats a push-service answer (A2.7). */
export function outcome(r) {
    if (r.busy) return "retry";
    if (r.status >= 200 && r.status < 300) return "ok";
    if (r.status === 404 || r.status === 410) return "gone";
    if (r.status === 429 || r.status >= 500) return "retry";
    if (r.status === 0) return r.reason === "timeout" || r.reason === "network" ? "retry" : "error";
    return "error";
}

/**
 * The store + handlers, without Express. deps: {auth, hs, adminToken, dir | (vapid + ownersFile), fetchImpl?,
 * now? (monotonic ms), wallNow?, log?, logError?, gatewayUrl?, pushTimeoutMs?, relay? (PUSH_RELAY: the phone apps' relay)}.
 */
export function createPush(deps) {
    const { auth, hs, adminToken } = deps;
    const now = deps.now || mono;
    const wallNow = deps.wallNow || wall;
    const log = deps.log || ((s) => console.log(s));
    const logError = deps.logError || deps.log || ((s) => console.error(s));
    const fetchImpl = deps.fetchImpl || fetch;
    const P = PUSH;
    const GATEWAY_URL = deps.gatewayUrl || P.GATEWAY_URL;
    const RELAY = relayOrigin(deps.relay);
    if (deps.relay && !RELAY) logError(`[push] PUSH_RELAY isn't an https origin -> phone pushers refused`);
    /** How an app id's subscriptions are checked: "browser" (the push-service allowlist), "relay" (phones), or null. */
    const kindOf = (appId) => (appId === P.APP_ID ? "browser" : RELAY && P.PHONE_APP_IDS.includes(appId) ? "relay" : null);
    const SUBJECT = deps.subject || P.SUBJECT;
    const timeoutMs = deps.pushTimeoutMs ?? P.PUSH_TIMEOUT_MS;
    const vapid = deps.vapid || loadOrCreateVapid(join(deps.dir, "vapid.json"), (m) => log(`[push] ${m}`));
    const topicKey = deps.topicKey || loadOrCreateTopicKey(join(deps.dir, "push-topic.key"), (m) => log(`[push] ${m}`));
    const regsFile = deps.ownersFile || join(deps.dir, "push-owners.json");

    // ── registrations (persisted, 0600): pushkey -> {mxid, quiet, at (wall ms), endpoint, p256dh, auth} ──
    let regs = new Map();
    try {
        const raw = JSON.parse(readFileSync(regsFile, "utf8"));
        if (!isObj(raw)) throw new Error("not an object");
        for (const [k, v] of Object.entries(raw)) {
            if (isObj(v) && typeof v.mxid === "string" && parseSubscription(v, RELAY, "any").ok && pushkeyFor(v.endpoint) === k)
                regs.set(k, { mxid: v.mxid, quiet: v.quiet === true, at: Number(v.at) || 0, endpoint: v.endpoint, p256dh: v.p256dh, auth: v.auth });
        }
    } catch (e) {
        if (e.code !== "ENOENT") logError(`[push] ${regsFile} unreadable (${e.message}) — starting with no registrations`);
        regs = new Map();
    }
    const fsImpl = { writeFileSync, renameSync, unlinkSync, ...(deps.fsImpl || {}) };
    const wanted = (mxid) => { for (const r of regs.values()) if (r.mxid === mxid && r.quiet) return true; return false; };

    // ── §3.4 activity (memory only, 35 s): mxid\0device\0instance -> {mxid, pushkey|null, at} ──
    const active = new Map();

    /**
     * After a user's registrations changed: without a quietWhileActive registration nothing asked for "I'm at a
     * computer" any more, so those pings go at once (A2.12 consent); foreground pings of pushkeys that are no longer
     * this user's registrations go too.
     */
    function tidyActivity(mxid) {
        const want = wanted(mxid);
        for (const [k, e] of active) {
            if (e.mxid !== mxid) continue;
            if (e.pushkey === null ? !want : regs.get(e.pushkey)?.mxid !== mxid) active.delete(k);
        }
    }

    /**
     * Change the registrations atomically: `mutate(next)` edits a copy and returns the mxids it touched; the copy is
     * written (temp file + rename) and only THEN adopted. Throws when the disk refuses — memory is left as it was,
     * so the caller can report the failure and a retry writes again (never "204" for a deletion a restart undoes).
     */
    function commitRegs(mutate) {
        const next = new Map(regs);
        const touched = mutate(next) || [];
        const tmp = `${regsFile}.tmp-${process.pid}`;
        try {
            fsImpl.writeFileSync(tmp, JSON.stringify(Object.fromEntries(next), null, 1) + "\n", { mode: 0o600 });
            fsImpl.renameSync(tmp, regsFile);
        } catch (e) {
            try { fsImpl.unlinkSync(tmp); } catch { /* never written */ }
            throw e;
        }
        regs.clear();
        for (const [k, v] of next) regs.set(k, v);
        for (const m of touched) tidyActivity(m);
    }
    /** Drop a registration whose subscription the push service says is gone; a failed save only logs (it comes back). */
    function dropGone(pk, endpoint) {
        const r = regs.get(pk);
        if (!r || r.endpoint !== endpoint) return;
        try { commitRegs((next) => { next.delete(pk); return [r.mxid]; }); }
        catch (e) { logError(`[push] could not save registrations (a gone subscription stays until the next try): ${e.message}`); }
    }

    /**
     * Why a push to pushkey K is held back, or null (A6.1). K's own foreground report holds K. Other devices are held
     * back ONLY by user-level "at a computer" activity (pushkey null) of K's owner, and only when K asked for that
     * (quietWhileActive). Another device's own-pushkey report never quiets K: a visible but idle desktop browser tab
     * must not keep the phone silent.
     */
    function suppressed(pk, t) {
        const owner = regs.get(pk);
        for (const e of active.values()) {
            if (t - e.at > P.ACTIVE_TTL_MS) continue;
            if (e.pushkey === pk) return "foreground";
            if (e.pushkey === null && owner && owner.quiet && e.mxid === owner.mxid) return "active_elsewhere";
        }
        return null;
    }

    // ── DM detection: admin room details, joined_members == 2, cached 5 min. true / false / null (lookup failed:
    //    group wording, and never a reason to drop — A2.7) ──
    const dmCache = new Map(); // room -> {dm: bool|null, exp}
    async function dmState(room) {
        const c = dmCache.get(room);
        if (c && c.exp > now()) return c.dm;
        let dm = null;
        if (adminToken) {
            try {
                const r = await hs.get(`/_synapse/admin/v1/rooms/${encodeURIComponent(room)}`, adminToken);
                if (r.ok && Number.isInteger(r.body?.joined_members)) dm = r.body.joined_members === 2;
            } catch { dm = null; }
        }
        dmCache.set(room, { dm, exp: now() + (dm === null ? P.DM_FAIL_CACHE_MS : P.DM_CACHE_MS) });
        return dm;
    }

    // ── dedup (A2.7): pushkey\0event_id -> {pending: Promise<outcome>} while a delivery runs, then {until} for 15 min
    //    after a success. The key is reserved synchronously, before the first await, so a concurrent copy of the same
    //    notification (a Synapse retry, or the same device twice in one request) waits for that one delivery and
    //    shares its outcome instead of sending again; a failed delivery releases the key so a retry can send. ──
    const delivered = new Map();
    function settleDelivery(k, entry, o) {
        if (delivered.get(k) !== entry) return;
        if (o !== "ok") { delivered.delete(k); return; }
        delivered.delete(k); // re-insert at the end: insertion order = age
        delivered.set(k, { pending: null, until: now() + P.DEDUP_MS });
        if (delivered.size > P.DEDUP_MAX) {
            for (const [key, e] of delivered) {
                if (delivered.size <= P.DEDUP_MAX) break;
                if (!e.pending) delivered.delete(key);
            }
        }
    }

    const gate = new Gate(P.CONCURRENCY, P.QUEUE_MAX);
    const gatewayLimit = new RateLimit(600, 60_000, now);
    const apiLimit = new RateLimit(60, 60_000, now);
    const testLimit = new RateLimit(1, P.TEST_INTERVAL_MS, now);
    const stats = { notify: 0, sent: 0, ok: 0, gone: 0, retry: 0, failed: 0, rejected: 0, oversize: 0, overLimit: 0, skip: {} };
    const skip = (why) => { stats.skip[why] = (stats.skip[why] || 0) + 1; };
    // app_id, push-service host, HTTP status (+ the service's short reason code), ms, 6 chars of the pushkey
    const line = (appId, host, status, ms, pk, reason = "", suffix = "", error = false) =>
        (error ? logError : log)(`[push] ${safeTag(appId)} ${safeTag(host)} ${status}${reason ? " " + reason : ""} ${ms}ms k=${safeTag(String(pk).slice(0, 6))}${suffix}`);

    const validPushkey = (k) => typeof k === "string" && k.length >= 1 && k.length <= 512 && !/[\u0000-\u001f\u007f]/.test(k);
    const tooMany = (res, lim, key) => { res.set("Retry-After", String(lim.retryAfter(key))); return res.status(429).json({ error: "too many requests" }); };

    async function send(sub, payload, topic) {
        const r = await gate.run(() => sendWebPush({
            sub, payload, vapid, subject: SUBJECT, ttl: P.PUSH_TTL, urgency: "high", topic,
            fetchImpl, timeoutMs, now, wallNow,
        }));
        return r.busy ? { status: 0, ms: 0, reason: "busy", busy: true } : r;
    }

    function sweep() {
        const t = now();
        for (const [k, e] of active) if (t - e.at > P.ACTIVE_TTL_MS) active.delete(k);
        for (const [k, v] of dmCache) if (v.exp <= t) dmCache.delete(k);
        for (const [k, v] of delivered) if (!v.pending && v.until <= t) delivered.delete(k);
        gatewayLimit.sweep(); apiLimit.sweep(); testLimit.sweep();
    }

    // ── handlers ──
    function config(_req, res) {
        noStore(res);
        // `relay` only when PUSH_RELAY is set: the phone apps subscribe there (browsers ignore it)
        res.json({ vapid: vapid.publicKey, gateway: GATEWAY_URL, app_id: P.APP_ID, ...(RELAY ? { relay: RELAY } : {}) });
    }

    async function register(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        if (!apiLimit.hit("reg:" + who.user)) return tooMany(res, apiLimit, "reg:" + who.user);
        const b = await readJson(req, P.API_BODY_LIMIT);
        if (!b.ok) return res.status(b.status).json({ error: b.error });
        const v = b.value;
        if (!isObj(v) || (v.quietWhileActive !== undefined && typeof v.quietWhileActive !== "boolean"))
            return res.status(400).json({ error: 'expected {"endpoint", "p256dh", "auth", "quietWhileActive": true|false}' });
        const sub = parseSubscription(v, RELAY, "any"); // a registration names no app id: a browser's or a phone's
        if (!sub.ok) return res.status(400).json({ error: "subscription_refused", reason: sub.reason });
        const pushkey = pushkeyFor(v.endpoint);
        const existing = regs.get(pushkey);
        if (existing && existing.mxid !== who.user) return res.status(409).json({ error: "pushkey_owned" });
        const quiet = v.quietWhileActive !== false;
        try {
            commitRegs((next) => {
                next.set(pushkey, { mxid: who.user, quiet, at: wallNow(), endpoint: v.endpoint, p256dh: v.p256dh, auth: v.auth });
                const mine = [...next].filter(([, r]) => r.mxid === who.user).sort((a, c) => a[1].at - c[1].at);
                while (mine.length > P.MAX_REGISTRATIONS_PER_USER) {
                    const [k] = mine.shift();
                    if (k !== pushkey) next.delete(k);
                }
                return [who.user];
            });
        } catch (e) {
            logError(`[push] could not save registrations: ${e.message}`);
            return res.status(503).json({ error: "could not save the registration, try again" });
        }
        res.json({ ok: true, pushkey, quietWhileActive: quiet });
    }

    function ownReg(req, res, who, pk) {
        if (!validPushkey(pk)) { res.status(400).json({ error: "pushkey required" }); return undefined; }
        const r = regs.get(pk);
        if (r && r.mxid !== who.user) { res.status(403).json({ error: "not_owner" }); return undefined; }
        return r || null;
    }

    async function registration(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        const r = ownReg(req, res, who, req.query?.pushkey);
        if (r === undefined) return;
        res.json({ registered: !!r, quietWhileActive: !!r?.quiet });
    }

    async function unregister(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        const pk = req.query?.pushkey;
        const r = ownReg(req, res, who, pk);
        if (r === undefined) return;
        if (r) {
            try { commitRegs((next) => { next.delete(pk); return [who.user]; }); }
            catch (e) {
                logError(`[push] could not save registrations: ${e.message}`);
                return res.status(503).json({ error: "could not remove the registration, try again" });
            }
        }
        for (const [k, e] of active) if (e.pushkey === pk && e.mxid === who.user) active.delete(k);
        res.status(204).end();
    }

    async function quietWanted(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        res.json({ wanted: wanted(who.user) });
    }

    async function activeHandler(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        if (!apiLimit.hit("act:" + who.user)) return tooMany(res, apiLimit, "act:" + who.user);
        const b = await readJson(req, P.API_BODY_LIMIT);
        if (!b.ok) return res.status(b.status).json({ error: b.error });
        const v = b.value;
        const pk = isObj(v) ? (v.pushkey ?? null) : undefined;
        const instance = isObj(v) ? (v.instance ?? "-") : undefined;
        if (!isObj(v) || typeof v.visible !== "boolean" || (pk !== null && !validPushkey(pk))
            || (instance !== "-" && (typeof instance !== "string" || !INSTANCE_RE.test(instance))))
            return res.status(400).json({ error: 'expected {"pushkey": "…"|null, "visible": true|false, "instance": "<id>"}' });
        if (pk !== null && regs.get(pk)?.mxid !== who.user) return res.status(403).json({ error: "not_owner" });
        const want = wanted(who.user);
        const key = `${who.user}\0${who.device}\0${instance}`;
        const t = now();
        // Consent (A2.12): "I'm at a computer" is kept only while one of my registrations asked for it.
        if (v.visible && (pk !== null || want)) {
            active.set(key, { mxid: who.user, pushkey: pk, at: t });
            if (active.size > 20_000) sweep();
        } else {
            active.delete(key);
        }
        res.json({ ok: true, ttl: P.ACTIVE_TTL_MS / 1000, wanted: want });
    }

    async function test(req, res) {
        noStore(res);
        const who = await auth.authenticate(req, res);
        if (!who) return;
        const b = await readJson(req, P.API_BODY_LIMIT);
        if (!b.ok) return res.status(b.status).json({ error: b.error });
        const v = b.value;
        if (!isObj(v)) return res.status(400).json({ error: 'expected {"pushkey": "…"}' });
        const reg = ownReg(req, res, who, v.pushkey);
        if (reg === undefined) return;
        if (!reg) return res.status(404).json({ error: "not_registered" });
        const sub = parseSubscription(reg, RELAY, "any");
        if (!sub.ok) return res.status(400).json({ error: "subscription_refused", reason: sub.reason });
        if (!testLimit.hit(who.user)) {
            res.set("Retry-After", String(testLimit.retryAfter(who.user)));
            return res.status(429).json({ error: "rate_limited", retry_after: testLimit.retryAfter(who.user) });
        }
        const payload = payloadBytes({ room: "", event: "", kind: "message", title: "Tin Hat", body: "Notifications work on this device.", unread: null, user: who.user },
            sub.viaRelay ? P.PHONE_PAYLOAD_MAX : P.PAYLOAD_MAX);
        const r = await send(sub, payload, undefined);
        const o = outcome(r);
        line(sub.viaRelay ? "phone" : P.APP_ID, sub.endpoint.hostname, r.status || r.reason, r.ms, v.pushkey, r.status ? r.reason : "", " (test)", o === "error");
        if (o === "ok") return res.json({ ok: true, status: r.status });
        if (o === "gone") dropGone(v.pushkey, reg.endpoint);
        return res.status(502).json({ ok: false, status: r.status, gone: o === "gone", error: r.status ? `push service answered ${r.status}` : `push failed (${r.reason})` });
    }

    async function notify(req, res) {
        noStore(res);
        const b = await readJson(req, P.GATEWAY_BODY_LIMIT);
        if (!b.ok) {
            if (b.status === 413) { stats.oversize++; return res.json({ rejected: [] }); } // retrying can't help
            return res.status(400).json({ error: b.error });
        }
        const n = isObj(b.value) ? b.value.notification : undefined;
        if (!isObj(n)) return res.status(400).json({ error: 'expected {"notification": {…}}' });
        stats.notify++;
        if (!gatewayLimit.hit("all")) { stats.overLimit++; return res.status(502).json({ error: "busy, retry later" }); }

        const devices = Array.isArray(n.devices) ? n.devices.slice(0, P.MAX_DEVICES_PER_NOTIFY) : [];
        let cls = classify(n);
        let dm; // Promise<true|false|null>, once per notification, only when needed
        const roomDm = () => (dm ??= dmState(n.room_id));
        // A5.9: call-key-sized encrypted events are dropped unless the room is (or may be) a DM.
        if (!cls.skip && isCallKeySized(n) && devices.some((d) => isObj(d) && kindOf(d.app_id)) && (await roomDm()) === false)
            cls = { skip: "call_key" };
        const rejected = [];
        const jobs = [];
        let retry = false;
        const t = now();
        const account = (pk) => (o) => { if (o === "gone") rejected.push(pk); else if (o === "retry") retry = true; };
        for (const d of devices) {
            if (!isObj(d) || !validPushkey(d.pushkey)) continue;
            const pk = d.pushkey;
            const kind = kindOf(d.app_id); // dev.tinhat.web → a browser push service; a phone app → the relay only
            if (!kind) { rejected.push(pk); stats.rejected++; line(d.app_id, "-", "rejected:app_id", 0, pk); continue; }
            const sub = parseSubscription(d.data, RELAY, kind);
            if (!sub.ok) { rejected.push(pk); stats.rejected++; line(d.app_id, "-", `rejected:${sub.reason}`, 0, pk); continue; }
            // A pushkey is bound to the subscription it arrived with — base64url(sha256(endpoint)), exactly as the
            // server derives it at registration. Anything else could borrow another user's pushkey (owner, activity)
            // for a subscription it controls, so it is rejected before dedup, suppression or any owner lookup.
            if (pk !== pushkeyFor(d.data.endpoint)) { rejected.push(pk); stats.rejected++; line(d.app_id, "-", "rejected:pushkey_mismatch", 0, pk); continue; }
            if (cls.skip) { skip(cls.skip); continue; }
            const tw = isObj(d.tweaks) ? d.tweaks : {};
            const highlight = tw.highlight === true;
            const sound = tw.sound !== undefined && tw.sound !== null && tw.sound !== false && tw.sound !== "";
            if (!highlight && !sound) { skip("silent"); continue; }
            const dedupKey = pk + "\0" + n.event_id;
            const prior = delivered.get(dedupKey);
            if (prior?.pending) { skip("duplicate"); jobs.push(prior.pending.then(account(pk))); continue; } // share it
            if (prior && prior.until > t) { skip("duplicate"); continue; }
            const why = suppressed(pk, t);
            if (why) { skip(why); continue; }
            const entry = { pending: null, until: 0 };
            delivered.set(dedupKey, entry); // reserved synchronously, before the first await
            entry.pending = deliver(n, cls, pk, sub, d.data.endpoint, roomDm, d.app_id);
            entry.pending.then((o) => settleDelivery(dedupKey, entry, o));
            jobs.push(entry.pending.then(account(pk)));
        }
        await Promise.all(jobs);
        if (retry) return res.status(502).json({ error: "push service unavailable, retry later" });
        res.json({ rejected: [...new Set(rejected)] });
    }

    /** One delivery: word it, encrypt, send, account for the answer. Resolves to its outcome; never rejects. */
    async function deliver(n, cls, pk, sub, endpoint, roomDm, appId = P.APP_ID) {
        try {
            const isDirect = cls.kind === "message" ? (await roomDm()) === true : false;
            const { title, body } = word(n, cls, isDirect);
            const user = regs.get(pk)?.mxid || "";
            // unread: null — the service worker counts the badge itself (A5.10), counts.unread is not it
            const phone = appId !== P.APP_ID;
            const payload = payloadBytes({ room: n.room_id, event: n.event_id, kind: cls.kind, title, body, unread: null, user },
                phone ? P.PHONE_PAYLOAD_MAX : P.PAYLOAD_MAX);
            const r = await send(sub, payload, phone ? topicForEvent(topicKey, pk, n.room_id, n.event_id) : topicFor(topicKey, pk, n.room_id));
            const o = outcome(r);
            if (!r.busy) stats.sent++;
            if (o === "ok") stats.ok++;
            else if (o === "gone") { stats.gone++; dropGone(pk, endpoint); }
            else if (o === "retry") stats.retry++;
            else stats.failed++;
            line(appId, sub.endpoint.hostname, r.status || r.reason, r.ms, pk, r.status ? r.reason : "",
                o === "gone" ? " -> rejected" : o === "retry" ? " -> retry" : "", o === "error");
            return o;
        } catch (e) {
            logError(`[push] delivery failed: ${e?.message || e}`);
            return "error";
        }
    }

    function report() {
        const s = JSON.parse(JSON.stringify(stats));
        for (const k of Object.keys(stats)) stats[k] = k === "skip" ? {} : 0;
        const skips = Object.entries(s.skip).map(([k, v]) => `${k} ${v}`).join(", ");
        if (!s.notify && !s.oversize && !skips) return;
        log(`[push] last period: ${s.notify} notifications, ${s.sent} sent (${s.ok} ok, ${s.gone} gone, ${s.retry} retry, ${s.failed} failed), ` +
            `${s.rejected} rejected, ${s.oversize} oversize, ${s.overLimit} over the gateway limit; skipped: ${skips || "none"}; ` +
            `${regs.size} registration(s)`);
    }

    return {
        config, register, registration, unregister, quietWanted, active: activeHandler, test, notify, report, sweep, suppressed,
        _regs: regs, _active: active, _topicKey: topicKey, vapidPublic: vapid.publicKey,
    };
}

/** Serve ONLY the gateway route on its own listener (so no public vhost path can reach it). */
export function startGatewayServer(p, { host = "127.0.0.1", port = 3091, log = console.log } = {}) {
    const server = createServer((req, res) => {
        res.status = (c) => { res.statusCode = c; return res; };
        res.set = (k, v) => { res.setHeader(k, v); return res; };
        res.json = (o) => {
            const body = Buffer.from(JSON.stringify(o));
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Length", body.length);
            res.end(body);
            return res;
        };
        let path = "";
        try { path = new URL(req.url, "http://gateway").pathname; } catch { /* malformed */ }
        if (req.method !== "POST" || path !== PUSH.GATEWAY_PATH) { req.resume(); return res.status(404).json({ error: "not found" }); }
        // Even an internal failure is a 200 to Synapse: replaying a notification that crashes us would stall the pusher.
        Promise.resolve(p.notify(req, res)).catch((e) => {
            console.error(`[push] gateway error: ${e?.message || e}`);
            if (!res.headersSent) res.json({ rejected: [] });
        });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on("error", (e) => console.error(`[push] gateway listener ${host}:${port} failed: ${e.message} -> Synapse can't deliver`));
    server.listen(port, host, () => log(`[push] gateway listening on ${host}:${port}${PUSH.GATEWAY_PATH}`));
    return server;
}

/**
 * Mount the API on the Express app and start the gateway listener.
 * deps: {auth, hs, adminToken, dir, log?, gatewayUrl?, gatewayListen?: {host, port}, reportEveryMs?}.
 */
export function installPush(app, deps) {
    let p;
    try { p = createPush(deps); } catch (e) {
        console.error(`[push] could not start (${e.message}) -> web push DISABLED`);
        const off = (_req, res) => { noStore(res); res.status(503).json({ error: "web push isn't set up on this server" }); };
        app.get("/push/config", off); app.post("/push/register", off); app.get("/push/register", off); app.delete("/push/register", off);
        app.get("/push/quiet-wanted", off); app.post("/push/active", off); app.post("/push/test", off);
        return null;
    }
    app.get("/push/config", p.config);
    app.post("/push/register", safe("push", p.register));
    app.get("/push/register", safe("push", p.registration));
    app.delete("/push/register", safe("push", p.unregister));
    app.get("/push/quiet-wanted", safe("push", p.quietWanted));
    app.post("/push/active", safe("push", p.active));
    app.post("/push/test", safe("push", p.test));
    startGatewayServer(p, { ...(deps.gatewayListen || {}), log: deps.log || console.log });
    setInterval(() => { try { p.sweep(); } catch { /* never fatal */ } }, PUSH.SWEEP_MS).unref?.();
    const every = deps.reportEveryMs ?? 10 * 60_000;
    if (every > 0) setInterval(() => { try { p.report(); } catch { /* never fatal */ } }, every).unref?.();
    if (!deps.adminToken) console.error("[push] synapse-admin.token missing -> DMs can't be told from groups (group wording)");
    const relay = relayOrigin(deps.relay);
    (deps.log || console.log)(`[push] ready — app_id ${PUSH.APP_ID}, gateway ${deps.gatewayUrl || PUSH.GATEWAY_URL}` +
        (relay ? `, phone apps via ${new URL(relay).host}` : ""));
    return p;
}
