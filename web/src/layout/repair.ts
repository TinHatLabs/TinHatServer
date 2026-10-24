// repair.ts — LAYOUT.md §5: any JSON text or value → a valid projection + notes (never throws), and validate() =
// the notes repair would produce (minus the informational ones). The raw value is never modified.
import type { JObj, Json } from "./json";
import { canonBytes, clampInt, clone, get, has, isArr, isInt, isJsonValue, isObj, isStr, mk, readJson, sortedKeys } from "./json";
import type { Loc } from "./form";
import {
  ANCHORS,
  Ids,
  STEP_TOS,
  allLocs,
  detach,
  findKey,
  fixSize,
  floatsOf,
  groupEdgeCol,
  hiddenIndex,
  hiddenOf,
  insertBeside,
  isContainer,
  isIsland,
  isKnownType,
  isNode,
  isStack,
  islandsIn,
  keyOf,
  kidsOf,
  locOf,
  placeByHome,
  refOf,
  roomLocs,
  r1ok,
  r2ok,
  tOf,
  timelineCol,
} from "./form";
import { normalizeInPlace } from "./normalize";
import {
  LIM,
  REGION_ORDER,
  REGISTRY,
  classicDesktop,
  classicPhone,
  defOf,
  isIdSyntax,
  isKnownRef,
  isRefSyntax,
  isReservedId,
  isStepRefSyntax,
  kindOf,
} from "./schema";

export interface RepairResult {
  form: JObj;
  notes: string[];
}
/** Notes that report what was kept, not a change: they never make a form invalid. */
export const INFO_NOTES: ReadonlySet<string> = new Set(["unknown-island-kept", "unknown-node-kept"]);
const codeOf = (note: string) => note.slice(0, note.indexOf(" ") < 0 ? note.length : note.indexOf(" "));

// ---- limits (LAYOUT.md §3.7) ------------------------------------------------------------------------------------
/** The first limit the value exceeds, in a fixed order; null when within every limit. */
export function limitViolation(v: JObj): string | null {
  if (canonBytes(v) > LIM.formBytes) return "too-large";
  let nodes = 0;
  let depth = 0;
  let children = false;
  let tabs = false;
  const visit = (n: Json, d: number) => {
    if (!isObj(n)) return;
    nodes++;
    if (d > depth) depth = d;
    const c = get(n, "c");
    if (!isArr(c)) return;
    if (c.length > LIM.children) children = true;
    if (get(n, "t") === "stack" && c.length > LIM.stackTabs) tabs = true;
    for (const k of c) visit(k, d + 1);
  };
  visit(get(v, "root") as Json, 1);
  const fl = get(v, "floats");
  if (isArr(fl)) for (const x of fl) if (isObj(x)) visit(get(x, "node") as Json, 1);
  if (depth > LIM.depth) return "too-deep";
  if (nodes > LIM.nodes) return "too-many-nodes";
  if (children) return "over-limit-children";
  if (tabs) return "over-limit-tabs";
  if (isArr(fl) && fl.length > LIM.floats) return "over-limit-floats";
  const buttons = new Set<string>();
  const addRef = (r: Json | undefined) => {
    if (isStr(r) && r.startsWith("buttons:")) buttons.add(r);
  };
  const walkRefs = (n: Json) => {
    if (!isObj(n)) return;
    addRef(get(n, "i"));
    const c = get(n, "c");
    if (isArr(c)) for (const k of c) walkRefs(k);
  };
  walkRefs(get(v, "root") as Json);
  if (isArr(fl)) for (const x of fl) if (isObj(x)) walkRefs(get(x, "node") as Json);
  const hid = get(v, "hidden");
  if (isArr(hid)) for (const h of hid) addRef(isObj(h) ? get(h, "i") : h);
  if (buttons.size > LIM.buttonsIslands) return "over-limit-buttons";
  if (isArr(hid) && hid.length > LIM.hidden) return "over-limit-hidden";
  const col = get(v, "collapse");
  if (isArr(col) && col.length > LIM.collapse) return "over-limit-collapse";
  return null;
}

// ---- opts (desktop and phone; LAYOUT.md §3.8) -------------------------------------------------------------------
const WIDGET_ID = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const ACTION_ID = /^[a-z][a-zA-Z0-9.]{0,63}$/;
const keysBeyond = (o: JObj, n: number) => sortedKeys(o).slice(n);

