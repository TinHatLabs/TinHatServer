// themes.ts — the theme runtime (Tin Hat modular UI: step 1a C1, step 1b any theme).
//
// A theme is resolved by the colour engine (src/theme: resolveForApp(theme, tokens, "web")) into every role and
// element token of the colour catalogue (src/theme/tokens.json → the compact runtime spec tokenSpec.gen.json).
// applyThemeDoc() writes each one as the CSS custom property `--th-<id>` (themeNames.ts varName: dots → dashes,
// lowerCamel → kebab) on <html>. tokens.css carries the same variables statically with the OLED values so CSS works
// before the bundle runs. JS colour maths (canvas, computed inline colours) read the SAME values through
// themeColours() / useThemeColours() — never from literals. How to use all this: src/theme/MIGRATING.md.
//
// WHICH theme is shown is decided by the theme store (themeStore.ts: the device override → the account's choice
// `dev.tinhat.theme` → the device's 10.x theme; THEMES-SYNC.md); this file only resolves and paints a theme document.
// <html data-theme="<id>" data-variant="dark|light">, `color-scheme` + <meta name="theme-color"> follow the theme, and
// for a theme that is not a built-in the boot page's variables are cached (pref `theme-boot`) so index.html paints the
// next start right before the bundle runs.
import { useCallback, useSyncExternalStore } from "react";
import { BUILTINS, ROLE_IDS, formatColour, parseLiteral, resolveForApp, type NamesMode, type Theme, type TokensSpec, type Variant } from "../theme/engine";
import { guardC } from "../theme/ops";
import { readLook } from "../theme/look";
import { readShape, type Shape } from "../theme/shape";
import { canonJson } from "../theme/canon";
import { setPrefRaw } from "../core/prefs";
import { hslLightness, qtHsla } from "./color";
import { cssColour, varName, varRef } from "./themeNames";
import { BOOT_IDS, FLOAT_ALPHA_IDS, type ThemeColourId } from "./themeVars.gen";
import tokenSpec from "./tokenSpec.gen.json" with { type: "json" };

export type { RoleId, ThemeColourId, TokenId } from "./themeVars.gen";

/** A theme's id (the built-ins "oled" / "goose", a library theme, one of My themes). */
export type ThemeName = string;
/** The shipped built-ins. */
export const THEME_NAMES: ThemeName[] = ["oled", "goose"];

/** The 10.x rule for a saved theme name: "goose" is Goose, anything else OLED (bridge.rs read_saved_theme). */
export function normalizeTheme(name: string | null | undefined): "oled" | "goose" {
  return name === "goose" ? "goose" : "oled";
}

/** A resolved theme for the web: every role and element token as a CSS colour. */
export interface ThemeColours {
  /** the theme's id */
  readonly theme: ThemeName;
  /** its display name ("OLED", "Catppuccin Latte") */
  readonly name: string;
  readonly author: string | null;
  readonly variant: Variant;
  /** people's name colours: "hash-hsl" (today's algorithm, senderColor) or "palette" (the name.1…12 roles) */
  readonly names: NamesMode;
  /** the guarded roles the readability guard changed (ENGINE §5) — "N colours adjusted for readability" */
  readonly adjusted: readonly string[];
  /** role / token id → CSS colour ("#rrggbb", "rgba(r, g, b, a)", or "rgb(r g b / a)" for the FLOAT_ALPHA_IDS —
   *  themeNames.ts cssColour) — exactly what its `--th-*` variable holds */
  readonly colour: Readonly<Record<ThemeColourId, string>>;
  /** the document that was resolved */
  readonly doc: Theme;
  /** true for a shipped built-in exactly as shipped (roles-only, never guarded: its content colours stay as they are) */
  readonly builtin: boolean;
}

const SPEC = tokenSpec as unknown as TokensSpec;
/** the engine's canonical colour text (`#rrggbb`, `#rrggbb/A`) of every role and token of a resolved theme */
const canonOf = new WeakMap<ThemeColours, Readonly<Record<string, string>>>();
/** resolved documents, keyed by their canonical text (a built-in and a library theme resolve once per session) */
const resolvedByText = new Map<string, ThemeColours>();

