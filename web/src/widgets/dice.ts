// dice.ts — the Dice roller's shared logic (contract WIDGETS.md §16 Dice, vectors testvectors/widgets/dice/*): the
// expression grammar and its friendly errors, turning raw die values into a result (keep highest / lowest, the total,
// the natural 20 / 1, the Advantage / Disadvantage label), the unbiased mapping of a random 32-bit word onto a die,
// the room message (plain body for every client + an HTML body + the structured `dev.tinhat.dice` field), reading
// that field back (a card only when everything re-adds up), the private-roll list kept on this device, the history
// order and the Small line. Pure: the RNG (web crypto.getRandomValues, desktop the OS CSPRNG) only supplies 32-bit
// words; everything the two apps show is decided here. The desktop's Rust port (crates/widgets/src/dice.rs) runs the
// same vectors (strings cut / compared in code points, whitespace ASCII only, numbers as doubles).

/** An expression longer than this many code points is refused (E_LONG). */
export const DICE_EXPR_MAX = 100;
/** At most this many dice in one roll (every dice term together). */
export const DICE_MAX = 100;
/** The most sides a die may have. */
export const SIDES_MAX = 1000;
/** A constant term's largest value. */
export const NUMBER_MAX = 10000;
/** At most this many terms (dice terms and numbers). */
export const TERMS_MAX = 20;
/** The private-roll list keeps the newest this many. */
export const PRIVATE_MAX = 50;
/** The wire field (inside the room message's content — encrypted with it in an encrypted room). */
export const DICE_FIELD = "dev.tinhat.dice";

export type DiceErrorCode =
  | "E_EMPTY"
  | "E_LONG"
  | "E_SYNTAX"
  | "E_COUNT"
  | "E_TOO_MANY"
  | "E_SIDES_FEW"
  | "E_SIDES_MANY"
  | "E_KEEP"
  | "E_NUMBER"
  | "E_TERMS"
  | "E_NO_DICE";

export type Keep = "all" | "kh" | "kl";

export interface DiceTerm {
  kind: "dice";
  sign: 1 | -1;
  count: number;
  sides: number;
  keep: Keep;
  /** how many dice count: `count` for "all" */
  n: number;
}
export interface NumTerm {
  kind: "num";
  sign: 1 | -1;
  value: number;
}
export type Term = DiceTerm | NumTerm;

export type DiceParse =
  | { ok: true; expr: string; terms: Term[]; dice: number; label: DiceLabel }
  | { ok: false; code: DiceErrorCode; message: string };

export type DiceLabel = "" | "Advantage" | "Disadvantage";
export type Natural = "" | "nat20" | "nat1";

export interface DiceGroup {
  kind: "dice";
  sign: 1 | -1;
  count: number;
  sides: number;
  keep: Keep;
  n: number;
  rolls: number[];
  kept: boolean[];
  /** the kept dice added up (before the sign) */
  sum: number;
}
export type ResultGroup = DiceGroup | NumTerm;

