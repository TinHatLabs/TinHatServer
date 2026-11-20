// The Hold'em table engine, rule by rule (GAMES-V1-SPEC §4.1–§4.3): scripted hands with rigged cards. Each test
// names the rule; the planted-wrong-rule controls in play-holdem-plants.test.mjs show these tests can fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable, move, viewFor, nextWake, wouldDeal, handRecord, historyFor, HOLDEM } from "../play/holdem-table.mjs";
import { shuffle, freshDeck, shuffledDeck } from "../play/holdem-cards.mjs";
import { Ledger, checkState } from "./play-holdem-sim.mjs";

const NOW = 1_763_600_000_000;
const ZERO = () => 0; // deterministic shuffle + the first eligible seat gets the first button
const SP = "sid-1"; // the table's game space (the server's opaque space id)

/** A tiny harness: a table, a clock, a ledger model fed by the effects, checked after every move. */
function harness(players, { seats = 8 } = {}) {
    const H = { now: NOW, L: new Ledger(), fx: [], admit: true, T: createTable({ host: players[0][0], space: SP, opts: { seats }, now: NOW }) };
    H.do = (m, { system = false, expect = true } = {}) => {
        if (m.do === "sit" && !("space" in m)) m = { ...m, space: SP };
        // the server's admission check runs exactly when the move would start a hand
        const admitted = wouldDeal(H.T, m, H.now) ? H.admit : undefined;
        const r = move(H.T, m, { now: H.now, randomInt: ZERO, system, admitted });
        if (expect === true) assert.ok(r.ok, `${JSON.stringify(m)} refused: ${r.code}`);
        else { assert.equal(r.ok, false, `${JSON.stringify(m)} should be refused`); assert.equal(r.code, expect); assert.equal(r.state, H.T); return r; }
        H.L.apply(r.effects);
        H.T = r.state;
        H.fx = r.effects;
        checkState(H.T, H.L);
        return r;
    };
    H.at = () => ({ hand: H.T.hand.n, turn: H.T.hand.turn });
    H.p = (by, d, extra = {}) => H.do({ do: d, by, at: H.at(), ...extra });
    H.toAct = () => H.T.seats[H.T.hand.b.toAct].id;
    H.tick = (t) => { if (t !== undefined) H.now = t; return H.do({ do: "tick" }, { system: true }); };
    /** rig the open hand: hole cards per seat, then the board in dealing order */
    H.rig = (holes, board) => {
        const used = new Set([...Object.values(holes).flat(), ...board]);
        H.T.hand.holes = structuredClone(holes);
        H.T.hand.deck = [...board, ...freshDeck().filter((c) => !used.has(c))];
    };
    H.view = (viewer) => viewFor(H.T, { viewer });
    for (const [i, [id, chips, seat]] of players.entries()) H.do({ do: "sit", by: id, chips, seat: seat ?? i + 1 });
    return H;
}

test("heads-up: the button posts the small blind and acts first; the big blind acts first after the flop; showdown pays the best hand", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    const deal = H.fx;
    assert.deepEqual(deal.map((e) => [e.t, e.a ?? "", e.amount ?? ""]), [["deal", "", ""], ["bet", "sb", 1], ["bet", "bb", 2]]);
    assert.equal(H.T.hand.button, 1);
    assert.equal(H.toAct(), "p1");
    assert.equal(H.T.hand.turn, 1);
    assert.equal(H.T.hand.deadline, NOW + 30_000);
    assert.deepEqual(H.T.hand.last, { seat: 2, a: "bb", to: 2 }, "after the deal: the big blind's post");
    H.rig({ 1: ["As", "Ad"], 2: ["Kc", "Kd"] }, ["2h", "7s", "9c", "Jd", "3h"]);
    H.p("p1", "call");
    assert.equal(H.toAct(), "p2");
    H.p("p2", "check");
    assert.equal(H.T.hand.street, "flop");
    assert.deepEqual(H.T.hand.board, ["2h", "7s", "9c"]);
    assert.equal(H.T.hand.last, null, "a new street starts with no last action");
    assert.equal(H.toAct(), "p2", "heads-up after the flop: the big blind acts first");
    H.p("p2", "raise", { to: 10 });
    assert.equal(H.T.hand.last.a, "bet");
    H.p("p1", "call");
    assert.equal(H.T.hand.street, "turn");
    H.p("p2", "check"); H.p("p1", "check");
    H.p("p2", "check"); H.p("p1", "check");
    assert.equal(H.T.status, "pause");
    const settle = H.fx.find((e) => e.t === "settle");
    assert.deepEqual(settle, { t: "settle", hand: 1, from: { p1: 12, p2: 12 }, to: { p1: 24, p2: 0 } });
    assert.equal(H.T.seats[1].stack, 62);
    assert.equal(H.T.seats[2].stack, 38);
    const v = H.view("p2");
    assert.deepEqual(v.seats.find((s) => s.seat === 1).shown, ["As", "Ad"]);
    assert.equal(v.hand.result.best[1].category, "pair");
    assert.deepEqual(v.hand.result.best[1].five, ["As", "Ad", "Jd", "9c", "7s"], "most significant first");
    assert.deepEqual(v.hand.last, { seat: 1, a: "check" }, "a finished hand keeps its last action");
    assert.deepEqual(v.hand.pots, [{ amount: 24, eligible: [1, 2], winners: [1], paid: { 1: 24 } }]);
    assert.equal(v.next_at, H.now + HOLDEM.PAUSE_MS);
    assert.equal(nextWake(H.T), H.now + HOLDEM.PAUSE_MS);
    // the next hand starts by itself 5 s later, the button moves clockwise
    H.tick(H.now + HOLDEM.PAUSE_MS);
    assert.equal(H.T.status, "hand");
    assert.equal(H.T.hand.n, 2);
    assert.equal(H.T.hand.button, 2);
    assert.equal(H.toAct(), "p2");
});