/** The engine's canonical colours of a resolved theme, split into roles and tokens (the theme editor's readability
 *  checks, THEMES-UI.md §13.5). */
export function canonicalColours(t: ThemeColours): { roles: Record<string, string>; tokens: Record<string, string> } {
  const all = canonOf.get(t) ?? {};
  const roles: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const [id, c] of Object.entries(all)) (ROLE_SET_RT.has(id) ? roles : tokens)[id] = c;
  return { roles, tokens };
}
const ROLE_SET_RT: ReadonlySet<string> = new Set(ROLE_IDS);

/** Resolve a theme document for the web (engine refusal → { error }). Cached: the same object for the same document. */
export function resolveColours(doc: Theme): ThemeColours | { error: string } {
  const text = canonJson(doc);
  const hit = resolvedByText.get(text);
  if (hit) return hit;
  const r = resolveForApp(doc, SPEC, "web");
  if (!r.ok) return { error: r.error };
  const colour: Record<string, string> = {};
  for (const [id, c] of Object.entries(r.roles)) colour[id] = cssColour(c, FLOAT_ALPHA_IDS.has(id));
  for (const [id, c] of Object.entries(r.tokens)) colour[id] = cssColour(c, FLOAT_ALPHA_IDS.has(id));
  const t: ThemeColours = Object.freeze({
    theme: doc.id,
    name: doc.name,
    author: typeof doc.author === "string" && doc.author.trim() ? doc.author : null,
    variant: r.variant,
    names: r.names,
    adjusted: Object.freeze([...r.adjusted]),
    colour: Object.freeze(colour) as Readonly<Record<ThemeColourId, string>>,
    doc,
    builtin: Object.prototype.hasOwnProperty.call(BUILTINS, doc.id) && canonJson(BUILTINS[doc.id]) === text,
  });
  canonOf.set(t, Object.freeze({ ...r.roles, ...r.tokens }));
  if (resolvedByText.size > 64) resolvedByText.clear(); // gallery browsing: never grows without bound
  resolvedByText.set(text, t);
  return t;
}

function builtinColours(name: string): ThemeColours {
  const r = resolveColours(BUILTINS[name] ?? BUILTINS.oled);
  if ("error" in r) throw new Error(`theme ${name}: ${r.error}`); // never for the shipped built-ins (unit-tested)
  return r;
}

/**
 * The resolved colours of a built-in theme by id, or of the active theme (no argument, or the active theme's id).
 * Any other id → the active theme's (a library theme is resolved from its document: resolveColours).
 */
export function themeColours(name?: ThemeName): ThemeColours {
  if (name === undefined || name === activeColours.theme) return activeColours;
  if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) return builtinColours(name);
  return activeColours;
}

/** React: the active theme's resolved colours (re-renders on a theme change; the same object per theme). */
export function useThemeColours(): ThemeColours {
  return useSyncExternalStore(subscribeTheme, activeSnapshot, activeSnapshot);
}

/** `var(--th-<id>)` of a role or element token — the type-checked way to put a theme colour in an inline style. */
export function cssVar(id: ThemeColourId): string {
  return varRef(id);
}

const varSets = new WeakMap<ThemeColours, Readonly<Record<string, string>>>();

/**
 * Every colour variable of a theme with its literal value: `--th-<id>` for each role and element token. Literal values
 * (not var() chains), so the set also re-themes a SUBTREE (the UI gallery's per-theme columns, a preview).
 */
export function themeVars(theme: ThemeName | ThemeColours): Readonly<Record<string, string>> {
  const t = typeof theme === "string" ? themeColours(theme) : theme;
  let v = varSets.get(t);
  if (!v) {
    const out: Record<string, string> = {};
    for (const [id, c] of Object.entries(t.colour)) out[varName(id)] = c;
    v = Object.freeze(out);
    varSets.set(t, v);
  }
  return v;
}

/**
 * Sender name colour. `names: "hash-hsl"` (OLED, Goose — AppCore.qml senderColor): the avatar's hue band, lighter on
 * dark themes. `names: "palette"` (THEMES-UI.md §10.1): name.((hash31 mod 12) + 1) of the theme.
 */
