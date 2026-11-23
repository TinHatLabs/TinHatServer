// games-s2, polish round 2: B10 away players (addendum v1.1 §8.1), rule by rule on the Hold'em table engine with
// rigged cards. Each test names its rule; written failing-first against 0.3.20's engine (two timeouts, no instant act,
// no gone, no hand-count stand-up, no away object).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable, move, viewFor, nextWake, wouldDeal, HOLDEM } from "../play/holdem-table.mjs";
import { freshDeck } from "../play/holdem-cards.mjs";
import { Ledger, checkState } from "./play-holdem-sim.mjs";

const NOW = 1_763_600_000_000;
const ZERO = () => 0;
const SP = "sid-1";
const K = { AFTER: HOLDEM.AWAY_AFTER_TIMEOUTS ?? 1, HANDS: HOLDEM.AWAY_STAND_HANDS ?? 6, MS: HOLDEM.AWAY_STAND_MS ?? 600_000 };

function harness(players) {
    const H = { now: NOW, L: new Ledger(), fx: [], gone: new Set(), T: createTable({ host: players[0][0], space: SP, opts: { seats: 8 }, now: NOW }) };
    H.do = (m, { system = false, expect = true } = {}) => {
        if (m.do === "sit" && !("space" in m)) m = { ...m, space: SP };
        const admitted = wouldDeal(H.T, m, H.now) ? true : undefined;
        const r = move(H.T, m, { now: H.now, randomInt: ZERO, system, admitted: admitted ?? (m.do === "tick" || m.do === "deal" ? true : undefined), gone: H.gone });
        if (expect === true) assert.ok(r.ok, `${JSON.stringify(m)} refused: ${r.code}`);
        else { assert.equal(r.ok, false); assert.equal(r.code, expect); return r; }
        H.L.apply(r.effects); H.T = r.state; H.fx = r.effects; checkState(H.T, H.L);
        return r;
    };
    H.at = () => ({ hand: H.T.hand.n, turn: H.T.hand.turn });
    H.p = (by, d, extra = {}) => H.do({ do: d, by, at: H.at(), ...extra });
    H.toAct = () => H.T.seats[H.T.hand.b.toAct].id;
    H.tick = (t) => { if (t !== undefined) H.now = t; return H.do({ do: "tick" }, { system: true }); };
    H.next = () => H.tick(H.now + HOLDEM.PAUSE_MS); // the pause after a hand → the next deal
    H.rig = (holes, board) => {
        const used = new Set([...Object.values(holes).flat(), ...board]);
        H.T.hand.holes = structuredClone(holes);
        H.T.hand.deck = [...board, ...freshDeck().filter((c) => !used.has(c))];
    };
    H.seatOf = (id) => Number(Object.keys(H.T.seats).find((s) => H.T.seats[s].id === id));
    H.view = (viewer) => viewFor(H.T, { viewer });
    H.foldOut = () => { for (let i = 0; i < 20 && H.T.status === "hand"; i++) H.p(H.toAct(), "fold"); }; // everyone folds to the last
    for (const [i, [id, chips]] of players.entries()) H.do({ do: "sit", by: id, chips, seat: i + 1 });
    return H;
}

test("one timeout → away from the NEXT hand (reason timeout): dealt out, no blind taken", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" }); // button 1, SB 2, BB 3; p1 first
    H.tick(H.T.hand.deadline);
    assert.equal(H.T.hand.log.at(-1).a, "fold");
    assert.equal(H.T.seats[1].away, true, "one timeout is enough");
    assert.deepEqual(H.view(null).seats.find((s) => s.seat === 1).away, { reason: "timeout", since: H.now, stand_at: H.now + K.MS, hands_left: K.HANDS });
    H.foldOut();
    H.next();
    assert.deepEqual(H.T.hand.order, [2, 3], "dealt out of the next hand");
    assert.ok(!H.fx.some((e) => e.t === "bet" && e.id === "p1"), "no blind from an away seat");
    assert.equal(H.view("p1").seats.find((s) => s.seat === 1).state, "away");
    assert.equal(H.view("p1").you.away.reason, "timeout");
    assert.equal(H.view("p1").you.away.hands_left, K.HANDS - 1);
});