export interface DiceResult {
  expr: string;
  label: DiceLabel;
  total: number;
  groups: ResultGroup[];
  /** every die in order (term by term) */
  rolls: number[];
  kept: boolean[];
  natural: Natural;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isWs = (c: string) => c === " " || (c >= "\t" && c <= "\r");
const isDigit = (c: string) => c >= "0" && c <= "9";

function fail(code: DiceErrorCode, count = 0): DiceParse {
  return { ok: false, code, message: errorText(code, count) };
}

/** The friendly text of an error (E_KEEP names the term's dice count). */
export function errorText(code: DiceErrorCode, count = 0): string {
  switch (code) {
    case "E_EMPTY":
      return "Type a roll, like 2d6+3";
    case "E_LONG":
      return "That's too long — 100 characters at most";
    case "E_SYNTAX":
      return "Can't read that — try 2d6+3, 4d6kh3 or 2d20kh1";
    case "E_COUNT":
      return "Roll at least 1 die";
    case "E_TOO_MANY":
      return "That's too many dice — 100 at most";
    case "E_SIDES_FEW":
      return "A die needs at least 2 sides";
    case "E_SIDES_MANY":
      return "Dice go up to 1000 sides";
    case "E_KEEP":
      return count === 1 ? "You can only keep 1 die" : `Keep between 1 and ${count} dice`;
    case "E_NUMBER":
      return "Numbers go up to 10000";
    case "E_TERMS":
      return "That's too many parts — 20 at most";
    case "E_NO_DICE":
      return "Add a die, like 1d20";
  }
}

/** One term in its canonical form (no sign). */
function termText(t: Term): string {
  if (t.kind === "num") return String(t.value);
  return `${t.count}d${t.sides}${t.keep === "kh" ? `kh${t.n}` : t.keep === "kl" ? `kl${t.n}` : ""}`;
}

/** The canonical expression of a term list: counts always written, `d%` → d100, `k` → kh, no spaces, "+" / "-". */
export function canonical(terms: Term[]): string {
  let s = "";
  terms.forEach((t, i) => {
    if (i === 0) s += t.sign < 0 ? "-" : "";
    else s += t.sign < 0 ? "-" : "+";
    s += termText(t);
  });
  return s;
}

/** Advantage / Disadvantage: exactly one d20 term, added, 2 dice keeping 1 (kh / kl). */
function labelOf(terms: Term[]): DiceLabel {
  const d20 = terms.filter((t): t is DiceTerm => t.kind === "dice" && t.sides === 20);
  if (d20.length !== 1) return "";
  const t = d20[0]!;
  if (t.sign !== 1 || t.count !== 2 || t.n !== 1) return "";
  return t.keep === "kh" ? "Advantage" : t.keep === "kl" ? "Disadvantage" : "";
}

/**
 * Parse a roll expression. Grammar (ASCII, letters in either case):
 *   expression := ws* [sign ws*] term (ws* sign ws* term)* ws*
 *   term       := dice | number
 *   dice       := [digits] ("d" | "D") (digits | "%") [keep]      count omitted = 1; "%" = 100
 *   keep       := ("kh" | "kl" | "k") digits                       "k" = "kh"
 *   number     := digits
 *   sign       := "+" | "-" | "−" (U+2212)
 *   ws         := U+0009–U+000D | U+0020
 * A run of digits reads as its value, capped at 1e9 (so every overlong number is out of range). Checks, in scan order:
 * the whole text (E_LONG over 100 code points; then E_EMPTY when only whitespace), then left to right — a syntax error
 * where it happens; each finished term: dice count 1–100 (E_COUNT for 0, E_TOO_MANY above), sides 2–1000
 * (E_SIDES_FEW / E_SIDES_MANY), keep 1–count (E_KEEP), a number 0–10000 (E_NUMBER); then the running dice total ≤ 100
 * (E_TOO_MANY) and the term count ≤ 20 (E_TERMS); at the end at least one dice term (E_NO_DICE).
 */
export function parseDice(input: string): DiceParse {
  const cs = [...input];
  if (cs.length > DICE_EXPR_MAX) return fail("E_LONG");
  if (cs.every(isWs)) return fail("E_EMPTY");
  let i = 0;
  const skipWs = () => {
    while (i < cs.length && isWs(cs[i]!)) i++;
  };
  const digits = (): number | null => {
    if (i >= cs.length || !isDigit(cs[i]!)) return null;
    let v = 0;
    while (i < cs.length && isDigit(cs[i]!)) {
      v = Math.min(v * 10 + (cs[i]!.charCodeAt(0) - 48), 1e9);
      i++;
    }
    return v;
  };
  const sign = (): 1 | -1 | 0 => {
    const c = cs[i];
    if (c === "+") return i++, 1;
    if (c === "-" || c === "−") return i++, -1;
    return 0;
  };
  const terms: Term[] = [];
  let dice = 0;
  skipWs();
  let sg: 1 | -1 = 1;
  const first = sign();
  if (first !== 0) {
    sg = first;
    skipWs();
  }
  for (;;) {
    // a term
    const lead = digits();
    const c = cs[i];
    if (c === "d" || c === "D") {
      i++;
      let sides: number | null;
      if (cs[i] === "%") {
        i++;
        sides = 100;
      } else sides = digits();
      if (sides === null) return fail("E_SYNTAX");
      let keep: Keep = "all";
      let n = -1;
      const k = cs[i];
      if (k === "k" || k === "K") {
        i++;
        const h = cs[i];
        if (h === "h" || h === "H") {
          i++;
          keep = "kh";
        } else if (h === "l" || h === "L") {
          i++;
          keep = "kl";
        } else keep = "kh";
        const kn = digits();
        if (kn === null) return fail("E_SYNTAX");
        n = kn;
      }
      const count = lead === null ? 1 : lead;
      if (count < 1) return fail("E_COUNT");
      if (count > DICE_MAX) return fail("E_TOO_MANY");
      if (sides < 2) return fail("E_SIDES_FEW");
      if (sides > SIDES_MAX) return fail("E_SIDES_MANY");
      if (keep === "all") n = count;
      else if (n < 1 || n > count) return fail("E_KEEP", count);
      terms.push({ kind: "dice", sign: sg, count, sides, keep, n });
      dice += count;
      if (dice > DICE_MAX) return fail("E_TOO_MANY");
    } else {
      if (lead === null) return fail("E_SYNTAX");
      if (lead > NUMBER_MAX) return fail("E_NUMBER");
      terms.push({ kind: "num", sign: sg, value: lead });
    }
    if (terms.length > TERMS_MAX) return fail("E_TERMS");
    skipWs();
    if (i >= cs.length) break;
    const s = sign();
    if (s === 0) return fail("E_SYNTAX");
    sg = s;
    skipWs();
    if (i >= cs.length) return fail("E_SYNTAX");
  }
  if (dice === 0) return fail("E_NO_DICE");
  return { ok: true, expr: canonical(terms), terms, dice, label: labelOf(terms) };
}

// ---- randomness -------------------------------------------------------------------------------------------------------

const TWO32 = 4294967296;

/**
 * An unbiased die from one uniformly random 32-bit word `u` (0 ≤ u < 2^32): words at or above the largest multiple of
 * `sides` that fits are REJECTED (null — draw another word); otherwise (u mod sides) + 1.
 */
export function dieFromU32(u: number, sides: number): number | null {
  const limit = TWO32 - (TWO32 % sides);
  return u < limit ? (u % sides) + 1 : null;
}

/** The raw die values of a parsed roll from a stream of 32-bit words (rejection sampling, dice in term order); null
 *  when the stream runs out first. The apps draw words from their CSPRNG until every die has a value. */
export function rawFromStream(p: { terms: Term[] }, stream: number[]): number[] | null {
  const out: number[] = [];
  let i = 0;
  for (const t of p.terms) {
    if (t.kind !== "dice") continue;
    for (let d = 0; d < t.count; d++) {
      for (;;) {
        if (i >= stream.length) return null;
        const v = dieFromU32(stream[i++]!, t.sides);
        if (v !== null) {
          out.push(v);
          break;
        }
      }
    }
  }
  return out;
}

// ---- evaluation -------------------------------------------------------------------------------------------------------

/** Which dice of a group count: all; the n highest (ties → the earlier die); the n lowest (ties → the earlier die). */
function keptOf(rolls: number[], keep: Keep, n: number): boolean[] {
  if (keep === "all") return rolls.map(() => true);
  const idx = rolls.map((_, i) => i);
  idx.sort((a, b) => (keep === "kh" ? rolls[b]! - rolls[a]! : rolls[a]! - rolls[b]!) || a - b);
  const kept = rolls.map(() => false);
  for (let j = 0; j < n; j++) kept[idx[j]!] = true;
  return kept;
}

/**
 * A parsed roll + its raw die values (exactly `dice` of them, each an integer 1–sides of its die, in term order) → the
 * result; null when the values don't fit. natural: exactly one d20 term, added, keeping one die → "nat20" / "nat1" when
 * that die shows 20 / 1.
 */
export function evaluateDice(p: { expr: string; terms: Term[]; dice: number; label: DiceLabel }, raw: readonly unknown[]): DiceResult | null {
  if (!Array.isArray(raw) || raw.length !== p.dice) return null;
  const groups: ResultGroup[] = [];
  const rolls: number[] = [];
  const kept: boolean[] = [];
  let total = 0;
  let pos = 0;
  for (const t of p.terms) {
    if (t.kind === "num") {
      groups.push({ kind: "num", sign: t.sign, value: t.value });
      total += t.sign * t.value;
      continue;
    }
    const rs: number[] = [];
    for (let d = 0; d < t.count; d++) {
      const v = raw[pos++];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > t.sides) return null;
      rs.push(v);
    }
    const ks = keptOf(rs, t.keep, t.n);
    let sum = 0;
    rs.forEach((v, i) => ks[i] && (sum += v));
    groups.push({ kind: "dice", sign: t.sign, count: t.count, sides: t.sides, keep: t.keep, n: t.n, rolls: rs, kept: ks, sum });
    total += t.sign * sum;
    rolls.push(...rs);
    kept.push(...ks);
  }
  let natural: Natural = "";
  const d20 = groups.filter((g): g is DiceGroup => g.kind === "dice" && g.sides === 20);
  if (d20.length === 1 && d20[0]!.sign === 1 && d20[0]!.n === 1) {
    const g = d20[0]!;
    const v = g.rolls[g.kept.indexOf(true)]!;
    natural = v === 20 ? "nat20" : v === 1 ? "nat1" : "";
  }
  return { expr: p.expr, label: p.label, total, groups, rolls, kept, natural };
}

