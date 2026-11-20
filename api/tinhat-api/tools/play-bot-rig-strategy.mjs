// The Rig bot's brain (lab only; never shipped in the API image). PURE: decide(view, me, mem, rnd) looks at one view
// (the play contract's `rigView`, as the server sends it; the engine's own view works too, for tests) and returns the
// next move with a human-ish delay, or null. It only ever plays from what the view shows: the same information a person
// at that seat has. mem = the bot's own memory across views ({}), rnd = () => [0, 1).
//
//   → null | {a: {do, …}, at?: {round, spin, phase}, delay_ms, key}
//
// Keys: one per move KIND per moment (round/spin/phase; Whispers per round): a move the server refused
// (mem.refused[key]) or already accepted (mem.done[key]) is never sent again for that moment, even when the view
// doesn't show the change yet (a lagging view, or a mock that doesn't move).
const SYMBOLS = ["hat", "saucer", "dish", "eye", "moon", "lizard"];
const PAY = { "trips-hat": 20, trips: 8, "pair-hat": 4, pair: 1, none: 0 };
const TEMPLATES = ["bet-size", "not-moon", "last-spin", "reel-2", "trust-nobody"];

export const PACE = Object.freeze({ min_ms: 2000, max_ms: 8000, nudge_min_ms: 400, nudge_max_ms: 2500, margin_ms: 2500 });

function category(r) {
    const [a, b, c] = r;
    if (a === b && b === c) return a === "hat" ? "trips-hat" : "trips";
    for (const [x, y] of [[a, b], [a, c], [b, c]]) if (x === y) return x === "hat" ? "pair-hat" : "pair";
    return "none";
}
const paytable = (r, bet) => PAY[category(r)] * bet;
const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];

// How well each open card explains what the Spinner has seen (final reels + payouts only: what the view shows).
export function suspicions(history) {
    const s = {};
    const add = (c, n) => { s[c] = (s[c] || 0) + n; };
    let streak = 0;
    history.forEach((h, i) => {
        const prev = i ? history[i - 1] : null;
        const want = paytable(h.reels, h.bet), got = h.payout, cat = category(h.reels);
        if (got < want) {
            if (got === 0 && h.reels.includes("moon")) add("moon-tax", 2);
            if (got === 0 && h.reels[1] === "lizard") add("lizard-tax", 2);
            if (got === 0 && h.bet === 1) add("penny-pincher", 2);
            if (h.bet === 3 && got === Math.floor(want / 2)) add("big-bet-tax", 2);
            if (got === want - 1) add("skim", 2);
            if (cat === "pair" && got === 0 && h.bet === 3) add("underdog", 1);
            if (cat === "pair" && got === 0 && prev && prev.result === "loss") add("cold-streak", 1);
            if (got === 0 && streak === 2) add("rebound", 1);
            if (h.spin <= 3 && got === 0) add("slow-start", 1);
            if (h.bet !== 2 && got === Math.floor(want / 2)) add("even-money", 1);
            if (cat === "pair" && got === 0 && prev && !prev.reels.includes("hat")) add("hot-hat", 1);
        }
        if (got > want) {
            if (cat === "pair" && h.bet === 1) add("underdog", 2);
            if (streak === 1) add("rebound", 2);
            if (h.spin >= 8) add("slow-start", 2);
            if (h.bet === 2 && cat === "pair") add("even-money", 2);
            if (prev && prev.reels[0] === "hat") add("hot-hat", 2);
        }
        if (h.reels[1] === "moon" && h.bet !== 2) add("moon-monday", 1);
        if (h.reels[0] === "lizard" && h.bet === 3) add("lizard-lane", 1);
        if (h.bet === 2 && !h.reels.includes("hat")) add("hat-thief", 0.25);
        if (h.reels[1] !== "hat") add("shy-hat", 0.1);
        streak = h.result === "loss" ? streak + 1 : 0;
    });
    return s;
}

// a bet that dodges what the bot suspects most
function chooseBet(R, sus, rnd) {
    const cap = Math.max(1, Math.min(3, R.bankroll.now));
    const n = R.history.length;
    if (n < 3) return Math.min(cap, [1, 3, 2][n]); // probe each bet size first
    const avoid = new Set();
    if ((sus["big-bet-tax"] || 0) >= 2 || (sus["lizard-lane"] || 0) >= 2) avoid.add(3);
    if ((sus["penny-pincher"] || 0) >= 2) avoid.add(1);
    if ((sus["moon-monday"] || 0) >= 2) { avoid.add(1); avoid.add(3); }
    if ((sus["even-money"] || 0) >= 2) { avoid.add(1); avoid.add(3); }
    const ok = [1, 2, 3].filter((b) => b <= cap && !avoid.has(b));
    return ok.length ? pick(rnd, ok) : Math.min(cap, 1 + Math.floor(rnd() * 3));
}

