// The chip ledger (GAMES-V1-SPEC §2, rev 2: per (space, person)). Every function takes a pg client already inside a
// transaction (db.mjs inTx) and does its whole job there: the money, the wallet row and the idempotency key commit
// together or not at all. Wallet rows are locked FOR UPDATE in sorted wid order (no deadlocks); every money change
// is a journal transaction with an idempotency key (a repeat returns the first result and changes nothing).
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import * as rules from "./rules.mjs";

export const TOMBSTONE_DAYS = 30;
export const acct = {
    w: (wid) => `w:${wid}`,
    seat: (table, wid) => `seat:${table}:${wid}`,
    pot: (table, hand, wid) => `pot:${table}:${hand}:${wid}`,
    esc: (table, round, kind, wid) => `esc:${table}:${round}:${kind}:${wid}`,
    mint: (what, sid) => `mint:${what}:${sid}`, // start | earn | topup
    burn: (sid) => `burn:prestige:${sid}`,
    bank: (sid) => `bank:rig:${sid}`,
};
const kindOf = (id) => id.slice(0, id.indexOf(":"));
const widOf = (id) => (["mint", "burn", "bank"].includes(kindOf(id)) ? null : id.slice(id.lastIndexOf(":") + 1));

// the lock helper lives on an object so the race test's negative control can swap it out (and must then fail)
export const _impl = {
    async lockWallets(c, wids) {
        const sorted = [...new Set(wids)].sort();
        if (!sorted.length) return [];
        const { rows } = await c.query("SELECT * FROM play_wallets WHERE wid = ANY($1) ORDER BY wid FOR UPDATE", [sorted]);
        return rows;
    },
};
const newWid = () => "w" + randomBytes(12).toString("base64url");

export async function ensureSpace(c, spaceId, owner) {
    const { rows } = await c.query(
        "INSERT INTO play_spaces (space_id, owner) VALUES ($1, $2) ON CONFLICT (space_id) DO UPDATE SET space_id = EXCLUDED.space_id RETURNING sid, owner",
        [spaceId, owner]);
    return Number(rows[0].sid);
}
export async function sidOf(c, spaceId) {
    const { rows } = await c.query("SELECT sid FROM play_spaces WHERE space_id = $1", [spaceId]);
    return rows.length ? Number(rows[0].sid) : null;
}
export async function widOfUser(c, sid, user) {
    const { rows } = await c.query("SELECT wid FROM play_people WHERE sid = $1 AND user_id = $2", [sid, user]);
    return rows.length ? rows[0].wid : null;
}
/** The spaces (space ids) where this person has a wallet on this server. */
export async function walletSpaces(c, user) {
    const { rows } = await c.query("SELECT s.space_id FROM play_people p JOIN play_spaces s ON s.sid = p.sid WHERE p.user_id = $1 ORDER BY s.space_id", [user]);
    return rows.map((r) => r.space_id);
}

async function ensureAccount(c, id, sid) {
    await c.query("INSERT INTO play_accounts (id, sid, kind, wid) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING", [id, sid, kindOf(id), widOf(id)]);
}

/**
 * One journal transaction: entries [[account, delta], …] (zero deltas dropped; the database checks Σ = 0, one space,
 * no negative account). A repeated idem key changes nothing and answers {dup: true, tx}.
 */
export async function post(c, { sid, kind, idem, ref = null, day, at = new Date(), entries }) {
    const tx = randomUUID();
    const ins = await c.query("INSERT INTO play_tx (tx, sid, at, day, kind, idem_key, ref) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idem_key) DO NOTHING RETURNING tx",
        [tx, sid, at, day, kind, idem, ref]);
    if (!ins.rows.length) {
        const { rows } = await c.query("SELECT tx FROM play_tx WHERE idem_key = $1", [idem]);
        return { dup: true, tx: rows[0].tx };
    }
    for (const [account, delta] of entries) {
        if (!Number.isSafeInteger(delta)) throw new Error(`play: bad delta ${delta}`);
        if (delta === 0) continue;
        await ensureAccount(c, account, sid);
        await c.query("INSERT INTO play_entries (tx, account, delta) VALUES ($1, $2, $3)", [tx, account, delta]);
    }
    return { dup: false, tx };
}

