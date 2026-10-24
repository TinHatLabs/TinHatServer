// rows.ts — the default rows of the layout presets (default-rows.json, ACTIONS.md §9.8) and where a row's value comes
// from: the layout's opts.<island>.rows.<row> when present, else the preset's default row (classic when the preset is
// unknown). A `buttons:<n>` island has no default row (it starts empty).
import DEFAULT_ROWS_JSON from "./default-rows.json" with { type: "json" };
import type { Json } from "../layout/json";
import { clone, get, isObj } from "../layout/json";

const DEFAULT_ROWS = clone(DEFAULT_ROWS_JSON as unknown as Json);

/** The default row value of a preset / form / island kind / row id, or null. */
export function defaultRowValue(island: string, row: string, form: "desktop" | "phone" = "desktop", preset = "classic"): Json | null {
  const presets = get(DEFAULT_ROWS as never, "presets");
  const p = isObj(presets) ? (get(presets, preset) ?? get(presets, "classic")) : undefined;
  const f = isObj(p) ? get(p, form) : undefined;
  const opts = isObj(f) ? get(f, "opts") : undefined;
  const isl = isObj(opts) ? get(opts, island.split(":")[0]) : undefined;
  const rows = isObj(isl) ? get(isl, "rows") : undefined;
  const r = isObj(rows) ? get(rows, row) : undefined;
  return r === undefined ? null : r;
}

/** The value a row draws: the stored row (opts.<ref>.rows.<row>) if the layout has one, else the default. */
export function rowValue(opts: Json | undefined, islandRef: string, row: string, form: "desktop" | "phone" = "desktop", preset = "classic"): Json | null {
  const o = isObj(opts) ? get(opts, islandRef) : undefined;
  const rows = isObj(o) ? get(o, "rows") : undefined;
  const stored = isObj(rows) ? get(rows, row) : undefined;
  if (stored !== undefined) return stored;
  return defaultRowValue(islandRef, row, form, preset);
}

/** The row kind of opts.<ref>.rows.<row> (ACTIONS.md §9.2): the ref's island kind + "." + row. */
export function rowKindOf(islandRef: string, row: string): string {
  return `${islandRef.split(":")[0]}.${row}`;
}
