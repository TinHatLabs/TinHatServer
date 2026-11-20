// Per-viewer views (GAMES-V1-SPEC §4.3, §5.3): the ONE place that decides what each person may see. A table's full
// ("god") state goes in, the viewer's view comes out. Everything secret (hole cards, live cards, deals, slot order,
// Mutes, Peeks, Market bets, Whisper authors, the seed, the Spinner's Audit) is copied out field by field, never by
// spreading the god state, so a new secret field can't leak by default. The contract fixtures (vectors/views/) are
// generated through these same functions, and the tests check every frame against schema.json.

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// ------------------------------------------------------------------------------------------------ Hold'em
/**
 * g: { table, room, vseq, now, status, host, opts, spectators, closed,
 *      seats: [{ seat, u, stack, bet, state, hole: [c, c] | [], connected, screens, timeouts, holdings, cap, at_cap }],
 *      hand: null | { n, button, sb, bb, street, board, pots, total, to_act, last, legal (for to_act.seat), show: [seat…] },
 *      result: null | { n, board, pots, returned, shown, best, net, voided, next_at } }
 * viewer: an mxid (seated → gets `you`), or null / anyone else = the public view.
 */
export function holdemView(g, viewer) {
    // cards are shown only at a showdown, and only for seats still in the hand (never a folded hand, never an
    // uncontested win, never a void)
    const atShowdown = g.hand?.street === "showdown";
    const stillIn = new Set(g.seats.filter((s) => s.state !== "folded").map((s) => s.seat));
    const showing = new Set(atShowdown ? (g.hand?.show || []).filter((n) => stillIn.has(n)) : []);
    const resultShown = g.result && !g.result.voided ? showing : new Set();
    const v = {
        game: "holdem", table: g.table, room: g.room, space: g.space, owner: g.owner, vseq: g.vseq, now: g.now, status: g.status, host: g.host,
        opts: pick(g.opts, ["sb", "bb", "seats", "turn_s"]),
        seats: g.seats.map((s) => {
            const o = { seat: s.seat, u: s.u, stack: s.stack, bet: s.bet, state: s.state, cards: s.state === "folded" ? 0 : (s.hole || []).length, connected: !!s.connected };
            if (showing.has(s.seat) && (s.hole || []).length === 2) o.shown = [...s.hole];
            return o;
        }),
        hand: g.hand ? {
            n: g.hand.n, button: g.hand.button, sb: g.hand.sb, bb: g.hand.bb, street: g.hand.street,
            board: [...g.hand.board], pots: g.hand.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] })), total: g.hand.total,
            to_act: g.hand.to_act ? pick(g.hand.to_act, ["seat", "turn", "deadline"]) : null,
            last: g.hand.last ? pick(g.hand.last, ["seat", "a", "to"]) : null,
        } : null,
        result: g.result ? {
            n: g.result.n, board: [...(g.result.board || [])],
            pots: (g.result.pots || []).map((p) => ({ amount: p.amount, eligible: [...p.eligible], winners: [...p.winners], paid: { ...p.paid } })),
            returned: { ...(g.result.returned || {}) },
            shown: Object.fromEntries(Object.entries(g.result.shown || {}).filter(([k]) => resultShown.has(Number(k))).map(([k, c]) => [k, [...c]])),
            best: Object.fromEntries(Object.entries(g.result.best || {}).filter(([k]) => resultShown.has(Number(k))).map(([k, b]) => [k, { category: b.category, five: [...b.five] }])),
            net: { ...(g.result.net || {}) }, voided: !!g.result.voided, next_at: g.result.next_at ?? null,
        } : null,
        closed: g.closed ? pick(g.closed, ["reason", "at"]) : null,
        spectators: g.spectators || 0,
    };
    const me = viewer ? g.seats.find((s) => s.u === viewer) : null;
    if (me) {
        const myTurn = g.hand?.to_act && g.hand.to_act.seat === me.seat && g.hand.legal;
        v.you = {
            seat: me.seat, state: me.state, cards: [...(me.hole || [])],
            legal: myTurn ? clone(g.hand.legal) : null,
            screens: [...(me.screens || [])], at_cap: !!me.at_cap, cap: me.cap, holdings: me.holdings,
            timeouts: me.timeouts || 0,
        };
        if (g.status === "lobby" && g.host === viewer && g.can_deal !== undefined) v.you.can_deal = !!g.can_deal;
    }
    return v;
}

// ------------------------------------------------------------------------------------------------ The Rig
const ROUND_PUBLIC = ["r", "spinner", "preset", "phase", "spin", "spins", "deadline", "seed_commit", "bankroll", "net", "dial",
    "bet", "calls_left", "call_used_this_spin", "audit_used", "walk_from", "peek_lock_after", "peeks_locked", "features", "board", "dead", "mechanics",
    "refilled", "history", "reels", "nudge", "waiting_on", "paused"];

/**
 * g: { table, room, vseq, now, status, host, opts, spectators, closed, end,
 *      players: [{ u, order, role, connected, left, spun, holdings, at_cap, screens, timeouts,
 *                  // secrets, only ever copied into that person's own `you`:
 *                  deal, kept, card, busted, patch, mutes_left, armed, rake, nudge_left, whisper_used, peek, market, market_done }],
 *      round: null | { …ROUND_PUBLIC, whispers: [{ who, spin, template?, person?, text? }], audit?, reveal? } }
 */
