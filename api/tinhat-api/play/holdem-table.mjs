// play/holdem-table.mjs — a Hold'em table: seats, the dealer state machine, timers, sit-out, leaving, void, close
// (GAMES-V1-SPEC §4.1–§4.3). PURE: no I/O, no clock, no ledger. Every call takes the table state (plain JSON, what the
// server keeps in play_games.state) and returns a NEW state plus the EFFECTS the server must make durable in the same
// transaction (money moves for the ledger, cash-outs, the close). A refused move returns the input state unchanged.
//
//   createTable({ host, space, opts, now })              → state (bound to its game space for life: spec rev 2 §1.1)
//   move(state, m, ctx)                                  → { ok, code?, state, effects }
//     m = { do, by, ...args } (spec §6.3 moves: sit {seat?, chips}, leave, deal, fold, check, call, raise {to}, allin,
//         away {on}, kick {target}, close; acting moves carry at: {hand, turn});
//     system moves (ctx.system = true, from the server itself): credit {target, amount}, tick, void {reason?}
//         (call the open hand off, then close: §4.2 VOID / the drain), close {reason}.
//     ctx = { now (ms, required), randomInt? (tests; default crypto.randomInt), system?,
//             admitted? (the server's admission check: the room's current game space is still this table's space;
//                        REQUIRED whenever the move would start a hand, see wouldDeal) }
//   wouldDeal(state, m, now)                             → true when this move would start a hand (so the server runs
//                                                          its admission check first and passes ctx.admitted)
//   nextWake(state)                                      → ms of the next timer (deadline, pause, away, empty) | null
//   viewFor(state, { viewer, nameOf })                   → the §4.3 view minus what the server adds (vseq, now,
//                                                          table, you.screens, you.at_cap)
//   handRecord(state) / historyFor(record, id)           → the hand log entry (30 days) and one player's copy of it
//
// Seats are numbered 1..opts.seats, clockwise = ascending. Players are opaque ids (the server's wallet ids); `nameOf`
// maps them to Matrix ids for a view. Effects name ids, never Matrix ids:
//   { t: "sit",     seat, id, amount }            wallet → seat (all the player's chips)
//   { t: "credit",  seat, id, amount }            wallet → seat (chips earned / topped up while seated)
//   { t: "deal",    hand, button, seats: [{ seat, id, stack }] }   a hand starts (play_games row, disposition open)
//   { t: "bet",     hand, turn, seat, id, amount, a }  seat → that player's own pot account (a: sb|bb|call|bet|raise|allin)
//   { t: "settle",  hand, from: { id: n }, to: { id: n } }  every pot account of the hand → the seats; disposition settled
//   { t: "void",    hand, refunds: { id: n } }     each pot account back to its owner's seat; disposition voided
//   { t: "cashout", seat, id, amount, reason }     seat → wallet, then the prestige check (reason: leave|kick|away|close)
//   { t: "table-end", summary: { hands, net: { id: n }, biggest } }   the summary card's numbers (settled hands)
//   { t: "post",    kind: "summary" }              ask an app to post the table summary card (when hands > 0)
//   { t: "closed",  reason }                        the table is closed (after the cash-outs above)
// Every account and transaction of a table belongs to the table's space (state.space, the server's sid): settlement
// and void never re-check the space (they always pay into the table's space). A space change seen mid-hand: the
// server sends the system move close {reason: "space-changed"}; the hand finishes, then the table closes. Seen at a
// hand start (ctx.admitted === false): no hand, the table closes and everyone is cashed out.
import { randomInt as cryptoRandomInt } from "node:crypto";
import { shuffledDeck } from "./holdem-cards.mjs";
import { showdown } from "./holdem-rank.mjs";
import { buildPots, settlePots } from "./holdem-pots.mjs";
import { startBetting, act, legal, BetError, putIn, liveSeats } from "./holdem-betting.mjs";

