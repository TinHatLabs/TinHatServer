// The Rig's rules as data + pure functions (GAMES-V1-SPEC §5.0 / §5.1; vectors/play/rig-spins.json is the only source
// of truth): the cards, the presets, how one spin resolves, the machine rules, Market and Peek settlement, Whisper
// checks. No I/O, no clock, no randomness of its own (re-rolls come from the caller: rig-rng.mjs in a game, a
// fixed list in the vectors).
import { SYMBOLS } from "./rig-rng.mjs";

export { SYMBOLS };

// ×bet. "payout" includes the bet coming back: a push is payout = bet.
export const PAYTABLE = Object.freeze({ "trips-hat": 20, trips: 8, "pair-hat": 4, pair: 1, none: 0 });

// Deck order = card number (the RNG deals from this order). kind R = reel card, P = payout card; `after` = applies
// after every multiplier (Skim). `lite` = in the 10-card Lite deck.
export const CARDS = Object.freeze(Object.fromEntries([
    ["moon-monday", "R", 2, false, true],
    ["lizard-lane", "R", 2, false, true],
    ["hat-thief", "R", 2, false, false],
    ["twos-company", "R", 3, false, false],
    ["big-bet-tax", "P", 2, false, true],
    ["penny-pincher", "P", 2, false, true],
    ["cold-streak", "P", 2, false, true],
    ["skim", "P", 2, true, true],
    ["moon-tax", "P", 3, true, true],
    ["shy-hat", "R", 2, true, false],
    ["lizard-tax", "P", 1, true, true],
    ["underdog", "P", 2, false, true],
    ["rebound", "P", 2, false, true],
    ["hot-hat", "P", 2, false, false],
    ["slow-start", "P", 2, false, false],
    ["even-money", "P", 2, false, false],
].map(([id, kind, bite, tax, lite], i) => [id, Object.freeze({ id, n: i + 1, kind, bite, tax, lite, after: id === "skim" })])));

export const DECK = Object.freeze(Object.keys(CARDS));
export const LITE_DECK = Object.freeze(DECK.filter((c) => CARDS[c].lite));

// One named constant per rule number (spec §5.0 presets): a different answer to an open question is a one-line change.
export const PRESETS = Object.freeze({
    lite: Object.freeze({ name: "lite", live: 2, deck: LITE_DECK, spins: 8, calls: 2, dead: 4, walk_from: 5, peek_lock_after: 3, mutes: 0, nudges: false, whispers: false, patch: false }),
    full: Object.freeze({ name: "full", live: 3, deck: DECK, spins: 10, calls: 3, dead: 3, walk_from: 6, peek_lock_after: 4, mutes: 2, nudges: true, whispers: true, patch: true }),
});
export const MONEY = Object.freeze({
    bankroll_min: 3, bankroll_max: 10, bankroll_default: 6,
    bet_min: 1, bet_max: 3,
    stake: 3, wrong_call: 2, call_needs: 2,
    market_min: 1, market_max: 2,
    peek: 2, peek_bounty: 3,
    round_cap: 20,
    max_bite: 6,
});
export const PLAYERS = Object.freeze({ min: 3, max: 8 });

export function category(reels) {
    const [a, b, c] = reels;
    if (a === b && b === c) return a === "hat" ? "trips-hat" : "trips";
    for (const [x, y] of [[a, b], [a, c], [b, c]]) if (x === y) return x === "hat" ? "pair-hat" : "pair";
    return "none";
}
export const paytableOf = (reels, bet) => PAYTABLE[category(reels)] * bet;
export const resultOf = (payout, bet) => (payout > bet ? "win" : payout === bet ? "push" : "loss");

// A re-roll: ONE draw (0..4) = that index among the five symbols other than `exclude`, in ring order.
function reroll(exclude, next) {
    const d = next();
    if (!Number.isInteger(d) || d < 0 || d > 4) throw new Error("rig: a re-roll draw is 0..4");
    return SYMBOLS.filter((s) => s !== exclude)[d];
}

function reelStep(card, reels, bet, next) {
    const r = [...reels];
    switch (card) {
        case "moon-monday": if (bet === 1 || bet === 3) r[1] = "moon"; break;
        case "lizard-lane": if (bet === 3) r[0] = "lizard"; break;
        case "hat-thief": if (bet === 2) for (let i = 0; i < 3; i++) if (r[i] === "hat") r[i] = reroll("hat", next); break;
        case "twos-company": if (bet === 2 && r[2] === r[0]) r[2] = reroll(r[0], next); break;
        case "shy-hat": if (r[1] === "hat") r[1] = reroll("hat", next); break;
        default: throw new Error(`rig: ${card} is not a reel card`);
    }
    return r;
}

