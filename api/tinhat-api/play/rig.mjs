// The Rig: the table and round engine (GAMES-V1-SPEC §5; HOUSE-GAME-DESIGN.md is the background). PURE: no I/O, no
// clock, no randomness of its own. The platform (S1) owns the database, the ledger, the sockets and the timers; it
// calls in with what it knows and carries out what comes back:
//
//   createTable({table, room, space, host, now})     → state (the host is seated). `space` = the table's wallet scope
//                                                       (spec rev 2: the game space's id), opaque here, bound for life
//   spaceChanged(state, ctx)                         → {state, effects}   the room's game space moved: finish the
//                                                       round in progress (settled into the table's space), then close
//   act(state, who, a, ctx)                          → {ok, code, state, effects}   a = the socket move's `a` (+ `at`)
//   tick(state, ctx)                                 → {state, effects}             at or after nextDeadline(state)
//   setOnline(state, who, online, ctx)               → {state, effects}             the Spinner's disconnect clock
//   voidRound(state, ctx)                            → {state, effects}             call off: every escrow back
//   viewFor(state, who, now)                         → the caller's view (§5.3); the ONLY way state leaves the engine
//   nextDeadline(state)                              → ms | null
//
//   ctx = {now (ms), balances: {mxid: available chips IN THE TABLE'S SPACE, i.e. the wallet without anything
//          escrowed} for every seated player AND every participant of the round in progress (also those who left),
//          newSeed: () => 32 random bytes (the CSPRNG; asked once per round),
//          admitted: the platform's admission check (the room's current game space == the table's); pass it on every
//          tick/act that may start a round. false → no new round: the table closes (space-changed).}
//
// Effects (do them in the same transaction as storing the new state; if one fails, drop the new state). Every money
// effect carries `space` = the table's space: escrows, settlements and voids always use it, never a re-check.
//   {k:"escrow", who, amount, kind: bankroll|stake|patch|market|peek, round}   wallet → the round's escrow
//   {k:"settle", round, idem, payouts: {who: n}, bank: n, lines: [{who, amount, reason}], reveal, net}
//        one transaction: every escrow of the round is released; payouts[who] (may be < 0: a Peek bounty paid from
//        the wallet) to each wallet, `bank` (+ = the bank gains) to the bank. Σ escrows = Σ payouts + bank, always.
//   {k:"void", round, refunds: {who: n}}                                        every escrow back (a restart, off)
//   {k:"live", dial}                                                             the public dial (no ack)
//   {k:"left", who}                                                              cash-out done: run the prestige check
//   {k:"post", kind: "result"|"summary", round}                                  ask an app to post the chat card
//   {k:"table-end", leaderboard, pit_boss}  {k:"forget-whispers"}                drop free-text Whispers kept so far
//
// The state holds secrets (the seed, the slots, Mutes, wagers): never send it anywhere; send viewFor() per person.
import { createHash } from "node:crypto";
import { commitOf, honestReels, rerollSource, shuffle } from "./rig-rng.mjs";
import {
    CARDS, PRESETS, MONEY, PLAYERS, reelPhase, applyNudge, payoutPhase, rakeOf, resultOf, paytableOf, machineOk,
    settleMarket, settlePeeks, WHISPER_TEMPLATES, checkWhisperText,
} from "./rig-rules.mjs";

export const TIMERS = Object.freeze({ setup: 20_000, turn: 20_000, land: 2_000, nudge: 4_000, reveal: 20_000, spinner_away: 45_000 });
export const DEAL_ATTEMPTS = 64;
export const TIMEOUTS_TO_WALK = 2;
export const RAILBIRD_BELOW = 1; // a House member with fewer chips than this at the round's start is a Railbird

const clone = (x) => structuredClone(x);
const own = (obj, k) => typeof k === "string" && Object.hasOwn(obj, k); // moves are untrusted: never "__proto__" & co
const isInt = (n) => Number.isInteger(n);

