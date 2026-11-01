// editor.ts — the theme editor's pure side (THEMES-UI.md §12; ENGINE.md §10): the operations on a working theme
// document, the undo history, readability (contrast) issues and their fixes, the island-opacity macro, save / export
// helpers. The TypeScript REFERENCE: the desktop ports it line by line (crates/theme/src/editor.rs) and both run the
// shared vectors (testvectors/editor/, tools/theme-lib/gen-editor-vectors.mjs) byte for byte.
//
// Pure: no DOM, no clock, no I/O. Every operation returns a NEW document (never mutates its input) or a refusal code;
// a document it returns always resolves (the engine checks it), so the live preview can never be handed a theme that
// would be refused — a malformed edit is refused, never half-applied.
import { canonJson, cmpCodePoint, prettyJson } from "./canon";
import type { ResolvedTheme, TokensSpec } from "./engine";
import { NO_TOKENS, resolveTheme } from "./engine";
import type { Expr } from "./expr";
import { parseExpr } from "./expr";
import { slugify } from "./import";
import { codePoints, takeCodePoints } from "./limits";
import type { Colour } from "./literal";
import { formatColour, isOpaque, parseLiteral, sameColour } from "./literal";
import { DENSITIES, FONT_SLOTS, SHADOW_BOUNDS, SIZE_BOUNDS, isAllowedFont } from "./look";
import { luminance, toOklab } from "./maths";
import { cr, guardAllC, guardC } from "./ops";
import { GUARDS, GUARD_SURFACES, PALETTE_SLOTS, ROLE_SET } from "./roles";
import { SHAPE_BOUNDS } from "./shape";
import { PALETTE_GROUPS, paletteView, shiftColour, type Swatch } from "./palette";
import type { JObj, Json } from "./sync";
import { clone, isObj, uniqueThemeId } from "./sync";

// ---- operations ------------------------------------------------------------------------------------------------------

/** One edit (THEMES-UI.md §12.2). `null` clears the field (where the table allows it). */
export type EditOp =
  | { op: "name"; value: string }
  | { op: "author"; value: string | null }
  | { op: "background"; value: string }
  | { op: "accent"; value: string }
  | { op: "palette"; slot: string; value: string | null }
  | { op: "role"; id: string; value: string | null }
  | { op: "token"; id: string; value: string | null }
  | { op: "shape"; key: string; value: number | null }
  | { op: "density"; value: string | null }
  | { op: "font"; slot: string; value: string | null }
  | { op: "size"; value: number | null }
  | { op: "opacity"; value: number }
  | { op: "swatch"; id: string; value: string }
  | { op: "group"; id: string; value: string };

export type EditResult = { ok: true; doc: JObj; resolved: ResolvedTheme } | { ok: false; error: string };

/** The shape keys the editor sets (radius / gap / margin / border: shape.ts; shadow: look.ts). */
export const SHAPE_KEYS = ["radius", "gap", "margin", "border", "shadow"] as const;
/** The island fills the opacity slider changes: every island except the call (its stage stays opaque under video,
 *  ISLANDS-ARCH §3.4) and the widgets (clear by design: each widget draws its own card). */
export const OPACITY_TOKENS: readonly string[] = [
  "island.bg.account", "island.bg.buttons", "island.bg.composer", "island.bg.dms", "island.bg.header", "island.bg.nav",
  "island.bg.panel", "island.bg.rooms", "island.bg.spaces", "island.bg.timeline",
];
export const OPACITY_BOUNDS: readonly [number, number] = [40, 100];

/** A roles-only theme's surface family, re-derived from a new background (§12.2 `background`): [role, dark, light]. */
export const SURFACE_FAMILY: readonly (readonly [string, string, string])[] = [
  ["surface.window", "mixok(surface.island, #000000, 0.25)", "mixok(surface.island, text.primary, 0.06)"],
  ["surface.raised", "mixok(surface.island, text.primary, 0.07)", "mixok(surface.island, #ffffff, 0.6)"],
  ["surface.hover", "mixok(surface.island, text.primary, 0.1)", "mixok(surface.island, text.primary, 0.1)"],
  ["surface.pressed", "mixok(surface.island, text.primary, 0.14)", "mixok(surface.island, text.primary, 0.14)"],
  ["surface.sunken", "mixok(surface.island, surface.window, 0.5)", "mixok(surface.island, surface.window, 0.5)"],
  ["border.subtle", "mixok(surface.island, text.primary, 0.13)", "mixok(surface.island, text.primary, 0.13)"],
  ["border.strong", "mixok(surface.island, text.primary, 0.24)", "mixok(surface.island, text.primary, 0.24)"],
];
/** accent.bright of a roles-only theme after `accent` (the engine's derivation for a literal accent, ENGINE.md §5). */
export const BRIGHT_DARK = "mixok(accent.base, #ffffff, 0.3)";
export const BRIGHT_LIGHT = "mixok(accent.base, #000000, 0.2)";

