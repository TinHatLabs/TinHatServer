// play/holdem-rank.mjs — hand ranking, best five of seven (GAMES-V1-SPEC §4.1 Showdown; vectors/holdem-hand-ranking.json).
// A hand's KEY is [category, ...tie-break ranks], compared left to right; ranks 2..14 (ace = 14, except in a wheel,
// where the straight's key is 5). Categories, weakest first, are CATEGORIES below. Pure: no I/O.
import { parseCard } from "./holdem-cards.mjs";

export const CATEGORIES = Object.freeze([
    "high-card", "pair", "two-pair", "trips", "straight", "flush", "full-house", "quads", "straight-flush",
]);

/** Compare two keys: > 0 when a is stronger, < 0 when b is, 0 for a tie. */
export function compareKeys(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const d = (a[i] ?? -1) - (b[i] ?? -1);
        if (d !== 0) return d;
    }
    return 0;
}

/** The key of exactly five parsed cards. */
function key5(cs) {
    const rs = cs.map((c) => c.r).sort((a, b) => b - a);
    const flush = cs.every((c) => c.s === cs[0].s);
    const uniq = [...new Set(rs)];
    let straightHigh = 0;
    if (uniq.length === 5) {
        if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
        else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A-2-3-4-5: the ace plays low (never Q-K-A-2-3)
    }
    const count = new Map();
    for (const r of rs) count.set(r, (count.get(r) || 0) + 1);
    // groups: most cards first, then the higher rank
    const g = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    if (straightHigh && flush) return [8, straightHigh];
    if (g[0][1] === 4) return [7, g[0][0], g[1][0]];
    if (g[0][1] === 3 && g[1][1] === 2) return [6, g[0][0], g[1][0]];
    if (flush) return [5, ...rs];
    if (straightHigh) return [4, straightHigh];
    if (g[0][1] === 3) return [3, g[0][0], g[1][0], g[2][0]];
    if (g[0][1] === 2 && g[1][1] === 2) return [2, g[0][0], g[1][0], g[2][0]];
    if (g[0][1] === 2) return [1, g[0][0], g[1][0], g[2][0], g[3][0]];
    return [0, ...rs];
}

/**
 * The best five of 5–7 cards: { category, key, five } (five = the cards that make it, most significant first).
 * Every five-card subset is scored, so kickers, counterfeits, six-in-a-row and six-suited all fall out of key5.
 */
export function bestHand(cards) {
    if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new TypeError("bestHand needs 5–7 cards");
    if (new Set(cards).size !== cards.length) throw new TypeError("duplicate card");
    const parsed = cards.map(parseCard);
    const n = parsed.length;
    let best = null;
    let bestIdx = null;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
            const k = key5([parsed[a], parsed[b], parsed[c], parsed[d], parsed[e]]);
            if (!best || compareKeys(k, best) > 0) { best = k; bestIdx = [a, b, c, d, e]; }
        }
    // the five in the order they matter: bigger groups first, then by rank (a wheel's ace last); ties keep input order
    const wheel = (best[0] === 4 || best[0] === 8) && best[1] === 5;
    const rv = (i) => (wheel && parsed[i].r === 14 ? 1 : parsed[i].r);
    const cnt = new Map();
    for (const i of bestIdx) cnt.set(rv(i), (cnt.get(rv(i)) || 0) + 1);
    const ordered = [...bestIdx].sort((x, y) => cnt.get(rv(y)) - cnt.get(rv(x)) || rv(y) - rv(x) || x - y);
    return { category: CATEGORIES[best[0]], key: best, five: ordered.map((i) => cards[i]) };
}

/**
 * Showdown: board (5 cards) + hole {seat: [c, c]} → { ranking, keys, best }.
 * ranking = groups of seats, strongest first; seats in one group tie (kept in the order `hole` lists them).
 */
export function showdown(board, hole) {
    const seats = Object.keys(hole);
    const best = {};
    const keys = {};
    for (const s of seats) {
        best[s] = bestHand([...hole[s], ...board]);
        keys[s] = best[s].key;
    }
    const sorted = seats.map((s, i) => ({ s, i })).sort((x, y) => compareKeys(keys[y.s], keys[x.s]) || x.i - y.i);
    const ranking = [];
    for (const { s } of sorted) {
        const last = ranking[ranking.length - 1];
        if (last && compareKeys(keys[last[0]], keys[s]) === 0) last.push(s);
        else ranking.push([s]);
    }
    return { ranking, keys, best };
}
