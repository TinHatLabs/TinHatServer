// roles.ts — the v1 role ids (NAMING.md §2), the palette slots, the readability guards and the derivation of
// every role from a terminal palette (ENGINE.md §5), written as expressions of the §3 language.
import { cmpCodePoint } from "./canon";
import type { Colour } from "./literal";
import { formatColour, parseLiteral, sameColour } from "./literal";
import { chroma } from "./maths";
import { cr } from "./ops";

/** Code-point order (= UTF-8 byte order, what Rust's str Ord / BTreeMap use). Every "sorted by id" uses it. */
export const cmpId = cmpCodePoint;

export const NAME_ROLE_SLOTS = ["c1", "c2", "c3", "c4", "c5", "c6", "c9", "c10", "c11", "c12", "c13", "c14"];

/** Every v1 role id, sorted by id (code point order). */
export const ROLE_IDS: readonly string[] = [
  "surface.window", "surface.island", "surface.raised", "surface.hover", "surface.pressed", "surface.selected",
  "surface.sunken", "surface.overlay", "scrim", "border.subtle", "border.strong", "border.focus",
  "text.primary", "text.secondary", "text.muted", "text.disabled", "text.link", "text.onAccent",
  "accent.base", "accent.bright", "accent.dim", "accent.glow",
  "state.danger", "state.dangerBright", "state.warning", "state.success", "state.info", "state.aside",
  "mention.bg", "mention.edge", "badge.bg", "badge.mention",
  "presence.online", "presence.away", "presence.busy", "presence.incall", "presence.offline",
  "call.speaking", "call.muted", "shadow",
  ...NAME_ROLE_SLOTS.map((_, i) => `name.${i + 1}`),
].sort(cmpId);

export const ROLE_SET: ReadonlySet<string> = new Set(ROLE_IDS);

/** Palette slots: the only refs besides roles inside role expressions of a palette theme. */
export const PALETTE_SLOTS: readonly string[] = [
  "bg", "fg", "cursor", "selectionBg", "selectionFg",
  ...Array.from({ length: 16 }, (_, i) => `c${i}`),
];
export const PALETTE_SET: ReadonlySet<string> = new Set(PALETTE_SLOTS);

/** The surfaces a guarded role must be readable on (§9 amendment 2026-09-27); the first one sets the direction. */
export const GUARD_SURFACES: readonly string[] = ["surface.island", "surface.window", "surface.raised", "surface.hover"];

/** The readability guards of §5: role → minimum contrast against every GUARD_SURFACES surface. */
export const GUARDS: ReadonlyMap<string, number> = new Map<string, number>([
  ["text.primary", 4.5],
  ["text.secondary", 4.5],
  ["text.muted", 3],
  ["accent.base", 3],
  ["accent.bright", 3],
  ["text.link", 4.5],
  ["state.danger", 3],
  ["state.dangerBright", 3],
  ["state.warning", 3],
  ["state.success", 3],
  ["state.info", 3],
  ["state.aside", 3],
  ["mention.edge", 3],
  ["presence.online", 3],
  ["presence.away", 3],
  ["presence.busy", 3],
  ["presence.incall", 3],
  ["presence.offline", 3],
  ["call.speaking", 3],
  ["call.muted", 3],
  // name colours are bold labels: 3.0 (ENGINE.md §9 C1); body text stays 4.5
  ...NAME_ROLE_SLOTS.map((_, i) => [`name.${i + 1}`, 3] as [string, number]),
]);

/** A parsed terminal palette (all opaque). */
export interface Palette {
  bg: Colour;
  fg: Colour;
  cursor?: Colour;
  selectionBg?: Colour;
  selectionFg?: Colour;
  ansi: Colour[]; // 16
}

export function paletteSlot(p: Palette, id: string): Colour | undefined {
  switch (id) {
    case "bg":
      return p.bg;
    case "fg":
      return p.fg;
    case "cursor":
      return p.cursor;
    case "selectionBg":
      return p.selectionBg;
    case "selectionFg":
      return p.selectionFg;
  }
  if (id.length >= 2 && id.length <= 3 && id.charCodeAt(0) === 99 /* c */) {
    const n = id === "c0" ? 0 : /^c[1-9][0-9]?$/.test(id) ? Number(id.slice(1)) : -1;
    if (n >= 0 && n < 16) return p.ansi[n];
  }
  return undefined;
}

