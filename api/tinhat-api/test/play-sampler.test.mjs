// The sampler (play/sampler.mjs): who a call-server connection is, the anti-AFK eligibility rule (§2.3 1-5), and on a
// real Postgres (PLAY_TEST_DB_URL) with a fake call server: opted-in people earn one chip per hour in a call; someone
// who never opted in leaves NO row and NO log line anywhere (searched), and a muted-for-31-minutes person stops earning.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { personOf, liveSignal, eligibility, createSampler, SAMPLER } from "../play/sampler.mjs";
import { migrate, inTx } from "../play/db.mjs";
import * as L from "../play/ledger.mjs";
import * as rules from "../play/rules.mjs";

test("personOf: devices and Pad connections fold into the person; Watch and junk are nobody", () => {
    assert.equal(personOf({ identity: "@a:play.test:DEV1" }), "@a:play.test");
    assert.equal(personOf({ identity: "@a:play.test:DEV2~pad-mic-0123456789abcdef" }), "@a:play.test");
    assert.equal(personOf({ identity: "@a:play.test:DEV2~pad-cam-0123456789abcdef" }), "@a:play.test");
    assert.equal(personOf({ identity: "@a:play.test:DEV~watch-0123456789abcdef" }), null);
    assert.equal(personOf({ identity: "nobody" }), null);
    assert.equal(personOf({ identity: "x", attributes: { "tinhat.person": "@b:play.test" } }), "@b:play.test");
    assert.equal(liveSignal({ tracks: [{ source: "MICROPHONE", muted: true }] }), false);
    assert.equal(liveSignal({ tracks: [{ source: "MICROPHONE", muted: false }] }), true);
    assert.equal(liveSignal({ tracks: [{ source: "CAMERA", muted: false }] }), true);
});

test("eligibility: alone, BRB, idle 31 min, guest or recorder company, no membership, not joined; and the eligible case", () => {
    const now = 1_000_000_000;
    const base = { person: "@a:x", connected: new Set(["@a:x", "@b:x"]), joined: new Set(["@a:x", "@b:x"]), inCall: new Set(["@a:x", "@b:x"]), away: new Set(), lastActive: now - 60_000, now, isGuest: (u) => /^@guest-/.test(u), isRecorder: (u) => u === "@rec:x" };
    assert.deepEqual(eligibility(base), { eligible: true, why: "" });
    assert.equal(eligibility({ ...base, connected: new Set(["@a:x"]) }).why, "alone");
    assert.equal(eligibility({ ...base, connected: new Set(["@a:x", "@guest-1:x"]) }).why, "alone");
    assert.equal(eligibility({ ...base, connected: new Set(["@a:x", "@rec:x"]) }).why, "alone");
    assert.equal(eligibility({ ...base, away: new Set(["@a:x"]) }).why, "brb");
    assert.equal(eligibility({ ...base, lastActive: now - 31 * 60_000 }).why, "idle");
    assert.equal(eligibility({ ...base, lastActive: now - 29 * 60_000 }).eligible, true);
    assert.equal(eligibility({ ...base, inCall: new Set(["@b:x"]) }).why, "no-membership");
    assert.equal(eligibility({ ...base, joined: new Set(["@b:x"]) }).why, "not-joined");
});

const ADMIN = process.env.PLAY_TEST_DB_URL;
const skip = !ADMIN && "set PLAY_TEST_DB_URL";
const DBNAME = `games_s1_s${process.pid}`;
let pool;
before(async () => {
    if (skip) return;
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.query(`CREATE DATABASE ${DBNAME}`); await a.end();
    const u = new URL(ADMIN.replace(/^postgres(ql)?:/, "http:")); u.pathname = `/${DBNAME}`;
    pool = new pg.Pool({ connectionString: u.href.replace(/^http:/, "postgresql:"), max: 6 });
    await migrate(pool);
});
after(async () => {
    if (skip) return;
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DBNAME}`); await a.end();
});

test("opted-in people earn; a person who never opted in leaves no row and no log line; idle stops earning", { skip }, async () => {
    const SPACE = "!sp:play.test", ROOM = "!call:play.test";
    const A = "@player-test1:play.test", B = "@player-test2:play.test", C = "@never-opted-in-9q7:play.test";
    const cfg = { ...rules.configFromEnv({}), tz: "America/Los_Angeles" };
    const sid = await inTx(pool, (c) => L.ensureSpace(c, SPACE, "play.test"));
    for (const u of [A, B]) await inTx(pool, (c) => L.createWallet(c, { sid, user: u, cfg, salt: "s" }));
    let clock = Date.parse("2026-11-19T20:00:00Z");
    let micA = true, micB = true;
    const lk = {
        listRooms: async () => [{ name: ROOM }, { name: "not-a-room" }],
        participants: async () => [
            { identity: `${A}:DEVA`, tracks: [{ source: "MICROPHONE", muted: !micA }] },
            { identity: `${A}:DEVA2~pad-mic-0123456789abcdef`, tracks: [] }, // A's phone: the same person, counted once
            { identity: `${B}:DEVB`, tracks: [{ source: "MICROPHONE", muted: !micB }] },
            { identity: `${C}:DEVC`, tracks: [{ source: "MICROPHONE", muted: false }] },
        ],
    };
    const everyone = new Set([A, B, C]);
    const spaces = { resolve: async () => ({ space: SPACE, server: "play.test", why: "", room: { joined: everyone, sessions: [...everyone].map((u) => ({ sender: u, createdTs: clock - 1000 })) }, spaceJoined: everyone }) };
    const logs = [];
    const s = createSampler({ pool, cfg, lk, spaces, now: () => clock, log: (x) => logs.push(x) });
    for (let i = 0; i <= 60; i++) { await s.run(); clock += SAMPLER.EVERY_MS; }
    const bal = async (u) => inTx(pool, async (c) => L.balance(c, L.acct.w(await L.widOfUser(c, sid, u))));
    assert.equal(await bal(A), 11, "A: 10 + one hour in a call");
    assert.equal(await bal(B), 11, "B: the same");
    // C: nothing anywhere
    const { rows: cols } = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'play_%' AND data_type IN ('text','jsonb')");
    for (const { table_name: t, column_name: col } of cols) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${col}::text LIKE $1`, ["%never-opted-in-9q7%"]);
        assert.equal(rows[0].n, 0, `${t}.${col} names the person who never opted in`);
    }
    assert.ok(logs.every((l) => !l.includes("never-opted-in")), "no log line names them");
    assert.ok(!s._lastActive.has(C), "not even in memory");
    // B mutes for 31 minutes (and does nothing else): B stops earning, A goes on
    micB = false;
    const before2 = { A: await bal(A), B: await bal(B) };
    for (let i = 0; i < 31; i++) { await s.run(); clock += SAMPLER.EVERY_MS; } // B still within 30 min of the last signal
    for (let i = 0; i < 61; i++) { await s.run(); clock += SAMPLER.EVERY_MS; }
    assert.ok((await bal(A)) >= before2.A + 1, "A goes on earning");
    assert.equal(await bal(B), before2.B, "B: idle (muted, no camera, no move) for over 30 minutes earns nothing more");
    assert.deepEqual(await inTx(pool, (c) => L.audit(c)), []);
});