/** Accent suggestions for a theme without a palette (roles-only: OLED, Goose and their copies). */
export const ACCENT_PRESETS: readonly string[] = [
  "#1e6a76", "#2f6fd6", "#5b5bd6", "#8a4fd8", "#b0508c", "#d0485e", "#d0642c", "#c99a1e", "#4f9a3a", "#1f9d7a",
  "#0f8fb0", "#6b7280",
];

const OPTIONAL_SLOTS = new Set(["cursor", "selectionBg", "selectionFg"]);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const own = (o: JObj, k: string): Json | undefined => (has(o, k) ? o[k] : undefined);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isAsciiWs = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === 13;

class Fail {
  error: string;
  constructor(error: string) {
    this.error = error;
  }
}
const fail = (code: string): never => {
  throw new Fail(code);
};

/** Strip space / tab / CR / LF from both ends (the expression grammar's whitespace; the same in Rust). */
export function trimAscii(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isAsciiWs(s.charCodeAt(a))) a++;
  while (b > a && isAsciiWs(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** An opaque colour literal (any accepted form), or null. */
function opaqueLiteral(v: unknown): Colour | null {
  if (typeof v !== "string") return null;
  const c = parseLiteral(v);
  return c && isOpaque(c) ? c : null;
}

/** An expression value as stored: a colour literal in canonical form, else the expression text (trimmed). */
export function exprValue(v: unknown): string {
  if (typeof v !== "string") fail("bad-op");
  const t = trimAscii(v as string);
  const c = parseLiteral(t);
  if (c) return formatColour(c);
  const p = parseExpr(t);
  if (!p.ok) fail(`bad-expr: ${p.why}`);
  return t;
}

/** k / 10000 printed with integer maths: "0.85", "1", "1.18", "0.0001" (ENGINE.md §1's alpha digits). */
export function numText(k: number): string {
  const ip = Math.floor(k / 10000);
  const fp = k - ip * 10000;
  if (fp === 0) return String(ip);
  let d = String(fp);
  while (d.length < 4) d = "0" + d;
  let end = 4;
  while (d.charCodeAt(end - 1) === 48) end--;
  return `${ip}.${d.slice(0, end)}`;
}

/** Where the number goes in each function's argument list (expr.ts SIGS). */
const NUM_AT: Record<string, number> = { alpha: 1, mix: 2, lighter: 1, darker: 1, mixok: 2, guard: 2, over: -1, best: -1 };

/** Canonical text of a parsed expression: literals canonical, `f(a, b, n)` with ", " and numText. */
export function exprCanon(e: Expr): string {
  if (e.k === "lit") return formatColour(e.c);
  if (e.k === "ref") return e.id;
  const parts = e.args.map(exprCanon);
  const at = NUM_AT[e.f];
  if (at >= 0) parts.splice(at, 0, numText(Math.round(e.n * 10000)));
  return `${e.f}(${parts.join(", ")})`;
}

function obj(): JObj {
  return Object.create(null) as JObj;
}
/** The object at d[key], created (replacing a non-object) when missing. */
function ensure(d: JObj, key: string): JObj {
  const v = own(d, key);
  if (isObj(v)) return v;
  const o = obj();
  d[key] = o;
  return o;
}
/** Remove d[key][field]; drop d[key] when that leaves it empty. */
function removeIn(d: JObj, key: string, field: string): void {
  const v = own(d, key);
  if (!isObj(v) || !has(v, field)) return;
  delete v[field];
  if (Object.keys(v).length === 0) delete d[key];
}
const hasPalette = (d: JObj): boolean => has(d, "palette");

function resolveOrFail(d: JObj, spec: TokensSpec): ResolvedTheme {
  const r = resolveTheme(d, spec);
  if (!r.ok) fail(`refused: ${r.error}`);
  return r as ResolvedTheme;
}

/** Tokens whose override is a literal equal to an accent colour that changed follow it as a reference (§12.2). */
function followAccent(d: JObj, before: ResolvedTheme, after: ResolvedTheme): void {
  const t = own(d, "tokens");
  if (!isObj(t)) return;
  const oldBright = parseLiteral(before.roles["accent.bright"]) as Colour;
  const oldBase = parseLiteral(before.roles["accent.base"]) as Colour;
  const brightMoved = before.roles["accent.bright"] !== after.roles["accent.bright"];
  const baseMoved = before.roles["accent.base"] !== after.roles["accent.base"];
  for (const k of Object.keys(t).sort(cmpCodePoint)) {
    const v = t[k];
    const c = typeof v === "string" ? parseLiteral(v) : null;
    if (!c) continue;
    if (brightMoved && sameColour(c, oldBright)) t[k] = "accent.bright";
    else if (baseMoved && sameColour(c, oldBase)) t[k] = "accent.base";
  }
}

function tokenDefaults(spec: TokensSpec): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of spec.tokens) m.set(t.id, t.default);
  return m;
}