/** Every Hold'em number is one named value here (spec §4.1; the §10 Q4 defaults). */
export const HOLDEM = Object.freeze({
    SB: 1,
    BB: 2,
    SEATS_MIN: 2,
    SEATS_MAX: 8,
    SEATS_DEFAULT: 8,
    TURN_S: 30, // per decision
    PAUSE_MS: 5_000, // between hands (the next deal starts by itself)
    // B10 away (addendum v1.1 §8.1; CHANGES v1 "two timeouts"): ONE timeout → away from the next hand; later turns of
    // an automatically-away player in the current hand are acted at once; a player with no socket on the table for
    // GONE_MS when a hand is dealt is dealt out; away for AWAY_STAND_HANDS dealt-out hands or AWAY_STAND_MS → stand up
    // (the v1 leave: deferred to the end of a hand they still have money in; cash-out to the wallet, chips kept)
    AWAY_AFTER_TIMEOUTS: 1,
    AWAY_INSTANT_ACT: true,
    GONE_MS: 20_000,
    AWAY_STAND_HANDS: 6,
    AWAY_STAND_MS: 10 * 60_000,
    EMPTY_CLOSE_MS: 10 * 60_000, // nobody seated this long → the table closes
    MIN_TO_SIT: 1,
    MAX_CHIPS: 2 ** 40, // sanity bound on any amount handed in
});

export class PlayError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const fail = (code) => { throw new PlayError(code); };

export function createTable({ host, space, opts = {}, now }) {
    if (!Number.isFinite(now)) throw new TypeError("now is required");
    if (typeof space !== "string" || !space) throw new TypeError("space is required (the table's game space)");
    const seats = opts.seats ?? HOLDEM.SEATS_DEFAULT;
    if (!Number.isInteger(seats) || seats < HOLDEM.SEATS_MIN || seats > HOLDEM.SEATS_MAX) throw new PlayError("bad");
    return {
        v: 1,
        game: "holdem",
        space,
        opts: { sb: HOLDEM.SB, bb: HOLDEM.BB, seats, turn_s: HOLDEM.TURN_S },
        status: "lobby", // lobby | hand | pause | closed
        host: host ?? null,
        n: 0, // hands dealt
        button: null, // the last hand's button seat
        seq: 0, // seating order (the longest-seated player becomes host)
        seats: {},
        hand: null,
        closing: null, // a close asked for during a hand: its reason
        pauseUntil: null,
        emptySince: now,
        closed: null,
        summary: { hands: 0, net: {}, biggest: 0 }, // the table summary card (§4.3): settled hands only
    };
}

// ---------------------------------------------------------------------------------------------------------------- moves

export function move(state, m, ctx = {}) {
    if (!Number.isFinite(ctx.now)) throw new TypeError("ctx.now is required");
    const T = structuredClone(state);
    const fx = [];
    const c = { now: ctx.now, randomInt: ctx.randomInt || cryptoRandomInt, admitted: ctx.admitted,
        gone: ctx.gone instanceof Set ? ctx.gone : new Set(ctx.gone || []) }; // ids with no socket on the table for GONE_MS
    try {
        if (!m || typeof m.do !== "string") fail("bad");
        if (T.status === "closed") fail("phase");
        const SYSTEM = new Set(["credit", "tick", "void"]);
        if (SYSTEM.has(m.do) && ctx.system !== true) fail("bad");
        switch (m.do) {
            case "sit": sit(T, m, c, fx); break;
            case "leave": leaveSeat(T, seatOf(T, m.by) ?? fail("bad"), "leave", c, fx); break;
            case "away": away(T, m, c); break;
            case "deal":
                hostOnly(T, m, ctx);
                if (T.status !== "lobby") fail("phase");
                if (!dealHand(T, c, fx)) fail("bad-action");
                break;
            case "fold": case "check": case "call": case "raise": case "allin": play(T, m, c, fx); break;
            case "kick": {
                hostOnly(T, m, ctx);
                // between hands only: a kick mid-hand would fold the target the moment the action reached them,
                // i.e. let the host force an opponent to fold (review round 1 P1)
                if (handOpen(T)) fail("phase");
                const s = seatOf(T, m.target);
                if (s === null) fail("bad");
                leaveSeat(T, s, "kick", c, fx);
                break;
            }
            case "close":
                if (ctx.system !== true) hostOnly(T, m, ctx);
                requestClose(T, ctx.system === true ? (m.reason || "system") : "host", c, fx);
                break;
            case "credit": credit(T, m, fx); break;
            case "tick": tick(T, c, fx); break;
            case "void": voidHand(T, m.reason || "void", c, fx); break;
            default: fail("bad");
        }
    } catch (e) {
        if (e instanceof PlayError || e instanceof BetError) {
            const code = e.code === "no-turn" ? "not-your-turn" : e.code;
            return { ok: false, code, state, effects: [] };
        }
        throw e;
    }
    return { ok: true, state: T, effects: fx };
}

function hostOnly(T, m, ctx) {
    if (ctx.system === true) return;
    if (m.by === undefined || m.by === null || m.by !== T.host) fail("host-only");
}

