// play/holdem-betting.mjs — no-limit betting for one hand (GAMES-V1-SPEC §4.1; vectors/holdem-betting.json).
// A hand's betting state is a plain JSON object (it lives in play_games.state); the functions below mutate the object
// they're given (the table engine clones before a move, so a refused move changes nothing). Pure: no I/O.
//
// Rules: blinds sb/bb; heads-up the button posts the small blind, acts first before the flop and last after it.
// Min bet = the big blind; min raise = the biggest raise so far on this street (at least the big blind). An all-in
// short of a full raise doesn't let players who already acted raise again, unless the raises since their own last
// action add up to a full raise. A big blind all-in for less still leaves the full big blind to call. Raise amounts are
// TOTALS for this street (raise TO).

export class BetError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

const NEXT_STREET = { preflop: "flop", flop: "turn", turn: "river", river: "showdown" };

/**
 * startBetting({ seats: [{ seat, stack }] (clockwise, every one dealt in, stack > 0), button, blinds: [sb, bb] })
 * Posts the blinds (a blind bigger than a stack puts that player all-in) and finds the first player to act.
 * Returns the state; `posts` = [{ seat, amount, a: "sb" | "bb" }] actually posted.
 */
export function startBetting({ seats, button, blinds }) {
    const [sb, bb] = blinds;
    const order = seats.map((s) => s.seat);
    const n = order.length;
    if (n < 2) throw new BetError("bad");
    const bi = order.indexOf(button);
    if (bi < 0) throw new BetError("bad");
    const h = { order, sb, bb, button, street: "preflop", current: 0, lastRaise: bb, toAct: null, p: {}, posts: [] };
    for (const s of seats) {
        if (!Number.isSafeInteger(s.stack) || s.stack <= 0) throw new BetError("bad");
        h.p[s.seat] = { stack: s.stack, bet: 0, total: 0, folded: false, acted: null };
    }
    const sbSeat = n === 2 ? order[bi] : order[(bi + 1) % n];
    const bbSeat = n === 2 ? order[(bi + 1) % n] : order[(bi + 2) % n];
    h.sbSeat = sbSeat;
    h.bbSeat = bbSeat;
    h.posts.push({ seat: sbSeat, amount: put(h, sbSeat, Math.min(sb, h.p[sbSeat].stack)), a: "sb" });
    h.posts.push({ seat: bbSeat, amount: put(h, bbSeat, Math.min(bb, h.p[bbSeat].stack)), a: "bb" });
    h.current = bb; // the full big blind, even when the big blind is all-in for less
    h.lastRaise = bb;
    advance(h, bbSeat);
    return h;
}

function put(h, s, amount) {
    const p = h.p[s];
    p.stack -= amount;
    p.bet += amount;
    p.total += amount;
    return amount;
}

const canAct = (h, s) => !h.p[s].folded && h.p[s].stack > 0;
const needsAction = (h, s) => h.p[s].acted === null || h.p[s].bet < h.current;
export const liveSeats = (h) => h.order.filter((s) => !h.p[s].folded);

/** The legal moves of the player to act, or null when nobody is to act. */
export function legal(h) {
    const s = h.toAct;
    if (s === null || s === undefined) return null;
    const p = h.p[s];
    const call = Math.min(Math.max(0, h.current - p.bet), p.stack);
    const allinTo = p.bet + p.stack;
    let raiseOk = allinTo > h.current;
    // facing less than a full raise since they last acted: call or fold only
    if (p.acted !== null && h.current - p.acted < h.lastRaise) raiseOk = false;
    // every other player still in is all-in: there is nobody to raise against
    if (!liveSeats(h).some((o) => o !== s && h.p[o].stack > 0)) raiseOk = false;
    let raise = null;
    if (raiseOk) {
        const min = h.current > 0 ? h.current + h.lastRaise : h.bb;
        raise = { min: Math.min(min, allinTo), max: allinTo };
    }
    return { fold: true, check: call === 0, call, raise };
}

