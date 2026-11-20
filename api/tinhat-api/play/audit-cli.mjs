#!/usr/bin/env node
// `tinhat play audit` (run inside the API container: docker compose exec -T api node play/audit-cli.mjs): the ledger's
// invariants (ledger.mjs audit). Prints counts and any problem; never a Matrix id. Exit 0 = clean.
import { readFileSync } from "node:fs";
import pg from "pg";
import * as L from "./ledger.mjs";
const env = process.env;
let password = env.PLAY_DB_PASSWORD;
if (!password && env.PLAY_DB_PASSWORD_FILE) password = readFileSync(env.PLAY_DB_PASSWORD_FILE, "utf8").trim();
const client = env.PLAY_DB_URL ? new pg.Client({ connectionString: env.PLAY_DB_URL })
    : new pg.Client({ host: env.PLAY_DB_HOST, port: Number(env.PLAY_DB_PORT || 5432), database: env.PLAY_DB_NAME || "tinhat_play", user: env.PLAY_DB_USER || "tinhat_play", password });
try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const bad = await L.audit(client);
    const n = async (sql) => Number((await client.query(sql)).rows[0].n);
    const grants = (await client.query("SELECT count(*)::int AS n, COALESCE(sum(e.delta), 0)::bigint AS chips FROM play_tx t JOIN play_entries e ON e.tx = t.tx AND e.delta > 0 WHERE t.kind = 'lab-grant'")).rows[0];
    const counts = { spaces: await n("SELECT count(*) AS n FROM play_spaces"), wallets: await n("SELECT count(*) AS n FROM play_wallets"), transactions: await n("SELECT count(*) AS n FROM play_tx"), "open tables": await n("SELECT count(*) AS n FROM play_tables WHERE status = 'open'"), "open games": await n("SELECT count(*) AS n FROM play_games WHERE disposition = 'open'") };
    await client.query("ROLLBACK");
    console.log(Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));
    // LAB grants are listed every time (a release gate: a real box shows 0)
    console.log(`lab grants: ${grants.n} (${grants.chips} chips)${grants.n ? "  <- LAB ONLY: never on a server people use" : ""}`);
    if (bad.length) { console.log(`PROBLEMS (${bad.length}):\n${bad.slice(0, 50).join("\n")}`); process.exitCode = 1; }
    else console.log("audit clean: every balance = its entries, every space sums to 0, no negative account, every transaction balanced and in one space, games settled XOR voided");
} catch (e) { console.log(`couldn't audit: ${e.code || e.message}`); process.exitCode = 2; }
finally { await client.end().catch(() => {}); }
