// palette.ts — the theme editor's Simple palette (THEME-SIMPLE design, 2026-10-31): the few base colours a theme really
// stores, grouped by what they paint (Backgrounds, Text, Accent, Status, People), each with every role and token that
// follows it; and the two Simple edits — one swatch, or a whole group moved by one OKLab offset. The TypeScript
// REFERENCE: the desktop ports it line by line (crates/theme/src/palette.rs) and both run the shared vectors
// (testvectors/editor/palette-*, edit-swatch-*, edit-group-*, session-*-drag*) byte for byte.
//
// No format change: the view only reads the document; the edits write literal colours into fields every app since 11.0
// reads (palette slots, `accent`, role values, token overrides, `variant`). Pure: no DOM, no clock, no I/O.
import { cmpCodePoint } from "./canon";
import type { TokensSpec } from "./engine";
import type { Expr } from "./expr";
import { parseExpr } from "./expr";
import { paletteLabel, roleLabel } from "./labels";
import type { Colour } from "./literal";
import { formatColour, parseLiteral } from "./literal";
import { chroma, fromOklab, luminance, toOklab } from "./maths";
import { PALETTE_SET, PALETTE_SLOTS as PALETTE_SLOTS_LIST, ROLE_IDS as ROLE_LIST, ROLE_SET, deriveRoleExprs, type Palette } from "./roles";
import type { JObj, Json } from "./sync";

/** The Simple groups, in order, with the roles each one owns (lead order). Roles in no group (scrim, shadow) are never
 *  swatches. `name.N` roles join People only when the theme's names come from the palette. */
export const PALETTE_GROUPS: readonly { id: string; label: string; roles: readonly string[] }[] = [
  {
    id: "backgrounds",
    label: "Backgrounds",
    roles: ["surface.island", "surface.window", "surface.raised", "surface.hover", "surface.pressed", "surface.sunken", "surface.overlay", "surface.selected", "border.subtle", "border.strong"],
  },
  { id: "text", label: "Text", roles: ["text.primary", "text.secondary", "text.muted", "text.disabled", "text.onAccent"] },
  { id: "accent", label: "Accent", roles: ["accent.base", "accent.bright", "accent.dim", "accent.glow", "text.link", "border.focus"] },
  {
    id: "status",
    label: "Status",
    roles: ["state.danger", "state.dangerBright", "state.warning", "state.success", "state.info", "state.aside", "mention.edge", "mention.bg", "badge.bg", "badge.mention", "call.speaking", "call.muted"],
  },
  {
    id: "people",
    label: "People",
    roles: ["presence.online", "presence.away", "presence.busy", "presence.incall", "presence.offline", ...Array.from({ length: 12 }, (_, i) => `name.${i + 1}`)],
  },
];

/** Hand-set token overrides of exactly a swatch's colour follow its edits only when that colour is chromatic (white,
 *  black and greys are never dragged along): OKLab chroma ≥ this (the engine's accent threshold, ENGINE.md §5). */
export const FOLLOW_CHROMA = 0.04;

export interface Swatch {
  /** the first source: the swatch's key (a palette slot, "accent", or a role id) */
  id: string;
  /** every source holding this colour in this group, in group order */
  sources: string[];
  /** the stored colour, canonical */
  colour: string;
  /** the first source's label */
  label: string;
  /** hand-set token overrides of exactly this colour that follow it (chromatic only), id order */
  follow: string[];
  /** every role and token that paints with it (the sources' roles included), id order */
  usedBy: string[];
  /** the other groups whose roles it reaches, group order */
  alsoIn: string[];
}
export interface PaletteGroup {
  id: string;
  label: string;
  swatches: Swatch[];
}
export interface PaletteView {
  groups: PaletteGroup[];
  /** literal token overrides no swatch reaches, and grouped roles made only of literals (not a swatch): Advanced */
  handSet: string[];
}

const isObj = (v: unknown): v is JObj => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const sorted = (xs: Iterable<string>): string[] => [...xs].sort(cmpCodePoint);

