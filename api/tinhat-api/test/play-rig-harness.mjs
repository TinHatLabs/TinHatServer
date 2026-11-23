// Shared test harness for The Rig's engine tests (play-rig-engine.test.mjs): a fake
// platform with an in-memory ledger that checks the money rules after every effect, a seeded PRNG, random moves, and
// the scrambler for the privacy non-interference check. RIG_ENGINE_DIR (tests only): see play-rig-vectors.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const dir = process.env.RIG_ENGINE_DIR ? pathToFileURL(process.env.RIG_ENGINE_DIR + "/").href : new URL("../play/", import.meta.url).href;
export const E = await import(new URL("rig.mjs", dir).href);
export const R = await import(new URL("rig-rules.mjs", dir).href);
export const G = await import(new URL("rig-rng.mjs", dir).href);
// one person's engine view minus vseq and now (what their version must track)
export function wireOf(st, u, now) {
    const { vseq, now: _n, ...rest } = E.viewFor(st, u, now);
    return { vseq, text: JSON.stringify(rest) };
}
export const U = (i) => `@p${i}:lab.test`;

// ------------------------------------------------------------------------------------------------- the fake platform
export function platform(n, chips = 20, tag = "t", opts = {}) {
    const H = { bal: {}, esc: {}, bank: 0, now: 1_000_000, seedN: 0, log: [], posts: [], left: [], ends: [], forgot: 0 };
    const people = [...Array(n).keys()].map(U);
    for (const u of people) H.bal[u] = typeof chips === "function" ? chips(u) : chips;
    H.supply = () => Object.values(H.bal).reduce((s, v) => s + v, 0) + Object.values(H.esc).flatMap((m) => Object.values(m)).reduce((s, v) => s + v, 0) + H.bank;
    const start = H.supply();
    H.admitted = true;
    H.space = "!space:lab.test";
    H.ctx = () => ({ now: H.now, balances: { ...H.bal }, admitted: H.admitted, newSeed: () => createHash("sha256").update(`${tag}:${H.seedN++}`).digest() });
    H.apply = (effects) => {
        for (const e of effects) {
            H.log.push(e);
            if (["escrow", "settle", "void"].includes(e.k)) assert.equal(e.space, H.space, `${e.k}: money moves only in the table's space`);
            if (e.k === "escrow") {
                assert.ok(e.amount > 0 && H.bal[e.who] >= e.amount, `escrow ${e.kind} ${e.amount} from ${e.who} (has ${H.bal[e.who]})`);
                H.bal[e.who] -= e.amount;
                const m = (H.esc[e.round] ||= {});
                m[e.who] = (m[e.who] || 0) + e.amount;
            } else if (e.k === "settle") {
                const m = H.esc[e.round] || {};
                const held = Object.values(m).reduce((s, v) => s + v, 0);
                const out = Object.values(e.payouts).reduce((s, v) => s + v, 0);
                assert.equal(held, out + e.bank, `round ${e.round}: escrows = payouts + bank`);
                for (const [u, v] of Object.entries(e.payouts)) {
                    assert.ok(!Object.is(v, -0));
                    H.bal[u] = (H.bal[u] || 0) + v;
                    assert.ok(H.bal[u] >= 0, `${u} below 0 after settle`);
                }
                H.bank += e.bank;
                delete H.esc[e.round];
            } else if (e.k === "void") {
                for (const [u, v] of Object.entries(e.refunds)) H.bal[u] += v;
                assert.deepEqual(e.refunds, H.esc[e.round] || {});
                delete H.esc[e.round];
            } else if (e.k === "post") H.posts.push(e);
            else if (e.k === "left") H.left.push(e.who);
            else if (e.k === "table-end") H.ends.push(e);
            else if (e.k === "forget-whispers") H.forgot += 1;
        }
        assert.equal(H.supply(), start, "chip supply conserved");
    };
    H.st = E.createTable({ table: opts.table ?? `t-${tag}`, room: "!room:lab.test", space: H.space, host: people[0], now: H.now });
    H.do = (who, a) => {
        const r = E.act(H.st, who, a, H.ctx());
        if (r.ok) { H.apply(r.effects); H.st = r.state; } else assert.equal(r.state, H.st, "a refused move changes nothing");
        return r;
    };
    H.must = (who, a) => { const r = H.do(who, a); assert.ok(r.ok, `${who} ${JSON.stringify(a)} → ${r.code}`); return r; };
    H.refuse = (who, a, code) => { const r = H.do(who, a); assert.equal(r.code, code, `${who} ${JSON.stringify(a)}`); return r; };
    H.advance = (ms) => {
        H.now += ms;
        const r = E.tick(H.st, H.ctx());
        H.apply(r.effects);
        H.st = r.state;
        return r;
    };
    H.toDeadline = () => { const d = E.nextDeadline(H.st); assert.ok(d != null); return H.advance(d - H.now); };
    H.view = (u) => E.viewFor(H.st, u, H.now);
    H.R = () => H.st.round;
    H.people = people;
    for (const u of people.slice(1)) H.must(u, { do: "join", space: H.space });
    return H;
}

