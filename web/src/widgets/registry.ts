// registry.ts — the widget registry (contract widgets.json, byte-identical in both apps; WIDGETS.md §2) and the widget
// list a layout holds (LAYOUT.md §3.9 opts.widgets: `{w, size?, settings?}` + `collapsed?`; the local pref until the
// dock host's synced layout document carries it). Pure: no DOM, no React.
import REGISTRY_JSON from "./widgets.json" with { type: "json" };

export type WidgetSize = "S" | "M" | "L";
export const SIZES: readonly WidgetSize[] = ["S", "M", "L"];

export interface IntSetting {
  id: string;
  type: "int";
  label: string;
  unit?: string;
  min: number;
  max: number;
  default: number;
}
export interface BoolSetting {
  id: string;
  type: "bool";
  label: string;
  default: boolean;
}
export type WidgetSetting = IntSetting | BoolSetting;

export interface WidgetDef {
  id: string;
  title: string;
  /** icon-pack / freedesktop icon name */
  icon: string;
  description: string;
  sizes: WidgetSize[];
  default: WidgetSize;
  /** body height caps at 1× scale (px); content decides below them */
  maxH: Partial<Record<WidgetSize, number>>;
  settings: WidgetSetting[];
  /** the data it reads (informational; the plugin mount point later) */
  data: string[];
  /** "event" = on data change only, "<n>s" = a poll period */
  refresh: { focused: string; unfocused: string };
  /** the one-shot motions it may play (the GPU gate drives each) */
  motions: string[];
  phone: boolean;
}
export interface WidgetRegistry {
  format: "tinhat-widgets";
  v: number;
  defaults: string[];
  widgets: WidgetDef[];
}

export const REGISTRY = REGISTRY_JSON as unknown as WidgetRegistry;

export function widgetDef(id: string): WidgetDef | undefined {
  return REGISTRY.widgets.find((w) => w.id === id);
}

/** A refresh value in ms (0 = on data change only). */
export function refreshMs(v: string): number {
  const m = /^([0-9]+)s$/.exec(v);
  return m ? Number(m[1]) * 1000 : 0;
}

// ---- the widget list ------------------------------------------------------------------------------------------------

export interface WidgetItem {
  /** widget id (unknown ids are kept: "Needs a newer Tin Hat") */
  w: string;
  size?: WidgetSize;
  settings?: Record<string, unknown>;
  /** folded to its header by the user (click on the header) */
  collapsed?: boolean;
  /** unknown keys of newer versions are kept */
  [k: string]: unknown;
}

export const MAX_WIDGETS = 12;
const W_ID = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A stored widget list, repaired like LAYOUT.md §5.5 (opts.widgets). Returns null when `value` is not an array (the
 * caller decides: no stored list yet → the defaults). Items that are not objects with a valid `w` are dropped; a bad
 * `size` / `settings` (not an object, or > 16 keys) / `collapsed` (not a boolean) is dropped from its item; a second
 * item of the same `w` is dropped (one instance per widget in v1 — the layout repair keeps duplicates, so the widget
 * host shows the first one only); at most 12 items. Unknown keys stay.
 */
export function normalizeItems(value: unknown): WidgetItem[] | null {
  if (!Array.isArray(value)) return null;
  const out: WidgetItem[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (!isObj(v) || typeof v.w !== "string" || !W_ID.test(v.w) || seen.has(v.w)) continue;
    const it: WidgetItem = { ...v, w: v.w };
    if ("size" in it && !SIZES.includes(it.size as WidgetSize)) delete it.size;
    if ("settings" in it && !(isObj(it.settings) && Object.keys(it.settings).length <= 16)) delete it.settings;
    if ("collapsed" in it && typeof it.collapsed !== "boolean") delete it.collapsed;
    seen.add(v.w);
    out.push(it);
    if (out.length >= MAX_WIDGETS) break;
  }
  return out;
}

/** The list a new user starts with: every default widget at its default size. */
export function defaultItems(): WidgetItem[] {
  return REGISTRY.defaults.filter((id) => widgetDef(id)).map((w) => ({ w }));
}

/** The size an item renders at: its own when the widget offers it, else the widget's default ("M" for unknown ids). */
export function sizeOf(item: WidgetItem): WidgetSize {
  const def = widgetDef(item.w);
  if (!def) return "M";
  return item.size && def.sizes.includes(item.size) ? item.size : def.default;
}

/** The settings an item runs with: every declared setting, its stored value when valid (ints floored + clamped to
 *  [min, max], bools as booleans), else the default. */
export function settingsOf(item: WidgetItem): Record<string, number | boolean> {
  const def = widgetDef(item.w);
  const out: Record<string, number | boolean> = {};
  if (!def) return out;
  const stored = isObj(item.settings) ? item.settings : {};
  for (const s of def.settings) {
    const v = Object.prototype.hasOwnProperty.call(stored, s.id) ? stored[s.id] : undefined;
    if (s.type === "int") out[s.id] = typeof v === "number" && Number.isFinite(v) ? Math.max(s.min, Math.min(s.max, Math.floor(v))) : s.default;
    else out[s.id] = typeof v === "boolean" ? v : s.default;
  }
  return out;
}
