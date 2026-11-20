// The Rig's table/round engine (play/rig.mjs) driven through whole rounds by a fake platform: a tiny in-memory ledger
// that carries out the engine's effects (escrow, settle, void) and checks the money rules after every step (supply
// conserved, no wallet below 0, every settle balances). Plus the privacy rule: nothing another player keeps secret
// may change what YOUR view says before the reveal (a non-interference check: scramble everyone else's secrets in
// the state, your view must stay byte-identical). RIG_ENGINE_DIR (tests only): see play-rig-vectors.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { E, R, G, U, platform, skipSetup, spin, rng, pickOf, randomMove, scramble, wireOf } from "./play-rig-harness.mjs";

test("lobby → start: round 1 is Lite whatever the host picked; Spinner = seat 1; Mechanics; escrows; seed commit", () => {
    const H = platform(5);
    H.refuse(H.people[1], { do: "start" }, "host-only");
    H.must(H.people[0], { do: "start", preset: "full", bankroll: 8, patch: true });
    const R0 = H.R();
    assert.equal(R0.preset, "lite");
    assert.equal(R0.spinner, H.people[0]);
    assert.deepEqual(R0.mechanics, [H.people[1], H.people[2]], "2 live cards in Lite, the first House seats after the Spinner");
    assert.equal(R0.bankroll, 8);
    assert.equal(R0.commit, createHash("sha256").update(Buffer.from(R0.seed, "hex")).digest("hex"));
    const esc = H.log.filter((e) => e.k === "escrow").map((e) => [e.who, e.amount, e.kind]);
    assert.deepEqual(esc, [[H.people[0], 8, "bankroll"], [H.people[1], 3, "stake"], [H.people[2], 3, "stake"]]);
    const v = H.view(H.people[1]);
    assert.equal(v.round.phase, "setup");
    assert.equal(v.you.role, "mechanic");
    assert.equal(v.you.deal.length, 2);
    assert.equal(v.round.dead.length, 4, "Lite shows 4 dead cards");
    assert.equal(H.view(H.people[0]).you.deal, undefined, "the Spinner sees no deal");
    assert.equal(H.view(H.people[3]).you.role, "sharp");
});

test("`at` in SETUP: the contract's spin 0 and the engine's spin 1 both name it; anything else is stale", () => {
    const H = platform(4, 20, "atsetup");
    H.must(H.people[0], { do: "start" });
    const M = H.R().mechanics[0], r = H.R().r;
    H.refuse(M, { do: "keep", card: H.R().deals[M][0], at: { round: r, spin: 2, phase: "setup" } }, "stale");
    H.refuse(M, { do: "keep", card: H.R().deals[M][0], at: { round: r, spin: 0, phase: "turn" } }, "stale");
    H.must(M, { do: "keep", card: H.R().deals[M][0], at: { round: r, spin: 0, phase: "setup" } });
    skipSetup(H);
    H.refuse(H.R().spinner, { do: "spin", bet: 1, at: { round: r, spin: 0, phase: "turn" } }, "stale");
});

test("SETUP ends early once every Mechanic kept and every House member bet or passed; the deal is from the seed", () => {
    const H = platform(4);
    H.must(H.people[0], { do: "start" });
    const R0 = H.R();
    const deal = E.dealFor(Buffer.from(R0.seed, "hex"), R.PRESETS.lite, 2);
    assert.deepEqual(R0.dead, deal.dead);
    assert.deepEqual(R0.deals[R0.mechanics[0]], deal.hands[0]);
    const [m1, m2] = R0.mechanics;
    const sharp = R0.house.find((u) => !R0.mechanics.includes(u));
    H.refuse(m1, { do: "keep", card: "not-a-card" }, "bad");
    H.must(m1, { do: "keep", card: R0.deals[m1][1] });
    H.refuse(m1, { do: "keep", card: R0.deals[m1][0] }, "limit");
    H.must(m2, { do: "keep", card: R0.deals[m2][0] });
    H.refuse(sharp, { do: "market", side: "up", stake: 3 }, "bad-amount");
    H.must(sharp, { do: "market", side: "up", stake: 2 });
    H.must(m1, { do: "market", side: "not-up", stake: 1 });
    assert.equal(H.R().phase, "setup", "m2 hasn't bet or passed yet");
    H.must(m2, { do: "market", side: "pass" });
    assert.equal(H.R().phase, "turn");
    assert.deepEqual(H.R().slots.map((s) => s.owner), deal.slots.map((m) => R0.mechanics[m]), "slot order from the seed");
    assert.equal(H.view(m1).you.card.card, R0.deals[m1][1]);
});