const isFull = (R) => (R.features ? !!R.features.nudge : R.preset === "full");
const whisperOn = (R) => (R.features ? !!R.features.whisper : R.preset === "full");
const mutesOn = (R) => (R.features ? !!R.features.mutes : R.preset === "full");
const marketDone = (Y) => (Y.market_done != null ? !!Y.market_done : Y.market != null);

// people who hold a live card now (Peek targets): Mechanics by role, minus anyone named on a busted card who hasn't
// been refilled since (conservative: a refilled Mechanic is just skipped)
function liveMechanics(v, me) {
    const busted = new Set(v.round.board.filter((b) => b.state === "busted").map((b) => b.by));
    return v.players.filter((p) => p.role === "mechanic" && !p.left && p.u !== me && !busted.has(p.u)).map((p) => p.u);
}

export function decide(v, me, mem, rnd) {
    if (!v || v.status !== "round" || !v.round || !v.you) return null;
    const R = v.round, Y = v.you;
    const role = Y.role;
    if (!role || role === "left" || role === "spectator" || role === "waiting" || role === "seated") return null;
    const moment = `${R.r}:${R.spin}:${R.phase}`;
    mem.refused ||= {};
    mem.done ||= {};
    const left = (R.deadline != null && v.now != null) ? R.deadline - v.now : 20_000;
    const pace = mem.pace || 1;
    const delay = (lo = PACE.min_ms, hi = PACE.max_ms) => {
        const d = (lo + rnd() * (hi - lo)) / pace;
        return Math.max(0, Math.min(d, left - PACE.margin_ms)); // never let a timer act for the bot
    };
    const at = { round: R.r, spin: R.spin, phase: R.phase };
    const keyOf = (a) => (a.do === "whisper" ? `${R.r}:whisper` : a.do === "mute" ? `${moment}:mute:${a.armed}` : `${moment}:${a.do}`);
    const move = (a, d, needsAt = true) => {
        const key = keyOf(a);
        if (mem.refused[key] || mem.done[key]) return null;
        return { a, ...(needsAt ? { at } : {}), delay_ms: d, key };
    };
    const first = (...cands) => { for (const c of cands) { const m = c(); if (m) return m; } return null; }; // lazy: no side effects of a loser

    if (R.phase === "setup") {
        return first(
            () => (role === "mechanic" && Y.deal && !Y.kept ? move({ do: "keep", card: Y.deal[rnd() < 0.5 ? 0 : 1] }, delay()) : null),
            () => (role !== "spinner" && role !== "railbird" && !marketDone(Y)
                ? ((Y.holdings ?? 99) >= 1 && rnd() < 0.6
                    ? move({ do: "market", side: rnd() < 0.5 ? "up" : "not-up", stake: (Y.holdings ?? 99) >= 4 && rnd() < 0.3 ? 2 : 1 }, delay())
                    : null) || move({ do: "market", side: "pass" }, delay())
                : null),
            () => (role !== "spinner" && whisperOn(R) && !Y.whisper_used && !mem.whisperTried?.[R.r] && rnd() < 0.15
                ? (mem.whisperTried = { ...(mem.whisperTried || {}), [R.r]: true }, move({ do: "whisper", template: pick(rnd, TEMPLATES) }, delay()))
                : null),
        );
    }

    if (R.phase === "nudge") {
        if (role === "spinner" || !(Y.nudge_left > 0) || !isFull(R) || mem.nudgeSkip === moment) return null;
        if (rnd() > 0.3) { mem.nudgeSkip = moment; return null; } // most windows pass
        const reels = R.reels || R.landing?.reels;
        if (!reels) return null;
        const bet = R.bet ?? R.landing?.bet ?? 1;
        const side = Y.market?.side;
        let best = null;
        for (const reel of [1, 2, 3]) for (const step of [1, -1]) {
            const r2 = [...reels];
            r2[reel - 1] = SYMBOLS[(SYMBOLS.indexOf(r2[reel - 1]) + step + 6) % 6];
            const score = paytable(r2, bet) * (side === "not-up" ? -1 : 1) + rnd() * 0.5;
            if (!best || score > best.score) best = { reel, step, score };
        }
        return move({ do: "nudge", reel: best.reel, step: best.step }, delay(PACE.nudge_min_ms, PACE.nudge_max_ms));
    }

    if (R.phase !== "turn") return null;

    if (role === "spinner") {
        const sus = suspicions(R.history);
        mem.turn ||= {};
        const T = mem.turn[moment] ||= {};
        if (!R.audit_used && R.history.length >= 3 && !T.auditTried && rnd() < 0.2) {
            T.auditTried = true;
            const worst = [...R.history].sort((a, b) => (paytable(b.reels, b.bet) - b.payout) - (paytable(a.reels, a.bet) - a.payout))[0];
            const m = move({ do: "audit", spin: worst.spin }, delay(1500, 4000));
            if (m) return m;
        }
        if (R.calls_left > 0 && !R.call_used_this_spin && R.bankroll.now >= 2 && !T.callTried) {
            T.callTried = true;
            const open = R.board.filter((b) => b.state === "open").map((b) => b.card);
            const ranked = open.map((c) => [c, sus[c] || 0]).sort((a, b) => b[1] - a[1]);
            if (ranked.length && ranked[0][1] >= 2 && rnd() < 0.7) {
                const m = move({ do: "call", card: ranked[0][0] }, delay(1500, 4000));
                if (m) return m;
            }
        }
        const net = R.bankroll.now - R.bankroll.start;
        if (R.spin >= R.walk_from && !T.walkTried && (net >= 4 || R.bankroll.now <= 2) && rnd() < 0.5) {
            T.walkTried = true;
            const m = move({ do: "walk" }, delay(1500, 4000));
            if (m) return m;
        }
        const bet = T.bet ||= chooseBet(R, sus, rnd);
        if (!T.dialed && R.dial !== bet) {
            T.dialed = true;
            // sometimes a feint: show 3 first, then the real bet
            const show = R.bankroll.now >= 3 && rnd() < 0.15 ? 3 : bet;
            if (show !== bet) T.feint = true;
            return { a: { do: "dial", bet: show }, at, delay_ms: delay(1000, 3000), key: `${moment}:dial:${show}`, noAck: true };
        }
        if (T.feint && R.dial !== bet && !T.unfeint) {
            T.unfeint = true;
            return { a: { do: "dial", bet }, at, delay_ms: delay(500, 1500), key: `${moment}:dial:${bet}`, noAck: true };
        }
        return move({ do: "spin", bet: Math.min(bet, R.bankroll.now) }, delay(1000, 4000));
    }

    // House in a TURN
    mem.house ||= {};
    const T = mem.house[moment] ||= {};
    if (T.done) return null;
    T.done = true; // one thought per turn per House member
    if (role === "mechanic" && Y.patch && Y.patch.ok && rnd() < 0.8) return move({ do: "patch" }, delay(1500, 4000));
    if (role === "mechanic" && Y.card && mutesOn(R) && !Y.armed && Y.mutes_left > 0 && rnd() < 0.15) return move({ do: "mute", armed: true }, delay(1500, 4000));
    if (role === "mechanic" && Y.armed && rnd() < 0.3) return move({ do: "mute", armed: false }, delay(1500, 4000));
    const locked = R.peeks_locked ?? (R.spin > R.peek_lock_after);
    if ((role === "mechanic" || role === "sharp") && Y.peek && !Y.peek.placed && !locked && (Y.holdings ?? 99) >= 2 && rnd() < 0.2) {
        const targets = liveMechanics(v, me);
        const open = R.board.filter((b) => b.state === "open" && b.card !== Y.card?.card).map((b) => b.card);
        if (targets.length && open.length) return move({ do: "peek", mechanic: pick(rnd, targets), card: pick(rnd, open) }, delay(1500, 5000));
    }
    if (whisperOn(R) && !Y.whisper_used && !mem.whisperTried?.[R.r] && rnd() < 0.08) {
        mem.whisperTried = { ...(mem.whisperTried || {}), [R.r]: true };
        const mechs = liveMechanics(v, me);
        if (mechs.length && rnd() < 0.3) return move({ do: "whisper", template: "bluffing", person: pick(rnd, mechs) }, delay());
        return move({ do: "whisper", template: pick(rnd, TEMPLATES) }, delay());
    }
    return null;
}
