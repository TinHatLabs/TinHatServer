#!/usr/bin/env node
// `tinhat play lab-grant <space> <user> <n>` (inside the API container): LAB ONLY. Refused (and logged) unless the API's
// environment has TINHAT_LAB=1, which the manager never writes and no image sets. Prints no secret.
import { readFileSync } from "node:fs";
import pg from "pg";
import * as L from "./ledger.mjs";
import { configFromEnv } from "./rules.mjs";
const [space, user, nRaw] = process.argv.slice(2);
const env = process.env;
if (env.TINHAT_LAB !== "1") { console.log("refused: lab grants need TINHAT_LAB=1 (a lab box only)"); console.error("[play] lab-grant refused: not a lab box"); process.exit(3); }
if (!/^![^:\s]+:\S+$/.test(space || "") || !/^@[^:\s]+:\S+$/.test(user || "") || !/^\d{1,4}$/.test(nRaw || "")) { console.log("usage: tinhat play lab-grant !space:server @user:server N"); process.exit(2); }
let password = env.PLAY_DB_PASSWORD;
if (!password && env.PLAY_DB_PASSWORD_FILE) password = readFileSync(env.PLAY_DB_PASSWORD_FILE, "utf8").trim();
const client = env.PLAY_DB_URL ? new pg.Client({ connectionString: env.PLAY_DB_URL }) : new pg.Client({ host: env.PLAY_DB_HOST, port: Number(env.PLAY_DB_PORT || 5432), database: env.PLAY_DB_NAME || "tinhat_play", user: env.PLAY_DB_USER || "tinhat_play", password });
try {
    await client.connect();
    await client.query("BEGIN");
    const sid = await L.sidOf(client, space);
    const wid = sid ? await L.widOfUser(client, sid, user) : null;
    if (!wid) { await client.query("ROLLBACK"); console.log("no wallet for that person in that space"); process.exit(1); }
    const r = await L.labGrant(client, { env, sid, wid, n: Number(nRaw), cfg: configFromEnv(env) });
    if (!r.ok) { await client.query("ROLLBACK"); console.log(`refused: ${r.why || r.code}`); process.exit(1); }
    await client.query("COMMIT");
    console.log(`LAB grant: ${nRaw} chips (journal: lab-grant)`);
} catch (e) { await client.query("ROLLBACK").catch(() => {}); console.log(`failed: ${e.code || e.message}`); process.exitCode = 2; }
finally { await client.end().catch(() => {}); }
