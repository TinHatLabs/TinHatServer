// model/games.ts — faithful TypeScript port of the native PURE fairness model
// (crates/app/src/games_model.rs, Tin Hat 10.5.0): pool tiers, per-person shares, regret credit,
// the verifiable winner draw, spin-record resolution and the explain strings.
//
// Rules of this port (tw-spec/calendar-games.md §3.8):
// - Numbers are IEEE doubles (JS Number == Rust f64). The summation ORDER of the Rust code is kept
//   exactly (never re-associate a sum), so every client lands on the same winner and odds.
// - Rust `sort()` on Strings is byte-wise; `cmpStr` compares by code point (== UTF-8 byte order).
// - This file imports NOTHING, so `node --experimental-strip-types --test model/games.test.ts`
//   can load it directly (see tools/calendar-model-test.sh).
// - Wire encoding (DECISIONS D8): Synapse refuses JSON floats in room v10 state. `spinToJson(rec,
//   "micro")` (the web's default) writes pool weights as integer micro-units round(w·1e6); readers
//   are scale-free (odds = w/Σw, the winner walk uses r·Σw), so native and web agree. "round6" is
//   the 10.5.0 native float encoding (kept for the round-trip tests and for reading); the desktop
//   app writes micro-units too since 10.5.1.
// - 10.5.1 open roster (DECISIONS D8b): `roster` / `adhocSessionId` / the even share mirror
//   games_model.rs byte for byte — same constants, same test vectors.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** Byte-wise (UTF-8 == code point) string order, like Rust's `str::cmp`. */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(i)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

const isObj = (v: Json): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: Json): v is number => typeof v === "number" && Number.isFinite(v);
/** serde_json `as_u64` (JS cannot tell 7.0 from 7; integral non-negative numbers qualify). */
const asU64 = (v: Json): number | undefined => (isNum(v) && Number.isInteger(v) && v >= 0 ? v : undefined);
/** serde_json `as_i64`. */
const asI64 = (v: Json): number | undefined => (isNum(v) && Number.isInteger(v) ? v : undefined);
const asStr = (v: Json): string | undefined => (typeof v === "string" ? v : undefined);
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
/** Rust `f64 as u32`: saturating, NaN → 0. */
const asU32 = (f: number) => (Number.isNaN(f) ? 0 : f <= 0 ? 0 : f >= 4294967295 ? 4294967295 : Math.trunc(f));
/** Rust `f64::round` (half away from zero). */
const rround = (f: number) => (f < 0 ? -Math.round(-f) : Math.round(f));
/** Rust `str::parse::<u32>()` */
function parseU32(s: string): number | undefined {
  if (!/^\+?\d+$/.test(s)) return undefined;
  const n = Number(s.replace(/^\+/, ""));
  return n <= 4294967295 ? n : undefined;
}
/** Rust `str::parse::<f64>()` (finite results only are ever used). */
function parseF64(s: string): number | undefined {
  const t = s.toLowerCase();
  if (/^[+-]?(inf|infinity|nan)$/.test(t)) return t.includes("nan") ? NaN : t.startsWith("-") ? -Infinity : Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) return undefined;
  return Number(t);
}

// ---------------------------------------------------------------------------------------------
// Prefs (§7.1)
// ---------------------------------------------------------------------------------------------

export interface Prefs {
  would_play: string[];
  favorites: string[];
  definitely_not: string[];
  flexible: boolean;
  updated_at: number;
  /** id → display name as the editor learned them (TH-REEL-04) */
  names: Record<string, string>;
}

export function emptyPrefs(): Prefs {
  return { would_play: [], favorites: [], definitely_not: [], flexible: false, updated_at: 0, names: {} };
}

