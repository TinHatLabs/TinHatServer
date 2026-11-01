// session.ts — the edit session (EDITMODE-UI.md §1, §4.3, §8, §9): a pure state machine over the layout engine — no
// DOM, no clock, no I/O — so the unit tests (session.test.ts) and the desktop's twin run the same rules.
//
// A session edits ONE form (the desktop editor the desktop form, the phone editor the phone form); the other rides
// along unchanged. Every change is an engine operation (or, for the phone form, a repaired phone form) that becomes the
// new working copy and one undo step; Undo / Redo walk whole forms (each one validated, so undo can never produce an
// invalid layout); Cancel throws everything away; Done answers the edit ONCE (`finish`) — or null when nothing changed
// (the engine's `save` would answer noop).
//
// Host logic that CHOOSES operations (both apps must choose the same ones, EDITMODE-UI §4.3 / §8):
//   pickPreset   applyPreset, then carry every placed island's button rows (opts.<ref>.rows)
//   floatAnchor  the host corner nearest to an island's centre
//   dockFloat    the island's registry home list as dock placements, first success wins
//   resetIsland  hide → strip size / from, from = the preset's parent + index → restore
import { applyOp, canon, clone, presetDesktop, presetPhone, repairPhone, REGISTRY } from "../../layout/index";
import type { JObj, Json } from "../../layout/index";
import { get, has, isArr, isObj, isStr, obj } from "../../layout/json";
import { allLocs, findKey, floatsOf, hiddenOf, isIsland, keyOf } from "../../layout/form";
import { kindOf } from "../../layout/schema";

export type FormKind = "desktop" | "phone";

/** What a session starts from: the layout the device renders (its synced entry, an override, or built-in Classic). */
export interface SessionStart {
  id: string;
  name: string;
  desktop: JObj;
  phone: JObj;
}

/** What Done hands to the save (engine `save` edit: {name, desktop, phone}). */
export interface SessionResult {
  id: string;
  name: string;
  desktop: JObj;
  phone: JObj;
}

export type Step = { ok: true } | { ok: false; error: string };

export const UNDO_CAP = 100;

export class EditSession {
  readonly kind: FormKind;
  readonly id: string;
  readonly startName: string;
  /** the edited form as the session started (Previous, dirty) */
  readonly start: JObj;
  /** the form this session does not edit */
  readonly other: JObj;
  name: string;
  form: JObj;
  private undos: JObj[] = [];
  private redos: JObj[] = [];
  /** the session ended (Done or Cancel): every further call is refused */
  closed = false;

  constructor(start: SessionStart, kind: FormKind) {
    this.kind = kind;
    this.id = start.id;
    this.startName = start.name;
    this.name = start.name;
    this.start = clone(kind === "desktop" ? start.desktop : start.phone) as JObj;
    this.other = clone(kind === "desktop" ? start.phone : start.desktop) as JObj;
    this.form = clone(this.start) as JObj;
  }

  get canUndo(): boolean {
    return !this.closed && this.undos.length > 0;
  }
  get canRedo(): boolean {
    return !this.closed && this.redos.length > 0;
  }
  get undoDepth(): number {
    return this.undos.length;
  }
  get redoDepth(): number {
    return this.redos.length;
  }
  /** Anything to save: the working copy or the name differs from the start (canonically). */
  get dirty(): boolean {
    return canon(this.form) !== canon(this.start) || this.name !== this.startName;
  }

  /** A new working copy (already validated by the engine) as one undo step; an equal form is not a step. */
  commit(next: JObj): boolean {
    if (this.closed) return false;
    if (canon(next) === canon(this.form)) return false;
    this.undos.push(this.form);
    if (this.undos.length > UNDO_CAP) this.undos.shift();
    this.redos = [];
    this.form = clone(next) as JObj;
    return true;
  }

  /** One engine operation on the desktop working copy (LAYOUT §8) — the input is never changed on an error. */
  apply(op: Json, ctx?: Json): Step {
    if (this.closed) return { ok: false, error: "closed" };
    if (this.kind !== "desktop") return { ok: false, error: "bad-op: bad request" };
    const r = applyOp(this.form, op, ctx);
    if (!r.ok) return { ok: false, error: r.error };
    this.commit(r.form);
    return { ok: true };
  }