function seatOf(T, id) {
    if (id === undefined || id === null) return null;
    for (const [s, x] of Object.entries(T.seats)) if (x.id === id) return Number(s);
    return null;
}

const handOpen = (T) => T.hand !== null && !T.hand.done;
/** Seat s's CURRENT occupant was dealt into T.hand (a seat number alone isn't enough: after a hand someone else can
 *  sit where a leaver sat, and must never inherit that hand's cards or state). */
const inHandSeat = (T, s) => T.hand !== null && T.hand.order.includes(s) && !!T.seats[s] && T.hand.ids[s] === T.seats[s].id;
const dealtIn = (T, s) => handOpen(T) && inHandSeat(T, s);
const amountOk = (n) => Number.isSafeInteger(n) && n >= 0 && n <= HOLDEM.MAX_CHIPS;

function sit(T, m, c, fx) {
    if (m.by === undefined || m.by === null) fail("bad");
    if (m.space !== T.space) fail("space-changed"); // the app's idea of the room's space is stale: refuse before any debit
    if (seatOf(T, m.by) !== null) fail("seated");
    if (!amountOk(m.chips)) fail("bad");
    if (m.chips < HOLDEM.MIN_TO_SIT) fail("no-chips");
    let seat;
    if (m.seat !== undefined && m.seat !== null) {
        if (!Number.isInteger(m.seat) || m.seat < 1 || m.seat > T.opts.seats) fail("bad");
        if (T.seats[m.seat]) fail(freeSeats(T).length ? "bad" : "table-full");
        seat = m.seat;
    } else {
        seat = freeSeats(T)[0] ?? fail("table-full");
    }
    T.seq += 1;
    T.seats[seat] = { id: m.by, stack: m.chips, pending: 0, seq: T.seq, away: false, awaySince: null, awayAuto: false, awayReason: null, awayHands: 0, timeouts: 0, leaving: false };
    if (T.host === null) T.host = m.by;
    T.emptySince = null;
    fx.push({ t: "sit", seat, id: m.by, amount: m.chips });
}

function freeSeats(T) {
    const out = [];
    for (let s = 1; s <= T.opts.seats; s++) if (!T.seats[s]) out.push(s);
    return out;
}

/** Sets a seat away from the next hand. reason: timeout | gone (automatic: the player's own move undoes it, and their
 *  later turns in the current hand are acted at once) | asked (the current hand plays normally). */
function setAway(x, reason, now) {
    if (!x.away) { x.away = true; x.awaySince = now; x.awayHands = 0; }
    x.awayReason = reason;
    x.awayAuto = reason !== "asked";
}
function clearAway(x) {
    x.away = false; x.awaySince = null; x.awayAuto = false; x.awayReason = null; x.awayHands = 0; x.timeouts = 0;
}

function away(T, m, c) {
    const s = seatOf(T, m.by);
    if (s === null) fail("bad");
    const x = T.seats[s];
    if (m.on === true) {
        setAway(x, "asked", c.now); // asked for: a move in the current hand doesn't undo it
    } else if (m.on === false) {
        clearAway(x);
        // I'm back while an instant act is pending on this very turn: the turn gets its normal timer (the race of
        // addendum §8.1: whichever commits first wins; the instant act then finds the deadline moved)
        const h = T.hand;
        if (handOpen(T) && h.b.toAct === s && h.instantTurn === h.turn) { h.deadline = c.now + T.opts.turn_s * 1000; h.instantTurn = null; }
    } else fail("bad");
}

/** Earned chips (or a top-up) the server moved from the wallet to this seat: they join the stack before the next hand. */
function credit(T, m, fx) {
    const s = seatOf(T, m.target);
    if (s === null) fail("bad");
    if (!amountOk(m.amount) || m.amount === 0) fail("bad");
    const x = T.seats[s];
    if (dealtIn(T, s)) x.pending += m.amount;
    else x.stack += m.amount;
    fx.push({ t: "credit", seat: s, id: x.id, amount: m.amount });
}

/** Leaving: between hands (or not dealt in) at once; dealt into the open hand → "leaving", folded when the action
 *  reaches them (no timer) or played out when all-in, cashed out at the end of the hand. Nobody folds out of turn. */
function leaveSeat(T, s, reason, c, fx) {
    if (!dealtIn(T, s)) return cashout(T, s, reason, c, fx);
    const x = T.seats[s];
    x.leaving = true;
    x.leaveReason = reason;
    if (T.hand.b.toAct === s) progress(T, c, fx, false); // the action is on them now: fold at once
}