/** array of strings, trimmed, non-empty, first occurrence kept */
export function strList(v: Json, key: string): string[] {
  const out: string[] = [];
  const a = isObj(v) ? v[key] : undefined;
  if (Array.isArray(a)) {
    for (const x of a) {
      if (typeof x !== "string") continue;
      const s = x.trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

export function prefsFromJson(v: Json): Prefs {
  const names: Record<string, string> = {};
  const m = isObj(v) ? v.names : undefined;
  if (isObj(m)) {
    for (const k of Object.keys(m).sort(cmpStr)) {
      const val = m[k];
      const n = typeof val === "string" ? val : isObj(val) && typeof val.name === "string" ? val.name : undefined;
      if (n !== undefined) names[k] = n;
    }
  }
  return {
    would_play: strList(v, "wouldPlay"),
    favorites: strList(v, "favorites"),
    definitely_not: strList(v, "definitelyNot"),
    flexible: isObj(v) && typeof v.flexible === "boolean" ? v.flexible : false,
    updated_at: (isObj(v) ? asU64(v.updatedAt) : undefined) ?? 0,
    names,
  };
}

/** refusal wins, favorites ⊆ would-play, at most max(slots,1) favourites */
export function prefsNormalized(p: Prefs, slots: number): Prefs {
  const not = new Set(p.definitely_not);
  const would_play = p.would_play.filter((g) => !not.has(g));
  const wp = new Set(would_play);
  const favorites = p.favorites.filter((g) => wp.has(g)).slice(0, Math.max(slots, 1));
  return { ...p, would_play, favorites, definitely_not: [...p.definitely_not], names: { ...p.names } };
}

export function prefsToJson(p: Prefs): Json {
  return {
    v: 1,
    wouldPlay: [...p.would_play],
    favorites: [...p.favorites],
    definitelyNot: [...p.definitely_not],
    flexible: p.flexible,
    updatedAt: p.updated_at,
    names: { ...p.names },
  };
}

export const prefsIsEmpty = (p: Prefs) => p.would_play.length === 0 && p.definitely_not.length === 0 && !p.flexible;
export const prefsFavorite = (p: Prefs): string | undefined => p.favorites[0];

// ---------------------------------------------------------------------------------------------
// Settings (§6)
// ---------------------------------------------------------------------------------------------

export type OwnerRule = { kind: "all" } | { kind: "allButOne" } | { kind: "atLeast"; n: number };
export const ALL: OwnerRule = { kind: "all" };
export const ALL_BUT_ONE: OwnerRule = { kind: "allButOne" };
export const atLeast = (n: number): OwnerRule => ({ kind: "atLeast", n });

export function ownerRuleFromJson(v: Json, def: OwnerRule): OwnerRule {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "all" || s === "all present") return ALL;
    if (s === "all-but-1" || s === "all-but-one" || s === "all but one") return ALL_BUT_ONE;
    const stripped = s.replace(/^[≥>= ]+/u, "");
    const n = parseU32(stripped);
    return n === undefined ? def : atLeast(clamp(n, 1, 99));
  }
  if (typeof v === "number") {
    const n = asU64(v);
    return n === undefined ? def : atLeast(clamp(n, 1, 99));
  }
  return def;
}

export function ownerRuleToJson(r: OwnerRule): Json {
  return r.kind === "all" ? "all" : r.kind === "allButOne" ? "all-but-1" : r.n;
}

/** Owners needed out of n counted people. Never below 1. */
export function threshold(r: OwnerRule, n: number): number {
  switch (r.kind) {
    case "all":
      return Math.max(n, 1);
    case "allButOne":
      return Math.max(Math.max(n - 1, 0), 1);
    default:
      return Math.max(r.n, 1);
  }
}

export type VetoMode = "hard" | "soft" | "off";
/** 10.5.1: "open" (default) = everyone in the call counts, RSVP or not; see `roster`. */
export type Presence = "open" | "rsvp+present" | "rsvp-only" | "call-only";
export type OddsVisibility = "full" | "badges-only" | "hidden";
/**
 * 10.5.2 `credits.mode` (2026-09-23: "make it a toggle to have to spend credits or just free
 * spin"): "earn" (default, the behaviour so far) = a lost favourite earns regret credit and a winning
 * one spends it; "free" = free spins — every spin record written while it is on carries
 * `"credit": false` (captured at write time, so flipping the mode never rewrites history) and
 * tonight's draw ignores banked credit (no "weighted up", no +N badges).
 */
export type CreditsMode = "earn" | "free";

/** veto.mode = soft: a definitely-not crushes the weight instead of removing the game. */
export const SOFT_VETO_FACTOR = 0.1;

export interface Settings {
  rev: number;
  feature_enabled: boolean;
  favorite_slots: number;
  favorite_share: number;
  favorite_second_share: number;
  regret_step: number;
  regret_cap: number;
  regret_count_maybe: boolean;
  regret_absence_decay: number | null;
  regret_reset_on_favorite_change: boolean;
  flexible_weight: number;
  pool_min_owners: OwnerRule;
  pool_stretch_rule: OwnerRule;
  pool_spin_stretch: boolean;
  pool_count_flexible_ownership: boolean;
  veto_mode: VetoMode;
  veto_post_spin_per_person: number;
  veto_respin_limit: number;
  damping_last_winner: boolean;
  damping_factor: number;
  damping_sessions: number;
  consensus_bonus: number | null;
  reel_min_items: number;
  reel_max_items: number;
  reel_duration_ms: number;
  reel_laps: number;
  roster_presence: Presence;
  roster_grace_min: number;
  odds_visibility: OddsVisibility;
  steam_import: boolean;
  steam_multiplayer_filter: boolean;
  steam_show_playtime: boolean;
  catalog_custom_entries: boolean;
  admin_min_pl: number;
  credits_mode: CreditsMode;
}

export function defaultSettings(): Settings {
  return {
    rev: 0,
    feature_enabled: true,
    favorite_slots: 1,
    favorite_share: 0.5,
    favorite_second_share: 0.25,
    regret_step: 0.5,
    regret_cap: 3,
    regret_count_maybe: true,
    regret_absence_decay: null,
    regret_reset_on_favorite_change: true,
    flexible_weight: 0.0,
    pool_min_owners: ALL,
    pool_stretch_rule: ALL_BUT_ONE,
    pool_spin_stretch: false,
    pool_count_flexible_ownership: true,
    veto_mode: "hard",
    veto_post_spin_per_person: 1,
    veto_respin_limit: 2,
    damping_last_winner: false,
    damping_factor: 0.5,
    damping_sessions: 1,
    consensus_bonus: null,
    reel_min_items: 2,
    reel_max_items: 16,
    reel_duration_ms: 6000,
    reel_laps: 5,
    roster_presence: "open",
    roster_grace_min: 0,
    odds_visibility: "full",
    steam_import: true,
    steam_multiplayer_filter: true,
    steam_show_playtime: false,
    catalog_custom_entries: true,
    admin_min_pl: 50,
    credits_mode: "earn",
  };
}

/** Typed, range-clamped reads of the flat settings object (games_model.rs Reader). */
class Reader {
  private v: Json;
  constructor(v: Json) {
    this.v = v;
  }
  private get(k: string): Json {
    return isObj(this.v) ? this.v[k] : undefined;
  }
  b(key: string, d: boolean): boolean {
    const x = this.get(key);
    if (typeof x === "boolean") return x;
    if (typeof x === "string") {
      const s = x.trim().toLowerCase();
      if (s === "on" || s === "true" || s === "yes" || s === "1") return true;
      if (s === "off" || s === "false" || s === "no" || s === "0") return false;
      return d;
    }
    if (typeof x === "number") return x !== 0;
    return d;
  }
  f(key: string, d: number, lo: number, hi: number): number {
    const x = this.get(key);
    return clamp(isNum(x) ? x : d, lo, hi);
  }
  u(key: string, d: number, lo: number, hi: number): number {
    const x = this.get(key);
    return clamp(isNum(x) ? asU32(Math.max(rround(x), 0)) : d, lo, hi);
  }
  s(key: string): string | undefined {
    const x = this.get(key);
    return typeof x === "string" ? x.trim().toLowerCase() : undefined;
  }
  optU(key: string, lo: number, hi: number): number | null {
    const x = this.get(key);
    if (typeof x === "number") {
      const n = clamp(asU32(Math.max(rround(x), 0)), lo, hi);
      return n > 0 ? n : null;
    }
    if (typeof x === "string") {
      const p = parseU32(x.trim());
      if (p === undefined) return null;
      const n = clamp(p, lo, hi);
      return n > 0 ? n : null;
    }
    return null;
  }
  optF(key: string, lo: number, hi: number): number | null {
    const x = this.get(key);
    if (typeof x === "number") return Number.isFinite(x) ? clamp(x, lo, hi) : null;
    if (typeof x === "string") {
      const f = parseF64(x.trim());
      return f !== undefined && Number.isFinite(f) ? clamp(f, lo, hi) : null;
    }
    return null;
  }
}

export function settingsFromJson(v: Json): Settings {
  const d = defaultSettings();
  const r = new Reader(v);
  const get = (k: string) => (isObj(v) ? v[k] : undefined);
  const veto = r.s("veto.mode");
  const pres = r.s("roster.presence");
  const vis = r.s("odds.visibility");
  const cm = r.s("credits.mode");
  return {
    rev: asU64(get("rev")) ?? 0,
    feature_enabled: r.b("feature.enabled", d.feature_enabled),
    favorite_slots: r.u("favorite.slots", d.favorite_slots, 1, 2),
    favorite_share: r.f("favorite.share", d.favorite_share, 0.2, 0.9),
    favorite_second_share: r.f("favorite.second_share", d.favorite_second_share, 0.0, 0.5),
    regret_step: r.f("regret.step", d.regret_step, 0.0, 2.0),
    regret_cap: r.u("regret.cap", d.regret_cap, 0, 10),
    regret_count_maybe: r.b("regret.count_maybe", d.regret_count_maybe),
    regret_absence_decay: r.optU("regret.absence_decay", 1, 20),
    regret_reset_on_favorite_change: r.b("regret.reset_on_favorite_change", d.regret_reset_on_favorite_change),
    flexible_weight: r.f("flexible.weight", d.flexible_weight, 0.0, 0.5),
    pool_min_owners: ownerRuleFromJson(get("pool.min_owners"), d.pool_min_owners),
    pool_stretch_rule: ownerRuleFromJson(get("pool.stretch_rule"), d.pool_stretch_rule),
    pool_spin_stretch: r.b("pool.spin_stretch", d.pool_spin_stretch),
    pool_count_flexible_ownership: r.b("pool.count_flexible_ownership", d.pool_count_flexible_ownership),
    veto_mode: veto === "soft" ? "soft" : veto === "off" ? "off" : veto === "hard" ? "hard" : d.veto_mode,
    veto_post_spin_per_person: r.u("veto.post_spin_per_person", d.veto_post_spin_per_person, 0, 3),
    veto_respin_limit: r.u("veto.respin_limit", d.veto_respin_limit, 0, 5),
    damping_last_winner: r.b("damping.last_winner", d.damping_last_winner),
    damping_factor: r.f("damping.factor", d.damping_factor, 0.1, 1.0),
    damping_sessions: r.u("damping.sessions", d.damping_sessions, 1, 5),
    consensus_bonus: r.optF("consensus.bonus", 0.0, 1.0),
    reel_min_items: r.u("reel.min_items", d.reel_min_items, 1, 4),
    reel_max_items: r.u("reel.max_items", d.reel_max_items, 6, 30),
    reel_duration_ms: r.u("reel.duration_ms", d.reel_duration_ms, 2000, 12000),
    reel_laps: r.u("reel.laps", d.reel_laps, 2, 10),
    roster_presence: pres === "rsvp-only" ? "rsvp-only" : pres === "call-only" ? "call-only" : pres === "rsvp+present" ? "rsvp+present" : pres === "open" ? "open" : d.roster_presence,
    roster_grace_min: r.u("roster.grace_min", d.roster_grace_min, 0, 30),
    odds_visibility: vis === "badges-only" ? "badges-only" : vis === "hidden" ? "hidden" : vis === "full" ? "full" : d.odds_visibility,
    steam_import: r.b("steam.import", d.steam_import),
    steam_multiplayer_filter: r.b("steam.multiplayer_filter", d.steam_multiplayer_filter),
    steam_show_playtime: r.b("steam.show_playtime", d.steam_show_playtime),
    catalog_custom_entries: r.b("catalog.custom_entries", d.catalog_custom_entries),
    admin_min_pl: clamp(asI64(get("admin.min_pl")) ?? d.admin_min_pl, 0, 100),
    credits_mode: cm === "free" ? "free" : cm === "earn" ? "earn" : d.credits_mode,
  };
}

/** The flat object (every key) — native `Settings::to_json`. */
export function settingsToJson(s: Settings): Json {
  return {
    rev: s.rev,
    "feature.enabled": s.feature_enabled,
    "favorite.slots": s.favorite_slots,
    "favorite.share": s.favorite_share,
    "favorite.second_share": s.favorite_second_share,
    "regret.step": s.regret_step,
    "regret.cap": s.regret_cap,
    "regret.count_maybe": s.regret_count_maybe,
    "regret.absence_decay": s.regret_absence_decay ?? false,
    "regret.reset_on_favorite_change": s.regret_reset_on_favorite_change,
    "flexible.weight": s.flexible_weight,
    "pool.min_owners": ownerRuleToJson(s.pool_min_owners),
    "pool.stretch_rule": ownerRuleToJson(s.pool_stretch_rule),
    "pool.spin_stretch": s.pool_spin_stretch,
    "pool.count_flexible_ownership": s.pool_count_flexible_ownership,
    "veto.mode": s.veto_mode,
    "veto.post_spin_per_person": s.veto_post_spin_per_person,
    "veto.respin_limit": s.veto_respin_limit,
    "damping.last_winner": s.damping_last_winner,
    "damping.factor": s.damping_factor,
    "damping.sessions": s.damping_sessions,
    "consensus.bonus": s.consensus_bonus ?? false,
    "reel.min_items": s.reel_min_items,
    "reel.max_items": s.reel_max_items,
    "reel.duration_ms": s.reel_duration_ms,
    "reel.laps": s.reel_laps,
    "roster.presence": s.roster_presence,
    "roster.grace_min": s.roster_grace_min,
    "odds.visibility": s.odds_visibility,
    "steam.import": s.steam_import,
    "steam.multiplayer_filter": s.steam_multiplayer_filter,
    "steam.show_playtime": s.steam_show_playtime,
    "catalog.custom_entries": s.catalog_custom_entries,
    "admin.min_pl": s.admin_min_pl,
    "credits.mode": s.credits_mode,
  };
}

/** Settings with `patch`'s keys laid over (rev NOT bumped). */
export function settingsMerged(s: Settings, patch: Json): Settings {
  const j = settingsToJson(s);
  if (isObj(patch)) for (const k of Object.keys(patch)) j[k] = patch[k];
  return settingsFromJson(j);
}

/** The fractional settings keys (their defaults are floats — DECISIONS D8). */
export const FRACTIONAL_KEYS = ["favorite.share", "favorite.second_share", "regret.step", "flexible.weight", "damping.factor", "consensus.bonus"] as const;
export const FLOAT_REFUSAL = "Matrix can't store fractional numbers yet — keep the default";

/**
 * D8 wire form of the settings (room v10 = strict canonical JSON, no floats): every integral /
 * bool / string key; a fractional key equal to its default is OMITTED (readers default it); a
 * non-default fractional value cannot be stored → `{error}`. `consensus.bonus` alone is read from a
 * numeric STRING too, so a fractional bonus travels as "0.4".
 */
export function settingsToWire(s: Settings): { content?: Json; error?: string } {
  const full = settingsToJson(s);
  const defs = settingsToJson(defaultSettings());
  const out: Json = {};
  for (const [k, v] of Object.entries(full)) {
    if (typeof v === "number" && !Number.isInteger(v)) {
      if ((FRACTIONAL_KEYS as readonly string[]).includes(k) && v === defs[k]) continue;
      if (k === "consensus.bonus") {
        out[k] = String(v);
        continue;
      }
      return { error: FLOAT_REFUSAL };
    }
    out[k] = v;
  }
  return { content: out };
}

// ---------------------------------------------------------------------------------------------
// Spin records (§7.2) + adjustments (§7.4)
// ---------------------------------------------------------------------------------------------

export interface Voided {
  by: string;
  reason: string;
  at: number;
}

export interface SpinRecord {
  id: string;
  event_id: string;
  seed: string;
  ts: number;
  sender: string;
  session_id: string;
  kind: string;
  supersedes: string | null;
  vetoed: string[];
  veto_by: Record<string, string>;
  roster: string[];
  late: string[];
  maybes: string[];
  flexible: string[];
  favorites: Record<string, string>;
  pool: Array<[string, number]>;
  settings_rev: number;
  winner: string | null;
  voided: Voided | null;
  /**
   * 10.5.2: false = this spin changes nobody's regret credit (wire `"credit": false`; absent = counts,
   * so every older record counts). Written in write 1 by a spin in free mode; the reader keeps the
   * spinner's own value unless an admin wrote the current copy (`trustedCreditFlag`), then applies an
   * admin's "Don't count for credit" / "Count for credit" override (`creditOverrides`). The result
   * itself stands — unlike a void it still wins, verifies and damps.
   */
  credit: boolean;
  // derived by the reader
  computed_winner: string | null;
  tampered: boolean;
  verified: boolean;
}

export function emptySpin(): SpinRecord {
  return {
    id: "",
    event_id: "",
    seed: "",
    ts: 0,
    sender: "",
    session_id: "",
    kind: "initial",
    supersedes: null,
    vetoed: [],
    veto_by: {},
    roster: [],
    late: [],
    maybes: [],
    flexible: [],
    favorites: {},
    pool: [],
    settings_rev: 0,
    winner: null,
    voided: null,
    credit: true,
    computed_winner: null,
    tampered: false,
    verified: false,
  };
}

export function spinFromJson(stateKey: string, eventId: string, ts: number, sender: string, c: Json): SpinRecord {
  const mapStr = (key: string): Record<string, string> => {
    const o = isObj(c) ? c[key] : undefined;
    const out: Record<string, string> = {};
    if (isObj(o)) for (const [k, v] of Object.entries(o)) if (typeof v === "string") out[k] = v;
    return out;
  };
  const g = (k: string) => (isObj(c) ? c[k] : undefined);
  const pool: Array<[string, number]> = [];
  const p = g("pool");
  if (Array.isArray(p)) {
    for (const x of p) {
      if (!isObj(x) || typeof x.id !== "string") continue;
      pool.push([x.id, typeof x.weight === "number" ? x.weight : 0]);
    }
  }
  const sup = asStr(g("supersedes"));
  const w = asStr(g("winner"));
  const vd = g("voided");
  return {
    id: stateKey,
    event_id: eventId,
    seed: asStr(g("seed")) ?? "",
    ts,
    sender,
    session_id: asStr(g("sessionId")) ?? "",
    kind: asStr(g("kind")) ?? "initial",
    supersedes: sup ? sup : null,
    vetoed: strList(c, "vetoed"),
    veto_by: mapStr("vetoBy"),
    roster: strList(c, "roster"),
    late: strList(c, "late"),
    maybes: strList(c, "maybes"),
    flexible: strList(c, "flexible"),
    favorites: mapStr("favorites"),
    pool,
    settings_rev: asU64(g("settingsRev")) ?? 0,
    winner: w ? w : null,
    voided: isObj(vd) ? { by: asStr(vd.by) ?? "", reason: asStr(vd.reason) ?? "", at: asU64(vd.at) ?? 0 } : null,
    credit: g("credit") !== false,
    computed_winner: null,
    verified: false,
    tampered: false,
  };
}

export type WeightEncoding = "micro" | "round6";

/** Integer micro-units (the web's wire form, D8). */
export const toMicro = (w: number) => Math.round(w * 1e6);

/**
 * The wire content (derived fields left out). `micro` (default, D8): the weights go out EXACTLY as
 * recorded — doSpin builds the pool in integer micro-units (`toMicro`) before the first write, like
 * games_model.rs; a legacy fractional record is never re-scaled (a re-scaled rewrite of a seeded record
 * would no longer match its seed event and read as tampered). "round6" = the 10.5.0 native float form.
 */
export function spinToJson(r: SpinRecord, enc: WeightEncoding = "micro"): Json {
  const v: Json = {
    v: 1,
    sessionId: r.session_id,
    kind: r.kind,
    supersedes: r.supersedes,
    vetoed: [...r.vetoed],
    vetoBy: { ...r.veto_by },
    roster: [...r.roster],
    late: [...r.late],
    maybes: [...r.maybes],
    flexible: [...r.flexible],
    favorites: { ...r.favorites },
    pool: r.pool.map(([id, w]) => ({ id, weight: enc === "micro" ? w : round6(w) })),
    settingsRev: r.settings_rev,
  };
  if (r.seed) v.seed = r.seed;
  if (r.winner !== null) v.winner = r.winner;
  if (r.voided) v.voided = { by: r.voided.by, reason: r.voided.reason, at: r.voided.at };
  // 10.5.2: only the exception travels, so a counting record is byte-identical to a 10.5.1 one
  if (!r.credit) v.credit = false;
  return v;
}

export const seedId = (r: SpinRecord) => (r.seed ? r.seed : r.event_id);
export const effectiveWinner = (r: SpinRecord): string | null => r.computed_winner ?? r.winner;
export const rosterAtSpin = (r: SpinRecord) => r.roster.filter((p) => !r.late.includes(p));
export const inPool = (r: SpinRecord, id: string) => r.pool.some(([g]) => g === id);

export interface Adjustment {
  delta: number;
  set: number | null;
  as_of: number;
  reason: string;
  /** 10.5.2: origin_server_ts of the adjust event (set by `mergeAdjustments`; 0 = unknown) — the
   * server clock the spins' `ts` use too, so "which came first" never depends on a client's clock */
  written: number;
}

export function adjustmentFromJson(v: Json): Adjustment {
  const g = (k: string) => (isObj(v) ? v[k] : undefined);
  return { delta: asI64(g("delta")) ?? 0, set: asI64(g("set")) ?? null, as_of: asU64(g("asOf")) ?? 0, reason: asStr(g("reason")) ?? "", written: 0 };
}

// ---------------------------------------------------------------------------------------------
// 10.5.2 admin credit adjustments that actually land (2026-09-23: "admins can't reliably
// undo the spin cost")
// ---------------------------------------------------------------------------------------------
//
// Up to 10.5.1 an adjustment lived at state_key = the TARGET's user id. Matrix (room v10 auth rules)
// refuses a state_key starting with "@" unless it is the sender's own id, so an admin could only ever
// adjust / reset their OWN credit ("Reset all credits" failed for everyone else). From 10.5.2 admins
// write `dev.tinhat.games.adjust` at state_key "admin:<target mxid>" (`adminAdjustKey`), which any
// sender with the event's power level may write. Readers (`mergeAdjustments`):
//   - honour an event only if its SENDER is an admin NOW (power level ≥ settings admin.min_pl in the
//     container) — the event's own power level may be lowered, so this is what stops a member from
//     crediting themselves; the same rule applies to the legacy self-key (state_key == sender);
//   - per person, the adjustment written LAST (origin_server_ts; a tie goes to the admin key) is the
//     one that counts — it replaces the other one completely. Writers always start from that merged
//     value (`adjustContent`), so a reset line (`set` + `asOf`) is carried forward, never lost.
// Credit (`creditDetail`): min(losses since the reset line, cap) + (set + delta) floored at 0, as
// before, except that the offset `set + delta` LAPSES once the streak it was given in has ended — a
// night after the adjustment on which the person's favourite won, or their favourite changed (with
// regret.reset_on_favorite_change) — so an admin's "+1" is spent by the next win instead of
// sticking forever. A reset (set 0, delta 0) carries no offset, so this changes nothing for it.

/** State-key prefix of an admin's adjustment of someone else's credit (10.5.2). */
export const ADMIN_ADJUST_PREFIX = "admin:";
export const adminAdjustKey = (mxid: string) => ADMIN_ADJUST_PREFIX + mxid;

/** [target mxid, is the admin key] of an adjust state key; null = not an adjustment of a person. */
export function adjustTarget(stateKey: string): [string, boolean] | null {
  if (stateKey.startsWith(ADMIN_ADJUST_PREFIX)) {
    const t = stateKey.slice(ADMIN_ADJUST_PREFIX.length);
    return t.startsWith("@") ? [t, true] : null;
  }
  return stateKey.startsWith("@") ? [stateKey, false] : null;
}

/** One `dev.tinhat.games.adjust` state event as the store holds it. */
export interface AdjustEvent {
  stateKey: string;
  sender: string;
  /** origin_server_ts */
  ts: number;
  content: Json;
}

/** The adjustment that counts for each person (see the block comment above). */
export function mergeAdjustments(events: AdjustEvent[], isAdmin: (mxid: string) => boolean): Map<string, Adjustment> {
  const best = new Map<string, { adj: Adjustment; adminKey: boolean }>();
  for (const e of events) {
    if (!isObj(e.content) || Object.keys(e.content).length === 0) continue;
    const t = adjustTarget(e.stateKey);
    if (!t) continue;
    const [target, adminKey] = t;
    if (!adminKey && e.sender !== e.stateKey) continue; // Matrix already refuses it; belt and braces
    if (!isAdmin(e.sender)) continue;
    const adj: Adjustment = { ...adjustmentFromJson(e.content), written: asU64(e.ts) ?? 0 };
    const cur = best.get(target);
    if (!cur || adj.written > cur.adj.written || (adj.written === cur.adj.written && adminKey && !cur.adminKey)) best.set(target, { adj, adminKey });
  }
  const out = new Map<string, Adjustment>();
  for (const [k, v] of best) out.set(k, v.adj);
  return out;
}

/**
 * The content of an admin's ±N for one person (written at `adminAdjustKey(target)`): the merged
 * adjustment `cur` is carried forward while its offset is `live` (`creditDetail(…).offsetLive`); a
 * lapsed offset is not — the streak it belonged to is over, so the new offset starts from 0 — but a
 * reset line (`asOf`, with `set` 0 once lapsed) is always kept, so losses from before a reset can never
 * count again (e.g. after regret.reset_on_favorite_change is switched off).
 */
export function adjustContent(cur: Adjustment | null, live: boolean, delta: number, reason: string, by: string, now: number): Json {
  const reset = cur !== null && cur.set !== null;
  const content: Json = { delta: (cur && live ? cur.delta : 0) + Math.trunc(delta), asOf: reset ? cur.as_of : now, reason: reason.trim(), by, at: now };
  if (reset) content.set = live ? cur.set : 0;
  return content;
}

/** An admin's reset of one person's credit ("Zero" in Tune, and every line of "Reset all credits"). */
export const zeroContent = (reason: string, by: string, now: number): Json => ({ set: 0, delta: 0, asOf: now, reason, by, at: now });

// ---------------------------------------------------------------------------------------------
// 10.5.2 "Don't count for credit" on one spin
// ---------------------------------------------------------------------------------------------

/**
 * The credit flag a reader trusts from a spin RECORD. Spin records are writable by every member (their
 * power level is lowered so anyone can spin), so a rewrite by a non-admin may not change the flag the
 * spinner's first write (the seed event, when fetched) carries — a free-mode spin stays free, a counted
 * one stays counted. (An admin's rewrite — a void, a reset — is taken as is.)
 */
export const trustedCreditFlag = (current: boolean, seedFlag: boolean | null, writerIsAdmin: boolean): boolean =>
  writerIsAdmin || seedFlag === null ? current : seedFlag;

/**
 * An admin's "Don't count for credit" / "Count for credit" lives OUTSIDE the member-writable spin
 * record: `dev.tinhat.games.adjust` state_key "credit:<spin id>" `{credit: bool, by, at}` — the adjust
 * type keeps the room's admin power level, and readers honour it only while its sender is an admin, so
 * no member rewrite of the record (not even an honest late-arrival append) can undo it. The record
 * itself is never touched, so it still verifies. It overrides the record's own flag (a free spin can be
 * made to count).
 */
export const CREDIT_OVERRIDE_PREFIX = "credit:";
export const creditOverrideKey = (spinId: string) => CREDIT_OVERRIDE_PREFIX + spinId;
export const creditOverrideContent = (counts: boolean, by: string, now: number): Json => ({ credit: counts, by, at: now });

/** spin id → counts, from admins' override events (an emptied event or a non-boolean `credit` = none). */
export function creditOverrides(events: AdjustEvent[], isAdmin: (mxid: string) => boolean): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const e of events) {
    if (!e.stateKey.startsWith(CREDIT_OVERRIDE_PREFIX)) continue;
    const id = e.stateKey.slice(CREDIT_OVERRIDE_PREFIX.length);
    if (!id || !isObj(e.content) || typeof e.content.credit !== "boolean" || !isAdmin(e.sender)) continue;
    out.set(id, e.content.credit);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Roster (§2, §6 roster.presence) + tonight's session — 10.5.1 open roster (games_model.rs roster)
// ---------------------------------------------------------------------------------------------

export interface Roster {
  /** planned roster: yes RSVPs (RSVP order), then maybes — the header's dimmed avatars */
  expected: string[];
  /** the ACTUAL roster: whose lists, vetoes, weights and credit count tonight */
  actual: string[];
  maybes: string[];
  flexible: string[];
}

/**
 * §2 / §6 roster.presence (games_model.rs `roster`). 10.5.1 (2026-09-23: "make it to where it
 * doesn't matter how many people are in there to see it but if more people join it adds their
 * preferences and games"): the default "open" counts EVERYONE in the call — RSVP or not, one person
 * included — so a newcomer's lists join the pool the moment they join and someone who leaves drops
 * out before the spin; outside a call it previews the planned roster plus the viewer. The older
 * modes stay for spaces that pick them explicitly.
 */
export function roster(rsvps: Array<[string, string]>, present: string[], me: string, prefs: Map<string, Prefs>, presence: Presence): Roster {
  const yes: string[] = [];
  const maybe: string[] = [];
  for (const [u, st] of rsvps) {
    if (st === "yes" && !yes.includes(u)) yes.push(u);
    else if (st === "maybe" && !maybe.includes(u)) maybe.push(u);
  }
  const expected = [...yes];
  for (const m of maybe) if (!expected.includes(m)) expected.push(m);
  const live: string[] = [];
  for (const p of present) if (p.startsWith("@") && !live.includes(p)) live.push(p);
  let actual: string[];
  if (presence === "open") {
    if (live.length) actual = live;
    else {
      actual = [...expected];
      if (me.startsWith("@") && !actual.includes(me)) actual.push(me);
    }
  } else if (presence === "rsvp+present") actual = expected.filter((p) => live.includes(p));
  else if (presence === "rsvp-only") actual = [...expected];
  else actual = live;
  const maybes = actual.filter((p) => maybe.includes(p));
  const flexible = actual.filter((p) => prefs.get(p)?.flexible ?? false);
  return { expected, actual, maybes, flexible };
}

/** Prefix of a calendar-less "tonight" session id. */
export const ADHOC_PREFIX = "night-";
/** The game-night day rolls over at 14:00 UTC: a fixed day boundary (morning across the Americas). */
export const NIGHT_ROLLOVER_UTC_H = 14;
const DAY_MS = 86_400_000;

/** 10.5.1: the session a spin belongs to when no calendar session is picked: `night-YYYY-MM-DD`,
 * the UTC date of now − 14 h — the same id on every client (games_model.rs adhoc_session_id). */
export function adhocSessionId(nowMs: number): string {
  const day = Math.floor(Math.max(0, nowMs - NIGHT_ROLLOVER_UTC_H * 3_600_000) / DAY_MS);
  return ADHOC_PREFIX + new Date(day * DAY_MS).toISOString().slice(0, 10);
}
export const isAdhocSession = (id: string) => id.startsWith(ADHOC_PREFIX);
/** When tonight's game night ends (the next rollover) — only a session starting before it auto-picks. */
export function nightEndMs(nowMs: number): number {
  const off = NIGHT_ROLLOVER_UTC_H * 3_600_000;
  return (Math.floor(Math.max(0, nowMs - off) / DAY_MS) + 1) * DAY_MS + off;
}
/** The session the reel works on: the picked calendar session when it exists, else tonight's ad-hoc one. */
export function effectiveSession(picked: string, knownEvent: boolean, nowMs: number): string {
  return picked && (knownEvent || isAdhocSession(picked)) ? picked : adhocSessionId(nowMs);
}

// ---------------------------------------------------------------------------------------------
// Pool (§5.2)
// ---------------------------------------------------------------------------------------------

export type Tier = "main" | "stretch" | "removed";

export interface Pool {
  main: string[];
  stretch: string[];
  removed: Array<[string, string]>;
  owners: Map<string, string[]>;
  missing: Map<string, string[]>;
  vetoers: Map<string, string[]>;
  counted: number;
}

export function emptyPool(): Pool {
  return { main: [], stretch: [], removed: [], owners: new Map(), missing: new Map(), vetoers: new Map(), counted: 0 };
}

export function poolTier(p: Pool, id: string): Tier | null {
  if (p.main.includes(id)) return "main";
  if (p.stretch.includes(id)) return "stretch";
  if (p.removed.some(([g]) => g === id)) return "removed";
  return null;
}

export function spinnable(p: Pool, s: Settings): string[] {
  const v = [...p.main];
  if (s.pool_spin_stretch) v.push(...p.stretch);
  return v;
}

export type Names = Map<string, string>;

/** Display name for a user id (falls back to the localpart). */
export function displayName(names: Names, mxid: string): string {
  const n = names.get(mxid);
  if (n !== undefined && n.trim() !== "") return n;
  const stripped = mxid.replace(/^@+/, "");
  return stripped.split(":")[0] ?? mxid;
}

/** "Kai" / "Kai and Sam" / "Kai, Sam and Jo". */
export function joinNames(names: string[]): string {
  const n = names.length;
  if (n === 0) return "";
  if (n === 1) return names[0];
  if (n === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, n - 1).join(", ")} and ${names[n - 1]}`;
}

function vetoReason(vetoers: string[], names: Names): string {
  return `${joinNames(vetoers.map((p) => displayName(names, p)))}: definitely not.`;
}

/** §5.2: tier every game the present people list. */
export function buildPool(present: string[], prefs: Map<string, Prefs>, s: Settings, names: Names): Pool {
  const isFlex = (p: string) => prefs.get(p)?.flexible ?? false;
  // 10.5.1 open roster: someone who hasn't listed any games (no prefs, or only definitely-nots)
  // tells us nothing about what they own — they neither block a game nor count toward "everyone
  // owns"; their definitely-nots still veto below.
  const listsGames = (p: string) => {
    const x = prefs.get(p);
    return !!x && (x.flexible || x.would_play.length > 0);
  };
  const counted = present.filter((p) => listsGames(p)).filter((p) => s.pool_count_flexible_ownership || !isFlex(p));
  const n = counted.length;
  const tMain = threshold(s.pool_min_owners, n);
  const tStretch = threshold(s.pool_stretch_rule, n);
  const cands: string[] = [];
  for (const p of counted) {
    const x = prefs.get(p);
    if (x) cands.push(...x.would_play);
  }
  cands.sort(cmpStr);
  const dedup = cands.filter((g, i) => i === 0 || g !== cands[i - 1]);
  const pool: Pool = { ...emptyPool(), counted: n };
  for (const g of dedup) {
    const lists = (p: string) => prefs.get(p)?.would_play.includes(g) ?? false;
    const owns = (p: string) => lists(p) || isFlex(p);
    const ownersAll = present.filter(lists);
    const ownersCounted = counted.filter(owns).length;
    const missing = counted.filter((p) => !owns(p));
    const vetoers = present.filter((p) => prefs.get(p)?.definitely_not.includes(g) ?? false);
    pool.owners.set(g, ownersAll);
    pool.missing.set(g, missing);
    if (vetoers.length) pool.vetoers.set(g, [...vetoers]);
    if (s.veto_mode === "hard" && vetoers.length) pool.removed.push([g, vetoReason(vetoers, names)]);
    else if (n > 0 && ownersCounted >= tMain) pool.main.push(g);
    else if (n > 0 && ownersCounted >= tStretch) pool.stretch.push(g);
    else pool.removed.push([g, "Not enough owners."]);
  }
  return pool;
}

// ---------------------------------------------------------------------------------------------
// Weights (§5.3–5.4)
// ---------------------------------------------------------------------------------------------

export interface GameWeight {
  id: string;
  weight: number;
  shares: Array<[string, number]>;
  damped: boolean;
  soft_vetoed: boolean;
  consensus: number;
  /** 10.5.1: nobody here carries weight, so this game got the even share */
  even: boolean;
}

/** 10.5.1: the base weight every spinnable game gets when NOBODY here carries any weight (everyone
 * Flexible — flexible.weight is 0 by default). Before, Σw was 0: an empty strip. */
export const EVEN_SHARE = 1.0;

export const newWeight = (id: string): GameWeight => ({ id, weight: 0, shares: [], damped: false, soft_vetoed: false, consensus: 1.0, even: false });

/** §5.3: how ONE person's vote unit lands on the spinnable pool. */
export function personShares(pr: Prefs, poolIds: string[], credit: number, s: Settings): Array<[string, number]> {
  if (poolIds.length === 0) return [];
  if (pr.flexible) {
    if (s.flexible_weight <= 0.0) return [];
    const each = s.flexible_weight / poolIds.length;
    return poolIds.map((g) => [g, each]);
  }
  const lp = poolIds.filter((g) => pr.would_play.includes(g) && !pr.definitely_not.includes(g));
  if (lp.length === 0) return [];
  const slots = clamp(s.favorite_slots, 1, 2);
  const favs: Array<[string, number, boolean]> = [];
  pr.favorites.slice(0, slots).forEach((f, i) => {
    if (lp.includes(f) && !favs.some(([x]) => x === f)) {
      favs.push([f, i === 0 ? s.favorite_share : s.favorite_second_share, i === 0]);
    }
  });
  const others = lp.filter((g) => !favs.some(([f]) => f === g));
  let baseTotal = 0;
  for (const f of favs) baseTotal += f[1];
  if ((others.length === 0 && baseTotal > 0.0) || baseTotal > 1.0) {
    const scale = 1.0 / baseTotal;
    for (const f of favs) f[1] *= scale;
    baseTotal = 1.0;
  }
  const m = 1.0 + s.regret_step * credit;
  const out: Array<[string, number]> = favs.map(([id, base, primary]) => [id, primary ? base * m : base]);
  if (others.length) {
    const each = (1.0 - baseTotal) / others.length;
    for (const g of others) out.push([g, each]);
  }
  return out;
}

export function weights(pool: Pool, present: string[], prefs: Map<string, Prefs>, credits: Map<string, number>, recentWinners: string[], s: Settings): GameWeight[] {
  return weightsOver(spinnable(pool, s), pool, present, prefs, credits, recentWinners, s);
}

export function weightsOver(ids: string[], pool: Pool, present: string[], prefs: Map<string, Prefs>, credits: Map<string, number>, recentWinners: string[], s: Settings): GameWeight[] {
  const acc = new Map<string, GameWeight>();
  for (const p of present) {
    const pr = prefs.get(p);
    if (!pr) continue;
    const c = credits.get(p) ?? 0;
    for (const [g, sh] of personShares(pr, ids, c, s)) {
      let e = acc.get(g);
      if (!e) acc.set(g, (e = newWeight(g)));
      e.shares.push([p, sh]);
      e.weight += sh;
    }
  }
  const nPresent = Math.max(present.length, 1);
  // nobody leaned toward anything (no POSITIVE share — a zero second-favourite share counts as none):
  // every game gets the same base share, then the usual multipliers
  let even = true;
  for (const g of acc.values()) if (g.weight > 0.0) even = false;
  return ids.map((id) => {
    const gw = acc.get(id) ?? newWeight(id);
    acc.delete(id);
    if (even) {
      gw.weight = EVEN_SHARE;
      gw.even = true;
    }
    if (s.veto_mode === "soft" && (pool.vetoers.get(id)?.length ?? 0) > 0) {
      gw.weight *= SOFT_VETO_FACTOR;
      gw.soft_vetoed = true;
    }
    if (s.damping_last_winner && recentWinners.includes(id)) {
      gw.weight *= s.damping_factor;
      gw.damped = true;
    }
    if (s.consensus_bonus !== null) {
      const owners = pool.owners.get(id)?.length ?? 0;
      gw.consensus = 1.0 + s.consensus_bonus * (owners / nPresent);
      gw.weight *= gw.consensus;
    }
    return gw;
  });
}

/** Odds = w / Σw (all zero when nothing carries weight). */
export function odds(ws: GameWeight[]): number[] {
  let total = 0;
  for (const w of ws) total += w.weight;
  if (total <= 0.0) return ws.map(() => 0);
  return ws.map((w) => w.weight / total);
}

/** The precision weights travel at inside a (native) spin record. */
export const round6 = (x: number) => Math.round(x * 1_000_000.0) / 1_000_000.0;

// ---------------------------------------------------------------------------------------------
// Regret credit (§5.5)
// ---------------------------------------------------------------------------------------------

export function deriveCredit(user: string, spins: SpinRecord[], prefsNow: Prefs, s: Settings, adj?: Adjustment | null): number {
  return creditDetail(user, spins, prefsNow, s, adj).credit;
}

export interface CreditDetail {
  credit: number;
  /** the adjustment's offset (set + delta) still applies — false once the streak it was given in
   * ended after it (10.5.2); true without an adjustment */
  offsetLive: boolean;
}

/**
 * §5.5 regret credit over the finals (newest first). 10.5.2: a final with `credit: false` is skipped
 * exactly like a voided one (no loss, no win, no absence — the night is invisible to credit), and the
 * adjustment's offset lapses when a streak end (win / favourite change / a night without a favourite
 * on record) newer than the adjustment stops the walk. See the block comment at `ADMIN_ADJUST_PREFIX`.
 */
export function creditDetail(user: string, spins: SpinRecord[], prefsNow: Prefs, s: Settings, adj?: Adjustment | null): CreditDetail {
  if (s.regret_cap === 0) return { credit: 0, offsetLive: true };
  const currentFav = prefsFavorite(prefsNow);
  if (currentFav === undefined) return { credit: 0, offsetLive: true };
  const since = adj && adj.set !== null ? adj.as_of : 0;
  const window: Array<"loss" | "absent"> = [];
  /** ts of the night that ended the streak (null = the walk ran out or hit the reset line) */
  let stoppedAt: number | null = null;
  for (const sp of spins) {
    if (sp.voided || !sp.credit) continue;
    if (since > 0 && sp.ts <= since) break;
    if (!sp.roster.includes(user)) {
      if (s.regret_absence_decay !== null) window.push("absent");
      continue;
    }
    if (sp.flexible.includes(user)) continue;
    if (!s.regret_count_maybe && sp.maybes.includes(user)) continue;
    const fav = Object.prototype.hasOwnProperty.call(sp.favorites, user) ? sp.favorites[user] : undefined;
    if (fav === undefined) {
      if (s.regret_reset_on_favorite_change) {
        stoppedAt = sp.ts;
        break;
      }
      continue;
    }
    if (!inPool(sp, fav)) continue;
    if ((s.regret_reset_on_favorite_change && fav !== currentFav) || effectiveWinner(sp) === fav) {
      stoppedAt = sp.ts;
      break;
    }
    window.push("loss");
  }
  let count = 0;
  let run = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i] === "loss") count += 1;
    else {
      run += 1;
      if (s.regret_absence_decay !== null && run >= Math.max(s.regret_absence_decay, 1)) {
        count = Math.max(count - 1, 0);
        run = 0;
      }
    }
  }
  let credit = Math.min(count, s.regret_cap);
  // the adjustment's time: when it was last written (server clock), else its asOf (tests / legacy)
  const adjAt = adj ? (adj.written > 0 ? adj.written : adj.as_of) : 0;
  const offsetLive = !adj || stoppedAt === null || stoppedAt <= adjAt;
  if (adj && offsetLive) credit += (adj.set ?? 0) + adj.delta;
  // Rust: clamp(0, u32::MAX) as u32 — the same saturation on both sides
  return { credit: Math.min(Math.max(credit, 0), 4294967295), offsetLive };
}

/**
 * Tonight's credit per person on the roster (who has lists) — what the draw weighs a favourite up
 * by (games.rs tonight). `finalsPast` = the finals of OTHER sessions, newest first. 10.5.2 free
 * spins (credits.mode "free"): 0 for everyone — banked credit is neither earned, spent nor used.
 */
export function tonightCredits(roster: string[], prefs: Map<string, Prefs>, finalsPast: SpinRecord[], adjustments: Map<string, Adjustment>, s: Settings): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of roster) {
    const pr = prefs.get(p);
    if (!pr) continue;
    out.set(p, s.credits_mode === "free" ? 0 : deriveCredit(p, finalsPast, pr, s, adjustments.get(p) ?? null));
  }
  return out;
}

export function recentWinners(finalsNewestFirst: SpinRecord[], s: Settings): string[] {
  const out: string[] = [];
  const take = Math.max(s.damping_sessions, 1);
  for (const sp of finalsNewestFirst) {
    if (out.length >= take) break;
    if (sp.voided) continue;
    const w = effectiveWinner(sp);
    if (w !== null) out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Winner derivation (§7.2) — the cross-client contract
// ---------------------------------------------------------------------------------------------

/** r = first 8 bytes of sha256(seed) big-endian / 2^64 (Number(BigInt) = round-to-nearest-even). */
export async function seedFraction(seedEventId: string): Promise<number> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seedEventId));
  const u = new DataView(buf).getBigUint64(0, false);
  return Number(u) / 18446744073709551616;
}

/** Walk the pool IN RECORD ORDER, cumulative weights left to right, until r·ΣW is passed (strict). */
export function winnerFromFraction(r: number, pool: Array<[string, number]>): string | null {
  let total = 0.0;
  for (const [, w] of pool) total += w;
  if (!(total > 0.0)) return null;
  const target = r * total;
  let cum = 0.0;
  for (const [id, w] of pool) {
    cum += w;
    if (cum > target) return id;
  }
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i][1] > 0.0) return pool[i][0];
  return null;
}

export async function deriveWinner(seedEventId: string, pool: Array<[string, number]>): Promise<string | null> {
  return winnerFromFraction(await seedFraction(seedEventId), pool);
}

// ---------------------------------------------------------------------------------------------
// Session resolution (§7.2)
// ---------------------------------------------------------------------------------------------

export interface Resolved {
  chain: string[];
  superseded: Map<string, string>;
  final_id: string | null;
}

export function resolveSession(records: SpinRecord[]): Resolved {
  const byParent = new Map<string | null, SpinRecord[]>();
  for (const r of records) {
    const k = r.supersedes;
    let g = byParent.get(k);
    if (!g) byParent.set(k, (g = []));
    g.push(r);
  }
  for (const v of byParent.values()) v.sort((a, b) => a.ts - b.ts || cmpStr(a.event_id, b.event_id));
  const out: Resolved = { chain: [], superseded: new Map(), final_id: null };
  let parent: string | null = null;
  let guard = 0;
  for (;;) {
    const group = byParent.get(parent);
    if (!group) break;
    const stands = group[0];
    if (!stands) break;
    for (const other of group.slice(1)) out.superseded.set(other.id, stands.id);
    out.chain.push(stands.id);
    parent = stands.id;
    guard += 1;
    if (guard > 64) break;
  }
  for (const r of records) {
    if (!out.chain.includes(r.id) && !out.superseded.has(r.id)) {
      const by = r.supersedes !== null ? out.superseded.get(r.supersedes) ?? "" : "";
      out.superseded.set(r.id, by);
    }
  }
  for (let i = out.chain.length - 1; i >= 0; i--) {
    const id = out.chain[i];
    if (records.some((r) => r.id === id && r.voided === null)) {
      out.final_id = id;
      break;
    }
  }
  return out;
}

/** Re-spins used tonight = the chain's `kind == "respin"` records, voided or not (games.rs compute,
 *  the same line in 10.5.0 and 10.5.1). */
export const respinsUsedIn = (chain: string[], records: SpinRecord[]): number =>
  chain.filter((id) => records.some((r) => r.id === id && r.kind === "respin")).length;

// ---------------------------------------------------------------------------------------------
// Admin "Reset spins" (web, 2026-09-23 — an admin hit the re-spin limit while testing, no way back)
// ---------------------------------------------------------------------------------------------

/** The kind an admin reset gives a re-spin record: anything but "respin" stops counting everywhere. */
export const RESET_KIND = "reset";
export const RESET_REASON = "spins reset by admin";

/** A stored spin record as the reset sees it: state key, current event id, raw content. */
export interface RawSpin {
  id: string;
  eventId: string;
  content: Json;
}

/**
 * The rewrites that restart tonight, in order. `raw` = every stored record of tonight's session,
 * `chain` = its resolved chain. Two passes:
 *   1. `voided` on every record that lacks one — records outside the chain (race losers / orphans)
 *      first, then the chain root → tail. The re-spin count does not move while a result still
 *      stands, so nobody gets a re-spin back early, and a watcher keeps seeing tonight's latest result
 *      until the standing record's own write lands (voiding the tail first would bring an earlier
 *      result back). The last write of this pass also re-kinds its record: from then on nothing stands.
 *   2. `kind: "respin"` → RESET_KIND on every remaining re-spin, so they stop counting.
 * Nothing else changes (pool / roster / session / winner / seed stay, so each record still verifies
 * against its seed; `seed` is filled from the current event id when the spinner never wrote it,
 * like a void). Losers are voided too because a rewrite gives a record a new server timestamp, and a
 * reader that could not fetch its seed orders race siblings by that timestamp — an untouched loser
 * could otherwise become the chain's root and stand again.
 *
 * Why not just void the standing record (Tune's "Void tonight's spin"): it then falls back to its
 * predecessor, and every client — desktop 10.5.0 / 10.5.1 included — keeps counting the chain's
 * "respin" records, so even a fresh spin would land with 0 re-spins left. Readers need no change for
 * this: after the rewrites nothing stands (Spin is enabled), and the next spin — chained onto the
 * tail by the web and 10.5.1 — counts no re-spins and has no vetoes. A re-run after a partial failure
 * only writes what is left. (Desktop resolve_session stops walking a chain at 65 records, so a single
 * night survives ~20 reset + spin + 2 re-spin rounds; the ad-hoc session rolls over at 14:00 UTC.)
 */
export function resetWrites(chain: string[], raw: RawSpin[], me: string, now: number): Array<[string, Record<string, Json>]> {
  const live = raw.filter((r) => isObj(r.content) && Object.keys(r.content).length > 0);
  const order = [
    ...live.filter((r) => !chain.includes(r.id)),
    ...chain.map((id) => live.find((r) => r.id === id)).filter((r): r is RawSpin => !!r),
  ];
  const cur = new Map<string, Record<string, Json>>(order.map((r) => [r.id, { ...r.content }]));
  const out: Array<[string, Record<string, Json>]> = [];
  const put = (r: RawSpin, patch: Record<string, Json>) => {
    const next: Record<string, Json> = { ...cur.get(r.id), ...patch };
    if (typeof next.seed !== "string" || !next.seed) next.seed = r.eventId;
    cur.set(r.id, next);
    out.push([r.id, next]);
  };
  const toVoid = order.filter((r) => !isObj(cur.get(r.id)?.voided));
  toVoid.forEach((r, i) => {
    const last = i === toVoid.length - 1;
    put(r, { voided: { by: me, reason: RESET_REASON, at: now }, ...(last && cur.get(r.id)?.kind === "respin" ? { kind: RESET_KIND } : {}) });
  });
  for (const r of order) if (cur.get(r.id)?.kind === "respin") put(r, { kind: RESET_KIND });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Verification (games.rs verify)
// ---------------------------------------------------------------------------------------------

/** A seed event as fetched (`GET /rooms/{id}/event/{seed}`): origin_server_ts, sender, content. */
export interface SeedEvent {
  origin_server_ts?: number;
  sender?: string;
  content?: Json;
}

/** Fill the derived fields of a record (mutates `rec`). `writerIsAdmin` = the sender of the record's
 * CURRENT copy is an admin now (10.5.2: only then may that copy's credit flag differ from the seed's). */
export async function verify(rec: SpinRecord, seedEvent: SeedEvent | null, writerIsAdmin = true): Promise<void> {
  rec.tampered = false;
  rec.computed_winner = await deriveWinner(seedId(rec), rec.pool);
  const winnerOk0 = rec.winner === null || rec.winner === rec.computed_winner;
  if (!rec.seed) {
    rec.verified = winnerOk0;
    return;
  }
  if (seedEvent) {
    const ts = asU64(seedEvent.origin_server_ts);
    if (ts !== undefined) rec.ts = ts;
    if (typeof seedEvent.sender === "string") rec.sender = seedEvent.sender;
    const first = spinFromJson(rec.id, rec.seed, rec.ts, rec.sender, seedEvent.content ?? null);
    rec.credit = trustedCreditFlag(rec.credit, first.credit, writerIsAdmin);
    rec.computed_winner = await deriveWinner(seedId(rec), first.pool);
    const winnerOk = rec.winner === null || rec.winner === rec.computed_winner;
    const samePool = first.pool.length === rec.pool.length && first.pool.every((a, i) => a[0] === rec.pool[i][0] && Math.abs(a[1] - rec.pool[i][1]) < 1e-6);
    const ras = rosterAtSpin(rec);
    const sameRoster = first.roster.length === ras.length && first.roster.every((p, i) => p === ras[i]);
    const sameSession = first.session_id === rec.session_id;
    rec.verified = samePool && sameRoster && sameSession && winnerOk;
    rec.tampered = !rec.verified;
  } else {
    rec.verified = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Explainability (§9)
// ---------------------------------------------------------------------------------------------

export interface Badge {
  kind: "favorite" | "credit" | "lastWinner" | "onlyPick";
  text: string;
}

export interface ExplainCtx {
  pool: Pool;
  present: string[];
  prefs: Map<string, Prefs>;
  credits: Map<string, number>;
  names: Names;
  settings: Settings;
  spinnable: string[];
}

const lostNights = (c: number) => (c === 1 ? "Lost last time" : `Lost the last ${c} nights`);

export function explain(ctx: ExplainCtx, id: string, w: GameWeight | null | undefined): [string[], Badge[]] {
  const lines: string[] = [];
  const badges: Badge[] = [];
  const name = (p: string) => displayName(ctx.names, p);
  const tier = poolTier(ctx.pool, id);
  if (tier === "removed") {
    const r = ctx.pool.removed.find(([g]) => g === id);
    if (r) lines.push(r[1]);
    return [lines, badges];
  }
  const owners = ctx.pool.owners.get(id) ?? [];
  lines.push(`${owners.length} of you would play this.`);
  const nonFlex = (p: string) => {
    const x = ctx.prefs.get(p);
    return x ? !x.flexible : false;
  };
  const favers: Array<[string, number]> = ctx.present
    .filter(nonFlex)
    .filter((p) => {
      const x = ctx.prefs.get(p);
      return x !== undefined && prefsFavorite(x) === id;
    })
    .map((p) => [p, ctx.credits.get(p) ?? 0]);
  if (favers.length === 1) {
    const [p, c] = favers[0];
    lines.push(c > 0 ? `${name(p)}'s favorite. ${lostNights(c)}, so it's weighted up.` : `${name(p)}'s favorite.`);
    badges.push({ kind: "favorite", text: `★ ${name(p)}` });
  } else if (favers.length > 1) {
    lines.push(`Favorite of ${joinNames(favers.map(([p]) => name(p)))}.`);
    for (const [p, c] of favers) if (c > 0) lines.push(`${name(p)} ${lostNights(c).toLowerCase()}, so it's weighted up.`);
    badges.push({ kind: "favorite", text: `★ favorite of ${favers.length}` });
  }
  for (const [p, c] of favers) {
    if (c > 0) badges.push({ kind: "credit", text: favers.length > 1 ? `+${c} ${name(p)}` : `+${c}` });
  }
  if (ctx.settings.favorite_slots >= 2) {
    for (const p of ctx.present.filter(nonFlex)) {
      if (ctx.prefs.get(p)?.favorites[1] === id) lines.push(`${name(p)}'s second favorite.`);
    }
  }
  for (const p of ctx.present.filter(nonFlex)) {
    const x = ctx.prefs.get(p);
    if (!x) continue;
    const lp = ctx.spinnable.filter((g) => x.would_play.includes(g) && !x.definitely_not.includes(g));
    if (lp.length === 1 && lp[0] === id) {
      lines.push(`${name(p)} only listed this one.`);
      badges.push({ kind: "onlyPick", text: `${name(p)}'s only pick` });
    }
  }
  if (tier === "stretch") {
    const missing = (ctx.pool.missing.get(id) ?? []).map(name);
    if (missing.length === 1) lines.push(`${missing[0]} doesn't own it.`);
    else if (missing.length) lines.push(`${joinNames(missing)} don't own it.`);
  }
  const v = ctx.pool.vetoers.get(id);
  if (v && v.length) {
    const ns = v.map(name);
    if (ctx.settings.veto_mode === "soft") lines.push(`${joinNames(ns)}: definitely not, so it's weighted down.`);
    else if (ctx.settings.veto_mode === "off") lines.push(`${joinNames(ns)} would rather not (vetoes are off tonight).`);
  }
  if (w) {
    if (w.even) lines.push("Nobody here leans toward a game, so every game gets an even share.");
    if (w.damped) {
      lines.push("Won last time, so it's weighted down.");
      badges.push({ kind: "lastWinner", text: "won last time" });
    }
    if (w.consensus > 1.0) lines.push(`Listed by ${owners.length} of ${ctx.present.length}, so it gets a consensus bonus.`);
  }
  return [lines, badges];
}

export const explainSuperseded = (winnerByName: string) => `Two people spun at once. ${winnerByName}'s spin came first.`;

export function explainVoided(byName: string, reason: string): string {
  const r = reason.trim();
  return r === "" ? `Voided by ${byName}.` : `Voided by ${byName}: ${r.replace(/\.+$/, "")}.`;
}
