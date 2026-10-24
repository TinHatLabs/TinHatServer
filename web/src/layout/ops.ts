// ops.ts — LAYOUT.md §8: transactional operations. applyOp(form, op, ctx) → {ok, form, remap} | {ok: false, error};
// on any error the input form is returned unchanged (the caller keeps its own copy: the input is never mutated).
// Steps: 1 resolve (by identity), 2 check preconditions, 3 mutate a copy without normalizing, 4 placement rules,
// 5 normalize once (collect the remap), 6 validate completely (limits included), 7 return.
import type { JObj, Json } from "./json";
import { clampInt, clone, fdiv, get, has, isInt, isJsonValue, isObj, isStr, mk, obj } from "./json";
import type { Loc, Side } from "./form";
import {
  ANCHORS,
  Ids,
  SIDES,
  axisOfContainer,
  basisOf,
  detach,
  findFloat,
  findKey,
  floatsOf,
  hiddenIndex,
  hiddenOf,
  insertBeside,
  insertEdge,
  isContainer,
  isIsland,
  isStack,
  isUnknownIsland,
  isUnknownNode,
  islandsIn,
  keyOf,
  kidsOf,
  locOf,
  nodesIn,
  placeByHome,
  placementError,
  refOf,
  regSizes,
  shareOneKeeping,
  sizeForAxis,
} from "./form";
import { normalizeInPlace } from "./normalize";
import { validateDesktop } from "./repair";
import type { Axis } from "./schema";
import { PRESET_NAMES, defOf, isKnownRef, isRefSyntax, presetDesktop } from "./schema";
import { solveDetail, unscale } from "./solve";

export type OpResult = { ok: true; form: JObj; remap: Record<string, string> } | { ok: false; error: string };
const fail = (error: string): OpResult => ({ ok: false, error });
const BAD = "bad-op: bad request";

/** The solve context of resize / resetSizes / dropZones: {size, unitPm, shape, content, view}. */
export function ctxSolve(form: JObj, ctx: Json | undefined) {
  const c = isObj(ctx) ? ctx : obj();
  return solveDetail(form, get(c, "size"), get(c, "unitPm"), get(c, "shape"), get(c, "content"), get(c, "view"));
}
const ctxUnit = (ctx: Json | undefined): number => {
  const u = isObj(ctx) ? get(ctx, "unitPm") : undefined;
  return isInt(u) ? clampInt(u, 500, 4000) : 1000;
};

// ---- step 1: resolve ------------------------------------------------------------------------------------------
type Moved = { loc: Loc; group: boolean } | { error: string };
function resolveMoved(f: JObj, ref: Json | undefined): Moved {
  if (!isStr(ref)) return { error: BAD };
  const l = findKey(f, ref);
  if (!l) return { error: "bad-op: island not placed" };
  if (isIsland(l.node)) {
    if (!isKnownRef(ref)) return { error: "bad-op: unknown island" };
    return { loc: l, group: false };
  }
  return { loc: l, group: true };
}
/** Step 2's read-only rule: the node is inside an unknown node, or a group holding unknown nodes / islands. */
function readOnly(l: Loc): boolean {
  if (l.inUnknown) return true;
  return nodesIn(l.node).some((n) => isUnknownNode(n) || isUnknownIsland(n));
}
const oldAxisOf = (l: Loc): Axis | null => (l.parent ? axisOfContainer(l.parent) : null);

// ---- steps 4-7 --------------------------------------------------------------------------------------------------
const LIMIT_ERRORS: Record<string, string> = {
  "too-large": "bad-layout: too large",
  "too-deep": "bad-layout: too deep",
  "too-many-nodes": "bad-layout: too many nodes",
};
function finish(f: JObj): OpResult {
  const pe = placementError(f);
  if (pe) return fail(pe);
  const n = normalizeInPlace(f);
  const v = validateDesktop(n.form);
  if (v.length) {
    const first = v[0];
    const code = first.slice(0, first.indexOf(" "));
    const subject = first.slice(first.indexOf(" ") + 1);
    if (code === "replaced-by-classic") return fail(LIMIT_ERRORS[subject] ?? "bad-layout: over a limit");
    if (code === "collapse-unsafe-dropped") return fail("bad-op: required island");
    if (code === "bad-opts-fixed") return fail(BAD);
    return fail("bad-op: locked group");
  }
  const remap: Record<string, string> = Object.create(null);
  for (const k of Object.keys(n.remap).sort()) remap[k] = n.remap[k];
  return { ok: true, form: n.form, remap };
}