function cashout(T, s, reason, c, fx) {
    const x = T.seats[s];
    fx.push({ t: "cashout", seat: s, id: x.id, amount: x.stack + x.pending, reason });
    delete T.seats[s];
    if (T.host === x.id) {
        const next = Object.values(T.seats).sort((a, b) => a.seq - b.seq)[0];
        T.host = next ? next.id : null;
    }
    if (Object.keys(T.seats).length === 0) T.emptySince = c.now;
}

function requestClose(T, reason, c, fx) {
    if (handOpen(T)) { T.closing = reason; return; }
    closeTable(T, reason, c, fx);
}

function closeTable(T, reason, c, fx) {
    for (const s of Object.keys(T.seats).map(Number).sort((a, b) => a - b)) cashout(T, s, "close", c, fx);
    T.status = "closed";
    T.closed = { reason, at: c.now };
    T.pauseUntil = null;
    T.closing = null;
    fx.push({ t: "table-end", summary: structuredClone(T.summary) });
    if (T.summary.hands > 0) fx.push({ t: "post", kind: "summary" });
    fx.push({ t: "closed", reason });
}

// ----------------------------------------------------------------------------------------------------------- the dealer

/** Players with no socket on the table for GONE_MS when a hand is dealt are dealt out (reason gone). */
function markGone(T, c) {
    for (const x of Object.values(T.seats)) if (c.gone.has(x.id) && !x.away && !x.leaving) setAway(x, "gone", c.now);
}

function eligibleSeats(T) {
    return Object.keys(T.seats).map(Number).sort((a, b) => a - b)
        .filter((s) => T.seats[s].stack + T.seats[s].pending > 0 && !T.seats[s].away && !T.seats[s].leaving);
}

/** Would this move start a hand at `now`? (Then the server runs its admission check and passes ctx.admitted.) */
export function wouldDeal(T, m, now) {
    if (!m || T.status === "closed") return false;
    if (m.do === "deal") return T.status === "lobby" && m.by === T.host && eligibleSeats(T).length >= 2;
    if (m.do === "tick") {
        // the turn timer can end a hand at this tick, but the next deal is always a later tick (after the pause)
        if (T.status !== "pause" || now < T.pauseUntil) return false;
        const away = (x) => x.away && !x.leaving && now - x.awaySince >= HOLDEM.AWAY_STAND_MS;
        return Object.values(T.seats).filter((x) => x.stack + x.pending > 0 && !x.away && !x.leaving && !away(x)).length >= 2;
    }
    return false;
}

/** Starts the next hand when at least two seated players have chips and aren't away. false = not enough players.
 *  The admission check comes first: the room no longer in this table's space → no hand, the table closes. */
function dealHand(T, c, fx) {
    // a failed admission check closes the table even when no hand could start anyway (review round 1)
    if (c.admitted === false) { closeTable(T, "space-changed", c, fx); return true; }
    markGone(T, c);
    const eligible = eligibleSeats(T);
    if (eligible.length < 2) return false;
    if (c.admitted !== true) throw new TypeError("a hand start needs the admission check (ctx.admitted)");
    for (const x of Object.values(T.seats)) { x.stack += x.pending; x.pending = 0; }
    let button;
    if (T.button === null) button = eligible[c.randomInt(0, eligible.length)];
    else button = eligible.find((s) => s > T.button) ?? eligible[0]; // clockwise over the players dealt in
    const deck = shuffledDeck(c.randomInt);
    const deckFull = deck.slice();
    const n = T.n + 1;
    const bi = eligible.indexOf(button);
    const holes = {};
    for (const s of eligible) holes[s] = [];
    for (let round = 0; round < 2; round++)
        for (let i = 1; i <= eligible.length; i++) holes[eligible[(bi + i) % eligible.length]].push(deck.shift());
    const b = startBetting({
        seats: eligible.map((s) => ({ seat: s, stack: T.seats[s].stack })),
        button,
        blinds: [T.opts.sb, T.opts.bb],
    });
    const ids = {};
    const startStacks = {};
    for (const s of eligible) { ids[s] = T.seats[s].id; startStacks[s] = T.seats[s].stack; }
    T.n = n;
    T.button = button;
    T.status = "hand";
    T.pauseUntil = null;
    T.hand = {
        n, button, order: eligible, ids, startStacks, holes, deck, deckFull, board: [], b,
        street: "preflop", turn: 0, deadline: null, last: null, log: [], done: false, result: null, voided: false,
        at: c.now,
    };
    fx.push({ t: "deal", hand: n, button, seats: eligible.map((s) => ({ seat: s, id: ids[s], stack: startStacks[s] })) });
    for (const p of b.posts) {
        if (p.amount > 0) fx.push({ t: "bet", hand: n, turn: 0, seat: p.seat, id: ids[p.seat], amount: p.amount, a: p.a });
        T.hand.log.push({ turn: 0, street: "preflop", seat: p.seat, a: p.a, amount: p.amount, to: b.p[p.seat].bet });
    }
    T.hand.last = { seat: b.bbSeat, a: "bb", to: b.p[b.bbSeat].bet };
    syncStacks(T);
    // away seats were dealt out of one more hand: after AWAY_STAND_HANDS of them, they stand up (not in this hand,
    // so at once: cash-out with the chips they have)
    for (const s of Object.keys(T.seats).map(Number).sort((a, b) => a - b)) {
        const x = T.seats[s];
        if (!x.away || x.leaving || eligible.includes(s)) continue;
        x.awayHands = (x.awayHands || 0) + 1;
        if (x.awayHands >= HOLDEM.AWAY_STAND_HANDS) cashout(T, s, "away", c, fx);
    }
    progress(T, c, fx);
    return true;
}