// ---- the room message -------------------------------------------------------------------------------------------------

interface Part {
  sign: 1 | -1;
  v: number;
}
function partsOf(r: DiceResult): { parts: Part[]; dropped: number[] } {
  const parts: Part[] = [];
  const dropped: number[] = [];
  for (const g of r.groups) {
    if (g.kind === "num") parts.push({ sign: g.sign, v: g.value });
    else g.rolls.forEach((v, i) => (g.kept[i] ? parts.push({ sign: g.sign, v }) : dropped.push(v)));
  }
  return { parts, dropped };
}
function sumText(parts: Part[]): string {
  return parts.map((p, i) => (i === 0 ? (p.sign < 0 ? `-${p.v}` : `${p.v}`) : `${p.sign < 0 ? " - " : " + "}${p.v}`)).join("");
}

/**
 * The plain body every client shows: "🎲 rolled 2d6+3 → 9 (4 + 2 + 3)"; the label in brackets after the expression
 * ("🎲 rolled 2d20kh1+5 (advantage) → 23 (18 + 5, dropped 7)"); the breakdown only when there is more than one part or
 * a dropped die; " — natural 20!" / " — natural 1" at the end.
 */
export function diceBody(r: DiceResult): string {
  const { parts, dropped } = partsOf(r);
  const lab = r.label ? ` (${r.label.toLowerCase()})` : "";
  const bd = parts.length > 1 || dropped.length > 0 ? ` (${sumText(parts)}${dropped.length ? `, dropped ${dropped.join(", ")}` : ""})` : "";
  const nat = r.natural === "nat20" ? " — natural 20!" : r.natural === "nat1" ? " — natural 1" : "";
  return `🎲 rolled ${r.expr}${lab} → ${r.total}${bd}${nat}`;
}

