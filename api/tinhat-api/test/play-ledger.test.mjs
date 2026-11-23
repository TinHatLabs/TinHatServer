// The ledger on a real Postgres (PLAY_TEST_DB_URL = an admin connection to a throwaway server; each run makes its own
// database and drops it). Skipped without it. ledger.json through the database, the journal's triggers, idempotency,
// the deletion guarantee, the 30-day return, a race with a negative control, and random sequences under the audit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, inTx, SCHEMA_VERSION } from "../play/db.mjs";
import * as L from "../play/ledger.mjs";
import * as rules from "../play/rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL to run the database tests";
const DBNAME = `games_s1_t${process.pid}`;
let pool;
const SALT = "test-salt-not-a-secret";

before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 10 });
    await migrate(pool);
});
after(async () => {
    if (skip) return;
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});

let spaceN = 0;
const newSpace = () => inTx(pool, (c) => L.ensureSpace(c, `!sp${++spaceN}x${process.pid}:play.test`, "play.test"));
// vectors/ledger.json runs with the v1 defaults under each case (addendum §6.3: the test names that object)
const cfgOf = (params) => ({ ...rules.configFromEnv({}), ...rules.V1_DEFAULTS, ...params });

test("migrations: version recorded, running again changes nothing", { skip }, async () => {
    assert.equal(await migrate(pool), SCHEMA_VERSION);
    assert.equal(await migrate(pool), SCHEMA_VERSION);
});

