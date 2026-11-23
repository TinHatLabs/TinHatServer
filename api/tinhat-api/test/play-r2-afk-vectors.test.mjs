// vectors/afk-v1.json (games-s2, reviewed by games-design2) through the Hold'em table engine, plus its negative
// controls: each planted wrong rule must fail the case the vector file names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(HERE, "vectors/play/afk-v1.json"), "utf8"));
const ENGINE = process.env.AFK_ENGINE || join(HERE, "../play/holdem-table.mjs");
const { createTable, move, viewFor, wouldDeal, HOLDEM } = await import(new URL(`file://${ENGINE}`).href);
const { freshDeck } = await import(new URL("../play/holdem-cards.mjs", import.meta.url).href);
const NOW = 1_763_600_000_000, SP = "sid-1";

export function runCase(c) {
    let T = createTable({ host: c.players[0][0], space: SP, opts: { seats: 8 }, now: NOW });
    let now = NOW, fx = [], gone = new Set();
    const go = (m, system = false) => {
        const admitted = m.do === "deal" || m.do === "tick" ? true : wouldDeal(T, m, now) ? true : undefined;
        const r = move(T, m, { now, randomInt: () => 0, system, admitted, gone });
        if (!r.ok) throw new Error(`${c.id}: ${JSON.stringify(m)} refused ${r.code}`);
        T = r.state; fx = r.effects;
    };
    c.players.forEach(([id, chips], i) => go({ do: "sit", by: id, chips, seat: i + 1, space: SP }));
    const at = () => ({ hand: T.hand.n, turn: T.hand.turn });
    for (const s of c.steps) {
        const [k, a, b, extra] = s;
        if (k === "deal") go({ do: "deal", by: a });
        else if (k === "tick") { if (a === "deadline") now = T.hand.deadline; else if (a === "pause") now += HOLDEM.PAUSE_MS; else if (a !== "now") now += Number(a); go({ do: "tick" }, true); }
        else if (k === "act") go({ do: b, by: a, at: at(), ...(extra || {}) });
        else if (k === "away") go({ do: "away", by: a, on: b });
        else if (k === "gone") gone = new Set(a);
        else if (k === "react") { /* F7: a reaction never reaches the table engine */ }
        else if (k === "foldout") { for (let i = 0; i < 20 && T.status === "hand"; i++) go({ do: "fold", by: T.seats[T.hand.b.toAct].id, at: at() }); }
        else if (k === "rig") { const used = new Set([...Object.values(a).flat(), ...b]); T.hand.holes = structuredClone(a); T.hand.deck = [...b, ...freshDeck().filter((x) => !used.has(x))]; }
        else if (k === "expect") {
            const v = viewFor(T, { viewer: null });
            const seat = (n) => v.seats.find((x) => x.seat === Number(n));
            for (const [key, want] of Object.entries(a)) {
                const where = `${c.id} expect ${key}`;
                if (key === "away") for (const [n, r] of Object.entries(want)) assert.equal(seat(n)?.away?.reason ?? null, r, `${where} seat ${n}`);
                else if (key === "hands_left") for (const [n, h] of Object.entries(want)) assert.equal(seat(n)?.away?.hands_left, h, `${where} seat ${n}`);
                else if (key === "state") for (const [n, st] of Object.entries(want)) assert.equal(seat(n)?.state, st, `${where} seat ${n}`);
                else if (key === "order") assert.deepEqual(T.hand.order, want, where);
                else if (key === "status") assert.equal(T.status, want, where);
                else if (key === "button") assert.equal(T.hand.button, want, where);
                else if (key === "sb_seat") assert.equal(T.hand.b.sbSeat, want, where);
                else if (key === "no_bet_from") assert.ok(!fx.some((e) => e.t === "bet" && want.includes(e.id)), where);
                else if (key === "deadline") assert.equal(T.hand.deadline, want === "now" ? now : now + HOLDEM.TURN_S * 1000, where);
                else if (key === "last") assert.deepEqual({ seat: T.hand.last.seat, a: T.hand.last.a }, want, where);
                else if (key === "seated") assert.deepEqual(Object.keys(T.seats).map(Number).sort((x, y) => x - y), want, where);
                else if (key === "cashout") assert.deepEqual(fx.filter((e) => e.t === "cashout" && e.id === want.id).map((e) => ({ id: e.id, amount: e.amount, reason: e.reason })), [want], where);
                else if (key === "winners") assert.deepEqual(T.hand.result.pots[0].winners, want, where);
                else throw new Error(`${where}: unknown expect key`);
            }
        } else throw new Error(`${c.id}: unknown step ${k}`);
    }
}

test("afk-v1.json: the constants are the engine's", () => {
    for (const [k, v] of Object.entries(V.constants)) assert.equal(HOLDEM[k], v, k);
});
for (const c of V.cases) test(`afk-v1 ${c.id}: ${c.about}`, () => runCase(c));

// the negative controls the vector file names: each planted wrong rule must fail its case
const PLANTS = [
    { name: "AWAY_AFTER_TIMEOUTS = 2", from: "AWAY_AFTER_TIMEOUTS: 1,", to: "AWAY_AFTER_TIMEOUTS: 2,", fails: "one-timeout" },
    { name: "an away seat dealt in", from: ".filter((s) => T.seats[s].stack + T.seats[s].pending > 0 && !T.seats[s].away && !T.seats[s].leaving);", to: ".filter((s) => T.seats[s].stack + T.seats[s].pending > 0 && !T.seats[s].leaving);", fails: "no-blind" },
    { name: "away treated as folded", from: "if (x.timeouts >= HOLDEM.AWAY_AFTER_TIMEOUTS && !x.away) setAway(x, \"timeout\", c.now);", to: "if (x.timeouts >= HOLDEM.AWAY_AFTER_TIMEOUTS && !x.away) { setAway(x, \"timeout\", c.now); h.b.p[s].folded = true; }", fails: "timed-out-check-wins" },
];
if (!process.env.AFK_ENGINE) for (const p of PLANTS) test(`afk-v1 plant FAILS: ${p.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "games-s2-afk-plant-"));
    try {
        cpSync(join(HERE, "../play"), join(dir, "play"), { recursive: true });
        const f = join(dir, "play/holdem-table.mjs");
        const src = readFileSync(f, "utf8");
        assert.equal(src.split(p.from).length, 2, "the plant matches exactly once");
        writeFileSync(f, src.replace(p.from, p.to));
        const r = spawnSync(process.execPath, ["--test", "--test-name-pattern", `afk-v1 ${p.fails}:`, fileURLToPath(import.meta.url)], { env: (({ NODE_TEST_CONTEXT, ...e }) => ({ ...e, AFK_ENGINE: f }))(process.env), encoding: "utf8" });
        assert.notEqual(r.status, 0, `the plant "${p.name}" passed ${p.fails}`);
        assert.match(r.stdout, new RegExp(`not ok \\d+ - afk-v1 ${p.fails}:`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
