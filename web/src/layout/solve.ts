// solve.ts — LAYOUT.md §7: solve(form, size, unitPm, shape, content, view) → integer rects for every island.
// Pure, integer-only (every quotient is fdiv = floor with a positive divisor), no floating point, no hash-order
// iteration. Input values are sanitized and clamped to x-tinhat.bounds before anything else (§7.1).
import type { JObj, Json } from "./json";
import { cmpCp, fdiv, get, isArr, isInt, isJsonValue, isObj, isStr, obj } from "./json";
import { fixSize, floatsOf, isContainer, isIsland, isStack, kidsOf, regSizes } from "./form";
import type { Axis, ShapeKey } from "./schema";
import { BOUNDS, MAIN, REGISTRY, SHAPE_DEFAULTS, SHAPE_KEYS, SHAPE_MIN, defOf, isCompatRef, isKnownRef } from "./schema";

/** §7.1 input caps: keys of view.sizes / active / popouts and content refs read (code-point order), forced steps. */
export const VIEW_KEY_CAP = 256;
export const FORCE_CAP = 64;
const firstKeys = (o: JObj, n: number): string[] => Object.keys(o).sort(cmpCp).slice(0, n);
const dataOrNothing = (v: Json | undefined): Json | undefined => (v !== undefined && isJsonValue(v) ? v : undefined);

const INF = 2 ** 40;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** sc(v) = sign(v) · fdiv(|v| · unitPm + 500, 1000): layout units → px, half away from zero. */
export function sc(v: number, unit: number): number {
  if (v < 0) return -sc(-v, unit);
  return fdiv(v * unit + 500, 1000);
}
/** unscale(px) = fdiv(px · 1000 + fdiv(unitPm, 2), unitPm), px ≥ 0. */
export function unscale(px: number, unit: number): number {
  return fdiv(px * 1000 + fdiv(unit, 2), unit);
}

// ---- inputs ----------------------------------------------------------------------------------------------------
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Sz {
  fixed?: number;
  share?: number;
  auto?: true;
  pm?: number;
  min?: number;
  max?: number;
  minPm?: number;
  maxPm?: number;
  grow?: number;
}
interface Content {
  w?: number;
  h?: number;
  minW?: number;
  minH?: number;
  empty?: boolean;
  collapsedH?: number;
  barH?: number;
}
export interface View {
  roomOpen: boolean;
  callShown: boolean;
  panelOpen: boolean;
  maximized: string | null;
  forceCollapse: string[];
  sizes: Record<string, Sz>;
  active: Record<string, string>;
  open: string | null;
  popouts: Set<string>;
}

const toSz = (o: JObj | undefined): Sz => {
  const s: Sz = {};
  if (!o) return s;
  for (const k of ["fixed", "share", "pm", "min", "max", "minPm", "maxPm", "grow"] as const) {
    const v = get(o, k);
    if (isInt(v)) s[k] = v;
  }
  if (get(o, "auto") === true) s.auto = true;
  return s;
};

/**
 * §7.1: the view state as solve reads it (defaults: roomOpen true, everything else off). Capabilities are enforced here:
 * `popouts` only names islands whose registry allows pop-out, `maximized` only an island whose registry is
 * `maximizable` (the call). At most 256 keys of sizes / active / popouts (code-point order) and 64 forced steps.
 */
export function readView(v: Json | undefined): View {
  const d = dataOrNothing(v);
  const o = isObj(d) ? d : obj();
  const sizes: Record<string, Sz> = Object.create(null);
  const sv = get(o, "sizes");
  if (isObj(sv)) for (const k of firstKeys(sv, VIEW_KEY_CAP)) if (isObj(sv[k])) sizes[k] = toSz(fixSize(sv[k]).size);
  const active: Record<string, string> = Object.create(null);
  const av = get(o, "active");
  if (isObj(av)) for (const k of firstKeys(av, VIEW_KEY_CAP)) if (isStr(av[k])) active[k] = av[k] as string;
  const dr = get(o, "drawer");
  const op = isObj(dr) ? get(dr, "open") : undefined;
  const fc = get(o, "forceCollapse");
  const po = get(o, "popouts");
  const mx = get(o, "maximized");
  const popouts = new Set<string>();
  if (isObj(po)) for (const k of firstKeys(po, VIEW_KEY_CAP)) if (isKnownRef(k) && defOf(k)?.popout) popouts.add(k);
  return {
    roomOpen: typeof get(o, "roomOpen") === "boolean" ? (get(o, "roomOpen") as boolean) : true,
    callShown: get(o, "callShown") === true,
    panelOpen: get(o, "panelOpen") === true,
    maximized: isStr(mx) && isKnownRef(mx) && defOf(mx)?.maximizable ? mx : null,
    forceCollapse: isArr(fc) ? [...new Set(fc.filter((x) => isStr(x)) as string[])].slice(0, FORCE_CAP) : [],
    sizes,
    active,
    open: isStr(op) ? op : null,
    popouts,
  };
}

function readContent(v0: Json | undefined): Record<string, Content> {
  const out: Record<string, Content> = Object.create(null);
  const v = dataOrNothing(v0);
  if (!isObj(v)) return out;
  const [lo, hi] = BOUNDS.contentPx;
  for (const ref of firstKeys(v, VIEW_KEY_CAP)) {
    const c = v[ref];
    if (!isObj(c)) continue;
    const r: Content = {};
    for (const k of ["w", "h", "minW", "minH", "collapsedH", "barH"] as const) {
      const x = get(c, k);
      if (isInt(x)) r[k] = clamp(x, lo, hi);
    }
    if (get(c, "empty") === true) r.empty = true;
    out[ref] = r;
  }
  return out;
}

function readShape(v0: Json | undefined, form: JObj): Record<ShapeKey, number> {
  const s = Object.create(null) as Record<ShapeKey, number>;
  const v = dataOrNothing(v0);
  const [lo, hi] = BOUNDS.layoutUnits;
  for (const k of SHAPE_KEYS) {
    const x = isObj(v) ? get(v, k) : undefined;
    s[k] = isInt(x) ? clamp(x, lo, hi) : SHAPE_DEFAULTS[k];
  }
  // the form's gap / margin override the theme's
  for (const k of ["gap", "margin"] as const) {
    const x = get(form, k);
    if (isInt(x)) s[k] = clamp(x, lo, hi);
  }
  // usable chrome (§7.1): handles, tab strips and drawer panels never shrink below their minimums
  for (const k of SHAPE_KEYS) if (s[k] < SHAPE_MIN[k]) s[k] = SHAPE_MIN[k];
  return s;
}

/**
 * §7.8 cut: r keeps out of q (with the gap g) — when they intersect, r becomes the largest of its parts above, below,
 * left of and right of q (ties: that order), or an empty rect at its corner when none is left.
 */
export function cutAround(r: Rect, q: Rect, g: number): Rect {
  if (!(r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h)) return r;
  const cands: Rect[] = [
    { x: r.x, y: r.y, w: r.w, h: q.y - g - r.y },
    { x: r.x, y: q.y + q.h + g, w: r.w, h: r.y + r.h - (q.y + q.h + g) },
    { x: r.x, y: r.y, w: q.x - g - r.x, h: r.h },
    { x: q.x + q.w + g, y: r.y, w: r.x + r.w - (q.x + q.w + g), h: r.h },
  ];
  let best: Rect | null = null;
  for (const c of cands) if (c.w > 0 && c.h > 0 && (!best || c.w * c.h > best.w * best.h)) best = c;
  return best ?? { x: r.x, y: r.y, w: 0, h: 0 };
}

