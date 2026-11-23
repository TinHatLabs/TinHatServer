// The wallet rules, pure (GAMES-V1-SPEC §2.1-§2.4, §2.7; vectors/ledger.json). No clock, no database: the ledger
// (ledger.mjs) loads a wallet's numbers, asks these functions what changes, and writes the answer as journal
// transactions in the same database transaction. Every number the owner may change is one named value here or in the
// server's config (PLAY_DAY_MAX / PLAY_START, bounds below); everything else is fixed in v1.

/** Fixed in v1 (§2.7: not admin-tweakable). Kept as the v1 numbers: vectors/ledger.json runs with these + V1_DEFAULTS. */
export const FIXED = Object.freeze({
    chip_s: 3600, // v1: one chip per 3 600 counted seconds in a call (v1.1: chip_minutes, per space)
    tick_max_s: 90, // one sample never pays more than 90 s (a stalled sampler can't pay for time it didn't see)
    topup_to: 5, // the daily top-up, only at exactly 0
    prestige_to: 10, // holdings after a prestige
    cap_base: 100, cap_per_rank: 50, // cap = 100 + 50 × rank
});
/** The v1 defaults of the two v1 tweakables: what vectors/ledger.json's cases are written against (addendum §6.3). */
export const V1_DEFAULTS = Object.freeze({ ...FIXED, day_max: 8, start: 10 });

/** v1.1 (addendum §5.2 / §6.3, CHANGES v1 §2.1 / §2.7): every economy key, per space, with its default and bounds.
 *  Resolution: the space's own value → the server-wide value (env, the dashboard / `tinhat play config`) → the default. */
export const PLAY_DEFAULTS_V11 = Object.freeze({
    chip_minutes: 15, day_max: 16, start: 10, topup_to: 5, cap_base: 100, cap_per_rank: 50, side_day_max: 10, side_on: true,
});
export const ECONOMY_BOUNDS = Object.freeze({
    chip_minutes: { min: 2, max: 60 }, day_max: { min: 1, max: 200 }, start: { min: 0, max: 500 }, topup_to: { min: 0, max: 100 },
    cap_base: { min: 20, max: 100_000 }, cap_per_rank: { min: 0, max: 100_000 }, side_day_max: { min: 0, max: 100 }, side_on: { bool: true },
});
export const ECONOMY_KEYS = Object.freeze(Object.keys(PLAY_DEFAULTS_V11));
/** One economy value checked against its bounds: the value, or undefined when it isn't valid. */
export function economyValue(k, v) {
    const b = ECONOMY_BOUNDS[k];
    if (!b) return undefined;
    if (b.bool) return typeof v === "boolean" ? v : undefined;
    return Number.isSafeInteger(v) && v >= b.min && v <= b.max ? v : undefined;
}
/** Kept for 0.3.20 callers: the two v1 tweakables (now with the v1.1 bounds). */
export const TWEAKABLE = Object.freeze({
    day_max: { default: PLAY_DEFAULTS_V11.day_max, ...ECONOMY_BOUNDS.day_max },
    start: { default: PLAY_DEFAULTS_V11.start, ...ECONOMY_BOUNDS.start },
});

/** The server's play config from its environment (PLAY_<KEY> for every economy key, PLAY_TZ). Never throws. `src`
 *  says per key whether the value is the server's own ("server") or the default. */
export function configFromEnv(env = process.env, warn = () => {}) {
    const out = { tick_max_s: FIXED.tick_max_s, prestige_to: FIXED.prestige_to, tz: validTz(env.PLAY_TZ) ? env.PLAY_TZ : "UTC", src: {} };
    for (const k of ECONOMY_KEYS) {
        const raw = env[`PLAY_${k.toUpperCase()}`];
        let v = PLAY_DEFAULTS_V11[k], src = "default";
        if (raw !== undefined && raw !== "") {
            const t = String(raw).trim();
            const n = ECONOMY_BOUNDS[k].bool ? (t === "true" || t === "1" ? true : t === "false" || t === "0" ? false : undefined) : /^\d+$/.test(t) ? Number(t) : NaN;
            const ok = economyValue(k, n);
            if (ok !== undefined) { v = ok; src = "server"; }
            else warn(`PLAY_${k.toUpperCase()}=${JSON.stringify(raw)} is outside its bounds: keeping ${PLAY_DEFAULTS_V11[k]}`);
        }
        out[k] = v; out.src[k] = src;
    }
    out.chip_s = out.chip_minutes * 60;
    // a LAB-ONLY fast chip clock (§8.1 "a lab box with a fast clock"): honoured only with TINHAT_LAB=1, which the manager
    // never writes and no image sets; anywhere else it is ignored with one warning. It wins over every chip_minutes.
    if (env.PLAY_CHIP_SECONDS !== undefined && env.PLAY_CHIP_SECONDS !== "") {
        const n = /^\d+$/.test(String(env.PLAY_CHIP_SECONDS).trim()) ? Number(env.PLAY_CHIP_SECONDS) : NaN;
        if (env.TINHAT_LAB === "1" && Number.isInteger(n) && n >= 10 && n <= 3600) { out.chip_s = n; out.lab_chip_s = n; warn(`LAB: one chip per ${n} s in a call (PLAY_CHIP_SECONDS, TINHAT_LAB=1)`); }
        else warn(`PLAY_CHIP_SECONDS ignored (only on a lab box with TINHAT_LAB=1, 10-3600): one chip per ${out.chip_s} s`);
    }
    return out;
}

