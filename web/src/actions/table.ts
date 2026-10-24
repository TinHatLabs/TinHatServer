// table.ts — the actions contract table (actions.json v1, ACTIONS.md §2–§9), read once. The JSON file is a byte copy
// of the contract's (tools/actions/sync-contract.mjs; actions.test.ts checks the copy). Everything here is pure data
// access: no DOM, no I/O, no clock. Iteration order is never the JSON key order (the Rust port's maps are sorted):
// anything ordered sorts by code point or keeps the table's array order.
import TABLE_JSON from "./actions.json" with { type: "json" };
import type { JObj, Json } from "../layout/json";
import { clone, get, isObj } from "../layout/json";

export type App = "desktop" | "web";
export const APPS: readonly App[] = ["desktop", "web"];

/** An availability rule (ACTIONS.md §4.1). */
export type When =
  | string
  | { not: When }
  | { all: When[] }
  | { any: When[] }
  | { eq: [string, string] }
  | { param: [string, string] };

export interface Face {
  label?: string;
  shortLabel?: string;
  icon?: string;
  tip?: string;
  /** an emoji drawn as the glyph (a status preset's 🎯); hosts prefer it to the icon */
  emoji?: string;
}
export interface ParamSpec {
  type: "enum" | "text" | "emoji" | "colour" | "int";
  values?: string[];
  labels?: Record<string, string>;
  shortLabels?: Record<string, string>;
  icons?: Record<string, string>;
  required?: boolean;
  max?: number;
  min?: number;
}
export interface TargetSpec {
  kind: string;
  absent?: "currentRoom" | "activeSpace" | "pick" | "none";
  picker?: string;
  values?: string[];
  labels?: Record<string, string>;
  shortLabels?: Record<string, string>;
  icons?: Record<string, string>;
  /** per stored value: an emoji drawn as the glyph (status presets) */
  emojis?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  pickable?: boolean;
}
export interface ToggleSpec {
  state: string;
  on?: Face;
  off?: Face;
  activeWhen?: string | { param: string } | { subject: true };
}
export interface Variant extends Face {
  when: When;
}
export interface ShortcutSpec {
  keys: string[];
  scope: string;
  typing?: boolean;
  fixed?: boolean;
  web?: string[];
  desktop?: string[];
  rank?: number;
  params?: Record<string, string>;
}
export interface ConfirmSpec {
  kind: "destructive" | "consent";
  title: string;
  text: string;
  confirmLabel: string;
  askReason?: boolean;
  onlyWhen?: When;
  variants?: ({ when: When } & Partial<Pick<ConfirmSpec, "title" | "text" | "confirmLabel">>)[];
}
export interface Action {
  id: string;
  group: string;
  label: string;
  shortLabel?: string;
  tip?: string;
  keywords?: string[];
  icon: string | null;
  iconByApp?: Partial<Record<App, string>>;
  apps: App[];
  requires?: When;
  when?: When;
  target?: TargetSpec;
  toggle?: ToggleSpec;
  variants?: Variant[];
  shortcut?: ShortcutSpec[];
  hold?: boolean;
  confirm?: ConfirmSpec;
  danger?: boolean;
  primary?: boolean;
  contexts?: string[];
  split?: { a: string; target?: JObj };
  /** the face of a button whose target is STORED in the item ("Join {name}", "{name}"; ACTIONS.md §7.2) */
  targetFace?: Face;
  pending?: string;
  /** false: never listed in the Ctrl+K palette (ACTIONS.md §10.2) */
  palette?: false;
  since: string;
  notes?: string;
}
export interface PredicateDef {
  type: "bool" | "enum";
  scope: string;
  values?: string[];
  /** "app": derived from the evaluating app (platform.web), never read from the snapshot. */
  source?: "app";
  doc: string;
}
export interface StateDef {
  type: "bool" | "enum" | "text" | "list";
  scope: string;
  values?: string[];
  source?: "app";
  doc: string;
}
export interface TargetKind {
  /** the row-item target key a stored kind's value sits under */
  key?: string;
  /** its value type (valueTypes) */
  value?: string;
  /** the subject kind the value names (snapshot.subjects.<subject>) */
  subject?: string;
  stored: boolean;
  portable: boolean;
  picker?: string;
  fallbackName: string;
  doc: string;
}
export interface ValueType {
  doc: string;
  values?: string[];
  or?: string;
  prefix?: string[];
  min?: number;
  max?: number;
  token?: boolean;
  server?: boolean;
  charset?: string;
}
export type Look = "icon" | "iconLabel" | "label";
export type Scale = "S" | "M";
export const LOOKS: readonly Look[] = ["icon", "iconLabel", "label"];
export const SCALES: readonly Scale[] = ["S", "M"];
export interface RowOverride extends Face {
  look?: Look;
  /** false → the item is hidden in this row (ANDed with the action's requires) */
  requires?: When;
  /** false → the item is unavailable in this row (ANDed with the action's when) */
  when?: When;
}
export interface RowKind {
  contexts: string[];
  forms: ("desktop" | "phone")[];
  /** the row's defaults when the stored row has none (ACTIONS.md §9.1) */
  look: Look;
  scale: Scale;
  /** how the host draws this row's buttons today (informative) */
  style: "header" | "tool" | "compact" | "call" | "rail" | "hover" | "tile";
  /** the user may change the row in edit mode in 11.0 */
  editable: boolean;
  doc: string;
  overrides?: Record<string, RowOverride>;
}
export interface MenuItem {
  a?: string;
  menu?: string;
  target?: JObj;
  hideWhenOff?: boolean;
  sepBefore?: boolean;
  section?: string;
  label?: string;
  when?: When;
  forms?: ("desktop" | "phone")[];
  sub?: boolean;
}
export interface MenuDef {
  context?: string;
  label?: string;
  doc: string;
  items: MenuItem[];
}
export interface PaletteSpec {
  maxResults: number;
  prefixes: Record<string, "action" | "person" | "room">;
  kindOrder: string[];
  tiers: {
    prefix: number;
    wordStart: number;
    words: number;
    substring: number;
    alias: number;
    subsequence: number;
    keywordPrefix: number;
    keywordWordStart: number;
    keywordSubstring: number;
  };
  boosts: { unread: number; dm: number };
  /** inclusive code-point ranges that separate words */
  separators: [number, number][];
  texts: {
    placeholder: string;
    pickPlaceholder: string;
    empty: string;
    emptyRooms: string;
    /** an invite row's marker ("Invited", the room list's pill word; ACTIONS.md §10.7) */
    inviteMarker: string;
    sections: Record<string, string>;
  };
}
export interface Table {
  format: "tinhat-actions";
  version: 1;
  doc: string;
  groups: { id: string; label: string }[];
  predicates: Record<string, PredicateDef>;
  states: Record<string, StateDef>;
  valueTypes: Record<string, ValueType>;
  paramTypes: Record<string, { doc: string }>;
  targetKinds: Record<string, TargetKind>;
  contexts: Record<string, { provides: string[]; doc: string }>;
  scopes: Record<string, { parent?: string; doc: string }>;
  keys: {
    modifiers: string[];
    named: string[];
    function: number;
    punctuation: string[];
    aliases: Record<string, string>;
    reserved: string[];
  };
  webKeys: { reserved: string[]; browser: string[] };
  limits: Record<string, number>;
  /** what a row draws for an action id this version does not know (ACTIONS.md §9.5) */
  placeholder: { label: string; icon: string; tip: string };
  palette: PaletteSpec;
  rows: Record<string, RowKind>;
  menus: Record<string, MenuDef>;
  actions: Action[];
}