  /** A new phone form (the phone form has no operations): accepted only when repair leaves it as it is. */
  setPhone(next: JObj): Step {
    if (this.closed) return { ok: false, error: "closed" };
    if (this.kind !== "phone") return { ok: false, error: "bad-op: bad request" };
    const r = repairPhone(next);
    if (canon(r.form) !== canon(next)) return { ok: false, error: "bad-op: bad request" };
    this.commit(r.form);
    return { ok: true };
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.redos.push(this.form);
    this.form = this.undos.pop() as JObj;
    return true;
  }
  redo(): boolean {
    if (!this.canRedo) return false;
    this.undos.push(this.form);
    this.form = this.redos.pop() as JObj;
    return true;
  }

  /** A preset (EDITMODE-UI §8; the phone editor: the preset's phone form) as one undo step. */
  preset(name: string): Step {
    if (this.closed) return { ok: false, error: "closed" };
    if (this.kind === "phone") {
      const p = presetPhone(name);
      if (!p) return { ok: false, error: "bad-op: bad request" };
      this.commit(p);
      return { ok: true };
    }
    const r = pickPreset(this.form, name);
    if (!r.ok) return r;
    this.commit(r.form);
    return { ok: true };
  }

  /** Reset (in edit mode, EDITMODE-UI §9) = the Classic preset, staged like every change. */
  reset(): Step {
    return this.preset("classic");
  }

  /** Previous (EDITMODE-UI §8) = the start form, as one new undo step. */
  previous(): Step {
    if (this.closed) return { ok: false, error: "closed" };
    this.commit(this.start);
    return { ok: true };
  }

  rename(name: string): void {
    if (this.closed) return;
    const n = [...name.trim()].slice(0, 40).join("");
    if (n) this.name = n;
  }

  /** Done: the edit to save, once — null when nothing changed (no save at all). */
  finish(): SessionResult | null {
    if (this.closed) return null;
    this.closed = true;
    if (!this.dirty) return null;
    const desktop = this.kind === "desktop" ? this.form : this.other;
    const phone = this.kind === "phone" ? this.form : this.other;
    return { id: this.id, name: this.name, desktop: clone(desktop) as JObj, phone: clone(phone) as JObj };
  }

  /** Cancel: nothing is saved; the start is what renders again. */
  cancel(): void {
    this.closed = true;
  }

  /** The save of a Done failed (too large, …): the session goes on exactly as it was — start, history, dirty. */
  reopen(): void {
    this.closed = false;
  }
}

// ---- host logic that chooses operations (EDITMODE-UI §4.3, §8) ------------------------------------------------------

const op = (pairs: Record<string, Json>): JObj => {
  const o = obj();
  for (const [k, v] of Object.entries(pairs)) o[k] = v;
  return o;
};

/** Every island ref placed in the root tree or a float (known node types), document order. */
export function placedRefs(form: JObj): string[] {
  const out: string[] = [];
  for (const l of allLocs(form)) if (isIsland(l.node) && isStr(get(l.node, "i"))) out.push(get(l.node, "i") as string);
  return out;
}

/** The preset pick (§8): applyPreset, then setOpt(ref, "rows", …) for every placed island that had button rows. */
export function pickPreset(form: JObj, name: string): { ok: true; form: JObj } | { ok: false; error: string } {
  const r = applyOp(form, op({ op: "applyPreset", preset: name }));
  if (!r.ok) return r;
  let next = r.form;
  const opts = get(form, "opts");
  if (isObj(opts)) {
    const placed = new Set(placedRefs(next));
    for (const ref of Object.keys(opts).sort(cmpCp)) {
      const o = opts[ref];
      if (!isObj(o) || !has(o, "rows") || !placed.has(ref)) continue;
      const s = applyOp(next, op({ op: "setOpt", ref, key: "rows", value: clone(get(o, "rows") as Json) }));
      if (s.ok) next = s.form;
    }
  }
  return { ok: true, form: next };
}

function cmpCp(a: string, b: string): number {
  // code-point order (the engine's): compare by code points, not UTF-16 units
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d) return d;
  }
  return x.length - y.length;
}