export function senderColor(mxid: string, theme?: ThemeName): string {
  const t = themeColours(theme);
  const h = hash31(mxid || "");
  if (t.names === "palette") return t.colour[`name.${(h % 12) + 1}` as ThemeColourId];
  const dark = hslLightness(t.colour["surface.window"]) < 0.5;
  const pick = h % 100;
  const hue = pick < 80 ? 0.02 + (h % 56) / 360 : 0.45 + (h % 22) / 360;
  return qtHsla(hue, 0.6, dark ? 0.7 : 0.42, 1);
}

/** The `(h * 31 + c) >>> 0` string hash shared by Avatar.qml and senderColor. */
export function hash31(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}

/** The surfaces a content colour is guarded against by default: the two text-bearing surfaces (THEMES-UI.md §10.2). */
const CONTENT_SURFACES: readonly ThemeColourId[] = ["surface.island", "surface.window"];
const inkCache = new WeakMap<ThemeColours, Map<string, string>>();

/**
 * THEMES-UI.md §10.2 (HAZARDS H11): a CONTENT colour — a role or tag colour, a custom status colour, an event or game
 * colour: chosen by a person or by data, never a token — drawn as TEXT on a themed surface goes through the engine's
 * readability guard (ENGINE §3 `guard`): nudged lighter or darker until it reads 4.5:1 (`glyph`: dots, rings and glyphs,
 * 3:1) on `surface.island` and then on `surface.window` (or the surfaces given), so it passes on both. Palette themes
 * only: roles-only themes (OLED, Goose) paint content colours exactly as they are. Anything that is not a colour literal
 * (`#rgb`, `#rrggbb`, `#rrggbbaa`; a `var(--th-…)` fallback) is returned as it is. The result is CSS.
 */
export function contentInk(colour: string, opts: { glyph?: boolean; on?: readonly ThemeColourId[] } = {}, theme?: ThemeColours): string {
  const t = theme ?? activeColours;
  if (!colour || t.doc.palette === undefined) return colour;
  const on = opts.on ?? CONTENT_SURFACES;
  const n = opts.glyph ? 3 : 4.5;
  let memo = inkCache.get(t);
  if (!memo) inkCache.set(t, (memo = new Map()));
  const key = `${colour}\u0000${n}\u0000${on.join(",")}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const c = parseLiteral(colour.trim().toLowerCase());
  const canon = canonOf.get(t);
  let css = colour;
  if (c && canon) {
    let out = c;
    for (const id of on) {
      const bg = parseLiteral(canon[id] ?? "");
      if (bg) out = guardC(out, bg, n);
    }
    css = cssColour(formatColour(out));
  }
  if (memo.size > 512) memo.clear();
  memo.set(key, css);
  return css;
}

/** React: contentInk bound to the active theme (the component re-renders when the theme changes). */
export function useContentInk(): (colour: string, opts?: { glyph?: boolean; on?: readonly ThemeColourId[] }) => string {
  const t = useThemeColours();
  return useCallback((colour: string, opts?: { glyph?: boolean; on?: readonly ThemeColourId[] }) => contentInk(colour, opts, t), [t]);
}

/** Localpart of an mxid ("@bob:server" → "bob"), FallbackTheme.localpart. */
export function localpart(s: string | null | undefined): string {
  return s ? String(s).replace(/^@/, "").split(":")[0] : "";
}

// ---- runtime application ---------------------------------------------------------------------------------------

let activeColours: ThemeColours = builtinColours("oled");
let onDocument: ThemeColours | null = null;
const listeners = new Set<() => void>();
const activeSnapshot = () => activeColours;

/** The active theme's id. */
export function currentTheme(): ThemeName {
  return activeColours.theme;
}
/** The active theme's resolved colours. */
export function currentColours(): ThemeColours {
  return activeColours;
}

/**
 * Paint a theme: every colour variable on <html>, data-theme / data-variant, `color-scheme`, the browser chrome
 * colour, the look (fonts, text size: ENGINE.md §10) and (not a built-in) the boot page's cache. Refused by the engine
 * → nothing changes, the error is returned. `boot: false` (a preview — the theme editor, Try: THEMES-UI.md §13.4)
 * leaves the boot cache alone: nothing about a preview outlives it.
 */
export function applyThemeDoc(doc: Theme, opts: { boot?: boolean } = {}): ThemeColours | { error: string } {
  const r = resolveColours(doc);
  if ("error" in r) return r;
  paint(r, opts.boot !== false);
  return r;
}

/** The family stack of a look font (ENGINE.md §10): the family first, then the app's own stack. */
const FONT_STACK = `"Noto Sans", system-ui, "Segoe UI", sans-serif`;
const quoteFamily = (f: string) => `"${f.replace(/["\\]/g, "")}"`;

