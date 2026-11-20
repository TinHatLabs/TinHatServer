// personal.ts — P22 (12.1.17): the text size and the density are PERSONAL settings layered over the theme, never stored
// in it. Before 12.1.17 they lived in the theme document (`type.size`, `shape.density`), so switching theme changed your
// size. Now:
//  * the person's own prefs `text-size` (one of TEXT_SIZES) and `density` (a Density id) decide the size and the density
//    on every theme (effectiveLook); a theme's own `type.size` / `shape.density` are ignored;
//  * once, the first time an app with this module starts (migrate), the ACTIVE theme's old size and density become the
//    person's default (the size snapped to the nearest step), so nobody's text jumps on the update;
//  * density is drawn: row() is the height of a list row (room list rows, menu items) for a base height, the text size
//    and the density; line() is a line height scaled by the text size. Integer maths only: both apps get the same px.
// This file is the REFERENCE; the desktop's twin is crates/theme/src/personal.rs. Both run testvectors/personal/*.json
// (byte-identical in both repos; personal.test.ts here, tests/personal.rs there).
// NO value imports except ./look (node unit tests load it through tools/modular/register.mjs).

import { readLook, type Density, type Look } from "./look";

/** The text sizes a person can pick, in per cent of the app's normal size. */
export const TEXT_SIZES: readonly number[] = [90, 100, 110, 125, 150];
export const DEFAULT_TEXT_SIZE = 100;
export const DEFAULT_DENSITY: Density = "normal";

/** The pref keys (web: `tinhat.pref.<key>`; desktop: the `ui-<key>` files). */
export const PREF_TEXT_SIZE = "text-size";
export const PREF_DENSITY = "density";
/** Set to "1" once migrate() has run on this device. */
export const PREF_MIGRATED = "look-personal";

/** The words on screen for each density (both apps show exactly these). */
export function densityLabel(d: Density): string {
  return d === "compact" ? "Compact" : d === "normal" ? "Cozy" : "Comfortable";
}

/** A stored `text-size` pref: exactly the decimal text of one of TEXT_SIZES ("125"); anything else → null. */
export function parseTextSize(pref: string | null | undefined): number | null {
  if (typeof pref !== "string") return null;
  for (const n of TEXT_SIZES) if (String(n) === pref) return n;
  return null;
}

/** A stored `density` pref: exactly `compact` / `normal` / `touch`; anything else → null. */
export function parseDensity(pref: string | null | undefined): Density | null {
  return pref === "compact" || pref === "normal" || pref === "touch" ? pref : null;
}

/** The step nearest to a per-cent size; a tie goes to the LARGER step (readability first). */
export function snapTextSize(n: number): number {
  let best = TEXT_SIZES[0];
  for (const s of TEXT_SIZES) {
    const d = Math.abs(s - n), bd = Math.abs(best - n);
    if (d < bd || (d === bd && s > best)) best = s;
  }
  return best;
}

/** The person's size and density (from the prefs; defaults for a missing or bad pref). */
export interface Personal {
  size: number;
  density: Density;
}

export function readPersonal(textSize: string | null | undefined, density: string | null | undefined): Personal {
  return { size: parseTextSize(textSize) ?? DEFAULT_TEXT_SIZE, density: parseDensity(density) ?? DEFAULT_DENSITY };
}

/** The look an app draws: the theme's fonts and shadow, the PERSON's size and density. */
export function effectiveLook(theme: unknown, p: Personal): Look {
  return { ...readLook(theme), size: p.size, density: p.density };
}

/** What migrate() writes: [key, value] pairs, in this order; empty = nothing to do. */
export type PrefWrites = [string, string][];

/**
 * The one-time move of a theme's size and density into the person's prefs. Already migrated → nothing. Otherwise: a
 * missing or bad `text-size` pref takes the theme's old size, snapped to a step, and a missing or bad `density` pref
 * takes the theme's old density — each written only when it is not the default — and the marker is written last. A
 * valid pref the person already has is never overwritten.
 */
export function migrate(
  migrated: string | null | undefined,
  textSize: string | null | undefined,
  density: string | null | undefined,
  activeTheme: unknown,
): PrefWrites {
  if (migrated === "1") return [];
  const old = readLook(activeTheme);
  const out: PrefWrites = [];
  if (parseTextSize(textSize) === null) {
    const s = snapTextSize(old.size);
    if (s !== DEFAULT_TEXT_SIZE) out.push([PREF_TEXT_SIZE, String(s)]);
  }
  if (parseDensity(density) === null && old.density !== DEFAULT_DENSITY) out.push([PREF_DENSITY, old.density]);
  out.push([PREF_MIGRATED, "1"]);
  return out;
}

/** round(n × num / den) for non-negative integers, halves up (the same integer on both apps). */
function mulDivRound(n: number, num: number, den: number): number {
  return Math.floor((2 * n * num + den) / (2 * den));
}

/** A line height (or any type-driven length) of `base` px at the text size `size` (per cent), rounded to a whole px. */
export function line(base: number, size: number): number {
  return mulDivRound(base, size, 100);
}

/** How much a density adds to a row (layout px) and the least a row may be. */
export function densityDelta(d: Density): number {
  return d === "compact" ? -8 : d === "normal" ? 0 : 8;
}
export function densityMinRow(d: Density): number {
  return d === "compact" ? 24 : d === "normal" ? 28 : 44;
}

/**
 * The height of a list row whose design height is `base` px at 100 % / Cozy: grown with the text size, then the
 * density's step, never under the density's minimum (Comfortable keeps a 44 px touch target). At 100 % and Cozy it is
 * `base` itself for every base ≥ 28, so the default look is pixel-identical to before.
 */
export function row(base: number, size: number, d: Density): number {
  return Math.max(line(base, size) + densityDelta(d), densityMinRow(d));
}

/** The space between groups (chat messages from different senders) whose design value is `base` px at Cozy: Compact
 *  halves it (rounded down), Comfortable doubles it. */
export function gap(base: number, d: Density): number {
  return d === "compact" ? Math.floor(base / 2) : d === "normal" ? base : base * 2;
}

/** The density drawn: the layout form's own `density` when it names one (the Handheld preset sets `touch`; LAYOUT.md
 *  form field, any non-string or unknown value = none), else the person's. */
export function effectiveDensity(person: Density, layout: unknown): Density {
  return parseDensity(typeof layout === "string" ? layout : null) ?? person;
}