/** The host corner nearest to a rect's centre (ties: tl, tr, bl, br). */
export function floatAnchor(r: { x: number; y: number; w: number; h: number }, host: { w: number; h: number }): "tl" | "tr" | "bl" | "br" {
  const cx = 2 * r.x + r.w; // doubled centre: integer maths
  const cy = 2 * r.y + r.h;
  const right = cx > host.w; // strictly past the middle → right (a tie stays left)
  const bottom = cy > host.h;
  return bottom ? (right ? "br" : "bl") : right ? "tr" : "tl";
}

/** The island's registry home list as placements (§4.3), in order. */
export function homePlacements(form: JObj, ref: string): JObj[] {
  const def = REGISTRY[kindOf(ref)];
  if (!def) return [];
  const out: JObj[] = [];
  for (const h of def.home) {
    const beside = get(h, "beside");
    const side = get(h, "side");
    const edge = get(h, "edge");
    if (isStr(beside) && isStr(side)) {
      if (get(h, "container") === true) {
        const l = findKey(form, beside);
        if (!l || !l.parent || l.float >= 0) continue;
        const pk = keyOf(l.parent);
        const root = get(form, "root");
        if (!pk || l.parent === root) continue;
        out.push(op({ op: "dockBeside", target: pk, side }));
      } else out.push(op({ op: "dockBeside", target: beside, side }));
    } else if (isStr(edge)) out.push(op({ op: "edge", side: edge }));
  }
  return out;
}

/** The float id holding `ref` (its node or inside it), or null. */
export function floatOf(form: JObj, ref: string): string | null {
  const fl = floatsOf(form);
  for (const l of allLocs(form)) {
    if (l.float < 0 || !isIsland(l.node) || get(l.node, "i") !== ref) continue;
    const f = fl[l.float];
    return isObj(f) && isStr(get(f, "id")) ? (get(f, "id") as string) : null;
  }
  return null;
}

/** Dock a floating island (§4.3): dock(float, to) for each home placement; the first success wins. */
export function dockFloat(form: JObj, ref: string): { ok: true; form: JObj } | { ok: false; error: string } {
  const f = floatOf(form, ref);
  if (!f) return { ok: false, error: "bad-op: island not placed" };
  let last = "bad-op: target not found";
  for (const to of homePlacements(form, ref)) {
    const r = applyOp(form, op({ op: "dock", ref: f, to }));
    if (r.ok) return { ok: true, form: r.form };
    last = r.error;
  }
  return { ok: false, error: last };
}

/** Float a docked island at the host corner nearest to its centre, 16 px in (§4.1). */
export function floatIsland(form: JObj, ref: string, rect: { x: number; y: number; w: number; h: number }, host: { w: number; h: number }) {
  return applyOp(form, op({ op: "float", ref, anchor: floatAnchor(rect, host), dx: 16, dy: 16 }));
}

/** Where the working copy's preset (else Classic) puts `ref`: its parent key and index, or null. */
function presetSpot(form: JObj, ref: string): { parent: string; index: number } | null {
  const pn = get(form, "preset");
  const p = (isStr(pn) && presetDesktop(pn)) || presetDesktop("classic");
  if (!p) return null;
  for (const l of allLocs(p)) {
    if (!isIsland(l.node) || get(l.node, "i") !== ref || !l.parent) continue;
    const k = keyOf(l.parent);
    return k ? { parent: k, index: l.index } : null;
  }
  return null;
}

/** "Reset this island" (§4.3): hide → the leaf loses size / from (from = the preset's spot when it exists) → restore. */
export function resetIsland(form: JObj, ref: string): { ok: true; form: JObj } | { ok: false; error: string } {
  const def = REGISTRY[kindOf(ref)];
  if (!def || !def.hideable || def.required) return { ok: false, error: "bad-op: not hideable" };
  const h = applyOp(form, op({ op: "hide", ref }));
  if (!h.ok) return h;
  const f = h.form;
  const hid = hiddenOf(f);
  const i = hid.findIndex((x) => isObj(x) && get(x, "i") === ref);
  if (i < 0) return { ok: false, error: "bad-op: island not hidden" };
  const leaf = clone(hid[i]) as JObj;
  delete leaf["size"];
  delete leaf["from"];
  const spot = presetSpot(form, ref);
  if (spot && findKey(f, spot.parent)) leaf["from"] = op({ parent: spot.parent, index: spot.index });
  const list = hid.slice();
  list[i] = leaf;
  f["hidden"] = list;
  const r = applyOp(f, op({ op: "restore", ref }));
  if (!r.ok) return r;
  return { ok: true, form: r.form };
}