/** The expression of a token without an outer alpha() (canonical text), or null if it does not parse. */
function unwrapAlpha(src: string): { base: string; k: number | null } | null {
  const p = parseExpr(src);
  if (!p.ok) return null;
  if (p.e.k === "fn" && p.e.f === "alpha") return { base: exprCanon(p.e.args[0]), k: Math.round(p.e.n * 10000) };
  return { base: exprCanon(p.e), k: null };
}

/** Canonical text of an expression source, or null if it does not parse. */
function canonExpr(src: string): string | null {
  const p = parseExpr(src);
  return p.ok ? exprCanon(p.e) : null;
}


/** Simple (palette.ts): write one swatch's new colour into each of its sources and the token overrides that follow it —
 *  the RGB of `c`, each target's own alpha kept. Literals only, in fields every app reads. */
function writeSwatch(d: JObj, sw: Swatch, c: Colour): void {
  const put = (old: string | null): string => {
    const o = old === null ? null : parseLiteral(old);
    return formatColour({ r: c.r, g: c.g, b: c.b, a: o ? o.a : 1 });
  };
  for (const src of sw.sources) {
    if (src === "accent") d.accent = put(typeof d.accent === "string" ? d.accent : null);
    else if (PALETTE_SLOTS.includes(src)) {
      const pal = ensure(d, "palette");
      const m = /^c([0-9]|1[0-5])$/.exec(src);
      if (m) {
        const ansi = own(pal, "ansi") as Json[];
        ansi[Number(m[1])] = put(typeof ansi[Number(m[1])] === "string" ? (ansi[Number(m[1])] as string) : null);
      } else pal[src] = put(typeof pal[src] === "string" ? (pal[src] as string) : null);
    } else {
      const roles = ensure(d, "roles");
      roles[src] = put(typeof roles[src] === "string" ? (roles[src] as string) : null);
    }
  }
  const t = own(d, "tokens");
  if (isObj(t)) for (const id of sw.follow) t[id] = put(typeof t[id] === "string" ? (t[id] as string) : null);
}

/** After a Simple edit of Backgrounds or Text on a roles-only theme that names its variant: the variant follows the
 *  island against the text (as the `background` op does). */
function followVariant(d: JObj, groupId: string): void {
  if (hasPalette(d) || !has(d, "variant") || (groupId !== "backgrounds" && groupId !== "text")) return;
  const r = resolveOrFail(d, NO_TOKENS);
  const dark = luminance(parseLiteral(r.roles["surface.island"]) as Colour) < luminance(parseLiteral(r.roles["text.primary"]) as Colour);
  d.variant = dark ? "dark" : "light";
}

function simpleColour(value: Json | undefined): Colour {
  if (typeof value !== "string") fail("bad-op");
  const c = opaqueLiteral(value);
  if (!c) fail("bad-colour");
  return c as Colour;
}

