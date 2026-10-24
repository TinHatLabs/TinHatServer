// look.ts — the non-colour look of a theme beyond `shape.radius/gap/margin/border` (shape.ts): the island shadow, the
// density and the type block (fonts from an allowed list, a text size) — ENGINE.md §10 (step 5, the theme editor).
// The desktop's twin is crates/theme/src/look.rs (the same rules, the same test names in tests/look.rs).
//
// Like shape.ts: a theme without a field gets the default; a value that is not exactly what the rule allows is ignored
// (the default stays), never clamped or guessed — so a shared theme can only name fonts from the list below and can
// never produce a size or density no other client would draw. Keys this reader does not know stay in the document.
// NO value imports (node unit tests load it directly).

export type Density = "compact" | "normal" | "touch";
export const DENSITIES: readonly Density[] = ["compact", "normal", "touch"];

export interface Look {
  /** island shadow blur radius in layout px (0 = none), painted in the `island.shadow` colour */
  shadow: number;
  density: Density;
  /** font family names from the allowed lists; null = the app's own font for that slot */
  fonts: { ui: string | null; chat: string | null; code: string | null };
  /** text size in per cent of the app's normal size */
  size: number;
}

export const LOOK_DEFAULTS: Readonly<Look> = Object.freeze({
  shadow: 0,
  density: "normal",
  fonts: Object.freeze({ ui: null, chat: null, code: null }),
  size: 100,
}) as Readonly<Look>;

export const SHADOW_BOUNDS: readonly [number, number] = [0, 24];
export const SIZE_BOUNDS: readonly [number, number] = [80, 150];

/** Interface and chat fonts (ENGINE.md §10): sans-serif families, then serif families. Exact, case-sensitive names. */
export const FONTS_SANS: readonly string[] = [
  "Noto Sans", "Inter", "Roboto", "Open Sans", "Lato", "Source Sans 3", "IBM Plex Sans", "Fira Sans", "Ubuntu",
  "Cantarell", "DejaVu Sans", "Liberation Sans", "Atkinson Hyperlegible", "Lexend", "Nunito", "Segoe UI", "Arial",
  "Verdana",
];
export const FONTS_SERIF: readonly string[] = [
  "Noto Serif", "Source Serif 4", "IBM Plex Serif", "Merriweather", "Literata", "DejaVu Serif", "Liberation Serif",
  "Georgia",
];
/** Code fonts. */
export const FONTS_MONO: readonly string[] = [
  "Noto Sans Mono", "JetBrains Mono", "Fira Code", "Fira Mono", "Source Code Pro", "IBM Plex Mono", "Cascadia Code",
  "Cascadia Mono", "Hack", "Iosevka", "Inconsolata", "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", "Consolas",
  "Menlo",
];
export type FontSlot = "ui" | "chat" | "code";
export const FONT_SLOTS: readonly FontSlot[] = ["ui", "chat", "code"];

/** The families a slot may name: ui / chat → sans then serif; code → mono. */
export function fontsFor(slot: FontSlot): readonly string[] {
  return slot === "code" ? FONTS_MONO : [...FONTS_SANS, ...FONTS_SERIF];
}
export function isAllowedFont(slot: string, family: unknown): boolean {
  if (slot !== "ui" && slot !== "chat" && slot !== "code") return false;
  return typeof family === "string" && fontsFor(slot).includes(family);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** The look of a theme document (any value; never throws). */
export function readLook(theme: unknown): Look {
  const out: Look = { shadow: LOOK_DEFAULTS.shadow, density: LOOK_DEFAULTS.density, fonts: { ui: null, chat: null, code: null }, size: LOOK_DEFAULTS.size };
  if (!isObj(theme)) return out;
  const shape = own(theme, "shape");
  if (isObj(shape)) {
    const sh = own(shape, "shadow");
    if (intIn(sh, SHADOW_BOUNDS[0], SHADOW_BOUNDS[1])) out.shadow = sh;
    const d = own(shape, "density");
    if (typeof d === "string" && (DENSITIES as readonly string[]).includes(d)) out.density = d as Density;
  }
  const type = own(theme, "type");
  if (isObj(type)) {
    for (const slot of FONT_SLOTS) {
      const f = own(type, slot);
      if (isAllowedFont(slot, f)) out.fonts[slot] = f as string;
    }
    const size = own(type, "size");
    if (intIn(size, SIZE_BOUNDS[0], SIZE_BOUNDS[1])) out.size = size;
  }
  return out;
}

/** `{"density":…,"fonts":{"chat":…,"code":…,"ui":…},"shadow":…,"size":…}` (keys sorted) — what the desktop hands to QML. */
export function lookJson(l: Look): string {
  const q = (v: string | null) => (v === null ? "null" : JSON.stringify(v));
  return `{"density":${JSON.stringify(l.density)},"fonts":{"chat":${q(l.fonts.chat)},"code":${q(l.fonts.code)},"ui":${q(l.fonts.ui)}},"shadow":${l.shadow},"size":${l.size}}`;
}
