// The Rig's shared vectors (GAMES-V1-SPEC §7; vectors/play/rig-*.json are byte-identical copies of the contract's
// files and the ONLY source of truth: a vector that looks wrong is reported, never edited). Every expected field is
// compared as JSON text in the vector's own key order, so a value, a key or an order that differs fails.
// RIG_ENGINE_DIR (tests only) points this file at another copy of the engine: play-rig-mutants.test.mjs uses it to show
// that a planted wrong rule fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dir = process.env.RIG_ENGINE_DIR ? pathToFileURL(process.env.RIG_ENGINE_DIR + "/").href : new URL("../play/", import.meta.url).href;
const R = await import(new URL("rig-rules.mjs", dir).href);
const G = await import(new URL("rig-rng.mjs", dir).href);
const SPINS = JSON.parse(readFileSync(new URL("./vectors/play/rig-spins.json", import.meta.url), "utf8"));
const RNG = JSON.parse(readFileSync(new URL("./vectors/play/rig-rng.json", import.meta.url), "utf8"));

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const same = (got, want, msg) => assert.equal(JSON.stringify(pick(got, Object.keys(want))), JSON.stringify(want), msg);

test("rig-spins: all 34 spins resolve exactly (reels, category, payouts, touched/bit order, rake, bank)", () => {
    assert.equal(SPINS.spins.length, 34);
    for (const c of SPINS.spins) {
        const got = R.resolveSpin(c.in);
        same(got, c.expect, `${c.id}: ${c.why}`);
        assert.equal(got.draws_left, 0, `${c.id}: every draw the vector gives is used`);
        // conservation: what the Spinner lost or won = rake + the bank
        const rake = Object.values(got.rake).reduce((s, v) => s + v, 0);
        assert.equal(0 - got.spinner_delta, rake + got.bank_delta, `${c.id}: chips conserved`);
    }
});

test("rig-spins: the machine rules (bite budget, one Tax, no card twice)", () => {
    assert.equal(SPINS.machine.cases.length, 7);
    for (const c of SPINS.machine.cases) same(R.machineOk(c.cards), c.expect, c.id);
});

test("rig-spins: Market settlement (pari-mutuel, floor, one side = refunds)", () => {
    assert.equal(SPINS.market.cases.length, 3);
    for (const c of SPINS.market.cases) {
        const got = R.settleMarket(c.bets, c.spinner_up);
        // `back` is compared per person (the vector lists winners first); the bank exactly
        assert.deepEqual(got.back, c.expect.back, `${c.id}: ${c.why}`);
        assert.equal(got.bank, c.expect.bank, c.id);
        const staked = c.bets.reduce((s, b) => s + b.stake, 0);
        assert.equal(Object.values(got.back).reduce((s, v) => s + v, 0) + got.bank, staked, `${c.id}: conserved`);
    }
});

test("rig-spins: Peek settlement, and the cross-target case gives the same answer in either order", () => {
    assert.equal(SPINS.peek.cases.length, 5);
    for (const c of SPINS.peek.cases) {
        const got = R.settlePeeks(c.peeks, c.mechanic_balance).delta;
        assert.deepEqual(got, c.expect.delta, `${c.id}: ${c.why}`);
        const rev = R.settlePeeks([...c.peeks].reverse(), c.mechanic_balance).delta;
        assert.deepEqual(rev, c.expect.delta, `${c.id}: the same in reverse order`);
        // escrow 2 per Peek: deltas (after escrow) + escrows = 0 overall (chips only move between players)
        assert.equal(Object.values(got).reduce((s, v) => s + v, 0), 2 * c.peeks.length, `${c.id}: conserved`);
    }
});

test("rig-rng: known answers (commit, honest reels, re-rolls, both decks, dead/deal, slot order, rejection)", () => {
    const E = RNG.expect;
    const seed = Buffer.from(E.seed_hex, "hex");
    assert.deepEqual(R.DECK, RNG.deck_order, "card numbers = deck order");
    assert.deepEqual(R.LITE_DECK, RNG.lite_deck_order);
    assert.equal(G.commitOf(seed), E.commit_sha256_hex);
    for (const [s, reels] of Object.entries(E.honest_reels)) assert.deepEqual(G.honestReels(seed, Number(s)), reels, `spin ${s}`);
    const src = G.rerollSource(seed, 1);
    assert.deepEqual([0, 1, 2, 3].map(() => src.next()), E.rerolls_spin1);
    for (const r of E.reroll_symbols) {
        const s = G.rerollSource(seed, 1);
        for (let k = 0; k < r.j; k++) s.next();
        const sym = R.SYMBOLS.filter((x) => x !== r.replacing)[s.next()];
        assert.equal(sym, r.symbol, `re-roll ${r.j} replacing ${r.replacing}`);
    }
    const full = G.shuffle(seed, "deck:0", R.DECK);
    assert.deepEqual(full, E.full_deck_attempt0);
    assert.deepEqual(G.shuffle(seed, "deck:0", R.LITE_DECK), E.lite_deck_attempt0);
    assert.deepEqual(full.slice(0, R.PRESETS.full.dead), E.full_dead);
    const d = R.PRESETS.full.dead;
    assert.deepEqual([0, 1, 2].map((m) => full.slice(d + 2 * m, d + 2 * m + 2)), E.full_dealt);
    assert.deepEqual(G.shuffle(seed, "slot", [0, 1, 2]), E.slot_order_of_3);
    const rj = E.rejection_case;
    assert.deepEqual(G.drawWithCounter(seed, rj.label, rj.n), { value: rj.value, counter: rj.counter_used });
});

test("rig-rng: the engine's deal uses exactly the vector's positions (attempt 0, Full, 3 Mechanics)", async () => {
    const E = RNG.expect;
    const { dealFor } = await import(new URL("rig.mjs", dir).href);
    const deal = dealFor(Buffer.from(E.seed_hex, "hex"), R.PRESETS.full, 3);
    // attempt 0 (bites 2+2+2, no Tax) satisfies the machine rules for every choice, so it is the deal used
    assert.equal(deal.attempt, 0);
    assert.deepEqual(deal.dead, E.full_dead);
    assert.deepEqual(deal.hands, E.full_dealt);
    assert.deepEqual(deal.slots, E.slot_order_of_3);
});