function applyOp(d: JObj, op: JObj, spec: TokensSpec): void {
  const kind = own(op, "op");
  const value = own(op, "value");
  switch (kind) {
    case "name": {
      if (typeof value !== "string") fail("bad-op");
      const n = trimAscii(value as string);
      if (n.length === 0 || codePoints(n) > 80) fail("bad-value");
      d.name = n;
      return;
    }
    case "author": {
      if (value !== null && typeof value !== "string") fail("bad-op");
      const a = value === null ? "" : trimAscii(value as string);
      if (codePoints(a) > 80) fail("bad-value");
      if (a.length === 0) delete d.author;
      else d.author = a;
      return;
    }
    case "background": {
      const c = opaqueLiteral(value);
      if (typeof value !== "string") fail("bad-op");
      if (!c) fail("bad-colour");
      if (hasPalette(d)) {
        ensure(d, "palette").bg = formatColour(c as Colour);
        return;
      }
      const before = resolveOrFail(d, NO_TOKENS);
      const dark = luminance(c as Colour) < luminance(parseLiteral(before.roles["text.primary"]) as Colour);
      const roles = ensure(d, "roles");
      roles["surface.island"] = formatColour(c as Colour);
      for (const [id, darkE, lightE] of SURFACE_FAMILY) roles[id] = dark ? darkE : lightE;
      if (has(d, "variant")) d.variant = dark ? "dark" : "light";
      return;
    }
    case "accent": {
      if (typeof value !== "string") fail("bad-op");
      const v = value as string;
      const before = resolveOrFail(d, NO_TOKENS);
      if (hasPalette(d)) {
        const pal = ensure(d, "palette");
        let a: string;
        if (v === "cursor") {
          if (!has(pal, "cursor")) fail("bad-value");
          a = v;
        } else if (/^c([1-9]|1[0-5])$/.test(v)) a = v;
        else {
          const c = opaqueLiteral(v);
          if (!c) fail("bad-colour");
          a = formatColour(c as Colour);
        }
        d.accent = a;
        removeIn(d, "roles", "accent.base");
        removeIn(d, "roles", "accent.bright");
      } else {
        if (v === "cursor" || /^c[0-9]+$/.test(v)) fail("no-palette");
        const c = opaqueLiteral(v);
        if (!c) fail("bad-colour");
        const roles = ensure(d, "roles");
        roles["accent.base"] = formatColour(c as Colour);
        roles["accent.bright"] = before.variant === "dark" ? BRIGHT_DARK : BRIGHT_LIGHT;
      }
      const after = resolveOrFail(d, NO_TOKENS);
      followAccent(d, before, after);
      return;
    }
    case "palette": {
      const slot = own(op, "slot");
      if (typeof slot !== "string" || (value !== null && typeof value !== "string")) fail("bad-op");
      if (!hasPalette(d)) fail("no-palette");
      if (!PALETTE_SLOTS.includes(slot as string)) fail("unknown-slot");
      const pal = ensure(d, "palette");
      if (value === null) {
        if (!OPTIONAL_SLOTS.has(slot as string)) fail("required");
        delete pal[slot as string];
        return;
      }
      const c = opaqueLiteral(value);
      if (!c) fail("bad-colour");
      const m = /^c([0-9]|1[0-5])$/.exec(slot as string);
      if (m) {
        const ansi = own(pal, "ansi");
        if (!Array.isArray(ansi) || ansi.length !== 16) fail("refused: bad-palette: ansi must be 16 colours");
        (ansi as Json[])[Number(m[1])] = formatColour(c as Colour);
      } else pal[slot as string] = formatColour(c as Colour);
      return;
    }
    case "role": {
      const id = own(op, "id");
      if (typeof id !== "string") fail("bad-op");
      if (!ROLE_SET.has(id as string)) fail("unknown-role");
      if (value === null) {
        if (!hasPalette(d)) fail("required");
        removeIn(d, "roles", id as string);
        return;
      }
      ensure(d, "roles")[id as string] = exprValue(value);
      return;
    }
    case "token": {
      const id = own(op, "id");
      if (typeof id !== "string") fail("bad-op");
      if (!spec.tokens.some((t) => t.id === id)) fail("unknown-token");
      if (value === null) {
        removeIn(d, "tokens", id as string);
        return;
      }
      ensure(d, "tokens")[id as string] = exprValue(value);
      return;
    }
    case "shape": {
      const key = own(op, "key");
      if (typeof key !== "string" || (value !== null && typeof value !== "number")) fail("bad-op");
      if (!(SHAPE_KEYS as readonly string[]).includes(key as string)) fail("unknown-key");
      if (value === null) {
        removeIn(d, "shape", key as string);
        return;
      }
      const [lo, hi] = key === "shadow" ? SHADOW_BOUNDS : SHAPE_BOUNDS[key as "radius"];
      if (!isInt(value) || (value as number) < lo || (value as number) > hi) fail("out-of-range");
      ensure(d, "shape")[key as string] = value as number;
      return;
    }
    case "density": {
      if (value !== null && typeof value !== "string") fail("bad-op");
      if (value === null) {
        removeIn(d, "shape", "density");
        return;
      }
      if (!(DENSITIES as readonly string[]).includes(value as string)) fail("bad-value");
      ensure(d, "shape").density = value as string;
      return;
    }
    case "font": {
      const slot = own(op, "slot");
      if (typeof slot !== "string" || (value !== null && typeof value !== "string")) fail("bad-op");
      if (!(FONT_SLOTS as readonly string[]).includes(slot as string)) fail("unknown-slot");
      if (value === null) {
        removeIn(d, "type", slot as string);
        return;
      }
      if (!isAllowedFont(slot as string, value)) fail("font-not-allowed");
      ensure(d, "type")[slot as string] = value as string;
      return;
    }
    case "size": {
      if (value !== null && typeof value !== "number") fail("bad-op");
      if (value === null) {
        removeIn(d, "type", "size");
        return;
      }
      if (!isInt(value) || (value as number) < SIZE_BOUNDS[0] || (value as number) > SIZE_BOUNDS[1]) fail("out-of-range");
      ensure(d, "type").size = value as number;
      return;
    }
    case "opacity": {
      if (typeof value !== "number") fail("bad-op");
      if (!isInt(value) || (value as number) < OPACITY_BOUNDS[0] || (value as number) > OPACITY_BOUNDS[1]) fail("out-of-range");
      const defaults = tokenDefaults(spec);
      for (const id of OPACITY_TOKENS) {
        const dflt = defaults.get(id);
        if (dflt === undefined) continue; // an older token list without the island fills
        const t = own(d, "tokens");
        const overridden = isObj(t) && has(t, id) && typeof t[id] === "string";
        const dfltCanon = canonExpr(dflt);
        // the fill without the alpha this slider set (an override is unwrapped once; a default never is)
        const u = overridden ? unwrapAlpha((t as JObj)[id] as string) : null;
        const base = u ? u.base : dfltCanon;
        if (base === null) fail(`bad-expr: ${id}`);
        if (value === 100) {
          if (base === dfltCanon) removeIn(d, "tokens", id);
          else ensure(d, "tokens")[id] = base as string;
        } else ensure(d, "tokens")[id] = `alpha(${base as string}, ${numText((value as number) * 100)})`;
      }
      return;
    }
    case "swatch": {
      const id = own(op, "id");
      if (typeof id !== "string") fail("bad-op");
      const c = simpleColour(value);
      resolveOrFail(d, NO_TOKENS);
      const view = paletteView(d, NO_TOKENS);
      for (const g of view.groups) {
        const sw = g.swatches.find((x) => x.sources.includes(id as string));
        if (!sw) continue;
        writeSwatch(d, sw, c);
        followVariant(d, g.id);
        return;
      }
      fail("unknown-swatch");
      return;
    }
    case "group": {
      const id = own(op, "id");
      if (typeof id !== "string") fail("bad-op");
      if (!PALETTE_GROUPS.some((g) => g.id === id)) fail("unknown-group");
      const c = simpleColour(value);
      resolveOrFail(d, NO_TOKENS);
      const g = paletteView(d, NO_TOKENS).groups.find((x) => x.id === id) as { id: string; swatches: Swatch[] };
      if (g.swatches.length === 0) fail("empty-group");
      const lead = parseLiteral(g.swatches[0].colour) as Colour;
      const p = toOklab(lead);
      const q = toOklab(c);
      const same = lead.r === c.r && lead.g === c.g && lead.b === c.b;
      const dL = same ? 0 : q.L - p.L;
      const dA = same ? 0 : q.A - p.A;
      const dB = same ? 0 : q.B - p.B;
      g.swatches.forEach((sw, i) => writeSwatch(d, sw, i === 0 ? c : shiftColour(parseLiteral(sw.colour) as Colour, dL, dA, dB)));
      followVariant(d, id as string);
      return;
    }
    default:
      fail("bad-op");
  }
}

