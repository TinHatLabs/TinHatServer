// form.ts — the desktop form's tree (LAYOUT.md §3): node kinds, keys, locations, size fields, the placement rules
// (R1-R3 + registry), insertion primitives shared by the operations and repair, home rules and id allocation (N8).
// Forms are plain JSON data (prototype-less objects, json.ts); unknown keys ride along untouched.
import type { JObj, Json } from "./json";
import { clampInt, clone, get, has, isArr, isInt, isObj, isStr, mk, obj } from "./json";
import type { Axis, IslandDef } from "./schema";
import { REGISTRY, defOf, isIdSyntax, isKnownRef, isReservedId, isTypeSyntax, kindOf } from "./schema";

// ---- known keys (LAYOUT.md §3.1) -------------------------------------------------------------------------------
export const KNOWN = {
  form: ["root", "floats", "hidden", "collapse", "opts", "preset", "gap", "margin", "density"],
  container: ["t", "id", "c", "size", "gap"],
  stack: ["t", "id", "c", "size", "active"],
  island: ["t", "i", "size"],
  hidden: ["t", "i", "size", "from"],
  float: ["id", "anchor", "dx", "dy", "w", "h", "reveal", "node"],
  size: ["fixed", "share", "auto", "pm", "min", "max", "minPm", "maxPm", "grow"],
  floatSize: ["fixed", "auto", "pm", "min", "max", "minPm", "maxPm"],
  step: ["ref", "to", "below", "w"],
  from: ["parent", "index"],
} as const;
const KSET = (ks: readonly string[]) => new Set<string>(ks);
const K_CONTAINER = KSET(KNOWN.container);
const K_STACK = KSET(KNOWN.stack);
const K_ISLAND = KSET(KNOWN.island);
const K_SIZE = KSET(KNOWN.size);

export const BASES = ["fixed", "share", "auto", "pm"] as const;
export const SIDES = ["left", "right", "top", "bottom"] as const;
export type Side = (typeof SIDES)[number];
export const ANCHORS = ["tl", "t", "tr", "r", "br", "b", "bl", "l"] as const;
export const STEP_TOS = ["fold", "hide", "overlay", "drawer"] as const;

// ---- node kinds and keys ---------------------------------------------------------------------------------------
export const tOf = (n: JObj): string | undefined => {
  const t = get(n, "t");
  return isStr(t) ? t : undefined;
};
/** An object with a type name matching the node type syntax. */
export const isNode = (v: unknown): v is JObj => isObj(v) && isTypeSyntax(get(v, "t"));
export const isContainer = (n: JObj): boolean => {
  const t = get(n, "t");
  return t === "row" || t === "col";
};
export const isStack = (n: JObj): boolean => get(n, "t") === "stack";
export const isIsland = (n: JObj): boolean => get(n, "t") === "island";
export const isKnownType = (n: JObj): boolean => isContainer(n) || isStack(n) || isIsland(n);
export const isUnknownNode = (n: JObj): boolean => isNode(n) && !isKnownType(n);
/** An island node whose ref this version does not render (not in the registry). */
export const isUnknownIsland = (n: JObj): boolean => isIsland(n) && isStr(get(n, "i")) && !isKnownRef(get(n, "i") as string);
export const refOf = (n: JObj): string => get(n, "i") as string;
export const kidsOf = (n: JObj): JObj[] => {
  const c = get(n, "c");
  return isArr(c) ? (c as JObj[]) : [];
};
/** The identity of a node in the one namespace (LAYOUT.md §3.2): island ref, or container / stack id. */
export function keyOf(n: JObj): string | undefined {
  if (isIsland(n)) return isStr(get(n, "i")) ? (get(n, "i") as string) : undefined;
  if (isContainer(n) || isStack(n)) return isStr(get(n, "id")) ? (get(n, "id") as string) : undefined;
  return undefined;
}
export const axisOfContainer = (n: JObj): Axis | null => (get(n, "t") === "row" ? "w" : get(n, "t") === "col" ? "h" : null);
export const axisOfSide = (s: Side): Axis => (s === "left" || s === "right" ? "w" : "h");
export const typeOfAxis = (a: Axis): string => (a === "w" ? "row" : "col");