test("refusals: stale turn, someone else's turn, bad amount, wrong phase, host-only — the state is handed back untouched", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "call", by: "p1", at: { hand: 1, turn: 1 } }, { expect: "phase" });
    H.do({ do: "deal", by: "p2" }, { expect: "host-only" });
    H.do({ do: "deal", by: "p1" });
    assert.equal(H.toAct(), "p1"); // three-handed: the button (seat 1) acts first
    H.do({ do: "call", by: "p1", at: { hand: 1, turn: 2 } }, { expect: "stale" });
    H.do({ do: "call", by: "p1", at: { hand: 0, turn: 1 } }, { expect: "stale" });
    H.do({ do: "call", by: "p2", at: H.at() }, { expect: "not-your-turn" });
    H.do({ do: "raise", by: "p1", at: H.at(), to: 3 }, { expect: "bad-amount" });
    H.do({ do: "raise", by: "p1", at: H.at(), to: 51 }, { expect: "bad-amount" });
    H.do({ do: "raise", by: "p1", at: H.at(), to: 4.5 }, { expect: "bad-amount" });
    H.do({ do: "check", by: "p1", at: H.at() }, { expect: "bad-action" });
    H.do({ do: "deal", by: "p1" }, { expect: "phase" });
    H.do({ do: "sit", by: "p2", chips: 5 }, { expect: "seated" });
    H.do({ do: "sit", by: "p4", chips: 0 }, { expect: "no-chips" });
    H.do({ do: "sit", by: "p4", chips: 5, seat: 2 }, { expect: "bad" });
    H.do({ do: "tick" }, { expect: "bad" }); // system moves only from the server itself
    H.do({ do: "credit", target: "p1", amount: 3 }, { expect: "bad" });
    H.do({ do: "kick", by: "p2", target: "p1" }, { expect: "host-only" });
    // a double click: the second copy of the same move names a turn that has passed
    const at = H.at();
    H.do({ do: "call", by: "p1", at });
    H.do({ do: "call", by: "p1", at }, { expect: "stale" });
});

test("a full table refuses a sit (table-full); seat numbers stay within the host's seat count", () => {
    const H = harness([["p1", 5], ["p2", 5]], { seats: 2 });
    H.do({ do: "sit", by: "p3", chips: 5 }, { expect: "table-full" });
    assert.throws(() => createTable({ host: "x", space: SP, opts: { seats: 9 }, now: NOW }));
    assert.throws(() => createTable({ host: "x", space: SP, opts: { seats: 1 }, now: NOW }));
    assert.throws(() => createTable({ host: "x", opts: { seats: 2 }, now: NOW }), /space/);
});

