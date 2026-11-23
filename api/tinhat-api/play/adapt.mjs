// Engine view → the frozen play contract (vectors/views/schema.json). The engines play with WALLET ids (so nothing
// they keep names a person: the deletion guarantee, §2.2); their views are already filtered per viewer. This layer only
// RESHAPES that filtered view, maps wallet ids to Matrix ids, and adds what only the platform knows (room, owner,
// connections, screens, holdings, the cap). From the engine's own state it reads public facts only: seat order, who has
// spun / was skipped, and a finished hand's net (public at its end). Its output is checked against the schema and the
// privacy rules in the tests (test/play-platform.test.mjs).
import { paytableOf } from "./rig-rules.mjs";
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o && o[k] !== undefined) r[k] = o[k]; return r; };

/** ctx: {room, owner, mx(wid) → mxid (or "~n" placeholders in history), connected(wid) → bool, screens(wid) → [...],
 *  wallet(wid) → {holdings, at_cap, cap}, spectators, closedAt, now} */
export function holdemContract(v, st, viewerWid, ctx) {
    const mx = ctx.mx;
    const h = v.hand;
    const done = !!(h && h.result);
    const seats = v.seats.map((s) => {
        const o = { seat: s.seat, u: mx(s.u), stack: s.stack, bet: s.bet, state: s.waiting ? "waiting" : s.state, cards: s.cards === 2 ? 2 : 0, connected: !!ctx.connected(s.u) };
        if (s.shown) o.shown = [...s.shown];
        const rk = ctx.rank ? ctx.rank(s.u) : null;
        if (rk !== null && rk !== undefined) o.rank = rk;
        if (s.away !== undefined) o.away = awayOf(s.away); // v1.1 (B10): null or {reason, since, stand_at, hands_left}
        return o;
    });
    const out = {
        game: "holdem", table: v.table, room: ctx.room, space: v.space, owner: ctx.owner, vseq: Math.max(1, v.vseq), now: ctx.now,
        status: v.status === "closed" ? "closed" : v.status, host: v.host ? mx(v.host) : ctx.hostMx,
        opts: { sb: 1, bb: 2, seats: v.opts.seats, turn_s: 30 },
        seats, hand: null, result: null, closed: null, spectators: ctx.spectators || 0,
    };
    if (h) {
        const shownAny = seats.some((s) => s.shown);
        out.hand = {
            n: h.n, button: h.button, sb: h.blinds.sb, bb: h.blinds.bb,
            street: done && shownAny ? "showdown" : h.street, board: [...h.board],
            pots: done ? [] : h.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] })),
            total: done ? 0 : h.total,
            to_act: h.to_act ? pick(h.to_act, ["seat", "turn", "deadline"]) : null,
            last: h.last ? { seat: h.last.seat, a: h.last.a, ...(h.last.to !== undefined ? { to: h.last.to } : {}) } : null,
        };
        if (done) {
            const shown = {}, best = {};
            // every hand shown at the showdown, also of a player who has left since (their seat row is gone)
            for (const [k, cs] of Object.entries(h.result.shown || {})) shown[k] = [...cs];
            for (const [k, b] of Object.entries(h.result.best || {})) if (shown[k]) best[k] = { category: b.category, five: [...b.five] };
            const net = {};
            for (const [wid, n] of Object.entries(st.hand?.result?.net || {})) if (n !== 0) net[mx(wid)] = n;
            out.result = {
                n: h.n, board: [...h.board],
                pots: h.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible], winners: [...p.winners], paid: { ...p.paid } })),
                returned: { ...(h.result.returned || {}) }, shown, best, net, voided: false, next_at: v.next_at ?? null,
            };
        }
    }
    if (v.status === "closed") out.closed = { reason: ctx.closedReason || "host", at: ctx.closedAt || ctx.now };
    if (ctx.voidedHand) out.result = { n: ctx.voidedHand, board: [], pots: [], returned: {}, shown: {}, best: {}, net: {}, voided: true, next_at: null };
    if (v.you && viewerWid) {
        const seat = seats.find((s) => s.seat === v.you.seat);
        const w = ctx.wallet(viewerWid);
        out.you = {
            seat: v.you.seat, state: seat ? seat.state : "waiting", cards: [...(v.you.cards || [])],
            legal: v.you.legal ? { fold: !!v.you.legal.fold, check: !!v.you.legal.check, call: v.you.legal.call || 0, raise: v.you.legal.raise ? { min: v.you.legal.raise.min, max: v.you.legal.raise.max } : null } : null,
            screens: ctx.screens(viewerWid), at_cap: !!w.at_cap, cap: w.cap, holdings: w.holdings,
            timeouts: Math.min(2, (Object.values(st.seats || {}).find((x) => x.id === viewerWid) || {}).timeouts || 0),
            ...(typeof v.you.can_deal === "boolean" ? { can_deal: v.you.can_deal } : {}),
            ...(v.you.away !== undefined ? { away: awayOf(v.you.away) } : {}),
        };
    }
    return out;
}