export function rigView(g, viewer) {
    const r = g.round;
    const v = {
        game: "rig", table: g.table, room: g.room, space: g.space, owner: g.owner, vseq: g.vseq, now: g.now, status: g.status, host: g.host,
        opts: pick(g.opts, ["preset", "bankroll", "patch"]),
        players: g.players.map((p) => ({ u: p.u, order: p.order, role: p.role ?? null, connected: !!p.connected, left: !!p.left, spun: !!p.spun, skipped: !!p.skipped })),
        round: null,
        end: g.end ? { rounds: g.end.rounds, leaderboard: g.end.leaderboard.map((x) => ({ u: x.u, net: x.net })), pit_boss: g.end.pit_boss ?? null } : null,
        closed: g.closed ? pick(g.closed, ["reason", "at"]) : null,
        spectators: g.spectators || 0,
    };
    if (r) {
        const reels = (x) => (x ? [x[0], x[1], x[2]] : null);
        v.round = {
            r: r.r, spinner: r.spinner, preset: r.preset, phase: r.phase, spin: r.spin, spins: r.spins, deadline: r.deadline ?? null,
            seed_commit: r.seed_commit, bankroll: { start: r.bankroll.start, now: r.bankroll.now }, net: r.net, dial: r.dial, bet: r.bet ?? null,
            calls_left: r.calls_left, call_used_this_spin: !!r.call_used_this_spin, audit_used: !!r.audit_used,
            walk_from: r.walk_from, peek_lock_after: r.peek_lock_after, peeks_locked: !!r.peeks_locked,
            features: pick(r.features, ["mutes", "nudge", "whisper", "patch"]),
            board: r.board.map((b) => (b.state === "busted" ? pick(b, ["card", "state", "by", "spin"]) : pick(b, ["card", "state"]))),
            dead: [...r.dead], mechanics: r.mechanics,
            refilled: (r.refilled || []).map((x) => ({ spin: x.spin })),
            history: (r.history || []).map((h) => ({ spin: h.spin, bet: h.bet, reels: reels(h.reels), payout: h.payout, result: h.result, stamps: h.stamps.filter((x) => ["nudged", "audited", "called-right", "called-wrong", "refilled"].includes(x)) })),
            reels: reels(r.reels),
            nudge: r.nudge ? { open: !!r.nudge.open, deadline: r.nudge.deadline ?? null, ...(r.nudge.open ? {} : pick(r.nudge, ["reel", "step"])) } : null,
            waiting_on: r.waiting_on || 0,
            paused: r.paused ? { budget_ms: r.paused.budget_ms } : null,
        };
        if (r.phase === "reveal" && r.reveal) v.round.reveal = clone(r.reveal); // the whole reveal is public at REVEAL (§5.3)
        if (r.audit && viewer && viewer === r.spinner) v.round.audit = { spin: r.audit.spin, honest_reels: reels(r.audit.honest_reels), honest_payout: r.audit.honest_payout, touched: r.audit.touched };
    }
    const me = viewer ? g.players.find((p) => p.u === viewer && !p.left) : null;
    if (me) {
        const base = { screens: [...(me.screens || [])], at_cap: !!me.at_cap, holdings: me.holdings };
        const role = r ? me.role ?? null : null;
        if (role === "spinner") {
            v.you = { role, whispers: (r.whispers || []).map((w) => pick(w, ["spin", "template", "person", "text"])), ...base, timeouts: me.timeouts || 0 };
            // (never `who`: Whisper authors only at the reveal)
        } else if (role === "mechanic") {
            v.you = {
                role, kept: !!me.kept, card: me.card ? pick(me.card, ["card", "bite"]) : null, busted: !!me.busted,
                patch: me.patch ? pick(me.patch, ["card", "ok"]) : null,
                mutes_left: me.mutes_left || 0, armed: !!me.armed, rake: me.rake || 0, call_shares: me.call_shares || 0,
                nudge_left: me.nudge_left || 0, whisper_used: !!me.whisper_used,
                peek: pick(me.peek || { placed: false, locks_after: r.peek_lock_after }, ["placed", "mechanic", "card", "locks_after"]),
                market: me.market ? pick(me.market, ["side", "stake"]) : null, market_done: !!me.market_done, ...base,
            };
            if (r.phase === "setup" && !me.kept && me.deal) v.you.deal = [...me.deal];
        } else if (role === "sharp") {
            v.you = {
                role, nudge_left: me.nudge_left || 0, whisper_used: !!me.whisper_used,
                peek: pick(me.peek || { placed: false, locks_after: r.peek_lock_after }, ["placed", "mechanic", "card", "locks_after"]),
                market: me.market ? pick(me.market, ["side", "stake"]) : null, market_done: !!me.market_done, ...base,
            };
        } else if (role === "railbird") {
            v.you = { role, nudge_left: me.nudge_left || 0, whisper_used: !!me.whisper_used, ...base };
        } else {
            v.you = { role: null, ...base };
        }
    }
    return v;
}

export function viewFor(g, viewer) {
    return g.game === "rig" ? rigView(g, viewer) : holdemView(g, viewer);
}

/** The listing a `room` frame / GET /rooms/{room}/tables carries (§6.2). */
export function listing(g) {
    if (g.game === "rig") {
        const players = g.players.filter((p) => !p.left).map((p) => p.u);
        return { table: g.table, game: "rig", status: g.status, host: g.host, seated: players.length, seats: 8, players, hand: null, round: g.round ? g.round.r : null, space: g.space, owner: g.owner };
    }
    const players = g.seats.map((s) => s.u);
    return { table: g.table, game: "holdem", status: g.status, host: g.host, seated: players.length, seats: g.opts.seats, players, hand: g.hand ? g.hand.n : null, round: null, space: g.space, owner: g.owner };
}