function syncStacks(T) {
    const h = T.hand;
    for (const s of h.order) if (T.seats[s]) T.seats[s].stack = h.b.p[s].stack;
}

/** A player's move on their turn. */
function play(T, m, c, fx) {
    if (!handOpen(T)) fail("phase");
    const h = T.hand;
    if (!m.at || m.at.hand !== h.n || m.at.turn !== h.turn) fail("stale");
    // the timer acts first (the server ticks, then the move), except a pending INSTANT act on this turn: the player's own
    // move that commits first wins it (addendum §8.1; astra r1 #11)
    if (h.deadline !== null && c.now >= h.deadline && h.instantTurn !== h.turn) fail("stale");
    const s = seatOf(T, m.by);
    if (s === null || h.b.toAct !== s) fail("not-your-turn");
    const rec = act(h.b, m.do === "raise" ? { do: "raise", to: m.to } : { do: m.do });
    const x = T.seats[s];
    x.timeouts = 0; // a move of their own breaks a run of timeouts
    if (x.away && x.awayAuto) clearAway(x); // ...and shows they're back (an away they asked for stays)
    record(T, rec, c, fx, false);
    progress(T, c, fx);
}

function record(T, rec, c, fx, timeout) {
    const h = T.hand;
    const entry = { turn: h.turn, street: h.street, seat: rec.seat, a: rec.a, amount: rec.amount, to: rec.to };
    if (timeout) entry.timeout = true;
    if (rec.auto) entry.auto = rec.auto;
    h.log.push(entry);
    if (rec.amount > 0) fx.push({ t: "bet", hand: h.n, turn: h.turn, seat: rec.seat, id: h.ids[rec.seat], amount: rec.amount, a: rec.a });
    // the public "last action": a timer's action reads "timeout"; a stake only where one was named
    h.last = timeout ? { seat: rec.seat, a: "timeout" } : rec.a === "fold" || rec.a === "check" ? { seat: rec.seat, a: rec.a } : { seat: rec.seat, a: rec.a, to: rec.to };
    syncStacks(T);
}

const BOARD_AFTER = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5, done: null };

/** Moves the hand on after any change: deals the board for a new street, sets the next turn + deadline when the
 *  action moved, folds a leaving player the moment the action reaches them (no timer), or ends the hand.
 *  moved = false only when nothing was played yet (a leave on one's own turn: that player folds now). */
