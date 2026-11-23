// F9, the side game "Tune In" (GAMES-V1.1-ADDENDUM §6): a broke, opted-in player tunes a tin hat's antenna to a hidden
// signal 1–100 in up to 7 tries (higher / lower after each). The SERVER holds the secret and judges every try; a find
// pays a few chips, capped per server day and never above the broke line + 3. Runs live in memory only (a restart drops
// them; nothing was paid). The payout is ONE journal transaction (mint:side:<sid> → the wallet) with the idempotency key
// side:<wid>:<run>, so two racing finds can't pay twice. Tries are never activity (no idle farming, launch-gate 6).
import { randomBytes, randomInt } from "node:crypto";
import * as rules from "./rules.mjs";
import * as L from "./ledger.mjs";
import { inTx } from "./db.mjs";

export const SIDE = Object.freeze({
    SIDE_BROKE_MAX: 4, SIDE_TRIES: 7, SIDE_PAY: Object.freeze([3, 3, 3, 3, 2, 2, 1]), SIDE_RUN_MS: 90_000,
    TRY_MIN_MS: 300, RUNS_PER_HOUR: 20, LO: 1, HI: 100,
});
const OP_RE = /^[A-Za-z0-9_-]{16,32}$/;
const mintSide = (sid) => `mint:side:${sid}`;
const runId = () => "sR" + randomBytes(12).toString("base64url").replace(/[^A-Za-z0-9]/g, "x").slice(0, 16);

/** The pay of a find on try `tries` (1-based), pure (vectors/ledger-v1.1.json `side_pay`): SIDE_PAY[try], clipped by
 *  what's left of the day max and by the broke line + 3, never below 0. */
export function sidePay({ tries, earned_today, side_day_max, holdings }) {
    return Math.max(0, Math.min(SIDE.SIDE_PAY[tries - 1] ?? 0, side_day_max - earned_today, SIDE.SIDE_BROKE_MAX + 3 - holdings));
}

/** The side counters of a wallet row for `today` (a new server day starts at 0). */
export const sideEarned = (w, today) => (w && w.side_day === today ? Number(w.side_earned || 0) : 0);

/** /me.side (§6.4): the apps show exactly this. */
export async function sideOf(c, { sid, wid, cfg, now, openMoney }) {
    const e = await L.spaceCfg(c, sid, cfg);
    const { rows } = await c.query("SELECT side_day, side_earned FROM play_wallets WHERE wid = $1", [wid]);
    const today = rules.dayOf(now, e.tz);
    const earned = sideEarned(rows[0], today);
    const h = await L.holdingsOf(c, wid);
    // Tune In's own rule (§6.2): money in play (seat / pot / escrow), so a busted seat (state out, 0 at the table) may
    // play; the admin screen keeps the stricter "seated at all" (astra r1 #6)
    const open = h.atTable > 0 || (openMoney.side ? await openMoney.side(c, wid) : false);
    const left = Math.max(0, e.side_day_max - earned);
    const reason = !e.side_on ? "off" : open ? "open-money" : h.holdings > SIDE.SIDE_BROKE_MAX ? "not-broke" : left <= 0 ? "day-max" : null;
    return { on: !!e.side_on, eligible: reason === null, reason, left_today: left, day_max: e.side_day_max, broke_max: SIDE.SIDE_BROKE_MAX };
}

/**
 * createSide({ pool, cfg, serverName, spaceInfo, now, mono, Refusal, openMoney, onWalletChanged, rng? })
 */
