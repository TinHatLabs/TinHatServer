// engine.ts — the Tin Hat theme engine: TypeScript REFERENCE implementation of the contract ENGINE.md v1
// (ENGINE.md; clarifications in ENGINE-QUESTIONS.md; porting notes in README.md).
//
// resolveTheme(theme, tokensSpec) → { ok, variant, names, roles, tokens, adjusted } | { ok: false, error }
// resolveForApp(theme, tokensSpec, "desktop" | "web") → the same + `pinned` (the apps' entry point, web step-1a pins)
// parseThemeJson(text) → { ok, theme } | { ok: false, error } (theme JSON text, read exactly like the Rust port)
// Pure data in, pure data out: no DOM, no I/O, no clock, no randomness; never throws on bad data (a malformed
// theme is refused as a whole, never half-applied). The desktop's Rust port must give byte-identical results
// on the shared test vectors (testvectors/engine/*.json).
import type { Expr } from "./expr";
import { parseExpr } from "./expr";
import {
  BACKDROP_IMAGE_PATH,
  MAX_BYTES,
  MAX_DEPTH,
  MAX_OVERRIDES,
  MAX_STRING,
  codePoints,
  containsUrl,
  isKeyId,
  isMxcUri,
  isJsonData,
  isThemeId,
  pathSeg,
  toWellFormed,
  utf8Length,
} from "./limits";
import type { Colour } from "./literal";
import { formatColour, isOpaque, parseLiteral, sameColour } from "./literal";
import { luminance, mixok } from "./maths";
import { bestC, darkerC, guardAllC, guardC, lighterC, mixC, overC, setAlpha } from "./ops";
import builtinGoose from "./builtin/goose.json" with { type: "json" };
import builtinOled from "./builtin/oled.json" with { type: "json" };
import type { Palette } from "./roles";
import { GUARDS, GUARD_SURFACES, PALETTE_SET, ROLE_IDS, ROLE_SET, accentSlot, cmpId, deriveRoleExprs, paletteSlot } from "./roles";

export type { Colour } from "./literal";
export { formatColour, parseLiteral } from "./literal";
export { GUARDS, PALETTE_SLOTS, ROLE_IDS, cmpId } from "./roles";

export interface TokenSpec {
  id: string;
  default: string;
}
export interface TokensSpec {
  tokens: TokenSpec[];
}
export type Variant = "dark" | "light";
export type NamesMode = "palette" | "hash-hsl";

/** A `tinhat-theme` v1 document (§4). Unknown keys are allowed and preserved by whoever re-saves the file. */
export interface Theme {
  format: "tinhat-theme";
  v: 1;
  id: string;
  name: string;
  author?: string;
  source?: string;
  variant?: Variant;
  accent?: string;
  names?: NamesMode;
  backdrop?: { image?: string; [extra: string]: unknown }; // step 1b; image = an mxc:// URI (§9 C2)
  palette?: {
    bg: string;
    fg: string;
    cursor?: string;
    selectionBg?: string;
    selectionFg?: string;
    ansi: string[];
  };
  roles?: Record<string, string>;
  tokens?: Record<string, string>;
  [extra: string]: unknown;
}

export interface ResolvedTheme {
  ok: true;
  variant: Variant;
  names: NamesMode;
  roles: Record<string, string>; // every role id, sorted, canonical colours
  tokens: Record<string, string>; // every token of the spec, sorted, canonical colours
  adjusted: string[]; // guarded roles the readability guard changed, sorted
}
export interface ResolveError {
  ok: false;
  error: string; // "<code>: <detail>"
}
export type ResolveResult = ResolvedTheme | ResolveError;