// ---- the solve tree --------------------------------------------------------------------------------------------
interface SN {
  kind: "row" | "col" | "stack" | "island";
  key: string;
  ref: string;
  orig: JObj;
  unknown: boolean;
  kids: SN[];
  /** a column the solver makes (the emergency drawer's, a merged drawer's, an overflow drawer's): not in `containers` */
  synthetic?: boolean;
}
const isRowCol = (n: SN) => n.kind === "row" || n.kind === "col";
const axisOf = (n: SN): Axis => (n.kind === "row" ? "w" : "h");
const cross = (a: Axis): Axis => (a === "w" ? "h" : "w");
const lenOf = (r: Rect, a: Axis) => (a === "w" ? r.w : r.h);

/** Build a solve tree; unknown node types become cols keyed `~<preorder index>` (`~f<i>.<index>` in float i). */
function build(n: JObj, prefix: string, counter: { i: number }): SN {
  const idx = counter.i++;
  if (isIsland(n)) {
    const ref = get(n, "i") as string;
    return { kind: "island", key: ref, ref, orig: n, unknown: false, kids: [] };
  }
  const known = isContainer(n) || isStack(n);
  const kind = known ? (get(n, "t") as "row" | "col" | "stack") : "col";
  const key = known ? (get(n, "id") as string) : `~${prefix}${idx}`;
  const kids: SN[] = [];
  for (const k of kidsOf(n)) if (isObj(k)) kids.push(build(k, prefix, counter));
  return { kind, key, ref: "", orig: n, unknown: !known, kids };
}

export interface IslandOut {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  vis: boolean;
  inset?: { l?: number; r?: number };
}
export interface StackOut {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  vis: boolean;
  tabs: string[];
  active: string;
  tab: number;
}
export interface DrawerOut {
  id: string;
  side: string;
  handle: Rect;
  panel: Rect;
  open: boolean;
  scroll?: number;
  merged?: string[];
  count?: number;
  vis?: boolean;
  z?: number;
}
export interface GapOut {
  id: string;
  axis: "x" | "y";
  x: number;
  y: number;
  w: number;
  h: number;
  a: string;
  b: string;
}
export interface SolveOut {
  islands: Record<string, IslandOut>;
  stacks: Record<string, StackOut>;
  containers: Record<string, Rect & { z: number }>;
  drawers: DrawerOut[];
  gaps: GapOut[];
  collapsed: string[];
  overflow: string[];
  squeezed: string[];
  emergency: boolean;
  tooSmall?: boolean;
}
interface Chip {
  key: string;
  axis: "x" | "y";
  rect: Rect;
  refs: string[];
  z: number;
  layerOpen: boolean;
}
/** Per docked container: its distribution (operations read lengths and bounds from it; LAYOUT.md §8.6). */
export interface DistRec {
  key: string;
  axis: Axis;
  inner: number;
  kids: { key: string; len: number; min: number; max: number }[];
}
interface Rec {
  islands: Record<string, IslandOut>;
  stacks: Record<string, StackOut>;
  containers: Record<string, Rect & { z: number }>;
  rects: Map<string, Rect>;
  inner: Map<string, number>;
  gaps: GapOut[];
  overflow: string[];
  breach: Set<string>;
  squeezed: string[];
  chips: Chip[];
  dist: Map<string, DistRec>;
  tree: SN | null;
}
const newRec = (): Rec => ({
  islands: Object.create(null),
  stacks: Object.create(null),
  containers: Object.create(null),
  rects: new Map(),
  inner: new Map(),
  gaps: [],
  overflow: [],
  breach: new Set(),
  squeezed: [],
  chips: [],
  dist: new Map(),
  tree: null,
});

interface Step {
  ref: string;
  to: string;
  below?: number;
  w?: number;
  forced: boolean;
}

export interface SolveDetail {
  out: SolveOut;
  dist: Map<string, DistRec>;
  rects: Map<string, Rect>;
  host: Rect;
}

// ---- the solver --------------------------------------------------------------------------------------------------
class Solver {
  form: JObj;
  W: number;
  H: number;
  unit: number;
  shape: Record<ShapeKey, number>;
  content: Record<string, Content>;
  view: View;
  gap: number;
  margin: number;
  host: Rect;
  folded = new Set<string>();
  emergencyMode = false;
  root: SN | null;
  floatTrees: (SN | null)[];
  /** protected controls: overlays and always-floats are cut around these (§7.8, §7.10) */
  guard: Rect[] = [];
  callFloatRect: Rect | null = null;

  constructor(form: JObj, size: Json | undefined, unitPm: Json | undefined, shape: Json | undefined, content: Json | undefined, view: Json | undefined) {
    this.form = form;
    const [hlo, hhi] = BOUNDS.hostPx;
    const sz = dataOrNothing(size);
    const sw = isObj(sz) ? get(sz, "w") : undefined;
    const sh = isObj(sz) ? get(sz, "h") : undefined;
    this.W = isInt(sw) ? clamp(sw, hlo, hhi) : 0;
    this.H = isInt(sh) ? clamp(sh, hlo, hhi) : 0;
    const [ulo, uhi] = BOUNDS.unitPm;
    this.unit = isInt(unitPm) ? clamp(unitPm, ulo, uhi) : 1000;
    this.shape = readShape(shape, form);
    this.content = readContent(content);
    this.view = readView(view);
    this.gap = this.sc(this.shape.gap);
    this.margin = Math.min(this.sc(this.shape.margin), fdiv(this.W, 8), fdiv(this.H, 8));
    const m = this.margin;
    this.host = { x: m, y: m, w: Math.max(0, this.W - 2 * m), h: Math.max(0, this.H - 2 * m) };
    const r = get(form, "root");
    this.root = isObj(r) ? build(r, "", { i: 0 }) : null;
    this.floatTrees = floatsOf(form).map((f, i) => {
      const n = get(f, "node");
      return isObj(n) ? build(n, `f${i}.`, { i: 0 }) : null;
    });
  }

  sc(v: number): number {
    return sc(v, this.unit);
  }

  // ---- presence (§7.3) ----
  present(ref: string): boolean {
    if (isCompatRef(ref)) return true;
    const d = defOf(ref);
    if (!d) return false;
    if (this.view.popouts.has(ref)) return false;
    const v = this.view;
    if (!v.roomOpen && (ref === "header" || ref === "composer" || ref === "panel")) return false; // the call: callShown alone
    switch (d.presence) {
      case "room":
        return v.roomOpen;
      case "call":
        return v.callShown;
      case "open":
        return v.panelOpen;
      case "content":
        return !(this.content[ref]?.empty === true);
      default:
        return true;
    }
  }
  prune(n: SN, removed: Set<string>): SN | null {
    if (removed.has(n.key)) return null;
    if (n.kind === "island") return this.present(n.ref) ? n : null;
    const kids: SN[] = [];
    for (const k of n.kids) {
      const p = this.prune(k, removed);
      if (p) kids.push(p);
    }
    return kids.length ? { ...n, kids } : null;
  }