function refs(e: Expr, out: string[]): string[] {
  if (e.k === "ref") out.push(e.id);
  else if (e.k === "fn") for (const a of e.args) refs(a, out);
  return out;
}
const REFS = new Map<string, string[]>();
/** The refs of an expression text, memoised (pure: the same text always has the same refs). */
const refsOf = (src: string): string[] => {
  let r = REFS.get(src);
  if (r) return r;
  const p = parseExpr(src);
  r = p.ok ? refs(p.e, []) : [];
  if (REFS.size > 20000) REFS.clear();
  REFS.set(src, r);
  return r;
};
const isLiteral = (src: unknown): boolean => typeof src === "string" && parseLiteral(src) !== null;

/** The document's palette (for the §5 derivation), or null (roles-only / unusable: the engine refuses those). */
function paletteOf(doc: JObj): Palette | null {
  const p = doc.palette;
  if (!isObj(p)) return null;
  const lit = (v: Json | undefined): Colour | undefined => (typeof v === "string" ? (parseLiteral(v) ?? undefined) : undefined);
  const ansi = Array.isArray(p.ansi) ? (p.ansi as Json[]).map((v) => lit(v)) : [];
  const bg = lit(p.bg);
  const fg = lit(p.fg);
  if (!bg || !fg || ansi.length !== 16 || ansi.some((c) => !c)) return null;
  return { bg, fg, cursor: lit(p.cursor), selectionBg: lit(p.selectionBg), selectionFg: lit(p.selectionFg), ansi: ansi as Colour[] };
}

/** The stored value of a source: a palette slot, "accent" (the literal `accent` field) or a role's own value. */
export function sourceValue(doc: JObj, id: string): string | null {
  if (id === "accent") return typeof doc.accent === "string" ? doc.accent : null;
  if (PALETTE_SET.has(id)) {
    const p = doc.palette;
    if (!isObj(p)) return null;
    const m = /^c(\d{1,2})$/.exec(id);
    const v = m ? (Array.isArray(p.ansi) ? (p.ansi as Json[])[Number(m[1])] : undefined) : p[id];
    return typeof v === "string" ? v : null;
  }
  const r = doc.roles;
  return isObj(r) && has(r, id) && typeof r[id] === "string" ? (r[id] as string) : null;
}

interface Graph {
  /** effective role expressions (derivation + overrides / the roles) */
  roleSrc: Map<string, string>;
  /** node → the nodes that reference it directly ("p:<slot>", "r:<role>", "t:<token>") */
  rev: Map<string, string[]>;
  palette: boolean;
  names: boolean;
}

function graph(doc: JObj, spec: TokensSpec): Graph {
  const pal = paletteOf(doc);
  const roleOv = isObj(doc.roles) ? (doc.roles as JObj) : null;
  const roleSrc = new Map<string, string>();
  if (pal) {
    let variant = doc.variant === "dark" || doc.variant === "light" ? doc.variant : null;
    if (!variant) variant = luminance(pal.bg) < luminance(pal.fg) ? "dark" : "light";
    for (const [id, src] of deriveRoleExprs(pal, variant === "dark", typeof doc.accent === "string" ? doc.accent : undefined)) roleSrc.set(id, src);
  }
  if (roleOv) for (const id of sorted(Object.keys(roleOv))) if (ROLE_SET.has(id) && typeof roleOv[id] === "string") roleSrc.set(id, roleOv[id] as string);
  const tokOv = isObj(doc.tokens) ? (doc.tokens as JObj) : null;
  const rev = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const l = rev.get(to);
    if (l) l.push(from);
    else rev.set(to, [from]);
  };
  for (const id of sorted(roleSrc.keys())) {
    for (const r of refsOf(roleSrc.get(id) as string)) {
      if (ROLE_SET.has(r)) link(`r:${id}`, `r:${r}`);
      else if (pal && PALETTE_SET.has(r)) link(`r:${id}`, `p:${r}`);
    }
  }
  const tokenIds = new Set(spec.tokens.map((t) => t.id));
  for (const t of spec.tokens) {
    const src = tokOv && has(tokOv, t.id) && typeof tokOv[t.id] === "string" ? (tokOv[t.id] as string) : t.default;
    for (const r of refsOf(src)) {
      if (ROLE_SET.has(r)) link(`t:${t.id}`, `r:${r}`);
      else if (tokenIds.has(r)) link(`t:${t.id}`, `t:${r}`);
    }
  }
  return { roleSrc, rev, palette: pal !== null, names: doc.names !== "hash-hsl" };
}

