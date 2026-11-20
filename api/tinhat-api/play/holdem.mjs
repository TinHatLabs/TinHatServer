// play/holdem.mjs — the Texas Hold'em engine's surface for the play platform, in the same shape as The Rig's
// (docs/GAMES-RIG-ENGINE.md), so the platform wires both engines the same way. A thin layer over holdem-table.mjs's
// move(): no rules live here. Pure: no I/O, no clock, no randomness of its own beyond the dealer's CSPRNG shuffle.
//
//   createTable({ table, room, space, host, now, opts })  → state (bound to `space` for life)
//   act(st, who, a, ctx)        a player's frame `a` (§6.3: sit {seat?, space}, leave, deal, fold, check, call,
//                               raise {to}, allin, away {on}, kick {u}, close; acting moves carry `at`)
//   tick(st, ctx)               every timer that is due (call at nextDeadline(st), harmless any time)
//   setOnline(st, who, on, ctx) a seat's last socket went / came back: nothing changes in Hold'em (same timer)
//   spaceChanged(st, ctx)       the room's space link changed: the hand plays out, then the table closes
//   voidRound(st, ctx)          restart / games off / the drain's 2 minutes: the hand is called off, the table closes
//   viewFor(st, who, now)       that person's engine view (§4.3 + additive fields), with table; vseq = st.rev (the
//                               platform keeps each person's own vseq from the contract view it sends)
//   nextDeadline(st)            ms of the next timer, or null
//   → every call: { ok, code?, state, effects }; a refused or no-op call returns the SAME state and no effects.
//
// ctx = { now, balances: { who: wallet chips in the table's space } (sit takes all of them; at every deal each seated
//         player's wallet chips (earned while seated, a top-up) join their stack first), admitted: bool (the
//         admission check; REQUIRED when the call may start a hand, see wouldDeal), randomInt? (tests) }
// `who` is whatever id the platform plays with (Matrix id or wallet id); the engine never looks inside it.
// state.rev = the compare-and-set revision (+1 per accepted change; never sent).
//
// Effects (each carries `space`, the table's): sit / credit {who, seat, amount} wallet → seat · deal {hand, button,
// seats: [{seat, who, stack}]} · bet {hand, turn, who, seat, amount, a} seat → that player's pot account · settle {hand, from, to} ·
// void {hand, refunds} · cashout {who, seat, amount, reason} seat → wallet, followed by left {who} (run the prestige
// check) · table-end {summary} · post {kind: "summary"} · closed {reason}. docs/PLAY-HOLDEM-ENGINE.md has the ledger
// mapping.
import * as core from "./holdem-table.mjs";

export { HOLDEM, handRecord, historyFor } from "./holdem-table.mjs";
export { bestHand, showdown, compareKeys, CATEGORIES } from "./holdem-rank.mjs";
export { buildPots, award, settlePots } from "./holdem-pots.mjs";
export { startBetting, legal, BetError } from "./holdem-betting.mjs";
export { freshDeck, shuffle, shuffledDeck } from "./holdem-cards.mjs";

export function createTable({ table = null, room = null, space, host, now, opts }) {
    const st = core.createTable({ host, space, opts, now });
    st.table = table;
    st.room = room;
    st.rev = 0;
    return st;
}

const PLAYER_MOVES = new Set(["sit", "leave", "deal", "fold", "check", "call", "raise", "allin", "away", "kick", "close"]);

export function act(st, who, a, ctx) {
    if (!a || typeof a !== "object" || !PLAYER_MOVES.has(a.do) || who === undefined || who === null) return refuse(st, "bad");
    let m;
    switch (a.do) {
        case "sit": {
            if (a.space !== st.space) return refuse(st, "space-changed"); // before any debit (rev 2)
            const chips = balanceOf(ctx, who);
            if (chips === null) return refuse(st, "bad");
            if (chips < core.HOLDEM.MIN_TO_SIT) return refuse(st, "no-chips");
            m = { do: "sit", by: who, seat: a.seat, space: a.space, chips };
            break;
        }
        case "kick": m = { do: "kick", by: who, target: a.u }; break;
        case "away": m = { do: "away", by: who, on: a.on }; break;
        case "raise": m = { do: "raise", by: who, at: a.at, to: a.to }; break;
        case "fold": case "check": case "call": case "allin": m = { do: a.do, by: who, at: a.at }; break;
        default: m = { do: a.do, by: who }; // leave, deal, close
    }
    return run(st, m, ctx, false);
}

export function tick(st, ctx) {
    return run(st, { do: "tick" }, ctx, true);
}