// ---- the operations ----------------------------------------------------------------------------------------------
const isSide = (s: unknown): s is Side => SIDES.includes(s as Side);

/** Give an inserted node its size for the new parent (LAYOUT.md §8.2). */
function sizeAfterMove(f: JObj, n: JObj, oldParent: JObj | null, oldAxis: Axis | null, newParent: JObj, keep: boolean): void {
  if (keep) return;
  const ax = axisOfContainer(newParent) as Axis;
  if (isIsland(n)) {
    if (oldParent === newParent) return; // a reorder inside the same container keeps its size
    n["size"] = sizeForAxis(f, n, ax);
  } else if (oldAxis !== ax) n["size"] = shareOneKeeping(n);
}

function doBeside(f: JObj, moved: JObj, oldParent: JObj | null, oldAxis: Axis | null, targetKey: Json | undefined, side: Json | undefined, keep: boolean, ids: Ids): string | null {
  if (!isStr(targetKey) || !isSide(side)) return BAD;
  const t = findKey(f, targetKey);
  if (!t) return "bad-op: target not found";
  if (t.inUnknown || isUnknownIsland(t.node)) return "bad-op: read-only layout";
  const np = insertBeside(f, moved, t, side, ids);
  sizeAfterMove(f, moved, oldParent, oldAxis, np, keep);
  return null;
}
function doEdge(f: JObj, moved: JObj, oldParent: JObj | null, oldAxis: Axis | null, side: Json | undefined, keep: boolean, ids: Ids): string | null {
  if (!isSide(side)) return BAD;
  const np = insertEdge(f, moved, side, ids);
  sizeAfterMove(f, moved, oldParent, oldAxis, np, keep);
  return null;
}
function doTab(f: JObj, moved: JObj, targetKey: Json | undefined, ids: Ids): string | null {
  if (!isStr(targetKey)) return BAD;
  if (!isIsland(moved)) return "bad-op: not stackable";
  const t = findKey(f, targetKey);
  if (!t) return "bad-op: target not found";
  if (t.inUnknown || isUnknownIsland(t.node)) return "bad-op: read-only layout";
  const ref = refOf(moved);
  if (isStack(t.node)) {
    kidsOf(t.node).push(moved);
    t.node["active"] = ref;
    return null;
  }
  if (!isIsland(t.node) || defOf(refOf(t.node))?.stackable !== true) return "bad-op: not stackable";
  if (t.parent && isStack(t.parent)) {
    const c = kidsOf(t.parent);
    c.splice(c.indexOf(t.node) + 1, 0, moved);
    t.parent["active"] = ref;
    return null;
  }
  const s = mk([
    ["t", "stack"],
    ["id", ids.next("s")],
  ]);
  if (has(t.node, "size")) s["size"] = clone(t.node["size"]);
  s["active"] = ref;
  s["c"] = [t.node, moved];
  const tl = locOf(f, t.node) as Loc;
  if (tl.parent) {
    const c = kidsOf(tl.parent);
    c[c.indexOf(t.node)] = s;
  } else if (tl.float >= 0) floatsOf(f)[tl.float]["node"] = s;
  else return "bad-op: not stackable";
  return null;
}
function doFloat(f: JObj, moved: JObj, anchor: Json | undefined, dx: Json | undefined, dy: Json | undefined, reveal: Json | undefined, ids: Ids): string | null {
  const fid = ids.next("f");
  const fl = mk([
    ["id", fid],
    ["anchor", anchor as string],
    ["dx", dx as number],
    ["dy", dy as number],
  ]);
  if (isIsland(moved)) {
    const d = defOf(refOf(moved));
    if (d && d.float) {
      fl["w"] = clone(d.float.w);
      fl["h"] = clone(d.float.h);
    }
  }
  fl["reveal"] = (reveal ?? "always") as string;
  fl["node"] = moved;
  if (!has(f, "floats")) f["floats"] = [];
  floatsOf(f).push(fl);
  return null;
}