test("the instant act: after a timeout, the same player's later turns in this hand are acted at once (no 30 s wait)", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" }); // heads-up: button 1 = SB acts first preflop
    H.p("p1", "call");
    H.tick(H.T.hand.deadline); // p2 (BB) times out: checks (free) → away pending; flop: p2 acts first
    assert.equal(H.T.hand.street, "flop");
    assert.equal(H.toAct(), "p2");
    assert.equal(H.T.hand.deadline, H.now, "p2's next turn is due at once");
    H.tick(H.now); // the timer acts: check (free)
    assert.equal(H.T.hand.log.at(-1).seat, 2); assert.equal(H.T.hand.log.at(-1).a, "check");
    assert.equal(H.toAct(), "p1");
    assert.equal(H.T.hand.deadline, H.now + 30_000, "a present player keeps the normal timer");
});

test("a timed-out check still wins the pot: away never changes who can win the current hand; its state stays in-hand", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.rig({ 1: ["2c", "7d"], 2: ["As", "Ah"] }, ["Kc", "9d", "4s", "Jh", "3c"]);
    H.p("p1", "call");
    H.tick(H.T.hand.deadline); // p2 checks on timeout → away pending
    assert.equal(H.view(null).seats.find((s) => s.seat === 2).state, "active", "still in the hand: active, not away");
    for (let i = 0; i < 12 && H.T.status === "hand"; i++) { if (H.toAct() === "p2") H.tick(H.T.hand.deadline); else H.p("p1", "check"); }
    assert.equal(H.T.status, "pause");
    assert.deepEqual(H.T.hand.result.pots[0].winners, [2], "the away-pending player's aces win");
    assert.equal(H.T.seats[2].stack, 52);
});

test("I'm back (away off): dealt in at the next hand without posting a missed blind; the counter resets", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "away", by: "p3", on: true });
    H.do({ do: "deal", by: "p1" });
    assert.deepEqual(H.T.hand.order, [1, 2]);
    H.do({ do: "away", by: "p3", on: false });
    assert.equal(H.view("p3").you.away, null);
    H.foldOut(); H.next();
    assert.deepEqual(H.T.hand.order, [1, 2, 3], "back in");
    const posts = H.fx.filter((e) => e.t === "bet");
    assert.deepEqual(posts.map((e) => e.a).sort(), ["bb", "sb"], "only the two blinds of this hand");
    assert.ok(posts.every((e) => e.seat === H.T.hand.b.sbSeat || e.seat === H.T.hand.b.bbSeat));
});

test("away off racing the instant act: the I'm back that commits first wins; the turn gets the normal timer", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.p("p1", "call");
    H.tick(H.T.hand.deadline); // p2 away pending; flop: p2's turn due at once
    assert.equal(H.T.hand.deadline, H.now);
    H.do({ do: "away", by: "p2", on: false }); // commits before the timer move
    assert.equal(H.T.hand.deadline, H.now + 30_000, "the normal timer back");
    const before = H.T.hand.log.length;
    H.tick(H.now); // the instant act finds the deadline moved: nothing
    assert.equal(H.T.hand.log.length, before);
    H.p("p2", "check"); // and p2 plays it themself
    assert.equal(H.T.seats[2].away, false);
});

test("asking to sit out on top of an automatic away keeps the seat away (reason asked)", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" }); // p1 first
    H.tick(H.T.hand.deadline); // p1 folds on timeout → away
    assert.equal(H.T.seats[1].away, true);
    H.foldOut(); H.next(); // p1 dealt out
    H.do({ do: "away", by: "p1", on: true }); // asked on top: still away (now reason asked)
    assert.equal(H.T.seats[1].away, true);
    assert.equal(H.view(null).seats.find((s) => s.seat === 1).away.reason, "asked");
});

test(`away for ${K.HANDS} dealt-out hands → stand up (cash-out reason away, the exact stack, chips kept)`, () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 37]]);
    H.do({ do: "away", by: "p3", on: true });
    H.do({ do: "deal", by: "p1" });
    for (let n = 1; n < K.HANDS; n++) { assert.ok(H.T.seats[3], `still seated after ${n}`); assert.equal(H.view(null).seats.find((s) => s.seat === 3).away.hands_left, K.HANDS - n); H.foldOut(); H.next(); }
    assert.equal(H.T.seats[3], undefined, `stood up at the ${K.HANDS}th dealt-out hand`);
    const co = H.fx.find((e) => e.t === "cashout");
    assert.deepEqual(co, { t: "cashout", seat: 3, id: "p3", amount: 37, reason: "away" });
});