  // ---- sizes (§7.4) ----
  regMin(n: SN, a: Axis): number {
    if (n.kind !== "island") return 0;
    const cm = a === "w" ? this.content[n.ref]?.minW : this.content[n.ref]?.minH;
    const rs = isCompatRef(n.ref) ? null : regSizes(this.form, n.ref);
    return Math.max(rs ? this.sc(rs.min[a]) : 0, cm ?? 0);
  }
  sizeOf(n: SN, a: Axis): Sz {
    let s: Sz;
    if (n.unknown) s = { share: 1 };
    else {
      const stored = toSz(isObj(get(n.orig, "size")) ? (get(n.orig, "size") as JObj) : undefined);
      const hasBasis = stored.fixed !== undefined || stored.share !== undefined || stored.auto !== undefined || stored.pm !== undefined;
      if (hasBasis) s = stored;
      else {
        const rs = n.kind === "island" && !isCompatRef(n.ref) ? regSizes(this.form, n.ref) : null;
        s = rs ? toSz(rs.pref[a]) : { share: 1 };
        for (const k of ["min", "max", "minPm", "maxPm"] as const) if (stored[k] !== undefined) s[k] = stored[k];
      }
    }
    const ov = this.emergencyMode ? undefined : this.view.sizes[n.key];
    if (ov) {
      s = { ...s };
      if (ov.fixed !== undefined || ov.share !== undefined || ov.auto !== undefined || ov.pm !== undefined) {
        delete s.fixed;
        delete s.share;
        delete s.auto;
        delete s.pm;
        delete s.grow;
        for (const k of ["fixed", "share", "auto", "pm", "grow"] as const) if (ov[k] !== undefined) (s as Record<string, unknown>)[k] = ov[k];
      }
      for (const k of ["min", "max", "minPm", "maxPm"] as const) if (ov[k] !== undefined) s[k] = ov[k];
    }
    return s;
  }
  floorLen(n: SN, a: Axis): number {
    if (n.kind === "island") return defOf(n.ref)?.required ? this.regMin(n, a) : 0;
    if (n.kind === "stack") return 0;
    const fl = n.kids.map((c) => this.floorLen(c, a));
    if (a === axisOf(n)) return fl.reduce((x, y) => x + y, 0);
    return fl.length ? Math.max(...fl) : 0;
  }
  tabPx(): number {
    return this.sc(this.shape.tab);
  }
  cgap(n: SN): number {
    const g = get(n.orig, "gap");
    return !n.unknown && isInt(g) ? this.sc(g) : this.gap;
  }
  natural(n: SN, a: Axis): number {
    if (n.kind === "island") {
      if (this.folded.has(n.ref)) return this.regMin(n, a);
      const c = this.content[n.ref];
      const v = c ? (a === "w" ? c.w : c.h) : undefined;
      if (v !== undefined) return v;
      if (isCompatRef(n.ref)) return 0;
      const rs = regSizes(this.form, n.ref);
      const pref = rs ? toSz(rs.pref[a]) : {};
      if (pref.fixed !== undefined) return this.sc(pref.fixed);
      return this.regMin(n, a);
    }
    if (n.kind === "stack") return Math.max(...n.kids.map((c) => this.natural(c, a))) + (a === "h" ? this.tabPx() : 0);
    if (a === axisOf(n)) return n.kids.reduce((x, c) => x + this.baseLen(c, a, null), 0) + this.cgap(n) * (n.kids.length - 1);
    return Math.max(...n.kids.map((c) => this.natural(c, a)));
  }
  minLen(n: SN, a: Axis, L: number | null, along: boolean): number {
    let m = this.regMin(n, a);
    if (along) {
      const s = this.sizeOf(n, a);
      m = Math.max(m, this.sc(s.min ?? 0));
      if (L !== null && s.minPm !== undefined) m = Math.max(m, fdiv(s.minPm * L, 1000));
    }
    if (isRowCol(n)) {
      const inner =
        a === axisOf(n)
          ? n.kids.reduce((x, c) => x + this.minLen(c, a, null, true), 0) + this.cgap(n) * (n.kids.length - 1)
          : Math.max(...n.kids.map((c) => this.minLen(c, a, null, false)));
      m = Math.max(m, inner);
    } else if (n.kind === "stack") {
      m = Math.max(m, Math.max(...n.kids.map((c) => this.minLen(c, a, null, false))) + (a === "h" ? this.tabPx() : 0));
    }
    return m;
  }
  maxLen(n: SN, a: Axis, L: number | null): number {
    const s = this.sizeOf(n, a);
    let mx = INF;
    if (s.max !== undefined) mx = Math.min(mx, this.sc(s.max));
    if (s.maxPm !== undefined && L !== null) mx = Math.min(mx, fdiv(s.maxPm * L, 1000));
    return mx;
  }
  baseLen(n: SN, a: Axis, L: number | null): number {
    const s = this.sizeOf(n, a);
    const mn = this.minLen(n, a, L, true);
    const mx = Math.max(mn, this.maxLen(n, a, L));
    let b: number;
    if (s.fixed !== undefined) b = this.sc(s.fixed);
    else if (s.auto) b = this.natural(n, a);
    else if (s.pm !== undefined && L !== null) b = fdiv(s.pm * L, 1000);
    else b = mn;
    return clamp(b, mn, mx);
  }
  weight(n: SN, a: Axis): number {
    const s = this.sizeOf(n, a);
    if (s.fixed !== undefined || s.auto || s.pm !== undefined) return s.grow ?? 0;
    return s.share ?? 1;
  }

  // ---- docked distribution (§7.6) ----
  distribute(n: SN, kids: SN[], length: number, a: Axis, gFixed: number | null) {
    const k = kids.length;
    let g: number;
    if (gFixed === null) {
      g = this.cgap(n);
      if (k > 1 && g * (k - 1) > fdiv(length, 4)) g = fdiv(fdiv(length, 4), k - 1);
    } else g = gFixed;
    const L = Math.max(0, length - g * Math.max(0, k - 1));
    const base = kids.map((c) => this.baseLen(c, a, L));
    const mins = kids.map((c) => this.minLen(c, a, L, true));
    const maxs = kids.map((c, i) => Math.max(mins[i], this.maxLen(c, a, L)));
    const floors = kids.map((c) => this.floorLen(c, a));
    const wts = kids.map((c) => this.weight(c, a));
    let R = L - base.reduce((x, y) => x + y, 0);
    let over = false;
    let breach = false;
    const squeezed: number[] = [];
    if (R > 0 && wts.some((w) => w > 0)) {
      const capped = new Set<number>();
      while (R > 0) {
        const act: number[] = [];
        for (let i = 0; i < k; i++) if (wts[i] > 0 && !capped.has(i)) act.push(i);
        const S = act.reduce((x, i) => x + wts[i], 0);
        if (S === 0) break;
        let gave = 0;
        let newcap = false;
        const rems: [number, number][] = [];
        for (const i of act) {
          let add = fdiv(R * wts[i], S);
          const rem = R * wts[i] - add * S;
          const room = maxs[i] - base[i];
          if (add >= room) {
            add = room;
            capped.add(i);
            newcap = true;
          }
          base[i] += add;
          gave += add;
          rems.push([rem, i]);
        }
        R -= gave;
        if (!newcap) {
          rems.sort((p, q) => q[0] - p[0] || p[1] - q[1]);
          for (const [, i] of rems) {
            if (R <= 0) break;
            if (base[i] >= maxs[i]) continue;
            base[i] += 1;
            R -= 1;
          }
          break;
        }
      }
    } else if (R < 0) {
      over = true;
      let need = -R;
      for (const phase of [1, 2, 3]) {
        for (let i = k - 1; i >= 0; i--) {
          if (need <= 0) break;
          const s = this.sizeOf(kids[i], a);
          if (phase === 1 && !(s.auto || s.pm !== undefined)) continue;
          if (phase === 2 && s.fixed === undefined) continue;
          if (phase === 3 && floors[i] === 0) continue;
          const lo = phase === 3 ? floors[i] : mins[i];
          const take = Math.min(need, Math.max(0, base[i] - lo));
          base[i] -= take;
          need -= take;
        }
      }
      for (let i = k - 1; i >= 0; i--) {
        if (need <= 0) break;
        if (floors[i] === 0 && base[i] > 0) {
          need -= base[i] + (k > 1 ? g : 0);
          base[i] = 0;
          squeezed.push(i);
        }
      }
      if (need > 0) breach = true;
    }
    return { base, mins, maxs, g, L, over, breach, squeezed };
  }

