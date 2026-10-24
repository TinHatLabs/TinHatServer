// normalize.ts — LAYOUT.md §4: N1-N9, after every operation and as repair's last step; idempotent.
// Never removes, unwraps or edits a node that carries unknown keys (itself or in its size), never touches unknown
// node types or unknown islands (their `c` children are normalized like any children).
import type { JObj } from "./json";
import { clone, get, has, isObj, isStr, mk, obj } from "./json";
import type { Loc } from "./form";
import {
  Ids,
  allLocs,
  carriesUnknown,
  collapseOf,
  fixSize,
  floatsOf,
  hiddenOf,
  isContainer,
  isIsland,
  isKnownType,
  isStack,
  isUnknownIsland,
  keyOf,
  kidsOf,
  refOf,
  roomLocs,
  r1ok,
  sizeHasUnknown,
} from "./form";
import { defOf } from "./schema";

export interface Normalized {
  form: JObj;
  remap: Record<string, string>;
  notes: string[];
}

/** Normalize `f` IN PLACE; returns the old → new key remapping of N2/N3 and the notes (repair uses them). */
export function normalizeInPlace(f: JObj): Normalized {
  const notes: string[] = [];
  const remap: Record<string, string> = Object.create(null);
  const note = (n: string, s: string) => notes.push(`${n} ${s}`);
  const setRemap = (from: string, to: string) => {
    for (const k of Object.keys(remap)) if (remap[k] === from) remap[k] = to;
    remap[from] = to;
  };

  // N1-N3, post-order; the root is never removed
  const norm = (n: JObj, isRoot: boolean): JObj | null => {
    if (isIsland(n)) return n;
    const c = kidsOf(n);
    if (Array.isArray(get(n, "c"))) {
      const kept: JObj[] = [];
      for (const k of c) {
        const r = isObj(k) ? norm(k, false) : k;
        if (r !== null) kept.push(r as JObj);
      }
      n["c"] = kept;
    }
    if (!isKnownType(n)) return n; // unknown node types stay (N1-N3 never remove or unwrap them)
    const kids = kidsOf(n);
    const id = get(n, "id") as string;
    if (kids.length === 0) {
      if (isRoot || carriesUnknown(n)) return n;
      note("empty-container-removed", id);
      return null;
    }
    if (kids.length === 1 && !carriesUnknown(n)) {
      const child = kids[0];
      const hoistable =
        isKnownType(child) &&
        !isUnknownIsland(child) &&
        !sizeHasUnknown(get(child, "size")) &&
        (!isRoot || isContainer(child));
      if (hoistable && (isContainer(n) || isStack(n))) {
        const s = get(n, "size");
        if (isRoot) {
          if (s !== undefined) child["size"] = s;
          else delete child["size"];
        } else {
          child["size"] = s !== undefined ? s : mkShare1();
        }
        note("single-child-unwrapped", id);
        const nk = keyOf(child);
        if (nk !== undefined) setRemap(id, nk);
        return child;
      }
    }
    return n;
  };
  const root = get(f, "root");
  if (isObj(root)) {
    f["root"] = norm(root, true) as JObj;
    // N5: the root is a row or col
    if (!isContainer(f["root"] as JObj)) {
      const ids = new Ids(f);
      const id = ids.body();
      f["root"] = mk([
        ["t", "row"],
        ["id", id],
        ["c", [f["root"] as JObj]],
      ]);
      note("root-wrapped", id);
    }
  }
  const fl = floatsOf(f);
  for (let i = 0; i < fl.length; i++) {
    const node = get(fl[i], "node");
    const r = isObj(node) ? norm(node, false) : null;
    if (r === null) {
      note("bad-float-fixed", isStr(get(fl[i], "id")) ? (get(fl[i], "id") as string) : `#${i}`);
      fl.splice(i, 1);
      i--;
    } else fl[i]["node"] = r;
  }

  const locs = allLocs(f);
  // N4: a stack's `active` names one of its children, else the first
  for (const l of locs) {
    if (!isStack(l.node)) continue;
    const refs = kidsOf(l.node).filter((k) => isIsland(k)).map((k) => refOf(k));
    if (refs.length === 0) {
      // an empty stack kept for its unknown keys names no tab
      if (has(l.node, "active")) {
        delete l.node["active"];
        note("bad-field-fixed", get(l.node, "id") as string);
      }
      continue;
    }
    const a = get(l.node, "active");
    if (!isStr(a) || !refs.includes(a)) {
      l.node["active"] = refs[0];
      note("bad-field-fixed", get(l.node, "id") as string);
    }
  }
  // N6: sizes of known nodes (not unknown islands), then the siblings' minPm sum
  for (const l of locs) {
    if (!isKnownType(l.node) || isUnknownIsland(l.node) || !has(l.node, "size")) continue;
    const r = fixSize(get(l.node, "size"));
    if (r.changed) {
      if (r.size) l.node["size"] = r.size;
      else delete l.node["size"];
      note("bad-size-fixed", keyOf(l.node) as string);
    }
  }
  for (const h of hiddenOf(f)) {
    if (!isObj(h) || !has(h, "size") || isUnknownIsland(h)) continue;
    const r = fixSize(get(h, "size"));
    if (r.changed) {
      if (r.size) h["size"] = r.size;
      else delete h["size"];
      note("bad-size-fixed", get(h, "i") as string);
    }
  }
  for (const l of locs) {
    if (!isContainer(l.node)) continue;
    const kids = kidsOf(l.node).filter((k) => isKnownType(k) && !isUnknownIsland(k));
    const pm = (k: JObj) => {
      const s = get(k, "size");
      const v = isObj(s) ? get(s, "minPm") : undefined;
      return typeof v === "number" ? v : 0;
    };
    let sum = kids.reduce((a, k) => a + pm(k), 0);
    if (sum <= 1000) continue;
    for (let i = kids.length - 1; i >= 0 && sum > 1000; i--) {
      const v = pm(kids[i]);
      if (v === 0) continue;
      delete (get(kids[i], "size") as JObj)["minPm"];
      sum -= v;
    }
    note("minpm-capped", get(l.node, "id") as string);
  }

  // N7: hidden and collapse deduplicated (first wins); remapped refs; steps whose ref is gone or whose `to` its new
  // node does not allow are dropped
  const placed = new Set<string>();
  for (const l of allLocs(f)) if (isIsland(l.node)) placed.add(refOf(l.node));
  const hid = hiddenOf(f);
  const seenH = new Set<string>();
  for (let i = 0; i < hid.length; i++) {
    const r = get(hid[i], "i") as string;
    if (placed.has(r) || seenH.has(r)) {
      note("dropped-duplicate", r);
      hid.splice(i, 1);
      i--;
      continue;
    }
    seenH.add(r);
    // a `from.parent` follows a remap only onto a container or stack (restore never accepts an island; an island's
    // ref need not even be id syntax): otherwise it stays, a stale hint
    const from = get(hid[i], "from");
    const fp = isObj(from) ? get(from, "parent") : undefined;
    if (isObj(from) && isStr(fp) && remap[fp] !== undefined) {
      const to = remap[fp];
      const l = allLocs(f).find((x) => (isContainer(x.node) || isStack(x.node)) && get(x.node, "id") === to);
      if (l) from["parent"] = to;
    }
  }
  const col = collapseOf(f);
  const rootLocs = allLocs(f).filter((l) => l.float < 0);
  const inRoot = (key: string): Loc | undefined => rootLocs.find((l) => isKnownType(l.node) && keyOf(l.node) === key);
  const seenC = new Set<string>();
  for (let i = 0; i < col.length; i++) {
    const st = col[i];
    let ref = get(st, "ref") as string;
    if (remap[ref] !== undefined) {
      ref = remap[ref];
      st["ref"] = ref;
    }
    const l = inRoot(ref);
    let ok = !!l;
    if (l && isIsland(l.node)) {
      const d = defOf(ref);
      if (d && !d.collapse.includes(get(st, "to") as string)) ok = false;
    } else if (l && get(st, "to") === "fold") ok = false;
    if (!ok) {
      note("bad-collapse-dropped", ref);
      col.splice(i, 1);
      i--;
      continue;
    }
    if (seenC.has(ref)) {
      note("dropped-duplicate", ref);
      col.splice(i, 1);
      i--;
      continue;
    }
    seenC.add(ref);
  }

  // N9: opts.composer.composerTop and opts.header.headerBottom record the room group's order in the tree
  const room = roomLocs(f);
  if (r1ok(room)) {
    const k = kidsOf(room.timeline!.parent as JObj);
    setFlag(f, "composer", "composerTop", k.indexOf(room.composer!.node) < k.indexOf(room.timeline!.node), note);
  }
  if (room.header && room.header.float < 0 && room.header.parent && get(room.header.parent, "t") === "col") {
    const k = kidsOf(room.header.parent);
    const i = k.indexOf(room.header.node);
    setFlag(f, "header", "headerBottom", k.length > 1 && i === k.length - 1, note);
  }
  return { form: f, remap, notes };
}

function mkShare1(): JObj {
  const s = obj();
  s["share"] = 1;
  return s;
}

function setFlag(f: JObj, ref: string, key: string, on: boolean, note: (n: string, s: string) => void): void {
  const opts = get(f, "opts");
  const o = isObj(opts) ? get(opts, ref) : undefined;
  const cur = isObj(o) ? get(o, key) : undefined;
  if (on) {
    if (cur === true) return;
    let oo = opts;
    if (!isObj(oo)) {
      oo = obj();
      f["opts"] = oo;
    }
    let r = get(oo, ref);
    if (!isObj(r)) {
      r = obj();
      oo[ref] = r;
    }
    r[key] = true;
    note("opts-fixed", ref);
  } else if (cur !== undefined && isObj(o)) {
    delete o[key];
    if (Object.keys(o).length === 0) delete (opts as JObj)[ref];
    note("opts-fixed", ref);
  }
}

/** A normalized copy (operations: step 5). */
export function normalize(f: JObj): Normalized {
  return normalizeInPlace(clone(f));
}