test("a spin resolves from the round seed exactly like resolveSpin (honest reels, re-rolls, cards in slot order)", () => {
    for (let t = 0; t < 30; t++) {
        const H = platform(4, 20, `spin${t}`);
        H.must(H.people[0], { do: "start" });
        skipSetup(H);
        for (let k = 0; k < 4 && H.R().phase === "turn"; k++) {
            const R0 = H.R(), bet = 1 + ((t + k) % 3);
            if (bet > R0.bankroll) break;
            const cards = R0.slots.filter((s) => s.busted_spin == null).sort((a, b) => a.slot - b.slot).map((s) => ({ card: s.card, owner: s.owner, muted: false }));
            const seed = Buffer.from(R0.seed, "hex");
            const honest = G.honestReels(seed, R0.spin);
            const src = G.rerollSource(seed, R0.spin);
            const draws = [...Array(8)].map(() => src.next());
            const want = R.resolveSpin({ bet, spin: R0.spin, honest, cards, draws, history: R0.history.map((h) => ({ result: h.result, reels: h.reels })) });
            const before = R0.bankroll;
            spin(H, bet);
            const h = (H.st.round || {}).history?.find((x) => x.spin === R0.spin) ?? H.log.filter((e) => e.k === "settle").at(-1).reveal.spins.find((x) => x.spin === R0.spin);
            const reels = h.reels ?? h.final;
            assert.deepEqual(reels, want.final);
            assert.equal(h.payout, want.payout);
            if (H.st.round && H.R().phase === "turn") assert.equal(H.R().bankroll, before + want.spinner_delta);
        }
    }
});

test("Calls: right → busted, stake into the bankroll, owner becomes a Sharp; wrong → −2 split over live Mechanics; caps", () => {
    const H = platform(4);
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const R0 = H.R(), S = R0.spinner;
    const [a, b] = R0.slots;
    const deadCard = R0.dead[0];
    H.refuse(S, { do: "call", card: deadCard }, "greyed");
    const wrong = R.PRESETS.lite.deck.find((c) => !R0.greyed[c] && !R0.slots.some((s) => s.card === c));
    H.must(S, { do: "call", card: wrong });
    assert.equal(H.R().bankroll, 6 - 2);
    assert.deepEqual(H.R().call_to, { [a.owner]: 1, [b.owner]: 1 }, "2 chips over 2 live Mechanics");
    H.refuse(S, { do: "call", card: a.card }, "limit"); // one per spin
    assert.equal(H.view(S).round.board.find((x) => x.card === wrong).state, "wrong");
    spin(H, 1);
    H.must(S, { do: "call", card: a.card });
    assert.equal(H.R().bankroll >= 3, true);
    const v = H.view(H.people[3]);
    assert.deepEqual(v.round.board.find((x) => x.card === a.card), { card: a.card, state: "busted", by: a.owner, spin: 2 });
    assert.equal(H.view(a.owner).you.role, "sharp");
    assert.equal(H.R().calls_left, 0, "Lite: 2 Calls a round");
    spin(H, 1);
    H.refuse(S, { do: "call", card: b.card }, "limit");
});

test("Peek bounty at the settle: one snapshot of the Mechanic's wallet + what the round pays them, never below 0", () => {
    // p1 stakes their last 3 chips; p3 Peeks p1 right; the Spinner busts p1 right away (the stake goes to the bankroll)
    const H = platform(4, (u) => (u === U(1) ? 3 : 20), "peeksnap");
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const R0 = H.R(), S = R0.spinner, M = U(1), peeker = U(3);
    assert.ok(R0.mechanics.includes(M) && !R0.mechanics.includes(peeker));
    const card = R0.slots.find((s) => s.owner === M).card;
    assert.equal(H.bal[M], 0);
    H.must(peeker, { do: "peek", mechanic: M, card });
    H.must(S, { do: "call", card });
    H.toDeadline(); // timeout 1: spins the dial (1)
    while (H.R().phase !== "turn" && H.R().phase !== "reveal") H.toDeadline();
    if (H.R().phase === "turn") H.toDeadline(); // timeout 2: forced Walk
    assert.equal(H.R().phase, "reveal");
    const settle = H.log.filter((e) => e.k === "settle").at(-1);
    assert.equal(settle.payouts[M] ?? 0, 0, "a busted Mechanic with an empty wallet pays no bounty");
    assert.equal(H.bal[M], 0);
    assert.deepEqual(settle.lines.filter((l) => l.reason === "rig:peek"), [{ who: peeker, amount: 2, reason: "rig:peek" }]);
    assert.deepEqual(settle.reveal.peeks.map((p) => [p.who, p.target, p.right, p.delta]), [[peeker, M, true, 2]]);
    // and with chips in the wallet the bounty is the full 3 (shared by the one right Peek)
    const H2 = platform(4, 20, "peeksnap");
    H2.must(H2.people[0], { do: "start" });
    skipSetup(H2);
    const c2 = H2.R().slots.find((s) => s.owner === M).card;
    H2.must(peeker, { do: "peek", mechanic: M, card: c2 });
    H2.must(H2.R().spinner, { do: "call", card: c2 });
    H2.toDeadline();
    while (H2.R().phase !== "turn" && H2.R().phase !== "reveal") H2.toDeadline();
    if (H2.R().phase === "turn") H2.toDeadline();
    const s2 = H2.log.filter((e) => e.k === "settle").at(-1);
    assert.equal(s2.payouts[M], -3, "M pays the 3-chip bounty from the wallet");
    assert.deepEqual(s2.reveal.peeks.map((p) => p.delta), [5]);
});