/** The hidden islands of a desktop form, in stored order (the Add island drawer, §7). */
export function hiddenRefs(form: JObj): string[] {
  return hiddenOf(form)
    .map((x) => (isObj(x) && isStr(get(x, "i")) ? (get(x, "i") as string) : null))
    .filter((x): x is string => x !== null);
}

/** Phone form helpers (§12): move a section one step within its column, or toggle it hidden. */
export function phoneMove(form: JObj, ref: string, dir: -1 | 1): JObj | null {
  for (const col of ["rail", "list"] as const) {
    const a = get(form, col);
    if (!isArr(a)) continue;
    const i = a.indexOf(ref);
    if (i < 0) continue;
    const j = i + dir;
    if (j < 0 || j >= a.length) return null;
    const b = a.slice();
    [b[i], b[j]] = [b[j], b[i]];
    const f = clone(form) as JObj;
    f[col] = b;
    return f;
  }
  return null;
}
/**
 * Phone: hide = the section leaves its column for the end of `hidden`; show = it leaves `hidden` for the end of its
 * registry column (LAYOUT §3: a ref appears once across rail, list and hidden). Answers null for an unknown ref.
 */
export function phoneToggle(form: JObj, ref: string, at?: number): JObj | null {
  const def = REGISTRY[kindOf(ref)];
  if (!def || def.phone === null) return null;
  const f = clone(form) as JObj;
  const arr = (k: string): Json[] => (isArr(get(f, k)) ? ((get(f, k) as Json[]).slice() as Json[]) : []);
  const hid = arr("hidden");
  const i = hid.indexOf(ref);
  if (i >= 0) {
    hid.splice(i, 1);
    const col = arr(def.phone);
    // back where it was when it was hidden in this session (`at`), else at the end of its column
    if (at !== undefined && at >= 0 && at < col.length) col.splice(at, 0, ref);
    else col.push(ref);
    f[def.phone] = col;
  } else {
    let found = false;
    for (const k of ["rail", "list"]) {
      const col = arr(k);
      const j = col.indexOf(ref);
      if (j < 0) continue;
      col.splice(j, 1);
      f[k] = col;
      found = true;
    }
    if (!found) return null;
    hid.push(ref);
  }
  f["hidden"] = hid;
  return f;
}

// ---- your own button islands in a session (EDITMODE-UI §7; the layout rules of actions/layoutStore.ts) ---------------
const btnRefsIn = (form: JObj): Set<string> => {
  const out = new Set<string>();
  for (const r of placedRefs(form)) if (r.startsWith("buttons:")) out.add(r);
  for (const r of hiddenRefs(form)) if (r.startsWith("buttons:")) out.add(r);
  const opts = get(form, "opts");
  if (isObj(opts)) for (const k of Object.keys(opts)) if (k.startsWith("buttons:")) out.add(k);
  return out;
};

/** A new empty button island `buttons:b<n>` (the smallest free n), placed by its registry home (the bottom edge). */
export function newButtonIsland(form: JObj): { ok: true; form: JObj; ref: string } | { ok: false; error: string } {
  return newButtonIslandWith(form, op({ items: [] }));
}

/** A new button island whose `main` row is `row` (newButtonIsland, Add button, Add drawer). */
function newButtonIslandWith(form: JObj, row: JObj): { ok: true; form: JObj; ref: string } | { ok: false; error: string } {
  if (placedRefs(form).filter((r) => r.startsWith("buttons:")).length >= 8) return { ok: false, error: "too-many" };
  const used = btnRefsIn(form);
  let n = 1;
  while (used.has(`buttons:b${n}`)) n++;
  const ref = `buttons:b${n}`;
  const f = clone(form) as JObj;
  const hid = hiddenOf(f).slice();
  hid.push(op({ t: "island", i: ref }));
  f["hidden"] = hid;
  const r = applyOp(f, op({ op: "restore", ref }));
  if (!r.ok) return r;
  const s2 = applyOp(r.form, op({ op: "setOpt", ref, key: "rows", value: op({ main: row }) }));
  if (!s2.ok) return s2;
  return { ok: true, form: s2.form, ref };
}