export function createSide(d) {
    const { pool, cfg, serverName, Refusal } = d;
    const now = d.now || Date.now;
    const mono = d.mono || (() => performance.now());
    const secretOf = d.rng || (() => randomInt(SIDE.LO, SIDE.HI + 1)); // the CSPRNG, uniform 1..100
    const runs = new Map(); // id → run
    const current = new Map(); // `${user}|${space}` → run id (one run at a time per person per space)
    const starts = new Map(); // user → [{t}] reservations (20 an hour); one shared array per user, edited in place
    const chains = new Map(); // `${user}|${space}` → the tail of that person's start/payout queue (astra r2 #8)
    const serial = (key, fn) => { const prev = chains.get(key) || Promise.resolve(); const p = prev.then(fn, fn); chains.set(key, p.catch(() => {})); return p; };

    function prune() { const t = mono(); for (const [id, r] of runs) if (t > r.expiresMono + 60_000) { runs.delete(id); if (current.get(r.key) === id) current.delete(r.key); } }

    async function qualify(c, { user, space, wid, sid, info }) {
        const e = await L.spaceCfg(c, sid, cfg);
        if (!info || !info.joined.has(user)) return "not-member";
        if (!e.side_on) return "side-off";
        const s = await sideOf(c, { sid, wid, cfg: e, now: now(), openMoney: d.openMoney });
        if (s.reason === "open-money") return "open-money";
        if (s.reason === "not-broke") return "not-broke";
        if (s.reason === "day-max") return "day-max";
        return null;
    }

    async function start(user, b) {
        if (!b || typeof b.space !== "string" || !/^![^:\s]+:\S+$/.test(b.space)) throw new Refusal("bad");
        const space = b.space;
        const info = await d.spaceInfo(space);
        if (!info) throw new Refusal("unavailable");
        if (!info.joined.has(user)) throw new Refusal("not-member");
        if (info.owner !== serverName) throw new Refusal("wrong-server", { space, server: info.owner });
        prune();
        const t = mono();
        const mine = starts.get(user) || [];
        starts.set(user, mine);
        for (let i = mine.length - 1; i >= 0; i--) if (t - mine[i].t >= 3600_000) mine.splice(i, 1);
        if (mine.length >= SIDE.RUNS_PER_HOUR) throw new Refusal("rate");
        const slot = { t }; mine.push(slot); // reserved before any await (astra r1 #7); this slot is given back on failure
        return serial(`${user}|${space}`, () => startLocked(user, space, info, t, mine, slot));
    }
    async function startLocked(user, space, info, t, mine, slot) {
        let r;
        try { r = await inTx(pool, async (c) => {
            const sid = await L.sidOf(c, space);
            const wid = sid && await L.widOfUser(c, sid, user);
            if (!wid) throw new Refusal("no-wallet");
            const [w] = await L._impl.lockWallets(c, [wid]);
            if (!w) throw new Refusal("no-wallet");
            const why = await qualify(c, { user, space, wid, sid, info });
            if (why) throw new Refusal(why);
            const s = await sideOf(c, { sid, wid, cfg, now: now(), openMoney: d.openMoney });
            return { sid, wid, left: s.left_today };
        }); } catch (e) { const i = mine.indexOf(slot); if (i >= 0) mine.splice(i, 1); throw e; }
        const key = `${user}|${space}`;
        const old = current.get(key); if (old) runs.delete(old); // a new run cancels the old one
        const id = runId();
        const run = { id, key, user, space, sid: r.sid, wid: r.wid, secret: secretOf(), lo: SIDE.LO, hi: SIDE.HI, tries: 0, ver: 0, busy: false, lastTry: -Infinity,
            expires: now() + SIDE.SIDE_RUN_MS, expiresMono: t + SIDE.SIDE_RUN_MS, answers: new Map(), done: null };
        runs.set(id, run); current.set(key, id);
        return { run: id, lo: run.lo, hi: run.hi, tries_left: SIDE.SIDE_TRIES, expires: run.expires, pay: [...SIDE.SIDE_PAY], left_today: r.left };
    }

    async function tune(user, id, b) {
        prune();
        const run = runs.get(id);
        if (!run || run.user !== user || current.get(run.key) !== id) throw new Refusal("no-run"); // someone else's run: the same answer
        if (!b || !OP_RE.test(b.op || "")) throw new Refusal("bad");
        const seen = run.answers.get(b.op);
        if (seen) return { ...seen, dup: true };
        if (run.done) throw new Refusal("no-run");
        if (mono() > run.expiresMono) { runs.delete(id); current.delete(run.key); throw new Refusal("no-run"); }
        const g = b.guess;
        if (!Number.isInteger(g) || g < run.lo || g > run.hi) throw new Refusal("bad"); // costs nothing
        if (run.busy) throw new Refusal("stale"); // guesses on one run are serialised
        if (mono() - run.lastTry < SIDE.TRY_MIN_MS) throw new Refusal("rate");
        run.busy = true;
        try {
            run.lastTry = mono();
            run.tries += 1; run.ver += 1;
            let ans;
            if (g === run.secret) {
                try { ans = await serial(run.key, () => payout(run)); } // serialised with a replacing start (astra r2 #8)
                catch (e) { run.tries -= 1; run.ver -= 1; run.lastTry = -Infinity; throw e; } // nothing committed: the try isn't spent (astra r1 #10)
            } else {
                if (g < run.secret) run.lo = g + 1; else run.hi = g - 1;
                const left = SIDE.SIDE_TRIES - run.tries;
                if (left <= 0) { run.done = "lost"; ans = { result: "lost", lo: run.lo, hi: run.hi, tries_left: 0, paid: 0, secret: run.secret }; }
                else ans = { result: g < run.secret ? "higher" : "lower", lo: run.lo, hi: run.hi, tries_left: left, paid: 0 };
            }
            run.answers.set(b.op, ans);
            return { ...ans, dup: false };
        } finally { run.busy = false; }
    }

    async function payout(run) {
        const info = await d.spaceInfo(run.space).catch(() => null);
        const out = await inTx(pool, async (c) => {
            const [w] = await L._impl.lockWallets(c, [run.wid]);
            if (!w) return { result: "cancelled", paid: 0, wallet: null };
            const e = await L.spaceCfg(c, run.sid, cfg);
            const why = await qualify(c, { user: run.user, space: run.space, wid: run.wid, sid: run.sid, info });
            // every admission rule again at the payout (§6.2), and the run must still be this person's current one: a run
            // replaced by a newer start before this commits is cancelled (astra r1 #8, #9)
            // holdings above the broke line at the payout only CLIP the pay (design2 16:29: a call-time chip landing mid-run
            // must not void a find); every other rule cancels
            if ((why && why !== "not-broke") || current.get(run.key) !== run.id) return { result: "cancelled", paid: 0, wallet: await walletOf(c, run.wid) };
            const today = rules.dayOf(now(), e.tz);
            const earned = sideEarned(w, today);
            const h = await L.holdingsOf(c, run.wid);
            const pay = sidePay({ tries: run.tries, earned_today: earned, side_day_max: e.side_day_max, holdings: h.holdings });
            if (pay > 0) {
                const p = await L.post(c, { sid: run.sid, kind: "side", idem: `side:${run.wid}:${run.id}`, ref: null, day: today, at: new Date(now()), entries: [[mintSide(run.sid), -pay], [L.acct.w(run.wid), pay]] });
                if (!p.dup) await c.query("UPDATE play_wallets SET side_day = $2, side_earned = $3, version = version + 1 WHERE wid = $1", [run.wid, today, earned + pay]);
                else return { result: "found", paid: 0, wallet: await walletOf(c, run.wid) };
            }
            return { result: "found", paid: pay, wallet: await walletOf(c, run.wid) };
        });
        run.done = out.result;
        if (out.paid > 0) d.onWalletChanged?.(run.wid, run.sid);
        return { result: out.result, lo: run.lo, hi: run.hi, tries_left: SIDE.SIDE_TRIES - run.tries, paid: out.paid, secret: run.secret, ...(out.wallet ? { wallet: out.wallet } : {}) };
    }
    async function walletOf(c, wid) { const h = await L.holdingsOf(c, wid); return { balance: h.wallet, holdings: h.holdings }; }

    return { start, tune, _runs: runs };
}