/**
 * Apply one edit to a working document (§12.2). Returns the new document and its resolve, or `{ok: false, error}`:
 * `bad-op`, `bad-colour`, `bad-value`, `no-palette`, `required`, `unknown-role`, `unknown-token`, `unknown-slot`,
 * `unknown-key`, `bad-expr: <why>`, `out-of-range`, `font-not-allowed`, or `refused: <engine error>` when the result
 * would not resolve. Never throws; never mutates `doc`.
 */
export function applyEdit(doc: unknown, op: unknown, spec: TokensSpec): EditResult {
  try {
    if (!isObj(doc) || !isObj(op)) fail("bad-op");
    const d = clone(doc as JObj);
    applyOp(d, op as JObj, spec);
    const r = resolveOrFail(d, spec);
    return { ok: true, doc: d, resolved: r };
  } catch (x) {
    if (x instanceof Fail) return { ok: false, error: x.error };
    throw x;
  }
}

/** The history key of an op: edits of the same key in one gesture (a drag) are one undo step. */
export function opKey(op: EditOp | JObj): string {
  const o = op as JObj;
  const target = own(o, "slot") ?? own(o, "id") ?? own(o, "key") ?? "";
  return `${String(own(o, "op"))}:${String(target)}`;
}

/** Island opacity (per cent) as the slider shows it: 100 when no OPACITY_TOKENS fill is overridden with an alpha(),
 *  the shared value when every fill is `alpha(x, n)` with the same whole-per-cent n (or 100), else null (mixed). */