function progress(T, c, fx, moved = true) {
    const h = T.hand;
    for (;;) {
        const want = BOARD_AFTER[h.b.street];
        if (want !== null) while (h.board.length < want) h.board.push(h.deck.shift());
        // a new betting street starts with a clean "last action"; a hand that ends keeps its last action, and one
        // that ends by folds keeps the street it ended on
        if (h.b.street !== h.street && h.b.street !== "done" && h.b.street !== "showdown") h.last = null;
        if (h.b.street !== "done") h.street = h.b.street;
        if (h.b.street === "done" || h.b.street === "showdown") return finishHand(T, c, fx);
        if (moved) {
            h.turn += 1;
            h.deadline = c.now + T.opts.turn_s * 1000;
            h.instantTurn = null;
        }
        const s = h.b.toAct;
        if (T.seats[s] && T.seats[s].leaving) {
            const rec = act(h.b, { do: "fold" });
            rec.auto = "leaving";
            record(T, rec, c, fx, false);
            moved = true;
            continue;
        }
        // an automatically-away player's turn: acted at once by the timer (a timer move like any other: an I'm back
        // that commits first gets the normal timer back, see away())
        if (moved && HOLDEM.AWAY_INSTANT_ACT && T.seats[s] && T.seats[s].away && T.seats[s].awayAuto) { h.deadline = c.now; h.instantTurn = h.turn; }
        return;
    }
}

function finishHand(T, c, fx) {
    const h = T.hand;
    const b = h.b;
    const live = liveSeats(b);
    const folded = h.order.filter((s) => b.p[s].folded);
    let ranking;
    const best = {};
    const shown = {};
    if (b.street === "showdown") {
        const hole = {};
        for (const s of live) hole[s] = h.holes[s];
        const sd = showdown(h.board, hole);
        ranking = sd.ranking;
        for (const s of live) {
            shown[s] = h.holes[s];
            best[s] = { category: sd.best[s].category, five: sd.best[s].five };
        }
    } else {
        ranking = [[String(live[0])]];
    }
    const pin = putIn(b);
    const st = settlePots({ order: h.order, putIn: pin, folded, ranking, button: h.button });
    const from = {};
    const to = {};
    const net = {};
    for (const s of h.order) {
        const id = h.ids[s];
        const back = (st.won[String(s)] || 0) + (st.returned[String(s)] || 0);
        from[id] = pin[String(s)];
        to[id] = back;
        net[id] = back - pin[String(s)];
        const x = T.seats[s];
        if (x) { x.stack = b.p[s].stack + back + x.pending; x.pending = 0; }
    }
    fx.push({ t: "settle", hand: h.n, from, to });
    T.summary.hands += 1;
    for (const [id, n] of Object.entries(net)) T.summary.net[id] = (T.summary.net[id] || 0) + n;
    T.summary.biggest = Math.max(T.summary.biggest, st.pots.reduce((a, p) => a + p.amount, 0)); // uncalled chips aren't pot
    h.result = { pots: st.pots, returned: st.returned, shown, best, net };
    h.done = true;
    h.deadline = null;
    h.endedAt = c.now;
    endOfHand(T, c, fx);
}

/** After a hand is settled or voided: leaving players go, then a close asked for during the hand, else the pause. */
function endOfHand(T, c, fx) {
    for (const s of Object.keys(T.seats).map(Number).sort((a, b) => a - b)) {
        const x = T.seats[s];
        if (x.leaving) cashout(T, s, x.leaveReason || "leave", c, fx);
    }
    if (T.closing) return closeTable(T, T.closing, c, fx);
    T.status = "pause";
    T.pauseUntil = c.now + HOLDEM.PAUSE_MS;
}

/** Calls off the open hand: every player's own chips in the pot go back to them (the server's restart path does the
 *  same from the ledger alone), then the table closes and everyone is cashed out (§4.2 VOID; the drain). */
function voidHand(T, reason, c, fx) {
    const handWasOpen = handOpen(T);
    if (handWasOpen) {
        const h = T.hand;
        const refunds = {};
        for (const s of h.order) {
            refunds[h.ids[s]] = h.b.p[s].total;
            const x = T.seats[s];
            if (x) { x.stack = h.b.p[s].stack + h.b.p[s].total + x.pending; x.pending = 0; }
        }
        fx.push({ t: "void", hand: h.n, refunds });
        h.done = true;
        h.voided = true;
        h.deadline = null;
        h.endedAt = c.now;
        h.result = null;
        for (const s of Object.keys(T.seats).map(Number).sort((a, b) => a - b))
            if (T.seats[s].leaving) cashout(T, s, T.seats[s].leaveReason || "leave", c, fx);
    }
    // a hand that was really called off explains itself (the restart line), even over a close asked for earlier
    closeTable(T, handWasOpen ? reason : T.closing || reason, c, fx);
}

/** Every timer that is due at c.now: the turn timer (check if free, else fold; two in a row → away), away players'
 *  10 minutes, the pause before the next deal, the empty table. */
