// The wallet rules, pure (GAMES-V1-SPEC §2.1-§2.4, §2.7; vectors/ledger.json). No clock, no database: the ledger
// (ledger.mjs) loads a wallet's numbers, asks these functions what changes, and writes the answer as journal
// transactions in the same database transaction. Every number the owner may change is one named value here or in the
// server's config (PLAY_DAY_MAX / PLAY_START, bounds below); everything else is fixed in v1.

/** Fixed in v1 (§2.7: not admin-tweakable). */
export const FIXED = Object.freeze({
    chip_s: 3600, // one chip per 3 600 counted seconds in a call
    tick_max_s: 90, // one sample never pays more than 90 s (a stalled sampler can't pay for time it didn't see)
    topup_to: 5, // the daily top-up, only at exactly 0
    prestige_to: 10, // holdings after a prestige
    cap_base: 100, cap_per_rank: 50, // cap = 100 + 50 × rank
});
/** Admin-tweakable (§2.7): default + bounds. An out-of-bounds or non-integer value in the environment keeps the default. */
export const TWEAKABLE = Object.freeze({
    day_max: { default: 8, min: 1, max: 24 },
    start: { default: 10, min: 0, max: 50 },
});

/** The server's play config from its environment (PLAY_DAY_MAX, PLAY_START, PLAY_TZ). Never throws. */
export function configFromEnv(env = process.env, warn = () => {}) {
    const out = { ...FIXED, tz: validTz(env.PLAY_TZ) ? env.PLAY_TZ : "UTC" };
    // a LAB-ONLY fast chip clock (§8.1 "a lab box with a fast clock"): honoured only with TINHAT_LAB=1, which the manager
    // never writes and no image sets; anywhere else it is ignored with one warning
    if (env.PLAY_CHIP_SECONDS !== undefined && env.PLAY_CHIP_SECONDS !== "") {
        const n = /^\d+$/.test(String(env.PLAY_CHIP_SECONDS).trim()) ? Number(env.PLAY_CHIP_SECONDS) : NaN;
        if (env.TINHAT_LAB === "1" && Number.isInteger(n) && n >= 10 && n <= 3600) { out.chip_s = n; warn(`LAB: one chip per ${n} s in a call (PLAY_CHIP_SECONDS, TINHAT_LAB=1)`); }
        else warn(`PLAY_CHIP_SECONDS ignored (only on a lab box with TINHAT_LAB=1, 10-3600): one chip per ${FIXED.chip_s} s`);
    }
    for (const [k, b] of Object.entries(TWEAKABLE)) {
        const raw = env[`PLAY_${k.toUpperCase()}`];
        let v = b.default;
        if (raw !== undefined && raw !== "") {
            const n = /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN;
            if (Number.isInteger(n) && n >= b.min && n <= b.max) v = n;
            else warn(`PLAY_${k.toUpperCase()}=${JSON.stringify(raw)} is outside ${b.min}-${b.max}: keeping ${b.default}`);
        }
        out[k] = v;
    }
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

export const capOf = (rank, cfg = FIXED) => cfg.cap_base + cfg.cap_per_rank * rank;

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
        const burned = w.holdings - cfg.prestige_to;
        return { burned, why: "prestige", w: { ...w, holdings: cfg.prestige_to, rank: w.rank + 1 } };
    }
    return { burned: 0, why: "", w: { ...w } };
}

/** A new wallet (opt-in): opens with the configured start. */
export function create(w, cfg) {
    return { chips: cfg.start, w: { ...w, holdings: w.holdings + cfg.start } };
}
