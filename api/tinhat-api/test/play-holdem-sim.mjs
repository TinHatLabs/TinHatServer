// A seeded random driver for the Hold'em table engine + the checks it runs after EVERY move:
// - the ledger: an independent model of the accounts (wallet / seat / pot per player), fed ONLY by the engine's effects,
//   must match the engine's own state (seat = stack + pending, pot = what each player put in), never go negative,
//   and sum to zero; a settle must empty every pot account of the hand; nothing is created or lost;
// - privacy: every view (each seated player's and a spectator's) may name only the board, the viewer's own hole
//   cards and cards shown at a showdown; never the deck, never another player's live cards.
// Takes the engine as a module namespace (so the planted-wrong-rule controls can run it on a mutated copy).
import assert from "node:assert/strict";

/** mulberry32 → randomInt(min, max) with node:crypto's signature (max exclusive). */
export function seeded(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return (min, max) => min + Math.floor(next() * (max - min));
}

export class Ledger {
    constructor() { this.acc = new Map(); this.minted = 0; }
    get(k) { return this.acc.get(k) || 0; }
    move(from, to, n) {
        assert.ok(Number.isSafeInteger(n) && n >= 0, `bad amount ${n}`);
        this.acc.set(from, this.get(from) - n);
        this.acc.set(to, this.get(to) + n);
        for (const k of [from, to]) if (!k.startsWith("w:")) assert.ok(this.get(k) >= 0, `negative ${k}: ${this.get(k)}`);
    }
    apply(fx) {
        for (const e of fx) {
            switch (e.t) {
                case "sit": this.move(`w:${e.id}`, `seat:${e.id}`, e.amount); break;
                case "bet": this.move(`seat:${e.id}`, `pot:${e.hand}:${e.id}`, e.amount); break;
                case "settle": {
                    const out = Object.values(e.from).reduce((a, b) => a + b, 0);
                    const back = Object.values(e.to).reduce((a, b) => a + b, 0);
                    assert.equal(back, out, `settle of hand ${e.hand} creates or loses chips (${out} in, ${back} out)`);
                    for (const [id, n] of Object.entries(e.from)) {
                        assert.equal(this.get(`pot:${e.hand}:${id}`), n, `settle takes ${n} from pot:${e.hand}:${id} holding ${this.get(`pot:${e.hand}:${id}`)}`);
                        this.move(`pot:${e.hand}:${id}`, "settle", n);
                    }
                    for (const [id, n] of Object.entries(e.to)) this.move("settle", `seat:${id}`, n);
                    assert.equal(this.get("settle"), 0);
                    break;
                }
                case "void":
                    for (const [id, n] of Object.entries(e.refunds)) {
                        assert.equal(this.get(`pot:${e.hand}:${id}`), n, `void refunds ${n} from pot:${e.hand}:${id}`);
                        this.move(`pot:${e.hand}:${id}`, `seat:${id}`, n);
                    }
                    break;
                case "cashout":
                    assert.equal(this.get(`seat:${e.id}`), e.amount, `cash-out of ${e.id}: ${e.amount} but the seat holds ${this.get(`seat:${e.id}`)}`);
                    this.move(`seat:${e.id}`, `w:${e.id}`, e.amount);
                    break;
                case "credit": this.move(`w:${e.id}`, `seat:${e.id}`, e.amount); break;
                case "deal": case "closed": case "table-end": case "post": case "left": break;
                default: assert.fail(`unknown effect ${e.t}`);
            }
        }
    }
    total() { let t = 0; for (const v of this.acc.values()) t += v; return t; }
}

/** The engine's state must agree with the ledger model. */
export function checkState(T, L) {
    assert.equal(L.total(), 0, "the books don't balance");
    const seatedIds = new Set();
    for (const [s, x] of Object.entries(T.seats)) {
        seatedIds.add(x.id);
        assert.ok(x.stack >= 0 && x.pending >= 0, `seat ${s} negative`);
        assert.equal(L.get(`seat:${x.id}`), x.stack + x.pending, `seat ${s} (${x.id}): ledger ${L.get(`seat:${x.id}`)} vs engine ${x.stack}+${x.pending}`);
    }
    const h = T.hand;
    const open = h && !h.done;
    for (const [k, v] of L.acc) {
        if (k.startsWith("seat:") && !seatedIds.has(k.slice(5))) assert.equal(v, 0, `${k} holds ${v} after leaving`);
        if (k.startsWith("pot:")) {
            const [, n, id] = k.split(":");
            if (open && Number(n) === h.n) {
                const s = h.order.find((q) => h.ids[q] === id);
                assert.equal(v, h.b.p[s].total, `${k}: ledger ${v} vs engine ${h.b.p[s].total}`);
            } else assert.equal(v, 0, `${k} still holds ${v} after its hand ended`);
        }
    }
}

