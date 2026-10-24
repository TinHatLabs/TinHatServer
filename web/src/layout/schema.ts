// schema.ts — the contract data of layout.schema.json (`x-tinhat`): island registry, limits, bounds, shape defaults,
// presets, region order (LAYOUT.md §2). The schema file is a byte copy of the contract's (tools/layout/sync-contract.mjs).
// Registry iteration order is NEVER the JSON key order (the Rust port's maps are sorted): anything ordered uses
// REGION_ORDER.
import SCHEMA_JSON from "./layout.schema.json" with { type: "json" };
import type { JObj, Json } from "./json";
import { clone, get, isObj } from "./json";

export type Axis = "w" | "h";
export type Presence = "always" | "content" | "room" | "open" | "call";

export interface IslandDef {
  id: string;
  presence: Presence;
  hideable: boolean;
  required: boolean;
  stackable: boolean;
  floatable: boolean;
  popout: boolean;
  /** view.maximized honours it (only the call) */
  maximizable: boolean;
  multi: boolean;
  phone: "rail" | "list" | null;
  pref: { w: JObj; h: JObj };
  min: { w: number; h: number };
  orientH: { pref: { w: JObj; h: JObj }; min: { w: number; h: number } } | null;
  float: { w: JObj; h: JObj } | null;
  collapse: string[];
  home: JObj[];
  /** the call: the usable minimum of its control bar (layout units), 0 elsewhere */
  bar: number;
}

export const SCHEMA: JObj = clone(SCHEMA_JSON as unknown as Json) as JObj;
const X = get(SCHEMA, "x-tinhat") as JObj;

const num = (o: JObj, k: string): number => get(o, k) as number;
const sizePair = (o: JObj) => ({ w: get(o, "w") as JObj, h: get(o, "h") as JObj });
const minPair = (o: JObj) => ({ w: num(o, "w"), h: num(o, "h") });

function readDef(id: string, d: JObj): IslandDef {
  const oh = get(d, "orientH");
  const fl = get(d, "float");
  const ph = get(d, "phone");
  return {
    id,
    presence: get(d, "presence") as Presence,
    hideable: get(d, "hideable") === true,
    required: get(d, "required") === true,
    stackable: get(d, "stackable") === true,
    floatable: get(d, "floatable") === true,
    popout: get(d, "popout") === true,
    maximizable: get(d, "maximizable") === true,
    multi: get(d, "multi") === true,
    phone: ph === "rail" || ph === "list" ? ph : null,
    pref: sizePair(get(d, "pref") as JObj),
    min: minPair(get(d, "min") as JObj),
    orientH: isObj(oh) ? { pref: sizePair(get(oh, "pref") as JObj), min: minPair(get(oh, "min") as JObj) } : null,
    float: isObj(fl) ? sizePair(fl) : null,
    collapse: (get(d, "collapse") as string[]).slice(),
    home: (get(d, "home") as JObj[]).slice(),
    bar: typeof get(d, "bar") === "number" ? (get(d, "bar") as number) : 0,
  };
}

const ISL = get(X, "islands") as JObj;
/** Registry kinds in the fixed logical region order (x-tinhat.regionOrder; LAYOUT.md §2.4). */
export const REGION_ORDER: readonly string[] = (get(get(X, "regionOrder") as JObj, "order") as string[]).slice();
export const REGISTRY: Readonly<Record<string, IslandDef>> = (() => {
  const r = Object.create(null) as Record<string, IslandDef>;
  for (const id of REGION_ORDER) r[id] = readDef(id, get(ISL, id) as JObj);
  return r;
})();

export const LIMITS = get(X, "limits") as JObj;
export const LIM = {
  docBytes: num(LIMITS, "docBytes"),
  layouts: num(LIMITS, "layouts"),
  tombstones: num(LIMITS, "tombstones"),
  formBytes: num(LIMITS, "formBytes"),
  nodes: num(LIMITS, "nodes"),
  depth: num(LIMITS, "depth"),
  children: num(LIMITS, "children"),
  stackTabs: num(LIMITS, "stackTabs"),
  floats: num(LIMITS, "floats"),
  buttonsIslands: num(LIMITS, "buttonsIslands"),
  hidden: num(LIMITS, "hidden"),
  collapse: num(LIMITS, "collapse"),
  vv: num(LIMITS, "vv"),
};

const B = get(X, "bounds") as JObj;
const pair = (k: string): [number, number] => (get(B, k) as number[]).slice(0, 2) as [number, number];
export const BOUNDS = {
  hostPx: pair("hostPx"),
  unitPm: pair("unitPm"),
  contentPx: pair("contentPx"),
  layoutUnits: pair("layoutUnits"),
  offsetUnits: pair("offsetUnits"),
  weight: pair("weight"),
  permille: pair("permille"),
};

export const SHAPE_KEYS = ["gap", "margin", "tab", "handle", "drawerW", "drawerPad"] as const;
export type ShapeKey = (typeof SHAPE_KEYS)[number];
/** x-tinhat.bounds.shapeMin: usable chrome (a theme's shape values are raised to these). */
export const SHAPE_MIN: Readonly<Record<ShapeKey, number>> = (() => {
  const s = get(B, "shapeMin") as JObj;
  const r = Object.create(null) as Record<ShapeKey, number>;
  for (const k of SHAPE_KEYS) r[k] = num(s, k);
  return r;
})();
export const SHAPE_DEFAULTS: Readonly<Record<ShapeKey, number>> = (() => {
  const s = get(X, "shapeDefaults") as JObj;
  const r = Object.create(null) as Record<ShapeKey, number>;
  for (const k of SHAPE_KEYS) r[k] = num(s, k);
  return r;
})();

