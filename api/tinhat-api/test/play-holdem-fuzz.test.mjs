// The table engine under a seeded random driver: thousands of hands with timeouts, leaves mid-hand, kicks, aways,
// credits, voids and stale moves. After every move the ledger model (fed only by the effects) must match the engine,
// balance, and never go negative; every view must be private. See play-holdem-sim.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as table from "../play/holdem-table.mjs";
import { simulate } from "./play-holdem-sim.mjs";

test("fuzz: 40 seeded tables × 150 hands, books balance and views stay private after every move", () => {
    const total = { hands: 0, showdowns: 0, sidepots: 0, splits: 0, timeouts: 0, leavesMid: 0, voids: 0, allins: 0, kicks: 0, refused: 0 };
    for (let seed = 1; seed <= 40; seed++) {
        const st = simulate({ table }, { seed, hands: 150 });
        for (const k of Object.keys(total)) total[k] += st[k];
    }
    // the driver really reached the hard paths (a fuzz that never side-pots proves nothing about side pots)
    assert.ok(total.hands >= 4000, JSON.stringify(total));
    for (const k of ["showdowns", "sidepots", "splits", "timeouts", "leavesMid", "voids", "allins", "kicks", "refused"])
        assert.ok(total[k] >= 20, `${k} only ${total[k]}: ${JSON.stringify(total)}`);
});

test("fuzz: heads-up and full tables specifically", () => {
    for (const seats of [2, 8]) for (let seed = 100; seed < 110; seed++) simulate({ table }, { seed, hands: 100, seats });
});
