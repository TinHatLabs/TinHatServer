// play/holdem-pots.mjs — uncalled chips, main and side pots, and who gets what (GAMES-V1-SPEC §4.1;
// vectors/holdem-side-pots.json). Pure: no I/O. Seats are opaque ids; `order` lists them clockwise. Maps (putIn, the
// results) are plain objects keyed by String(seat); arrays (eligible, winners) hold the ids exactly as `order` has them.

/**
 * buildPots({ order, putIn, folded }) → { returned, pots: [{ amount, eligible }] }
 * 1. The uncalled part of the single biggest put-in (over the second biggest, folded seats included) goes back.
 * 2. One pot per distinct put-in level of the seats still in (ascending), taking from every seat (folded too) up to
 *    that level; eligible = seats still in whose put-in reaches it. Neighbouring pots with the same eligible seats merge.
 * 3. Chips above the highest level reached by a seat still in (put in only by folded seats) join the top pot.
 */
export function buildPots({ order, putIn, folded = [] }) {
    const fold = new Set(folded.map(String));
    const put = {};
    for (const s of order) put[String(s)] = putIn[String(s)] || 0;
    const returned = {};
    const vals = order.map((s) => put[String(s)]);
    const top = Math.max(0, ...vals);
    const tops = order.filter((s) => put[String(s)] === top);
    if (top > 0 && tops.length === 1) {
        const second = Math.max(0, ...order.filter((s) => s !== tops[0]).map((s) => put[String(s)]));
        if (top > second) {
            returned[String(tops[0])] = top - second;
            put[String(tops[0])] = second;
        }
    }
    const live = order.filter((s) => !fold.has(String(s)));
    const levels = [...new Set(live.map((s) => put[String(s)]).filter((v) => v > 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const L of levels) {
        let amount = 0;
        for (const s of order) amount += Math.max(0, Math.min(put[String(s)], L) - prev);
        const eligible = live.filter((s) => put[String(s)] >= L);
        if (amount > 0) {
            const last = pots[pots.length - 1];
            if (last && sameSeats(last.eligible, eligible)) last.amount += amount;
            else pots.push({ amount, eligible });
        }
        prev = L;
    }
    const total = order.reduce((a, s) => a + put[String(s)], 0);
    const inPots = pots.reduce((a, p) => a + p.amount, 0);
    if (total > inPots) {
        if (!pots.length) throw new Error("chips in with no seat still in"); // can't happen: some seat is always in
        pots[pots.length - 1].amount += total - inPots;
    }
    return { returned, pots };
}

function sameSeats(a, b) {
    return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * award({ pots, ranking, button, order }) → { pots: [{ amount, eligible, winners, paid }], won }
 * Each pot goes to the strongest group in `ranking` (groups of seats, strongest first) that has an eligible seat;
 * a split pot's odd chips go one each to its winners clockwise, starting with the first seat after the button.
 */
export function award({ pots, ranking, button, order }) {
    const n = order.length;
    const bi = order.findIndex((s) => String(s) === String(button));
    if (bi < 0) throw new Error("the button is not in the seat order");
    const clockwise = [];
    for (let i = 1; i <= n; i++) clockwise.push(order[(bi + i) % n]);
    const won = {};
    const out = [];
    for (const p of pots) {
        const elig = new Set(p.eligible.map(String));
        let winners = null;
        for (const g of ranking) {
            const w = g.filter((s) => elig.has(String(s)));
            if (w.length) { winners = w; break; }
        }
        if (!winners) throw new Error("a pot with no eligible seat in the ranking");
        const ws = new Set(winners.map(String));
        const winnersInOrder = order.filter((s) => ws.has(String(s)));
        const share = Math.floor(p.amount / winners.length);
        let odd = p.amount - share * winners.length;
        const paid = {};
        for (const s of winnersInOrder) paid[String(s)] = share;
        for (const s of clockwise) {
            if (odd === 0) break;
            if (ws.has(String(s))) { paid[String(s)] += 1; odd -= 1; }
        }
        for (const s of winnersInOrder) won[String(s)] = (won[String(s)] || 0) + paid[String(s)];
        out.push({ amount: p.amount, eligible: p.eligible, winners: winnersInOrder, paid });
    }
    return { pots: out, won: sortedBy(won, order) };
}

function sortedBy(map, order) {
    const o = {};
    for (const s of order) if (map[String(s)] !== undefined) o[String(s)] = map[String(s)];
    return o;
}

/** settle = buildPots + award, the whole end of a hand: { returned, pots, won }. */
export function settlePots({ order, putIn, folded, ranking, button }) {
    const { returned, pots } = buildPots({ order, putIn, folded });
    const a = award({ pots, ranking, button, order });
    return { returned: sortedBy(returned, order), pots: a.pots, won: a.won };
}