/** Sanitize one island's options object in place; true when something changed. */
function fixIslandOpts(v: JObj): boolean {
  let ch = false;
  const drop = (k: string) => {
    delete v[k];
    ch = true;
  };
  for (const k of ["compact", "composerTop", "headerBottom"]) if (has(v, k) && typeof v[k] !== "boolean") drop(k);
  if (has(v, "orient") && v["orient"] !== "v" && v["orient"] !== "h") drop("orient");
  if (has(v, "widgets")) {
    const w = v["widgets"];
    if (!isArr(w)) drop("widgets");
    else {
      const kept: Json[] = [];
      for (const it of w) {
        if (!isObj(it) || !isStr(get(it, "w")) || !WIDGET_ID.test(get(it, "w") as string)) {
          ch = true;
          continue;
        }
        const sz = get(it, "size");
        if (has(it, "size") && sz !== "S" && sz !== "M" && sz !== "L") {
          delete it["size"];
          ch = true;
        }
        const st = get(it, "settings");
        if (has(it, "settings") && (!isObj(st) || Object.keys(st).length > 16)) {
          delete it["settings"];
          ch = true;
        }
        kept.push(it);
      }
      if (kept.length > 12) {
        kept.length = 12;
        ch = true;
      }
      v["widgets"] = kept;
    }
  }
  if (has(v, "rows")) {
    const r = v["rows"];
    if (!isObj(r)) drop("rows");
    else {
      for (const rk of sortedKeys(r)) {
        const row = r[rk];
        if (!isObj(row)) {
          delete r[rk];
          ch = true;
          continue;
        }
        const look = get(row, "look");
        if (has(row, "look") && look !== "icon" && look !== "iconLabel" && look !== "label") {
          delete row["look"];
          ch = true;
        }
        const sc = get(row, "scale");
        if (has(row, "scale") && sc !== "S" && sc !== "M") {
          delete row["scale"];
          ch = true;
        }
        if (has(row, "items")) {
          const items = row["items"];
          if (!isArr(items)) {
            delete row["items"];
            ch = true;
          } else {
            const kept: Json[] = [];
            for (const it of items) {
              if (!isObj(it) || !isStr(get(it, "a")) || !ACTION_ID.test(get(it, "a") as string)) {
                ch = true;
                continue;
              }
              const tg = get(it, "target");
              if (has(it, "target") && (!isObj(tg) || Object.keys(tg).length > 4)) {
                delete it["target"];
                ch = true;
              }
              if (has(it, "hideWhenOff") && typeof get(it, "hideWhenOff") !== "boolean") {
                delete it["hideWhenOff"];
                ch = true;
              }
              kept.push(it);
            }
            if (kept.length > 24) {
              kept.length = 24;
              ch = true;
            }
            row["items"] = kept;
          }
        }
      }
      for (const rk of keysBeyond(r, 8)) {
        delete r[rk];
        ch = true;
      }
    }
  }
  // at most 32 keys: the derived flags (composerTop, headerBottom) always fit — the other keys are cut to 30 first
  const others = sortedKeys(v).filter((k) => k !== "composerTop" && k !== "headerBottom");
  for (const k of others.slice(30)) drop(k);
  return ch;
}

/** `opts` of a form: keys are island refs, values objects (≤ 32 entries). Notes `bad-opts-fixed <ref | opts>`. */
function fixOpts(f: JObj, note: (n: string, s: string) => void): void {
  if (!has(f, "opts")) return;
  const o = f["opts"];
  if (!isObj(o)) {
    delete f["opts"];
    note("bad-opts-fixed", "opts");
    return;
  }
  for (const k of sortedKeys(o)) {
    if (!isRefSyntax(k)) {
      delete o[k];
      note("bad-opts-fixed", "opts");
      continue;
    }
    const v = o[k];
    if (!isObj(v)) {
      delete o[k];
      note("bad-opts-fixed", k);
      continue;
    }
    if (fixIslandOpts(v)) note("bad-opts-fixed", k);
  }
  // at most 32 entries: `composer` and `header` (where N9 records the room order) always fit — the others are cut to 30
  const beyond = sortedKeys(o).filter((k) => k !== "composer" && k !== "header").slice(30);
  for (const k of beyond) delete o[k];
  if (beyond.length) note("bad-opts-fixed", "opts");
}