function checkFloatArgs(op: JObj): string | null {
  const a = get(op, "anchor");
  const dx = get(op, "dx");
  const dy = get(op, "dy");
  const rv = get(op, "reveal");
  if (!ANCHORS.includes(a as (typeof ANCHORS)[number])) return BAD;
  if (!isInt(dx) || !isInt(dy) || dx < -4096 || dx > 4096 || dy < -4096 || dy > 4096) return BAD;
  if (rv !== undefined && rv !== "always" && rv !== "hover") return BAD;
  return null;
}
/** Step 2 for a placement (`to`) of `n`: floatable / stackable / required (hover). */
function checkPlacement(n: JObj, to: JObj): string | null {
  const kind = get(to, "op");
  if (kind === "float") {
    const e = checkFloatArgs(to);
    if (e) return e;
    for (const r of islandsIn(n)) {
      const d = defOf(r);
      if (d && !d.floatable) return "bad-op: not floatable";
      if (d && d.required && get(to, "reveal") === "hover") return "bad-op: required island";
    }
    return null;
  }
  if (kind === "stackAsTab") {
    if (!isIsland(n)) return "bad-op: not stackable";
    if (defOf(refOf(n))?.stackable !== true) return "bad-op: not stackable";
    return null;
  }
  if (kind === "dockBeside" || kind === "edge") return null;
  return BAD;
}
/** Insert a detached node per a placement object (dockBeside / stackAsTab / edge / float). `ids` = N8 over the form
 *  as it was BEFORE the node was detached (so a moved group's own ids are never handed out again). */
function place(f: JObj, n: JObj, to: JObj, oldParent: JObj | null, oldAxis: Axis | null, keep: boolean, ids: Ids): string | null {
  switch (get(to, "op")) {
    case "dockBeside":
      return doBeside(f, n, oldParent, oldAxis, get(to, "target"), get(to, "side"), keep, ids);
    case "edge":
      return doEdge(f, n, oldParent, oldAxis, get(to, "side"), keep, ids);
    case "stackAsTab":
      return doTab(f, n, get(to, "target"), ids);
    case "float":
      return doFloat(f, n, get(to, "anchor"), get(to, "dx"), get(to, "dy"), get(to, "reveal"), ids);
  }
  return BAD;
}

/** Move a placed node (island or group) per `to`: resolve, check, detach, insert, finish. */
function moveOp(form: JObj, ref: Json | undefined, to: JObj): OpResult {
  const f = clone(form);
  const m = resolveMoved(f, ref);
  if ("error" in m) return fail(m.error);
  const { loc } = m;
  // target checks that do not need the mutation: existence, same node, inside the moved group
  const tk = get(to, "target");
  if (get(to, "op") === "dockBeside" || get(to, "op") === "stackAsTab") {
    if (!isStr(tk)) return fail(BAD);
    const t = findKey(f, tk);
    if (!t) return fail("bad-op: target not found");
    if (t.node === loc.node) return fail("bad-op: same island");
    if (nodesIn(loc.node).includes(t.node)) return fail("bad-op: target inside moved group");
    if (t.inUnknown || isUnknownIsland(t.node)) return fail("bad-op: read-only layout");
  }
  if (readOnly(loc)) return fail("bad-op: read-only layout");
  if (!loc.parent && loc.float < 0) return fail("bad-op: locked group"); // the root does not move
  const pc = checkPlacement(loc.node, to);
  if (pc) return fail(pc);
  const oldParent = loc.parent;
  const oldAxis = oldAxisOf(loc);
  const ids = new Ids(f);
  detach(f, loc);
  const e = place(f, loc.node, to, oldParent, oldAxis, false, ids);
  if (e) return fail(e);
  return finish(f);
}