  islandsIn(n: SN): string[] {
    return n.kind === "island" ? [n.ref] : n.kids.flatMap((c) => this.islandsIn(c));
  }

  solveNode(n: SN, r: Rect, z: number, rec: Rec, docked: boolean): void {
    rec.rects.set(n.key, r);
    if (n.kind === "island") {
      rec.islands[n.ref] = { x: r.x, y: r.y, w: r.w, h: r.h, z, vis: r.w > 0 && r.h > 0 };
      return;
    }
    if (n.kind === "stack") {
      const t = Math.min(this.tabPx(), r.h);
      const refs = n.kids.map((c) => c.ref);
      let act = this.view.active[n.key];
      if (act === undefined || !refs.includes(act)) act = get(n.orig, "active") as string;
      if (!isStr(act) || !refs.includes(act)) act = refs[0];
      rec.stacks[n.key] = { x: r.x, y: r.y, w: r.w, h: r.h, z, vis: r.w > 0 && r.h > 0, tabs: refs, active: act, tab: t };
      for (const c of n.kids) {
        this.solveNode(c, { x: r.x, y: r.y + t, w: r.w, h: r.h - t }, z, rec, false);
        rec.islands[c.ref].vis = rec.islands[c.ref].vis && c.ref === act;
      }
      return;
    }
    if (!n.synthetic) rec.containers[n.key] = { x: r.x, y: r.y, w: r.w, h: r.h, z };
    const a = axisOf(n);
    const ca = cross(a);
    const length = lenOf(r, a);
    const clen = lenOf(r, ca);
    let kids = n.kids.slice();
    const first = this.distribute(n, kids, length, a, null);
    let cur = first;
    let over = first.over;
    let breach = first.breach;
    const squeezedNodes: SN[] = [];
    const chip = Math.min(this.sc(this.shape.handle), length);
    while (cur.squeezed.length > 0) {
      const gone = new Set(cur.squeezed.map((i) => kids[i]));
      squeezedNodes.push(...kids.filter((c) => gone.has(c)));
      kids = kids.filter((c) => !gone.has(c));
      cur = this.distribute(n, kids, Math.max(0, length - (chip + first.g)), a, first.g);
      over = over || cur.over;
      breach = breach || cur.breach;
    }
    rec.inner.set(n.key, first.L);
    if (squeezedNodes.length) {
      const cr: Rect = a === "w" ? { x: r.x + r.w - chip, y: r.y, w: chip, h: r.h } : { x: r.x, y: r.y + r.h - chip, w: r.w, h: chip };
      const order = new Map(n.kids.map((c, i) => [c, i]));
      const refs = squeezedNodes
        .slice()
        .sort((p, q) => (order.get(p) as number) - (order.get(q) as number))
        .flatMap((c) => this.islandsIn(c));
      for (const ref of refs) {
        rec.islands[ref] = { x: cr.x, y: cr.y, w: 0, h: 0, z, vis: false };
        rec.squeezed.push(ref);
      }
      rec.chips.push({ key: n.key, axis: a === "w" ? "x" : "y", rect: cr, refs, z, layerOpen: true });
    }
    if (over) rec.overflow.push(n.key);
    if (breach) rec.breach.add(n.key);
    for (const c of kids) {
      if (this.minLen(c, ca, null, false) > clen) {
        if (!rec.overflow.includes(n.key)) rec.overflow.push(n.key);
        if (this.floorLen(c, ca) > clen) rec.breach.add(n.key);
      }
    }
    if (docked)
      rec.dist.set(n.key, {
        key: n.key,
        axis: a,
        inner: cur.L,
        kids: kids.map((c, i) => ({ key: c.key, len: cur.base[i], min: cur.mins[i], max: cur.maxs[i] })),
      });
    let pos = a === "w" ? r.x : r.y;
    const g = cur.g;
    let prev: string | null = null;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const ln = cur.base[i];
      const cr: Rect = a === "w" ? { x: pos, y: r.y, w: ln, h: r.h } : { x: r.x, y: pos, w: r.w, h: ln };
      if (prev !== null && z === 0) {
        const gr: Rect = a === "w" ? { x: pos - g, y: r.y, w: g, h: r.h } : { x: r.x, y: pos - g, w: r.w, h: g };
        rec.gaps.push({ id: `${n.key}/${i - 1}`, axis: a === "w" ? "x" : "y", ...gr, a: prev, b: c.key });
      }
      this.solveNode(c, cr, z, rec, docked);
      prev = c.key;
      pos += ln + g;
    }
  }

  // ---- trials, collapse (§7.5) ----
  find(n: SN | null, key: string): SN | null {
    if (!n) return null;
    if (n.key === key) return n;
    for (const c of n.kids) {
      const f = this.find(c, key);
      if (f) return f;
    }
    return null;
  }
  parentOf(n: SN, key: string): SN | null {
    for (const c of n.kids) {
      if (c.key === key) return n;
      const p = this.parentOf(c, key);
      if (p) return p;
    }
    return null;
  }
  descendants(n: SN): SN[] {
    return [n, ...n.kids.flatMap((c) => this.descendants(c))];
  }
  trial(removed: Set<string>, full: SN): Rec {
    const tree = this.prune(full, removed);
    const rec = newRec();
    if (tree) this.solveNode(tree, this.host, 0, rec, true);
    rec.tree = tree;
    return rec;
  }
  belowFloor(rec: Rec, under: Set<string> | null): boolean {
    for (const ref of Object.keys(rec.islands)) {
      const r = rec.islands[ref];
      if (!defOf(ref)?.required || r.z !== 0) continue;
      if (under && !under.has(ref)) continue;
      const node = { kind: "island", key: ref, ref, orig: obj(), unknown: false, kids: [] } as SN;
      if (r.w < this.regMin(node, "w") || r.h < this.regMin(node, "h")) return true;
    }
    return false;
  }
  breached(rec: Rec): boolean {
    return rec.breach.size > 0 || this.belowFloor(rec, null);
  }
  /** A step's subtree in the form holds a room-group island or the call (§3.4 safety). */
  unsafe(key: string): boolean {
    const n = this.root ? this.find(this.root, key) : null;
    return !!n && this.islandsIn(n).some((r) => MAIN.includes(r));
  }
  canFold(key: string, node: SN): boolean {
    return node.kind === "island" && !!defOf(key)?.collapse.includes("fold");
  }
  condition(st: Step, rec: Rec): boolean {
    if (st.forced) return true;
    const tree = rec.tree;
    if (!tree) return false;
    const par = this.parentOf(tree, st.ref);
    const P = par ?? tree;
    const prect = par ? rec.rects.get(par.key) : this.host;
    // a parent squeezed out of its own container is not laid out: length 0, and it counts as overflowed
    if (!prect) return true;
    const plen = P.kind === "row" ? prect.w : prect.h;
    if (st.below !== undefined) return plen < this.sc(st.below);
    const sub = this.descendants(P);
    if (sub.some((d) => rec.overflow.includes(d.key))) return true;
    return this.belowFloor(rec, new Set(this.islandsIn(P)));
  }
  /** A step takes part in a trial when its node is in the working tree, it is safe, and a fold can fold. */
  eligible(st: Step, rec: Rec): boolean {
    const node = this.find(rec.tree, st.ref);
    if (!node || this.unsafe(st.ref)) return false;
    if (st.to === "fold" && !this.canFold(st.ref, node)) return false;
    return true;
  }
  effects(applied: Step[]): Set<string> {
    return new Set(applied.filter((s) => s.to !== "fold").map((s) => s.ref));
  }

  run(): SolveDetail {
    const out: SolveOut = {
      islands: Object.create(null),
      stacks: Object.create(null),
      containers: Object.create(null),
      drawers: [],
      gaps: [],
      collapsed: [],
      overflow: [],
      squeezed: [],
      emergency: false,
    };
    const res: SolveDetail = { out, dist: new Map(), rects: new Map(), host: { ...this.host } };
    const mx = this.view.maximized;
    if (mx !== null && this.placedPresent(mx)) {
      const h = this.host;
      out.islands[mx] = { x: h.x, y: h.y, w: h.w, h: h.h, z: 0, vis: h.w > 0 && h.h > 0 };
      return res;
    }
    const full = this.root ? this.prune(this.root, new Set()) : null;
    if (!full) {
      const chips: Chip[] = [];
      this.setGuard(null);
      this.placeFloats(out, chips);
      this.placeChips(chips, out);
      return res;
    }
    // steps: forced (view.forceCollapse) first, then the form's
    const formSteps: Step[] = [];
    for (const s of isArr(get(this.form, "collapse")) ? (get(this.form, "collapse") as JObj[]) : []) {
      const st: Step = { ref: get(s, "ref") as string, to: get(s, "to") as string, forced: false };
      if (isInt(get(s, "below"))) st.below = get(s, "below") as number;
      if (isInt(get(s, "w"))) st.w = get(s, "w") as number;
      formSteps.push(st);
    }
    const byRef = new Map<string, Step>();
    for (const s of formSteps) if (!byRef.has(s.ref)) byRef.set(s.ref, s);
    const steps: Step[] = [];
    for (const ref of this.view.forceCollapse) {
      const node = this.find(full, ref);
      const fs = byRef.get(ref);
      const to = fs ? fs.to : node && node.kind !== "island" ? "drawer" : "hide";
      steps.push({ ref, to, below: fs?.below, w: fs?.w, forced: true });
    }
    const forcedRefs = new Set(this.view.forceCollapse);
    for (const s of formSteps) if (!forcedRefs.has(s.ref)) steps.push(s);
    let applied: Step[] = [];
    for (const st of steps) {
      const rec = this.trial(this.effects(applied), full);
      if (!this.eligible(st, rec)) continue;
      if (this.condition(st, rec)) {
        applied.push(st);
        if (st.to === "fold") this.folded.add(st.ref);
      }
    }
    // fixpoint (Q-FIXPOINT): a later step can shrink an earlier step's parent (a share container follows its content's
    // minimum), so apply the first not-applied eligible step whose condition now holds, until none does
    for (;;) {
      const rec = this.trial(this.effects(applied), full);
      const next = steps.find((st) => !applied.includes(st) && this.eligible(st, rec) && this.condition(st, rec));
      if (!next) break;
      applied.push(next);
      if (next.to === "fold") this.folded.add(next.ref);
    }
    for (const st of applied.slice().reverse()) {
      if (st.forced) continue;
      const rest = applied.filter((x) => x !== st);
      const saved = new Set(this.folded);
      if (st.to === "fold") this.folded.delete(st.ref);
      const rec = this.trial(this.effects(rest), full);
      let ok = !this.breached(rec);
      if (ok) {
        for (const other of steps) {
          if (rest.includes(other)) continue;
          if (!this.eligible(other, rec)) continue;
          if (this.condition(other, rec)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) applied = rest;
      else this.folded = saved;
    }
    out.collapsed = applied.map((s) => `${s.ref}:${s.to}`);
    const eff = this.effects(applied);
    const fin = this.trial(eff, full);
    this.setGuard(fin);
    if (this.breached(fin) || this.floatCallBreach()) {
      this.emergency(full, out);
      return res;
    }
    Object.assign(out.islands, fin.islands);
    Object.assign(out.stacks, fin.stacks);
    Object.assign(out.containers, fin.containers);
    out.gaps.push(...fin.gaps);
    out.overflow.push(...fin.overflow);
    out.squeezed.push(...fin.squeezed);
    const chips: Chip[] = fin.chips.slice();
    res.dist = fin.dist;
    res.rects = fin.rects;
    for (const s of applied) if (s.to === "overlay") this.placeOverlay(s, full, fin, eff, out, chips);
    this.placeFloats(out, chips);
    const drawers = applied.filter((s) => s.to === "drawer").map((s) => ({ ref: s.ref, w: s.w, node: this.pruneFor(full, s.ref, eff) }));
    this.placeDrawers(drawers, full, out, chips, null);
    this.placeChips(chips, out);
    return res;
  }

  /** The step's node from the uncollapsed tree, without the nodes other applied steps removed. */
  pruneFor(full: SN, key: string, eff: Set<string>): SN | null {
    const node = this.find(full, key);
    if (!node) return null;
    const others = new Set(eff);
    others.delete(key);
    return this.prune(node, others);
  }

  placedPresent(ref: string): boolean {
    if (!this.present(ref)) return false;
    const inTree = (n: SN | null): boolean => !!n && (n.ref === ref && n.kind === "island" ? true : n.kids.some(inTree));
    return inTree(this.root) || this.floatTrees.some(inTree);
  }

  // ---- overlays (§7.8) ----
  placeOverlay(st: Step, full: SN, fin: Rec, eff: Set<string>, out: SolveOut, chips: Chip[]): void {
    const par = this.parentOf(full, st.ref);
    const node = this.pruneFor(full, st.ref, eff);
    if (!par || !node) return;
    const a: Axis = par.kind === "row" ? "w" : "h";
    const ca = cross(a);
    const prect = fin.rects.get(par.key) ?? this.host;
    const plen = lenOf(prect, a);
    const inner = fin.inner.get(par.key) ?? plen;
    const ln = Math.min(this.baseLen(node, a, inner), plen);
    const finPar = fin.tree ? this.find(fin.tree, par.key) : null;
    const remaining = new Set(finPar ? finPar.kids.map((c) => c.key) : []);
    const idx = par.kids.findIndex((c) => c.key === st.ref);
    const last = par.kids.slice(idx + 1).every((c) => !remaining.has(c.key));
    const r: Rect =
      a === "w"
        ? { x: last ? prect.x + prect.w - ln : prect.x, y: prect.y, w: ln, h: lenOf(prect, ca) }
        : { x: prect.x, y: last ? prect.y + prect.h - ln : prect.y, w: lenOf(prect, ca), h: ln };
    let rr = r;
    for (const q of this.guard) rr = cutAround(rr, q, this.gap); // never over the composer or the call
    const rec = newRec();
    this.solveNode(node, rr, 2, rec, false);
    Object.assign(out.islands, rec.islands);
    Object.assign(out.stacks, rec.stacks);
    Object.assign(out.containers, rec.containers);
    chips.push(...rec.chips);
    out.squeezed.push(...rec.squeezed);
  }

  // ---- drawers (§7.9) ----
  hx(): number {
    return Math.min(Math.max(this.margin, 4), fdiv(this.W, 8), fdiv(this.H, 8));
  }
  /** the handle size: at most half of what is between the two handle margins, so the sides never meet (§7.9) */
  hs(): number {
    const hx = this.hx();
    return Math.max(0, Math.min(this.sc(this.shape.handle), fdiv(this.W - 2 * hx - 4, 2), this.H - 2 * hx));
  }
  placeDrawers(
    list: { ref: string; w?: number; node: SN | null }[],
    full: SN,
    out: SolveOut,
    chips: Chip[],
    sideRect: Rect | null,
  ): void {
    const items = list.filter((d) => d.node !== null) as { ref: string; w?: number; node: SN }[];
    if (!items.length) return;
    const hx = this.hx();
    const hs = this.hs();
    const pad = this.sc(this.shape.drawerPad);
    // the side of a drawer: its node's rect in the uncollapsed trial (every present node, no steps, no folds)
    let sideRec: Rec | null = null;
    if (!sideRect) {
      const saved = this.folded;
      this.folded = new Set();
      sideRec = this.trial(new Set(), full);
      this.folded = saved;
    }
    const kmax = Math.max(1, fdiv(this.W - 2 * hx + 4, 2 * (hs + 4)));
    const groups: Record<"l" | "r", { ref: string; w?: number; node: SN; merged?: string[] }[]> = { l: [], r: [] };
    for (const d of items) {
      const nr = sideRect ?? (sideRec as Rec).rects.get(d.ref) ?? this.host;
      const side = 2 * nr.x + nr.w > 2 * this.host.x + this.host.w ? "r" : "l";
      groups[side].push(d);
    }
    const open = this.view.open;
    for (const side of ["l", "r"] as const) {
      let g = groups[side];
      if (g.length > kmax) {
        const head = g.slice(0, kmax - 1);
        const tail = g.slice(kmax - 1);
        const mergedNode: SN = { kind: "col", key: `~m.${tail[0].ref}`, ref: "", orig: obj(), unknown: true, kids: tail.map((t) => t.node), synthetic: true };
        g = [...head, { ref: tail[0].ref, node: mergedNode, merged: tail.map((t) => t.ref) }];
      }
      for (let k = 0; k < g.length; k++) {
        const d = g[k];
        const hxk = hx + k * (hs + 4);
        const handle: Rect = { x: side === "l" ? hxk : this.W - hxk - hs, y: hx, w: hs, h: hs };
        let pw: number;
        // a stored drawer width counts, but never below the usable minimum (x-tinhat.bounds.shapeMin.drawerW)
        if (d.w !== undefined) pw = this.sc(Math.max(d.w, SHAPE_MIN.drawerW));
        else {
          const nat = this.natural(d.node, "w");
          pw = nat > 0 ? Math.min(this.sc(this.shape.drawerW), nat + 2 * pad) : this.sc(this.shape.drawerW);
        }
        pw = Math.min(pw, Math.max(0, this.W - 2 * hx));
        const py = Math.min(hx + hs + 4, Math.max(0, this.H - hx));
        let ph = Math.max(200, Math.min(this.sc(680), fdiv(this.H * 820, 1000), this.H - 94));
        ph = Math.max(0, Math.min(ph, this.H - hx - py));
        const px = side === "l" ? hx : this.W - hx - pw;
        const pd = Math.min(pad, fdiv(pw, 4), fdiv(ph, 4));
        const iw = Math.max(0, pw - 2 * pd);
        const ih = Math.max(0, ph - 2 * pd);
        const ch = Math.max(ih, this.minLen(d.node, "h", null, false));
        const rec = newRec();
        this.solveNode(d.node, { x: px + pd, y: py + pd, w: iw, h: ch }, 20, rec, false);
        const ids = d.merged ?? [d.ref];
        const isOpen = open !== null && ids.includes(open);
        this.mergeLayer(rec, out, chips, isOpen);
        const dr: DrawerOut = { id: d.ref, side, handle, panel: { x: px, y: py, w: pw, h: ph }, open: isOpen };
        if (ch > ih) dr.scroll = ch;
        if (d.merged) dr.merged = d.merged;
        out.drawers.push(dr);
        for (const k2 of Object.keys(out.islands)) {
          const r = out.islands[k2];
          if (r.z !== 0 || r.w <= 0 || r.h <= 0) continue;
          if (r.x < handle.x + hs && handle.x < r.x + r.w && r.y < handle.y + hs && handle.y < r.y + r.h) {
            const ins = { ...(r.inset ?? {}) };
            if (side === "l") ins.l = Math.max(ins.l ?? 0, handle.x + hs + 2 - r.x);
            else ins.r = Math.max(ins.r ?? 0, r.x + r.w - handle.x + 2);
            r.inset = ins;
          }
        }
      }
    }
  }
  /** Copy a layer's islands / stacks / containers into the output; `open` = the layer is shown. */
  mergeLayer(rec: Rec, out: SolveOut, chips: Chip[], open: boolean): void {
    for (const k of Object.keys(rec.islands)) {
      const r = rec.islands[k];
      r.vis = r.vis && open;
      out.islands[k] = r;
    }
    for (const k of Object.keys(rec.stacks)) {
      const s = rec.stacks[k];
      s.vis = s.vis && open;
      out.stacks[k] = s;
    }
    for (const k of Object.keys(rec.containers)) out.containers[k] = rec.containers[k];
    for (const c of rec.chips) chips.push({ ...c, layerOpen: c.layerOpen && open });
    out.squeezed.push(...rec.squeezed);
  }

  // ---- overflow chips (§7.6, §7.9) ----
  placeChips(chips: Chip[], out: SolveOut): void {
    const hx = this.hx();
    const pad = this.sc(this.shape.drawerPad);
    const open = this.view.open;
    for (const c of chips) {
      const { x: cx, y: cy, w: cw, h: chh } = c.rect;
      // the panel is a plain scrolling list (§7.9): each island at its natural height, at least its registry minimum,
      // the form gap between them — no size constraints, no view overrides, no distribution, so nothing can be squeezed
      // a second time
      const kids: SN[] = c.refs.map((ref) => ({ kind: "island", key: ref, ref, orig: obj(), unknown: false, kids: [] }) as SN);
      const hts = kids.map((k) => Math.max(this.natural(k, "h"), this.regMin(k, "h")));
      const listH = hts.reduce((a, b) => a + b, 0) + this.gap * Math.max(0, kids.length - 1);
      let pw = Math.min(this.sc(this.shape.drawerW), Math.max(...kids.map((k) => this.natural(k, "w"))) + 2 * pad, Math.max(0, this.W - 2 * hx));
      const want = listH + 2 * pad;
      const room: Record<string, number> = {
        below: this.H - hx - (cy + chh + 4),
        above: cy - 4 - hx,
        right: this.W - hx - (cx + cw + 4),
        left: cx - 4 - hx,
      };
      const pref = c.axis === "x" ? ["below", "above", "right", "left"] : ["right", "left", "below", "above"];
      const need: Record<string, number> = { below: Math.min(want, 200), above: Math.min(want, 200), right: pw, left: pw };
      let side = pref.find((k) => room[k] >= need[k]);
      if (side === undefined) {
        side = pref[0];
        for (const k of pref) if (room[k] > room[side]) side = k;
      }
      let px: number;
      let py: number;
      let ph: number;
      if (side === "below" || side === "above") {
        ph = Math.max(0, Math.min(want, room[side]));
        py = side === "below" ? cy + chh + 4 : cy - 4 - ph;
        px = cx + cw - pw;
      } else {
        pw = Math.max(0, Math.min(pw, room[side]));
        ph = Math.max(0, Math.min(want, this.H - 2 * hx));
        px = side === "right" ? cx + cw + 4 : cx - 4 - pw;
        py = cy + chh - ph;
      }
      px = clamp(px, hx, Math.max(hx, this.W - hx - pw));
      py = clamp(py, hx, Math.max(hx, this.H - hx - ph));
      pw = Math.max(0, Math.min(pw, this.W - hx - px));
      ph = Math.max(0, Math.min(ph, this.H - hx - py));
      const pd = Math.min(pad, fdiv(pw, 4), fdiv(ph, 4));
      const iw = Math.max(0, pw - 2 * pd);
      const ih = Math.max(0, ph - 2 * pd);
      const chn = Math.max(ih, listH);
      const id = `overflow-${c.key}`;
      const isOpen = open === id;
      let y = py + pd;
      for (let i = 0; i < kids.length; i++) {
        out.islands[kids[i].ref] = { x: px + pd, y, w: iw, h: hts[i], z: 20, vis: iw > 0 && hts[i] > 0 && isOpen };
        y += hts[i] + this.gap;
      }
      const dr: DrawerOut = { id, side: "chip", handle: { ...c.rect }, panel: { x: px, y: py, w: pw, h: ph }, open: isOpen, count: c.refs.length, vis: c.layerOpen, z: c.z };
      if (chn > ih) dr.scroll = chn;
      out.drawers.push(dr);
    }
  }

  // ---- floats (§7.10) ----
  floatLen(spec: Sz, auto: boolean, node: SN, a: Axis, hostLen: number, hover: boolean): number {
    let v: number;
    if (spec.fixed !== undefined) v = this.sc(spec.fixed);
    else if (spec.pm !== undefined) v = fdiv(spec.pm * hostLen, 1000);
    else v = this.natural(node, a);
    void auto;
    const lo = Math.max(this.sc(spec.min ?? 0), fdiv((spec.minPm ?? 0) * hostLen, 1000));
    let hi = INF;
    if (spec.max !== undefined) hi = Math.min(hi, this.sc(spec.max));
    if (spec.maxPm !== undefined) hi = Math.min(hi, fdiv(spec.maxPm * hostLen, 1000));
    v = clamp(v, lo, Math.max(lo, hi));
    if (hover) v = Math.max(v, Math.min(this.hs(), hostLen));
    return clamp(v, 0, hostLen);
  }
  floatGeom(f: JObj, node: SN): Rect {
    const h = this.host;
    const ref0 = node.kind === "island" ? node.ref : null;
    const d = ref0 ? defOf(ref0) : undefined;
    const spec = (k: "w" | "h"): Sz => {
      const v = get(f, k);
      if (isObj(v)) return toSz(v);
      if (d && d.float) return toSz(d.float[k]);
      return { auto: true };
    };
    const hover = get(f, "reveal") === "hover";
    const fw = this.floatLen(spec("w"), true, node, "w", h.w, hover);
    const fh = this.floatLen(spec("h"), true, node, "h", h.h, hover);
    const dx = this.sc(isInt(get(f, "dx")) ? (get(f, "dx") as number) : 0);
    const dy = this.sc(isInt(get(f, "dy")) ? (get(f, "dy") as number) : 0);
    const an = get(f, "anchor") as string;
    const fx = an.includes("l") ? h.x + dx : an.includes("r") ? h.x + h.w - fw - dx : h.x + fdiv(h.w - fw, 2) + dx;
    const fy = an.startsWith("t") ? h.y + dy : an.startsWith("b") ? h.y + h.h - fh - dy : h.y + fdiv(h.h - fh, 2) + dy;
    let r: Rect = { x: clamp(fx, h.x, h.x + h.w - fw), y: clamp(fy, h.y, h.y + h.h - fh), w: fw, h: fh };
    if (hover) return r; // a hover float opens on demand, like a drawer
    const own = this.islandsIn(node).includes("call");
    for (const q of this.guard) if (!(own && q === this.callFloatRect)) r = cutAround(r, q, this.gap);
    return r;
  }
  /** The protected controls (§7.8, §7.10): the visible docked composer and call, then a floating call's rect. */
  setGuard(fin: Rec | null): void {
    this.guard = [];
    this.callFloatRect = null;
    if (fin) {
      for (const ref of ["composer", "call"]) {
        const r = fin.islands[ref];
        if (r && r.z === 0 && r.vis) this.guard.push({ x: r.x, y: r.y, w: r.w, h: r.h });
      }
    }
    const fl = floatsOf(this.form);
    for (let i = 0; i < fl.length; i++) {
      const t = this.floatTrees[i];
      const node = t ? this.prune(t, new Set()) : null;
      if (!node || !this.islandsIn(node).includes("call")) continue;
      const rec = newRec();
      this.solveNode(node, this.floatGeom(fl[i], node), 10 + i, rec, false);
      const c = rec.islands["call"];
      if (c && c.vis) {
        this.callFloatRect = { x: c.x, y: c.y, w: c.w, h: c.h };
        this.guard.push(this.callFloatRect);
      }
      break;
    }
  }
  floatCallBreach(): boolean {
    const fl = floatsOf(this.form);
    for (let i = 0; i < fl.length; i++) {
      const t = this.floatTrees[i];
      const node = t ? this.prune(t, new Set()) : null;
      if (!node || !this.islandsIn(node).includes("call")) continue;
      const rec = newRec();
      this.solveNode(node, this.floatGeom(fl[i], node), 10 + i, rec, false);
      const c = rec.islands["call"];
      const cn = { kind: "island", key: "call", ref: "call", orig: obj(), unknown: false, kids: [] } as SN;
      if (!c || c.w < this.regMin(cn, "w") || c.h < this.regMin(cn, "h") || rec.breach.size > 0) return true;
    }
    return false;
  }
  placeFloats(out: SolveOut, chips: Chip[]): void {
    const fl = floatsOf(this.form);
    const hs = this.hs();
    for (let i = 0; i < fl.length; i++) {
      const t = this.floatTrees[i];
      const node = t ? this.prune(t, new Set()) : null;
      if (!node) continue;
      const f = fl[i];
      const g = this.floatGeom(f, node);
      const rec = newRec();
      this.solveNode(node, g, 10 + i, rec, false);
      const hover = get(f, "reveal") === "hover";
      const isOpen = !hover || this.view.open === get(f, "id");
      this.mergeLayer(rec, out, chips, isOpen);
      if (hover) {
        const an = get(f, "anchor") as string;
        let hxp = an.includes("l") ? g.x : an.includes("r") ? g.x + g.w - hs : g.x + fdiv(g.w - hs, 2);
        let hyp = an.startsWith("t") ? g.y : an.startsWith("b") ? g.y + g.h - hs : g.y + fdiv(g.h - hs, 2);
        hxp = clamp(hxp, 0, Math.max(0, this.W - hs));
        hyp = clamp(hyp, 0, Math.max(0, this.H - hs));
        out.drawers.push({ id: get(f, "id") as string, side: an, handle: { x: hxp, y: hyp, w: hs, h: hs }, panel: g, open: isOpen });
      }
    }
  }

  // ---- the emergency arrangement (§7.11) ----
  emergency(full: SN, out: SolveOut): void {
    this.emergencyMode = true;
    this.folded = new Set();
    out.islands = Object.create(null);
    out.stacks = Object.create(null);
    out.containers = Object.create(null);
    out.drawers = [];
    out.gaps = [];
    out.overflow = [];
    out.squeezed = [];
    out.emergency = true;
    out.collapsed = ["emergency"];
    const g = this.gap;
    const h = this.host;
    const subtrees: SN[] = [];
    const loose: SN[] = [];
    const isMainOrPanel = (r: string) => MAIN.includes(r) || r === "panel";
    const walk = (n: SN) => {
      const refs = this.islandsIn(n);
      if (!refs.some(isMainOrPanel)) {
        subtrees.push(n);
        return;
      }
      if (n.kind === "island") return;
      for (const c of n.kids) walk(c);
    };
    walk(full);
    const refs = this.islandsIn(full);
    const fl = floatsOf(this.form);
    for (let i = 0; i < fl.length; i++) {
      const t = this.floatTrees[i];
      const node = t ? this.prune(t, new Set()) : null;
      if (!node) continue;
      for (const r of this.islandsIn(node)) {
        if (r === "call" || r === "panel") refs.push(r);
        else if (!isMainOrPanel(r)) loose.push({ kind: "island", key: r, ref: r, orig: obj(), unknown: false, kids: [] });
      }
    }
    const opts = get(this.form, "opts");
    const flag = (ref: string, k: string) => {
      const o = isObj(opts) ? get(opts, ref) : undefined;
      return isObj(o) && get(o, k) === true;
    };
    const room = flag("composer", "composerTop") ? ["composer", "timeline"] : ["timeline", "composer"];
    const hb = flag("header", "headerBottom");
    const order0 = [...(hb ? [] : ["header"]), "call", ...room, ...(hb ? ["header"] : [])].filter((r) => refs.includes(r));
    const isl = (r: string) => ({ kind: "island", key: r, ref: r, orig: obj(), unknown: false, kids: [] }) as SN;
    const nat = (r: string) => this.natural(isl(r), "h");
    const fl2 = (r: string) => this.regMin(isl(r), "h");
    const has2 = (r: string) => order0.includes(r);
    const comp = has2("composer") ? Math.max(nat("composer"), fl2("composer")) : 0;
    const cc = this.content["call"];
    // the call's usable minimum: its control bar, never below the registry's `bar` (a measurement cannot hide it)
    const callB = has2("call") ? Math.max(this.sc(REGISTRY["call"].bar), cc?.barH ?? 0) : 0;
    const callC = has2("call") ? Math.max(cc?.collapsedH ?? fl2("call"), callB) : 0;
    const callN = has2("call") ? Math.max(nat("call"), callC) : 0;
    const head = has2("header") ? nat("header") : 0;
    const tlf = has2("timeline") ? fl2("timeline") : 0;
    const callOn = has2("call");
    const A = (o: string[]) => h.h - g * Math.max(0, o.length - 1);
    let lens: Record<string, number> | null = null;
    let order: string[] = [];
    let tooSmall = false;
    for (const drop of [[], ["header"], ["header", "timeline"]]) {
      const o = order0.filter((r) => !drop.includes(r));
      if (!o.includes("call") && !o.includes("composer") && !o.includes("timeline")) continue;
      const a = A(o);
      const hd = o.includes("header") ? head : 0;
      const tf = o.includes("timeline") ? tlf : 0;
      const call = callOn ? clamp(a - comp - hd - tf, callC, callN) : 0;
      const rest = a - comp - hd - call;
      if (rest >= tf && (!o.includes("timeline") || rest > 0)) {
        lens = { header: hd, call, composer: comp, timeline: rest };
        order = o;
        break;
      }
    }
    if (lens === null) {
      const o = order0.filter((r) => r === "call" || r === "composer");
      const a = A(o);
      if (callOn && o.includes("composer") && a >= callB + comp) {
        lens = { call: Math.min(callC, a - comp), composer: comp };
        order = o;
      } else if (callOn && h.h >= callB) {
        lens = { call: Math.min(callN, h.h) };
        order = ["call"];
      } else if (!callOn && o.includes("composer") && h.h >= comp) {
        lens = { composer: h.h };
        order = ["composer"];
      } else {
        const keep = callOn ? "call" : o.includes("composer") ? "composer" : has2("timeline") ? "timeline" : null;
        lens = keep ? { [keep]: h.h } : {};
        order = keep ? [keep] : [];
        tooSmall = true;
      }
    }
    let y = h.y;
    for (const r of order) {
      const ln = lens[r];
      out.islands[r] = { x: h.x, y, w: h.w, h: ln, z: 0, vis: ln > 0 && h.w > 0 };
      y += ln + g;
    }
    for (const r of MAIN) if (refs.includes(r) && !order.includes(r)) out.islands[r] = { x: h.x, y: h.y, w: 0, h: 0, z: 0, vis: false };
    if (tooSmall) out.tooSmall = true;
    if (refs.includes("panel")) {
      const t = out.islands["timeline"];
      const pw = Math.min(this.sc(324), h.w);
      out.islands["panel"] =
        t && t.vis ? { x: h.x + h.w - pw, y: t.y, w: pw, h: t.h, z: 2, vis: pw > 0 } : { x: h.x, y: h.y, w: 0, h: 0, z: 2, vis: false };
    }
    const kids = [...subtrees, ...loose];
    if (kids.length) {
      const node: SN = kids.length === 1 ? kids[0] : { kind: "col", key: "emergency", ref: "", orig: obj(), unknown: true, kids, synthetic: true };
      const chips: Chip[] = [];
      this.placeDrawers([{ ref: "emergency", node }], full, out, chips, { x: h.x, y: h.y, w: 0, h: h.h });
      this.placeChips(chips, out);
    }
  }
}

/** §1.4: a form that is not a JSON object is solved as an empty form (no root: floats only, i.e. nothing). */
const formOrEmpty = (form: unknown): JObj => (isObj(form) && isJsonValue(form) ? form : obj());

/** LAYOUT.md §7: the solver's entry point. `form` must be a valid (repaired) desktop form or an internal preset. */
export function solve(
  form: JObj,
  size: Json | undefined,
  unitPm?: Json,
  shape?: Json,
  content?: Json,
  view?: Json,
): SolveOut {
  return new Solver(formOrEmpty(form), size, unitPm, shape, content, view).run().out;
}
/** solve + the docked distribution records the operations read (resize, resetSizes, dropZones). */
export function solveDetail(form: JObj, size: Json | undefined, unitPm?: Json, shape?: Json, content?: Json, view?: Json): SolveDetail {
  return new Solver(formOrEmpty(form), size, unitPm, shape, content, view).run();
}

/** The canonical JSON value of a solve output (inset/scroll/merged/count/vis/tooSmall only when present). */
export function outJson(o: SolveOut): JObj {
  return JSON.parse(JSON.stringify(o)) as JObj;
}
