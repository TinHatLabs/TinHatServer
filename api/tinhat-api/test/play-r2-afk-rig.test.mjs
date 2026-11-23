// games-s2, polish round 2: B10 away in The Rig (GAMES-V1.1-ADDENDUM §8.1, The Rig part) on the engine through the
// fake platform (play-rig-harness.mjs: money rules checked after every step). Failing-first against 9b6778f.
import { test } from "node:test";
import assert from "node:assert/strict";
import { E, platform, skipSetup } from "./play-rig-harness.mjs";

const ROUNDS = E.AWAY?.AWAY_STAND_ROUNDS ?? 6, MS = E.AWAY?.AWAY_STAND_MS ?? 600_000;
/** Let the Spinner time out twice: v1's timeout spin, then the forced Walk; then the reveal. */
function timeOutRound(H) {
    for (let i = 0; i < 40 && H.st.round && H.R().phase !== "reveal"; i++) H.toDeadline();
    assert.equal(H.R().phase, "reveal");
}

test("Rig: a Spinner's timeout → away from the NEXT rounds: skipped as Spinner, never a Mechanic, a watch-only Railbird", () => {
    const H = platform(5, 20, "afk1");
    H.must(H.people[0], { do: "start" });
    skipSetup(H);
    const sp = H.R().spinner;
    timeOutRound(H); // the current round keeps v1's rules (timeout spin, forced Walk)
    assert.equal(H.st.away?.[sp]?.reason, "timeout");
    const pv = H.view(H.people[1]).players.find((p) => p.u === sp);
    assert.deepEqual(pv.away, { reason: "timeout", since: H.st.away[sp].since, stand_at: H.st.away[sp].since + MS, hands_left: ROUNDS });
    H.toDeadline(); // the reveal ends: round 2
    const R = H.R();
    assert.notEqual(R.spinner, sp, "skipped as Spinner");
    assert.ok(!R.mechanics.includes(sp), "never dealt in as a Mechanic");
    assert.ok(R.railbirds.includes(sp) && R.watch.includes(sp), "a Railbird who can only watch");
    assert.ok(!H.log.some((e) => e.k === "escrow" && e.who === sp && e.round === R.r), "nothing of theirs escrowed");
    H.refuse(sp, { do: "whisper", template: "trust-nobody", at: { round: R.r, spin: 0, phase: "setup" } }, "rules");
    H.refuse(sp, { do: "market", side: "up", stake: 1, at: { round: R.r, spin: 0, phase: "setup" } }, "rules");
    assert.equal(H.view(sp).players.find((p) => p.u === sp).away.hands_left, ROUNDS - 1);
});

test("Rig: a Mechanic who doesn't keep in setup (timeout keep) is away from the next rounds; I'm back clears it", () => {
    const H = platform(4, 20, "afk2");
    H.must(H.people[0], { do: "start" });
    const m = H.R().mechanics[0];
    H.toDeadline(); // nobody keeps: v1's timeout keep
    assert.equal(H.R().phase, "turn");
    assert.equal(H.st.away?.[m]?.reason, "timeout");
    H.must(m, { do: "away", on: false });
    assert.equal(H.st.away[m], undefined);
    H.must(H.people[1], { do: "away", on: true });
    assert.equal(H.st.away[H.people[1]].reason, "asked");
});

test("Rig: fewer than 3 players who aren't away: no setup, the table waits in the lobby (nothing escrowed, no round)", () => {
    const H = platform(3, 20, "afk3");
    H.must(H.people[2], { do: "away", on: true });
    const before = H.st.rounds;
    H.must(H.people[0], { do: "start" });
    assert.equal(H.st.status, "lobby");
    assert.equal(H.st.round, null);
    assert.equal(H.st.rounds, before);
    assert.ok(!H.log.some((e) => e.k === "escrow"));
    H.must(H.people[2], { do: "away", on: false });
    H.must(H.people[0], { do: "start" });
    assert.equal(H.st.status, "round");
});

test("Rig: away past AWAY_STAND_MS → stands up at the next round's start (left, chips kept)", () => {
    const H = platform(4, 20, "afk4");
    H.must(H.people[3], { do: "away", on: true });
    H.must(H.people[0], { do: "start" });
    assert.ok(H.R().watch.includes(H.people[3]));
    skipSetup(H);
    H.advance(MS); // ten minutes pass (the due timers act at the new time)
    timeOutRound(H);
    const bal = H.bal[H.people[3]];
    H.toDeadline(); // the next round's start
    assert.ok(!H.st.seats.includes(H.people[3]), "stood up");
    assert.ok(H.left.includes(H.people[3]));
    assert.equal(H.bal[H.people[3]], bal, "chips kept");
});

test("Rig: an away Mechanic's SECRET move (a keep) shows nobody anything; away clears at the round's end", () => {
    const H = platform(4, 20, "afk5");
    H.must(H.people[0], { do: "start" });
    const m = H.R().mechanics[0];
    H.must(m, { do: "away", on: true }); // public: they asked to sit out the next rounds
    assert.equal(H.st.away[m].reason, "asked");
    const others = H.people.filter((u) => u !== m);
    const before = others.map((u) => JSON.stringify(E.viewFor(H.st, u, H.now)));
    H.must(m, { do: "keep", card: H.R().deals[m][1], at: { round: H.R().r, spin: 0, phase: "setup" } }); // secret
    assert.deepEqual(others.map((u) => JSON.stringify(E.viewFor(H.st, u, H.now))), before, "nobody's view moved");
    assert.ok(H.st.away[m], "still away until the round ends");
    for (let i = 0; i < 60 && H.st.round && H.R().phase !== "reveal"; i++) H.toDeadline();
    H.toDeadline();
    assert.equal(H.st.away?.[m], undefined, "I'm back by that move, applied once the round is over");
});