const AWAY_REASONS = new Set(["timeout", "gone", "asked"]);
const awayOf = (a) => (a && AWAY_REASONS.has(a.reason) ? { reason: a.reason, since: a.since, stand_at: a.stand_at, hands_left: a.hands_left } : null);

const RIG_ROLES = new Set(["spinner", "mechanic", "sharp", "railbird"]);
export function rigContract(v, st, viewerWid, ctx) {
    const mx = ctx.mx;
    // the engine's view carries every public fact the contract needs (docs/GAMES-RIG-ENGINE.md "Public view fields");
    // a busted Mechanic stays `mechanic` (round.roster) with busted: true
    const roster = new Set(v.round?.roster || []);
    const roleOf = (p) => (roster.has(p.u) && v.status === "round" ? "mechanic" : RIG_ROLES.has(p.role) ? p.role : null);
    const players = (v.players || []).map((p, i) => {
        const o = {
            u: mx(p.u), order: Number.isInteger(p.order) && p.order >= 1 ? p.order : i + 1, role: roleOf(p), connected: p.connected ?? !!ctx.connected(p.u), left: !!p.left,
            spun: !!p.spun, skipped: !!p.skipped,
        };
        const rk = ctx.rank ? ctx.rank(p.u) : null; // B3: the prestige rank beside the name (left out when unknown)
        if (rk !== null && rk !== undefined) o.rank = rk;
        if (p.away !== undefined) o.away = awayOf(p.away); // v1.1 B10 (hands_left = rounds left before standing up)
        return o;
    });
    const out = {
        game: "rig", table: v.table, room: ctx.room, space: v.space, owner: ctx.owner, vseq: Math.max(1, v.vseq), now: ctx.now,
        status: v.status === "closed" ? "closed" : v.status === "end" ? "end" : v.status === "round" ? "round" : "lobby",
        host: v.host ? mx(v.host) : ctx.hostMx, opts: { preset: v.opts.preset || "lite", bankroll: v.opts.bankroll ?? 6, patch: v.opts.patch !== false },
        players, round: null, end: null, closed: null, spectators: ctx.spectators || 0,
    };
    const r = v.round;
    if (r && out.status === "round") {
        const full = r.preset === "full";
        const landing = r.landing || null;
        const phase = r.phase;
        out.round = {
            r: r.r, spinner: mx(r.spinner), preset: r.preset, phase, spin: phase === "setup" ? 0 : Math.min(10, r.spin), spins: r.spins,
            deadline: r.paused ? null : (r.deadline ?? null), seed_commit: r.seed_commit,
            bankroll: { start: r.bankroll.start, now: r.bankroll.now }, net: r.bankroll.now - r.bankroll.start,
            dial: r.dial, bet: r.bet ?? (landing ? landing.bet : null),
            calls_left: r.calls_left, call_used_this_spin: !!r.call_used_this_spin, audit_used: !!r.audit_used,
            walk_from: r.walk_from, peek_lock_after: r.peek_lock_after, peeks_locked: r.spin > r.peek_lock_after,
            features: { mutes: r.mutes !== undefined ? !!r.mutes : full, nudge: !!r.nudges, whisper: !!r.whispers, patch: r.patch !== undefined ? !!r.patch : full && out.opts.patch },
            board: r.board.map((b) => (b.state === "busted" ? { card: b.card, state: "busted", by: mx(b.by), spin: b.spin } : { card: b.card, state: b.state })),
            dead: [...r.dead], mechanics: (r.roster || r.mechanics || []).length,
            refilled: (r.refilled || []).map((x) => ({ spin: x.spin })),
            history: (r.history || []).map((h) => ({ spin: h.spin, bet: h.bet, reels: [...h.reels], payout: h.payout, result: h.result, stamps: (h.stamps || []).filter((s) => ["nudged", "audited", "called-right", "called-wrong", "refilled"].includes(s)) })),
            reels: landing ? [...landing.reels] : null,
            nudge: phase === "nudge" ? { open: true, deadline: r.deadline ?? null } : null,
            waiting_on: phase === "setup" ? Math.min(8, r.waiting_on || 0) : 0,
            paused: r.paused ? { budget_ms: Math.max(0, (r.deadline ?? ctx.now) - ctx.now) } : null,
        };
        if (r.audit) out.round.audit = { spin: r.audit.spin, honest_reels: [...r.audit.honest_reels], honest_payout: r.audit.honest_payout, touched: r.audit.touched };
        if (phase === "reveal" && v.reveal) out.round.reveal = mapReveal(v.reveal, mx);
    }
    if (out.status === "end" && v.table_end) out.end = { rounds: Math.max(1, v.table_end.rounds || st.rounds || 1), leaderboard: (v.table_end.leaderboard || []).map((x) => ({ u: mx(x.u), net: x.net })), pit_boss: Array.isArray(v.table_end.pit_boss) ? (v.table_end.pit_boss[0] ? mx(v.table_end.pit_boss[0]) : null) : (v.table_end.pit_boss ? mx(v.table_end.pit_boss) : null) };
    if (out.status === "closed") out.closed = { reason: v.closed_reason === "space-changed" ? "space-changed" : (ctx.closedReason || v.closed_reason || "host"), at: ctx.closedAt || v.closed_at || ctx.now };
    if (viewerWid && v.you && !["spectator", "left"].includes(v.you.role) && players.some((p) => p.u === mx(viewerWid) && !p.left)) out.you = rigYou(v.you, out, viewerWid, ctx, roster.has(viewerWid));
    return out;
}