/** Keys of `o` outside `known`. */
export function unknownKeys(o: JObj, known: ReadonlySet<string>): string[] {
  return Object.keys(o).filter((k) => !known.has(k));
}
export const sizeHasUnknown = (s: Json | undefined): boolean => isObj(s) && unknownKeys(s, K_SIZE).length > 0;
/** The node carries keys this version does not know — on itself or inside its `size` (LAYOUT.md §4). */
export function carriesUnknown(n: JObj): boolean {
  if (!isKnownType(n)) return true;
  const known = isContainer(n) ? K_CONTAINER : isStack(n) ? K_STACK : K_ISLAND;
  return unknownKeys(n, known).length > 0 || sizeHasUnknown(get(n, "size"));
}

// ---- locations -------------------------------------------------------------------------------------------------
/** Where a node sits: `parent` holds it in `c` (null for a tree top); `float` = index in `floats` (-1 = root tree). */
export interface Loc {
  node: JObj;
  parent: JObj | null;
  index: number;
  float: number;
  depth: number;
  inUnknown: boolean;
  ancestors: JObj[];
}

export const floatsOf = (f: JObj): JObj[] => {
  const v = get(f, "floats");
  return isArr(v) ? (v as JObj[]) : [];
};
export const hiddenOf = (f: JObj): JObj[] => {
  const v = get(f, "hidden");
  return isArr(v) ? (v as JObj[]) : [];
};
export const collapseOf = (f: JObj): JObj[] => {
  const v = get(f, "collapse");
  return isArr(v) ? (v as JObj[]) : [];
};

function walkTree(top: JObj, float: number, out: Loc[]): void {
  const rec = (node: JObj, parent: JObj | null, index: number, depth: number, anc: JObj[], inU: boolean) => {
    out.push({ node, parent, index, float, depth, inUnknown: inU, ancestors: anc });
    if (isIsland(node)) return;
    const kids = kidsOf(node);
    const anc2 = anc.concat([node]);
    const inU2 = inU || isUnknownNode(node);
    for (let i = 0; i < kids.length; i++) if (isObj(kids[i])) rec(kids[i], node, i, depth + 1, anc2, inU2);
  };
  rec(top, null, float < 0 ? -1 : float, 1, [], false);
}

/** Every node of the root tree, then of each float's node, depth-first pre-order. */
export function allLocs(f: JObj): Loc[] {
  const out: Loc[] = [];
  const root = get(f, "root");
  if (isObj(root)) walkTree(root, -1, out);
  const fl = floatsOf(f);
  for (let i = 0; i < fl.length; i++) {
    const n = isObj(fl[i]) ? get(fl[i], "node") : undefined;
    if (isObj(n)) walkTree(n, i, out);
  }
  return out;
}
export const rootLocs = (f: JObj): Loc[] => allLocs(f).filter((l) => l.float < 0);

/** First node (root tree, then floats) whose key is `key`; known node types only. */
export function findKey(f: JObj, key: string): Loc | undefined {
  for (const l of allLocs(f)) if (isKnownType(l.node) && keyOf(l.node) === key) return l;
  return undefined;
}
export function findFloat(f: JObj, id: string): number {
  const fl = floatsOf(f);
  for (let i = 0; i < fl.length; i++) if (isObj(fl[i]) && get(fl[i], "id") === id) return i;
  return -1;
}
export function hiddenIndex(f: JObj, ref: string): number {
  const h = hiddenOf(f);
  for (let i = 0; i < h.length; i++) if (isObj(h[i]) && get(h[i], "i") === ref) return i;
  return -1;
}

/** Island refs of a subtree, depth-first. */
export function islandsIn(n: JObj): string[] {
  if (isIsland(n)) return isStr(get(n, "i")) ? [get(n, "i") as string] : [];
  const out: string[] = [];
  for (const k of kidsOf(n)) if (isObj(k)) out.push(...islandsIn(k));
  return out;
}
/** Every node of a subtree (itself included), depth-first pre-order. */
export function nodesIn(n: JObj): JObj[] {
  const out: JObj[] = [n];
  if (!isIsland(n)) for (const k of kidsOf(n)) if (isObj(k)) out.push(...nodesIn(k));
  return out;
}

