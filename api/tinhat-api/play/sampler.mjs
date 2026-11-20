// Earning (GAMES-V1-SPEC §2.3, rev 2 §1.1): every 60 s the API asks ITS OWN call server who is connected, keeps only
// people who have a wallet in the room's game space (everyone else is dropped at once, never stored, never logged),
// and credits each eligible person once per sample through ledger.sample (the compare-and-set on credited_through).
// Stored: per wallet only accrual_s, credited_through, earned_today, day (ledger.mjs). Logged: counts only.
import { inTx } from "./db.mjs";
import * as L from "./ledger.mjs";

export const SAMPLER = Object.freeze({ EVERY_MS: 60_000, IDLE_MS: 30 * 60_000, ROOM_CACHE_MS: 5 * 60_000, SWEEP_MS: 24 * 3600_000 });

/** The person behind a call-server identity: "@a:x:DEVICE", "@a:x:DEVICE~pad-mic-<hex>" (a Pad connection folds into
 *  the person), or the re-minted `tinhat.person` attribute when present. null = not a person (Watch, malformed). */
export function personOf(p) {
    const attr = p?.attributes?.["tinhat.person"];
    if (typeof attr === "string" && /^@[^:\s]+:\S+$/.test(attr)) return attr;
    const id = String(p?.identity || "");
    if (/~watch-/.test(id)) return null;
    const base = id.replace(/~pad-(mic|cam)-[0-9a-f]{16}$/, "");
    const i = base.lastIndexOf(":");
    if (i <= 0) return null;
    const mx = base.slice(0, i);
    return /^@[^:\s]+:\S+$/.test(mx) ? mx : null;
}

/** Is this participant showing life right now (mic open, a camera or a screen published)? */
export function liveSignal(p) {
    for (const t of p?.tracks || []) {
        const src = String(t.source ?? "");
        const muted = !!t.muted;
        if (!muted && (src === "MICROPHONE" || src === "2" || src === "CAMERA" || src === "1" || src === "SCREEN_SHARE" || src === "3" || src === "SCREEN_SHARE_AUDIO" || src === "4")) return true;
    }
    return false;
}

/**
 * The eligibility rule for one person in one room (pure; §2.3 1-5). ctx: {person, connected: Set of people in that
 * call, joined: Set, inCall: Set (live call memberships), away: Set (BRB), lastActive: ms|undefined, now, isGuest(u),
 * isRecorder(u)} → {eligible, why}.
 */
export function eligibility(ctx) {
    const u = ctx.person;
    if (!ctx.joined.has(u)) return { eligible: false, why: "not-joined" };
    if (!ctx.inCall.has(u)) return { eligible: false, why: "no-membership" };
    const others = [...ctx.connected].filter((x) => x !== u && !ctx.isGuest(x) && !ctx.isRecorder(x));
    if (!others.length) return { eligible: false, why: "alone" };
    if (ctx.away.has(u)) return { eligible: false, why: "brb" };
    if (ctx.lastActive === undefined || ctx.now - ctx.lastActive > SAMPLER.IDLE_MS) return { eligible: false, why: "idle" };
    return { eligible: true, why: "" };
}

/**
 * createSampler({pool, cfg, lk: {listRooms() → [{name}], participants(room) → [...]}, spaces, roomAway(room) → Set,
 *   isGuest, isRecorder, serverName, now, log}) → {run(), touch(user), start(), stop()}
 */