export function islandOpacity(doc: unknown, spec: TokensSpec): number | null {
  const defaults = tokenDefaults(spec);
  const t = isObj(doc) ? own(doc as JObj, "tokens") : undefined;
  let shared: number | undefined;
  for (const id of OPACITY_TOKENS) {
    if (!defaults.has(id)) continue;
    let pct = 100;
    if (isObj(t) && has(t, id) && typeof t[id] === "string") {
      const u = unwrapAlpha(t[id] as string);
      if (!u) return null;
      if (u.k !== null) {
        if (u.k % 100 !== 0) return null;
        pct = u.k / 100;
      }
    }
    if (shared === undefined) shared = pct;
    else if (shared !== pct) return null;
  }
  return shared ?? 100;
}

// ---- history (§12.3) -------------------------------------------------------------------------------------------------

export const HISTORY_MAX = 100;

export interface EditSession {
  /** the document the editor opened with (Reset / Cancel / dirty) */
  base: JObj;
  /** the working document (always resolves) */
  doc: JObj;
  /** undo stack, oldest first (≤ HISTORY_MAX) */
  past: JObj[];
  /** redo stack, the most recently undone last */
  future: JObj[];
  /** the gesture of the last edit (edits of one gesture on the same key coalesce), null after undo / redo */
  gesture: number | null;
  lastKey: string | null;
}

export function openSession(doc: JObj): EditSession {
  return { base: clone(doc), doc: clone(doc), past: [], future: [], gesture: null, lastKey: null };
}

export type SessionStep = { ok: true; result: "edited" | "noop"; session: EditSession } | { ok: false; error: string };

/**
 * An edit in the session: refused → the session is unchanged; equal to the working document → noop; else the old
 * document goes on the undo stack — unless this edit continues the previous one's gesture on the same key — and the
 * redo stack is cleared.
 */
export function sessionEdit(s: EditSession, op: unknown, spec: TokensSpec, gesture: number | null = null): SessionStep {
  const key = isObj(op) ? opKey(op as JObj) : "";
  const coalesce = gesture !== null && s.gesture === gesture && s.lastKey === key && s.past.length > 0;
  // Simple's palette edits continue a drag from the document before the gesture: swatch membership, the lead and the
  // old colours are read there, so a drag cannot capture a swatch it passes and never drifts (THEME-SIMPLE §7)
  const fromStart = coalesce && isObj(op) && (own(op as JObj, "op") === "swatch" || own(op as JObj, "op") === "group");
  const r = applyEdit(fromStart ? s.past[s.past.length - 1] : s.doc, op, spec);
  if (!r.ok) return r;
  if (canonJson(r.doc) === canonJson(s.doc)) return { ok: true, result: "noop", session: s };
  const past = coalesce ? s.past : [...s.past, s.doc].slice(-HISTORY_MAX);
  return { ok: true, result: "edited", session: { base: s.base, doc: r.doc, past, future: [], gesture, lastKey: key } };
}