test("Walk only from walk_from; timeouts: the first spins the dial, the second in a row Walks", () => {
    const H = platform(4);
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const S = H.R().spinner;
    H.refuse(S, { do: "walk" }, "phase");
    H.must(S, { do: "dial", bet: 2 });
    H.toDeadline(); // timeout 1: spins 2
    while (H.R().phase !== "turn" && H.R().phase !== "reveal") H.toDeadline();
    assert.equal(H.R().history[0].bet, 2);
    if (H.R().phase === "turn") {
        H.toDeadline(); // timeout 2 in a row → forced Walk (ignores walk_from)
        assert.equal(H.R().phase, "reveal");
        assert.equal(H.R().end_reason, "timeouts");
    }
});

test("the Spinner's disconnect: the clock pauses on a 45 s budget per round, then a forced Walk", () => {
    const H = platform(4);
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const S = H.R().spinner;
    const dl = H.R().deadline;
    H.st = E.setOnline(H.st, S, false, H.ctx()).state;
    H.advance(30_000);
    assert.equal(H.R().phase, "turn", "paused, not timed out");
    H.st = E.setOnline(H.st, S, true, H.ctx()).state;
    assert.equal(H.R().deadline, dl + 30_000);
    H.st = E.setOnline(H.st, S, false, H.ctx()).state;
    H.advance(14_999);
    assert.equal(H.R().phase, "turn");
    H.advance(1);
    assert.equal(H.R().phase, "reveal");
    assert.equal(H.R().end_reason, "away");
});

test("Full round: Mute (hidden, spent), Nudge (first tap wins, stamped), Patch, Peek lock, Whisper, Audit, Market, settle", () => {
    const H = platform(5, 30, "full");
    H.must(H.people[0], { do: "start", preset: "full" });
    // round 1 is Lite: play it out quickly by walking from spin 5
    skipSetup(H);
    while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    assert.equal(H.R().phase, "reveal");
    H.toDeadline();
    const R0 = H.R();
    assert.equal(R0.preset, "full");
    assert.equal(R0.spinner, H.people[1]);
    assert.equal(R0.mechanics.length, 3);
    const S = R0.spinner;
    const sharp = R0.house.find((u) => !R0.mechanics.includes(u));
    for (const m of R0.mechanics) H.must(m, { do: "keep", card: R0.deals[m][0] });
    H.must(sharp, { do: "market", side: "up", stake: 2 });
    for (const m of R0.mechanics) H.must(m, { do: "market", side: "not-up", stake: 1 });
    assert.equal(H.R().phase, "turn");
    const [m1, m2] = H.R().slots.map((s) => s.owner);
    // Peek (2 chips), right on m1
    H.refuse(sharp, { do: "peek", mechanic: sharp, card: "skim" }, "bad");
    H.must(sharp, { do: "peek", mechanic: m1, card: H.R().slots[0].card });
    H.refuse(sharp, { do: "peek", mechanic: m2, card: "skim" }, "limit");
    // Whisper (free text rules)
    H.refuse(sharp, { do: "whisper", text: "see https://x.example" }, "bad");
    H.refuse(sharp, { do: "whisper", text: "a\u0007b" }, "bad");
    H.refuse(sharp, { do: "whisper", text: "x".repeat(61) }, "bad");
    H.must(sharp, { do: "whisper", text: "it's the moon one" });
    H.refuse(sharp, { do: "whisper", template: "trust-nobody" }, "limit");
    H.must(m2, { do: "whisper", template: "bluffing", person: m1 });
    assert.deepEqual(H.view(S).you.whispers.map((w) => w.text), ["it's the moon one", "{person} is bluffing"]);
    assert.ok(!JSON.stringify(H.view(S)).includes(`"who"`), "no authors for the Spinner");
    // Mute: armed when SPIN lands, spent, invisible to others
    H.must(m1, { do: "mute", armed: true });
    assert.equal(H.view(m1).you.armed, true);
    assert.ok(!("armed" in H.view(m2).you) || H.view(m2).you.armed === false);
    H.must(S, { do: "spin", bet: 1 });
    assert.equal(H.R().phase, "land");
    assert.equal(H.R().mutes[m1].left, 1);
    assert.deepEqual(H.R().pending.muted, [m1]);
    H.toDeadline();
    assert.equal(H.R().phase, "nudge");
    H.refuse(S, { do: "nudge", reel: 1, step: 1 }, "not-your-turn");
    H.refuse(sharp, { do: "nudge", reel: 4, step: 1 }, "bad");
    H.must(sharp, { do: "nudge", reel: 2, step: -1, at: { round: H.R().r, spin: 1, phase: "nudge" } });
    H.refuse(m2, { do: "nudge", reel: 1, step: 1, at: { round: H.R().r, spin: 1, phase: "nudge" } }, "taken");
    assert.deepEqual(H.R().history[0].stamps, ["nudged"]);
    H.refuse(sharp, { do: "nudge", reel: 1, step: 1 }, "window");
    // Audit spin 1
    H.refuse(S, { do: "audit", spin: 2 }, "bad");
    H.must(S, { do: "audit", spin: 1 });
    assert.ok(H.view(S).round.audit);
    assert.equal(H.view(m2).round.audit, undefined, "only the Spinner sees the Audit before the reveal");
    assert.ok(H.view(m2).round.history[0].stamps.includes("audited"));
    // Right Call on m2 → Patch with the returned card (if the rules allow it)
    const s2 = H.R().slots.find((s) => s.owner === m2);
    H.must(S, { do: "call", card: s2.card });
    const v2 = H.view(m2).you;
    assert.ok(v2.patch, "the busted Mechanic is offered a Patch this turn");
    const pr = H.do(m2, { do: "patch" });
    if (v2.patch.ok) {
        assert.ok(pr.ok);
        assert.deepEqual(H.R().refilled, [{ spin: 2 }]);
        assert.equal(H.view(m2).you.role, "mechanic");
        assert.equal(H.view(H.people[0]).round.refilled[0].spin, 2);
    } else assert.ok(["rules", "greyed"].includes(pr.code));
    // play on past the Peek lock (Full: after spin 4)
    while (H.R().phase === "turn" && H.R().spin <= 4) spin(H, 1);
    if (H.R().phase === "turn") {
        H.refuse(m2, { do: "peek", mechanic: m1, card: "skim" }, "locked");
        while (H.R().phase === "turn" && H.R().spin < 6) spin(H, 1);
    }
    if (H.R().phase === "turn") H.must(S, { do: "walk" });
    const R1 = H.R();
    assert.equal(R1.phase, "reveal");
    const settle = H.log.filter((e) => e.k === "settle").at(-1);
    assert.equal(settle.idem, `rig:${H.st.table}:${R1.r}:settle`);
    const rv = H.view(H.people[4]).reveal;
    assert.equal(rv.seed, R1.seed);
    assert.ok(rv.slots.length >= 3);
    assert.deepEqual(rv.mutes, [{ spin: 1, owner: m1 }]);
    assert.equal(rv.nudges[0].by, sharp);
    assert.deepEqual(rv.whispers.map((w) => w.who), [sharp, m2]);
    assert.equal(rv.peeks[0].who, sharp);
    assert.equal(rv.peeks[0].right, true);
    assert.equal(rv.market.length, 4);
    assert.equal(Object.values(rv.net).reduce((s, v) => s + v, 0), -settle.bank, "everyone's net = what the bank lost");
});

