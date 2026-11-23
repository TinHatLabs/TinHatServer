// F8, the admin money screen's API (GAMES-V1.1-ADDENDUM §5): per space, its admins (power level >= PLAY_ADMIN_RANK in
// the space room) and the server owner (a Synapse server admin here) may grant / remove / set / reset chips and ranks
// and tune the space's economy. Only the server that keeps the space answers. Every change is ONE database
// transaction: the journal transaction(s) (double-entry, mint:admin / burn:admin), the append-only log row, the why-text
// apart, the notices to the people changed and the durable op receipt. Nothing is ever rewritten. People with open
// money (at a table, in a round) show no balance anywhere here and only ever get a grant.
import { createHash } from "node:crypto";
import * as rules from "./rules.mjs";
import * as L from "./ledger.mjs";
import { inTx } from "./db.mjs";

export const ADMIN = Object.freeze({
    PLAY_ADMIN_RANK: 100,
    ADMIN_MAX_DELTA: 10_000, ADMIN_MAX_SET: 100_000, ADMIN_MAX_TARGETS: 100, ADMIN_RANK_MAX: 50,
    ADMIN_LOG_DAYS: 180, WRITES_PER_MIN: 30, LOG_PAGE: 50, NOTICES_PAGE: 10,
});
const ACTIONS = ["grant", "remove", "set", "reset", "rank"];
const MXID_RE = /^@[^:\s]+:\S+$/;
const OP_RE = /^[A-Za-z0-9_-]{16,32}$/;
const mintAdmin = (sid) => `mint:admin:${sid}`;
const burnAdmin = (sid) => `burn:admin:${sid}`;
const hashOf = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

/** The chips an admin action moves for one wallet, pure (vectors/ledger-v1.1.json `admin_delta`): + mints, − burns. */
export function adminDelta({ action, amount, balance, start }) {
    if (action === "grant") return amount;
    if (action === "remove") return -Math.min(amount, balance);
    if (action === "set") return amount - balance;
    if (action === "reset") return start - balance;
    return 0; // rank: no chips
}

/** The optional why-text (§5.4): 1–140 characters, no control characters, no links, nothing that looks like a Matrix id. */
export function reasonOk(t) {
    if (t === undefined || t === null) return true;
    if (typeof t !== "string") return false;
    const s = t.trim();
    if (s.length < 1 || s.length > 140) return false;
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return false;
    if (/[a-z][a-z0-9+.-]*:(\/\/|[^\s]*@)/i.test(s) || /www\./i.test(s) || /\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(s)) return false; // any scheme (mailto too), any domain (astra r2/r3 N9)
    if (/@[^\s:]+:[^\s]+/.test(s) || /^@/.test(s)) return false;
    return true;
}

/**
 * createAdmin({ pool, cfg, serverName, spaceInfo(space) → {owner, joined:Set, levelOf(u)}|null, isServerAdmin(u) → bool,
 *   now, Refusal, RateLimit, onWalletChanged(wid, sid), openMoney(c, wid) → bool })
 */