const PRESETS_J = get(X, "presets") as JObj;
const INTERNAL_J = get(X, "internalPresets") as JObj;
/** Preset names in the schema's documented order. */
export const PRESET_NAMES: readonly string[] = ["classic", "compact", "callFirst", "sideMonitor", "handheld"];
/** A fresh copy of preset `name`'s desktop / phone form (undefined for an unknown name). */
export function presetDesktop(name: string): JObj | undefined {
  const p = get(PRESETS_J, name);
  return isObj(p) ? (clone(get(p, "desktop")) as JObj) : undefined;
}
export function presetPhone(name: string): JObj | undefined {
  const p = get(PRESETS_J, name);
  return isObj(p) ? (clone(get(p, "phone")) as JObj) : undefined;
}
/** The internal migration preset (classic-flush): solve only, never stored, never validated. */
export function internalDesktop(name: string): JObj | undefined {
  const p = get(INTERNAL_J, name);
  return isObj(p) ? (clone(get(p, "desktop")) as JObj) : undefined;
}
export const classicDesktop = (): JObj => presetDesktop("classic") as JObj;
export const classicPhone = (): JObj => presetPhone("classic") as JObj;

export const ERRORS: readonly string[] = (get(X, "errors") as string[]).slice();
export const NOTES: readonly string[] = (get(X, "repairNotes") as string[]).slice();

// ---- identifiers (LAYOUT.md §2.2) ------------------------------------------------------------------------------
const lower = (c: number) => c >= 97 && c <= 122;
const upper = (c: number) => c >= 65 && c <= 90;
const digit = (c: number) => c >= 48 && c <= 57;

/** `^[a-z][a-z0-9-]{0,31}$` — layout, container, stack and float ids. */
export function isIdSyntax(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 1 || s.length > 32 || !lower(s.charCodeAt(0))) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(lower(c) || digit(c) || c === 45)) return false;
  }
  return true;
}

/** `^[a-z][a-zA-Z0-9]{0,23}(:[a-z0-9]{1,12})?$` — island refs (kind, optionally `:instance`). */
export function isRefSyntax(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const colon = s.indexOf(":");
  const kind = colon < 0 ? s : s.slice(0, colon);
  if (kind.length < 1 || kind.length > 24 || !lower(kind.charCodeAt(0))) return false;
  for (let i = 1; i < kind.length; i++) {
    const c = kind.charCodeAt(i);
    if (!(lower(c) || upper(c) || digit(c))) return false;
  }
  if (colon < 0) return true;
  const inst = s.slice(colon + 1);
  if (inst.length < 1 || inst.length > 12) return false;
  for (let i = 0; i < inst.length; i++) {
    const c = inst.charCodeAt(i);
    if (!(lower(c) || digit(c))) return false;
  }
  return true;
}

/** `^[a-z][a-zA-Z0-9-]{0,31}(:[a-z0-9]{1,12})?$` — a collapse step's ref (a node id or an island ref). */
export function isStepRefSyntax(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const colon = s.indexOf(":");
  const head = colon < 0 ? s : s.slice(0, colon);
  if (head.length < 1 || head.length > 32 || !lower(head.charCodeAt(0))) return false;
  for (let i = 1; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (!(lower(c) || upper(c) || digit(c) || c === 45)) return false;
  }
  if (colon < 0) return true;
  const inst = s.slice(colon + 1);
  if (inst.length < 1 || inst.length > 12) return false;
  for (let i = 0; i < inst.length; i++) {
    const c = inst.charCodeAt(i);
    if (!(lower(c) || digit(c))) return false;
  }
  return true;
}

/** `^[a-z]{1,16}$` — a node type name. */
export function isTypeSyntax(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 1 || s.length > 16) return false;
  for (let i = 0; i < s.length; i++) if (!lower(s.charCodeAt(i))) return false;
  return true;
}

export const kindOf = (ref: string): string => {
  const i = ref.indexOf(":");
  return i < 0 ? ref : ref.slice(0, i);
};
/** A ref this version renders: a non-multi registry id, or `<multi kind>:<instance>`. */
export function isKnownRef(ref: string): boolean {
  const d = REGISTRY[kindOf(ref)];
  return d !== undefined && d.multi === ref.includes(":");
}
export const defOf = (ref: string): IslandDef | undefined => (isKnownRef(ref) ? REGISTRY[kindOf(ref)] : undefined);
/** Compat islands of the internal migration preset (`_nav`, `_room`): solve only. */
export const isCompatRef = (ref: string): boolean => ref.length > 1 && ref.charCodeAt(0) === 95;
/** Reserved node ids: a registry kind, `emergency`, or `overflow-*` (one namespace with refs and drawer ids). */
export const isReservedId = (id: string): boolean =>
  REGISTRY[id] !== undefined || id === "emergency" || id.startsWith("overflow-");

export const ROOM_GROUP: readonly string[] = ["header", "timeline", "composer"];
/** The emergency column's islands (LAYOUT.md §5.11). */
export const MAIN: readonly string[] = ["header", "call", "timeline", "composer"];
/** Islands whose registry `required` is true (timeline, composer, call) — in region order. */
export const REQUIRED: readonly string[] = REGION_ORDER.filter((k) => REGISTRY[k].required);
/** Singleton kinds (not multi) in region order. */
export const SINGLETONS: readonly string[] = REGION_ORDER.filter((k) => !REGISTRY[k].multi);