/**
 * act(h, { do: "fold" | "check" | "call" | "raise" | "allin", to? }) → { seat, a, amount, to }
 * Throws BetError("no-turn" | "bad-action" | "bad-amount") and leaves h untouched when refused.
 * a = what happened, for the log: fold | check | call | bet | raise | allin.
 */
export function act(h, move) {
    const s = h.toAct;
    if (s === null || s === undefined) throw new BetError("no-turn");
    const lg = legal(h);
    const p = h.p[s];
    const kind = move && move.do;
    let rec;
    if (kind === "fold") {
        p.folded = true;
        rec = { seat: s, a: "fold", amount: 0, to: p.bet };
    } else if (kind === "check") {
        if (!lg.check) throw new BetError("bad-action");
        rec = { seat: s, a: "check", amount: 0, to: p.bet };
    } else if (kind === "call") {
        if (lg.call === 0) throw new BetError("bad-action");
        const amount = put(h, s, lg.call);
        rec = { seat: s, a: p.stack === 0 ? "allin" : "call", amount, to: p.bet };
    } else if (kind === "raise" || kind === "allin") {
        if (lg.raise === null) {
            // an all-in that is only a call (or less) is a call; anything more can't be a raise here
            if (kind === "allin" && lg.call > 0 && lg.call === p.stack) {
                const amount = put(h, s, lg.call);
                rec = { seat: s, a: "allin", amount, to: p.bet };
                p.acted = h.current;
                advance(h, s);
                return rec;
            }
            throw new BetError("bad-action");
        }
        const to = kind === "allin" ? p.bet + p.stack : move.to;
        if (!Number.isSafeInteger(to) || to < lg.raise.min || to > lg.raise.max) throw new BetError("bad-amount");
        const wasBet = h.current === 0;
        const inc = to - h.current;
        const amount = put(h, s, to - p.bet);
        if (inc >= h.lastRaise) h.lastRaise = inc;
        h.current = to;
        rec = { seat: s, a: p.stack === 0 ? "allin" : wasBet ? "bet" : "raise", amount, to };
    } else {
        throw new BetError("bad-action");
    }
    p.acted = h.current;
    advance(h, s);
    return rec;
}

function roundOver(h) {
    const live = liveSeats(h);
    if (live.length <= 1) return true;
    const able = live.filter((s) => h.p[s].stack > 0);
    const maxBet = Math.max(...live.map((s) => h.p[s].bet));
    for (const s of able) {
        if (needsAction(h, s)) {
            // a lone player with chips who already matches the bet has nobody to bet against; "the bet" is the full
            // big blind preflop even when the big blind is all-in for less (they still owe it: call or fold)
            if (able.length === 1 && h.p[s].bet >= Math.max(maxBet, h.current)) continue;
            return false;
        }
    }
    return true;
}

function nextActor(h, after) {
    const n = h.order.length;
    const i = h.order.indexOf(after);
    for (let k = 1; k <= n; k++) {
        const s = h.order[(i + k) % n];
        if (canAct(h, s) && needsAction(h, s)) return s;
    }
    return null;
}

/** After a move by `s` (or the blinds): the next player, or the end of the street / the betting. */
function advance(h, s) {
    if (liveSeats(h).length <= 1) {
        h.toAct = null;
        h.street = "done";
        return;
    }
    if (!roundOver(h)) {
        h.toAct = nextActor(h, s);
        return;
    }
    const able = liveSeats(h).filter((x) => h.p[x].stack > 0);
    const next = NEXT_STREET[h.street];
    if (able.length <= 1 || next === "showdown") {
        h.street = "showdown"; // no more betting: the board runs out
        h.toAct = null;
        return;
    }
    h.street = next;
    for (const x of h.order) {
        h.p[x].bet = 0;
        h.p[x].acted = null;
    }
    h.current = 0;
    h.lastRaise = h.bb;
    h.toAct = nextActor(h, h.button);
}

/** Every chip each seat has put in this hand: { [seat]: n }. */
export function putIn(h) {
    const o = {};
    for (const s of h.order) o[String(s)] = h.p[s].total;
    return o;
}