function rigYou(y, out, wid, ctx, inRoster = false) {
    const w = ctx.wallet(wid);
    const base = { screens: ctx.screens(wid), at_cap: !!w.at_cap, holdings: w.holdings, away: (out.players.find((p) => p.u === ctx.mx(wid)) || {}).away ?? null }; // v1.1 you.away (astra r2 N6)
    const role = !out.round ? null : inRoster ? "mechanic" : RIG_ROLES.has(y.role) ? y.role : null;
    const peek = (p) => ({ placed: !!(p && p.placed), ...(p && p.mechanic ? { mechanic: ctx.mx(p.mechanic), card: p.card } : {}), locks_after: p?.locks_after ?? out.round.peek_lock_after });
    const market = (m) => (m && m.side && m.side !== "pass" ? { side: m.side, stake: m.stake } : null);
    if (role === "spinner") return { role, whispers: (y.whispers || []).map((x) => ({ spin: x.spin ?? 0, ...(x.template ? { template: x.template } : {}), ...(x.person ? { person: ctx.mx(x.person) } : {}), ...(x.text ? { text: x.text } : {}) })), ...base, timeouts: Math.min(2, y.timeouts || 0) };
    if (role === "mechanic") {
        const o = {
            role, kept: !!y.kept, card: y.busted ? null : (y.card ? { card: y.card.card, bite: y.card.bite } : null), busted: !!y.busted,
            patch: y.patch ? { card: y.patch.card, ok: !!y.patch.ok } : null, mutes_left: y.mutes_left || 0, armed: !!y.armed, rake: y.rake || 0,
            call_shares: y.call_shares || 0, nudge_left: y.nudge_left || 0, whisper_used: !!y.whisper_used, peek: peek(y.peek),
            market: market(y.market), market_done: !!y.market, ...base,
        };
        if (out.round.phase === "setup" && !y.kept && y.deal) o.deal = [...y.deal];
        return o;
    }
    if (role === "sharp") return { role, nudge_left: y.nudge_left || 0, whisper_used: !!y.whisper_used, peek: peek(y.peek), market: market(y.market), market_done: !!y.market, ...base };
    if (role === "railbird") return { role, nudge_left: y.nudge_left || 0, whisper_used: !!y.whisper_used, ...base };
    return { role: null, ...base };
}