export function createSampler(deps) {
    const { pool, cfg, lk, spaces } = deps;
    const now = deps.now || Date.now;
    const log = deps.log || ((s) => console.log(s));
    const isGuest = deps.isGuest || ((u) => /^@guest-/i.test(u));
    const isRecorder = deps.isRecorder || (() => false);
    // in memory only, never stored (§2.3 4): when each CONNECTED person last showed life; dropped when they leave
    const lastActive = new Map();
    let timer = null, running = false, lastSweep = 0;

    async function run() {
        if (running) return { skipped: true };
        running = true;
        const t = now();
        let rooms = 0, people = 0, chips = 0;
        let client = null;
        try {
            client = await pool.connect();
            // one sampler at a time across processes (§2.3 "One sampler, once per interval")
            const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext('tinhat_play:sampler')) AS ok");
            if (!rows[0].ok) return { skipped: true };
            try {
                const list = (await lk.listRooms()) || [];
                const seenNow = new Set();
                const best = new Map(); // person → {room, sid, wid, createdTs, ctx}
                const others = []; // every OTHER (person, space) wallet seen connected: its clock moves on, unpaid
                for (const r of list) {
                    if (!/^![^:\s]+:\S+$/.test(String(r.name))) continue; // only calls named after a Matrix room
                    let res;
                    try { res = await spaces.resolve(r.name); } catch { continue; }
                    if (!res || res.why !== "" || !res.room) continue; // no game space this server keeps: nobody earns here
                    const parts = (await lk.participants(r.name)) || [];
                    const connected = new Set();
                    const signal = new Map();
                    for (const p of parts) {
                        const u = personOf(p); if (!u) continue;
                        connected.add(u);
                        if (liveSignal(p)) signal.set(u, true);
                    }
                    if (!connected.size) continue;
                    rooms++;
                    const sid = await L.sidOf(client, res.space);
                    if (!sid) continue; // nobody has opted in to that space
                    const inCall = new Set(res.room.sessions.map((s) => s.sender));
                    const created = new Map(); for (const s of res.room.sessions) created.set(s.sender, Math.max(created.get(s.sender) || 0, s.createdTs || 0));
                    const away = res.room.away || new Set();
                    for (const u of connected) {
                        // only people with a wallet in THIS space go any further; everyone else is dropped here, unlogged
                        const wid = await L.widOfUser(client, sid, u);
                        if (!wid) continue;
                        if (!res.spaceJoined.has(u)) continue; // left the space: the wallet is frozen (§1.1)
                        seenNow.add(u);
                        if (!lastActive.has(u)) lastActive.set(u, t); // joining the call counts as showing life
                        if (signal.get(u)) lastActive.set(u, t);
                        const ctx = { person: u, connected, joined: res.room.joined, inCall, away, lastActive: lastActive.get(u), now: t, isGuest, isRecorder };
                        const c = created.get(u) || 0;
                        const prev = best.get(u);
                        if (!prev || c > prev.createdTs) { if (prev) others.push(prev); best.set(u, { sid, wid, createdTs: c, ctx }); } // the newest live membership
                        else others.push({ sid, wid, createdTs: c, ctx });
                    }
                }
                for (const u of [...lastActive.keys()]) if (!seenNow.has(u)) lastActive.delete(u);
                // a person connected in two spaces' calls is paid in one; the other wallets' clocks move on too (so switching
                // which call is "newest" can never pay the same seconds twice)
                for (const o of others) {
                    if (best.get(o.ctx.person)?.wid === o.wid) continue;
                    const { rows: w } = await client.query("SELECT credited_through FROM play_wallets WHERE wid = $1", [o.wid]);
                    const seen = w.length && w[0].credited_through ? new Date(w[0].credited_through).getTime() : null;
                    await inTx(pool, (c) => L.sample(c, { sid: o.sid, wid: o.wid, cfg, now: t, seen: seen ?? undefined, eligible: false }));
                }
                for (const [u, b] of best) {
                    const el = eligibility(b.ctx);
                    people++;
                    const { rows: w } = await client.query("SELECT credited_through FROM play_wallets WHERE wid = $1", [b.wid]);
                    const seen = w.length && w[0].credited_through ? new Date(w[0].credited_through).getTime() : null;
                    const r = await inTx(pool, (c) => L.sample(c, { sid: b.sid, wid: b.wid, cfg, now: t, seen: seen ?? undefined, eligible: el.eligible, provisional: deps.provisional ? () => deps.provisional(b.wid) : 0 }));
                    chips += r.chips || 0;
                    if (r.chips && deps.onCredit) { try { await deps.onCredit(b.wid, b.sid); } catch { /* a push is best effort */ } }
                    void u;
                }
                if (t - lastSweep > SAMPLER.SWEEP_MS / 24) { // hourly: credited_through is cleared once a wallet had no sample for 24 h
                    lastSweep = t;
                    // rows locked in wid order, like every other wallet lock (no cycle with commits / top-ups)
                    await client.query("UPDATE play_wallets SET credited_through = NULL WHERE wid IN (SELECT wid FROM play_wallets WHERE credited_through < $1 ORDER BY wid FOR UPDATE)", [new Date(t - SAMPLER.SWEEP_MS)]);
                }
            } finally {
                await client.query("SELECT pg_advisory_unlock(hashtext('tinhat_play:sampler'))").catch(() => {});
            }
        } catch (e) {
            log(`[play] sampler: ${e.message}`);
        } finally {
            client?.release();
            running = false;
        }
        if (rooms || chips) log(`[play] sampler: ${rooms} rooms, ${people} people, ${chips} chips`);
        return { rooms, people, chips };
    }
    return {
        run,
        touch(user) { if (lastActive.has(user)) lastActive.set(user, now()); }, // a game move counts as showing life
        start() { if (!timer) { timer = setInterval(() => { run().catch(() => {}); }, SAMPLER.EVERY_MS); timer.unref?.(); } },
        stop() { clearInterval(timer); timer = null; },
        _lastActive: lastActive,
        setProvisional(fn) { deps.provisional = fn; },
        setOnCredit(fn) { deps.onCredit = fn; },
    };
}