test("timeouts: check if free, else fold; two in a row → away from the next hand (dealt out, no blinds); I'm back returns", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" }); // button 1, SB 2, BB 3, p1 first
    assert.equal(H.toAct(), "p1");
    H.tick(H.T.hand.deadline - 1);
    assert.equal(H.toAct(), "p1", "nothing happens before the deadline");
    H.tick(H.T.hand.deadline);
    assert.equal(H.T.hand.log.at(-1).a, "fold", "facing the big blind: a timeout folds");
    assert.equal(H.T.hand.log.at(-1).timeout, true);
    assert.equal(H.T.seats[1].timeouts, 1);
    H.p("p2", "call");
    H.p("p3", "check");
    H.p("p2", "check"); H.p("p3", "check");
    H.p("p2", "check"); H.p("p3", "check");
    H.p("p2", "check"); H.p("p3", "check");
    H.tick(H.now + HOLDEM.PAUSE_MS); // hand 2: button 2, SB 3, BB 1; p2 first
    assert.equal(H.T.hand.button, 2);
    H.p("p2", "call");
    H.p("p3", "call");
    assert.equal(H.toAct(), "p1");
    H.tick(H.T.hand.deadline);
    assert.equal(H.T.hand.log.at(-1).a, "check", "the big blind's option: a timeout checks");
    assert.equal(H.T.seats[1].away, true, "a second timeout in a row: away from the next hand");
    // finish hand 2
    H.p("p3", "raise", { to: 20 });
    H.tick(H.T.hand.deadline); // p1 times out again: folds
    H.p("p2", "fold");
    assert.equal(H.T.status, "pause");
    H.tick(H.now + HOLDEM.PAUSE_MS);
    assert.deepEqual(H.T.hand.order, [2, 3], "away: dealt out");
    assert.ok(!H.fx.some((e) => e.t === "bet" && e.id === "p1"), "away: no blinds");
    assert.equal(H.view(null).seats.find((s) => s.seat === 1).state, "away");
    H.do({ do: "away", by: "p1", on: false });
    assert.equal(H.view(null).seats.find((s) => s.seat === 1).state, "active");
    H.p(H.toAct(), "fold");
    H.tick(H.now + HOLDEM.PAUSE_MS);
    assert.deepEqual(H.T.hand.order, [1, 2, 3], "back: dealt in at the next hand without posting a missed blind");
});

test("a move of one's own breaks a run of timeouts (and an automatic away); an away the player asked for stays", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.tick(H.T.hand.deadline); // p1 (SB) folds on timeout
    H.tick(H.now + HOLDEM.PAUSE_MS); // hand 2: button 2 = SB acts first
    H.p("p2", "call");
    H.tick(H.T.hand.deadline); // p1 checks on timeout: the second in a row → away
    assert.equal(H.T.seats[1].away, true);
    H.p("p1", "check"); // flop: p1 acts first heads-up (BB) and moves by hand
    assert.equal(H.T.seats[1].away, false);
    assert.equal(H.T.seats[1].timeouts, 0);
    H.do({ do: "away", by: "p2", on: true });
    H.p("p2", "check");
    assert.equal(H.T.seats[2].away, true, "asked for: playing out the current hand doesn't undo it");
});

test("away for 10 minutes → the player leaves (cash-out, reason away)", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 30]]);
    H.do({ do: "away", by: "p3", on: true });
    const since = H.now;
    assert.equal(nextWake(H.T), since + HOLDEM.AWAY_LEAVE_MS);
    H.tick(since + HOLDEM.AWAY_LEAVE_MS - 1);
    assert.ok(H.T.seats[3]);
    H.tick(since + HOLDEM.AWAY_LEAVE_MS);
    assert.deepEqual(H.fx, [{ t: "cashout", seat: 3, id: "p3", amount: 30, reason: "away" }]);
    assert.equal(H.T.seats[3], undefined);
});

test("leaving mid-hand: marked leaving, folded the moment the action reaches them (no timer), cashed out after the settle", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" }); // p1 to act; p3 = BB
    H.do({ do: "leave", by: "p3" });
    assert.equal(H.T.seats[3].leaving, true);
    assert.equal(H.view(null).seats.find((s) => s.seat === 3).state, "leaving");
    assert.ok(!H.fx.some((e) => e.t === "cashout"), "nobody is cashed out with chips in the pot");
    H.p("p1", "call");
    const before = H.T.hand.turn;
    H.p("p2", "call"); // the action reaches p3: folded at once, no turn of their own to wait out
    const auto = H.T.hand.log.at(-1);
    assert.deepEqual([auto.seat, auto.a, auto.auto], [3, "fold", "leaving"]);
    assert.equal(H.T.hand.street, "flop");
    assert.ok(H.T.hand.turn > before + 1);
    assert.equal(H.T.hand.deadline, H.now + 30_000);
    H.p("p2", "raise", { to: 4 }); // flop: p2 first after the button
    H.p("p1", "fold");
    const kinds = H.fx.map((e) => e.t);
    assert.ok(kinds.indexOf("settle") < kinds.indexOf("cashout"), "settle first, then the cash-out");
    assert.deepEqual(H.fx.find((e) => e.t === "cashout"), { t: "cashout", seat: 3, id: "p3", amount: 48, reason: "leave" });
    assert.equal(H.T.seats[3], undefined);
});