// Finish SETUP (keep the first dealt card, no Market) by timeout
// (v1.1: each Mechanic keeps their first card themself first, so nobody times out into `away`, addendum §8.1)
export const skipSetup = (H) => {
    assert.equal(H.R().phase, "setup");
    const r = H.R().r;
    for (const m of H.R().mechanics) if (!H.R().kept[m] && !H.R().left.includes(m)) H.must(m, { do: "keep", card: H.R().deals[m][0], at: { round: r, spin: 0, phase: "setup" } });
    if (H.R().phase === "setup") H.toDeadline();
    assert.equal(H.R().phase, "turn");
};
// Spin and let the reels land + the Nudge window pass
export function spin(H, bet) {
    const n = H.R().spin;
    H.must(H.R().spinner, { do: "spin", bet, at: { round: H.R().r, spin: n, phase: "turn" } });
    while (H.st.round && H.R().phase !== "turn" && H.R().phase !== "reveal" && H.R().spin === n) H.toDeadline();
}

export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const pickOf = (r, xs) => xs[Math.floor(r() * xs.length)];

export function randomMove(H, r) {
    const st = H.st, Rr = st.round;
    const who = pickOf(r, H.people);
    const deck = R.DECK;
    const moves = [
        { do: "keep", card: Rr?.deals?.[who]?.[Math.floor(r() * 2)] },
        { do: "market", side: pickOf(r, ["up", "not-up", "pass"]), stake: 1 + Math.floor(r() * 2) },
        { do: "dial", bet: 1 + Math.floor(r() * 3) },
        { do: "spin", bet: 1 + Math.floor(r() * 3) },
        { do: "call", card: pickOf(r, deck) },
        { do: "audit", spin: 1 + Math.floor(r() * 5) },
        { do: "walk" },
        { do: "mute", armed: r() < 0.7 },
        { do: "patch" },
        { do: "nudge", reel: 1 + Math.floor(r() * 3), step: r() < 0.5 ? 1 : -1 },
        { do: "whisper", text: "hm" },
        { do: "peek", mechanic: pickOf(r, H.people), card: pickOf(r, deck) },
    ];
    return [who, pickOf(r, moves)];
}

// Everything secret that belongs to someone else: scrambled, `who`'s view must not change (before the reveal).
export function scramble(st0, who, r) {
    const st = structuredClone(st0);
    const Rr = st.round;
    if (!Rr || Rr.phase === "reveal") return st;
    Rr.seed = createHash("sha256").update(Rr.seed + "x").digest("hex");
    const P = R.PRESETS[Rr.preset];
    const spare = P.deck.filter((c) => !Rr.greyed[c]);
    for (const s of Rr.slots) if (s.owner !== who && s.busted_spin == null) s.card = pickOf(r, spare);
    for (const s of Rr.slots) if (s.owner !== who) s.slot = (s.slot + 1) % Math.max(1, Rr.slots.length);
    for (const [u, d] of Object.entries(Rr.deals)) if (u !== who) Rr.deals[u] = [pickOf(r, spare), pickOf(r, spare)];
    for (const u of Object.keys(Rr.kept)) if (u !== who) Rr.kept[u] = pickOf(r, spare);
    for (const [u, m] of Object.entries(Rr.mutes)) if (u !== who) { m.armed = !m.armed; m.left = (m.left + 1) % 3; }
    for (const p of Rr.peeks) if (p.who !== who) { p.card = pickOf(r, spare); p.held = pickOf(r, spare); }
    for (const [u, b] of Object.entries(Rr.market)) if (u !== who) { b.side = b.side === "up" ? "not-up" : "up"; b.stake = 3 - b.stake; }
    for (const w of Rr.whispers) if (w.who !== who) w.who = pickOf(r, H_people_of(st).filter((u) => u !== who));
    for (const u of Object.keys(Rr.rake_to)) if (u !== who) Rr.rake_to[u] += 5;
    for (const u of Object.keys(Rr.call_to)) if (u !== who) Rr.call_to[u] += 5;
    for (const u of Object.keys(Rr.nudge_left)) if (u !== who) Rr.nudge_left[u] = 1 - Rr.nudge_left[u];
    if (Rr.spinner !== who && Rr.audit) Rr.audit = { spin: Rr.audit.spin, honest_reels: ["hat", "hat", "hat"], honest_payout: 60, touched: 3 }; // that it was used is public (the stamp)
    if (Rr.pending) for (const c of Rr.pending.cards) if (c.owner !== who) { c.card = pickOf(r, spare); c.muted = !c.muted; }
    if (Rr.pending) Rr.pending.muted = Rr.pending.muted.filter((u) => u === who);
    for (const h of Rr.history) { h.muted = h.muted.filter((u) => u === who); if (h.nudge) h.nudge.by = "@scrambled:x"; h.touched = []; h.bit = []; h.rake = {}; h.honest = ["moon", "moon", "moon"]; }
    Rr.escrow = {};
    Rr.bank = 99;
    return st;
}
const H_people_of = (st) => [...new Set([st.round.spinner, ...st.round.house])];