function resizeOp(form: JObj, op: JObj, ctx: Json | undefined, reset: boolean): OpResult {
  const a = get(op, "a");
  const b = get(op, "b");
  const delta = get(op, "delta");
  if (!isStr(a) || !isStr(b) || (!reset && (!isInt(delta) || delta < -16384 || delta > 16384))) return fail(BAD);
  const det = ctxSolve(form, ctx);
  let rec = null;
  for (const d of det.dist.values()) {
    for (let i = 0; i + 1 < d.kids.length; i++) if (d.kids[i].key === a && d.kids[i + 1].key === b) rec = { d, i };
  }
  if (!rec) return fail("bad-op: target not found");
  const f = clone(form);
  const la = findKey(f, a);
  const lb = findKey(f, b);
  if (!la || !lb) return fail("bad-op: target not found");
  if (readOnly(la) || readOnly(lb) || isUnknownNode(la.node) || isUnknownNode(lb.node)) return fail("bad-op: read-only layout");
  const axis = rec.d.axis;
  if (reset) {
    for (const l of [la, lb]) l.node["size"] = isIsland(l.node) ? sizeForAxis(f, l.node, axis) : shareOneKeeping(l.node);
    return finish(f);
  }
  const A = rec.d.kids[rec.i];
  const B = rec.d.kids[rec.i + 1];
  const LA = A.len;
  const LB = B.len;
  const t = 4 * fdiv(LA + (delta as number) + 2, 4);
  let lo = Math.max(A.min, LA + LB - B.max);
  let hi = Math.min(A.max, LA + LB - B.min);
  // v1.2 `into: true` (§8.2, Q-RESIZEINTO): a side that is a row / col with C's axis and an effective `auto` basis passes
  // the change on to its child next to the gap (a: its last laid-out child, b: its first — repeated while that child is
  // again such a container), unless that child's basis is share; the container keeps its auto size (it follows its
  // content). The child's own bounds then limit the move too.
  type RSide = { node: JObj; eff: JObj; len: number; min: number; max: number; inner: number };
  const side = (l: typeof la, K: typeof A, first: boolean): RSide => {
    let cur: RSide = { node: l.node, eff: effectiveSize(f, l.node, axis), len: K.len, min: K.min, max: K.max, inner: rec.d.inner };
    if (get(op, "into") !== true) return cur;
    for (let guard = 0; guard < 64; guard++) {
      const n = cur.node;
      if (!isContainer(n) || axisOfContainer(n) !== axis || basisOf(cur.eff) !== "auto") break;
      const k = keyOf(n);
      const d = k ? det.dist.get(k) : undefined;
      if (!d || d.axis !== axis || d.kids.length === 0) break;
      const kid = first ? d.kids[0] : d.kids[d.kids.length - 1];
      const kl = findKey(f, kid.key);
      if (!kl || readOnly(kl) || isUnknownNode(kl.node)) break;
      const keff = effectiveSize(f, kl.node, axis);
      if (basisOf(keff) === "share") break;
      cur = { node: kl.node, eff: keff, len: kid.len, min: kid.min, max: kid.max, inner: d.inner };
    }
    return cur;
  };
  const SA = side(la, A, false);
  const SB = side(lb, B, true);
  if (SA.node !== la.node) {
    lo = Math.max(lo, LA - (SA.len - SA.min));
    hi = Math.min(hi, LA + (SA.max - SA.len));
  }
  if (SB.node !== lb.node) {
    lo = Math.max(lo, LA + SB.len - SB.max);
    hi = Math.min(hi, LA + SB.len - SB.min);
  }
  if (lo > hi) return fail("bad-op: no room");
  const nA = t < lo ? lo : t > hi ? hi : t;
  const nB = LA + LB - nA;
  const dA = nA - LA;
  const unit = ctxUnit(ctx);
  const shareA = basisOf(SA.eff) === "share";
  const shareB = basisOf(SB.eff) === "share";
  const write = (S: RSide, len: number, asPm: boolean): string | null => {
    const s = clone(S.eff);
    const basis = basisOf(s);
    const Lc = S.inner;
    for (const k of ["fixed", "share", "auto", "pm"]) delete s[k];
    if (asPm || basis === "pm") {
      if (Lc <= 0) return "bad-op: no room";
      s["pm"] = clampInt(fdiv(len * 1000 + fdiv(Lc, 2), Lc), 0, 1000);
      if (basis === "share") delete s["grow"];
    } else s["fixed"] = clampInt(unscale(len, unit), 0, 8192);
    S.node["size"] = s;
    return null;
  };
  const lenA = SA.len + dA;
  const lenB = SB.len - dA;
  let e: string | null = null;
  if (shareA && shareB) e = write(SA, lenA, true);
  else if (shareA) e = write(SB, lenB, false);
  else if (shareB) e = write(SA, lenA, false);
  else e = write(SA, lenA, false) ?? write(SB, lenB, false);
  void nB;
  if (e) return fail(e);
  return finish(f);
}
/** The stored size as solve reads it on `axis`: with a basis as stored; else the registry pref (islands) or share 1,
 *  with the stored constraints and unknown keys on top. */
function effectiveSize(f: JObj, n: JObj, axis: Axis): JObj {
  const stored = isObj(get(n, "size")) ? (get(n, "size") as JObj) : obj();
  if (basisOf(stored)) return clone(stored);
  const out = obj();
  const rs = isIsland(n) ? regSizes(f, refOf(n)) : null;
  const src = rs ? rs.pref[axis] : mk([["share", 1]]);
  for (const k of Object.keys(src)) out[k] = clone(src[k]);
  for (const k of Object.keys(stored)) out[k] = clone(stored[k]);
  return out;
}