test("leaving on one's own turn folds at once; leaving while all-in plays the hand out and cashes out the winnings", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.do({ do: "leave", by: "p1" });
    assert.deepEqual([H.T.hand.log.at(-1).seat, H.T.hand.log.at(-1).a], [1, "fold"]);
    assert.equal(H.toAct(), "p2");
    const G = harness([["a", 20], ["b", 20]]);
    G.do({ do: "deal", by: "a" });
    G.rig({ 1: ["As", "Ad"], 2: ["Kc", "Kd"] }, ["2h", "7s", "9c", "Jd", "3h"]);
    G.p("a", "allin");
    G.do({ do: "leave", by: "a" });
    assert.equal(G.T.seats[1].leaving, true);
    G.p("b", "call");
    const out = G.fx.find((e) => e.t === "cashout");
    assert.deepEqual(out, { t: "cashout", seat: 1, id: "a", amount: 40, reason: "leave" });
});

test("void: every player's own chips in the pot go back, then the table closes and everyone is cashed out (§4.2 VOID)", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.p("p1", "raise", { to: 8 });
    H.p("p2", "call");
    const rec0 = H.T;
    H.do({ do: "void", reason: "drain" }, { system: true });
    assert.deepEqual(H.fx, [
        { t: "void", hand: 1, refunds: { p1: 8, p2: 8, p3: 2 } },
        { t: "cashout", seat: 1, id: "p1", amount: 50, reason: "close" },
        { t: "cashout", seat: 2, id: "p2", amount: 50, reason: "close" },
        { t: "cashout", seat: 3, id: "p3", amount: 50, reason: "close" },
        { t: "table-end", summary: { hands: 0, net: {}, biggest: 0 } },
        { t: "closed", reason: "drain" },
    ]);
    assert.equal(H.T.status, "closed");
    assert.equal(handRecord(H.T).disposition, "voided");
    assert.equal(H.view("p1").hand, null);
    assert.notEqual(rec0, H.T);
    H.do({ do: "sit", by: "p9", chips: 3 }, { expect: "phase" });
    H.do({ do: "deal", by: "p1" }, { expect: "phase" });
    // between hands a void just closes
    const G = harness([["a", 9], ["b", 9]]);
    G.do({ do: "void" }, { system: true });
    assert.deepEqual(G.fx.map((e) => e.t), ["cashout", "cashout", "table-end", "closed"]);
});

test("close: the host's close waits for the hand to end; between hands it is at once; an empty table closes after 10 minutes", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.do({ do: "close", by: "p2" }, { expect: "host-only" });
    H.do({ do: "close", by: "p1" });
    assert.equal(H.T.status, "hand");
    assert.deepEqual(H.fx, []);
    H.p("p1", "fold");
    assert.deepEqual(H.fx.map((e) => e.t), ["settle", "cashout", "cashout", "table-end", "post", "closed"]);
    assert.deepEqual(H.fx.find((e) => e.t === "table-end").summary, { hands: 1, net: { p1: -1, p2: 1 }, biggest: 2 }, "the uncalled 1 isn't pot");
    assert.equal(H.T.closed.reason, "host");
    const G = harness([["a", 9], ["b", 9]]);
    G.do({ do: "close", by: "a" });
    assert.deepEqual(G.fx.map((e) => e.t), ["cashout", "cashout", "table-end", "closed"], "no hands: no summary card");
    const E = harness([["a", 9]]);
    E.do({ do: "leave", by: "a" });
    const t0 = E.now;
    assert.equal(nextWake(E.T), t0 + HOLDEM.EMPTY_CLOSE_MS);
    E.tick(t0 + HOLDEM.EMPTY_CLOSE_MS - 1);
    assert.equal(E.T.status, "lobby");
    E.tick(t0 + HOLDEM.EMPTY_CLOSE_MS);
    assert.equal(E.T.status, "closed");
    assert.equal(E.T.closed.reason, "empty");
});

test("the host leaving passes the role to the longest-seated player; kick is a leave, between hands only", () => {
    const K = harness([["a", 50], ["b", 50]]);
    K.do({ do: "deal", by: "a" });
    K.p("a", "raise", { to: 10 });
    K.do({ do: "kick", by: "a", target: "b" }, { expect: "phase" }); // a kick mid-hand would force b to fold
    K.do({ do: "sit", by: "c", chips: 5 });
    K.do({ do: "kick", by: "a", target: "c" }, { expect: "phase" });
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "leave", by: "p1" });
    assert.equal(H.T.host, "p2");
    H.do({ do: "kick", by: "p2", target: "p3" });
    assert.deepEqual(H.fx, [{ t: "cashout", seat: 3, id: "p3", amount: 50, reason: "kick" }]);
    assert.equal(H.view("p2").host, "p2");
});