// ---- float sizes (step 6) ------------------------------------------------------------------------------------
/** A float's w / h: invalid (not an object, `share`, two bases, a wrong-typed known field) → null; else clamped. */
function fixFloatSize(v: Json): { size: JObj | null; changed: boolean } {
  if (!isObj(v) || has(v, "share")) return { size: null, changed: true };
  if (["fixed", "auto", "pm"].filter((b) => has(v, b)).length > 1) return { size: null, changed: true };
  if (has(v, "auto") && v["auto"] !== true) return { size: null, changed: true };
  for (const k of ["fixed", "pm", "min", "max", "minPm", "maxPm"]) if (has(v, k) && !isInt(v[k])) return { size: null, changed: true };
  const r = fixSize(v); // clamps, max >= min
  return { size: r.size as JObj, changed: r.changed };
}

// ---- the desktop form ------------------------------------------------------------------------------------------
const classic = (why: string): RepairResult => ({ form: classicDesktop(), notes: [`replaced-by-classic ${why}`] });

/** Repair desktop-form JSON text (LAYOUT.md §5.1): not JSON data → Classic. */
export function repairDesktopText(text: string): RepairResult {
  const r = readJson(text);
  return r.ok ? repairDesktop(r.value) : classic("not-json");
}

/** LAYOUT.md §5.1-§5.3: a valid projection of any value + the notes, in the order the steps produce them. */
export function repairDesktop(value: Json): RepairResult {
  if (!isJsonValue(value)) return classic("not-json");
  if (!isObj(value)) return classic("not-object");
  if (!isObj(get(value, "root")) || !isNode(get(value, "root"))) return classic("no-root");
  const lim = limitViolation(value);
  if (lim) return classic(lim);
  const f = clone(value);
  const notes: string[] = [];
  const note = (n: string, s: string) => notes.push(`${n} ${s}`);
  repairInPlace(f, note);
  const lim2 = limitViolation(f);
  if (lim2) return classic(lim2);
  return { form: f, notes };
}

/** validate(form) → the violations = the change notes repair would produce (LAYOUT.md §5.4). */
export function validateDesktop(value: Json): string[] {
  return repairDesktop(value).notes.filter((n) => !INFO_NOTES.has(codeOf(n)));
}

function fixIntField(o: JObj, k: string, lo: number, hi: number): boolean {
  if (!has(o, k)) return false;
  const v = o[k];
  if (!isInt(v)) {
    delete o[k];
    return true;
  }
  const c = clampInt(v, lo, hi);
  if (c !== v) {
    o[k] = c;
    return true;
  }
  return false;
}
const cpLen = (s: string) => Array.from(s).length;