test("Railbirds (0 chips) and broke Spinners: no Market/Peek for a Railbird; a Spinner under 3 is skipped", () => {
    const H = platform(4, (u) => (u === U(2) ? 0 : u === U(1) ? 2 : 20));
    H.must(H.people[0], { do: "start" });
    let R0 = H.R();
    assert.ok(R0.railbirds.includes(U(2)));
    assert.ok(!R0.mechanics.includes(U(2)) && !R0.mechanics.includes(U(1)), "under 3 chips can't stake");
    H.refuse(U(2), { do: "market", side: "up", stake: 1 }, "not-your-turn");
    assert.equal(H.view(U(2)).you.role, "railbird");
    skipSetup(H);
    H.refuse(U(2), { do: "peek", mechanic: R0.mechanics[0], card: "skim" }, "not-your-turn");
    while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    H.toDeadline(); // next Spinner would be U(1) with 2 chips: skipped
    R0 = H.R();
    assert.equal(R0.spinner, U(2) === R0.spinner ? U(2) : U(3));
    assert.ok(H.st.skipped.includes(U(1)));
});

test("a table = one rotation: leaderboard, Pit Boss, forget-whispers, summary post; the host can start another", () => {
    const H = platform(3, 20, "rot");
    H.must(H.people[0], { do: "start" });
    for (let r = 0; r < 3; r++) {
        skipSetup(H);
        while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
        if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
        assert.equal(H.R().preset, "lite", "3 players: always Lite");
        H.toDeadline();
    }
    assert.equal(H.st.status, "end");
    assert.equal(H.ends.length, 1);
    assert.equal(H.forgot, 1);
    assert.equal(H.posts.filter((p) => p.kind === "result").length, 3);
    assert.equal(H.posts.filter((p) => p.kind === "summary").length, 1);
    const v = H.view(H.people[1]);
    assert.ok(v.table_end.leaderboard.length === 3 && v.table_end.pit_boss.length >= 1);
    H.must(H.people[0], { do: "start" });
    assert.equal(H.st.status, "round");
    assert.equal(H.R().spinner, H.people[0]);
});