test("busted: stack 0 → 'out of chips', not dealt in; chips arriving (a credit) deal them in again", () => {
    const H = harness([["p1", 50], ["p2", 2], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" }); // button 1, p2 SB (1), p3 BB
    H.rig({ 1: ["2c", "3d"], 2: ["7c", "2d"], 3: ["As", "Ad"] }, ["Kh", "Qs", "9c", "8d", "4h"]);
    H.p("p1", "fold");
    H.p("p2", "allin"); // 1 more = all in for 2, only a call: the big blind already matches it, nobody can bet
    assert.equal(H.T.status, "pause", "the lone player with chips has nothing to act on: the board runs out");
    assert.equal(H.T.seats[2].stack, 0);
    assert.equal(H.view(null).seats.find((s) => s.seat === 2).state, "allin", "during the pause: as the hand ended");
    H.tick(H.now + HOLDEM.PAUSE_MS);
    assert.deepEqual(H.T.hand.order, [1, 3]);
    assert.equal(H.view(null).seats.find((s) => s.seat === 2).state, "out", "the next hand: out of chips, dealt out");
    H.do({ do: "credit", target: "p2", amount: 5 }, { system: true }); // not dealt in: straight onto the stack
    assert.equal(H.T.seats[2].stack, 5);
    const p1Stack = H.T.seats[1].stack;
    H.do({ do: "credit", target: "p1", amount: 4 }, { system: true }); // dealt in: held until the hand ends
    assert.equal(H.T.seats[1].pending, 4, "chips earned during a hand join the stack before the next one");
    assert.equal(H.view(null).seats.find((s) => s.seat === 1).stack, p1Stack, "not in play this hand");
    const folder = H.toAct();
    H.p(folder, "fold");
    assert.equal(H.T.seats[1].pending, 0);
    assert.ok(H.T.seats[1].stack >= p1Stack + 4);
    H.tick(H.now + HOLDEM.PAUSE_MS);
    assert.deepEqual(H.T.hand.order, [1, 2, 3]);
});

test("not enough players with chips: the pause falls back to the lobby; the host's Deal is refused; can_deal tells the host", () => {
    const H = harness([["p1", 50], ["p2", 2]]);
    H.do({ do: "deal", by: "p1" }); // p1 button/SB, p2 BB all-in for 2
    H.rig({ 1: ["As", "Ad"], 2: ["Kc", "Kd"] }, ["2h", "7s", "9c", "Jd", "3h"]);
    assert.deepEqual(H.view("p1").you.legal, { fold: true, check: false, call: 1, raise: null }, "nobody left to raise against");
    H.p("p1", "call");
    assert.equal(H.T.status, "pause");
    assert.deepEqual(H.fx.find((e) => e.t === "settle").to, { p1: 4, p2: 0 });
    H.tick(H.now + HOLDEM.PAUSE_MS);
    assert.equal(H.T.status, "lobby");
    H.do({ do: "deal", by: "p1" }, { expect: "bad-action" });
    assert.equal(H.view("p1").you.can_deal, false);
    assert.equal(H.view("p2").you.can_deal, undefined, "only the host gets can_deal");
    H.do({ do: "credit", target: "p2", amount: 3 }, { system: true });
    assert.equal(H.view("p1").you.can_deal, true);
    H.do({ do: "deal", by: "p1" });
    assert.equal(H.T.hand.n, 2);
});

test("blinds all-in heads-up: uncalled chips go back before the pot is made", () => {
    const H = harness([["p1", 1], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" }); // p1 button/SB posts 1 all-in, p2 BB posts 2: nothing to act on, the board runs out
    assert.equal(H.T.status, "pause");
    const settle = H.fx.find((e) => e.t === "settle");
    assert.deepEqual(settle.from, { p1: 1, p2: 2 });
    assert.equal(settle.to.p1 + settle.to.p2, 3);
    assert.ok(settle.to.p2 >= 1, "the 1 nobody called goes back to the big blind");
    assert.equal(H.T.hand.board.length, 5);
});

test("a player who sits during a hand waits (waiting) and is dealt in at the next one without posting", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.do({ do: "sit", by: "p3", chips: 20 });
    const row = H.view(null).seats.find((s) => s.u === "p3");
    assert.equal(row.waiting, true);
    assert.equal(row.cards, 0);
    assert.deepEqual(H.view("p3").you.cards, []);
    H.p("p1", "fold");
    H.tick(H.now + HOLDEM.PAUSE_MS);
    assert.ok(H.T.hand.order.includes(3));
});

test("views: §4.3 shape; the player to act gets legal moves (raise TO totals), others get null; nobody sees anyone else's cards", () => {
    const H = harness([["p1", 40], ["p4", 40]], { seats: 8 });
    H.do({ do: "deal", by: "p1" });
    const v = H.view("p1");
    assert.deepEqual(Object.keys(v).sort(), ["game", "hand", "host", "opts", "seats", "space", "status", "you"]);
    assert.deepEqual(v.opts, { sb: 1, bb: 2, seats: 8, turn_s: 30 });
    assert.deepEqual(Object.keys(v.hand).sort(), ["blinds", "board", "button", "last", "n", "pots", "street", "to_act", "total"]);
    assert.deepEqual(v.hand.to_act, { seat: 1, turn: 1, deadline: NOW + 30_000 });
    assert.deepEqual(v.you.legal, { fold: true, check: false, call: 1, raise: { min: 4, max: 40 } });
    assert.equal(v.you.cards.length, 2);
    assert.deepEqual(v.seats.map((s) => [s.seat, s.stack, s.bet, s.state, s.cards]), [[1, 39, 1, "active", 2], [2, 38, 2, "active", 2]]);
    const o = H.view("p4");
    assert.equal(o.you.legal, null);
    for (const c of v.you.cards) assert.ok(!JSON.stringify(o).includes(`"${c}"`));
    const spec = H.view(null);
    assert.equal(spec.you, undefined);
    for (const c of [...v.you.cards, ...o.you.cards]) assert.ok(!JSON.stringify(spec).includes(`"${c}"`));
    assert.ok(!JSON.stringify(spec).includes("deck"));
    // pots show the chips of finished streets; this street's bets sit in front of the players
    H.p("p1", "call"); H.p("p4", "check");
    assert.deepEqual(H.view(null).hand.pots, [{ amount: 4, eligible: [1, 2] }]);
    assert.equal(H.view(null).hand.total, 4);
});

test("hand history: your own cards, public actions and shown cards; nothing for someone who wasn't dealt in", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.rig({ 1: ["As", "Ad"], 2: ["Kc", "Kd"], 3: ["7h", "2s"] }, ["2h", "7s", "9c", "Jd", "3h"]);
    H.p("p1", "call"); H.p("p2", "call"); H.p("p3", "fold");
    for (let i = 0; i < 3; i++) { H.p("p2", "check"); H.p("p1", "check"); }
    const rec = handRecord(H.T);
    assert.equal(rec.deck.length, 52, "the server's log keeps the deck (30 days)");
    const mine = historyFor(rec, "p3");
    assert.deepEqual(mine.you, { seat: 3, cards: ["7h", "2s"] });
    assert.deepEqual(mine.shown, { 1: ["As", "Ad"], 2: ["Kc", "Kd"] });
    const json = JSON.stringify(historyFor(rec, "p1"));
    assert.ok(!json.includes('"7h"') && !json.includes('"2s"'), "a folded hand stays private");
    assert.ok(!json.includes("deck"));
    assert.equal(historyFor(rec, "nobody"), null);
});

test("side pot through the table: a three-way all-in pays the main pot and the side pot to different players", () => {
    const H = harness([["p1", 10], ["p2", 30], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" }); // button 1, p2 SB, p3 BB, p1 first
    H.rig({ 1: ["As", "Ad"], 2: ["Kc", "Kd"], 3: ["Qc", "Qd"] }, ["2h", "7s", "9c", "Jd", "3h"]);
    H.p("p1", "allin");
    H.p("p2", "allin");
    H.p("p3", "call");
    assert.equal(H.T.status, "pause");
    const settle = H.fx.find((e) => e.t === "settle");
    assert.deepEqual(settle, { t: "settle", hand: 1, from: { p1: 10, p2: 30, p3: 30 }, to: { p1: 30, p2: 40, p3: 0 } });
    assert.deepEqual(H.view(null).hand.pots.map((p) => [p.amount, p.winners]), [[30, [1]], [40, [2]]]);
});

test("the dealer's shuffle: Fisher–Yates over the CSPRNG by default, uniform (every order of 3 cards equally likely)", () => {
    const d = shuffledDeck();
    assert.equal(d.length, 52);
    assert.deepEqual([...d].sort(), freshDeck().sort());
    const R = seededInt(7);
    const counts = new Map();
    const N = 60_000;
    for (let i = 0; i < N; i++) {
        const k = shuffle(["a", "b", "c"], R).join("");
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    assert.equal(counts.size, 6);
    for (const v of counts.values()) assert.ok(Math.abs(v - N / 6) < N * 0.012, `skewed: ${[...counts]}`);
    assert.throws(() => shuffle([1, 2, 3], () => 5), RangeError);
});

function seededInt(seed) {
    let a = seed >>> 0;
    return (min, max) => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min));
    };
}

test("space (rev 2): a sit naming another space is refused space-changed before any debit", () => {
    const H = harness([["p1", 50]]);
    H.do({ do: "sit", by: "p2", chips: 20, space: "sid-2" }, { expect: "space-changed" });
    H.do({ do: "sit", by: "p2", chips: 20, space: undefined }, { expect: "space-changed" });
    H.do({ do: "sit", by: "p2", chips: 20, space: SP });
    assert.equal(H.view(null).space, SP);
});

test("space (rev 2): the admission check fails at a hand start → no hand, the table closes, everyone is cashed out", () => {
    const H = harness([["p1", 50], ["p2", 30]]);
    H.admit = false;
    H.do({ do: "deal", by: "p1" });
    assert.deepEqual(H.fx, [
        { t: "cashout", seat: 1, id: "p1", amount: 50, reason: "close" },
        { t: "cashout", seat: 2, id: "p2", amount: 30, reason: "close" },
        { t: "table-end", summary: { hands: 0, net: {}, biggest: 0 } },
        { t: "closed", reason: "space-changed" },
    ]);
    assert.equal(H.T.status, "closed");
    assert.equal(H.T.n, 0, "no hand was dealt");
    // the same at the automatic deal after a pause
    const G = harness([["a", 50], ["b", 50]]);
    G.do({ do: "deal", by: "a" });
    G.p("a", "fold");
    G.admit = false;
    G.tick(G.now + HOLDEM.PAUSE_MS);
    assert.equal(G.T.status, "closed");
    assert.equal(G.T.n, 1);
});

test("space (rev 2): a change seen mid-hand finishes the hand (settled into the table's space), then closes", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.do({ do: "close", reason: "space-changed" }, { system: true });
    assert.equal(H.T.status, "hand");
    H.p("p1", "call");
    H.p("p2", "raise", { to: 6 });
    H.p("p1", "fold");
    assert.deepEqual(H.fx.map((e) => e.t), ["settle", "cashout", "cashout", "table-end", "post", "closed"]);
    assert.equal(H.T.closed.reason, "space-changed");
});

test("a hand never starts without the admission check: wouldDeal names every move that deals, and a deal without ctx.admitted throws", () => {
    let T = createTable({ host: "a", space: SP, now: NOW });
    for (const [id, chips] of [["a", 10], ["b", 10]]) T = move(T, { do: "sit", by: id, chips, space: SP }, { now: NOW }).state;
    assert.equal(wouldDeal(T, { do: "deal", by: "b" }, NOW), false, "not the host");
    assert.equal(wouldDeal(T, { do: "deal", by: "a" }, NOW), true);
    assert.throws(() => move(T, { do: "deal", by: "a" }, { now: NOW }), /admission/);
    T = move(T, { do: "deal", by: "a" }, { now: NOW, admitted: true, randomInt: ZERO }).state;
    T = move(T, { do: "fold", by: "a", at: { hand: 1, turn: 1 } }, { now: NOW }).state;
    assert.equal(wouldDeal(T, { do: "tick" }, NOW + HOLDEM.PAUSE_MS - 1), false);
    assert.equal(wouldDeal(T, { do: "tick" }, NOW + HOLDEM.PAUSE_MS), true);
    assert.throws(() => move(T, { do: "tick" }, { now: NOW + HOLDEM.PAUSE_MS, system: true }), /admission/);
});

test("heads-up, a big blind all-in for less: the small blind still owes the full big blind (call or fold)", () => {
    const H = harness([["p1", 50], ["p2", 1]]);
    H.do({ do: "deal", by: "p1" }); // p1 button/SB posts 1, p2 BB all-in for 1
    assert.equal(H.T.status, "hand");
    assert.equal(H.toAct(), "p1");
    assert.deepEqual(H.view("p1").you.legal, { fold: true, check: false, call: 1, raise: null });
    H.p("p1", "fold");
    assert.deepEqual(H.fx.find((e) => e.t === "settle"), { t: "settle", hand: 1, from: { p1: 1, p2: 1 }, to: { p1: 0, p2: 2 } });
    const G = harness([["p1", 50], ["p2", 1]]);
    G.do({ do: "deal", by: "p1" });
    G.rig({ 1: ["As", "Ad"], 2: ["Kc", "Kd"] }, ["2h", "7s", "9c", "Jd", "3h"]);
    G.p("p1", "call");
    assert.deepEqual(G.fx.find((e) => e.t === "settle"), { t: "settle", hand: 1, from: { p1: 2, p2: 1 }, to: { p1: 3, p2: 0 } }, "the uncalled 1 goes back");
});

test("space (rev 2): an explicit failed admission check closes the table even when no hand could start", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "away", by: "p2", on: true });
    const r = move(H.T, { do: "deal", by: "p1" }, { now: H.now, admitted: false });
    assert.ok(r.ok);
    assert.equal(r.state.status, "closed");
    assert.equal(r.state.closed.reason, "space-changed");
});