// ---- buttons and drawers (EDITMODE-UI §7.2, §7.3; feat/editmode-buttons-drawers) ------------------------------------
// Add button = a new button island holding ONE action from the catalogue. Add drawer = the island goes into `hidden` and
// a new one-button island runs `layout.drawer.toggle` on it; opening the drawer renders drawerForm (the island in a
// float under its button) — a transient form, never saved. The layout format is unchanged: a Tin Hat that does not know
// the action draws the button as "Needs a newer Tin Hat" and lists the island among the hidden ones (CORE-CHANGES.md).

/** The action a drawer's button runs (ACTIONS.md: target {island, icon?}). */
export const DRAWER_ACTION = "layout.drawer.toggle";
/** The drawer button's icons (the action's `icon` param values, code-point order). */
export const DRAWER_ICONS = ["calendar", "chat", "drawer", "games", "grid", "info", "music", "people", "pin", "star"];
/** Kinds an island in a drawer may have: hideable, floatable, and the same anywhere (not the room group, the call or
 *  room info). */
export const DRAWER_KINDS = ["nav", "dms", "spaces", "rooms", "widgets", "account", "buttons"];
/** The gap between a drawer's button and its panel (layout units). */
export const DRAWER_GAP = 4;
/** drawerForm's numbers are truncated to integers and clamped to ±DRAWER_SPAN first (the same domain in Rust). */
export const DRAWER_SPAN = 65536;
const LOOKS = ["icon", "iconLabel", "label"];

/** A new button island holding one action: `item` = a row item ({a, target?}), `look` icon | iconLabel | label. */
export function newActionButton(form: JObj, item: Json, look: string): { ok: true; form: JObj; ref: string } | { ok: false; error: string } {
  if (!isObj(item) || !isStr(get(item, "a")) || !/^[a-z][a-zA-Z0-9.]{0,63}$/.test(get(item, "a") as string)) return { ok: false, error: "bad-item" };
  if (!LOOKS.includes(look)) return { ok: false, error: "bad-look" };
  return newButtonIslandWith(form, op({ look, items: [clone(item)] }));
}

/** Whether a button island holds a drawer's button (any row): it can't go into a drawer (it would lock itself away). */
function holdsDrawerButton(form: JObj, ref: string): boolean {
  const opts = get(form, "opts");
  const o = isObj(opts) ? get(opts, ref) : undefined;
  const rows = isObj(o) ? get(o, "rows") : undefined;
  if (!isObj(rows)) return false;
  return Object.keys(rows).some((k) => {
    const items = isObj(rows[k]) ? get(rows[k] as JObj, "items") : undefined;
    return isArr(items) && items.some((it) => isObj(it) && get(it, "a") === DRAWER_ACTION);
  });
}

/** The islands that may go into a drawer: placed or hidden, of a DRAWER_KINDS kind, not a drawer's own button island;
 *  kind order, then code-point order. */
export function drawerTargets(form: JObj): string[] {
  const seen = new Set<string>();
  for (const r of placedRefs(form)) seen.add(r);
  for (const r of hiddenRefs(form)) seen.add(r);
  const rank = (r: string) => DRAWER_KINDS.indexOf(kindOf(r));
  return [...seen].filter((r) => rank(r) >= 0 && (r.startsWith("buttons:") || r === kindOf(r)) && !holdsDrawerButton(form, r)).sort((a, b) => rank(a) - rank(b) || cmpCp(a, b));
}