test("leaving: a Spinner who leaves forces a Walk; a Mechanic who leaves keeps their card live; prestige check after settle", () => {
    const H = platform(5);
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const R0 = H.R();
    const mech = R0.mechanics[0];
    H.must(mech, { do: "leave" });
    assert.ok(H.R().slots.some((s) => s.owner === mech && s.busted_spin == null));
    assert.ok(!H.left.includes(mech), "the cash-out comes with the settle");
    H.must(R0.spinner, { do: "leave" });
    assert.equal(H.R().phase, "reveal");
    assert.equal(H.R().end_reason, "left");
    assert.deepEqual(H.left.sort(), [mech, R0.spinner].sort());
    assert.equal(H.st.host, H.people[2], "the host passes to the first seat still there (p1 left first)");
});

test("spec rev 2: bound to its space: join names it, the admission check gates every round, a change finishes the round then closes", () => {
    const H = platform(4, 20, "space");
    H.refuse("@late:lab.test", { do: "join", space: "!other:lab.test" }, "space-changed");
    H.refuse("@late:lab.test", { do: "join" }, "space-changed");
    // a change seen mid-round: the round plays out and settles (into the table's space), then the table closes
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const ch = E.spaceChanged(H.st, H.ctx());
    H.apply(ch.effects); H.st = ch.state;
    assert.equal(H.st.status, "round", "the round in progress isn't cut short");
    H.admitted = false;
    spin(H, 1);
    while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    assert.equal(H.R().phase, "reveal");
    assert.equal(H.log.filter((e) => e.k === "settle").length, 1);
    H.toDeadline();
    assert.equal(H.st.status, "closed");
    assert.equal(H.view(H.people[1]).closed_reason, "space-changed");
    assert.deepEqual([...H.left].sort(), [...H.people].sort(), "everyone cashed out");
    assert.equal(Object.keys(H.esc).length, 0);
    // the admission check failing at a round's setup: no round, the table closes, nothing escrowed
    const H2 = platform(3, 20, "space2");
    H2.admitted = false;
    H2.must(H2.people[0], { do: "start" });
    assert.equal(H2.st.status, "closed");
    assert.equal(H2.log.filter((e) => e.k === "escrow").length, 0);
    // a change with no round running closes at once
    const H3 = platform(3, 20, "space3");
    const c3 = E.spaceChanged(H3.st, H3.ctx());
    H3.apply(c3.effects);
    assert.equal(c3.state.status, "closed");
});

test("void (restart / games off): every escrow goes back, nothing else moves", () => {
    const H = platform(4);
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    spin(H, 2);
    const before = { ...H.bal };
    const r = E.voidRound(H.st, H.ctx());
    H.apply(r.effects);
    const esc = r.effects[0].refunds;
    for (const u of H.people) assert.equal(H.bal[u], before[u] + (esc[u] || 0));
});

test("hostile moves (untrusted JSON) never throw and never change anything", () => {
    const junk = [undefined, null, 0, -1, 1.5, 1e308, NaN, "", "__proto__", "constructor", "toString", "hasOwnProperty",
        [], {}, { __proto__: { x: 1 } }, "x".repeat(5000), "\u0000", true];
    const keys = ["card", "side", "stake", "bet", "spin", "armed", "reel", "step", "template", "text", "person", "mechanic", "u", "preset", "bankroll", "patch", "space", "at"];
    const r = rng(9);
    for (let t = 0; t < 6; t++) {
        const H = platform(5, 20, `hostile${t}`);
        if (t > 0) H.must(H.people[0], { do: "start", preset: t % 2 ? "full" : "lite" });
        if (t > 1) skipSetup(H);
        if (t > 2) { spin(H, 1); spin(H, 1); }
        for (let i = 0; i < 3000; i++) {
            const a = { do: pickOf(r, ["keep", "market", "dial", "spin", "call", "audit", "walk", "mute", "patch", "nudge", "whisper", "peek", "join", "leave", "start", "kick", "close", "__proto__", "constructor", 7]) };
            for (const k of keys) if (r() < 0.4) a[k] = pickOf(r, junk);
            const who = pickOf(r, [...H.people, "@x:y", "__proto__", undefined]);
            const before = JSON.stringify(H.st);
            let res;
            assert.doesNotThrow(() => { res = E.act(H.st, who, a, H.ctx()); }, `${String(who)} ${JSON.stringify(a)}`);
            if (!res.ok) assert.equal(JSON.stringify(res.state), before);
            else if (["leave", "close", "kick", "join"].includes(a.do)) { /* real table moves by real players may succeed */ }
            assert.doesNotThrow(() => E.viewFor(res.state, who, H.now));
        }
    }
    assert.equal(E.act(platform(3).st, U(0), { do: "start", preset: "__proto__" }, { now: 1, balances: { [U(0)]: 20 }, newSeed: () => Buffer.alloc(32) }).code, "bad");
    const H = platform(4, 20, "hostileW");
    H.must(H.people[0], { do: "start", preset: "full" });
    assert.equal(E.act(H.st, U(1), { do: "whisper", template: "constructor" }, H.ctx()).code, "phase", "Lite round 1: no Whispers");
});