export async function balance(c, id) {
    const { rows } = await c.query("SELECT balance FROM play_accounts WHERE id = $1", [id]);
    return rows.length ? Number(rows[0].balance) : 0;
}
/** holdings (§2.1) = wallet + seat + own pot chips + escrows (+ provisional Rig results, passed by the caller). */
export async function holdingsOf(c, wid, provisional = 0) {
    const { rows } = await c.query("SELECT kind, COALESCE(SUM(balance), 0) AS b FROM play_accounts WHERE wid = $1 GROUP BY kind", [wid]);
    const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.b)]));
    const total = (by.w || 0) + (by.seat || 0) + (by.pot || 0) + (by.esc || 0) + provisional;
    return { holdings: total, wallet: by.w || 0, atTable: (by.seat || 0) + (by.pot || 0) + (by.esc || 0), open: (by.pot || 0) + (by.esc || 0) };
}

const uhash = (salt, user) => createHmac("sha256", salt).update(user).digest("base64url");

/**
 * Opt in (§2.2, §6.1): creates the wallet with the configured start (start:<wid>), or, within 30 days of a
 * deletion in this space, at 0 with the old day counters (no second top-up or fresh day max by deleting).
 */
/** v1.1 (addendum §5.2): the economy that applies in this space (its own values over the server's). Cached on the
 *  returned object for the same space, so passing it on costs nothing. */
export async function spaceCfg(c, sid, cfg) {
    if (cfg && cfg.__sid === sid) return cfg;
    const { rows } = await c.query("SELECT settings FROM play_space_economy WHERE sid = $1", [sid]);
    return { ...rules.economyFor(cfg, rows.length ? rows[0].settings || {} : {}), __sid: sid };
}