function paint(t: ThemeColours, boot = true): void {
  if (typeof document !== "undefined" && onDocument !== t) {
    const root = document.documentElement;
    root.dataset.theme = t.theme;
    root.dataset.variant = t.variant;
    // only the variables that change (a theme editor drag repaints a few of the 1,500+)
    const before = onDocument ? themeVars(onDocument) : null;
    for (const [k, val] of Object.entries(themeVars(t))) if (!before || before[k] !== val) root.style.setProperty(k, val);
    root.style.colorScheme = t.variant;
    // ENGINE.md §10: the look — fonts from the allowed lists, the text size (tokens.css scales every type size by it)
    // (an empty value removes the inline declaration: tokens.css's default comes back)
    const look = readLook(t.doc);
    const chat = look.fonts.chat ?? look.fonts.ui;
    root.style.setProperty("--th-font", look.fonts.ui ? `${quoteFamily(look.fonts.ui)}, ${FONT_STACK}` : "");
    root.style.setProperty("--th-font-chat", chat ? quoteFamily(chat) : "");
    root.style.setProperty("--th-font-mono", look.fonts.code ? `${quoteFamily(look.fonts.code)}, monospace` : "");
    root.style.setProperty("--th-text-scale", look.size !== 100 ? String(look.size / 100) : "");
    // 11.0 (ISLANDS-ARCH §3.4): the theme's shape block — island radius, gap, margin, border (theme/shape.ts)
    const sh = readShape(t.doc);
    root.style.setProperty("--th-shape-radius", `${sh.radius}px`);
    root.style.setProperty("--th-shape-gap", `${sh.gap}px`);
    root.style.setProperty("--th-shape-margin", `${sh.margin}px`);
    root.style.setProperty("--th-shape-border", `${sh.border}px`);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t.colour["window.bg"]);
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute("content", t.variant);
    onDocument = t;
    if (boot) cacheBoot(t);
  }
  if (t !== activeColours) {
    activeColours = t;
    for (const l of listeners) l();
  }
}

/** The active theme's shape block (island radius, gap, margin, border in layout px) — the dock host's `shape`. */
export function useShape(): Shape {
  const t = useThemeColours();
  return shapeOf(t);
}
const shapes = new WeakMap<ThemeColours, Shape>();
function shapeOf(t: ThemeColours): Shape {
  let sh = shapes.get(t);
  if (!sh) {
    sh = readShape(t.doc);
    shapes.set(t, sh);
  }
  return sh;
}

/** index.html's boot script reads pref `theme-boot` = {id, variant, vars} for a theme that is not a built-in. */
function cacheBoot(t: ThemeColours): void {
  try {
    if (t.builtin) {
      setPrefRaw("theme-boot", null);
      return;
    }
    const vars: Record<string, string> = {};
    for (const id of BOOT_IDS) vars[varName(id)] = t.colour[id];
    setPrefRaw("theme-boot", JSON.stringify({ id: t.theme, variant: t.variant, vars }));
  } catch {
    /* storage full / blocked: the boot page shows OLED for a moment, nothing else */
  }
}

/** Paint a BUILT-IN by id ("goose" → Goose, anything else → OLED) — the 10.x entry point (tests, fallbacks). */
export function applyTheme(name: string): ThemeName {
  paint(builtinColours(normalizeTheme(name)));
  return activeColours.theme;
}

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React: the active theme's id (re-renders on theme change). */
export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);
}

// ---- reduce motion + the motion switch: ui/motion.ts (GPU.md §1) -------------------------------------------
// (re-exported here: themes.ts was their home before the low-GPU contract; `durMs()` is now 0 whenever the motion
// switch is off — unfocused, hidden or Reduce motion — not only under Reduce motion)
export { applyReducedMotion, reducedMotion, useReducedMotion, durMs } from "./motion";
