// games-s2, round 2: the 0.3.20 → 0.3.21 games database migration (V3, additive; addendum §7.1) on a real Postgres
// (PLAY_TEST_DB_URL; skipped without it): a schema-2 database with wallets, journal and a tombstone (as 0.3.20 leaves
// it) moves to 3 with every balance and the audit unchanged, old-shape writes (0.3.20's INSERTs, i.e. a rollback to the
// older API) still work on the new schema, and the v1.1 reads see the defaults.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate, inTx, SCHEMA_VERSION } from "../play/db.mjs";
import * as L from "../play/ledger.mjs";
import * as rules from "../play/rules.mjs";

const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL to run the platform tests";
const DBNAME = `games_s2_mig_${process.pid}`;
let pool;
before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 4 });
});
after(async () => {
    if (skip) return;
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});

test("V2 → V3: balances, journal and audit unchanged; 0.3.20-shape writes still work; v1.1 reads see the defaults", { skip }, async () => {
    assert.equal(SCHEMA_VERSION, 3);
    assert.equal(await migrate(pool, { upTo: 2 }), 2);
    // a 0.3.20 database: one space, two wallets (start 10 each, one earned 3), a tombstone, with 0.3.20's own INSERTs
    const sid = await inTx(pool, (c) => L.ensureSpace(c, "!mig:play.test", "play.test"));
    for (const [wid, user, extra] of [["wMigA000000000000", "@mig-a:play.test", 3], ["wMigB000000000000", "@mig-b:play.test", 0]]) {
        await inTx(pool, async (c) => {
            await c.query("INSERT INTO play_people (sid, user_id, wid) VALUES ($1, $2, $3)", [sid, user, wid]);
            await c.query("INSERT INTO play_wallets (wid, sid, day, earned_today, topup_day) VALUES ($1, $2, $3, $4, $5)", [wid, sid, "2026-11-20", extra, null]);
            await L.post(c, { sid, kind: "start", idem: `start:${wid}`, day: "2026-11-20", entries: [[L.acct.mint("start", sid), -10], [L.acct.w(wid), 10]] });
            for (let i = 1; i <= extra; i++) await L.post(c, { sid, kind: "earn", idem: `earn:${wid}:2026-11-20:${i}`, day: "2026-11-20", entries: [[L.acct.mint("earn", sid), -1], [L.acct.w(wid), 1]] });
        });
    }
    await pool.query("INSERT INTO play_tombstones (sid, uhash, day, earned_today, topup_day) VALUES ($1, 'h-old', '2026-11-20', 2, null)", [sid]);
    const before = (await pool.query("SELECT id, balance FROM play_accounts ORDER BY id")).rows;
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
    // the update: V3
    assert.equal(await migrate(pool), 3);
    assert.equal(await migrate(pool), 3, "again: nothing");
    assert.deepEqual((await pool.query("SELECT id, balance FROM play_accounts ORDER BY id")).rows, before, "every balance unchanged");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
    const w = (await pool.query("SELECT side_day, side_earned FROM play_wallets WHERE wid = 'wMigA000000000000'")).rows[0];
    assert.deepEqual(w, { side_day: null, side_earned: 0 }, "the side counters start empty");
    assert.equal((await pool.query("SELECT side_earned FROM play_tombstones WHERE uhash = 'h-old'")).rows[0].side_earned, null);
    // a rollback to 0.3.20 writes its old shapes on the new schema
    await inTx(pool, async (c) => {
        await c.query("INSERT INTO play_people (sid, user_id, wid) VALUES ($1, '@mig-c:play.test', 'wMigC000000000000')", [sid]);
        await c.query("INSERT INTO play_wallets (wid, sid, day, earned_today, topup_day) VALUES ('wMigC000000000000', $1, '2026-11-20', 0, null)", [sid]);
        await c.query("INSERT INTO play_tombstones (sid, uhash, deleted_on, day, earned_today, topup_day) VALUES ($1, 'h-new', now(), '2026-11-20', 0, null)", [sid]);
    });
    // the v1.1 reads: no space economy row = the server's values; /me at the v1.1 defaults
    const m = await inTx(pool, (c) => L.me(c, { sid, spaceId: "!mig:play.test", user: "@mig-a:play.test", cfg: { ...rules.configFromEnv({}), tz: "UTC" }, now: Date.parse("2026-11-20T20:00:00Z") }));
    assert.deepEqual([m.balance, m.day_max, m.chip_minutes, m.chip_s, m.earned_today], [13, 16, 15, 900, 3]);
});