test("the disconnect budget counts only the Spinner's own turn, not the reels landing", () => {
    const H = platform(4);
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const S = H.R().spinner;
    H.must(S, { do: "spin", bet: 1 });
    H.st = E.setOnline(H.st, S, false, H.ctx()).state; // drops while the reels land
    H.advance(1_000);
    H.st = E.setOnline(H.st, S, true, H.ctx()).state;
    assert.equal(H.R().away.used, 0);
});

// ------------------------------------------------------------------------------------------ review round 1 findings
const strip = (v) => { const { vseq, now, ...rest } = v; return JSON.stringify(rest); };

test("review: a Spinner who leaves while the reels land still gets that spin's result", () => {
    const H = platform(4, 20, "rv1");
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const S = H.R().spinner, start = H.R().bank_start;
    H.must(S, { do: "spin", bet: 3 });
    assert.equal(H.R().phase, "land");
    H.must(S, { do: "leave" });
    assert.equal(H.R().phase, "land", "the spin keeps landing");
    while (H.R().phase !== "reveal") H.toDeadline();
    const settle = H.log.filter((e) => e.k === "settle").at(-1);
    assert.equal(settle.reveal.spins.length, 1, "the spin was resolved, not dropped");
    const sp = settle.reveal.spins[0];
    assert.equal(settle.reveal.bankroll.end, start + sp.payout - sp.bet);
    assert.equal(settle.reveal.reason, "left");
});

test("review 2: leaving can't dodge the House's Nudge, and a table emptied mid-spin settles before it closes", () => {
    const H = platform(5, 20, "rv2b");
    H.must(H.people[0], { do: "start", preset: "full" });
    skipSetup(H); while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    H.toDeadline(); // round 2: Full
    skipSetup(H);
    const S = H.R().spinner, nudger = H.R().house[0];
    H.must(S, { do: "spin", bet: 2 });
    H.must(S, { do: "leave" });
    H.toDeadline();
    assert.equal(H.R().phase, "nudge", "the Nudge window still opens");
    H.must(nudger, { do: "nudge", reel: 1, step: 1 });
    assert.equal(H.R().phase, "reveal");
    const rv = H.log.filter((e) => e.k === "settle").at(-1).reveal;
    assert.deepEqual(rv.nudges.map((n) => n.by), [nudger]);
    // everyone leaves while a spin lands: no close before the settle (escrow never stranded)
    const H2 = platform(3, 20, "rv2c");
    H2.must(H2.people[0], { do: "start" });
    skipSetup(H2);
    H2.must(H2.R().spinner, { do: "spin", bet: 1 });
    for (const u of H2.people) H2.must(u, { do: "leave" });
    assert.equal(H2.st.status, "round");
    while (H2.st.status === "round") H2.toDeadline();
    assert.equal(H2.st.status, "closed");
    assert.equal(H2.st.closed_reason, "empty");
    assert.equal(H2.log.filter((e) => e.k === "settle").length, 1);
    assert.equal(Object.keys(H2.esc).length, 0, "nothing left in escrow");
});

test("review 2: a newly seated person's version says nothing about others' private moves", () => {
    const run = (toggles) => {
        const H = platform(5, 20, "rv2a");
        H.must(H.people[0], { do: "start", preset: "full" });
        skipSetup(H); while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
        if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
        H.toDeadline();
        skipSetup(H);
        const m = H.R().slots[0].owner;
        for (let i = 0; i < toggles; i++) H.must(m, { do: "mute", armed: i % 2 === 0 });
        H.must("@new:lab.test", { do: "join", space: H.space });
        return { joiner: H.view("@new:lab.test").vseq, spinner: H.view(H.R().spinner).vseq };
    };
    assert.deepEqual(run(20), run(0));
});

test("review: a move after a missed deadline is stale (the timer acts first); a late reconnect doesn't cancel the forced Walk", () => {
    const H = platform(4, 20, "rv3");
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const S = H.R().spinner;
    H.now = H.R().deadline + 40_000; // the platform's tick is late
    H.refuse(S, { do: "spin", bet: 3 }, "stale");
    H.advance(0);
    assert.equal(H.R().history.length >= 0 && H.R().phase !== "turn" || H.R().spin === 2, true);
    const H2 = platform(4, 20, "rv3b");
    H2.must(H2.people[0], { do: "start" });
    skipSetup(H2);
    const S2 = H2.R().spinner;
    H2.st = E.setOnline(H2.st, S2, false, H2.ctx()).state;
    H2.now += 50_000; // budget (45 s) spent, no tick yet
    H2.st = E.setOnline(H2.st, S2, true, H2.ctx()).state;
    H2.advance(0);
    assert.equal(H2.R().phase, "reveal");
    assert.equal(H2.R().end_reason, "away");
});

