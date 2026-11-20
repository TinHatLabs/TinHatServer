// The Hold'em engine against the shared vectors (GAMES-V1-SPEC §7; test/vectors/play/holdem-*.json are byte-identical
// copies of the spec's vectors/, checked by md5 in play-holdem-plants.test.mjs). The engine has no other source of
// truth: a case that fails here is a bug in the engine, never in the vector (a vector that looks wrong is reported).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runRanking, runShowdown, runSidePots, runBetting } from "./play-holdem-vector-runner.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(`./vectors/play/${f}`, import.meta.url), "utf8"));
const RANK = load("holdem-hand-ranking.json");
const POTS = load("holdem-side-pots.json");
const BET = load("holdem-betting.json");

const engine = {
    rank: await import("../play/holdem-rank.mjs"),
    pots: await import("../play/holdem-pots.mjs"),
    betting: await import("../play/holdem-betting.mjs"),
};

test("hand ranking vectors: every seven-card case (category + key)", () => {
    assert.equal(RANK.v, 1);
    assert.ok(RANK.seven.length >= 19);
    for (const c of RANK.seven) assert.deepEqual(runRanking(engine, c), c.expect, `${c.id}: ${c.why}`);
});

test("hand ranking vectors: every showdown (ranking groups + keys)", () => {
    assert.ok(RANK.showdown.length >= 9);
    for (const c of RANK.showdown) assert.deepEqual(runShowdown(engine, c), c.expect, `${c.id}: ${c.why}`);
});

test("side pot vectors: returned chips, pots, winners, paid, won", () => {
    assert.equal(POTS.v, 1);
    assert.ok(POTS.cases.length >= 11);
    for (const c of POTS.cases) assert.deepEqual(runSidePots(engine, c), c.expect, `${c.id}: ${c.why}`);
});

test("betting vectors: street, next seat, legal moves, refusals", () => {
    assert.equal(BET.v, 1);
    assert.ok(BET.cases.length >= 14);
    for (const c of BET.cases) assert.deepEqual(runBetting(engine, c), c.expect, `${c.id}: ${c.why}`);
});

test("chips are whole and nothing is created or lost in any side pot case", () => {
    for (const c of POTS.cases) {
        const r = runSidePots(engine, c);
        const inTotal = Object.values(c.put_in).reduce((a, b) => a + b, 0);
        const out = Object.values(r.returned).reduce((a, b) => a + b, 0) + Object.values(r.won).reduce((a, b) => a + b, 0);
        assert.equal(out, inTotal, c.id);
    }
});