// ctx: {bet, cat, reels (final), spin, prev ({result, reels} | null), streak (losses in a row right before)}
function payoutStep(card, pay, ctx) {
    const { bet, cat, reels, spin, prev, streak } = ctx;
    switch (card) {
        case "big-bet-tax": return bet === 3 ? Math.floor(pay / 2) : pay;
        case "penny-pincher": return bet === 1 ? 0 : pay;
        case "cold-streak": return prev && prev.result === "loss" && cat === "pair" ? 0 : pay;
        case "moon-tax": return reels.includes("moon") ? 0 : pay;
        case "lizard-tax": return reels[1] === "lizard" ? 0 : pay;
        case "underdog": return cat !== "pair" ? pay : bet === 1 ? pay * 2 : bet === 3 ? 0 : pay;
        case "rebound": return streak === 1 ? pay * 2 : streak === 2 ? 0 : pay;
        case "hot-hat":
            if (!prev) return pay;
            if (!prev.reels.includes("hat") && cat === "pair") return 0;
            if (prev.reels[0] === "hat") return pay * 2;
            return pay;
        case "slow-start": return spin >= 1 && spin <= 3 ? 0 : spin >= 8 && spin <= 10 ? pay * 2 : pay;
        case "even-money":
            if (bet === 2 && cat === "pair") return pay * 2;
            if ((bet === 1 || bet === 3) && (cat === "pair-hat" || cat === "trips" || cat === "trips-hat")) return Math.floor(pay / 2);
            return pay;
        case "skim": return pay > 0 ? pay - 1 : 0;
        default: throw new Error(`rig: ${card} is not a payout card`);
    }
}

const live = (cards) => cards.filter((c) => !c.muted);

// Step 1 of a spin: reel cards in slot order on the honest reels. cards: [{card, owner, muted?}] in slot order.
// next(): the next re-roll draw 0..4. → {after_cards, touched, bit}
export function reelPhase({ bet, honest, cards, next }) {
    let reels = [...honest];
    const touched = [], bit = [];
    for (const c of live(cards)) {
        if (CARDS[c.card].kind !== "R") continue;
        const before = reels;
        reels = reelStep(c.card, reels, bet, next);
        if (reels.some((s, i) => s !== before[i])) {
            touched.push(c.card);
            if (paytableOf(reels, bet) < paytableOf(before, bet)) bit.push(c.card);
        }
    }
    return { after_cards: reels, touched, bit };
}

// A Nudge: one reel one step round the symbol ring (wrapping). The last word on the reels.
export function applyNudge(reels, nudge) {
    if (!nudge) return [...reels];
    const r = [...reels], i = nudge.reel - 1;
    r[i] = SYMBOLS[(SYMBOLS.indexOf(r[i]) + nudge.step + SYMBOLS.length) % SYMBOLS.length];
    return r;
}

// The streak and the previous spin, from this round's earlier spins (oldest first): a push or a win ends a losing streak.
export function streakOf(history) {
    let n = 0;
    for (let i = history.length - 1; i >= 0 && history[i].result === "loss"; i--) n++;
    return n;
}

// Step 3: the paytable on the final reels, then payout cards in slot order: every multiplier first, then Skim.
// → {category, paytable_payout, payout, touched, bit}
export function payoutPhase({ bet, spin, final, cards, history }) {
    const cat = category(final);
    let pay = PAYTABLE[cat] * bet;
    const paytable = pay;
    const ctx = { bet, cat, reels: final, spin, prev: history.length ? history[history.length - 1] : null, streak: streakOf(history) };
    const touched = [], bit = [];
    for (const after of [false, true]) {
        for (const c of live(cards)) {
            const def = CARDS[c.card];
            if (def.kind !== "P" || def.after !== after) continue;
            const before = pay;
            pay = Math.max(0, payoutStep(c.card, pay, ctx));
            if (pay !== before) {
                touched.push(c.card);
                if (pay < before) bit.push(c.card);
            }
        }
    }
    return { category: cat, paytable_payout: paytable, payout: pay, touched, bit };
}

// Rake: only on a loss with a bite: bet − payout split evenly over the owners of the cards that bit (whole chips, the
// remainder to the bank); a loss with no bite goes to the bank; a win or push is paid by the bank.
// → {rake: {owner: n}, bank_delta} (bank_delta + = the bank gains)
export function rakeOf({ bet, payout, bit, cards }) {
    const rake = {};
    if (payout >= bet) return { rake, bank_delta: bet - payout }; // never -0
    const lost = bet - payout;
    const owners = bit.map((card) => cards.find((c) => c.card === card).owner);
    if (!owners.length) return { rake, bank_delta: lost };
    const share = Math.floor(lost / owners.length);
    for (const o of owners) rake[o] = (rake[o] || 0) + share;
    return { rake, bank_delta: lost - share * owners.length };
}