function tick(T, c, fx) {
    if (handOpen(T) && T.hand.deadline !== null && c.now >= T.hand.deadline) {
        const h = T.hand;
        const s = h.b.toAct;
        const lg = legal(h.b);
        const rec = act(h.b, { do: lg.check ? "check" : "fold" });
        const x = T.seats[s];
        x.timeouts += 1;
        if (x.timeouts >= HOLDEM.AWAY_AFTER_TIMEOUTS && !x.away) setAway(x, "timeout", c.now);
        record(T, rec, c, fx, true);
        progress(T, c, fx);
    }
    for (const s of Object.keys(T.seats).map(Number).sort((a, b) => a - b)) {
        const x = T.seats[s];
        if (x && x.away && !x.leaving && c.now - x.awaySince >= HOLDEM.AWAY_STAND_MS) leaveSeat(T, s, "away", c, fx);
    }
    if (T.status === "closed") return;
    if (T.status === "pause" && c.now >= T.pauseUntil) {
        if (!dealHand(T, c, fx)) { T.status = "lobby"; T.pauseUntil = null; }
    }
    if (T.status !== "hand" && T.status !== "closed" && Object.keys(T.seats).length === 0 && T.emptySince !== null
        && c.now - T.emptySince >= HOLDEM.EMPTY_CLOSE_MS) closeTable(T, "empty", c, fx);
}

/** When the server should next call tick (ms), or null when nothing is pending. */
export function nextWake(T) {
    if (T.status === "closed") return null;
    const t = [];
    if (handOpen(T) && T.hand.deadline !== null) t.push(T.hand.deadline);
    if (T.status === "pause" && T.pauseUntil !== null) t.push(T.pauseUntil);
    for (const x of Object.values(T.seats)) if (x.away && !x.leaving) t.push(x.awaySince + HOLDEM.AWAY_STAND_MS);
    if (Object.keys(T.seats).length === 0 && T.emptySince !== null) t.push(T.emptySince + HOLDEM.EMPTY_CLOSE_MS);
    return t.length ? Math.min(...t) : null;
}

// --------------------------------------------------------------------------------------------------------------- views

function seatState(T, s) {
    const x = T.seats[s];
    const h = T.hand;
    if (h && inHandSeat(T, s) && !h.voided && (T.status === "hand" || T.status === "pause")) {
        const p = h.b.p[s];
        if (x.leaving) return "leaving";
        // during the hand a seat keeps its hand status (an away-pending player who checked is still active; away
        // never changes who can win this pot: addendum §8.1); between hands / dealt out, `away` below
        if (!h.done) return p.folded ? "folded" : p.stack === 0 ? "allin" : "active";
        // a finished hand (the pause): each player as the hand ended (all-in = no chips behind before the settle); an away
        // player shows away between hands (addendum §8.1; astra r2 N7)
        if (x.away) return "away";
        return p.folded ? "folded" : p.stack === 0 ? "allin" : "active";
    }
    if (x.away) return "away";
    if (x.stack + x.pending === 0) return "out";
    return "active";
}

/**
 * The view one person gets (spec §4.3). viewer = their id (null for a spectator). The server adds vseq, now, table and
 * you.screens / you.at_cap. Never carries the deck or anyone else's hole cards (only cards shown at a showdown).
 */