test("review: a Spinner who is already away when their turn starts gets the disconnect pause", () => {
    const H = platform(4, 20, "rv5");
    H.st = E.setOnline(H.st, H.people[0], false, H.ctx()).state;
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    assert.equal(H.R().away.since, H.now);
    H.advance(20_000);
    assert.equal(H.R().phase, "turn", "no auto-spin: paused");
    H.advance(25_000);
    assert.equal(H.R().end_reason, "away");
});

test("review: a settlement never guesses a missing balance (a departed Mechanic can't dodge a Peek bounty)", () => {
    const H = platform(4, 20, "rv6");
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const M = H.R().slots[0].owner, card = H.R().slots[0].card;
    const peeker = H.R().house.find((u) => u !== M);
    H.must(peeker, { do: "peek", mechanic: M, card });
    H.must(H.R().spinner, { do: "call", card });
    H.must(M, { do: "leave" });
    const ctx = { ...H.ctx(), balances: Object.fromEntries(Object.entries(H.bal).filter(([u]) => u !== M)) };
    assert.throws(() => E.act(H.st, H.R().spinner, { do: "leave" }, ctx), /needs .* balance/);
    H.must(H.R().spinner, { do: "leave" });
    const rv = H.log.filter((e) => e.k === "settle").at(-1).reveal;
    assert.deepEqual(rv.peeks.map((p) => p.delta), [5], "the full bounty: M had chips");
});

test("review: versions are per person: an invisible change (a Mute) doesn't move anyone else's vseq", () => {
    const H = platform(5, 20, "rv7");
    H.must(H.people[0], { do: "start", preset: "full" });
    skipSetup(H); while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    H.toDeadline(); // round 2: Full, Mutes on
    for (const m of H.R().mechanics) H.must(m, { do: "keep", card: H.R().deals[m][0] });
    for (const u of H.R().house) if (!H.R().market_done.includes(u)) H.must(u, { do: "market", side: "pass" });
    const m = H.R().slots[0].owner;
    const before = Object.fromEntries([...H.people, "@watch:x"].map((u) => [u, H.view(u)]));
    H.must(m, { do: "mute", armed: true });
    for (const u of [...H.people, "@watch:x"]) {
        const v = H.view(u);
        if (u === m) assert.equal(v.vseq, before[u].vseq + 1);
        else assert.equal(v.vseq, before[u].vseq, `${u} saw a version change`);
    }
});

test("review: stale table moves, the last one out, the dial after a wrong Call, a Whisper's named person in the reveal", () => {
    const H = platform(4, 20, "rv8");
    H.must(H.people[0], { do: "start" });
    skipSetup(H); while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    H.refuse(H.people[0], { do: "close", at: { round: 0 } }, "stale");
    H.refuse(H.people[0], { do: "close", at: { round: H.R().r, spin: H.R().spin + 1 } }, "stale");
    H.refuse(H.people[0], { do: "close", at: { round: H.R().r, phase: "turn" } }, "stale");
    H.must(H.people[0], { do: "close", at: { round: H.R().r } });
    // the dial
    const H2 = platform(4, 3, "rv10");
    H2.must(H2.people[0], { do: "start" });
    skipSetup(H2);
    const S = H2.R().spinner;
    H2.must(S, { do: "dial", bet: 3 });
    const wrong = R.PRESETS.lite.deck.find((c) => !H2.R().greyed[c] && !H2.R().slots.some((x) => x.card === c));
    H2.must(S, { do: "call", card: wrong });
    assert.equal(H2.R().bankroll, 1);
    assert.equal(H2.view(S).round.dial, 1);
    assert.deepEqual(H2.log.filter((e) => e.k === "live").at(-1), { k: "live", dial: 1 });
    // the last one out of a table with a past round: forget-whispers
    const H3 = platform(3, 20, "rv9");
    H3.must(H3.people[0], { do: "start" });
    skipSetup(H3);
    H3.must(H3.R().spinner, { do: "leave" });
    for (const u of H3.people.slice(1)) H3.must(u, { do: "leave" });
    assert.equal(H3.st.status, "closed");
    assert.equal(H3.forgot, 1);
});

test("review: the reveal keeps a Whisper's template and named person", () => {
    const H = platform(5, 20, "rv11");
    H.must(H.people[0], { do: "start", preset: "full" });
    skipSetup(H); while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    H.toDeadline();
    const who = H.R().house[0], named = H.R().house[1];
    H.must(who, { do: "whisper", template: "bluffing", person: named });
    H.must(H.R().spinner, { do: "leave" });
    const rv = H.log.filter((e) => e.k === "settle").at(-1).reveal;
    assert.deepEqual(rv.whispers, [{ who, spin: 0, template: "bluffing", person: named, text: "{person} is bluffing" }], "sent in SETUP: spin 0");
});

