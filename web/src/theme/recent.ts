// recent.ts — the ☰ Theme menu's recent themes (THEMES-UI.md §12). The desktop's Rust port is crates/theme/src/recent.rs
// (tinhat_theme::recent), with the same unit-test case names (recent.test.ts ↔ crates/theme/tests/recent.rs).
//
// Per device, never synced: web pref `theme-recent` (localStorage tinhat.pref.theme-recent), desktop the ui pref file
// `ui-theme-recent` — the JSON text of an array of theme ids, most recent first, at most RECENT_MAX, no repeats.
// Pure: data in, data out (the stores do the reading, the writing and the "does this theme still exist" lookups).

import { isThemeId } from "./limits";

/** How many themes the menu lists (and the history keeps). */
export const RECENT_MAX = 5;

/** What the list starts from before there is any history: the theme on screen, then these two built-ins. */
export const RECENT_SEED: readonly string[] = ["oled", "goose"];

/** Can the menu offer this theme — a library theme (OLED and Goose included) or one of My themes the engine accepts. */
export type ThemeExists = (id: string) => boolean;

/** Theme ids only, first occurrence wins, those `keep` accepts, at most RECENT_MAX — the shape of every list here. */
function tidy(ids: readonly unknown[], keep: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const x of ids) {
    if (out.length === RECENT_MAX) break;
    if (typeof x !== "string" || !isThemeId(x) || out.includes(x) || !keep(x)) continue;
    out.push(x);
  }
  return out;
}

/**
 * The stored text → the history, most recent first. Anything that is not the JSON text of an array reads as no history;
 * entries that are not theme ids are skipped, repeats dropped, at most RECENT_MAX kept.
 */
export function readRecent(text: string | null | undefined): string[] {
  if (typeof text !== "string") return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(v) ? tidy(v, () => true) : [];
}

/** The history as it is stored: compact JSON (`["nord","oled","goose"]`). */
export function writeRecent(list: readonly string[]): string {
  return JSON.stringify(tidy(list, () => true));
}

/** The list a menu or a pick starts from: the history's themes that still exist, or — none left — the seed:
 *  `shown` (the theme on screen), OLED, Goose. */
function startList(history: readonly string[], shown: string, exists: ThemeExists): string[] {
  const known = tidy(history, exists);
  return known.length > 0 ? known : tidy([shown, ...RECENT_SEED], (id) => id === shown || exists(id));
}

/**
 * The history after a pick: a person applied `picked` on this device while `shown` was on screen (a ☰ Theme row, a
 * card, My themes → Use, import "Save and use", Undo, "Keep ‹old› here"). `picked` goes first, then the start list
 * (the history, or the seed when there is none); themes that no longer exist are dropped; no repeats; at most 5.
 */
export function recordPick(history: readonly string[], shown: string, picked: string, exists: ThemeExists): string[] {
  return tidy([picked, ...startList(history, shown, exists)], (id) => id === picked || exists(id));
}

/**
 * The menu's rows (theme ids, top to bottom; the menu checks `current`): the start list for the theme on screen, with
 * `current` put first when it is not in it (a theme chosen on another device is shown, but is not a pick); no repeats;
 * at most 5. `current` always counts as existing.
 */
export function recentMenu(history: readonly string[], current: string, exists: ThemeExists): string[] {
  const list = startList(history, current, exists);
  return tidy(list.includes(current) ? list : [current, ...list], (id) => id === current || exists(id));
}