/** Add drawer: `ref` is hidden (when placed) and a new one-button island opens it; answers that island's ref. */
export function newDrawer(form: JObj, ref: string, icon: string): { ok: true; form: JObj; ref: string; island: string } | { ok: false; error: string } {
  if (!drawerTargets(form).includes(ref)) return { ok: false, error: "not-drawer-island" };
  if (icon !== "" && !DRAWER_ICONS.includes(icon)) return { ok: false, error: "bad-icon" };
  // it must be able to open: a free float slot, and a button island in it must not make a ninth placed one
  // a button island in it: after hiding it, its launcher + itself opened must still fit in 8 placed
  if (ref.startsWith("buttons:")) {
    const placed = placedRefs(form);
    const afterHide = placed.filter((r) => r.startsWith("buttons:")).length - (placed.includes(ref) ? 1 : 0);
    if (afterHide >= 7) return { ok: false, error: "too-many" };
  }
  let f = form;
  if (placedRefs(form).includes(ref)) {
    const h = applyOp(form, op({ op: "hide", ref }));
    if (!h.ok) return h;
    f = h.form;
  }
  // a free float slot once it is hidden (hiding an island that floats alone frees its slot)
  if (floatsOf(f).length >= 8) return { ok: false, error: "too-many-floats" };
  const target = icon === "" ? op({ island: ref }) : op({ icon, island: ref });
  const r = newButtonIslandWith(f, op({ look: "icon", items: [op({ a: DRAWER_ACTION, target })] }));
  if (!r.ok) return r;
  return { ok: true, form: r.form, ref: r.ref, island: ref };
}

/** The form a host renders while `ref`'s drawer is open: the hidden island in a float beside its button `btn` (layout
 *  units, host coordinates, integers): under it (over it in the lower half), left-aligned with it (right-aligned in the
 *  right half), DRAWER_GAP away; the float's size is the island's registry float size. Never saved. */
export function drawerForm(form: JObj, ref: string, btn: { x: number; y: number; w: number; h: number }, host: { w: number; h: number }): { ok: true; form: JObj; id: string } | { ok: false; error: string } {
  if (!hiddenRefs(form).includes(ref)) return { ok: false, error: "not-hidden" };
  if (!drawerTargets(form).includes(ref)) return { ok: false, error: "not-drawer-island" };   // whatever a layout says
  const floats = floatsOf(form);
  if (floats.length >= 8) return { ok: false, error: "too-many-floats" };
  if (ref.startsWith("buttons:") && placedRefs(form).filter((r) => r.startsWith("buttons:")).length >= 8) return { ok: false, error: "too-many" };
  const taken = new Set<string>([...placedRefs(form), ...hiddenRefs(form)]);
  for (const fl of floats) if (isObj(fl) && isStr(get(fl, "id"))) taken.add(get(fl, "id") as string);
  for (const l of allLocs(form)) { const k = keyOf(l.node); if (k) taken.add(k); }
  let id = "drawer";
  for (let n = 2; taken.has(id); n++) id = `drawer-${n}`;
  // the input domain: integers in [-DRAWER_SPAN, DRAWER_SPAN] (truncated, then clamped) — exact in both languages
  const n = (v: number) => Math.max(-DRAWER_SPAN, Math.min(DRAWER_SPAN, Number.isFinite(v) ? Math.trunc(v) : 0));
  btn = { x: n(btn.x), y: n(btn.y), w: n(btn.w), h: n(btn.h) };
  host = { w: n(host.w), h: n(host.h) };
  const right = 2 * btn.x + btn.w > host.w; // doubled centre: integer maths (floatAnchor's rule)
  const bottom = 2 * btn.y + btn.h > host.h;
  const clamp = (v: number) => Math.max(-4096, Math.min(4096, v));
  const dx = clamp(right ? host.w - (btn.x + btn.w) : btn.x);
  const dy = clamp(bottom ? host.h - btn.y + DRAWER_GAP : btn.y + btn.h + DRAWER_GAP);
  const f = clone(form) as JObj;
  f["hidden"] = hiddenOf(f).filter((x) => !(isObj(x) && get(x, "i") === ref));
  f["floats"] = [...floatsOf(f), op({ id, anchor: (bottom ? "b" : "t") + (right ? "r" : "l"), dx, dy, node: op({ t: "island", i: ref }) })];
  return { ok: true, form: f, id };
}

/** Remove a button island: hidden, then its leaf and its options dropped. */
export function removeButtonIslandFrom(form: JObj, ref: string): JObj | null {
  let f = form;
  if (placedRefs(form).includes(ref)) {
    const h = applyOp(form, op({ op: "hide", ref }));
    if (!h.ok) return null;
    f = h.form;
  } else f = clone(form) as JObj;
  f["hidden"] = hiddenOf(f).filter((x) => !(isObj(x) && get(x, "i") === ref));
  const opts = get(f, "opts");
  if (isObj(opts)) delete opts[ref];
  return f;
}