/** Every node reachable backwards from `starts` (the starts included), as ids without their prefix: roles and tokens. */
function reach(g: Graph, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length) {
    const n = stack.pop() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of g.rev.get(n) ?? []) stack.push(m);
  }
  return seen;
}

const groupRoles = (g: Graph, roles: readonly string[]): string[] => roles.filter((r) => g.names || !r.startsWith("name."));
const labelOf = (id: string): string => (id === "accent" ? roleLabel("accent.base") : PALETTE_SET.has(id) ? paletteLabel(id) : roleLabel(id));
const nodeOf = (id: string): string => (id === "accent" ? "r:accent.base" : PALETTE_SET.has(id) ? `p:${id}` : `r:${id}`);

/** The Simple palette of a working document (which must resolve). */
export function paletteView(doc: JObj, spec: TokensSpec): PaletteView {
  const g = graph(doc, spec);
  // 1. sources, in group order: literal roles; on a palette theme the slots each role references directly (a slot
  //    belongs to the first group that references it) and the literal `accent`
  const owner = new Map<string, number>(); // source → group index
  const order: string[][] = PALETTE_GROUPS.map(() => []);
  const roleGroup = new Map<string, number>();
  PALETTE_GROUPS.forEach((gr, gi) => groupRoles(g, gr.roles).forEach((r) => roleGroup.set(r, gi)));
  const claim = (src: string, gi: number) => {
    if (owner.has(src)) return;
    owner.set(src, gi);
    order[gi].push(src);
  };
  const madeOfLiterals: string[] = [];
  // pass 1: a role that IS a source (a literal, the literal accent, or exactly one slot); pass 2: slots referenced
  // inside expressions — so Text owns `fg` even though the surfaces mix it in
  const own = (r: string) => isObj(doc.roles) && has(doc.roles as JObj, r);
  PALETTE_GROUPS.forEach((gr, gi) => {
    for (const r of groupRoles(g, gr.roles)) {
      const src = g.roleSrc.get(r);
      if (src === undefined) continue;
      if (isLiteral(src)) {
        if (own(r)) claim(r, gi);
        else if (r === "accent.base" && isLiteral(doc.accent)) claim("accent", gi);
        continue;
      }
      const p = parseExpr(src);
      if (g.palette && p.ok && p.e.k === "ref" && PALETTE_SET.has(p.e.id) && !ROLE_SET.has(p.e.id)) claim(p.e.id, gi);
    }
  });
  PALETTE_GROUPS.forEach((gr, gi) => {
    for (const r of groupRoles(g, gr.roles)) {
      const src = g.roleSrc.get(r);
      if (src === undefined || isLiteral(src)) continue;
      let any = false;
      for (const x of refsOf(src)) {
        if (ROLE_SET.has(x)) any = true;
        else if (g.palette && PALETTE_SET.has(x)) {
          any = true;
          claim(x, gi);
        }
      }
      if (!any && own(r)) madeOfLiterals.push(r);
    }
  });
  // 2. swatches: the sources of a group with the same canonical colour
  const tokOv = isObj(doc.tokens) ? (doc.tokens as JObj) : {};
  const claimedTokens = new Set<string>();
  const groups: PaletteGroup[] = PALETTE_GROUPS.map((gr, gi) => {
    const swatches: Swatch[] = [];
    const byColour = new Map<string, Swatch>();
    for (const src of order[gi]) {
      const c = parseLiteral(sourceValue(doc, src) ?? "");
      if (!c) continue;
      const colour = formatColour(c);
      const sw = byColour.get(colour);
      if (sw) sw.sources.push(src);
      else {
        const n: Swatch = { id: src, sources: [src], colour, label: labelOf(src), follow: [], usedBy: [], alsoIn: [] };
        byColour.set(colour, n);
        swatches.push(n);
      }
    }
    for (const sw of swatches) {
      const c = parseLiteral(sw.colour) as Colour;
      if (chroma(c) >= FOLLOW_CHROMA) {
        for (const t of sorted(Object.keys(tokOv))) {
          if (claimedTokens.has(t) || typeof tokOv[t] !== "string") continue;
          const tc = parseLiteral(tokOv[t] as string);
          if (tc && formatColour(tc) === sw.colour) {
            sw.follow.push(t);
            claimedTokens.add(t);
          }
        }
      }
      const seen = reach(g, [...sw.sources.map(nodeOf), ...sw.follow.map((t) => `t:${t}`)]);
      const used: string[] = [];
      const also = new Set<number>();
      for (const n of seen) {
        if (n.startsWith("p:")) continue;
        const id = n.slice(2);
        used.push(id);
        if (n.startsWith("r:")) {
          const rg = roleGroup.get(id);
          if (rg !== undefined && rg !== gi) also.add(rg);
        }
      }
      sw.usedBy = sorted(used);
      sw.alsoIn = [...also].sort((a, b) => a - b).map((i) => PALETTE_GROUPS[i].id);
    }
    return { id: gr.id, label: gr.label, swatches };
  });
  const handSet = sorted([...madeOfLiterals, ...Object.keys(tokOv).filter((t) => !claimedTokens.has(t) && isLiteral(tokOv[t]))]);
  return { groups, handSet };
}