function repairInPlace(f: JObj, note: (n: string, s: string) => void): void {
  // ---- step 2a: form-level fields (preset, gap, margin, density, floats, hidden, collapse, opts)
  if (has(f, "preset") && (!isStr(f["preset"]) || cpLen(f["preset"] as string) > 32)) {
    delete f["preset"];
    note("bad-field-fixed", "preset");
  }
  if (fixIntField(f, "gap", 0, 32)) note("bad-field-fixed", "gap");
  if (fixIntField(f, "margin", 0, 64)) note("bad-field-fixed", "margin");
  if (has(f, "density") && !["compact", "normal", "touch"].includes(f["density"] as string)) {
    delete f["density"];
    note("bad-field-fixed", "density");
  }
  for (const k of ["floats", "hidden", "collapse"]) {
    if (has(f, k) && !isArr(f[k])) {
      delete f[k];
      note("bad-field-fixed", k);
    }
  }
  fixOpts(f, note);

  // ---- step 2b: the root is a row or col (N5)
  const ids = new Ids(f);
  const allRefs = new Set<string>();
  for (const l of allLocs(f)) if (isStr(get(l.node, "i"))) allRefs.add(get(l.node, "i") as string);
  for (const h of hiddenOf(f)) {
    if (isStr(h)) allRefs.add(h);
    else if (isObj(h) && isStr(get(h, "i"))) allRefs.add(get(h, "i") as string);
  }
  let root = f["root"] as JObj;
  if (!isContainer(root)) {
    const id = ids.body();
    root = mk([
      ["t", "row"],
      ["id", id],
      ["c", [root]],
    ]);
    f["root"] = root;
    note("root-wrapped", id);
  }

  // ---- step 2c: walk the root depth-first, then the floats, then hidden
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  const fixId = (n: JObj, prefix: string) => {
    const id = get(n, "id");
    let why: string | null = null;
    if (!isIdSyntax(id)) why = "id-reassigned";
    else if (isReservedId(id)) why = "renamed-reserved-id";
    else if (seenIds.has(id) || allRefs.has(id)) why = "id-reassigned";
    if (why === null) {
      seenIds.add(id as string);
      return;
    }
    const nid = ids.next(prefix);
    seenIds.add(nid);
    n["id"] = nid;
    note(why, why === "renamed-reserved-id" ? (id as string) : nid);
  };
  const fixNodeSize = (n: JObj, subject: string) => {
    if (!has(n, "size")) return;
    const r = fixSize(n["size"]);
    if (!r.changed) return;
    if (r.size) n["size"] = r.size;
    else delete n["size"];
    note("bad-size-fixed", subject);
  };
  const walkKids = (n: JObj, subject: string) => {
    const kept: JObj[] = [];
    for (const k of kidsOf(n)) {
      const r = walk(k, subject);
      if (r) kept.push(r);
    }
    n["c"] = kept;
  };
  const walk = (n: Json, parentSubject: string): JObj | null => {
    if (!isNode(n)) {
      note("dropped-invalid", parentSubject);
      return null;
    }
    const t = tOf(n) as string;
    if (t === "island") {
      const r = get(n, "i");
      if (!isRefSyntax(r)) {
        note("dropped-invalid", parentSubject);
        return null;
      }
      if (seen.has(r)) {
        note("dropped-duplicate", r);
        return null;
      }
      seen.add(r);
      if (!isKnownRef(r)) note("unknown-island-kept", r);
      else fixNodeSize(n, r);
      return n;
    }
    if (t === "row" || t === "col" || t === "stack") {
      fixId(n, t === "stack" ? "s" : "n");
      const id = get(n, "id") as string;
      if (t !== "stack" && fixIntField(n, "gap", 0, 32)) note("bad-field-fixed", id);
      fixNodeSize(n, id);
      if (!isArr(get(n, "c"))) {
        n["c"] = [];
        note("bad-field-fixed", id);
      }
      walkKids(n, id);
      return n;
    }
    note("unknown-node-kept", t);
    if (isArr(get(n, "c"))) walkKids(n, t);
    return n;
  };
  // the root itself: its id and fields, then its children
  fixId(root, "n");
  const rid = get(root, "id") as string;
  if (fixIntField(root, "gap", 0, 32)) note("bad-field-fixed", rid);
  fixNodeSize(root, rid);
  if (!isArr(get(root, "c"))) {
    root["c"] = [];
    note("bad-field-fixed", rid);
  }
  walkKids(root, rid);

  if (has(f, "floats")) {
    const fl = f["floats"] as Json[];
    const kept: JObj[] = [];
    for (const x of fl) {
      if (!isObj(x)) {
        note("dropped-invalid", "floats");
        continue;
      }
      fixId(x, "f");
      const id = get(x, "id") as string;
      const node = get(x, "node");
      const r = isNode(node) ? walk(node, id) : null;
      if (!r) {
        if (isNode(node)) {
          /* the walk noted why */
        }
        note("bad-float-fixed", id);
        continue;
      }
      x["node"] = r;
      kept.push(x);
    }
    f["floats"] = kept;
  }
  if (has(f, "hidden")) {
    const hid = f["hidden"] as Json[];
    const kept: JObj[] = [];
    for (const h of hid) {
      if (isStr(h)) {
        if (!isRefSyntax(h)) {
          note("dropped-invalid", "hidden");
          continue;
        }
        if (seen.has(h)) {
          note("dropped-duplicate", h);
          continue;
        }
        seen.add(h);
        note("hidden-upgraded", h);
        if (!isKnownRef(h)) note("unknown-island-kept", h);
        kept.push(
          mk([
            ["t", "island"],
            ["i", h],
          ]),
        );
        continue;
      }
      if (!isObj(h) || get(h, "t") !== "island" || !isRefSyntax(get(h, "i"))) {
        note("dropped-invalid", "hidden");
        continue;
      }
      const r = get(h, "i") as string;
      if (seen.has(r)) {
        note("dropped-duplicate", r);
        continue;
      }
      seen.add(r);
      if (!isKnownRef(r)) note("unknown-island-kept", r);
      else fixNodeSize(h, r);
      if (has(h, "from")) {
        const fr = h["from"];
        if (!isObj(fr) || !isIdSyntax(get(fr, "parent")) || !isInt(get(fr, "index"))) {
          delete h["from"];
          note("bad-field-fixed", r);
        } else if (fixIntField(fr, "index", 0, 15)) note("bad-field-fixed", r);
      }
      kept.push(h);
    }
    f["hidden"] = kept;
  }

  // ---- step 3: stacks hold stackable islands only; the rest moves out, right after the stack
  const stacks = allLocs(f)
    .filter((l) => isStack(l.node))
    .map((l) => l.node);
  for (const s of stacks) {
    const keep: JObj[] = [];
    const out: JObj[] = [];
    for (const k of kidsOf(s)) {
      if (isIsland(k)) {
        const d = defOf(refOf(k));
        if (!d || d.stackable) {
          keep.push(k);
          continue;
        }
      }
      out.push(k);
      note("unstacked", keyOf(k) ?? (tOf(k) as string));
    }
    if (out.length === 0) continue;
    s["c"] = keep;
    const l = locOf(f, s) as Loc;
    if (l.parent) {
      const c = kidsOf(l.parent);
      c.splice(c.indexOf(s) + 1, 0, ...out);
    } else if (l.float >= 0) {
      floatsOf(f)[l.float]["node"] = mk([
        ["t", "col"],
        ["id", ids.next("n")],
        ["c", [s, ...out]],
      ]);
    }
  }

  // ---- step 4: the room group (R1-R3)
  const partial = (g: JObj) => partialOk(g);
  // 4a. the timeline: docked in the root tree
  {
    const hi = hiddenIndex(f, "timeline");
    const tl = findKey(f, "timeline");
    if (hi >= 0) {
      const leaf = (f["hidden"] as JObj[]).splice(hi, 1)[0];
      delete leaf["from"];
      note("unhid-required", "timeline");
      placeByHome(f, leaf, ids, partial);
    } else if (tl && tl.float >= 0) {
      detach(f, tl);
      note("regrouped-room", "timeline");
      placeByHome(f, tl.node, ids, partial);
    } else if (!tl) {
      note("restored-required", "timeline");
      placeByHome(f, mk([["t", "island"], ["i", "timeline"]]), ids, partial);
    }
  }
  // 4b. the composer: directly after the timeline in its col (a col is created around the timeline if needed)
  {
    const room = roomLocs(f);
    const hi = hiddenIndex(f, "composer");
    let leaf: JObj | null = null;
    if (hi >= 0) {
      leaf = (f["hidden"] as JObj[]).splice(hi, 1)[0];
      delete leaf["from"];
      note("unhid-required", "composer");
    } else if (!room.composer) {
      leaf = mk([["t", "island"], ["i", "composer"]]);
      note("restored-required", "composer");
    } else if (!r1ok(room)) {
      detach(f, room.composer);
      leaf = room.composer.node;
      note("regrouped-room", "composer");
    }
    if (leaf) {
      const tl = findKey(f, "timeline") as Loc;
      insertBeside(f, leaf, tl, "bottom", ids);
    }
  }
  // 4c. the header (when placed): first child of the nearest col containing the timeline's col (groupEdge top)
  {
    const room = roomLocs(f);
    if (room.header && (room.header.float >= 0 || !r2ok(room))) {
      detach(f, room.header);
      note("regrouped-room", "header");
      const col = groupEdgeCol(roomLocs(f)) as JObj;
      kidsOf(col).unshift(room.header.node);
    }
  }

  // ---- step 5: the call (required) and every other missing singleton island, by their home rules
  {
    const hi = hiddenIndex(f, "call");
    if (hi >= 0) {
      const leaf = (f["hidden"] as JObj[]).splice(hi, 1)[0];
      delete leaf["from"];
      note("unhid-required", "call");
      placeByHome(f, leaf, ids, partial);
    } else if (!findKey(f, "call")) {
      note("restored-required", "call");
      placeByHome(f, mk([["t", "island"], ["i", "call"]]), ids, partial);
    }
    for (const k of REGION_ORDER) {
      const d = REGISTRY[k];
      if (d.multi || d.required) continue;
      if (findKey(f, k) || hiddenIndex(f, k) >= 0) continue;
      note("restored-missing", k);
      placeByHome(f, mk([["t", "island"], ["i", k]]), ids, partial);
    }
  }

  // ---- step 6: floats' fields
  for (const x of floatsOf(f)) {
    const id = get(x, "id") as string;
    let bad = false;
    if (!ANCHORS.includes(get(x, "anchor") as (typeof ANCHORS)[number])) {
      x["anchor"] = "tl";
      bad = true;
    }
    for (const k of ["dx", "dy"]) if (fixIntField(x, k, -4096, 4096)) bad = true;
    for (const k of ["w", "h"]) {
      if (!has(x, k)) continue;
      const r = fixFloatSize(x[k]);
      if (r.size === null) {
        delete x[k];
        bad = true;
      } else if (r.changed) {
        x[k] = r.size;
        bad = true;
      }
    }
    if (has(x, "reveal") && x["reveal"] !== "always" && x["reveal"] !== "hover") {
      x["reveal"] = "always";
      bad = true;
    }
    if (bad) note("bad-float-fixed", id);
    if (x["reveal"] === "hover" && isObj(get(x, "node")) && islandsIn(x["node"] as JObj).some((r) => defOf(r)?.required)) {
      x["reveal"] = "always";
      note("reveal-fixed", id);
    }
  }

  // ---- step 7: collapse steps
  if (has(f, "collapse")) {
    const col = f["collapse"] as Json[];
    const kept: JObj[] = [];
    const rootKeys = new Map<string, Loc>();
    for (const l of allLocs(f)) if (l.float < 0 && isKnownType(l.node) && keyOf(l.node) !== undefined && !rootKeys.has(keyOf(l.node) as string)) rootKeys.set(keyOf(l.node) as string, l);
    const seenSteps = new Set<string>();
    for (const st of col) {
      const ref = isObj(st) ? get(st, "ref") : undefined;
      const subj = isStr(ref) && isStepRefSyntax(ref) ? ref : "collapse";
      if (!isObj(st) || !isStepRefSyntax(ref) || !STEP_TOS.includes(get(st, "to") as (typeof STEP_TOS)[number])) {
        note("bad-collapse-dropped", subj);
        continue;
      }
      const to = get(st, "to") as string;
      const l = rootKeys.get(ref);
      if (!l) {
        note("bad-collapse-dropped", ref);
        continue;
      }
      if (isIsland(l.node)) {
        const d = defOf(ref);
        if (d && !d.collapse.includes(to)) {
          note("bad-collapse-dropped", ref);
          continue;
        }
      } else if (to === "fold") {
        note("bad-collapse-dropped", ref);
        continue;
      }
      if (islandsIn(l.node).some((r) => r === "header" || r === "timeline" || r === "composer" || r === "call")) {
        note("collapse-unsafe-dropped", ref);
        continue;
      }
      if (seenSteps.has(ref)) {
        note("dropped-duplicate", ref);
        continue;
      }
      seenSteps.add(ref);
      let bad = false;
      for (const k of ["below", "w"]) if (fixIntField(st, k, 0, 8192)) bad = true;
      if (bad) note("bad-field-fixed", ref);
      kept.push(st);
    }
    f["collapse"] = kept;
  }

  // ---- step 8: normalize
  const n = normalizeInPlace(f);
  for (const x of n.notes) {
    const i = x.indexOf(" ");
    note(x.slice(0, i), x.slice(i + 1));
  }
}