// One whole spin, in order (the vectors' entry point). inp: {bet, spin, honest, cards, history, draws?, nudge?}
export function resolveSpin(inp) {
    const draws = [...(inp.draws || [])];
    const next = () => {
        if (!draws.length) throw new Error("rig: re-roll draws exhausted");
        return draws.shift();
    };
    const { bet, spin, honest, cards } = inp;
    const history = inp.history || [];
    const rp = reelPhase({ bet, honest, cards, next });
    const final = applyNudge(rp.after_cards, inp.nudge);
    const pp = payoutPhase({ bet, spin, final, cards, history });
    const bit = [...rp.bit, ...pp.bit];
    const { rake, bank_delta } = rakeOf({ bet, payout: pp.payout, bit, cards });
    return {
        after_cards: rp.after_cards, final, category: pp.category, honest_payout: paytableOf(honest, bet),
        paytable_payout: pp.paytable_payout, payout: pp.payout, result: resultOf(pp.payout, bet),
        touched: [...rp.touched, ...pp.touched], bit, spinner_delta: pp.payout - bet, rake, bank_delta,
        draws_left: draws.length,
    };
}

// A machine is refused if its live cards' bites add to more than 6, it has two Taxes, or a card twice.
export function machineOk(cards) {
    if (cards.reduce((s, c) => s + CARDS[c].bite, 0) > MONEY.max_bite) return { ok: false, why: "bite" };
    if (cards.filter((c) => CARDS[c].tax).length > 1) return { ok: false, why: "tax" };
    if (new Set(cards).size !== cards.length) return { ok: false, why: "dup" };
    return { ok: true, why: "" };
}

// Market (pari-mutuel, whole chips): both sides bet → each winner gets stake + floor(stake × losing pool / winning
// stakes), the rest of the losing pool to the bank; one side only → stakes back. → {back: {who: n}, bank}
export function settleMarket(bets, spinnerUp) {
    const win = spinnerUp ? "up" : "not-up";
    const W = bets.filter((b) => b.side === win), L = bets.filter((b) => b.side !== win);
    const back = {};
    const add = (k, v) => { back[k] = (back[k] || 0) + v; };
    if (!W.length || !L.length) {
        for (const b of bets) add(b.who, b.stake);
        return { back, bank: 0 };
    }
    const pool = L.reduce((s, b) => s + b.stake, 0), stakes = W.reduce((s, b) => s + b.stake, 0);
    let paid = 0;
    for (const b of W) {
        const g = Math.floor((b.stake * pool) / stakes);
        add(b.who, b.stake + g);
        paid += g;
    }
    for (const b of L) add(b.who, 0);
    return { back, bank: pool - paid };
}

// Peeks (each escrowed 2 when placed). One snapshot per Mechanic: B = balance after the earlier stages + 2 × wrong
// Peeks on them; bounty = min(3, B) shared evenly by the right Peeks on them (remainder stays); right Peeks get their 2
// back. Refunds and shares a Mechanic RECEIVES never fund a bounty, so the order doesn't matter.
// peeks: [{who, target, card, held}], balances: {mechanic: n}. → {delta: {who: n}} (after escrow)
export function settlePeeks(peeks, balances) {
    const delta = {};
    const add = (k, v) => { delta[k] = (delta[k] || 0) + v; };
    for (const p of peeks) { add(p.who, 0); add(p.target, 0); }
    const targets = [...new Set(peeks.map((p) => p.target))];
    const snap = {};
    for (const m of targets) {
        const wrong = peeks.filter((p) => p.target === m && p.card !== p.held).length;
        snap[m] = (balances[m] || 0) + MONEY.peek * wrong;
        add(m, MONEY.peek * wrong);
    }
    for (const m of targets) {
        const right = peeks.filter((p) => p.target === m && p.card === p.held);
        if (!right.length) continue;
        const share = Math.floor(Math.min(MONEY.peek_bounty, Math.max(0, snap[m])) / right.length);
        add(m, -share * right.length);
        for (const p of right) add(p.who, MONEY.peek + share);
    }
    return { delta };
}

// Whispers (§5.1.12): a template, or 1–60 characters with no control characters and no links.
export const WHISPER_TEMPLATES = Object.freeze({
    "bet-size": "It's about bet size",
    "not-moon": "It's not a Moon thing",
    "last-spin": "It's about the last spin",
    "reel-2": "Watch reel 2",
    bluffing: "{person} is bluffing",
    "trust-nobody": "Trust nobody",
});
export const WHISPER_MAX = 60;
// C0/C1 controls, plus the bidi overrides/isolates (they could flip how the line reads).
const CONTROL = /[\p{Cc}‪-‮⁦-⁩]/u;
const LINK = /:\/\/|www\./i;
export function checkWhisperText(text) {
    if (typeof text !== "string") return "bad";
    const len = [...text].length;
    if (len < 1 || len > WHISPER_MAX || !text.trim()) return "bad";
    if (CONTROL.test(text) || LINK.test(text)) return "bad";
    if (/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))) return "bad"; // lone surrogates
    return "";
}