/** The same line as HTML (`formatted_body`): the expression in <code>, the total in <strong>, dropped dice in <del>. */
export function diceHtml(r: DiceResult): string {
  const { parts, dropped } = partsOf(r);
  const lab = r.label ? ` (${r.label.toLowerCase()})` : "";
  const bd =
    parts.length > 1 || dropped.length > 0
      ? ` (${sumText(parts)}${dropped.length ? `, dropped ${dropped.map((v) => `<del>${v}</del>`).join(", ")}` : ""})`
      : "";
  const nat = r.natural === "nat20" ? " — <strong>natural 20!</strong>" : r.natural === "nat1" ? " — <strong>natural 1</strong>" : "";
  return `🎲 rolled <code>${r.expr}</code>${lab} → <strong>${r.total}</strong>${bd}${nat}`;
}

/** The structured field: {v: 1, expr, rolls, kept, total}. */
export function diceField(r: DiceResult): { v: 1; expr: string; rolls: number[]; kept: boolean[]; total: number } {
  return { v: 1, expr: r.expr, rolls: [...r.rolls], kept: [...r.kept], total: r.total };
}

/**
 * The room message's content: msgtype m.notice (a machine-made line: no push notification per roll — the default
 * `.m.rule.suppress_notices` — and bots never answer a notice), the plain + HTML bodies, `m.mentions: {}` (a roll
 * mentions nobody), and the structured field.
 */
export function diceContent(r: DiceResult): Record<string, unknown> {
  return {
    msgtype: "m.notice",
    body: diceBody(r),
    format: "org.matrix.custom.html",
    formatted_body: diceHtml(r),
    "m.mentions": {},
    [DICE_FIELD]: diceField(r),
  };
}

