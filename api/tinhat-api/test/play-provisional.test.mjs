// rigProvisional (play/provisional.mjs): an open Rig round's running result per person, which holdings include (§2.1).
// Checked against the engine's own settlement: at the reveal each person's wallet moves by exactly escrow + provisional
// + (Market / Peek results), so for a round with no Market bets or Peeks, settlement payout = escrow + provisional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as R from "../play/rig.mjs";
import { rigProvisional } from "../play/provisional.mjs";

test("the running result matches what the settlement then pays (random Lite rounds, no Market/Peek)", () => {
    let checked = 0;
    for (let t = 0; t < 30; t++) {
        const now0 = 1763600000000;
        let now = now0;
        const people = ["wA", "wB", "wC", "wD"];
        const bal = { wA: 30, wB: 30, wC: 30, wD: 30 };
        let st = R.createTable({ table: "tRprovisionalTst", room: "!r:x", space: "!S:x", host: "wA", now });
        const ctx = () => ({ now, balances: bal, admitted: true, newSeed: () => randomBytes(32) });
        for (const w of people.slice(1)) st = R.act(st, w, { do: "join", space: "!S:x" }, ctx()).state;
        st = R.act(st, "wA", { do: "start", preset: "lite", bankroll: 6, patch: true }, ctx()).state;
        const R0 = st.round;
        for (const m of R0.mechanics) st = R.act(st, m, { do: "keep", card: st.round.deals[m][0] }, ctx()).state;
        for (const h of R0.house) st = R.act(st, h, { do: "market", side: "pass" }, ctx()).state;
        let last = null;
        for (let i = 0; i < 200 && st.round && st.round.phase !== "reveal"; i++) {
            if (st.round.phase === "turn") {
                const before = Object.fromEntries(people.map((w) => [w, rigProvisional(st, w)]));
                last = before;
                const r = R.act(st, st.round.spinner, { do: "spin", bet: 1 + (i % 3 === 0 ? 1 : 0) }, ctx());
                if (r.ok) st = r.state; else { now += 21_000; st = R.tick(st, ctx()).state; }
            } else { now += 5_000; st = R.tick(st, ctx()).state; }
        }
        if (!st.round || !st.round.settled) continue;
        const settle = st.round.settled;
        for (const w of people) {
            const esc = st.round.escrow[w] || 0;
            const prov = (() => { const s2 = JSON.parse(JSON.stringify(st)); s2.round.phase = "payout"; delete s2.round.settled; return rigProvisional(s2, w); })();
            assert.equal((settle.payouts[w] || 0), esc + prov, `table ${t}: ${w} payout = escrow ${esc} + running result ${prov}`);
            checked++;
        }
        void last;
    }
    assert.ok(checked >= 40, `checked ${checked} people`);
});

test("nothing provisional outside an open round, and a planted wrong rule (busted stakes ignored) is caught", () => {
    assert.equal(rigProvisional({ status: "lobby" }, "wA"), 0);
    assert.equal(rigProvisional({ status: "round", round: { phase: "reveal", spinner: "wA", bankroll: 9, bank_start: 6 } }, "wA"), 0);
    const st = { status: "round", round: { phase: "turn", spinner: "wS", bankroll: 11, bank_start: 6, rake_to: { wM: 2 }, call_to: { wM: 1 }, slots: [{ owner: "wM", busted_spin: 3, stake: 3 }, { owner: "wN", busted_spin: null, stake: 3 }] } };
    assert.equal(rigProvisional(st, "wS"), 5);
    assert.equal(rigProvisional(st, "wM"), 0); // +2 rake +1 call −3 busted stake
    assert.equal(rigProvisional(st, "wN"), 0);
    const planted = (s, w) => { const c = JSON.parse(JSON.stringify(s)); c.round.slots = c.round.slots.map((x) => ({ ...x, busted_spin: null })); return rigProvisional(c, w); };
    assert.notEqual(planted(st, "wM"), rigProvisional(st, "wM"), "the plant changes the answer (so the check above can fail)");
});