/** The economy for one space: the server's config with the space's own valid values on top (addendum §5.2).
 *  space = the play_space_economy.settings object ({} = none). Adds `src` per key: "space" | "server" | "default". */
export function economyFor(base, space = {}) {
    const out = { ...base, src: { ...(base.src || {}) } };
    for (const k of ECONOMY_KEYS) {
        if (!space || !(k in space)) continue;
        const v = economyValue(k, space[k]);
        if (v !== undefined) { out[k] = v; out.src[k] = "space"; }
    }
    // the chip clock follows a space's own chip_minutes; otherwise the server's (a caller's explicit chip_s, e.g. the v1
    // vectors' 3 600, is kept)
    out.chip_s = base.lab_chip_s || (out.src.chip_minutes === "space" ? out.chip_minutes * 60 : base.chip_s ?? out.chip_minutes * 60);
    return out;
}

function validTz(tz) {
    if (!tz || typeof tz !== "string") return false;
    try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch { return false; }
}

/** The server day (YYYY-MM-DD) of an instant (ms or ISO string) in the server's time zone. */
export function dayOf(at, tz) {
    const d = typeof at === "number" ? new Date(at) : new Date(at);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
}
export function nextDay(day) {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

export const capOf = (rank, cfg = FIXED) => cfg.cap_base + cfg.cap_per_rank * rank; // per space in v1.1 (economyFor)

/**
 * One sampler tick for one wallet. w = {holdings, rank, accrual_s, day, earned_today}; ev = {at, gap_s, eligible}.
 * Returns {chips, why, w} (w = the new numbers; chips = chips minted). A new server day resets earned_today first.
 */
export function tick(w, ev, cfg) {
    const today = dayOf(ev.at, cfg.tz);
    const n = { ...w };
    if (n.day !== today) { n.day = today; n.earned_today = 0; }
    if (!ev.eligible) return { chips: 0, why: "not-eligible", w: n };
    if (n.holdings >= capOf(n.rank, cfg)) return { chips: 0, why: "at-cap", w: n };
    if (n.earned_today >= cfg.day_max) return { chips: 0, why: "day-max", w: n };
    const add = Math.max(0, Math.min(Math.floor(ev.gap_s), cfg.tick_max_s));
    n.accrual_s += add;
    let chips = 0;
    // one chip per chip_s; never past the day max (the rest stays saved for tomorrow)
    while (n.accrual_s >= cfg.chip_s && n.earned_today < cfg.day_max) {
        n.accrual_s -= cfg.chip_s; n.earned_today += 1; n.holdings += 1; chips += 1;
    }
    return { chips, why: "", w: n };
}

/** The daily top-up check. openMoney = anything of theirs still in play (then no top-up, §2.4). */
export function topup(w, at, cfg, openMoney = false) {
    const today = dayOf(at, cfg.tz);
    if (w.holdings !== 0) return { chips: 0, why: "not-zero", w: { ...w } };
    if (openMoney) return { chips: 0, why: "open-money", w: { ...w } };
    if (w.topup_day === today) return { chips: 0, why: "already-today", w: { ...w } };
    // a top-up_day AFTER today (a wallet that came back from a tombstone in another zone's tomorrow) also blocks
    if (w.topup_day && w.topup_day > today) return { chips: 0, why: "already-today", w: { ...w } };
    return { chips: cfg.topup_to, why: "", w: { ...w, holdings: cfg.topup_to, topup_day: today } };
}

/** The prestige check at a leave (the person has no open money left at that table). */
export function leave(w, cfg) {
    if (w.holdings >= capOf(w.rank, cfg)) {
        const burned = w.holdings - (cfg.prestige_to ?? FIXED.prestige_to);
        return { burned, why: "prestige", w: { ...w, holdings: cfg.prestige_to ?? FIXED.prestige_to, rank: w.rank + 1 } };
    }
    return { burned: 0, why: "", w: { ...w } };
}

/** A new wallet (opt-in): opens with the configured start. */
export function create(w, cfg) {
    return { chips: cfg.start, w: { ...w, holdings: w.holdings + cfg.start } };
}