/**
 * A message content → its dice result, or null (then the message shows as the plain text it is). Only when the field
 * is an object with v === 1, an expression that parses, `rolls` = exactly that many integers each within its die, a
 * `total` equal to what they add up to, and — when present — `kept` equal to the kept flags they give. The card is
 * rebuilt from expr + rolls; nothing else in the field is trusted.
 */
export function readDice(content: unknown): DiceResult | null {
  if (!isObj(content)) return null;
  const d = content[DICE_FIELD];
  if (!isObj(d) || d.v !== 1 || typeof d.expr !== "string" || !Array.isArray(d.rolls)) return null;
  const p = parseDice(d.expr);
  if (!p.ok) return null;
  const r = evaluateDice(p, d.rolls);
  if (!r || d.total !== r.total) return null;
  if ("kept" in d) {
    const k = d.kept;
    if (!Array.isArray(k) || k.length !== r.kept.length || k.some((x, i) => x !== r.kept[i])) return null;
  }
  return r;
}

/** Roll the same once more with advantage / disadvantage: the one added 1d20 (or 2d20 keeping 1) of `expr` becomes
 *  2d20kh1 / 2d20kl1 (the rest kept); anything else — no d20, several, a subtracted one, other counts, over 100 dice,
 *  an expression that doesn't parse — gives plain "2d20kh1" / "2d20kl1". */
export function withAdvantage(expr: string, kind: "adv" | "dis"): string {
  const plain = kind === "adv" ? "2d20kh1" : "2d20kl1";
  const p = parseDice(expr);
  if (!p.ok) return plain;
  const d20 = p.terms.filter((t) => t.kind === "dice" && t.sides === 20);
  if (d20.length !== 1) return plain;
  const t = d20[0] as DiceTerm;
  if (t.sign !== 1) return plain;
  const ok = (t.count === 1 && t.keep === "all") || (t.count === 2 && t.n === 1);
  if (!ok || p.dice - t.count + 2 > DICE_MAX) return plain;
  const terms = p.terms.map((x) => (x === t ? { kind: "dice" as const, sign: 1 as const, count: 2, sides: 20, keep: (kind === "adv" ? "kh" : "kl") as Keep, n: 1 } : x));
  return canonical(terms);
}

// ---- private rolls + history ---------------------------------------------------------------------------------------------

/** A roll kept on this device only (the private history): never sent anywhere. */
export interface PrivateRoll {
  id: string;
  ts: number;
  expr: string;
  rolls: number[];
  total: number;
}

function cmpStr(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i]!.codePointAt(0)!;
    const q = y[i]!.codePointAt(0)!;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

/**
 * A stored private list → the list: not an array → []; keeps objects with `id` a string of 1–64 code points, `ts` a
 * finite number ≥ 0 (floored), and expr + rolls + total that read as a roll (readDice); the expression becomes
 * canonical; each id once (the first wins); newest first (ts descending, then id in code-point order); at most 50.
 */
export function normalizePrivate(value: unknown): PrivateRoll[] {
  if (!Array.isArray(value)) return [];
  const out: PrivateRoll[] = [];
  const seen = new Set<string>();
  for (const it of value) {
    if (!isObj(it)) continue;
    const id = it.id;
    if (typeof id !== "string") continue;
    const len = [...id].length;
    if (len < 1 || len > 64 || seen.has(id)) continue;
    const ts = it.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) continue;
    const r = readDice({ [DICE_FIELD]: { v: 1, expr: it.expr, rolls: it.rolls, total: it.total } });
    if (!r) continue;
    seen.add(id);
    out.push({ id, ts: Math.floor(ts), expr: r.expr, rolls: [...r.rolls], total: r.total });
  }
  out.sort((a, b) => b.ts - a.ts || cmpStr(a.id, b.id));
  return out.slice(0, PRIVATE_MAX);
}

/** Add a private roll (newest), normalized. */
export function addPrivate(list: PrivateRoll[], roll: PrivateRoll): PrivateRoll[] {
  return normalizePrivate([roll, ...list]);
}