function hideOp(form: JObj, ref: Json | undefined): OpResult {
  const f = clone(form);
  const m = resolveMoved(f, ref);
  if ("error" in m) return fail(m.error);
  const { loc } = m;
  if (readOnly(loc)) return fail("bad-op: read-only layout");
  if (!loc.parent && loc.float < 0) return fail("bad-op: locked group"); // the root
  if (m.group) return fail("bad-op: not hideable");
  const d = defOf(refOf(loc.node));
  if (d && d.required) return fail("bad-op: required island");
  if (d && !d.hideable) return fail("bad-op: not hideable");
  let from: JObj;
  if (loc.parent) from = mk([["parent", keyOf(loc.parent) as string], ["index", kidsOf(loc.parent).indexOf(loc.node)]]);
  else from = mk([["parent", get(floatsOf(f)[loc.float], "id") as string], ["index", 0]]);
  detach(f, loc);
  const leaf = loc.node;
  leaf["from"] = from;
  if (!has(f, "hidden")) f["hidden"] = [];
  hiddenOf(f).push(leaf);
  return finish(f);
}

function restoreOp(form: JObj, ref: Json | undefined, to: Json | undefined): OpResult {
  if (!isStr(ref) || (to !== undefined && !isObj(to))) return fail(BAD);
  const f = clone(form);
  const hi = hiddenIndex(f, ref);
  if (hi < 0) return fail("bad-op: island not hidden");
  if (!isKnownRef(ref)) return fail("bad-op: unknown island");
  const ids = new Ids(f);
  const leaf = hiddenOf(f).splice(hi, 1)[0];
  const from = get(leaf, "from");
  delete leaf["from"];
  if (isObj(to)) {
    if (get(to, "op") === "dockBeside" || get(to, "op") === "stackAsTab") {
      const tk = get(to, "target");
      if (!isStr(tk)) return fail(BAD);
      const t = findKey(f, tk);
      if (!t) return fail("bad-op: target not found");
      if (t.inUnknown || isUnknownIsland(t.node)) return fail("bad-op: read-only layout");
    }
    const pc = checkPlacement(leaf, to);
    if (pc) return fail(pc);
    const e = place(f, leaf, to, null, null, true, ids);
    if (e) return fail(e);
    return finish(f);
  }
  // at `from` when that node exists and accepts it, else the registry home rules
  if (isObj(from) && isStr(get(from, "parent")) && isInt(get(from, "index"))) {
    const trial = clone(f);
    const lf = clone(leaf);
    const pk = get(from, "parent") as string;
    const idx = get(from, "index") as number;
    let slot: JObj | null = null;
    const pl = findKey(trial, pk);
    if (pl && !pl.inUnknown && (isContainer(pl.node) || isStack(pl.node))) slot = pl.node;
    else {
      const fi = findFloat(trial, pk);
      const node = fi >= 0 ? get(floatsOf(trial)[fi], "node") : undefined;
      if (isObj(node) && isContainer(node)) slot = node;
    }
    if (slot && !(isStack(slot) && defOf(ref)?.stackable !== true)) {
      const c = kidsOf(slot);
      c.splice(Math.min(idx, c.length), 0, lf);
      if (placementError(trial) === null) return finish(trial);
    }
  }
  placeByHome(f, leaf, ids, (g) => placementError(g) === null);
  return finish(f);
}

function setOptOp(form: JObj, op: JObj): OpResult {
  const ref = get(op, "ref");
  const key = get(op, "key");
  if (!isRefSyntax(ref) || !isStr(key) || key.length === 0) return fail(BAD);
  if (key === "composerTop" || key === "headerBottom") return fail(BAD); // the tree records the order (N9)
  const f = clone(form);
  let opts = get(f, "opts");
  if (!isObj(opts)) {
    opts = obj();
    f["opts"] = opts;
  }
  let o = get(opts, ref);
  if (!isObj(o)) {
    o = obj();
    opts[ref] = o;
  }
  if (has(op, "value")) o[key] = clone(op["value"]);
  else {
    delete o[key];
    if (Object.keys(o).length === 0) delete opts[ref];
  }
  return finish(f);
}