test("ledger.json through the database: every case, every step", { skip }, async () => {
    const V = JSON.parse(readFileSync(join(HERE, "vectors/play/ledger.json"), "utf8"));
    for (const cs of V.cases) {
        const cfg = cfgOf(cs.params);
        const sid = await newSpace();
        const user = `@v-${cs.id}:play.test`;
        let wid = null;
        const t0 = Date.parse("2026-11-19T20:00:00Z");
        const seed = async () => {
            // a wallet holding the case's start state (created at start 0, then the holdings minted in, the counters set)
            wid = (await inTx(pool, (c) => L.createWallet(c, { sid, user, cfg: { ...cfg, start: 0 }, now: t0, salt: SALT }))).wid;
            await inTx(pool, async (c) => {
                if (cs.start.holdings) await L.post(c, { sid, kind: "start", idem: `seed:${wid}`, day: cs.start.day, entries: [[L.acct.mint("start", sid), -cs.start.holdings], [L.acct.w(wid), cs.start.holdings]] });
                await c.query("UPDATE play_wallets SET rank=$2, accrual_s=$3, day=$4, earned_today=$5, topup_day=$6 WHERE wid=$1", [wid, cs.start.rank, cs.start.accrual_s, cs.start.day, cs.start.earned_today, cs.start.topup_day]);
            });
        };
        if (cs.events[0].do !== "create") await seed();
        let n = 0;
        for (const [i, ev] of cs.events.entries()) {
            const want = cs.expect.after_each[i];
            let got = {};
            if (ev.do === "create") {
                const r = await inTx(pool, (c) => L.createWallet(c, { sid, user, cfg, now: t0, salt: SALT }));
                wid = r.wid; got = { chips: r.start };
                await inTx(pool, (c) => c.query("UPDATE play_wallets SET day=$2 WHERE wid=$1", [wid, cs.start.day]));
            } else if (ev.do === "tick") {
                const now = Date.parse(ev.at);
                await inTx(pool, (c) => c.query("UPDATE play_wallets SET credited_through = $2 WHERE wid = $1", [wid, new Date(now - ev.gap_s * 1000)]));
                const seen = now - ev.gap_s * 1000;
                const r = await inTx(pool, (c) => L.sample(c, { sid, wid, cfg, now, seen, eligible: ev.eligible }));
                got = { chips: r.chips, why: r.why };
            } else if (ev.do === "topup") {
                const r = await inTx(pool, (c) => L.topupIfDue(c, { sid, wid, cfg, now: Date.parse(ev.at) }));
                got = { chips: r.chips, why: r.why };
            } else if (ev.do === "settle") {
                const amt = Math.abs(ev.delta);
                await inTx(pool, (c) => L.move(c, { sid, kind: "rig-settle", idem: `settle:${wid}:${++n}`, cfg, now: t0, from: ev.delta > 0 ? L.acct.bank(sid) : L.acct.w(wid), to: ev.delta > 0 ? L.acct.w(wid) : L.acct.bank(sid), amount: amt }));
            } else if (ev.do === "leave") {
                const r = await inTx(pool, (c) => L.prestigeCheck(c, { sid, wid, cfg, now: t0 }));
                got = { burned: r.burned, why: r.why === "prestige" ? "prestige" : "" };
            }
            for (const k of ["chips", "why", "burned"]) if (k in want) assert.deepEqual(got[k], want[k], `${cs.id}[${i}] ${k}`);
            if (want.state) {
                const st = await inTx(pool, async (c) => {
                    const { rows } = await c.query("SELECT * FROM play_wallets WHERE wid = $1", [wid]);
                    const h = await L.holdingsOf(c, wid);
                    return { holdings: h.holdings, rank: rows[0].rank, accrual_s: rows[0].accrual_s, day: rows[0].day, earned_today: rows[0].earned_today, topup_day: rows[0].topup_day };
                });
                const w = want.state;
                assert.deepEqual(st, { holdings: w.holdings, rank: w.rank, accrual_s: w.accrual_s, day: w.day, earned_today: w.earned_today, topup_day: w.topup_day }, `${cs.id}[${i}] state`);
            }
        }
    }
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("the journal refuses: an unbalanced transaction, two spaces in one, a negative wallet, an UPDATE/DELETE", { skip }, async () => {
    const s1 = await newSpace(), s2 = await newSpace();
    const cfg = cfgOf({});
    const a = (await inTx(pool, (c) => L.createWallet(c, { sid: s1, user: "@j1:play.test", cfg, salt: SALT }))).wid;
    const b = (await inTx(pool, (c) => L.createWallet(c, { sid: s2, user: "@j1:play.test", cfg, salt: SALT }))).wid;
    await assert.rejects(inTx(pool, (c) => L.post(c, { sid: s1, kind: "x", idem: "unbalanced:1", day: "2026-11-19", entries: [[L.acct.w(a), 5]] })), /sums to/);
    await assert.rejects(inTx(pool, (c) => L.post(c, { sid: s1, kind: "x", idem: "mix:1", day: "2026-11-19", entries: [[L.acct.w(a), -1], [L.acct.w(b), 1]] })), /mixes spaces/);
    await assert.rejects(inTx(pool, (c) => L.post(c, { sid: s1, kind: "x", idem: "neg:1", day: "2026-11-19", entries: [[L.acct.w(a), -11], [L.acct.bank(s1), 11]] })), /play_accounts_nonneg/);
    await assert.rejects(inTx(pool, (c) => c.query("UPDATE play_tx SET kind = 'y'")), /append-only/);
    await assert.rejects(inTx(pool, (c) => c.query("DELETE FROM play_entries")), /append-only/);
    await assert.rejects(inTx(pool, (c) => c.query("UPDATE play_accounts SET sid = $1 WHERE id = $2", [s2, L.acct.w(a)])), /never change/);
    // nothing of the refused ones stuck
    assert.equal(await inTx(pool, (c) => L.balance(c, L.acct.w(a))), 10);
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("idempotency: a repeated key changes nothing; the top-up can't happen twice in a day even when two race", { skip }, async () => {
    const sid = await newSpace(); const cfg = cfgOf({ start: 0 });
    const wid = (await inTx(pool, (c) => L.createWallet(c, { sid, user: "@i1:play.test", cfg, salt: SALT }))).wid;
    const now = Date.parse("2026-11-19T20:00:00Z");
    const rs = await Promise.all([1, 2, 3, 4].map(() => inTx(pool, (c) => L.topupIfDue(c, { sid, wid, cfg, now }))));
    assert.equal(rs.filter((r) => r.chips === 5).length, 1);
    assert.equal(await inTx(pool, (c) => L.balance(c, L.acct.w(wid))), 5);
    const p1 = await inTx(pool, (c) => L.move(c, { sid, kind: "sit", idem: "sit:tH:1", cfg, now, from: L.acct.w(wid), to: L.acct.seat("tHx", wid), amount: 5 }));
    const p2 = await inTx(pool, (c) => L.move(c, { sid, kind: "sit", idem: "sit:tH:1", cfg, now, from: L.acct.w(wid), to: L.acct.seat("tHx", wid), amount: 5 }));
    assert.equal(p1.dup, false); assert.equal(p2.dup, true); assert.equal(p1.tx, p2.tx);
    assert.equal(await inTx(pool, (c) => L.balance(c, L.acct.seat("tHx", wid))), 5);
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("the sampler race: of two samplers on one interval exactly one credits (negative control: without the row lock both do)", { skip }, async () => {
    const sid = await newSpace(); const cfg = cfgOf({});
    const run = async (label) => {
        const wid = (await inTx(pool, (c) => L.createWallet(c, { sid, user: `@race-${label}:play.test`, cfg, salt: SALT }))).wid;
        let t = Date.parse("2026-11-19T20:00:00Z");
        await inTx(pool, (c) => c.query("UPDATE play_wallets SET credited_through = $2 WHERE wid = $1", [wid, new Date(t)]));
        let credited = 0;
        for (let i = 0; i < 60; i++) {
            const seen = t; t += 60000;
            const rs = await Promise.all([0, 1].map(() => inTx(pool, (c) => L.sample(c, { sid, wid, cfg, now: t, seen, eligible: true }))));
            credited += rs.filter((r) => r.why !== "raced").length;
        }
        const { rows } = await pool.query("SELECT accrual_s, earned_today FROM play_wallets WHERE wid = $1", [wid]);
        return { seconds: rows[0].accrual_s + rows[0].earned_today * 3600, credited };
    };
    // locked: each interval is credited by exactly ONE of the two samplers (the other sees credited_through moved: raced)
    assert.deepEqual(await run("locked"), { seconds: 60 * 60, credited: 60 });
    const real = L._impl.lockWallets;
    L._impl.lockWallets = async (c, wids) => (await c.query("SELECT * FROM play_wallets WHERE wid = ANY($1)", [wids])).rows; // no FOR UPDATE
    try {
        const r = await run("unlocked");
        assert.ok(r.credited > 60, `the negative control must let both samplers credit one interval (credited ${r.credited})`);
    } finally { L._impl.lockWallets = real; }
});

test("Delete my chips: no trace of the Matrix id but the salted hash; back within 30 days = 0 + the day counters; after = fresh", { skip }, async () => {
    const sid = await newSpace(); const cfg = cfgOf({ tz: "America/Los_Angeles" });
    const user = "@deleteme-7f3a:play.test";
    const now = Date.parse("2026-11-19T20:00:00Z");
    const wid = (await inTx(pool, (c) => L.createWallet(c, { sid, user, cfg, now, salt: SALT }))).wid;
    await inTx(pool, (c) => c.query("UPDATE play_wallets SET earned_today = 6, topup_day = '2026-11-19' WHERE wid = $1", [wid]));
    // refused while chips sit at a table
    await inTx(pool, (c) => L.move(c, { sid, kind: "sit", idem: `sit:del:${wid}`, cfg, now, from: L.acct.w(wid), to: L.acct.seat("tHdel", wid), amount: 4 }));
    assert.equal((await inTx(pool, (c) => L.deleteWallet(c, { sid, user, now, salt: SALT }))).code, "seated");
    await inTx(pool, (c) => L.move(c, { sid, kind: "cashout", idem: `cash:del:${wid}`, cfg, now, from: L.acct.seat("tHdel", wid), to: L.acct.w(wid), amount: 4 }));
    assert.equal((await inTx(pool, (c) => L.deleteWallet(c, { sid, user, now, salt: SALT }))).ok, true);
    // search every text column of every play table for the id
    const { rows: cols } = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'play_%' AND data_type IN ('text','jsonb')");
    let hits = 0;
    for (const { table_name: t, column_name: col } of cols) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${col}::text LIKE $1`, ["%deleteme-7f3a%"]);
        hits += rows[0].n;
    }
    assert.equal(hits, 0, "the Matrix id must be gone from every table");
    // back within 30 days: 0, and the counters came back (no fresh day max, no second top-up)
    const back = await inTx(pool, (c) => L.createWallet(c, { sid, user, cfg, now: now + 3600000, salt: SALT }));
    assert.equal(back.start, 0); assert.equal(back.returning, true);
    const w2 = (await pool.query("SELECT earned_today, topup_day FROM play_wallets WHERE wid = $1", [back.wid])).rows[0];
    assert.deepEqual(w2, { earned_today: 6, topup_day: "2026-11-19" });
    // delete again and come back after 31 days: a fresh start
    await inTx(pool, (c) => L.deleteWallet(c, { sid, user, now: now + 7200000, salt: SALT }));
    const fresh = await inTx(pool, (c) => L.createWallet(c, { sid, user, cfg, now: now + 31 * 86400000, salt: SALT }));
    assert.equal(fresh.start, 10); assert.equal(fresh.returning, false);
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});

test("random sequences in two spaces: the audit stays clean and every replayed key changes nothing", { skip }, async () => {
    const cfg = cfgOf({});
    const spaces = [await newSpace(), await newSpace()];
    const wallets = [];
    for (const sid of spaces) for (const n of [1, 2, 3]) wallets.push({ sid, wid: (await inTx(pool, (c) => L.createWallet(c, { sid, user: `@prop${n}:play.test`, cfg, salt: SALT }))).wid });
    let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const done = [];
    for (let i = 0; i < 300; i++) {
        const a = wallets[rnd(wallets.length)];
        const peers = wallets.filter((w) => w.sid === a.sid && w.wid !== a.wid);
        const b = peers[rnd(peers.length)];
        const amt = 1 + rnd(6);
        const idem = `prop:${i}`;
        try {
            await inTx(pool, (c) => L.move(c, { sid: a.sid, kind: "rig-settle", idem, cfg, from: L.acct.w(a.wid), to: L.acct.w(b.wid), amount: amt }));
            done.push({ idem, a, b, amt });
        } catch (e) { assert.match(String(e.message), /nonneg/); } // a wallet can't go below 0: refused, nothing moved
        if (rnd(5) === 0 && done.length) { // replay an old key: nothing changes
            const old = done[rnd(done.length)];
            const before = await pool.query("SELECT sum(balance)::int AS s, sum(abs(balance))::int AS t FROM play_accounts");
            const r = await inTx(pool, (c) => L.move(c, { sid: old.a.sid, kind: "rig-settle", idem: old.idem, cfg, from: L.acct.w(old.a.wid), to: L.acct.w(old.b.wid), amount: old.amt }));
            const after2 = await pool.query("SELECT sum(balance)::int AS s, sum(abs(balance))::int AS t FROM play_accounts");
            assert.equal(r.dup, true); assert.deepEqual(after2.rows, before.rows);
        }
    }
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});