test("a move that arrives once its turn's deadline has passed is stale: the timer acts first", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    const at = H.at();
    H.now = H.T.hand.deadline;
    H.do({ do: "call", by: "p1", at }, { expect: "stale" });
    H.tick();
    assert.equal(H.T.hand.log.at(-1).timeout, true);
});

test("engine view: waiting = seated, active and not in the hand on show (the lobby too); away and out never read waiting", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50], ["p4", 1]]);
    assert.deepEqual(H.view(null).seats.map((s) => s.waiting === true), [true, true, true, true], "lobby: nobody dealt yet");
    H.do({ do: "away", by: "p3", on: true });
    H.do({ do: "deal", by: "p1" }); // p1 button, p2 SB, p4 BB all-in for 1
    const during = H.view(null).seats;
    assert.deepEqual(during.map((s) => [s.seat, s.state, !!s.waiting]), [[1, "active", false], [2, "active", false], [3, "away", false], [4, "allin", false]]);
    H.do({ do: "sit", by: "p5", chips: 9 });
    assert.equal(H.view(null).seats.find((s) => s.seat === 5).waiting, true);
    while (H.T.status === "hand") H.p(H.toAct(), "fold");
    const pause = H.view(null).seats;
    assert.equal(pause.find((s) => s.seat === 5).waiting, true, "the pause: not in the hand on show");
    assert.equal(!!pause.find((s) => s.seat === 3).waiting, false, "away stays away");
    assert.equal(!!pause.find((s) => s.seat === 1).waiting, false, "dealt in: as the hand ended");
});