/** The placement rules a repair / home insertion must keep (the ones whose islands are placed). */
export function partialOk(f: JObj): boolean {
  const seen = new Set<string>();
  for (const l of allLocs(f)) {
    if (isStack(l.node)) for (const k of kidsOf(l.node)) if (!isIsland(k) || defOf(refOf(k))?.stackable === false) return false;
    if (!isIsland(l.node)) continue;
    const r = refOf(l.node);
    if (seen.has(r)) return false;
    seen.add(r);
    if (l.float >= 0 && defOf(r)?.floatable === false) return false;
  }
  const room = roomLocs(f);
  if (room.timeline && room.composer && !r1ok(room)) return false;
  if (room.header && timelineCol(room) && !r2ok(room)) return false;
  return true;
}

// ---- the phone form (LAYOUT.md §5.5) ------------------------------------------------------------------------------
const PHONE_LIM = { rail: 16, list: 16, hidden: 32 };

export function repairPhoneText(text: string): RepairResult {
  const r = readJson(text);
  return r.ok ? repairPhone(r.value) : { form: classicPhone(), notes: ["replaced-by-classic not-json"] };
}

export function repairPhone(value: Json): RepairResult {
  if (!isJsonValue(value)) return { form: classicPhone(), notes: ["replaced-by-classic not-json"] };
  if (!isObj(value)) return { form: classicPhone(), notes: ["replaced-by-classic not-object"] };
  if (canonBytes(value) > LIM.formBytes) return { form: classicPhone(), notes: ["replaced-by-classic too-large"] };
  const f = clone(value);
  const notes: string[] = [];
  const note = (n: string, s: string) => notes.push(`${n} ${s}`);
  const cols: Record<"rail" | "list" | "hidden", string[]> = { rail: [], list: [], hidden: [] };
  const misplaced: Record<"rail" | "list", string[]> = { rail: [], list: [] };
  const seen = new Set<string>();
  for (const k of ["rail", "list", "hidden"] as const) {
    let arr = get(f, k);
    if (has(f, k) && !isArr(arr)) {
      note("bad-phone-fixed", k);
      arr = [];
    }
    if (!isArr(arr)) arr = [];
    for (const r of arr) {
      if (!isRefSyntax(r)) {
        note("bad-phone-fixed", k);
        continue;
      }
      if (seen.has(r)) {
        note("dropped-duplicate", r);
        continue;
      }
      const d = defOf(r);
      if (!isKnownRef(r)) {
        seen.add(r);
        note("unknown-island-kept", r);
        cols[k].push(r);
        continue;
      }
      if (!d || d.phone === null) {
        note("bad-phone-fixed", r);
        continue;
      }
      seen.add(r);
      if (k !== "hidden" && d.phone !== k) {
        note("bad-phone-fixed", r);
        misplaced[d.phone].push(r);
        continue;
      }
      cols[k].push(r);
    }
  }
  cols.rail.push(...misplaced.rail);
  cols.list.push(...misplaced.list);
  for (const k of REGION_ORDER) {
    const d = REGISTRY[k];
    if (d.multi || d.phone === null || seen.has(k)) continue;
    cols[d.phone].push(k);
    note("restored-missing", k);
  }
  // overflow (§5.6, Q-PHONEFIX; nothing is ever dropped): a column over its limit gives up its last unknown ref, else
  // its last button section, until it fits; what it gives up moves to the end of `hidden` as one run, in the order it
  // had (one `bad-phone-fixed <ref>` each, in that order). `hidden` over its limit then → the Classic phone form
  // (`replaced-by-classic over-limit-hidden`): a save quarantines the original (§9.5), nothing is silently lost.
  const isBtn = (r: string) => kindOf(r) === "buttons" && isKnownRef(r);
  for (const k of ["rail", "list"] as const) {
    const col = cols[k];
    const gone = new Set<number>();
    const lastFree = (pred: (r: string) => boolean) => {
      for (let i = col.length - 1; i >= 0; i--) if (!gone.has(i) && pred(col[i])) return i;
      return -1;
    };
    while (col.length - gone.size > PHONE_LIM[k]) {
      let i = lastFree((r) => !isKnownRef(r));
      if (i < 0) i = lastFree(isBtn);
      if (i < 0) break; // cannot happen: a column holds at most 3 known sections that are not button sections
      gone.add(i);
    }
    if (gone.size === 0) continue;
    const moved = col.filter((_, i) => gone.has(i));
    cols[k] = col.filter((_, i) => !gone.has(i));
    for (const r of moved) {
      cols.hidden.push(r);
      note("bad-phone-fixed", r);
    }
  }
  if (cols.hidden.length > PHONE_LIM.hidden) return { form: classicPhone(), notes: ["replaced-by-classic over-limit-hidden"] };
  for (const k of ["rail", "list", "hidden"] as const) {
    // a key that was absent stays absent while its column is empty
    if (has(f, k) || cols[k].length > 0) f[k] = cols[k];
  }
  fixOpts(f, note);
  if (canonBytes(f) > LIM.formBytes) return { form: classicPhone(), notes: ["replaced-by-classic too-large"] };
  return { form: f, notes };
}

export function validatePhone(value: Json): string[] {
  return repairPhone(value).notes.filter((n) => !INFO_NOTES.has(codeOf(n)));
}

