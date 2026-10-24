// labels.ts — the words of the theme editor's Advanced mode (THEMES-UI.md §12.8): palette-slot and role labels, token
// labels built from the id (NAMING.md §4), the groups (palette, role groups, then every token area under its section)
// and the search. The labels and the grouping come from editor-labels.json, a byte copy of the contract's (the desktop
// embeds the same file), so both apps show the same words in the same order; the functions are pinned by the shared
// vectors testvectors/editor/labels-*.json (desktop: crates/theme/src/labels.rs).
// Pure: no DOM. ASCII-only case folding (so the two languages agree on every input).
import labelsJson from "./editor-labels.json" with { type: "json" };
import { cmpCodePoint } from "./canon";
import { PALETTE_SLOTS } from "./roles";

export interface EditorLabels {
  format: "tinhat-editor-labels";
  v: 1;
  palette: Record<string, string>;
  roles: Record<string, string>;
  roleGroups: { label: string; ids: string[] }[];
  sections: { label: string; areas: string[] }[];
  areas: Record<string, string>;
  words: Record<string, string>;
  properties: string[];
  states: string[];
}
export const LABELS = labelsJson as unknown as EditorLabels;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** ASCII lower case (A–Z only). */
export function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (m) => String.fromCharCode(m.charCodeAt(0) + 32));
}
/** First character upper-cased when it is an ASCII letter. */
function capital(s: string): string {
  const c = s.charCodeAt(0);
  return c >= 97 && c <= 122 ? String.fromCharCode(c - 32) + s.slice(1) : s;
}
/** "afkBanner" → ["afk", "banner"]: split before each ASCII capital, lower-cased. */
function camelWords(seg: string): string[] {
  const out: string[] = [];
  let w = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      if (w) out.push(w);
      w = String.fromCharCode(c + 32);
    } else w += seg[i];
  }
  if (w) out.push(w);
  return out;
}
const word = (w: string, L: EditorLabels): string => (has(L.words, w) ? L.words[w] : w);

/**
 * A token's label from its id (§12.8): the area segment dropped; a trailing state after a property becomes
 * " (<state>)"; every remaining segment split into words (camelCase), each word through the word table; joined with
 * spaces, first letter capital. `composer.border.focus` → "Border (focus)", `rooms.item.bg.hover` → "Item background
 * (hover)", `call.afkBanner.icon` → "AFK banner icon". A one-segment id is its own words.
 */
export function tokenLabel(id: string, L: EditorLabels = LABELS): string {
  const segs = id.split(".");
  const rest = segs.length > 1 ? segs.slice(1) : segs;
  let state: string | null = null;
  if (rest.length >= 2 && L.states.includes(rest[rest.length - 1]) && L.properties.includes(rest[rest.length - 2])) state = rest.pop() as string;
  const words: string[] = [];
  for (const s of rest) for (const w of camelWords(s)) words.push(word(w, L));
  const label = capital(words.join(" "));
  return state === null ? label : `${label} (${word(state, L)})`;
}
export const roleLabel = (id: string, L: EditorLabels = LABELS): string => (has(L.roles, id) ? L.roles[id] : id);
export const paletteLabel = (slot: string, L: EditorLabels = LABELS): string => (has(L.palette, slot) ? L.palette[slot] : slot);
export const areaLabel = (area: string, L: EditorLabels = LABELS): string => (has(L.areas, area) ? L.areas[area] : area);

/** A token as the Advanced mode needs it (tokens.json: id, area, description). */
export interface TokenInfo {
  id: string;
  area: string;
  description?: string;
}
export type RowKind = "palette" | "role" | "token";
export interface EditorRow {
  kind: RowKind;
  id: string;
  label: string;
}
export interface EditorGroup {
  /** "palette", "roles:<n>", "area:<area>" */
  id: string;
  /** the section heading the group sits under ("Palette", "Roles", "Chat", …, "Other") */
  section: string;
  label: string;
  rows: EditorRow[];
}

/**
 * The Advanced mode's groups in order (§12.8): the palette (palette themes only: bg, fg, cursor, selectionBg,
 * selectionFg, c0…c15), the role groups, then for every section every area of it that has tokens, then the areas no
 * section lists (a newer token list) under "Other", by area id. Token rows in id order.
 */
export function advancedGroups(hasPalette: boolean, tokens: readonly TokenInfo[], L: EditorLabels = LABELS): EditorGroup[] {
  const out: EditorGroup[] = [];
  if (hasPalette) out.push({ id: "palette", section: "Palette", label: "Palette", rows: PALETTE_SLOTS.map((s) => ({ kind: "palette", id: s, label: paletteLabel(s, L) })) });
  L.roleGroups.forEach((g, i) => out.push({ id: `roles:${i}`, section: "Roles", label: g.label, rows: g.ids.map((id) => ({ kind: "role", id, label: roleLabel(id, L) })) }));
  const byArea = new Map<string, string[]>();
  for (const t of tokens) {
    const l = byArea.get(t.area);
    if (l) l.push(t.id);
    else byArea.set(t.area, [t.id]);
  }
  const rowsOf = (area: string): EditorRow[] => [...(byArea.get(area) ?? [])].sort(cmpCodePoint).map((id) => ({ kind: "token", id, label: tokenLabel(id, L) }));
  const listed = new Set<string>();
  for (const s of L.sections) {
    for (const a of s.areas) {
      listed.add(a);
      if (!byArea.has(a)) continue;
      out.push({ id: `area:${a}`, section: s.label, label: areaLabel(a, L), rows: rowsOf(a) });
    }
  }
  for (const a of [...byArea.keys()].filter((x) => !listed.has(x)).sort(cmpCodePoint)) out.push({ id: `area:${a}`, section: "Other", label: a, rows: rowsOf(a) });
  return out;
}

/** The search words of a query: ASCII-lower-cased, split on space / tab / CR / LF, empty ones dropped. */
export function searchWords(query: string): string[] {
  return lowerAscii(query).split(/[ \t\r\n]+/).filter((w) => w.length > 0);
}

/**
 * The groups a search keeps (§12.8): a row matches when every word occurs in its text — label, id, group label,
 * section and (tokens) the description — ASCII-lower-cased; groups with no matching row are left out. No words →
 * the groups as they are.
 */
export function searchGroups(groups: readonly EditorGroup[], query: string, describe: (id: string) => string = () => ""): EditorGroup[] {
  const words = searchWords(query);
  if (words.length === 0) return [...groups];
  const out: EditorGroup[] = [];
  for (const g of groups) {
    const rows = g.rows.filter((r) => {
      const hay = lowerAscii(`${r.label} ${r.id} ${g.label} ${g.section} ${r.kind === "token" ? describe(r.id) : ""}`);
      return words.every((w) => hay.includes(w));
    });
    if (rows.length) out.push({ ...g, rows });
  }
  return out;
}