const CARD = /"([2-9TJQKA][cdhs])"/g;

/** Every card a viewer's view names must be on the board, their own, or shown at a showdown. */
export function checkPrivacy(T, viewFor, viewer) {
    const v = viewFor(T, { viewer });
    const json = JSON.stringify(v);
    const h = T.hand;
    const allowed = new Set();
    if (h && !h.voided) {
        for (const c of h.board) allowed.add(c);
        if (h.done && h.result) for (const cs of Object.values(h.result.shown)) for (const c of cs) allowed.add(c);
        const mine = Object.keys(h.ids).find((s) => h.ids[s] === viewer);
        if (mine !== undefined) for (const c of h.holes[mine]) allowed.add(c);
    }
    for (const m of json.matchAll(CARD)) assert.ok(allowed.has(m[1]), `view for ${viewer} leaks ${m[1]}`);
    assert.ok(!json.includes("deck"), "a view carries the deck");
    return v;
}

/**
 * Plays `hands` hands at a random table, seeded. Every move: ledger + state + privacy checks.
 * mods = { table } (the table.mjs namespace). Returns counters for the caller's coverage asserts.
 */
export function simulate(mods, { seed = 1, hands = 200, seats = null } = {}) {
    const { createTable, move, viewFor, nextWake, wouldDeal, HOLDEM } = mods.table;
    const R = seeded(seed);
    const nSeats = seats ?? R(2, 9);
    let now = 1_763_600_000_000;
    const L = new Ledger();
    const SPACE = "sid-sim";
    let T = createTable({ host: "p1", space: SPACE, opts: { seats: nSeats }, now });
    const stats = { hands: 0, showdowns: 0, sidepots: 0, splits: 0, timeouts: 0, leavesMid: 0, voids: 0, allins: 0, moves: 0, refused: 0, kicks: 0, aways: 0, credits: 0 };
    let nextId = 1;
    const apply = (m, sys = false) => {
        const admitted = wouldDeal(T, m, now) ? true : undefined; // a deal without the check throws: wouldDeal must be exact
        const r = move(T, m, { now, randomInt: R, system: sys, admitted });
        stats.moves += 1;
        if (!r.ok) { stats.refused += 1; assert.equal(r.state, T, "a refused move must hand back the same state"); assert.deepEqual(r.effects, []); return r; }
        L.apply(r.effects);
        for (const e of r.effects) {
            if (e.t === "deal") stats.hands += 1;
            if (e.t === "void") stats.voids += 1;
            if (e.t === "bet" && e.a === "allin") stats.allins += 1;
        }
        T = r.state;
        checkState(T, L);
        checkPrivacy(T, viewFor, null);
        for (const x of Object.values(T.seats)) checkPrivacy(T, viewFor, x.id);
        if (T.hand && T.hand.done && T.hand.result && r.effects.some((e) => e.t === "settle")) {
            if (Object.keys(T.hand.result.shown).length) stats.showdowns += 1;
            if (T.hand.result.pots.length > 1) stats.sidepots += 1;
            if (T.hand.result.pots.some((p) => p.winners.length > 1)) stats.splits += 1;
        }
        return r;
    };
    const sitNew = () => {
        const id = `p${nextId++}`;
        const chips = R(1, 120);
        apply({ do: "sit", by: id, chips, space: SPACE });
    };
    for (let i = 0; i < Math.min(nSeats, R(2, nSeats + 1)); i++) sitNew();
    let guard = 0;
    stats.tables = 1;
    while (stats.hands < hands) {
        if (T.status === "closed") {
            // a void or a close ends the table: open the next one at the same ledger (everyone was cashed out)
            assert.deepEqual(Object.keys(T.seats), []);
            T = createTable({ host: `p${nextId}`, space: SPACE, opts: { seats: nSeats }, now });
            stats.tables += 1;
            for (let i = 0; i < R(2, nSeats + 1); i++) sitNew();
            continue;
        }
        if (++guard > hands * 400) assert.fail(`no progress after ${guard} steps (status ${T.status})`);
        const seated = Object.values(T.seats);
        const roll = R(0, 1000);
        if (T.status === "lobby") {
            if (seated.filter((x) => x.stack + x.pending > 0 && !x.away).length < 2 || roll < 100) {
                if (seated.length < nSeats && roll < 600) sitNew();
                else if (seated.length) {
                    const x = seated[R(0, seated.length)];
                    if (x.away) apply({ do: "away", by: x.id, on: false });
                    else { apply({ do: "credit", target: x.id, amount: R(1, 30) }, true); stats.credits += 1; }
                } else sitNew();
                continue;
            }
            apply({ do: "deal", by: T.host });
            continue;
        }
        if (T.status === "pause") {
            if (roll < 60 && seated.length) { const x = seated[R(0, seated.length)]; apply({ do: "leave", by: x.id }); continue; }
            if (roll < 120 && seated.length < nSeats) { sitNew(); continue; }
            if (roll < 160 && seated.length) {
                const x = seated[R(0, seated.length)];
                if (x.away) apply({ do: "away", by: x.id, on: false }); else { apply({ do: "credit", target: x.id, amount: R(1, 10) }, true); stats.credits += 1; }
                continue;
            }
            now = T.pauseUntil;
            apply({ do: "tick" }, true);
            continue;
        }
        // a hand is on
        const h = T.hand;
        const s = h.b.toAct;
        const x = T.seats[s];
        if (roll < 25) { const y = seated[R(0, seated.length)]; apply({ do: "leave", by: y.id }); stats.leavesMid += 1; continue; }
        if (roll < 35) { const y = seated[R(0, seated.length)]; if (y.id !== T.host) { apply({ do: "kick", by: T.host, target: y.id }); stats.kicks += 1; } continue; }
        if (roll < 45) { const y = seated[R(0, seated.length)]; apply({ do: "away", by: y.id, on: !y.away }); stats.aways += 1; continue; }
        if (roll < 50 && seated.length < nSeats) { sitNew(); continue; }
        if (roll < 55) { const y = seated[R(0, seated.length)]; apply({ do: "credit", target: y.id, amount: R(1, 5) }, true); stats.credits += 1; continue; }
        if (roll < 52 + (seed % 3)) { apply({ do: "void" }, true); continue; }
        if (roll < 90) { now = h.deadline; apply({ do: "tick" }, true); stats.timeouts += 1; continue; }
        if (roll < 100) { apply({ do: "call", by: x.id, at: { hand: h.n, turn: h.turn - 1 } }); continue; } // stale on purpose
        const lg = viewFor(T, { viewer: x.id }).you.legal;
        assert.ok(lg, "the player to act has legal moves");
        const at = { hand: h.n, turn: h.turn };
        const pick = R(0, 100);
        if (pick < 15) apply({ do: "fold", by: x.id, at });
        else if (pick < 50) apply({ do: lg.check ? "check" : "call", by: x.id, at });
        else if (pick < 80 && lg.raise) apply({ do: "raise", by: x.id, at, to: R(lg.raise.min, lg.raise.max + 1) });
        else if (pick < 90) apply({ do: "allin", by: x.id, at });
        else apply({ do: lg.check ? "check" : "call", by: x.id, at });
        // sanity: nextWake always names a time while a hand is on
        if (T.status === "hand") assert.ok(Number.isFinite(nextWake(T)));
    }
    // close at the end: everyone is cashed out, the books still balance, every seat/pot account is 0
    if (T.status !== "closed") {
        apply({ do: T.hand && !T.hand.done ? "void" : "close", reason: "test" }, true);
    }
    assert.equal(T.status, "closed");
    for (const [k, v] of L.acc) if (!k.startsWith("w:")) assert.equal(v, 0, `${k} holds ${v} after the close`);
    void HOLDEM;
    return stats;
}