export async function createWallet(c, { sid, user, cfg, now = Date.now(), salt }) {
    cfg = await spaceCfg(c, sid, cfg);
    const have = await widOfUser(c, sid, user);
    if (have) return { wid: have, created: false };
    const wid = newWid();
    const h = uhash(salt, user);
    const { rows: tomb } = await c.query("SELECT * FROM play_tombstones WHERE sid = $1 AND uhash = $2 AND deleted_on > $3::timestamptz - interval '30 days'",
        [sid, h, new Date(now)]);
    const back = tomb[0];
    await c.query("INSERT INTO play_people (sid, user_id, wid) VALUES ($1, $2, $3)", [sid, user, wid]);
    const day = rules.dayOf(now, cfg.tz);
    await c.query("INSERT INTO play_wallets (wid, sid, day, earned_today, topup_day, side_day, side_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [wid, sid, back ? back.day : day, back ? back.earned_today || 0 : 0, back ? back.topup_day : null, back ? back.side_day ?? null : null, back ? back.side_earned || 0 : 0]);
    await ensureAccount(c, acct.w(wid), sid);
    if (back) await c.query("DELETE FROM play_tombstones WHERE sid = $1 AND uhash = $2", [sid, h]);
    const start = back ? 0 : cfg.start;
    await post(c, { sid, kind: "start", idem: `start:${wid}`, day, at: new Date(now), entries: [[acct.mint("start", sid), -start], [acct.w(wid), start]] });
    return { wid, created: true, start, returning: !!back };
}

/** "Delete my chips in <space>" (§2.2): refused while anything of theirs is at a table. */
export async function deleteWallet(c, { sid, user, now = Date.now(), salt }) {
    const wid = await widOfUser(c, sid, user);
    if (!wid) return { ok: false, code: "no-wallet" };
    const [w] = await _impl.lockWallets(c, [wid]);
    const h = await holdingsOf(c, wid);
    const { rows: seated } = await c.query("SELECT 1 FROM play_seats WHERE wid = $1 AND active", [wid]);
    if (h.open > 0) return { ok: false, code: "open-money" };
    if (seated.length || h.atTable > 0) return { ok: false, code: "seated" };
    // v1.1 F9: the side counters ride along, so deleting and rejoining can't refill the day (§6.2)
    await c.query("INSERT INTO play_tombstones (sid, uhash, deleted_on, day, earned_today, topup_day, side_day, side_earned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (sid, uhash) DO UPDATE SET deleted_on = EXCLUDED.deleted_on, day = EXCLUDED.day, earned_today = EXCLUDED.earned_today, topup_day = EXCLUDED.topup_day, side_day = EXCLUDED.side_day, side_earned = EXCLUDED.side_earned",
        [sid, uhash(salt, user), new Date(now), w.day, w.earned_today, w.topup_day, w.side_day ?? null, w.side_earned ?? 0]);
    await c.query("DELETE FROM play_people WHERE sid = $1 AND user_id = $2", [sid, user]);
    await c.query("DELETE FROM play_wallets WHERE wid = $1", [wid]);
    // v1.1 F8 (§5.4): their notices, and the why-texts of admin log rows about this wallet (the rows stay: "someone")
    await c.query("DELETE FROM play_notices WHERE wid = $1", [wid]);
    await c.query("DELETE FROM play_admin_reasons WHERE log_id IN (SELECT id FROM play_admin_log WHERE target_wid = $1)", [wid]);
    // the admin op receipts naming them (their Matrix id + balances in the stored answer) are scrubbed; the op + its
    // request hash stay, so a resend still can't run it again (astra r1 #1)
    // (a valid answer stays: the same log id, nothing about anyone; astra r2 N1)
    await c.query("UPDATE play_admin_ops SET answer = jsonb_build_object('done', '[]'::jsonb, 'skipped', '[]'::jsonb, 'log', answer->'log') WHERE sid = $1 AND jsonb_path_exists(answer, '$.** ? (@ == $u)', jsonb_build_object('u', $2::text))", [sid, user]);
    return { ok: true, wid };
}

/** The top-up check at any touch (§2.4). */
export async function topupIfDue(c, { sid, wid, cfg, now = Date.now() }) {
    cfg = await spaceCfg(c, sid, cfg);
    const [w] = await _impl.lockWallets(c, [wid]);
    if (!w) return { chips: 0, why: "no-wallet" };
    const h = await holdingsOf(c, wid);
    const r = rules.topup({ holdings: h.holdings, topup_day: w.topup_day }, now, cfg, h.open > 0);
    if (!r.chips) return { chips: 0, why: r.why };
    const day = r.w.topup_day;
    const p = await post(c, { sid, kind: "topup", idem: `topup:${wid}:${day}`, day, at: new Date(now), entries: [[acct.mint("topup", sid), -r.chips], [acct.w(wid), r.chips]] });
    if (p.dup) return { chips: 0, why: "already-today" };
    await c.query("UPDATE play_wallets SET topup_day = $2, version = version + 1 WHERE wid = $1", [wid, day]);
    return { chips: r.chips, why: "" };
}

/**
 * One sampler sample for one wallet (§2.3). seen = the credited_through the sampler READ for this wallet (the
 * compare-and-set: if another run moved it on since, this sample is dropped, so no second is ever paid twice).
 * eligible = the anti-AFK rule's answer for this sample.
 */
export async function sample(c, { sid, wid, cfg, now, seen, eligible, provisional = 0 }) {
    cfg = await spaceCfg(c, sid, cfg);
    const [w] = await _impl.lockWallets(c, [wid]);
    if (!w) return { chips: 0, why: "no-wallet" };
    const ct = w.credited_through ? new Date(w.credited_through).getTime() : null;
    if (seen !== undefined && (ct ?? null) !== (seen ?? null)) return { chips: 0, why: "raced" };
    const gap = ct === null ? 0 : Math.max(0, Math.floor((now - ct) / 1000));
    // the running Rig result is read AFTER the wallet lock (a settlement holding it has then finished); null = a table is
    // committing right now: skip this sample, the next one counts the time
    const prov = typeof provisional === "function" ? provisional() : provisional;
    if (prov === null) return { chips: 0, why: "raced" };
    const h = await holdingsOf(c, wid, prov);
    const r = rules.tick({ holdings: h.holdings, rank: w.rank, accrual_s: w.accrual_s, day: w.day, earned_today: w.earned_today }, { at: now, gap_s: gap, eligible }, cfg);
    for (let i = 0; i < r.chips; i++) {
        const n = r.w.earned_today - r.chips + i + 1;
        // stamped with the server DAY only (§2.3: never the minute someone was in a call)
        await post(c, { sid, kind: "earn", idem: `earn:${wid}:${r.w.day}:${n}`, day: r.w.day, at: new Date(`${r.w.day}T00:00:00Z`), entries: [[acct.mint("earn", sid), -1], [acct.w(wid), 1]] });
    }
    await c.query("UPDATE play_wallets SET accrual_s = $2, day = $3, earned_today = $4, credited_through = $5, version = version + 1 WHERE wid = $1",
        [wid, r.w.accrual_s, r.w.day, r.w.earned_today, new Date(now)]);
    return { chips: r.chips, why: r.why };
}

/** Move chips between two of one space's accounts (sit, cash-out, bets, escrows, settlements). */
export async function move(c, { sid, kind, idem, ref, cfg, now = Date.now(), from, to, amount }) {
    return post(c, { sid, kind, idem, ref, day: rules.dayOf(now, cfg.tz), at: new Date(now), entries: [[from, -amount], [to, amount]] });
}

/** The prestige check at a leave (§2.4): the caller has already cashed the seat out and the person has no open money. */
export async function prestigeCheck(c, { sid, wid, cfg, now = Date.now() }) {
    cfg = await spaceCfg(c, sid, cfg);
    const [w] = await _impl.lockWallets(c, [wid]);
    if (!w) return { burned: 0, why: "no-wallet" };
    const h = await holdingsOf(c, wid);
    if (h.atTable > 0) return { burned: 0, why: "open-money" };
    const r = rules.leave({ holdings: h.holdings, rank: w.rank }, cfg);
    if (!r.burned && r.why !== "prestige") return { burned: 0, why: "" };
    const p = await post(c, { sid, kind: "prestige", idem: `prestige:${wid}:${w.rank}`, day: rules.dayOf(now, cfg.tz), at: new Date(now), entries: [[acct.w(wid), -r.burned], [acct.burn(sid), r.burned]] });
    if (p.dup) return { burned: 0, why: "dup" };
    await c.query("UPDATE play_wallets SET rank = rank + 1, version = version + 1 WHERE wid = $1", [wid]);
    return { burned: r.burned, why: "prestige", rank: w.rank + 1 };
}

/** GET /me (§6.2): runs the top-up check first. */
export async function me(c, { sid, spaceId, user, cfg, now = Date.now(), atTable = null, provisional = 0 }) {
    cfg = await spaceCfg(c, sid, cfg);
    const wid = await widOfUser(c, sid, user);
    if (!wid) return null;
    await topupIfDue(c, { sid, wid, cfg, now });
    const { rows } = await c.query("SELECT * FROM play_wallets WHERE wid = $1", [wid]);
    const w = rows[0];
    const h = await holdingsOf(c, wid, (typeof provisional === "function" ? provisional() : provisional) ?? 0);
    const today = rules.dayOf(now, cfg.tz);
    const earned = w.day === today ? w.earned_today : 0;
    return {
        v: 1, space: spaceId, user, balance: h.wallet, holdings: h.holdings, rank: w.rank, cap: rules.capOf(w.rank, cfg), at_table: atTable,
        earned_today: earned, day_max: cfg.day_max, accrual_s: w.accrual_s % cfg.chip_s, chip_s: cfg.chip_s, chip_minutes: cfg.chip_minutes, day: today,
        topup: { available: h.holdings === 0 && h.open === 0 && w.topup_day !== today, next_day: w.topup_day === today ? rules.nextDay(today) : today },
    };
}

const REASON = { start: "start", earn: "earn", topup: "topup", prestige: "prestige", sit: "sit", cashout: "cashout", "rig-escrow": "rig-escrow", "rig-settle": "rig-settle", void: "void", "lab-grant": "lab-grant", admin: "admin", side: "side", "admin-topup": "oneoff" }; // v1.1 (design2 16:39): + admin, side, oneoff; unknown → other

/**
 * LAB ONLY: mint chips into a wallet for a test (e.g. to reach the cap and prestige). Refused unless env.TINHAT_LAB is
 * exactly "1" (the manager never writes it; no image sets it). Journalled as its own `lab-grant` transaction from
 * `mint:lab:<sid>`, so the audit and the journal show it. n: 1-1000.
 */
export async function labGrant(c, { env = process.env, sid, wid, n, now = Date.now(), cfg }) {
    if (env.TINHAT_LAB !== "1") return { ok: false, code: "refused", why: "lab grants need TINHAT_LAB=1 (a lab box only)" };
    if (!Number.isInteger(n) || n < 1 || n > 1000) return { ok: false, code: "bad", why: "n is 1-1000" };
    const [w] = await _impl.lockWallets(c, [wid]);
    if (!w) return { ok: false, code: "no-wallet" };
    const p = await post(c, { sid, kind: "lab-grant", idem: `lab-grant:${wid}:${randomUUID()}`, day: rules.dayOf(now, cfg.tz), at: new Date(now), entries: [[acct.mint("lab", sid), -n], [acct.w(wid), n]] });
    return { ok: true, tx: p.tx };
}
/** GET /me/journal: your own wallet's entries, newest first. */
export async function journal(c, { wid, before = null, limit = 50 }) {
    const lim = Math.max(1, Math.min(50, Number(limit) || 50));
    // the cursor is "<ms>.<tx>" (opaque to the apps): earnings share their day's midnight, so time alone can't page
    const m = typeof before === "string" ? /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(before) : null;
    const cur = m ? { at: Number(m[1]), tx: m[2] } : null;
    const { rows } = await c.query(
        `SELECT t.tx, t.at, t.day, t.kind, t.ref, e.delta FROM play_entries e JOIN play_tx t ON t.tx = e.tx
         WHERE e.account = $1 AND ($2::timestamptz IS NULL OR (t.at, t.tx) < ($2::timestamptz, $3::uuid)) ORDER BY t.at DESC, t.tx DESC LIMIT $4`,
        [acct.w(wid), cur ? new Date(cur.at) : null, cur ? cur.tx : "00000000-0000-0000-0000-000000000000", lim + 1]);
    const page = rows.slice(0, lim);
    return {
        entries: page.map((r) => ({ tx: r.tx, at: r.kind === "earn" ? null : new Date(r.at).getTime(), day: r.day, delta: Number(r.delta), reason: REASON[r.kind] || "other", ref: r.ref })), // never a borrowed reason (design2 16:39)
        next: rows.length > lim ? `${new Date(page[page.length - 1].at).getTime()}.${page[page.length - 1].tx}` : null,
    };
}

/** Ranks above 0 of these people in this space (the caller filters to current space members). */
export async function ranks(c, { sid, users }) {
    if (!users.length) return {};
    const { rows } = await c.query("SELECT p.user_id, w.rank FROM play_people p JOIN play_wallets w ON w.wid = p.wid WHERE p.sid = $1 AND p.user_id = ANY($2) AND w.rank > 0", [sid, users]);
    return Object.fromEntries(rows.map((r) => [r.user_id, r.rank]));
}

/**
 * The invariants (§2.5), as `tinhat play audit` runs them: each balance = the sum of its entries; every space sums
 * to 0; no negative account but mint/burn/bank; every transaction sums to 0 and stays in one space; mint only
 * negative, burn only positive; every finished game settled XOR voided; an open game has no settlement.
 */
export async function audit(c) {
    const bad = [];
    const q = async (sql, why) => { const { rows } = await c.query(sql); for (const r of rows) bad.push(`${why}: ${JSON.stringify(r)}`); };
    await q(`SELECT a.id, a.balance, COALESCE(SUM(e.delta),0) AS sum FROM play_accounts a LEFT JOIN play_entries e ON e.account = a.id GROUP BY a.id, a.balance HAVING a.balance <> COALESCE(SUM(e.delta),0)`, "balance != entries");
    await q(`SELECT sid, SUM(balance) AS sum FROM play_accounts GROUP BY sid HAVING SUM(balance) <> 0`, "space does not sum to 0");
    await q(`SELECT id, balance FROM play_accounts WHERE kind NOT IN ('mint','burn','bank') AND balance < 0`, "negative account");
    await q(`SELECT tx, SUM(delta) AS sum FROM play_entries GROUP BY tx HAVING SUM(delta) <> 0`, "transaction does not sum to 0");
    await q(`SELECT e.tx FROM play_entries e JOIN play_tx t ON t.tx = e.tx JOIN play_accounts a ON a.id = e.account WHERE a.sid <> t.sid`, "transaction mixes spaces");
    await q(`SELECT id, balance FROM play_accounts WHERE (kind = 'mint' AND balance > 0) OR (kind = 'burn' AND balance < 0)`, "mint/burn sign");
    await q(`SELECT g.id FROM play_games g JOIN play_tx t ON t.idem_key IN ('hand:' || g.table_id || ':' || g.n, 'rig:' || g.table_id || ':' || g.n || ':settle', 'void:' || g.table_id || ':' || g.n, 'rig:' || g.table_id || ':' || g.n || ':void') WHERE g.disposition = 'open'`, "open game with a settlement");
    await q(`SELECT g.id FROM play_games g WHERE g.disposition = 'settled' AND EXISTS (SELECT 1 FROM play_tx t WHERE t.idem_key IN ('void:' || g.table_id || ':' || g.n, 'rig:' || g.table_id || ':' || g.n || ':void'))`, "settled and voided");
    // v1.1 F8 (§5.4, design2 16:51): admin changes agree with the admin log. Only kind `admin` and mint:admin / burn:admin
    // (a one-off `admin-topup` / mint:oneoff:* stays in the plain supply checks above).
    const { rows: [v3] } = await c.query("SELECT to_regclass('play_admin_log') IS NOT NULL AS ok");
    if (v3.ok) {
        await q(`SELECT t.tx, t.ref FROM play_tx t WHERE t.kind = 'admin' AND (t.ref IS NULL OR t.ref NOT LIKE 'alog:%' OR (t.at > now() - interval '180 days' AND NOT EXISTS (SELECT 1 FROM play_admin_log l WHERE 'alog:' || l.id = t.ref AND l.sid = t.sid)))`, "admin transaction without its log row");
        await q(`SELECT e.tx, e.account FROM play_entries e JOIN play_tx t ON t.tx = e.tx WHERE (e.account LIKE 'mint:admin:%' OR e.account LIKE 'burn:admin:%') AND t.kind <> 'admin'`, "admin mint/burn outside an admin transaction");
        await q(`SELECT l.id, l.net, COALESCE(SUM(e.delta), 0) AS moved FROM play_admin_log l LEFT JOIN play_tx t ON t.ref = 'alog:' || l.id AND t.kind = 'admin' AND t.sid = l.sid LEFT JOIN play_entries e ON e.tx = t.tx AND e.account LIKE 'w:%' WHERE l.action <> 'economy' GROUP BY l.id, l.net HAVING l.net <> COALESCE(SUM(e.delta), 0)`, "admin log row's net != its journal");
    }
    return bad;
}