export function setOnline(st) {
    return { ok: true, state: st, effects: [] }; // Hold'em: a disconnected player gets the same turn timer
}

export function spaceChanged(st, ctx) {
    if (st.status === "closed") return { ok: true, state: st, effects: [] };
    return run(st, { do: "close", reason: "space-changed" }, ctx, true);
}

export function voidRound(st, ctx) {
    if (st.status === "closed") return { ok: true, state: st, effects: [] };
    return run(st, { do: "void", reason: (ctx && ctx.reason) || "void" }, ctx, true);
}

export function viewFor(st, who, now) {
    const v = core.viewFor(st, { viewer: who ?? null });
    v.table = st.table;
    v.vseq = st.rev;
    if (now !== undefined) v.now = now;
    return v;
}

export function nextDeadline(st) {
    return core.nextWake(st);
}

/** Would this call start a hand (counting the wallet chips a deal would pull in)? The simplest wiring passes
 *  ctx.admitted on EVERY deal and tick instead; this is for a platform that wants to skip the check otherwise.
 *  who + a = a player frame, or a = { do: "tick" }. */
export function wouldDeal(st, who, a, ctx) {
    const m = a && a.do === "tick" ? { do: "tick" } : { do: a && a.do, by: who };
    return core.wouldDeal(stageCredits(st, ctx).state, m, ctx.now);
}

/** The table as it would be after every seated player's wallet chips joined their stack (the first step of a deal). */
function stageCredits(st, ctx) {
    let T = st;
    const fx = [];
    for (const s of Object.keys(st.seats).map(Number).sort((a, b) => a - b)) {
        const x = st.seats[s];
        const amount = balanceOf(ctx, x.id);
        if (!amount) continue;
        const r = core.move(T, { do: "credit", target: x.id, amount }, { now: ctx.now, system: true });
        if (!r.ok) continue; // a balance the core won't take (out of range) never blocks the call: that player just isn't topped
        T = r.state;
        fx.push(...r.effects);
    }
    return { state: T, effects: fx };
}

// ---------------------------------------------------------------------------------------------------------------------

function balanceOf(ctx, who) {
    const b = ctx && ctx.balances ? ctx.balances[who] : 0;
    if (b === undefined) return 0;
    return Number.isSafeInteger(b) && b >= 0 ? b : null;
}

function refuse(st, code) {
    return { ok: false, code, state: st, effects: [] };
}

/** One platform call = one or more core moves (wallet pulls before a deal), as one result. */
function run(st, m, ctx, system) {
    if (!ctx || !Number.isFinite(ctx.now)) throw new TypeError("ctx.now is required");
    const base = { now: ctx.now, randomInt: ctx.randomInt };
    let T = st;
    const fx = [];
    // DEAL: stacks topped from wallets (chips earned while seated, a top-up) before the hand. Whether a hand starts
    // is judged WITH those chips (a busted player whose wallet earned a chip is dealt back in), and they're only
    // moved when it does (review round 3).
    // only a call that could deal stages anything (a turn timer never depends on a wallet: review round 4)
    const mayDeal = (m.do === "deal" && st.status === "lobby") || (m.do === "tick" && st.status === "pause" && ctx.now >= st.pauseUntil);
    if (mayDeal && ctx.admitted !== false) {
        const staged = stageCredits(st, ctx);
        if (core.wouldDeal(staged.state, m, ctx.now)) {
            if (ctx.admitted !== true) throw new TypeError("a hand start needs the admission check (ctx.admitted)");
            T = staged.state;
            fx.push(...staged.effects);
        }
    }
    if (ctx.admitted === undefined && core.wouldDeal(T, m, ctx.now)) throw new TypeError("a hand start needs the admission check (ctx.admitted)");
    const r = core.move(T, m, { ...base, system, admitted: ctx.admitted });
    if (!r.ok) return refuse(st, r.code);
    fx.push(...r.effects);
    const out = r.state;
    out.rev = st.rev;
    if (fx.length === 0 && JSON.stringify(out) === JSON.stringify(st)) return { ok: true, state: st, effects: [] };
    out.rev = st.rev + 1;
    return { ok: true, state: out, effects: decorate(fx, st.space) };
}

function decorate(fx, space) {
    const out = [];
    for (const e of fx) {
        const { id, ...rest } = e;
        const d = id === undefined ? { ...rest, space } : { ...rest, who: id, space };
        if (e.t === "deal") d.seats = e.seats.map((x) => ({ seat: x.seat, who: x.id, stack: x.stack }));
        out.push(d);
        if (e.t === "cashout") out.push({ t: "left", who: id, space });
    }
    return out;
}