// ---------------------------------------------------------------------------------------------------------- the deal
// Attempt a: shuffle("deck:a", the preset's deck); the first `dead` are dead; Mechanic m gets d+2m, d+2m+1. Every
// choice of kept cards must pass the machine rules, else attempt a+1 (≤ 64). Slot order = shuffle("slot", indexes).
export function dealFor(seed, preset, mechanics) {
    for (let a = 0; a < DEAL_ATTEMPTS; a++) {
        const deck = shuffle(seed, `deck:${a}`, preset.deck);
        const dead = deck.slice(0, preset.dead);
        const hands = [];
        for (let m = 0; m < mechanics; m++) hands.push(deck.slice(preset.dead + 2 * m, preset.dead + 2 * m + 2));
        const choices = hands.reduce((acc, h) => acc.flatMap((x) => h.map((c) => [...x, c])), [[]]);
        if (choices.every((ch) => machineOk(ch).ok)) {
            return { attempt: a, dead, hands, slots: shuffle(seed, "slot", [...Array(mechanics).keys()]) };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------------------------------------- tables
export function createTable({ table, room, space, host, now }) {
    if (typeof space !== "string" || !space) throw new Error("rig: a table is bound to a space");
    const st = {
        v: 1, game: "rig", table, room, space, host, created: now, rev: 1, vs: {}, offline: [], status: "lobby", closing: null,
        opts: { preset: "lite", bankroll: MONEY.bankroll_default, patch: true },
        seats: [host], spun: [], skipped: [], mech_count: {}, board: {}, run: 0, rounds: 0, rounds_in_run: 0, round: null, end: null,
    };
    refreshVersions(st);
    return st;
}

export function nextDeadline(st) {
    const R = st.round;
    if (!R || st.status !== "round") return null;
    if (R.phase === "turn" && R.away.since != null) {
        return R.away.since + Math.max(0, TIMERS.spinner_away - R.away.used);
    }
    return R.deadline;
}

const presetOf = (R) => PRESETS[R.preset];
const liveSlots = (R) => R.slots.filter((s) => s.busted_spin == null);
const liveCardOf = (R, u) => liveSlots(R).find((s) => s.owner === u)?.card ?? null;
const inRound = (R, u) => R && (R.spinner === u || R.house.includes(u));
const isHouse = (R, u) => R && R.house.includes(u) && !R.left.includes(u);
const isRailbird = (R, u) => R.railbirds.includes(u);

// st.rev = the state's own revision (the platform's compare-and-set; never sent). Each recipient's view carries its OWN
// version (st.vs[who].v), bumped only when THAT person's view changes: a shared counter would tell the Spinner that
// something invisible happened (a Mute armed, a Peek placed). Spectators share the key "*", which only ever moves on
// public changes. A new key starts just above "*" (never from other people's counters, which move on their private
// changes), so a spectator who sits down never sees their version go back; a key, once made, is kept.
const SPECTATOR = "*";
function refreshVersions(st) {
    const keys = new Set([SPECTATOR, ...Object.keys(st.vs), ...st.seats, ...(st.round ? [st.round.spinner, ...st.round.house] : [])]);
    for (const u of keys) { // "*" first (the Set's order), so a new key starts above its fresh value
        const h = createHash("sha256").update(JSON.stringify(viewBody(st, u))).digest("base64");
        const cur = st.vs[u];
        if (!cur) st.vs[u] = { v: u === SPECTATOR ? 1 : st.vs[SPECTATOR].v + 1, h };
        else if (cur.h !== h) { cur.v += 1; cur.h = h; }
    }
}
function bump(st) { st.rev += 1; refreshVersions(st); }

function ok(st, effects = []) { bump(st); return { ok: true, code: "", state: st, effects }; }
function no(st0, code) { return { ok: false, code, state: st0, effects: [] }; }

// ------------------------------------------------------------------------------------------------------ round start
function closeTable(st, effects, reason, now) {
    st.status = "closed";
    st.closed_reason = reason;
    st.closed_at = now;
    st.round = null;
    for (const u of st.seats) effects.push({ k: "left", who: u });
    if (st.rounds) effects.push({ k: "forget-whispers" });
}

function startNextRound(st, ctx, effects) {
    st.round = null;
    // spec rev 2: the admission check at every round setup; a failed check or a change seen earlier closes the table
    if (st.closing || ctx.admitted === false) return closeTable(st, effects, st.closing || "space-changed", ctx.now);
    for (;;) {
        if (st.seats.length < PLAYERS.min) return endTable(st, effects);
        const spinner = st.seats.find((u) => !st.spun.includes(u));
        if (!spinner) return endTable(st, effects);
        st.spun.push(spinner);
        const bal = (u) => Math.max(0, ctx.balances?.[u] ?? 0);
        const bankroll = Math.min(st.opts.bankroll, bal(spinner));
        if (bankroll < MONEY.bankroll_min) { st.skipped.push(spinner); continue; } // "not enough chips": sits in the House
        const house = st.seats.filter((u) => u !== spinner);
        const firstOfRun = st.rounds_in_run === 0;
        const preset = firstOfRun || st.seats.length === PLAYERS.min ? PRESETS.lite : PRESETS[st.opts.preset];
        // Mechanics: House members who can stake, fewest Mechanic turns first, then seat order after the Spinner.
        const si = st.seats.indexOf(spinner), n = st.seats.length;
        const dist = (u) => (st.seats.indexOf(u) - si + n) % n;
        const eligible = house.filter((u) => bal(u) >= MONEY.stake)
            .sort((a, b) => (st.mech_count[a] || 0) - (st.mech_count[b] || 0) || dist(a) - dist(b));
        const mechanics = eligible.slice(0, preset.live).sort((a, b) => dist(a) - dist(b));
        const seed = Buffer.from(ctx.newSeed());
        const deal = dealFor(seed, preset, mechanics.length);
        if (!deal) { st.skipped.push(spinner); continue; } // can't happen with these decks; never start a broken machine
        for (const u of mechanics) st.mech_count[u] = (st.mech_count[u] || 0) + 1;
        st.rounds += 1; st.rounds_in_run += 1;
        const r = st.rounds;
        const railbirds = house.filter((u) => bal(u) < RAILBIRD_BELOW);
        const R = {
            r, preset: preset.name, seed: seed.toString("hex"), commit: commitOf(seed),
            phase: "setup", deadline: ctx.now + TIMERS.setup,
            spinner, house, mechanics, railbirds, left: [],
            bank_start: bankroll, bankroll,
            dead: deal.dead, deals: Object.fromEntries(mechanics.map((u, m) => [u, deal.hands[m]])), kept: {},
            order: deal.slots, slots: [], greyed: Object.fromEntries(deal.dead.map((c) => [c, "dead"])),
            spins: preset.spins, spin: 1, dial: 1, calls_left: preset.calls, call_spin: 0, audit: null,
            timeouts: 0, away: { since: null, used: 0 },
            mutes: Object.fromEntries(mechanics.map((u) => [u, { left: preset.mutes, armed: false }])),
            nudge_left: Object.fromEntries(house.map((u) => [u, preset.nudges ? 1 : 0])),
            whispers: [], peeks: [], market: {}, market_done: [],
            pending: null, history: [], calls: [], refilled: [], patched: [],
            rake_to: {}, call_to: {}, bank: 0,
            escrow: {}, settled: null, end_reason: null,
        };
        st.round = R;
        st.status = "round";
        const esc = (who, amount, kind) => {
            R.escrow[who] = (R.escrow[who] || 0) + amount;
            effects.push({ k: "escrow", space: st.space, who, amount, kind, round: r });
        };
        esc(spinner, bankroll, "bankroll");
        for (const u of mechanics) esc(u, MONEY.stake, "stake");
        return;
    }
}

function endTable(st, effects) {
    st.status = "end";
    st.round = null;
    const leaderboard = Object.entries(st.board).map(([u, net]) => ({ u, net }))
        .sort((a, b) => b.net - a.net || st.seats.indexOf(a.u) - st.seats.indexOf(b.u));
    const top = leaderboard.length ? leaderboard[0].net : null;
    const pit_boss = leaderboard.filter((x) => x.net === top).map((x) => x.u);
    st.end = { leaderboard, pit_boss, skipped: [...st.skipped] };
    effects.push({ k: "table-end", leaderboard, pit_boss });
    effects.push({ k: "forget-whispers" });
    effects.push({ k: "post", kind: "summary", round: st.rounds });
}

function setupDone(R) {
    return R.mechanics.every((u) => R.kept[u] || R.left.includes(u)) &&
        R.house.filter((u) => !isRailbird(R, u) && !R.left.includes(u)).every((u) => R.market_done.includes(u));
}

function finishSetup(st, ctx) {
    const R = st.round;
    for (const u of R.mechanics) if (!R.kept[u]) R.kept[u] = R.deals[u][0];
    R.slots = R.order.map((m, i) => ({ slot: i, owner: R.mechanics[m], card: R.kept[R.mechanics[m]], from_spin: 1, busted_spin: null, stake: MONEY.stake }));
    toTurn(st, ctx);
}

function toTurn(st, ctx) {
    const R = st.round;
    R.phase = "turn";
    R.deadline = ctx.now + TIMERS.turn;
    R.dial = Math.min(R.dial, R.bankroll);
    R.away.since = st.offline.includes(R.spinner) ? ctx.now : null; // away when the turn starts: the budget drains
}

// ----------------------------------------------------------------------------------------------------------- spins
function doSpin(st, ctx, bet) {
    const R = st.round;
    const n = R.spin;
    const muted = [];
    const cards = liveSlots(R).sort((a, b) => a.slot - b.slot).map((s) => {
        const m = R.mutes[s.owner];
        const isMuted = !!(m && m.armed && !R.left.includes(s.owner));
        if (m && m.armed) { m.armed = false; if (isMuted) { m.left -= 1; muted.push(s.owner); } }
        return { card: s.card, owner: s.owner, muted: isMuted };
    });
    const seed = Buffer.from(R.seed, "hex");
    const honest = honestReels(seed, n);
    const src = rerollSource(seed, n);
    const rp = reelPhase({ bet, honest, cards, next: src.next });
    R.pending = { spin: n, bet, honest, after_cards: rp.after_cards, reel_touched: rp.touched, reel_bit: rp.bit, cards, muted, nudge: null };
    R.phase = "land";
    R.deadline = ctx.now + TIMERS.land;
}

function nudgeOpen(st) {
    const R = st.round;
    return presetOf(R).nudges && R.house.some((u) => !R.left.includes(u) && R.nudge_left[u] > 0);
}

function doPayout(st, ctx, effects) {
    const R = st.round;
    const p = R.pending;
    const final = applyNudge(p.after_cards, p.nudge);
    const history = R.history.map((h) => ({ result: h.result, reels: h.reels }));
    const pp = payoutPhase({ bet: p.bet, spin: p.spin, final, cards: p.cards, history });
    const bit = [...p.reel_bit, ...pp.bit];
    const { rake, bank_delta } = rakeOf({ bet: p.bet, payout: pp.payout, bit, cards: p.cards });
    R.bankroll += pp.payout - p.bet;
    for (const [u, v] of Object.entries(rake)) R.rake_to[u] = (R.rake_to[u] || 0) + v;
    R.bank += bank_delta;
    const stamps = [];
    if (p.nudge) stamps.push("nudged");
    const call = R.calls.find((c) => c.spin === p.spin);
    if (call) stamps.push(call.right ? "called-right" : "called-wrong");
    if (R.refilled.some((x) => x.spin === p.spin)) stamps.push("refilled");
    const rake_cards = {}; // the same rake, by the card that bit (each Mechanic has one live card)
    for (const card of bit) { const o = p.cards.find((c) => c.card === card).owner; if (rake[o] > 0) rake_cards[card] = rake[o]; }
    R.history.push({
        spin: p.spin, bet: p.bet, reels: final, payout: pp.payout, result: resultOf(pp.payout, p.bet), stamps,
        honest: p.honest, honest_payout: paytableOf(p.honest, p.bet), after_cards: p.after_cards,
        touched: [...p.reel_touched, ...pp.touched], bit, rake, rake_cards, bank_delta, muted: p.muted, nudge: p.nudge,
    });
    R.pending = null;
    if (R.force) return finishRound(st, ctx, effects, R.force); // e.g. the Spinner left while the reels landed
    if (R.bankroll <= 0) return finishRound(st, ctx, effects, "bust");
    if (R.bankroll - R.bank_start >= MONEY.round_cap) return finishRound(st, ctx, effects, "cap");
    if (R.spin >= R.spins) return finishRound(st, ctx, effects, "spins");
    R.spin += 1;
    toTurn(st, ctx);
}

// ------------------------------------------------------------------------------------------------------ settlement
function finishRound(st, ctx, effects, reason) {
    const R = st.round;
    if (R.phase === "setup") { // a forced Walk before spin 1: the machine is built from the defaults first
        for (const u of R.mechanics) if (!R.kept[u]) R.kept[u] = R.deals[u][0];
        R.slots = R.order.map((m, i) => ({ slot: i, owner: R.mechanics[m], card: R.kept[R.mechanics[m]], from_spin: 1, busted_spin: null, stake: MONEY.stake }));
    }
    R.end_reason = reason;
    const payouts = {}, lines = [];
    const pay = (who, amount, reason) => {
        if (!amount) return;
        payouts[who] = (payouts[who] || 0) + amount;
        lines.push({ who, amount, reason });
    };
    let bank = 0;
    // (1) the round log: the bankroll back to the Spinner, rake and wrong-Call shares to the Mechanics, the rest bank
    pay(R.spinner, R.bankroll, "rig:bankroll");
    for (const [u, v] of Object.entries(R.rake_to)) pay(u, v, "rig:rake");
    for (const [u, v] of Object.entries(R.call_to)) pay(u, v, "rig:call");
    bank += R.bank;
    // (2) stakes: busted → already the Spinner's (in the bankroll); every other stake back
    for (const s of R.slots) if (s.busted_spin == null) pay(s.owner, s.stake, "rig:stake");
    // (3) the Market
    const up = R.bankroll > R.bank_start;
    const bets = Object.entries(R.market).map(([who, b]) => ({ who, side: b.side, stake: b.stake }));
    const m = settleMarket(bets, up);
    for (const [u, v] of Object.entries(m.back)) pay(u, v, "rig:market");
    bank += m.bank;
    // (4) Peeks from one snapshot: each Mechanic's wallet now + what (1)–(3) pay them
    const snap = {};
    for (const p of R.peeks) {
        const b = ctx.balances?.[p.target];
        // never guess: a missing balance would shrink a bounty (pass every round participant's, even after they left)
        if (!Number.isInteger(b) || b < 0) throw new Error(`rig: the settlement needs ${p.target}'s balance`);
        snap[p.target] = b + (payouts[p.target] || 0);
    }
    const pk = settlePeeks(R.peeks.map((p) => ({ who: p.who, target: p.target, card: p.card, held: p.held })), snap).delta;
    const peekRows = R.peeks.map((p) => ({ who: p.who, target: p.target, card: p.card, right: p.card === p.held, spin: p.spin }));
    for (const [u, v] of Object.entries(pk)) pay(u, v, "rig:peek");
    // conservation, checked here so a broken rule can never move chips: Σ escrows = Σ payouts + bank
    const esc = Object.values(R.escrow).reduce((s, v) => s + v, 0);
    const out = Object.values(payouts).reduce((s, v) => s + v, 0);
    if (esc !== out + bank) throw new Error(`rig: settlement doesn't balance (${esc} ≠ ${out} + ${bank})`);
    const people = [...new Set([R.spinner, ...R.house, ...Object.keys(payouts)])];
    const net = Object.fromEntries(people.map((u) => [u, (payouts[u] || 0) - (R.escrow[u] || 0)]));
    for (const u of R.house) st.board[u] = (st.board[u] || 0) + net[u];
    const reveal = {
        r: R.r, preset: R.preset, reason, seed: R.seed, seed_commit: R.commit, spinner: R.spinner,
        bankroll: { start: R.bank_start, end: R.bankroll }, up,
        dead: R.dead,
        slots: R.slots.map((s) => ({ slot: s.slot, card: s.card, owner: s.owner, from_spin: s.from_spin, busted_spin: s.busted_spin })),
        mutes: R.history.flatMap((h) => h.muted.map((owner) => ({ spin: h.spin, owner }))),
        nudges: R.history.filter((h) => h.nudge).map((h) => ({ spin: h.spin, by: h.nudge.by, reel: h.nudge.reel, step: h.nudge.step })),
        calls: R.calls.map((c) => ({ spin: c.spin, card: c.card, right: c.right, owner: c.owner })),
        peeks: peekRows.map((p) => ({ ...p, delta: 0 })),
        market: bets.map((b) => ({ ...b, back: m.back[b.who] || 0 })),
        whispers: R.whispers.map((w) => ({ who: w.who, spin: w.spin, template: w.template, person: w.person, text: w.text })),
        spins: R.history.map((h) => ({
            spin: h.spin, bet: h.bet, honest: h.honest, after_cards: h.after_cards, final: h.reels, payout: h.payout,
            result: h.result, honest_payout: h.honest_payout, touched: h.touched, bit: h.bit, rake: h.rake, rake_cards: h.rake_cards,
        })),
        net,
    };
    // a Peek row's delta = what that Peek did for its placer (2 back + share, or 0)
    for (const row of reveal.peeks) {
        const same = R.peeks.filter((p) => p.target === row.target && p.card === p.held).length;
        if (row.right) {
            const bounty = Math.min(MONEY.peek_bounty, snap[row.target] + MONEY.peek * R.peeks.filter((p) => p.target === row.target && p.card !== p.held).length);
            row.delta = MONEY.peek + Math.floor(bounty / same);
        }
    }
    R.settled = { payouts, bank, net, lines };
    R.reveal = reveal;
    R.phase = "reveal";
    R.deadline = ctx.now + TIMERS.reveal;
    R.pending = null;
    effects.push({ k: "settle", space: st.space, round: R.r, idem: `rig:${st.table}:${R.r}:settle`, payouts, bank, lines, reveal, net });
    for (const u of R.left) effects.push({ k: "left", who: u });
    effects.push({ k: "post", kind: "result", round: R.r });
}

export function voidRound(st0, ctx) {
    const st = clone(st0);
    const R = st.round;
    if (!R || R.phase === "reveal") return { state: st0, effects: [] };
    const effects = [{ k: "void", space: st.space, round: R.r, refunds: { ...R.escrow } }];
    for (const u of R.left) effects.push({ k: "left", who: u });
    st.round = null;
    st.status = "lobby"; // a called-off table is closed by the platform (restart / off): it never resumes
    st.voided = (st.voided || 0) + 1;
    bump(st);
    return { state: st, effects };
}

// ----------------------------------------------------------------------------------------------------------- timers
export function tick(st0, ctx) {
    const st = clone(st0);
    const effects = [];
    let changed = false;
    for (let guard = 0; guard < 64; guard++) {
        const R = st.round;
        const due = nextDeadline(st);
        if (due == null || ctx.now < due) break;
        changed = true;
        if (R.phase === "setup") finishSetup(st, ctx);
        else if (R.phase === "turn") {
            if (R.away.since != null) { finishRound(st, ctx, effects, "away"); continue; }
            R.timeouts += 1;
            if (R.timeouts >= TIMEOUTS_TO_WALK) finishRound(st, ctx, effects, "timeouts");
            else doSpin(st, ctx, Math.min(R.dial, R.bankroll));
        } else if (R.phase === "land") {
            if (nudgeOpen(st)) { R.phase = "nudge"; R.deadline = ctx.now + TIMERS.nudge; } else doPayout(st, ctx, effects);
        } else if (R.phase === "nudge") doPayout(st, ctx, effects);
        else if (R.phase === "reveal") startNextRound(st, ctx, effects);
    }
    if (!changed) return { state: st0, effects: [] };
    bump(st);
    return { state: st, effects };
}

// Who is connected (any seated player; the platform calls it when someone's last socket for the table goes or comes
// back). For the Spinner in their turn the turn clock stops while they're away and a 45 s budget per round drains
// instead (reconnecting doesn't refill it); the budget spent = a forced Walk (tick does it). A Spinner who is already
// away when their turn starts gets the same pause. Once a deadline is due, a reconnect changes no clock: tick decides.
export function setOnline(st0, who, online, ctx) {
    if (st0.offline.includes(who) === !online) return { state: st0, effects: [] };
    const st = clone(st0);
    st.offline = online ? st.offline.filter((u) => u !== who) : [...st.offline, who];
    const R = st.round;
    const due = nextDeadline(st0);
    if (R && st.status === "round" && R.spinner === who && R.phase === "turn" && !(due != null && ctx.now >= due)) {
        const A = R.away;
        if (!online && A.since == null) A.since = ctx.now;
        else if (online && A.since != null) {
            const gone = ctx.now - A.since;
            R.deadline += gone;
            A.used += gone;
            A.since = null;
        }
    }
    bump(st);
    return { state: st, effects: [] };
}

// The room's game space changed (spec rev 2): a round in progress finishes and settles into the table's space;
// then (or now, with no round running) the table closes and everyone is cashed out.
export function spaceChanged(st0, ctx) {
    if (st0.status === "closed") return { state: st0, effects: [] };
    const st = clone(st0);
    const effects = [];
    st.closing = "space-changed";
    if (st.status !== "round" || !st.round || st.round.phase === "reveal") closeTable(st, effects, "space-changed", ctx.now);
    bump(st);
    return { state: st, effects };
}

// ------------------------------------------------------------------------------------------------------------ moves
const TABLE_MOVES = new Set(["join", "leave", "start", "kick", "close"]);

export function act(st0, who, a, ctx) {
    if (!a || typeof a !== "object" || typeof a.do !== "string") return no(st0, "bad");
    if (st0.status === "closed") return no(st0, "no-table");
    const st = clone(st0);
    const effects = [];
    const bal = Math.max(0, ctx.balances?.[who] ?? 0);
    const due = nextDeadline(st0);
    const late = due != null && ctx.now >= due; // a timer is due: it acts first (the platform runs tick)
    if (TABLE_MOVES.has(a.do)) {
        if (a.do !== "leave" && a.do !== "join") { // leaving is always honoured; joining carries no turn
            if (late && st0.status === "round") return no(st0, "stale");
            const at = a.at, R0 = st0.status === "round" ? st0.round : null;
            if (at != null && (typeof at !== "object" || at.round !== (R0 ? R0.r : st0.rounds) ||
                (at.spin != null && at.spin !== R0?.spin) || (at.phase != null && at.phase !== R0?.phase))) return no(st0, "stale");
        }
        return tableMove(st0, st, who, a, ctx, effects);
    }
    if (!st.seats.includes(who)) return no(st0, "not-member");
    const R = st.round;
    if (!R || st.status !== "round") return no(st0, "phase");
    if (late) return no(st0, "stale");
    if (!inRound(R, who) || R.left.includes(who)) return no(st0, "not-your-turn");
    if (a.do === "nudge" && R.phase !== "nudge" && R.spinner !== who) {
        // too late: "taken" if someone else's Nudge closed the window this move was aimed at, else "window"
        const h = a.at && R.history.find((x) => x.spin === a.at.spin);
        return no(st0, h && h.nudge && h.nudge.by !== who ? "taken" : "window");
    }
    if (a.at != null) {
        const at = a.at;
        // the contract numbers SETUP as spin 0 (the engine counts it as spin 1's lead-in): both name SETUP
        const spinOk = at.spin == null || at.spin === R.spin || (R.phase === "setup" && at.spin === 0);
        if (typeof at !== "object" || at.round !== R.r || !spinOk || (at.phase != null && at.phase !== R.phase)) return no(st0, "stale");
    }
    const P = presetOf(R);
    const spinner = R.spinner === who;
    switch (a.do) {
    case "keep": {
        if (R.phase !== "setup") return no(st0, "phase");
        if (!R.mechanics.includes(who)) return no(st0, "not-your-turn");
        if (R.kept[who]) return no(st0, "limit");
        if (!R.deals[who].includes(a.card)) return no(st0, "bad");
        R.kept[who] = a.card;
        if (setupDone(R)) finishSetup(st, ctx);
        return ok(st, effects);
    }
    case "market": {
        if (R.phase !== "setup") return no(st0, "phase");
        if (spinner || !R.house.includes(who) || isRailbird(R, who)) return no(st0, "not-your-turn");
        if (R.market_done.includes(who)) return no(st0, "limit");
        if (a.side === "pass" || a.side == null) {
            R.market_done.push(who);
        } else {
            if (a.side !== "up" && a.side !== "not-up") return no(st0, "bad");
            if (!isInt(a.stake) || a.stake < MONEY.market_min || a.stake > MONEY.market_max) return no(st0, "bad-amount");
            if (bal < a.stake) return no(st0, "no-chips");
            R.market[who] = { side: a.side, stake: a.stake };
            R.market_done.push(who);
            R.escrow[who] = (R.escrow[who] || 0) + a.stake;
            effects.push({ k: "escrow", space: st.space, who, amount: a.stake, kind: "market", round: R.r });
        }
        if (setupDone(R)) finishSetup(st, ctx);
        return ok(st, effects);
    }
    case "dial": {
        if (!spinner) return no(st0, "not-your-turn");
        if (R.phase !== "turn") return no(st0, "phase");
        if (!isInt(a.bet) || a.bet < MONEY.bet_min || a.bet > MONEY.bet_max) return no(st0, "bad-amount");
        if (a.bet > R.bankroll) return no(st0, "no-chips");
        R.dial = a.bet;
        effects.push({ k: "live", dial: a.bet });
        return ok(st, effects);
    }
    case "spin": {
        if (!spinner) return no(st0, "not-your-turn");
        if (R.phase !== "turn") return no(st0, "phase");
        const bet = a.bet ?? R.dial;
        if (!isInt(bet) || bet < MONEY.bet_min || bet > MONEY.bet_max) return no(st0, "bad-amount");
        if (bet > R.bankroll) return no(st0, "no-chips");
        R.dial = bet;
        R.timeouts = 0;
        doSpin(st, ctx, bet);
        return ok(st, effects);
    }
    case "call": {
        if (!spinner) return no(st0, "not-your-turn");
        if (R.phase !== "turn") return no(st0, "phase");
        if (R.calls_left <= 0 || R.call_spin === R.spin) return no(st0, "limit");
        if (R.bankroll < MONEY.call_needs) return no(st0, "no-chips");
        if (!P.deck.includes(a.card)) return no(st0, "bad");
        if (R.greyed[a.card]) return no(st0, "greyed");
        R.calls_left -= 1;
        R.call_spin = R.spin;
        const slot = liveSlots(R).find((s) => s.card === a.card);
        if (slot) {
            slot.busted_spin = R.spin;
            R.greyed[a.card] = "busted";
            R.bankroll += slot.stake; // the stake was escrowed; it moves into the bankroll in the round log
            if (R.mutes[slot.owner]) R.mutes[slot.owner].armed = false;
            R.calls.push({ spin: R.spin, card: a.card, right: true, owner: slot.owner });
        } else {
            R.greyed[a.card] = "wrong";
            R.bankroll -= MONEY.wrong_call;
            const owners = liveSlots(R).map((s) => s.owner);
            if (owners.length) {
                const share = Math.floor(MONEY.wrong_call / owners.length);
                for (const o of owners) R.call_to[o] = (R.call_to[o] || 0) + share;
                R.bank += MONEY.wrong_call - share * owners.length;
            } else R.bank += MONEY.wrong_call;
            R.calls.push({ spin: R.spin, card: a.card, right: false, owner: null });
            if (R.dial > R.bankroll && R.bankroll > 0) { R.dial = R.bankroll; effects.push({ k: "live", dial: R.dial }); }
            if (R.bankroll <= 0) finishRound(st, ctx, effects, "bust");
        }
        return ok(st, effects);
    }
    case "audit": {
        if (!spinner) return no(st0, "not-your-turn");
        if (R.phase !== "turn") return no(st0, "phase");
        if (R.audit) return no(st0, "limit");
        const h = R.history.find((x) => x.spin === a.spin);
        if (!isInt(a.spin) || !h) return no(st0, "bad");
        R.audit = { spin: h.spin, honest_reels: h.honest, honest_payout: h.honest_payout, touched: h.touched.length };
        h.stamps.push("audited");
        return ok(st, effects);
    }
    case "walk": {
        if (!spinner) return no(st0, "not-your-turn");
        if (R.phase !== "turn") return no(st0, "phase");
        if (R.spin < P.walk_from) return no(st0, "phase");
        finishRound(st, ctx, effects, "walk");
        return ok(st, effects);
    }
    case "mute": {
        if (!P.mutes) return no(st0, "phase");
        if (R.phase !== "turn") return no(st0, "phase");
        const m = R.mutes[who];
        if (!m || !liveCardOf(R, who)) return no(st0, "not-your-turn");
        if (a.armed === true) { if (m.left <= 0) return no(st0, "limit"); m.armed = true; }
        else if (a.armed === false) m.armed = false;
        else return no(st0, "bad");
        return ok(st, effects);
    }
    case "patch": {
        if (!P.patch || !st.opts.patch) return no(st0, "phase");
        if (R.phase !== "turn") return no(st0, "phase");
        const busted = R.slots.find((s) => s.owner === who && s.busted_spin === R.spin && R.call_spin === R.spin);
        if (!busted || R.patched.includes(who) || liveCardOf(R, who)) return no(st0, "not-your-turn");
        const card = R.deals[who].find((c) => c !== busted.card);
        if (R.greyed[card]) return no(st0, "greyed");
        // can't fire with a legal deal (every one-card-per-hand choice passes); kept as the spec's guard
        if (!machineOk([...liveSlots(R).map((s) => s.card), card]).ok) return no(st0, "rules");
        if (bal < MONEY.stake) return no(st0, "no-chips");
        R.slots.push({ slot: busted.slot, owner: who, card, from_spin: R.spin, busted_spin: null, stake: MONEY.stake });
        R.patched.push(who);
        R.refilled.push({ spin: R.spin });
        R.escrow[who] = (R.escrow[who] || 0) + MONEY.stake;
        effects.push({ k: "escrow", space: st.space, who, amount: MONEY.stake, kind: "patch", round: R.r });
        return ok(st, effects);
    }
    case "nudge": {
        if (spinner) return no(st0, "not-your-turn");
        if (!P.nudges) return no(st0, "phase");
        if (!isInt(a.reel) || a.reel < 1 || a.reel > 3 || (a.step !== 1 && a.step !== -1)) return no(st0, "bad");
        if ((R.nudge_left[who] || 0) <= 0) return no(st0, "limit");
        R.nudge_left[who] -= 1;
        R.pending.nudge = { by: who, reel: a.reel, step: a.step };
        doPayout(st, ctx, effects); // the first tap wins and closes the window at once
        return ok(st, effects);
    }
    case "whisper": {
        if (spinner) return no(st0, "not-your-turn");
        if (!P.whispers) return no(st0, "phase");
        if (R.phase === "reveal") return no(st0, "phase");
        if (R.whispers.some((w) => w.who === who)) return no(st0, "limit");
        let text;
        if (a.template != null) {
            if (!own(WHISPER_TEMPLATES, a.template)) return no(st0, "bad");
            const t = WHISPER_TEMPLATES[a.template];
            if (t.includes("{person}")) {
                if (!st.seats.includes(a.person) && !inRound(R, a.person)) return no(st0, "bad");
                text = t; // {person} stays a placeholder: the apps draw the name; the mxid travels beside it
            } else text = t;
        } else {
            if (checkWhisperText(a.text)) return no(st0, "bad");
            text = a.text;
        }
        R.whispers.push({ who, template: a.template ?? null, person: a.template === "bluffing" ? a.person : null, text, spin: R.phase === "setup" ? 0 : R.spin });
        return ok(st, effects);
    }
    case "peek": {
        if (spinner || isRailbird(R, who)) return no(st0, "not-your-turn");
        if (!["turn", "land", "nudge"].includes(R.phase)) return no(st0, "phase");
        if (R.spin > P.peek_lock_after) return no(st0, "locked");
        if (R.peeks.some((p) => p.who === who)) return no(st0, "limit");
        if (a.mechanic === who) return no(st0, "bad");
        const held = liveCardOf(R, a.mechanic);
        if (!held) return no(st0, "bad");
        if (!P.deck.includes(a.card)) return no(st0, "bad");
        if (bal < MONEY.peek) return no(st0, "no-chips");
        R.peeks.push({ who, target: a.mechanic, card: a.card, held, spin: R.spin });
        R.escrow[who] = (R.escrow[who] || 0) + MONEY.peek;
        effects.push({ k: "escrow", space: st.space, who, amount: MONEY.peek, kind: "peek", round: R.r });
        return ok(st, effects);
    }
    default:
        return no(st0, "bad");
    }
}

function tableMove(st0, st, who, a, ctx, effects) {
    const host = st.host === who;
    const R = st.round;
    switch (a.do) {
    case "join": {
        if (a.space !== st.space) return no(st0, "space-changed"); // before any debit (spec rev 2)
        if (st.seats.includes(who)) return no(st0, "seated");
        if (st.seats.length >= PLAYERS.max) return no(st0, "table-full");
        // the table's roster also lists this round's players who left (until the reveal ends): 8 at most in all
        const roster = new Set([...st.seats, ...(R && st.status === "round" ? [R.spinner, ...R.house] : [])]);
        if (!roster.has(who) && roster.size >= PLAYERS.max) return no(st0, "table-full");
        st.seats.push(who); // mid-round: waits for the next round (and spins in this rotation if it reaches them)
        return ok(st, effects);
    }
    case "leave": {
        if (!st.seats.includes(who)) return no(st0, "not-member");
        st.seats = st.seats.filter((u) => u !== who);
        if (host) st.host = st.seats[0] ?? st.host; // the last one out stays the (closed) table's host
        if (R && st.status === "round" && inRound(R, who) && R.phase !== "reveal") {
            R.left.push(who); // dropped: Market bet and Peek stand; a Mechanic's card stays live (no Mutes)
            if (R.mutes[who]) R.mutes[who].armed = false;
            if (R.spinner === who) {
                if (R.pending) R.force = "left"; // the spin they started lands as usual (Nudge window included), then it settles
                else finishRound(st, ctx, effects, "left");
            }
            else if (R.phase === "setup" && setupDone(R)) finishSetup(st, ctx);
        } else {
            if (R && st.status === "round" && inRound(R, who) && !R.left.includes(who)) R.left.push(who); // in REVEAL
            effects.push({ k: "left", who });
        }
        if (!st.seats.length) {
            // a round still to settle (a spin landing) settles first; the table closes when it would start the next
            if (st.status === "round" && R && R.phase !== "reveal") st.closing = "empty";
            else closeTable(st, effects, "empty", ctx.now);
        }
        return ok(st, effects);
    }
    case "start": {
        if (!host) return no(st0, "host-only");
        if (st.status !== "lobby" && st.status !== "end") return no(st0, "phase");
        if (st.seats.length < PLAYERS.min) return no(st0, "phase");
        // nobody can fund a bankroll: no round could start (a table never ends with zero rounds)
        if (!st.seats.some((u) => (ctx.balances?.[u] ?? 0) >= MONEY.bankroll_min)) return no(st0, "no-chips");
        const o = { ...st.opts };
        if (a.preset != null) { if (!own(PRESETS, a.preset)) return no(st0, "bad"); o.preset = a.preset; }
        if (a.bankroll != null) {
            if (!isInt(a.bankroll) || a.bankroll < MONEY.bankroll_min || a.bankroll > MONEY.bankroll_max) return no(st0, "bad-amount");
            o.bankroll = a.bankroll;
        }
        if (a.patch != null) { if (typeof a.patch !== "boolean") return no(st0, "bad"); o.patch = a.patch; }
        st.opts = o;
        st.run += 1; st.rounds_in_run = 0; st.spun = []; st.skipped = []; st.board = {}; st.end = null;
        startNextRound(st, ctx, effects);
        return ok(st, effects);
    }
    case "kick": {
        if (!host) return no(st0, "host-only");
        if (a.u === who || !st.seats.includes(a.u)) return no(st0, "bad");
        if (st.status === "round" && R && R.phase !== "reveal") return no(st0, "phase"); // between rounds only
        st.seats = st.seats.filter((u) => u !== a.u);
        if (R && st.status === "round" && inRound(R, a.u) && !R.left.includes(a.u)) R.left.push(a.u); // in REVEAL
        effects.push({ k: "left", who: a.u });
        return ok(st, effects);
    }
    case "close": {
        if (!host) return no(st0, "host-only");
        if (st.status === "round" && R && R.phase !== "reveal") return no(st0, "phase");
        closeTable(st, effects, "host", ctx.now);
        return ok(st, effects);
    }
    }
    return no(st0, "bad");
}

// ------------------------------------------------------------------------------------------------------------ views
function roleOf(st, u) {
    const R = st.round;
    if (!st.seats.includes(u) && !(R && inRound(R, u))) return "spectator";
    if (!R || st.status !== "round") return "seated";
    if (!inRound(R, u)) return "waiting";
    if (R.spinner === u) return "spinner";
    if (R.phase === "setup" ? R.mechanics.includes(u) : liveCardOf(R, u)) return "mechanic";
    if (isRailbird(R, u)) return "railbird";
    return "sharp";
}

// The caller's view: public fields for everyone, `you` for the caller's own secrets, `reveal` only once settled.
export function viewFor(st, who, now) {
    const body = viewBody(st, who);
    const key = Object.hasOwn(st.vs, who) ? who : SPECTATOR;
    return { game: body.game, table: body.table, space: body.space, vseq: st.vs[key].v, now, ...body };
}

function viewBody(st, who) {
    const R = st.round;
    const live = R && st.status === "round";
    const players = [...new Set([...st.seats, ...(live ? [R.spinner, ...R.house] : [])])]
        .map((u, i) => ({
            u, role: roleOf(st, u), ...(R && R.left.includes(u) ? { left: true } : {}), order: i + 1,
            connected: !st.offline.includes(u), skipped: st.skipped.includes(u),
            spun: st.spun.includes(u) && !(live && R.spinner === u && R.phase !== "reveal"), // this table's rotation
        }));
    const view = {
        game: "rig", table: st.table, space: st.space, status: st.status, host: st.host,
        ...(st.status === "closed" ? { closed_reason: st.closed_reason ?? null, closed_at: st.closed_at ?? null } : {}),
        opts: { ...st.opts }, players,
    };
    if (st.status === "end" && st.end) view.table_end = { rounds: st.rounds_in_run, leaderboard: st.end.leaderboard, pit_boss: st.end.pit_boss };
    if (!R || st.status !== "round") { view.you = { role: roleOf(st, who) }; return view; }
    const P = presetOf(R);
    const board = P.deck.map((card) => {
        const g = R.greyed[card];
        if (g === "busted") {
            const s = R.slots.find((x) => x.card === card && x.busted_spin != null);
            return { card, state: "busted", by: s.owner, spin: s.busted_spin };
        }
        return { card, state: g || "open" };
    });
    view.round = {
        r: R.r, preset: R.preset, spinner: R.spinner, mechanics: R.phase === "setup" ? [...R.mechanics] : liveSlots(R).map((s) => s.owner).sort((a, b) => R.mechanics.indexOf(a) - R.mechanics.indexOf(b)),
        phase: R.phase, spin: R.spin, spins: R.spins, deadline: nextDeadline(st),
        // the Spinner is away in their turn: `deadline` is then when their 45 s budget runs out (the forced Walk)
        paused: R.phase === "turn" && R.away.since != null, seed_commit: R.commit,
        bankroll: { start: R.bank_start, now: R.bankroll }, dial: R.dial, calls_left: R.calls_left,
        call_used_this_spin: R.call_spin === R.spin, audit_used: !!R.audit, walk_from: P.walk_from,
        peek_lock_after: P.peek_lock_after, dead: [...R.dead], board, refilled: R.refilled.map((x) => ({ ...x })),
        history: R.history.map((h) => ({ spin: h.spin, bet: h.bet, reels: [...h.reels], payout: h.payout, result: h.result, stamps: [...h.stamps] })),
        nudges: P.nudges, whispers: P.whispers, mutes: P.mutes > 0, patch: P.patch && st.opts.patch,
        roster: [...R.mechanics], // the round's Mechanics (public; a busted one stays on it)
        bet: R.pending ? R.pending.bet : null,
        waiting_on: R.phase === "setup" ? new Set([
            ...R.mechanics.filter((u) => !R.kept[u] && !R.left.includes(u)),
            ...R.house.filter((u) => !isRailbird(R, u) && !R.left.includes(u) && !R.market_done.includes(u)),
        ]).size : 0,
    };
    if (R.pending && (R.phase === "land" || R.phase === "nudge")) {
        view.round.landing = { spin: R.pending.spin, bet: R.pending.bet, reels: [...R.pending.after_cards] };
    }
    const role = roleOf(st, who);
    const you = { role };
    if (R.left.includes(who)) you.role = "left"; // left this round: no secrets any more (their wagers stand)
    else if (role === "spinner") {
        you.whispers = R.whispers.map((w) => ({ spin: w.spin, template: w.template, person: w.person, text: w.text }));
        if (R.audit) view.round.audit = { ...R.audit, honest_reels: [...R.audit.honest_reels] };
        you.walk_ok = R.phase === "turn" && R.spin >= P.walk_from;
        you.timeouts = R.timeouts;
    } else if (inRound(R, who) && !R.left.includes(who)) {
        if (R.mechanics.includes(who)) {
            if (R.phase === "setup" && !R.kept[who]) you.deal = [...R.deals[who]];
            if (R.kept[who]) you.kept = R.kept[who];
            const card = liveCardOf(R, who);
            if (card) {
                you.card = { card, bite: CARDS[card].bite };
                you.mutes_left = R.mutes[who].left;
                you.armed = R.mutes[who].armed;
            } else if (R.phase === "setup" && R.kept[who]) {
                you.card = { card: R.kept[who], bite: CARDS[R.kept[who]].bite };
                you.mutes_left = R.mutes[who].left;
                you.armed = false;
            }
            you.rake = (R.rake_to[who] || 0);
            you.call_shares = (R.call_to[who] || 0);
            const busted = R.slots.find((s) => s.owner === who && s.busted_spin != null);
            if (busted) {
                you.busted = { card: busted.card, spin: busted.busted_spin };
                const card2 = R.deals[who].find((c) => c !== busted.card);
                if (P.patch && st.opts.patch && !R.patched.includes(who) && busted.busted_spin === R.spin && R.phase === "turn") {
                    // only public facts: the deal makes every one-card-per-hand machine legal, so the rules check in
                    // the move can't refuse a Patch, and a view never computes anything from other people's cards
                    you.patch = { card: card2, ok: !R.greyed[card2] };
                }
            }
        }
        you.nudge_left = R.nudge_left[who] || 0;
        you.whisper_used = R.whispers.some((w) => w.who === who);
        if (!isRailbird(R, who)) {
            const p = R.peeks.find((x) => x.who === who);
            you.peek = { placed: !!p, ...(p ? { mechanic: p.target, card: p.card } : {}), locks_after: P.peek_lock_after, locked: R.spin > P.peek_lock_after };
            you.market = R.market[who] ? { ...R.market[who] } : R.market_done.includes(who) ? { side: "pass", stake: 0 } : null;
        }
    }
    view.you = you;
    if (R.phase === "reveal" && R.reveal) view.reveal = clone(R.reveal);
    return view;
}