/** A history entry: a roll in the room (its event) or a private one. */
export interface DiceEntry {
  id: string;
  ts: number;
  /** the roller ("" for a private roll: always you) */
  sender: string;
  private: boolean;
  result: DiceResult;
}

/**
 * The history the widget shows: the room's dice messages (`events`: {id, sender, ts, content} — the loaded timeline's
 * m.room.message events, decrypted; ones that don't read as a roll are skipped) and the private rolls, newest first
 * (ts descending, then id in code-point order), each id once, at most `limit` (1–50).
 */
export function diceHistory(events: readonly unknown[], priv: readonly PrivateRoll[], limit: number): DiceEntry[] {
  const out: DiceEntry[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!isObj(e)) continue;
    const { id, sender, ts } = e;
    if (typeof id !== "string" || !id || typeof sender !== "string" || typeof ts !== "number" || !Number.isFinite(ts) || seen.has(id)) continue;
    const r = readDice(e.content);
    if (!r) continue;
    seen.add(id);
    out.push({ id, ts, sender, private: false, result: r });
  }
  for (const p of normalizePrivate(priv)) {
    if (seen.has(p.id)) continue;
    const r = readDice({ [DICE_FIELD]: { v: 1, expr: p.expr, rolls: p.rolls, total: p.total } });
    if (!r) continue;
    seen.add(p.id);
    out.push({ id: p.id, ts: p.ts, sender: "", private: true, result: r });
  }
  out.sort((a, b) => b.ts - a.ts || cmpStr(a.id, b.id));
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 1;
  return out.slice(0, n);
}

/** The Small / collapsed line: "No rolls yet"; "<who> · 2d6+3 → 9" (who = "Private" for a private roll — the app passes
 *  "You" for your own room rolls, else the roller's name); " · nat 20" / " · nat 1" appended. */
export function diceSummary(e: DiceEntry | null, who: string): string {
  if (!e) return "No rolls yet";
  const w = e.private ? "Private" : who;
  const nat = e.result.natural === "nat20" ? " · nat 20" : e.result.natural === "nat1" ? " · nat 1" : "";
  return `${w} · ${e.result.expr} → ${e.result.total}${nat}`;
}

/** A card's dice faces in order, for the apps' renderers: [{v, sides, kept, sign}] (numbers are not faces). */
export function facesOf(r: DiceResult): { v: number; sides: number; kept: boolean; sign: 1 | -1 }[] {
  const out: { v: number; sides: number; kept: boolean; sign: 1 | -1 }[] = [];
  for (const g of r.groups) if (g.kind === "dice") g.rolls.forEach((v, i) => out.push({ v, sides: g.sides, kept: g.kept[i]!, sign: g.sign }));
  return out;
}

/** The modifier text after the faces: the number terms summed with their signs ("+3", "-1", "" when none / zero). */
export function modifierOf(r: DiceResult): string {
  let m = 0;
  let any = false;
  for (const g of r.groups)
    if (g.kind === "num") {
      m += g.sign * g.value;
      any = true;
    }
  if (!any || m === 0) return "";
  return m > 0 ? `+${m}` : `${m}`;
}

// ---- the chat samples (the gates' timeline cards; both apps render the same rows) ------------------------------------------

/** Sample dice messages a gate / review build appends to the open conversation (web `?chatsamples=dice` with the debug
 *  flag, desktop `TINHAT_CHAT_SAMPLES=dice`): local rows only, never sent. `mine` rows are the viewer's own; `at` = today's
 *  local time [h, m]. */
export const DICE_CHAT_SAMPLES: readonly { id: string; sender: string; mine: boolean; at: [number, number]; expr: string; rolls: number[] }[] = [
  { id: "$w3-sample-dice-1", sender: "@Ana:sample.invalid", mine: false, at: [20, 42], expr: "2d20kh1+5", rolls: [7, 20] },
  { id: "$w3-sample-dice-2", sender: "", mine: true, at: [20, 43], expr: "4d6kh3", rolls: [3, 6, 3, 2] },
  { id: "$w3-sample-dice-3", sender: "@Bo:sample.invalid", mine: false, at: [20, 44], expr: "1d20-1", rolls: [1] },
  { id: "$w3-sample-dice-4", sender: "", mine: true, at: [20, 45], expr: "20d6+2", rolls: [6, 1, 3, 4, 5, 2, 6, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6] },
];