/** The reveal block, people mapped (also for GET /tables/{id}/rounds/{r}, with "~n" for deleted people). */
export function mapReveal(rv, mx) {
    const m = (u) => (u ? mx(u) : u);
    // the engine numbers slots from 0 and keys a spin's rake by owner; the contract numbers slots from 1 and keys rake by
    // the card that bit (the card each owner held in that spin: their slot, from_spin ≤ spin, not busted before it)
    const base0 = (rv.slots || []).some((s) => s.slot === 0);
    const cardOf = (owner, spin) => {
        const s = (rv.slots || []).filter((x) => x.owner === owner && x.from_spin <= spin && (x.busted_spin == null || x.busted_spin >= spin)).sort((a, b) => b.from_spin - a.from_spin)[0];
        return s ? s.card : null;
    };
    const rakeByCard = (sp) => {
        const out = {};
        for (const [k, n] of Object.entries(sp.rake || {})) {
            if (!(n > 0)) continue;
            const card = /^[a-z-]+$/.test(k) && !k.startsWith("@") && !k.startsWith("w") ? k : cardOf(k, sp.spin);
            if (card) out[card] = (out[card] || 0) + n;
        }
        return out;
    };
    const netOut = {};
    for (const [k, n] of Object.entries(rv.net || {})) netOut[m(k)] = n;
    return {
        seed: rv.seed,
        slots: (rv.slots || []).map((s) => ({ slot: base0 ? s.slot + 1 : s.slot, card: s.card, owner: m(s.owner), from_spin: s.from_spin })),
        mutes: (rv.mutes || []).map((x) => ({ spin: x.spin, owner: m(x.owner) })),
        nudges: (rv.nudges || []).map((x) => ({ spin: x.spin, by: m(x.by), reel: x.reel, step: x.step })),
        calls: (rv.calls || []).map((x) => ({ spin: x.spin, card: x.card, right: !!x.right, owner: x.owner ? m(x.owner) : null })),
        peeks: (rv.peeks || []).map((x) => ({ who: m(x.who), target: m(x.target), card: x.card, right: !!x.right, delta: x.delta })),
        market: (rv.market || []).map((x) => ({ who: m(x.who), side: x.side, stake: x.stake, back: x.back })),
        whispers: (rv.whispers || []).map((x) => ({ who: m(x.who), spin: x.spin ?? 0, ...(x.template ? { template: x.template } : {}), ...(x.person ? { person: m(x.person) } : {}), ...(x.text ? { text: x.text } : {}) })),
        spins: (rv.spins || []).map((s) => ({ spin: s.spin, bet: s.bet, honest: [...s.honest], after_cards: [...s.after_cards], final: [...s.final], honest_payout: s.honest_payout ?? paytableOf(s.honest, s.bet), payout: s.payout, touched: [...(s.touched || [])], bit: [...(s.bit || [])], rake: s.rake_cards ? Object.fromEntries(Object.entries(s.rake_cards).filter(([, n]) => n > 0)) : rakeByCard(s) })),
        up: !!rv.up, net: netOut,
    };
}