export function sessionUndo(s: EditSession): { result: "undone" | "noop"; session: EditSession } {
  if (s.past.length === 0) return { result: "noop", session: s };
  const doc = s.past[s.past.length - 1];
  return { result: "undone", session: { base: s.base, doc, past: s.past.slice(0, -1), future: [...s.future, s.doc], gesture: null, lastKey: null } };
}

export function sessionRedo(s: EditSession): { result: "redone" | "noop"; session: EditSession } {
  if (s.future.length === 0) return { result: "noop", session: s };
  const doc = s.future[s.future.length - 1];
  return { result: "redone", session: { base: s.base, doc, past: [...s.past, s.doc].slice(-HISTORY_MAX), future: s.future.slice(0, -1), gesture: null, lastKey: null } };
}

/** Reset all: back to the base document as one more undoable step. */
export function sessionReset(s: EditSession): { result: "reset" | "noop"; session: EditSession } {
  if (canonJson(s.doc) === canonJson(s.base)) return { result: "noop", session: s };
  return { result: "reset", session: { base: s.base, doc: clone(s.base), past: [...s.past, s.doc].slice(-HISTORY_MAX), future: [], gesture: null, lastKey: null } };
}

export const isDirty = (s: EditSession): boolean => canonJson(s.doc) !== canonJson(s.base);

// ---- readability (§12.5) ---------------------------------------------------------------------------------------------

export interface ContrastIssue {
  fg: string;
  bg: string;
  /** cr(fg, bg), floored to 2 decimals */
  ratio: number;
  need: number;
}

/**
 * The token pairs checked for readability, from the naming contract (NAMING.md §4): a token `<p>.fg[.<state>]` (4.5)
 * or `<p>.icon[.<state>]` (3.0) against `<p>.bg[.<state>]`, else `<p>.bg`, when that token exists. Sorted by fg id.
 */
export function contrastPairs(tokenIds: readonly string[]): Array<[fg: string, bg: string, need: number]> {
  const ids = new Set(tokenIds);
  const out: Array<[string, string, number]> = [];
  for (const id of [...tokenIds].sort(cmpCodePoint)) {
    const m = /^(.+)\.(fg|icon)(\.[a-z][A-Za-z0-9]*)?$/.exec(id);
    if (!m) continue;
    const state = m[3] ?? "";
    const bg = ids.has(`${m[1]}.bg${state}`) ? `${m[1]}.bg${state}` : ids.has(`${m[1]}.bg`) ? `${m[1]}.bg` : null;
    if (bg) out.push([id, bg, m[2] === "fg" ? 4.5 : 3]);
  }
  return out;
}

const floor2 = (x: number): number => Math.floor(x * 100) / 100;

/**
 * Readability issues of a resolved theme (§12.5): every guarded role (ENGINE.md §5 GUARDS) against every guard surface,
 * and every contrastPairs() token pair whose background is opaque (a translucent one sits on something this cannot know:
 * a bubble, a video, a card). Only the pairs below their minimum, sorted by fg, then bg.
 */
export function contrastIssues(resolved: { roles: Record<string, string>; tokens: Record<string, string> }): ContrastIssue[] {
  const out: ContrastIssue[] = [];
  const col = (id: string): Colour | null => {
    const s = has(resolved.roles, id) ? resolved.roles[id] : has(resolved.tokens, id) ? resolved.tokens[id] : undefined;
    return s === undefined ? null : parseLiteral(s);
  };
  for (const [g, need] of [...GUARDS.entries()].sort((a, b) => cmpCodePoint(a[0], b[0]))) {
    const fg = col(g);
    if (!fg) continue;
    for (const s of GUARD_SURFACES) {
      const bg = col(s);
      if (!bg) continue;
      const ratio = cr(fg, bg);
      if (ratio < need) out.push({ fg: g, bg: s, ratio: floor2(ratio), need });
    }
  }
  for (const [f, b, need] of contrastPairs(Object.keys(resolved.tokens))) {
    const fg = col(f);
    const bg = col(b);
    // a translucent background's backdrop is not known here (a bubble, a video, a card): not checked
    if (!fg || !bg || !isOpaque(bg)) continue;
    const ratio = cr(fg, bg);
    if (ratio < need) out.push({ fg: f, bg: b, ratio: floor2(ratio), need });
  }
  return out.sort((a, b) => cmpCodePoint(a.fg, b.fg) || cmpCodePoint(a.bg, b.bg));
}