/** The accent field: "cursor", "c1".."c15" or a literal. Returns the slot number for cN, 0 for others, -1 invalid. */
export function accentSlot(accent: string): number {
  if (accent === "cursor") return 0;
  if (/^c([1-9]|1[0-5])$/.test(accent)) return Number(accent.slice(1));
  return parseLiteral(accent) ? 0 : -1;
}

/**
 * The derivation table of §5 for one palette theme, as expressions. `dark` is the theme's variant.
 * accent.base: the theme's `accent` (cursor | cN | literal); absent, or "cursor" without a cursor in the palette →
 * the default rule (cursor if present, ≠ fg and OKLab chroma ≥ 0.04, else c4). The accent SLOT (for accent.bright)
 * is N when accent.base is cN — including the c4 fallback — else none.
 */
export function deriveRoleExprs(p: Palette, dark: boolean, accent: string | undefined): Map<string, string> {
  let accentExpr: string;
  let slot = 0;
  if (accent === undefined || (accent === "cursor" && !p.cursor)) {
    if (p.cursor && !sameColour(p.cursor, p.fg) && chroma(p.cursor) >= 0.04) accentExpr = "cursor";
    else {
      accentExpr = "c4";
      slot = 4;
    }
  } else if (accent === "cursor") {
    accentExpr = "cursor";
  } else if (accent.charCodeAt(0) === 99 /* c */) {
    accentExpr = accent;
    slot = Number(accent.slice(1));
  } else {
    accentExpr = formatColour(parseLiteral(accent) as Colour);
  }
  const selOk = p.selectionBg !== undefined && cr(p.fg, p.selectionBg) >= 3;
  const d = new Map<string, string>([
    ["surface.island", "bg"],
    ["surface.window", dark ? "mixok(bg, #000000, 0.25)" : "mixok(bg, fg, 0.06)"],
    ["surface.raised", dark ? "mixok(bg, fg, 0.07)" : "mixok(bg, #ffffff, 0.6)"],
    ["surface.hover", "mixok(bg, fg, 0.10)"],
    ["surface.pressed", "mixok(bg, fg, 0.14)"],
    ["surface.selected", selOk ? "selectionBg" : "mixok(bg, accent.base, 0.25)"],
    ["surface.sunken", "mixok(bg, surface.window, 0.5)"],
    ["surface.overlay", "surface.raised"],
    ["scrim", dark ? "alpha(#000000, 0.5)" : "alpha(#000000, 0.3)"],
    ["border.subtle", "mixok(bg, fg, 0.13)"],
    ["border.strong", "mixok(bg, fg, 0.24)"],
    ["border.focus", "accent.bright"],
    ["text.primary", "fg"],
    ["text.secondary", "mixok(fg, bg, 0.28)"],
    ["text.muted", "mixok(fg, bg, 0.45)"],
    ["text.disabled", "mixok(fg, bg, 0.60)"],
    ["accent.base", accentExpr],
    [
      "accent.bright",
      slot >= 1 && slot <= 6 ? `c${slot + 8}` : dark ? "mixok(accent.base, #ffffff, 0.3)" : "mixok(accent.base, #000000, 0.2)",
    ],
    ["accent.dim", "alpha(accent.base, 0.18)"],
    ["accent.glow", "alpha(accent.base, 0.35)"],
    ["text.link", "accent.bright"],
    ["text.onAccent", "best(accent.base, #ffffff, bg, fg, #000000)"],
    ["state.danger", "c1"],
    ["state.dangerBright", "c9"],
    ["state.warning", "c3"],
    ["state.success", "c2"],
    ["state.info", "c6"],
    ["state.aside", "c11"],
    ["mention.bg", "alpha(state.warning, 0.10)"],
    ["mention.edge", "state.warning"],
    ["badge.bg", "accent.base"],
    ["badge.mention", "state.danger"],
    ["presence.online", "c2"],
    ["presence.away", "c3"],
    ["presence.busy", "c1"],
    ["presence.incall", "accent.bright"],
    ["presence.offline", "text.muted"],
    ["call.speaking", "state.success"],
    ["call.muted", "state.dangerBright"],
    ["shadow", "#000000"], // opaque; every shadow token applies its own alpha (ENGINE.md §5, 2026-09-26)
    ...NAME_ROLE_SLOTS.map((s, i) => [`name.${i + 1}`, s] as [string, string]),
  ]);
  return d;
}
