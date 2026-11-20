// The Rig bot's strategy (tools/play-bot-rig-strategy.mjs, lab only) against the real engine: bots in every seat play
// whole tables on a simulated clock. Every move a bot chooses must be legal (the engine accepts it: never a refusal),
// a bot never lets a timer act for it (no timeout spins or Walks, no setup defaults), the tables keep moving (no
// stall), and the money rules hold throughout (the harness ledger). When games-s1's adapter is present (merged), the
// same runs go through the CONTRACT view the server really sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { E, U, platform, rng } from "./play-rig-harness.mjs";

const { decide } = await import(new URL("../tools/play-bot-rig-strategy.mjs", import.meta.url).href);
const ADAPT = fileURLToPath(new URL("../play/adapt.mjs", import.meta.url));
const rigContract = existsSync(ADAPT) ? (await import(pathToFileURL(ADAPT).href)).rigContract : null;

function viewer(H, mode) {
    if (mode === "engine") return (u) => { // + the wallet, as the platform's contract view carries it (you.holdings)
        const v = E.viewFor(H.st, u, H.now);
        if (v.you) v.you.holdings = H.bal[u] ?? 0;
        return v;
    };
    return (u) => rigContract(E.viewFor(H.st, u, H.now), H.st, u, {
        room: "!room:lab.test", owner: "lab.test", mx: (x) => x, connected: () => true, screens: () => ["web"],
        wallet: (x) => ({ holdings: H.bal[x] ?? 0, at_cap: false, cap: 100 }), spectators: 0, closedAt: H.now, now: H.now, hostMx: H.st.host,
    });
}

// one simulated table session: bots decide on their own views; the soonest decision runs unless a timer is due first
function soak({ seats, rounds, seed, mode, chips = 20 }) {
    const r = rng(seed);
    const H = platform(seats, chips, `bot${seed}`, { table: "tR7q2wE4rT6yU8iO" });
    const view = viewer(H, mode);
    const mem = Object.fromEntries(H.people.map((u) => [u, { pace: 1 }]));
    const stats = { moves: 0, refused: [], timerActs: 0, rounds: 0, byDo: {}, steps: 0 };
    const start = () => {
        // between tables: the server's daily top-up keeps people playing (here paid by the bank, so supply holds)
        for (const u of H.people) if (H.bal[u] < 6) { H.bank -= 20 - H.bal[u]; H.bal[u] = 20; }
        H.must(H.st.host, { do: "start", preset: r() < 0.3 ? "lite" : "full", bankroll: 6, patch: true });
    };
    start();
    let lastRound = 0, stepsInRound = 0;
    while (stats.rounds < rounds) {
        if (++stats.steps > rounds * 2000) throw new Error(`stalled: ${stats.rounds} rounds after ${stats.steps} steps`);
        if (H.st.status === "end") { start(); continue; }
        if (H.st.status !== "round") throw new Error(`table ${H.st.status}`);
        if (H.R().r !== lastRound) { lastRound = H.R().r; stats.rounds++; stepsInRound = 0; }
        if (++stepsInRound > 2000) throw new Error(`round ${lastRound} stalled in ${H.R().phase}`);
        const due = E.nextDeadline(H.st);
        let best = null;
        for (const u of H.people) {
            const d = decide(view(u), u, mem[u], r);
            if (d && (!best || d.delay_ms < best.d.delay_ms)) best = { u, d };
        }
        if (best && (due == null || H.now + best.d.delay_ms < due)) {
            H.now += Math.round(best.d.delay_ms);
            const res = E.act(H.st, best.u, { ...best.d.a, ...(best.d.at ? { at: best.d.at } : {}) }, H.ctx());
            stats.moves++;
            stats.byDo[best.d.a.do] = (stats.byDo[best.d.a.do] || 0) + 1;
            if (!res.ok) { stats.refused.push(`${best.u} ${JSON.stringify(best.d.a)} → ${res.code} (phase ${H.R().phase})`); mem[best.u].refused[best.d.key] = true; continue; }
            if (best.d.key && !best.d.noAck) mem[best.u].done[best.d.key] = true; // as the client does on an ok ack
            H.apply(res.effects); H.st = res.state;
        } else {
            const R0 = H.R(), phase = R0.phase, before = R0.timeouts;
            const unkept = phase === "setup" ? R0.mechanics.filter((m) => !R0.kept[m]).length : 0;
            H.advance(Math.max(0, due - H.now));
            if (phase === "turn" && (H.st.round?.timeouts > before || H.st.round?.end_reason === "timeouts")) stats.timerActs++;
            if (unkept) stats.timerActs++;
        }
    }
    return stats;
}

for (const mode of ["engine", "contract"]) {
    test(`bots in every seat (${mode} views): every move legal, no timer acts for a bot, no stall, money rules hold`, { skip: mode === "contract" && !rigContract ? "needs games-s1's play/adapt.mjs (runs once merged)" : false }, () => {
        const total = { moves: 0, rounds: 0, byDo: {} };
        for (const [i, seats] of [3, 4, 5, 6, 8].entries()) {
            const s = soak({ seats, rounds: 50, seed: 100 + i, mode });
            assert.deepEqual(s.refused, [], `${seats} seats: refused moves`);
            assert.equal(s.timerActs, 0, `${seats} seats: a timer acted for a bot`);
            total.moves += s.moves; total.rounds += s.rounds;
            for (const [k, n] of Object.entries(s.byDo)) total.byDo[k] = (total.byDo[k] || 0) + n;
        }
        // the bots really use the game: every kind of move turns up over the soak
        for (const k of ["keep", "market", "dial", "spin", "call", "audit", "walk", "mute", "nudge", "whisper", "peek"]) assert.ok(total.byDo[k] > 0, `never played ${k}: ${JSON.stringify(total.byDo)}`);
        assert.ok(total.rounds >= 250, `${total.rounds} rounds`);
    });
}

test("a bot's pace: every delay sits inside the timer it answers (with a margin) and 2–8 s by default", () => {
    const H = platform(4, 20, "pace");
    H.must(H.people[0], { do: "start" });
    const r = rng(3);
    for (let i = 0; i < 200; i++) {
        for (const u of H.people) {
            const v = E.viewFor(H.st, u, H.now);
            const d = decide(v, u, { pace: 1 }, r);
            if (!d) continue;
            const left = v.round.deadline - v.now;
            assert.ok(d.delay_ms >= 0 && d.delay_ms <= Math.max(0, left - 2500) + 1e-9, `${d.a.do} at ${d.delay_ms} with ${left} left`);
            if (v.round.phase !== "nudge") assert.ok(d.delay_ms <= 8000, `${d.a.do} ${d.delay_ms}`);
        }
        H.advance(1000);
        if (H.st.status !== "round") break;
    }
});

test("an accepted move isn't sent again for the same moment, even if the view doesn't show it yet (no spamming)", () => {
    const H = platform(4, 20, "nospam");
    H.must(H.people[0], { do: "start" });
    const M = H.R().mechanics[0];
    const v = E.viewFor(H.st, M, H.now);
    v.you.holdings = 20;
    const mem = { pace: 1 }, r = rng(5);
    const d1 = decide(v, M, mem, r);
    assert.equal(d1.a.do, "keep");
    mem.done[d1.key] = true; // the server said ok, but this (stale) view still shows the deal
    for (let i = 0; i < 50; i++) {
        const d = decide(v, M, mem, r);
        assert.ok(!d || d.a.do !== "keep", "keep sent again");
        if (d) mem.done[d.key] = true;
    }
});