export function createAdmin(d) {
    const { pool, cfg, serverName, Refusal } = d;
    const now = d.now || Date.now;
    const perAdmin = new d.RateLimit(ADMIN.WRITES_PER_MIN, 60_000);

    /** Who may: a joined member of the space who is a space admin, or the server owner; only on the keeping server. */
    async function adminOf(user, space) {
        if (typeof space !== "string" || !/^![^:\s]+:\S+$/.test(space)) throw new Refusal("bad");
        const info = await d.spaceInfo(space);
        if (!info) throw new Refusal("unavailable");
        if (!info.joined.has(user)) throw new Refusal("not-member");
        if (info.owner !== serverName) throw new Refusal("wrong-server", { space, server: info.owner });
        const level = typeof info.levelOf === "function" ? Number(info.levelOf(user)) : 0;
        if (Number.isFinite(level) && level >= ADMIN.PLAY_ADMIN_RANK) return { info, role: "space-admin" };
        if (user.endsWith(`:${serverName}`) && await d.isServerAdmin(user).catch(() => false) === true) return { info, role: "server-owner" };
        throw new Refusal("not-admin");
    }
    async function sidOf(c, space) { return L.ensureSpace(c, space, serverName); }
    async function economyOf(c, sid) {
        const e = await L.spaceCfg(c, sid, cfg);
        return Object.fromEntries(rules.ECONOMY_KEYS.map((k) => [k, { value: e[k], source: e.src?.[k] || "default" }]));
    }
    /** Current members' wallets in the space: [{u, wid, rank, open, balance}] (balance null with open money). */
    async function walletsOf(c, sid, info) {
        const { rows: all } = await c.query("SELECT p.user_id, p.wid FROM play_people p WHERE p.sid = $1", [sid]);
        // the v1 locks (sorted wids) for the whole read, so the open-money check and the balance agree (astra r1 #2)
        const locked = new Map((await L._impl.lockWallets(c, all.filter((r) => info.joined.has(r.user_id)).map((r) => r.wid))).map((w) => [w.wid, w]));
        const rows = all.filter((r) => locked.has(r.wid)).map((r) => ({ ...r, rank: locked.get(r.wid).rank })).sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
        const out = [];
        for (const r of rows) {
            if (!info.joined.has(r.user_id)) continue;
            const open = await d.openMoney(c, r.wid);
            const h = await L.holdingsOf(c, r.wid);
            out.push({ u: r.user_id, wid: r.wid, rank: r.rank, open, balance: open ? null : h.wallet });
        }
        return out;
    }

    async function getSpace(user, space) {
        const { info, role } = await adminOf(user, space);
        return inTx(pool, async (c) => {
            const sid = await sidOf(c, space);
            const e = await L.spaceCfg(c, sid, cfg);
            const ws = await walletsOf(c, sid, info);
            return { v: 1, space, you: { admin: true, why: role }, economy: await economyOf(c, sid),
                wallets: ws.map((w) => ({ u: w.u, balance: w.balance, rank: w.rank, cap: rules.capOf(w.rank, e), open: w.open })) };
        });
    }

    async function actor(c, sid, user) {
        const { rows } = await c.query("INSERT INTO play_admin_actors (sid, user_id) VALUES ($1, $2) ON CONFLICT (sid, user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING aid", [sid, user]);
        return Number(rows[0].aid);
    }
    async function receipt(c, sid, aid, op, req) {
        const { rows } = await c.query("SELECT req_hash, answer FROM play_admin_ops WHERE sid = $1 AND aid = $2 AND op = $3", [sid, aid, op]);
        if (!rows.length) return null;
        if (rows[0].req_hash !== hashOf(req)) throw new Refusal("op-reused");
        return { ...rows[0].answer, dup: true };
    }
    async function logRow(c, { sid, aid, role, action, wid = null, amount = null, count = null, before = null, after = null, reason = null, net = 0 }) {
        const { rows } = await c.query("INSERT INTO play_admin_log (sid, aid, role, action, target_wid, amount, count, before, after, net) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, at",
            [sid, aid, role, action, wid, amount, count, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, net]);
        const id = Number(rows[0].id);
        if (reason) await c.query("INSERT INTO play_admin_reasons (log_id, text) VALUES ($1, $2)", [id, reason.trim()]);
        return id;
    }

    /** POST /admin/spaces/{space}/wallets (§5.2, §5.3). */
    async function changeWallets(user, space, b) {
        const { info, role } = await adminOf(user, space);
        if (!b || typeof b !== "object" || !OP_RE.test(b.op || "") || !ACTIONS.includes(b.action)) throw new Refusal("bad");
        const everyone = b.who === "everyone";
        if (!everyone) {
            if (!Array.isArray(b.who) || b.who.length < 1 || b.who.length > ADMIN.ADMIN_MAX_TARGETS || new Set(b.who).size !== b.who.length || !b.who.every((u) => typeof u === "string" && MXID_RE.test(u))) throw new Refusal("bad");
        }
        const n = b.amount;
        const bounds = { grant: [1, ADMIN.ADMIN_MAX_DELTA], remove: [1, ADMIN.ADMIN_MAX_DELTA], set: [0, ADMIN.ADMIN_MAX_SET], rank: [0, ADMIN.ADMIN_RANK_MAX] }[b.action];
        if (bounds && !(Number.isSafeInteger(n) && n >= bounds[0] && n <= bounds[1])) throw new Refusal("bad-amount");
        if (!bounds && n !== undefined) throw new Refusal("bad-amount");
        if (!reasonOk(b.reason)) throw new Refusal("bad-reason");
        if (!perAdmin.hit(user)) throw new Refusal("rate"); // 30 writes a minute per admin, across spaces (astra r1 #4)
        const req = { action: b.action, who: everyone ? "everyone" : [...b.who].sort(), amount: n ?? null, reason: b.reason ?? null };
        const changed = [];
        const out = await inTx(pool, async (c) => {
            const sid = await sidOf(c, space);
            const aid = await actor(c, sid, user);
            const dup = await receipt(c, sid, aid, b.op, req);
            if (dup) return dup;
            const e = await L.spaceCfg(c, sid, cfg);
            // the targets: current members with a wallet in this space
            let targets;
            if (everyone) {
                const { rows } = await c.query("SELECT user_id, wid FROM play_people WHERE sid = $1", [sid]);
                targets = rows.filter((r) => info.joined.has(r.user_id)).map((r) => ({ u: r.user_id, wid: r.wid }));
            } else {
                const { rows } = await c.query("SELECT user_id, wid FROM play_people WHERE sid = $1 AND user_id = ANY($2)", [sid, b.who]);
                const by = new Map(rows.map((r) => [r.user_id, r.wid]));
                const missing = b.who.filter((u) => !by.has(u) || !info.joined.has(u));
                if (missing.length) throw new Refusal("no-wallet", { who: missing });
                targets = b.who.map((u) => ({ u, wid: by.get(u) }));
            }
            // the v1 locks: wallet rows FOR UPDATE in sorted wid order, then each person's open money, in this transaction
            const locked = new Map((await L._impl.lockWallets(c, targets.map((t) => t.wid))).map((w) => [w.wid, w]));
            for (const t of targets) { t.w = locked.get(t.wid); t.open = await d.openMoney(c, t.wid); t.h = await L.holdingsOf(c, t.wid); }
            const gone = targets.filter((t) => !t.w);
            if (!everyone && gone.length) throw new Refusal("no-wallet", { who: gone.map((t) => t.u) }); // all-or-nothing (astra r1 #5)
            const live = targets.filter((t) => t.w); // everyone: a wallet deleted meanwhile is simply not there
            const blocked = b.action === "grant" ? [] : live.filter((t) => t.open);
            if (!everyone && blocked.length) throw new Refusal("at-table", { who: blocked.map((t) => t.u) });
            const skipped = blocked.map((t) => ({ u: t.u, code: "at-table" }));
            const doing = live.filter((t) => !blocked.includes(t));
            const done = [];
            let firstLog = null;
            const day = rules.dayOf(now(), cfg.tz);
            // one log row per named person, one row for "everyone"; each changed wallet = one journal transaction
            // the deltas first (from the locked balances): each log row records the net it moves, which the audit checks
            for (const t of doing) t.delta = adminDelta({ action: b.action, amount: n, balance: t.h.wallet, start: e.start });
            let groupLog = null;
            if (everyone) groupLog = firstLog = await logRow(c, { sid, aid, role, action: b.action, amount: n ?? null, count: doing.length, reason: b.reason, net: doing.reduce((x, t) => x + t.delta, 0) });
            for (const t of doing) {
                const bal = t.h.wallet;
                const delta = t.delta;
                const before = t.open ? null : { balance: bal, rank: t.w.rank };
                const after = t.open ? null : { balance: bal + delta, rank: b.action === "rank" ? n : t.w.rank };
                const logId = groupLog ?? await logRow(c, { sid, aid, role, action: b.action, wid: t.wid, amount: n ?? null, count: 1,
                    before: t.open ? { granted: n } : before, after: t.open ? { granted: n } : after, reason: b.reason, net: delta });
                if (firstLog === null) firstLog = logId;
                if (delta !== 0) {
                    const entries = delta > 0 ? [[mintAdmin(sid), -delta], [L.acct.w(t.wid), delta]] : [[L.acct.w(t.wid), delta], [burnAdmin(sid), -delta]];
                    await L.post(c, { sid, kind: "admin", idem: `admin:${logId}:${t.wid}`, ref: `alog:${logId}`, day, at: new Date(now()), entries });
                }
                if (b.action === "rank") await c.query("UPDATE play_wallets SET rank = $2, version = version + 1 WHERE wid = $1", [t.wid, n]);
                await c.query("INSERT INTO play_notices (wid, log_id) VALUES ($1, $2)", [t.wid, logId]);
                done.push(t.open ? { u: t.u, before: { granted: n }, after: { granted: n } } : { u: t.u, before, after });
                changed.push({ wid: t.wid, sid });
            }
            if (firstLog === null) firstLog = await logRow(c, { sid, aid, role, action: b.action, amount: n ?? null, count: 0, reason: b.reason });
            const answer = { done, skipped, log: firstLog };
            await c.query("INSERT INTO play_admin_ops (sid, aid, op, req_hash, answer, log_id) VALUES ($1,$2,$3,$4,$5,$6)", [sid, aid, b.op, hashOf(req), JSON.stringify(answer), firstLog]);
            return { ...answer, dup: false };
        });
        for (const x of changed) d.onWalletChanged?.(x.wid, x.sid);
        return out;
    }

    /** PUT /admin/spaces/{space}/economy (§5.2): set and/or reset keys; nothing retroactive. */
    async function changeEconomy(user, space, b) {
        const { role } = await adminOf(user, space);
        if (!b || typeof b !== "object" || !OP_RE.test(b.op || "")) throw new Refusal("bad");
        const set = b.set === undefined ? {} : b.set;
        const reset = b.reset === undefined ? [] : b.reset;
        if (typeof set !== "object" || set === null || Array.isArray(set) || !Array.isArray(reset)) throw new Refusal("bad");
        if (!Object.keys(set).length && !reset.length) throw new Refusal("bad");
        for (const k of [...Object.keys(set), ...reset]) if (!rules.ECONOMY_KEYS.includes(k)) throw new Refusal("bad");
        for (const [k, v] of Object.entries(set)) {
            if (rules.economyValue(k, v) === undefined) { const bd = rules.ECONOMY_BOUNDS[k]; throw new Refusal("bad-value", bd.bool ? { key: k } : { key: k, min: bd.min, max: bd.max }); }
        }
        if (!reasonOk(b.reason)) throw new Refusal("bad-reason");
        if (!perAdmin.hit(user)) throw new Refusal("rate");
        const req = { set, reset: [...reset].sort(), reason: b.reason ?? null };
        return inTx(pool, async (c) => {
            const sid = await sidOf(c, space);
            const aid = await actor(c, sid, user);
            const dup = await receipt(c, sid, aid, b.op, req);
            if (dup) return dup;
            await c.query("INSERT INTO play_space_economy (sid) VALUES ($1) ON CONFLICT (sid) DO NOTHING", [sid]);
            const { rows } = await c.query("SELECT settings FROM play_space_economy WHERE sid = $1 FOR UPDATE", [sid]);
            const before = rows[0].settings || {};
            const after = { ...before, ...set };
            for (const k of reset) delete after[k];
            await c.query("UPDATE play_space_economy SET settings = $2, updated_at = now() WHERE sid = $1", [sid, JSON.stringify(after)]);
            const logId = await logRow(c, { sid, aid, role, action: "economy", before, after, reason: b.reason });
            const answer = { economy: await economyOf(c, sid), log: logId };
            await c.query("INSERT INTO play_admin_ops (sid, aid, op, req_hash, answer, log_id) VALUES ($1,$2,$3,$4,$5,$6)", [sid, aid, b.op, hashOf(req), JSON.stringify(answer), logId]);
            return { ...answer, dup: false };
        });
    }

    /** GET /admin/spaces/{space}/log (§5.4): newest first, 50 a page; for that space's admins only. */
    async function getLog(user, space, { before, limit } = {}) {
        await adminOf(user, space);
        const lim = Math.max(1, Math.min(ADMIN.LOG_PAGE, Number(limit) || ADMIN.LOG_PAGE));
        const cur = before !== undefined && /^\d{1,18}$/.test(String(before)) ? Number(before) : null;
        return inTx(pool, async (c) => {
            const sid = await sidOf(c, space);
            const { rows } = await c.query(
                `SELECT l.id, l.at, l.role, l.action, l.target_wid, l.amount, l.count, l.before, l.after, a.user_id AS by, r.text AS reason, p.user_id AS target
                 FROM play_admin_log l JOIN play_admin_actors a ON a.aid = l.aid LEFT JOIN play_admin_reasons r ON r.log_id = l.id
                 LEFT JOIN play_people p ON p.wid = l.target_wid
                 WHERE l.sid = $1 AND ($2::bigint IS NULL OR l.id < $2) ORDER BY l.id DESC LIMIT $3`, [sid, cur, lim]);
            return { v: 1, space, entries: rows.map((r) => ({
                id: Number(r.id), at: new Date(r.at).getTime(), by: r.by, by_role: r.role, action: r.action,
                who: r.action === "economy" ? "economy" : r.target_wid ? (r.target || "someone") : "everyone",
                amount: r.amount === null ? null : Number(r.amount), before: r.before, after: r.after, reason: r.reason ?? null, count: r.count ?? 0,
            })) };
        });
    }

    /** The admin log's retention (§5.4): rows older than ADMIN_LOG_DAYS go with their reasons, receipts and notices. */
    async function sweep() {
        const cut = new Date(now() - ADMIN.ADMIN_LOG_DAYS * 86400_000);
        const r = await pool.query("DELETE FROM play_admin_log WHERE at < $1 AND at < now() - interval '180 days'", [cut]);
        await pool.query("DELETE FROM play_admin_actors a WHERE NOT EXISTS (SELECT 1 FROM play_admin_log l WHERE l.aid = a.aid) AND NOT EXISTS (SELECT 1 FROM play_admin_ops o WHERE o.aid = a.aid)");
        return { log: r.rowCount };
    }

    return { adminOf, getSpace, changeWallets, changeEconomy, getLog, sweep };
}

/** /me's notices (§5.5): the oldest NOTICES_PAGE unseen admin changes to this wallet in this space, plus how many more. */
export async function noticesOf(c, wid) {
    const { rows } = await c.query(
        `SELECT n.id, l.at, l.action, l.amount, r.text AS reason FROM play_notices n JOIN play_admin_log l ON l.id = n.log_id
         LEFT JOIN play_admin_reasons r ON r.log_id = l.id WHERE n.wid = $1 AND NOT n.seen ORDER BY n.id LIMIT $2`, [wid, ADMIN.NOTICES_PAGE + 1]);
    const { rows: cnt } = await c.query("SELECT count(*)::int AS n FROM play_notices WHERE wid = $1 AND NOT seen", [wid]);
    const items = rows.slice(0, ADMIN.NOTICES_PAGE).map((r) => ({ id: Number(r.id), at: new Date(r.at).getTime(), action: r.action, amount: r.amount === null ? null : Number(r.amount), reason: r.reason ?? null }));
    return { items, more: Math.max(0, cnt[0].n - items.length) };
}