/** Remove the located node from its slot. A float's node leaves the float without a node (normalization drops it). */
export function detach(f: JObj, l: Loc): void {
  if (l.parent) {
    kidsOf(l.parent).splice(kidsOf(l.parent).indexOf(l.node), 1);
  } else if (l.float >= 0) {
    delete floatsOf(f)[l.float]["node"];
  } else {
    throw new Error("layout: the root cannot be detached");
  }
}
/** Put `repl` where the located node is. */
export function replaceAt(f: JObj, l: Loc, repl: JObj): void {
  if (l.parent) {
    const c = kidsOf(l.parent);
    c[c.indexOf(l.node)] = repl;
  } else if (l.float >= 0) {
    floatsOf(f)[l.float]["node"] = repl;
  } else {
    f["root"] = repl;
  }
}

// ---- ids (N8) --------------------------------------------------------------------------------------------------
/** Every id and island ref in the form: node / float ids (any node type) and `i` values in root, floats and hidden. */
export function usedNames(f: JObj): Set<string> {
  const s = new Set<string>();
  for (const l of allLocs(f)) {
    const id = get(l.node, "id");
    if (isStr(id)) s.add(id);
    const i = get(l.node, "i");
    if (isStr(i)) s.add(i);
  }
  for (const fl of floatsOf(f)) if (isObj(fl) && isStr(get(fl, "id"))) s.add(get(fl, "id") as string);
  for (const h of hiddenOf(f)) {
    if (isObj(h) && isStr(get(h, "i"))) s.add(get(h, "i") as string);
    if (isStr(h)) s.add(h);
  }
  return s;
}
/** N8: `<prefix><k>` with the smallest positive k not used by any id or ref of the form. */
export class Ids {
  used: Set<string>;
  constructor(f: JObj) {
    this.used = usedNames(f);
  }
  next(prefix: string): string {
    for (let k = 1; ; k++) {
      const id = prefix + k;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }
  /** N5: `body` if free, else `body1`, `body2`, … */
  body(): string {
    if (!this.used.has("body")) {
      this.used.add("body");
      return "body";
    }
    return this.next("body");
  }
}
/** A usable container / stack / float id: the syntax, not reserved. */
export const idUsable = (id: unknown): id is string => isIdSyntax(id) && !isReservedId(id);

// ---- sizes (N6, LAYOUT.md §3.4) ---------------------------------------------------------------------------------
const RANGES: Record<string, [number, number]> = {
  fixed: [0, 8192],
  min: [0, 8192],
  max: [0, 8192],
  share: [1, 10000],
  grow: [1, 10000],
  pm: [0, 1000],
  minPm: [0, 1000],
  maxPm: [0, 1000],
};
/**
 * N6 on a size object (a copy is returned; unknown keys kept): a known field of the wrong type is dropped (never
 * rounded), integers are clamped to their ranges, several bases keep the first of fixed, share, auto, pm, `grow`
 * needs an explicit non-share basis, max ≥ min and maxPm ≥ minPm. Not an object → undefined.
 */
export function fixSize(v: Json | undefined): { size: JObj | undefined; changed: boolean } {
  if (!isObj(v)) return { size: undefined, changed: true };
  const s = clone(v);
  let changed = false;
  for (const k of ["fixed", "share", "pm", "min", "max", "minPm", "maxPm", "grow"]) {
    if (!has(s, k)) continue;
    const x = s[k];
    if (!isInt(x)) {
      delete s[k];
      changed = true;
      continue;
    }
    const [lo, hi] = RANGES[k];
    const c = clampInt(x, lo, hi);
    if (c !== x || Object.is(x, -0)) {
      s[k] = c === 0 ? 0 : c;
      changed = changed || c !== x;
    }
  }
  if (has(s, "auto") && s["auto"] !== true) {
    delete s["auto"];
    changed = true;
  }
  const bases = BASES.filter((b) => has(s, b));
  for (const b of bases.slice(1)) {
    delete s[b];
    changed = true;
  }
  if (has(s, "grow") && (bases.length === 0 || bases[0] === "share")) {
    delete s["grow"];
    changed = true;
  }
  if (has(s, "min") && has(s, "max") && (s["max"] as number) < (s["min"] as number)) {
    s["max"] = s["min"];
    changed = true;
  }
  if (has(s, "minPm") && has(s, "maxPm") && (s["maxPm"] as number) < (s["minPm"] as number)) {
    s["maxPm"] = s["minPm"];
    changed = true;
  }
  return { size: s, changed };
}
export const basisOf = (s: JObj | undefined): string | undefined => (s ? BASES.find((b) => has(s, b)) : undefined);

/** Registry sizes of an island for the form's orientation option (`opts.<ref>.orient = "h"` → orientH). */
export function regSizes(f: JObj | null, ref: string): { pref: { w: JObj; h: JObj }; min: { w: number; h: number } } | null {
  const d = defOf(ref);
  if (!d) return null;
  if (f && d.orientH) {
    const o = get(f, "opts");
    const oo = isObj(o) ? get(o, ref) : undefined;
    if (isObj(oo) && get(oo, "orient") === "h") return d.orientH;
  }
  return { pref: d.pref, min: d.min };
}

/**
 * A size for `n` on the axis of a new parent (LAYOUT.md §6.2): an island gets its registry pref for that axis, a group
 * `{share: 1}`; the unknown keys of the node's old size ride along.
 */
export function sizeForAxis(f: JObj, n: JObj, axis: Axis): JObj {
  const out = obj();
  const old = get(n, "size");
  if (isObj(old)) for (const k of unknownKeys(old, K_SIZE)) out[k] = clone(old[k]);
  const rs = isIsland(n) ? regSizes(f, refOf(n)) : null;
  const src = rs ? rs.pref[axis] : mk([["share", 1]]);
  for (const k of Object.keys(src)) out[k] = clone(src[k]);
  return out;
}
/** `{share: 1}` plus the unknown keys of the node's old size. */
export function shareOneKeeping(n: JObj): JObj {
  const out = obj();
  const old = get(n, "size");
  if (isObj(old)) for (const k of unknownKeys(old, K_SIZE)) out[k] = clone(old[k]);
  out["share"] = 1;
  return out;
}

// ---- placement rules (LAYOUT.md §3.5; ops step 4) ------------------------------------------------------------------
export interface RoomLocs {
  timeline?: Loc;
  composer?: Loc;
  header?: Loc;
}
export function roomLocs(f: JObj): RoomLocs {
  const r: RoomLocs = {};
  for (const l of allLocs(f)) {
    if (!isIsland(l.node)) continue;
    const ref = refOf(l.node);
    if ((ref === "timeline" || ref === "composer" || ref === "header") && r[ref] === undefined) r[ref] = l;
  }
  return r;
}
const isCol = (n: JObj | null): boolean => !!n && get(n, "t") === "col";

/** R1: timeline and composer are adjacent children of one col (root tree). */
export function r1ok(r: RoomLocs): boolean {
  const t = r.timeline;
  const c = r.composer;
  if (!t || !c || t.float >= 0 || c.float >= 0 || !isCol(t.parent) || t.parent !== c.parent) return false;
  const k = kidsOf(t.parent as JObj);
  return Math.abs(k.indexOf(t.node) - k.indexOf(c.node)) === 1;
}
/** The col R2 measures from: the timeline's col (after R1). */
export const timelineCol = (r: RoomLocs): JObj | null => (r.timeline && isCol(r.timeline.parent) ? r.timeline.parent : null);
/** R2 (header placed): first or last child of the timeline's col or of an ancestor col of it. */
export function r2ok(r: RoomLocs): boolean {
  const h = r.header;
  if (!h) return true;
  const tc = timelineCol(r);
  if (!tc || !r.timeline || h.float >= 0 || !isCol(h.parent)) return false;
  const tcAnc = r.timeline.ancestors; // ancestors of the timeline: …, tc
  if (h.parent !== tc && !tcAnc.slice(0, -1).includes(h.parent as JObj)) return false;
  const k = kidsOf(h.parent as JObj);
  const i = k.indexOf(h.node);
  return i === 0 || i === k.length - 1;
}
/** groupEdge target: the nearest col that contains the timeline's col, else the timeline's col itself. */
export function groupEdgeCol(r: RoomLocs): JObj | null {
  const tc = timelineCol(r);
  if (!tc || !r.timeline) return null;
  const anc = r.timeline.ancestors.slice(0, -1);
  for (let i = anc.length - 1; i >= 0; i--) if (isCol(anc[i]) ) return anc[i];
  return tc;
}

/**
 * The placement rules an operation's mutated copy must meet before normalization (LAYOUT.md §6.1 step 4), in this
 * order: one occurrence per ref; hidden islands hideable and not required; stacks hold stackable islands only;
 * floated islands floatable, no required island in a hover float; the required islands placed; R1; R2/R3.
 * Returns the error code or null.
 */
export function placementError(f: JObj): string | null {
  const seen = new Set<string>();
  const locs = allLocs(f);
  for (const l of locs) {
    if (!isIsland(l.node)) continue;
    const r = refOf(l.node);
    if (seen.has(r)) return "bad-op: locked group";
    seen.add(r);
  }
  for (const h of hiddenOf(f)) {
    const r = get(h, "i") as string;
    if (seen.has(r)) return "bad-op: locked group";
    seen.add(r);
    const d = defOf(r);
    if (d && d.required) return "bad-op: required island";
    if (d && !d.hideable) return "bad-op: not hideable";
  }
  for (const l of locs) {
    if (!isStack(l.node)) continue;
    for (const k of kidsOf(l.node)) {
      if (!isIsland(k)) return "bad-op: not stackable";
      const d = defOf(refOf(k));
      if (d && !d.stackable) return "bad-op: not stackable";
    }
  }
  const fl = floatsOf(f);
  for (let i = 0; i < fl.length; i++) {
    const node = get(fl[i], "node");
    if (!isObj(node)) continue;
    for (const r of islandsIn(node)) {
      const d = defOf(r);
      if (d && !d.floatable) return "bad-op: not floatable";
      if (d && d.required && get(fl[i], "reveal") === "hover") return "bad-op: required island";
    }
  }
  for (const req of ["timeline", "composer", "call"]) if (!seen.has(req) || hiddenIndex(f, req) >= 0) return "bad-op: required island";
  const room = roomLocs(f);
  if (!r1ok(room)) return "bad-op: locked group";
  if (room.header && (room.header.float >= 0 || !r2ok(room))) return "bad-op: locked group";
  for (const l of [room.timeline, room.composer, room.header]) if (l && l.parent && isStack(l.parent)) return "bad-op: locked group";
  return null;
}

// ---- insertion primitives (LAYOUT.md §6.2) --------------------------------------------------------------------------
/**
 * dockBeside's insertion (the moved node is already detached): target in a stack → the stack; P = its parent; P has the
 * side's axis → insert before / after; else the target is replaced by a new container of that axis holding
 * [moved, target] or [target, moved], which takes the target's size while the target gets `{share: 1}`.
 * Returns the new parent of `moved`.
 */
export function insertBeside(f: JObj, moved: JObj, target: Loc, side: Side, ids: Ids): JObj {
  let t = target;
  if (t.parent && isStack(t.parent)) t = locOf(f, t.parent) as Loc;
  const type = typeOfAxis(axisOfSide(side));
  const before = side === "left" || side === "top";
  if (t.parent && isContainer(t.parent) && get(t.parent, "t") === type) {
    const c = kidsOf(t.parent);
    const i = c.indexOf(t.node);
    c.splice(before ? i : i + 1, 0, moved);
    return t.parent;
  }
  const w = mk([
    ["t", type],
    ["id", ids.next("n")],
  ]);
  const ts = get(t.node, "size");
  if (ts !== undefined) w["size"] = ts;
  w["c"] = before ? [moved, t.node] : [t.node, moved];
  t.node["size"] = mk([["share", 1]]);
  replaceAt(f, t, w);
  return w;
}
/** edge's insertion: a new first / last child of the root, or a new root wrapping the old one. Returns the new parent. */
export function insertEdge(f: JObj, moved: JObj, side: Side, ids: Ids): JObj {
  const root = get(f, "root") as JObj;
  const type = typeOfAxis(axisOfSide(side));
  const first = side === "left" || side === "top";
  if (get(root, "t") === type) {
    const c = kidsOf(root);
    if (first) c.unshift(moved);
    else c.push(moved);
    return root;
  }
  root["size"] = shareOneKeeping(root);
  const w = mk([
    ["t", type],
    ["id", ids.next("n")],
    ["c", first ? [moved, root] : [root, moved]],
  ]);
  f["root"] = w;
  return w;
}
/** The location of a node object (by identity). */
export function locOf(f: JObj, n: JObj): Loc | undefined {
  for (const l of allLocs(f)) if (l.node === n) return l;
  return undefined;
}

// ---- home rules (LAYOUT.md §3.6) --------------------------------------------------------------------------------
/**
 * Place `leaf` (not in the form) by its registry home rules, first applicable wins; a rule applies when its target
 * exists docked (outside unknown nodes) and the result meets the placement rules. Fallback: wrap the root on the side
 * of the island's last edge rule (left if it has none). Mutates `f`.
 */
export function placeByHome(f: JObj, leaf: JObj, ids: Ids, check: (g: JObj) => boolean): void {
  const ref = refOf(leaf);
  const d = REGISTRY[kindOf(ref)] as IslandDef | undefined;
  const rules = d ? d.home : [];
  let lastEdge: Side = "left";
  for (const rule of rules) {
    const trial = clone(f);
    const lf = clone(leaf);
    const tIds = new Ids(trial);
    for (const u of ids.used) tIds.used.add(u);
    if (isStr(get(rule, "edge"))) lastEdge = get(rule, "edge") as Side;
    if (!applyHomeRule(trial, lf, rule, tIds)) continue;
    if (!check(trial)) continue;
    for (const k of Object.keys(f)) delete f[k];
    for (const k of Object.keys(trial)) f[k] = trial[k];
    for (const u of tIds.used) ids.used.add(u);
    return;
  }
  // fallback: a new root around the old one
  const root = get(f, "root") as JObj;
  const type = typeOfAxis(axisOfSide(lastEdge));
  root["size"] = shareOneKeeping(root);
  const first = lastEdge === "left" || lastEdge === "top";
  f["root"] = mk([
    ["t", type],
    ["id", ids.next("n")],
    ["c", first ? [leaf, root] : [root, leaf]],
  ]);
}

function applyHomeRule(f: JObj, leaf: JObj, rule: JObj, ids: Ids): boolean {
  if (isStr(get(rule, "edge"))) {
    insertEdge(f, leaf, get(rule, "edge") as Side, ids);
    return true;
  }
  if (isStr(get(rule, "groupEdge"))) {
    const col = groupEdgeCol(roomLocs(f));
    if (!col) return false;
    const c = kidsOf(col);
    if (get(rule, "groupEdge") === "top") c.unshift(leaf);
    else c.push(leaf);
    return true;
  }
  const beside = get(rule, "beside");
  if (!isStr(beside)) return false;
  const x = findKey(f, beside);
  if (!x || x.float >= 0 || x.inUnknown || !isIsland(x.node)) return false;
  let target: Loc = x;
  if (get(rule, "container") === true) {
    if (!x.parent) return false;
    const pl = locOf(f, x.parent);
    if (!pl || pl.inUnknown || isUnknownNode(pl.node)) return false;
    target = pl;
  }
  insertBeside(f, leaf, target, get(rule, "side") as Side, ids);
  return true;
}

/** The node types this version edits: known types outside unknown nodes. */
export const editable = (l: Loc): boolean => !l.inUnknown && isKnownType(l.node);