test("engine view: a leaver's showdown cards stay in the result after their seat is gone", () => {
    const G = harness([["a", 20], ["b", 20]]);
    G.do({ do: "deal", by: "a" });
    G.rig({ 1: ["As", "Ad"], 2: ["Kc", "Kd"] }, ["2h", "7s", "9c", "Jd", "3h"]);
    G.p("a", "allin");
    G.do({ do: "leave", by: "a" });
    G.p("b", "call");
    const v = G.view(null);
    assert.equal(v.seats.some((s) => s.seat === 1), false, "a is cashed out");
    assert.deepEqual(v.hand.result.shown, { 1: ["As", "Ad"], 2: ["Kc", "Kd"] });
    assert.equal(v.hand.result.best[1].category, "pair");
});

test("engine view: last action — a stake only where one was named; a timer's action reads timeout", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.p("p1", "call");
    assert.deepEqual(H.T.hand.last, { seat: 1, a: "call", to: 2 });
    H.p("p2", "check"); // → the flop: p2 first
    H.p("p2", "check");
    assert.deepEqual(H.T.hand.last, { seat: 2, a: "check" });
    H.tick(H.T.hand.deadline); // p1's timer checks behind
    assert.equal(H.T.hand.street, "turn");
    assert.equal(H.T.hand.last, null, "a new street");
    H.p("p2", "raise", { to: 6 });
    assert.deepEqual(H.T.hand.last, { seat: 2, a: "bet", to: 6 });
    H.tick(H.T.hand.deadline); // p1 times out facing a bet: folds, the hand ends and keeps its last action
    assert.deepEqual(H.T.hand.last, { seat: 1, a: "timeout" });
    assert.equal(H.T.hand.log.at(-1).a, "fold", "the log keeps what the timer did");
});

test("a void after the host's close: the table closes with the void's reason (the restart line), not the host's", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.do({ do: "close", by: "p1" });
    H.do({ do: "void", reason: "restart" }, { system: true });
    assert.equal(H.T.closed.reason, "restart");
    assert.equal(H.fx.at(-1).reason, "restart");
});