test("review 4: leaving or kicked during REVEAL = left (no `you`); the roster cap counts this round's leavers; start needs a fundable bankroll", () => {
    const H = platform(4, 20, "rv4a");
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    H.must(H.R().spinner, { do: "leave" });
    assert.equal(H.R().phase, "reveal");
    const M = H.R().house[0];
    H.must(M, { do: "leave" });
    assert.ok(H.R().left.includes(M));
    assert.equal(E.viewFor(H.st, M, H.now).you.role, "left");
    const H2 = platform(8, 20, "rv4b");
    H2.must(H2.people[0], { do: "start" });
    skipSetup(H2);
    H2.must(H2.R().house[2], { do: "leave" });
    H2.refuse("@new:lab.test", { do: "join", space: H2.space }, "table-full");
    H2.must(H2.R().house[2], { do: "join", space: H2.space }); // the one who left may come back (waits for the next round)
    const H3 = platform(3, 2, "rv4c");
    H3.refuse(H3.people[0], { do: "start" }, "no-chips");
});

test("review 4: a departed Spinner's version stays put when a Whisper arrives (no private `you` after leaving)", () => {
    const H = platform(5, 20, "rv4d");
    H.must(H.people[0], { do: "start", preset: "full" });
    skipSetup(H); while (H.R().phase === "turn" && H.R().spin < 5) spin(H, 1);
    if (H.R().phase === "turn") H.must(H.R().spinner, { do: "walk" });
    H.toDeadline();
    skipSetup(H);
    const S = H.R().spinner;
    H.must(S, { do: "spin", bet: 1 });
    H.must(S, { do: "leave" });
    const before = wireOf(H.st, S, H.now);
    H.must(H.R().house[0], { do: "whisper", template: "trust-nobody" });
    const after = wireOf(H.st, S, H.now);
    assert.equal(after.vseq, before.vseq);
    assert.equal(after.text, before.text);
});

// -------------------------------------------------------------------------------------------- random play + privacy
test("random play: 120 tables of random moves keep every money rule, and no view leaks another player's secrets", () => {
    let views = 0, rounds = 0;
    for (let t = 0; t < 120; t++) {
        const r = rng(1000 + t);
        const n = 3 + (t % 6);
        const H = platform(n, (u) => [0, 1, 2, 3, 5, 9, 20][Math.floor(r() * 7)] + (u === U(0) ? 10 : 0), `rand${t}`);
        H.must(H.people[0], { do: "start", preset: r() < 0.5 ? "full" : "lite", bankroll: 3 + Math.floor(r() * 8), patch: r() < 0.7 });
        const prev = {};
        for (let step = 0; step < 4000 && H.st.status === "round"; step++) {
            if (r() < 0.25) { H.advance(Math.floor(r() * 6000)); continue; }
            if (r() < 0.02 && H.R().phase === "turn") H.st = E.setOnline(H.st, H.R().spinner, r() < 0.5, H.ctx()).state;
            const [who, a] = randomMove(H, r);
            if (H.R().phase !== "reveal" && a.do !== "dial") a.at = r() < 0.9 ? { round: H.R().r, spin: H.R().spin, phase: H.R().phase } : { round: H.R().r, spin: H.R().spin + 1 };
            H.do(who, a);
            for (const u of [...H.people, "@outsider:x"]) {
                const v = wireOf(H.st, u, H.now), p = prev[u];
                if (p) assert.equal(v.text !== p.text, v.vseq !== p.vseq, `table ${t}: ${u}'s vseq moves exactly when their view does`);
                if (p) assert.ok(v.vseq >= p.vseq, "a version never goes back");
                prev[u] = v;
            }
            if (H.st.round && H.R().phase !== "reveal") {
                for (const u of [...H.people, "@outsider:x"]) {
                    const v = JSON.stringify(E.viewFor(H.st, u, H.now));
                    const v2 = JSON.stringify(E.viewFor(scramble(H.st, u, r), u, H.now));
                    assert.equal(v2, v, `table ${t} step ${step}: ${u}'s view changed when others' secrets did`);
                    assert.ok(!v.includes(H.R().seed), "the seed never shows before the reveal");
                    views++;
                }
            }
        }
        rounds += H.st.rounds;
        assert.equal(Object.keys(H.esc).length, H.st.status === "round" && H.R().phase !== "reveal" ? 1 : 0, "only the live round holds escrow");
    }
    assert.ok(rounds > 200 && views > 10_000, `exercised: ${rounds} rounds, ${views} views`);
});

test("no -0 and no fractions anywhere in a settlement", () => {
    for (let t = 0; t < 30; t++) {
        const r = rng(77 + t);
        const H = platform(5, 12, `z${t}`);
        H.must(H.people[0], { do: "start" });
        for (let step = 0; step < 3000 && H.st.status === "round"; step++) {
            if (r() < 0.3) { H.advance(3000); continue; }
            const [who, a] = randomMove(H, r);
            H.do(who, a);
        }
        for (const e of H.log.filter((x) => x.k === "settle")) {
            for (const v of [...Object.values(e.payouts), e.bank, ...Object.values(e.net)]) assert.ok(Number.isInteger(v) && !Object.is(v, -0));
        }
    }
});
