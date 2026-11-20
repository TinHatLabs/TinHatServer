// G1: the manager's games-database restore checks the ledger with playdb.AUDIT_SQL / COUNT_SQL (appliance manager,
// Python). This runs THOSE SQL texts (read from playdb.py) on a real games database made by the real migrations
// (PLAY_TEST_DB_URL; skipped without it): clean, with the right counts, after real ledger moves; and each planted
// violation is caught (a balance that isn't its entries, an unbalanced transaction, a negative wallet).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, inTx } from "../play/db.mjs";
import * as L from "../play/ledger.mjs";
import * as rules from "../play/rules.mjs";

const PLAYDB = fileURLToPath(new URL("../../../appliance/rootfs/opt/tinhat/manager/tinhat/playdb.py", import.meta.url));
const src = readFileSync(PLAYDB, "utf8");
const sqlOf = (name) => {
    const m = src.match(new RegExp(`^${name} = """\\\\\\n([\\s\\S]*?)"""`, "m"));
    if (!m) throw new Error(`${name} not found in playdb.py`);
    return m[1];
};
const AUDIT = sqlOf("AUDIT_SQL"), COUNT = sqlOf("COUNT_SQL");
const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL";
const DBNAME = `games_s1_g1_${process.pid}`;
let pool;
before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 4 });
    await migrate(pool);
});
after(async () => {
    if (skip) return;
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});
const row = async (sql) => Object.values((await pool.query({ text: sql, rowMode: "array" })).rows[0]).map(Number);

test("playdb's ledger check and counts on a real games database, and each planted violation caught", { skip }, async () => {
    const cfg = { ...rules.configFromEnv({}), tz: "UTC" };
    const sid = await inTx(pool, (c) => L.ensureSpace(c, "!g1:play.test", "play.test"));
    for (const u of ["@g1-a:play.test", "@g1-b:play.test", "@g1-c:play.test"]) await inTx(pool, (c) => L.createWallet(c, { sid, user: u, cfg, salt: "s" }));
    assert.deepEqual(await row(AUDIT), [0, 0, 0, 0, 0], "a real ledger is clean");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), [], "and the API's own audit agrees");
    const [wallets, txs, entries, inWallets, held] = await row(COUNT);
    assert.equal(wallets, 3);
    assert.equal(inWallets, 3 * cfg.start);
    assert.equal(held, inWallets);
    assert.ok(txs >= 3 && entries >= 2 * txs);
    // controls: the journal's own triggers forbid these, so they are planted with the user triggers off
    const c = await pool.connect();
    try {
        await c.query("ALTER TABLE play_accounts DISABLE TRIGGER USER");
        await c.query("UPDATE play_accounts SET balance = balance + 1 WHERE id = (SELECT id FROM play_accounts WHERE kind = 'w' ORDER BY id LIMIT 1)");
        const bad = await row(AUDIT);
        assert.ok(bad[0] > 0, "a balance that isn't its entries is caught");
        assert.ok(bad[4] > 0, "and its space no longer sums to zero");
        await c.query("UPDATE play_accounts SET balance = balance - 1 WHERE id = (SELECT id FROM play_accounts WHERE kind = 'w' ORDER BY id LIMIT 1)");
        assert.deepEqual(await row(AUDIT), [0, 0, 0, 0, 0]);
        await c.query("ALTER TABLE play_entries DISABLE TRIGGER ALL");
        const { rows: [e] } = await c.query("SELECT tx, account FROM play_entries ORDER BY tx, account LIMIT 1");
        await c.query("INSERT INTO play_entries (tx, account, delta) VALUES ($1, $2, 5)", [e.tx, e.account]);
        assert.ok((await row(AUDIT))[1] > 0, "an unbalanced transaction is caught");
        // (a wallet can't go negative while the schema's CHECK stands, and layer 1 refuses a schema without it: this
        // part of the audit is defense in depth, planted here in the scratch database by dropping the CHECK)
        await c.query("ALTER TABLE play_accounts DROP CONSTRAINT play_accounts_nonneg");
        await c.query("UPDATE play_accounts SET balance = -1 WHERE id = (SELECT id FROM play_accounts WHERE kind = 'w' ORDER BY id LIMIT 1)");
        assert.ok((await row(AUDIT))[3] > 0, "a negative wallet is caught");
    } finally {
        await c.query("ALTER TABLE play_entries ENABLE TRIGGER ALL").catch(() => {});
        await c.query("ALTER TABLE play_accounts ENABLE TRIGGER USER").catch(() => {});
        c.release();
    }
});