/** The issues of `now` whose pair is not an issue of `base` (the editor warns about what the edits broke, not about a
 *  built-in's own choices). */
export function newIssues(now: ContrastIssue[], base: ContrastIssue[]): ContrastIssue[] {
  const seen = new Set(base.map((i) => `${i.fg}\u0000${i.bg}`));
  return now.filter((i) => !seen.has(`${i.fg}\u0000${i.bg}`));
}

/**
 * The edit that fixes an issue, as a literal on the fg id: a guarded role against a guard surface is moved with
 * guardAll over EVERY guard surface (one fix for all of them, as the engine guards palette themes, ENGINE.md §9); any
 * other pair with guard(fg, bg, need).
 */
export function fixContrast(issue: ContrastIssue, resolved: { roles: Record<string, string>; tokens: Record<string, string> }): EditOp {
  const isRole = has(resolved.roles, issue.fg);
  const fg = parseLiteral(isRole ? resolved.roles[issue.fg] : resolved.tokens[issue.fg]) as Colour;
  let fixed: Colour;
  if (isRole && GUARDS.has(issue.fg) && GUARD_SURFACES.includes(issue.bg)) {
    fixed = guardAllC(fg, GUARD_SURFACES.map((id) => parseLiteral(resolved.roles[id]) as Colour), GUARDS.get(issue.fg) as number);
  } else {
    const bg = parseLiteral(has(resolved.roles, issue.bg) ? resolved.roles[issue.bg] : resolved.tokens[issue.bg]) as Colour;
    fixed = guardC(fg, bg, issue.need);
  }
  return isRole ? { op: "role", id: issue.fg, value: formatColour(fixed) } : { op: "token", id: issue.fg, value: formatColour(fixed) };
}

/** One fix per fg id (the first issue of each fg, in issue order): what the "Fix" buttons apply. */
export function fixesFor(issues: readonly ContrastIssue[], resolved: { roles: Record<string, string>; tokens: Record<string, string> }): EditOp[] {
  const seen = new Set<string>();
  const out: EditOp[] = [];
  for (const i of issues) {
    if (seen.has(i.fg)) continue;
    seen.add(i.fg);
    out.push(fixContrast(i, resolved));
  }
  return out;
}

// ---- starting, saving, exporting (§12.1, §12.4) ----------------------------------------------------------------------

/** "‹name› (edited)", cut so it stays ≤ 80 code points. */
export function copyName(name: string): string {
  const tail = " (edited)";
  return takeCodePoints(trimAscii(name), 80 - tail.length) + tail;
}

/** The working document of "New theme from this": a copy with copyName(name). */
export function startCopy(doc: JObj): JObj {
  const d = clone(doc);
  d.name = copyName(typeof d.name === "string" ? d.name : "Theme");
  return d;
}

/** The document to save: `mine` keeps its id; `new` gets slugify(name) made unique (THEMES-SYNC §4.1). */
export function saveDoc(doc: JObj, target: { kind: "mine"; id: string } | { kind: "new" }, taken: (id: string) => boolean): JObj {
  const d = clone(doc);
  d.id = target.kind === "mine" ? target.id : uniqueThemeId(slugify(typeof d.name === "string" ? d.name : ""), taken);
  return d;
}

/** The export file's text: the document as pretty canonical JSON (the vector format), ending in a newline. */
export function exportText(doc: JObj): string {
  return prettyJson(doc);
}
/** `<slug>.tinhat-theme.json`. */
export function exportFileName(doc: JObj): string {
  return `${slugify(typeof doc.name === "string" ? doc.name : "")}.tinhat-theme.json`;
}