/** The table, as prototype-less objects (own keys only; a key like "__proto__" would be ordinary data). */
export const TABLE: Table = clone(TABLE_JSON as unknown as Json) as unknown as Table;

const BY_ID: Map<string, Action> = new Map(TABLE.actions.map((a) => [a.id, a]));

/** The action with this id, or undefined (own ids only). */
export function actionById(id: string): Action | undefined {
  return BY_ID.get(id);
}

/** An own-key lookup in a registry map (never an inherited property). */
export function reg<T>(m: Record<string, T> | undefined, k: string): T | undefined {
  if (!m || !isObj(m as unknown)) return undefined;
  return get(m as unknown as JObj, k) as unknown as T | undefined;
}

/** The scope chain of a shortcut scope, innermost first; an unknown scope is a chain of its own ([scope]). */
export function scopeChain(scope: string): string[] {
  const out: string[] = [];
  let s: string | undefined = scope;
  while (s !== undefined && out.length < 16 && !out.includes(s)) {
    out.push(s);
    const def: { parent?: string } | undefined = reg(TABLE.scopes, s);
    s = def ? def.parent : undefined;
  }
  return out;
}

/** True when one scope is the other or an ancestor of it (bindings in them can meet one key press). */
export function scopesOverlap(a: string, b: string): boolean {
  return scopeChain(a).includes(b) || scopeChain(b).includes(a);
}