class Refusal {
  code: string;
  detail: string;
  constructor(code: string, detail: string) {
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code: string, detail: string): never {
  throw new Refusal(code, detail);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** An OWN property of user data, never one inherited from Object.prototype (`constructor`, `toString`, `__proto__` …):
 *  the Rust port's maps hold own keys only (ENGINE.md §9, PORT-QUESTIONS Q1). */
const own = (o: Obj, k: string): unknown => (has(o, k) ? o[k] : undefined);
const sortedKeys = (o: Obj) => Object.keys(o).sort(cmpId);

// ---- tokens spec ------------------------------------------------------------------------------------------

interface ParsedSpec {
  ids: string[]; // sorted
  exprs: Map<string, Expr>;
  /** token id → built-in theme id → the web's step-1a parity pin (tokens.json `webPin`). */
  webPins: Map<string, Map<string, Colour>>;
}

function parseTokensSpec(spec: unknown): ParsedSpec {
  const list = isObj(spec) ? own(spec, "tokens") : undefined;
  if (!Array.isArray(list)) refuse("bad-tokens", "not a tokens spec");
  const exprs = new Map<string, Expr>();
  const webPins = new Map<string, Map<string, Colour>>();
  for (let i = 0; i < list.length; i++) {
    const t: unknown = list[i];
    const id = isObj(t) ? own(t, "id") : undefined;
    const dflt = isObj(t) ? own(t, "default") : undefined;
    if (!isObj(t) || typeof id !== "string" || typeof dflt !== "string")
      refuse("bad-tokens", `item ${i} needs a string id and default`);
    if (!isKeyId(id)) refuse("bad-tokens", `item ${i}: bad id`);
    if (ROLE_SET.has(id) || PALETTE_SET.has(id)) refuse("bad-tokens", `${id}: clashes with a role or palette slot`);
    if (exprs.has(id)) refuse("bad-tokens", `${id}: duplicate`);
    const p = parseExpr(dflt);
    if (!p.ok) refuse("bad-tokens", `${id}: ${p.why}`);
    exprs.set(id, p.e);
    if (has(t, "webPin")) {
      const w = own(t, "webPin");
      if (!isObj(w)) refuse("bad-tokens", `${id}: bad webPin`);
      const pins = new Map<string, Colour>();
      for (const k of sortedKeys(w)) {
        const c = typeof w[k] === "string" ? parseLiteral(w[k] as string) : null;
        if (!c) refuse("bad-tokens", `${id}: bad webPin`);
        pins.set(k, c);
      }
      webPins.set(id, pins);
    }
  }
  return { ids: [...exprs.keys()].sort(cmpId), exprs, webPins };
}

// ---- theme structure + limits (§4) ------------------------------------------------------------------------

function checkString(s: string, path: string): void {
  if (codePoints(s) > MAX_STRING) refuse("string-too-long", path);
  if (containsUrl(s)) refuse("url", path);
}

/**
 * Depth-first over every value (object keys in id order, arrays in index order): depth, string length, URLs.
 * The one exception (§9 C2): the string at /backdrop/image is exempt from both string checks when it is an mxc URI
 * (its own pattern bounds it); any other value there is checked like every other string.
 */
function scan(v: unknown, path: string, depth: number): void {
  if (typeof v === "string") {
    if (path === BACKDROP_IMAGE_PATH && isMxcUri(v)) return;
    checkString(v, path);
    return;
  }
  if (Array.isArray(v)) {
    if (depth > MAX_DEPTH) refuse("too-deep", path);
    for (let i = 0; i < v.length; i++) scan(v[i], `${path}/${i}`, depth + 1);
    return;
  }
  if (isObj(v)) {
    if (depth > MAX_DEPTH) refuse("too-deep", path);
    for (const k of sortedKeys(v)) {
      const p = `${path}/${pathSeg(k)}`;
      checkString(k, p);
      scan(v[k], p, depth + 1);
    }
  }
}

function checkOverrides(t: Obj, field: "roles" | "tokens"): Obj | null {
  if (!has(t, field)) return null;
  const o = own(t, field);
  if (!isObj(o)) refuse("bad-field", field);
  for (const k of sortedKeys(o)) {
    if (!isKeyId(k)) refuse("bad-key", `/${field}/${pathSeg(k)}`);
    if (typeof o[k] !== "string") refuse("bad-field", `/${field}/${k}`);
  }
  return o;
}

function paletteColour(name: string, v: unknown): Colour {
  const c = typeof v === "string" ? parseLiteral(v) : null;
  if (!c || !isOpaque(c)) refuse("bad-palette", `${name} must be an opaque colour`);
  return c;
}

function parsePalette(p: unknown): Palette {
  if (!isObj(p)) refuse("bad-palette", "not an object");
  const bg = paletteColour("bg", own(p, "bg"));
  const fg = paletteColour("fg", own(p, "fg"));
  const list = own(p, "ansi");
  if (!Array.isArray(list) || list.length !== 16) refuse("bad-palette", "ansi must be 16 colours");
  const ansi = (list as unknown[]).map((v, i) => paletteColour(`ansi[${i}]`, v));
  const opt = (name: string) => (has(p, name) ? paletteColour(name, own(p, name)) : undefined);
  const cursor = opt("cursor");
  const selectionBg = opt("selectionBg");
  const selectionFg = opt("selectionFg");
  return { bg, fg, cursor, selectionBg, selectionFg, ansi };
}

// ---- evaluation (§3 resolution order, §5 guards) ----------------------------------------------------------

class Evaluator {
  palette: Palette | null;
  roleExpr: Map<string, Expr>;
  tokenExpr: Map<string, Expr>;
  guarded: boolean;
  roleVal = new Map<string, Colour>();
  tokenVal = new Map<string, Colour>();
  stack: string[] = [];
  adjusted: string[] = [];

  constructor(palette: Palette | null, roleExpr: Map<string, Expr>, tokenExpr: Map<string, Expr>, guarded: boolean) {
    this.palette = palette;
    this.roleExpr = roleExpr;
    this.tokenExpr = tokenExpr;
    this.guarded = guarded;
  }

  enter(id: string): void {
    const i = this.stack.indexOf(id);
    if (i >= 0) refuse("cycle", [...this.stack.slice(i), id].join(" -> "));
    this.stack.push(id);
  }

  role(id: string): Colour {
    const done = this.roleVal.get(id);
    if (done) return done;
    this.enter(id);
    let c = this.eval(this.roleExpr.get(id) as Expr, id, true);
    const n = this.guarded ? GUARDS.get(id) : undefined;
    if (n !== undefined) {
      // §9 (2026-09-27): against every neutral surface text sits on — island first (it picks the direction).
      const g = guardAllC(c, GUARD_SURFACES.map((s) => this.role(s)), n);
      if (!sameColour(g, c)) this.adjusted.push(id);
      c = g;
    }
    this.stack.pop();
    this.roleVal.set(id, c);
    return c;
  }

  token(id: string): Colour {
    const done = this.tokenVal.get(id);
    if (done) return done;
    this.enter(id);
    const c = this.eval(this.tokenExpr.get(id) as Expr, id, false);
    this.stack.pop();
    this.tokenVal.set(id, c);
    return c;
  }

  ref(id: string, owner: string, inRole: boolean): Colour {
    if (ROLE_SET.has(id)) return this.role(id);
    if (inRole) {
      const c = this.palette && PALETTE_SET.has(id) ? paletteSlot(this.palette, id) : undefined;
      if (c) return c;
    } else if (this.tokenExpr.has(id)) {
      return this.token(id);
    }
    refuse("undefined-ref", `${owner} -> ${id}`);
  }

  eval(e: Expr, owner: string, inRole: boolean): Colour {
    if (e.k === "lit") return e.c;
    if (e.k === "ref") return this.ref(e.id, owner, inRole);
    const a: Colour[] = [];
    for (const x of e.args) a.push(this.eval(x, owner, inRole));
    switch (e.f) {
      case "alpha":
        return setAlpha(a[0], e.n);
      case "mix":
        return mixC(a[0], a[1], e.n);
      case "lighter":
        return lighterC(a[0], e.n);
      case "darker":
        return darkerC(a[0], e.n);
      case "over":
        return overC(a[0], a[1]);
      case "mixok":
        return mixok(a[0], a[1], e.n);
      case "best":
        return bestC(a[0], a.slice(1));
      case "guard":
        return guardC(a[0], a[1], e.n);
    }
  }
}

function parseOrRefuse(src: string, where: string): Expr {
  const p = parseExpr(src);
  if (!p.ok) refuse("bad-expr", `${where}: ${p.why}`);
  return p.e;
}

function resolve(theme: unknown, tokensSpec: unknown, parsed?: ParsedSpec): ResolvedTheme {
  const spec = parsed ?? parseTokensSpec(tokensSpec);

  // 1. shape, JSON data, size, strings, URLs
  if (!isObj(theme)) refuse("bad-theme", "not an object");
  let text: string;
  try {
    text = JSON.stringify(theme);
  } catch {
    refuse("bad-theme", "not JSON data"); // a cycle, a BigInt, …
  }
  // what the Rust port can hold (§9, PORT-QUESTIONS Q2/Q3): nesting ≤ 128, no lone surrogate in a string or key
  if (!isJsonData(theme)) refuse("bad-theme", "not JSON data");
  const bytes = utf8Length(text);
  if (bytes > MAX_BYTES) refuse("too-large", `${bytes} bytes (max ${MAX_BYTES})`);
  scan(theme, "", 1);

  // 2. header fields (own properties only, like every read of user data)
  if (own(theme, "format") !== "tinhat-theme") refuse("bad-format", "expected tinhat-theme");
  if (own(theme, "v") !== 1) refuse("bad-version", "expected 1");
  const id = own(theme, "id");
  if (typeof id !== "string" || !isThemeId(id)) refuse("bad-id", "must be 1-64 characters of a-z 0-9 . : -");
  const name = own(theme, "name");
  if (typeof name !== "string" || !/[^ \t\n\r]/.test(name)) refuse("bad-name", "must be a non-empty string");
  for (const f of ["author", "source"]) if (has(theme, f) && typeof own(theme, f) !== "string") refuse("bad-field", f);
  const variantField = own(theme, "variant");
  if (has(theme, "variant") && variantField !== "dark" && variantField !== "light") refuse("bad-field", "variant");
  const namesField = own(theme, "names");
  if (has(theme, "names") && namesField !== "palette" && namesField !== "hash-hsl") refuse("bad-field", "names");
  const accent = own(theme, "accent");
  if (has(theme, "accent") && (typeof accent !== "string" || accentSlot(accent) < 0))
    refuse("bad-accent", "must be cursor, c1-c15 or a colour");
  if (has(theme, "backdrop")) {
    // step 1b: only `image` is validated for now; other backdrop keys are kept like unknown keys
    const b = own(theme, "backdrop");
    if (!isObj(b)) refuse("bad-field", "backdrop");
    const image = own(b, "image");
    if (has(b, "image") && (typeof image !== "string" || !isMxcUri(image))) refuse("bad-field", BACKDROP_IMAGE_PATH);
  }
  const roleOv = checkOverrides(theme, "roles");
  const tokenOv = checkOverrides(theme, "tokens");
  const nOv = (roleOv ? Object.keys(roleOv).length : 0) + (tokenOv ? Object.keys(tokenOv).length : 0);
  if (nOv > MAX_OVERRIDES) refuse("too-many-overrides", `${nOv} (max ${MAX_OVERRIDES})`);

  // 3. colours: a palette (derivation + overrides + guards) or every role directly
  const palette = has(theme, "palette") ? parsePalette(own(theme, "palette")) : null;
  if (!palette && !roleOv) refuse("no-colours", "needs a palette or every role");
  if (!palette) for (const id of ROLE_IDS) if (!has(roleOv as Obj, id)) refuse("missing-role", id);

  const explicitVariant = variantField as Variant | undefined;
  let variant: Variant | undefined = explicitVariant;
  const roleExpr = new Map<string, Expr>();
  if (palette) {
    if (!variant) variant = luminance(palette.bg) < luminance(palette.fg) ? "dark" : "light";
    const derived = deriveRoleExprs(palette, variant === "dark", accent as string | undefined);
    for (const [id, src] of derived) {
      const p = parseExpr(src);
      if (!p.ok) throw new Error(`theme engine: bad derivation for ${id}: ${p.why}`);
      roleExpr.set(id, p.e);
    }
  }
  if (roleOv) for (const id of sortedKeys(roleOv)) if (ROLE_SET.has(id)) roleExpr.set(id, parseOrRefuse(roleOv[id] as string, `/roles/${id}`));
  const tokenExpr = new Map<string, Expr>(spec.exprs);
  if (tokenOv) for (const id of sortedKeys(tokenOv)) if (spec.exprs.has(id)) tokenExpr.set(id, parseOrRefuse(tokenOv[id] as string, `/tokens/${id}`));

  // 4. evaluate: roles in id order, then tokens in id order
  const ev = new Evaluator(palette, roleExpr, tokenExpr, palette !== null);
  for (const id of ROLE_IDS) ev.role(id);
  for (const id of spec.ids) ev.token(id);
  if (!variant) {
    const island = ev.roleVal.get("surface.island") as Colour;
    const primary = ev.roleVal.get("text.primary") as Colour;
    variant = luminance(island) < luminance(primary) ? "dark" : "light";
  }

  const roles: Record<string, string> = {};
  for (const id of ROLE_IDS) roles[id] = formatColour(ev.roleVal.get(id) as Colour);
  const tokens: Record<string, string> = {};
  for (const id of spec.ids) tokens[id] = formatColour(ev.tokenVal.get(id) as Colour);
  return {
    ok: true,
    variant,
    names: (namesField as NamesMode | undefined) ?? "palette",
    roles,
    tokens,
    adjusted: [...ev.adjusted].sort(cmpId),
  };
}

/** ENGINE.md §6. Never throws for bad input; `error` is "<code>: <detail>" (codes: README "Refusals"). */
export function resolveTheme(theme: unknown, tokensSpec: unknown): ResolveResult {
  try {
    return resolve(theme, tokensSpec);
  } catch (x) {
    if (x instanceof Refusal) return { ok: false, error: `${x.code}: ${x.detail}` };
    throw x;
  }
}

/** Empty token spec (roles only). */
export const NO_TOKENS: TokensSpec = { tokens: [] };

/**
 * A theme document from JSON text (account data, a shared card, a file), read exactly as the Rust port reads it
 * (`parse_theme_json`): strict JSON (no BOM, no comments), arrays/objects nested at most 128 deep, no lone surrogate
 * made by a `\u` escape (a raw lone surrogate in the text reads as U+FFFD, as after any UTF-8 transfer). Anything
 * else is `bad-theme: not JSON data`. Hand the theme to resolveTheme / resolveForApp. Never throws.
 */
export function parseThemeJson(text: string): { ok: true; theme: unknown } | ResolveError {
  let theme: unknown;
  try {
    if (typeof text !== "string") throw new Error("not text");
    theme = JSON.parse(toWellFormed(text));
  } catch {
    return { ok: false, error: "bad-theme: not JSON data" };
  }
  if (!isJsonData(theme)) return { ok: false, error: "bad-theme: not JSON data" };
  return { ok: true, theme };
}

// ---- the apps' entry point ----------------------------------------------------------------------------------

export type App = "desktop" | "web";
export interface AppResolved extends ResolvedTheme {
  pinned: string[]; // tokens replaced by the web's step-1a parity pins, sorted
}
export type AppResolveResult = AppResolved | ResolveError;

/** The shipped built-ins, by id (src/theme/builtin = contract/builtin, byte copies). */
export const BUILTINS: Readonly<Record<string, Theme>> = {
  goose: builtinGoose as unknown as Theme,
  oled: builtinOled as unknown as Theme,
};

/** Structural equality of JSON data: same keys (any order), same strings, numbers equal as doubles, same arrays. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!has(b, k) || !sameJson(a[k], b[k])) return false;
  return true;
}

/** A theme is a built-in when its id names one and it is structurally equal to that shipped document. */
export function builtinId(theme: unknown): string | null {
  if (!isObj(theme)) return null;
  const id = own(theme, "id");
  if (typeof id !== "string" || !has(BUILTINS, id)) return null;
  return sameJson(theme, BUILTINS[id]) ? id : null;
}

/**
 * What the apps call (ENGINE.md §9 step-1a pins): resolveTheme, then — for app "web" only, and only when the theme
 * IS a shipped built-in (OLED/Goose, see builtinId) — every token with a `webPin` for that built-in gets the pinned
 * colour (what the web paints today, until its parity fix). Pins replace final values only; they never apply to
 * other themes or on the desktop. `pinned` lists the replaced token ids. Never throws for bad input.
 */
export function resolveForApp(theme: unknown, tokensSpec: unknown, app: App): AppResolveResult {
  try {
    if (app !== "desktop" && app !== "web") refuse("bad-app", "must be desktop or web");
    const spec = parseTokensSpec(tokensSpec);
    const r = resolve(theme, tokensSpec, spec);
    const pinned: string[] = [];
    const bid = app === "web" ? builtinId(theme) : null;
    if (bid) {
      for (const id of spec.ids) {
        const pin = spec.webPins.get(id)?.get(bid);
        if (!pin) continue;
        r.tokens[id] = formatColour(pin);
        pinned.push(id);
      }
    }
    return { ...r, pinned };
  } catch (x) {
    if (x instanceof Refusal) return { ok: false, error: `${x.code}: ${x.detail}` };
    throw x;
  }
}