/** A colour moved by an OKLab offset (L clamped to 0..1, channels clamped by fromOklab); its alpha kept. A zero offset
 *  returns the colour itself (no re-quantising). */
export function shiftColour(c: Colour, dL: number, dA: number, dB: number): Colour {
  if (dL === 0 && dA === 0 && dB === 0) return c;
  const p = toOklab(c);
  let L = p.L + dL;
  if (L < 0) L = 0;
  if (L > 1) L = 1;
  const [r, g, b] = fromOklab(L, p.A + dA, p.B + dB);
  return { r, g, b, a: c.a };
}

/** Advanced's "Used by ‹n›": for every role (and, on a palette theme, every palette slot) how many other roles and
 *  tokens paint with it, followed through every expression. Keys in id order. */
export function usageCounts(doc: JObj, spec: TokensSpec): Record<string, number> {
  const g = graph(doc, spec);
  const out: Record<string, number> = {};
  const ids = [...(g.palette ? PALETTE_SLOTS_LIST : []), ...ROLE_LIST].sort(cmpCodePoint);
  for (const id of ids) {
    const self = PALETTE_SET.has(id) ? `p:${id}` : `r:${id}`;
    let n = 0;
    for (const x of reach(g, [self])) if (x !== self && !x.startsWith("p:")) n++;
    out[id] = n;
  }
  return out;
}

/** What a Simple swatch's popover shows, read live from the current view (THEME-SIMPLE §4): the swatch of `group` that
 *  holds `id` (null when it is gone), whether it leads (first of ≥ 2), the group's size, how many OTHER colours follow
 *  the edit — with `whole`, the union over the group's swatches — and the other groups it reaches. */
export function swatchInfo(view: PaletteView, group: string, id: string, whole: boolean): { lead: boolean; members: number; usedBy: number; alsoIn: string[]; colour: string } | null {
  const g = view.groups.find((x) => x.id === group);
  const i = g ? g.swatches.findIndex((x) => x.sources.includes(id)) : -1;
  if (!g || i < 0) return null;
  const lead = i === 0 && g.swatches.length > 1;
  const list = lead && whole ? g.swatches : [g.swatches[i]];
  const used = new Set<string>();
  const own = new Set<string>();
  const also = new Set<string>();
  for (const sw of list) {
    sw.usedBy.forEach((x) => used.add(x));
    sw.sources.forEach((x) => own.add(x));
    sw.alsoIn.forEach((x) => also.add(x));
  }
  let n = 0;
  for (const x of used) if (!own.has(x)) n++;
  const alsoIn = PALETTE_GROUPS.filter((x) => also.has(x.id)).map((x) => x.id);
  return { lead, members: g.swatches.length, usedBy: n, alsoIn, colour: g.swatches[i].colour };
}