test("the 10-minute clock fires first when hands are slow; a stand-up while all-in waits for the settle", () => {
    const H = harness([["p1", 10], ["p2", 50], ["p3", 50], ["p4", 50]]);
    H.do({ do: "deal", by: "p1" }); // button 1, SB 2, BB 3; p4 first
    H.rig({ 1: ["As", "Ad"], 2: ["7c", "2d"], 3: ["8h", "3s"], 4: ["9c", "4h"] }, ["Kc", "9d", "4s", "Jh", "5c"]);
    H.p("p4", "call");
    H.p("p1", "allin");
    H.do({ do: "away", by: "p1", on: true });
    const since = H.now;
    H.p("p2", "call");
    H.p("p3", "call");
    assert.equal(H.toAct(), "p4");
    H.now = since + K.MS; // 10 minutes pass with p4 to act: p4's timer and p1's stand-up in the same tick
    H.tick();
    assert.ok(H.T.seats[1], "all-in: not removed mid-hand");
    assert.equal(H.T.seats[1].leaving, true, "stands up at the end of this hand");
    assert.ok(!H.fx.some((e) => e.t === "cashout" && e.id === "p1"));
    for (let i = 0; i < 20 && H.T.status === "hand"; i++) { if (H.T.hand.deadline <= H.now) H.tick(); else H.p(H.toAct(), "check"); }
    const co = H.fx.find((e) => e.t === "cashout" && e.id === "p1");
    assert.ok(co, "cashed out after the settle");
    assert.equal(co.reason, "away");
    assert.ok(co.amount > 10, "with the pot the aces won");
});

test("gone at a deal: a seated player with no socket for GONE_MS is dealt out (reason gone); back = dealt in", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.gone = new Set(["p2"]);
    H.do({ do: "deal", by: "p1" });
    assert.deepEqual(H.T.hand.order, [1, 3], "p2 dealt out");
    assert.equal(H.view(null).seats.find((s) => s.seat === 2).away.reason, "gone");
    assert.equal(HOLDEM.GONE_MS, 20_000);
    H.gone = new Set();
    H.do({ do: "away", by: "p2", on: false });
    H.foldOut(); H.next();
    assert.deepEqual(H.T.hand.order, [1, 2, 3]);
});

test("three players, one away → heads-up order (the button posts the small blind); the button anchors on its seat", () => {
    const H = harness([["p1", 50], ["p2", 50], ["p3", 50]]);
    H.do({ do: "deal", by: "p1" }); // button 1
    H.do({ do: "away", by: "p2", on: true }); // p2 (SB this hand) asks out for the next
    H.foldOut(); H.next(); // the button moves clockwise from seat 1 to the next eligible: seat 3
    assert.deepEqual(H.T.hand.order, [1, 3]);
    assert.equal(H.T.hand.button, 3);
    assert.equal(H.T.hand.b.sbSeat, 3, "heads-up: the button posts the small blind");
});

test("fewer than two eligible: no hand starts (the table waits, nobody posts)", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.do({ do: "away", by: "p2", on: true });
    H.foldOut(); H.next();
    assert.equal(H.T.status, "lobby");
    assert.equal(H.T.hand.n, 1);
    assert.ok(!H.fx.some((e) => e.t === "bet"));
});

test("an own game move that commits before the pending instant act wins it and clears the automatic away (§8.1)", () => {
    const H = harness([["p1", 50], ["p2", 50]]);
    H.do({ do: "deal", by: "p1" });
    H.p("p1", "call");
    H.tick(H.T.hand.deadline); // p2 away pending; flop: p2's turn due at once
    assert.equal(H.T.hand.deadline, H.now);
    H.p("p2", "check"); // the player's own move arrives first
    assert.equal(H.T.seats[2].away, false, "back");
    assert.equal(H.T.hand.log.at(-1).timeout, undefined, "their move, not the timer's");
    // a NORMAL expired turn still goes to the timer first
    H.now = H.T.hand.deadline;
    H.do({ do: "check", by: "p1", at: H.at() }, { expect: "stale" });
});