/** A placement object (`to` of dock / restore): dockBeside {target, side}, stackAsTab {target}, edge {side}, float. */
function placementShapeOk(to: Json | undefined, allowFloat: boolean): boolean {
  if (!isObj(to)) return false;
  switch (get(to, "op")) {
    case "dockBeside":
      return isStr(get(to, "target")) && isSide(get(to, "side"));
    case "stackAsTab":
      return isStr(get(to, "target"));
    case "edge":
      return isSide(get(to, "side"));
    case "float":
      return allowFloat && checkFloatArgs(to) === null;
  }
  return false;
}
/** §8.1 step 1: the op object's shape (every field an operation reads, typed). */
function shapeOk(op: JObj): boolean {
  const str = (k: string) => isStr(get(op, k));
  switch (get(op, "op")) {
    case "dockBeside":
      return str("ref") && str("target") && isSide(get(op, "side"));
    case "stackAsTab":
      return str("ref") && str("target");
    case "edge":
      return str("ref") && isSide(get(op, "side"));
    case "float":
      return str("ref") && checkFloatArgs(op) === null;
    case "dock":
      return str("ref") && placementShapeOk(get(op, "to"), false);
    case "resize": {
      const d = get(op, "delta");
      const into = get(op, "into");
      return str("a") && str("b") && isInt(d) && d >= -16384 && d <= 16384 && (into === undefined || typeof into === "boolean");
    }
    case "resetSizes":
      return str("a") && str("b");
    case "hide":
      return str("ref");
    case "restore":
      return str("ref") && (!has(op, "to") || placementShapeOk(get(op, "to"), true));
    case "setOpt": {
      const k = get(op, "key");
      return isRefSyntax(get(op, "ref")) && isStr(k) && k.length > 0 && k !== "composerTop" && k !== "headerBottom";
    }
    case "applyPreset":
      return str("preset") && PRESET_NAMES.includes(get(op, "preset") as string);
    case "reset":
      return true;
  }
  return false;
}

/** LAYOUT.md §8: apply one operation. Never throws; the input is never mutated. */
export function applyOp(form: JObj, op: Json, ctx?: Json): OpResult {
  if (!isJsonValue(form) || !isObj(form) || !isJsonValue(op) || (ctx !== undefined && !isJsonValue(ctx))) return fail(BAD);
  if (!isObj(op) || !isStr(get(op, "op")) || !shapeOk(op)) return fail(BAD);
  // resize and resetSizes read lengths from a solve: they need ctx.size {w, h} (integers)
  if (get(op, "op") === "resize" || get(op, "op") === "resetSizes") {
    const sz = isObj(ctx) ? get(ctx, "size") : undefined;
    if (!isObj(sz) || !isInt(get(sz, "w")) || !isInt(get(sz, "h"))) return fail(BAD);
  }
  switch (get(op, "op")) {
    case "dockBeside":
    case "stackAsTab":
    case "edge":
      return moveOp(form, get(op, "ref"), op);
    case "float": {
      const e = checkFloatArgs(op);
      if (e) return fail(e);
      return moveOp(form, get(op, "ref"), op);
    }
    case "dock": {
      const to = get(op, "to");
      const ref = get(op, "ref");
      if (!isObj(to) || !["dockBeside", "stackAsTab", "edge"].includes(get(to, "op") as string) || !isStr(ref)) return fail(BAD);
      const fi = findFloat(form, ref);
      let key: string | undefined = ref;
      if (fi >= 0) {
        const node = get(floatsOf(form)[fi], "node");
        key = isObj(node) ? keyOf(node) : undefined;
        if (key === undefined) return fail("bad-op: read-only layout");
      } else {
        const l = findKey(form, ref);
        if (!l) return fail("bad-op: island not placed");
        if (l.float < 0) return fail("bad-op: island not placed");
      }
      return moveOp(form, key, to);
    }
    case "resize":
      return resizeOp(form, op, ctx, false);
    case "resetSizes":
      return resizeOp(form, op, ctx, true);
    case "hide":
      return hideOp(form, get(op, "ref"));
    case "restore":
      return restoreOp(form, get(op, "ref"), get(op, "to"));
    case "applyPreset":
    case "reset": {
      const name = get(op, "op") === "reset" ? "classic" : get(op, "preset");
      if (!isStr(name) || !PRESET_NAMES.includes(name)) return fail(BAD);
      return finish(presetDesktop(name) as JObj);
    }
    case "setOpt":
      return setOptOp(form, op);
  }
  return fail(BAD);
}