export function viewFor(T, { viewer = null, nameOf = (id) => id } = {}) {
    const h = T.hand;
    const showHand = !!h && !h.voided && (T.status === "hand" || T.status === "pause"); // the hand on show: open, or in its pause
    const seats = [];
    for (const s of Object.keys(T.seats).map(Number).sort((a, b) => a - b)) {
        const x = T.seats[s];
        const inHand = showHand && inHandSeat(T, s);
        const p = inHand ? h.b.p[s] : null;
        const row = {
            seat: s,
            u: nameOf(x.id),
            stack: x.stack + (inHand && !h.done ? 0 : x.pending),
            bet: inHand && !h.done ? p.bet : 0,
            state: seatState(T, s),
            cards: inHand && !p.folded ? 2 : 0,
            away: awayInfo(x),
        };
        if (inHand && h.done && h.result && h.result.shown[s]) row.shown = h.result.shown[s];
        // seated, not in the hand on show (or no hand yet): dealt in at the next one. Never for away / out.
        if (!inHand && row.state === "active" && T.status !== "closed") row.waiting = true;
        seats.push(row);
    }
    const v = { game: "holdem", space: T.space, status: T.status, host: T.host === null ? null : nameOf(T.host), opts: { ...T.opts }, seats, hand: null };
    if (showHand) {
        const b = h.b;
        const hv = {
            n: h.n,
            button: h.button,
            blinds: { sb: b.sbSeat, bb: b.bbSeat },
            street: h.street,
            board: h.board.slice(),
            pots: [],
            total: h.order.reduce((a, s) => a + b.p[s].total, 0),
            to_act: null,
            last: h.last ? { ...h.last } : null,
        };
        if (h.done) {
            hv.pots = h.result.pots.map((p) => ({ amount: p.amount, eligible: p.eligible.slice(), winners: p.winners.slice(), paid: { ...p.paid } }));
            // shown = every hand shown at the showdown, also of players who have left since (public once shown)
            hv.result = { returned: { ...h.result.returned }, shown: structuredClone(h.result.shown), best: structuredClone(h.result.best) };
        } else {
            hv.pots = collectedPots(h);
            hv.to_act = { seat: b.toAct, turn: h.turn, deadline: h.deadline };
        }
        v.hand = hv;
    }
    if (T.status === "pause") v.next_at = T.pauseUntil;
    const ys = seatOf(T, viewer);
    if (ys !== null) {
        const you = { seat: ys, cards: [], legal: null, timeouts: T.seats[ys].timeouts, away: awayInfo(T.seats[ys]) };
        if (showHand && inHandSeat(T, ys)) you.cards = h.holes[ys].slice();
        if (handOpen(T) && h.b.toAct === ys) you.legal = legal(h.b);
        if (T.host === viewer && T.status === "lobby") you.can_deal = eligibleCount(T) >= 2;
        v.you = you;
    }
    return v;
}

/** The public away object of a seat (addendum §8.1 view), or null. */
function awayInfo(x) {
    if (!x.away) return null;
    return { reason: x.awayReason || "asked", since: x.awaySince, stand_at: x.awaySince + HOLDEM.AWAY_STAND_MS, hands_left: Math.max(0, HOLDEM.AWAY_STAND_HANDS - (x.awayHands || 0)) };
}

function eligibleCount(T) {
    return eligibleSeats(T).length;
}

/** The pots as they stand: the chips of finished streets (this street's bets are still in front of the players). */
function collectedPots(h) {
    const b = h.b;
    const collected = {};
    for (const s of h.order) collected[String(s)] = b.p[s].total - b.p[s].bet;
    const folded = h.order.filter((s) => b.p[s].folded);
    if (h.order.every((s) => collected[String(s)] === 0)) return [];
    const { returned, pots } = buildPots({ order: h.order, putIn: collected, folded });
    const back = Object.values(returned).reduce((a, n) => a + n, 0);
    if (back && pots.length) pots[pots.length - 1].amount += back; // never mid-hand in practice; shown, not lost
    return pots.map((p) => ({ amount: p.amount, eligible: p.eligible.slice() }));
}

// ------------------------------------------------------------------------------------------------------------ hand log

/** The finished hand's log entry (kept 30 days): everything, including the deck. Server-side only. */
export function handRecord(T) {
    const h = T.hand;
    if (!h || !h.done) return null;
    return {
        n: h.n,
        at: h.at,
        ended: h.endedAt,
        button: h.button,
        seats: h.order.map((s) => ({ seat: s, id: h.ids[s], stack: h.startStacks[s] })),
        holes: structuredClone(h.holes),
        board: h.board.slice(),
        deck: h.deckFull.slice(),
        actions: structuredClone(h.log),
        disposition: h.voided ? "voided" : "settled",
        result: h.result ? structuredClone(h.result) : null,
    };
}

/** One player's copy of a hand log entry (GET /tables/{id}/hands): their own cards, the public actions and the cards
 *  shown at the showdown. Nothing for someone who wasn't dealt in. */
export function historyFor(rec, id) {
    const mine = rec.seats.find((x) => x.id === id);
    if (!mine) return null;
    return {
        n: rec.n,
        at: rec.at,
        button: rec.button,
        seats: rec.seats.map((x) => ({ seat: x.seat, id: x.id, stack: x.stack })),
        you: { seat: mine.seat, cards: rec.holes[mine.seat].slice() },
        board: rec.board.slice(),
        actions: structuredClone(rec.actions),
        disposition: rec.disposition,
        shown: rec.result ? structuredClone(rec.result.shown) : {},
        pots: rec.result ? structuredClone(rec.result.pots) : [],
        net: rec.result ? structuredClone(rec.result.net) : {},
    };
}
