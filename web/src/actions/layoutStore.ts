// layoutStore.ts — this device's layout (11.0 buttons): the desktop form and the phone form the shell renders, in the
// device prefs `layout-desktop` / `layout-phone` (JSON) — the same precedent as the widget list (features/widgets/
// store.ts): device-local UNTIL the synced layout document (`dev.tinhat.layouts`, LAYOUT.md §9) is wired with edit
// mode (step 4), whose first save of `main` copies these two forms verbatim. They are stored exactly as the document
// carries them: the button rows in `opts.<island>.rows.<row>` (LAYOUT.md §3.9, ACTIONS.md §9.2), your own button
// islands as `buttons:<n>` leaves of the tree (a float, the bottom edge, the room column…). No stored form = the
// Classic preset, byte for byte (the dock host's form of 10.8). The desktop app's twin: Main.qml `layoutForm` + the
// pref "layout-desktop" (LayoutController repairs it the same way — the same engine).
//
// Every read is repaired (§5: any stored value → a valid projection); every write goes through the engine (setOpt /
// restore / hide, §8) or through repair, so nothing invalid is ever stored. A form equal to the preset is not stored.
import { useSyncExternalStore } from "react";
import { getPrefRaw, onPrefChange, removePref, setPref } from "@/core/prefs";
import type { JObj, Json } from "@/layout/json";
import { canon, clone, get, isArr, isObj, isStr, obj } from "@/layout/json";
import { applyOp, classicDesktop, classicPhone, repairDesktop, repairPhone } from "@/layout";

export const LAYOUT_DESKTOP_PREF = "layout-desktop";
export const LAYOUT_PHONE_PREF = "layout-phone";
export type FormKind = "desktop" | "phone";
const PREF: Record<FormKind, string> = { desktop: LAYOUT_DESKTOP_PREF, phone: LAYOUT_PHONE_PREF };
const PRESET: Record<FormKind, () => JObj> = { desktop: classicDesktop, phone: classicPhone };

const cache: Record<FormKind, { raw: string | null | undefined; form: JObj }> = {
  desktop: { raw: undefined, form: classicDesktop() },
  phone: { raw: undefined, form: classicPhone() },
};

// ---- 11.0 edit mode (features/editmode, EDITMODE-UI §16): the synced layout document is the source once it exists —
// every read then comes from the layout the device renders (or edit mode's working copy while it is open) and every
// write becomes a save of that layout (or a step of the open edit session). Without a source (or while it answers
// null / false) the device prefs below are the layout, exactly as before; the first save of `main` copies them.
export interface FormSource {
  /** the form to read, or null → the device prefs */
  get(kind: FormKind): JObj | null;
  /** store a (repaired) form; false → the device prefs */
  set(kind: FormKind, form: JObj): boolean;
  subscribe(cb: () => void): () => void;
}
let source: FormSource | null = null;
const sourceListeners = new Set<() => void>();
export function setFormSource(s: FormSource | null): void {
  source = s;
  for (const l of [...sourceListeners]) l();
}

/** The form this device renders: the source's (the synced layout / the edit session), else the device prefs. */
export function getForm(kind: FormKind): JObj {
  return source?.get(kind) ?? getDeviceForm(kind);
}

/** The device prefs' form (repaired; the Classic preset when none is stored). Stable identity until the pref changes. */
export function getDeviceForm(kind: FormKind): JObj {
  const raw = getPrefRaw(PREF[kind]);
  const c = cache[kind];
  if (raw === c.raw) return c.form;
  c.raw = raw;
  let v: Json | null = null;
  if (raw !== null) {
    try {
      v = JSON.parse(raw) as Json;
    } catch {
      v = null;
    }
  }
  c.form = v === null ? PRESET[kind]() : (kind === "desktop" ? repairDesktop(v) : repairPhone(v)).form;
  return c.form;
}

/** React: the device's form, live (other tabs too; the source's changes too). */
export function useForm(kind: FormKind): JObj {
  return useSyncExternalStore(
    (cb) => {
      const a = onPrefChange(PREF[kind], cb);
      sourceListeners.add(cb);
      let b = source?.subscribe(cb) ?? null;
      const re = () => {
        b?.();
        b = source?.subscribe(cb) ?? null;
      };
      sourceListeners.add(re);
      return () => {
        a();
        b?.();
        sourceListeners.delete(cb);
        sourceListeners.delete(re);
      };
    },
    () => getForm(kind),
    () => getForm(kind),
  );
}

/** Store a form (repaired first; the preset itself → the pref is removed). With a source: its save / session step. */
export function setForm(kind: FormKind, form: JObj | null): void {
  if (form === null) {
    if (source?.set(kind, PRESET[kind]())) return;
    removePref(PREF[kind]);
    return;
  }
  const f = (kind === "desktop" ? repairDesktop(form) : repairPhone(form)).form;
  if (source?.set(kind, f)) return;
  if (canon(f) === canon(PRESET[kind]())) removePref(PREF[kind]);
  else setPref(PREF[kind], JSON.parse(JSON.stringify(f)) as object);
}

// ---- button rows (ACTIONS.md §9.2: opts.<island ref>.rows.<row id>) --------------------------------------------------

/** The stored row value of an island's row, or undefined (the preset's default row applies, actions/rows.ts). */
export function storedRow(form: JObj, islandRef: string, rowId: string): Json | undefined {
  const opts = get(form, "opts");
  const o = isObj(opts) ? get(opts, islandRef) : undefined;
  const rows = isObj(o) ? get(o, "rows") : undefined;
  return isObj(rows) ? get(rows, rowId) : undefined;
}

/** Set (value) or remove (null: back to the default row) one row of one island. Answers "ok" or an engine error. */
export function setRow(kind: FormKind, islandRef: string, rowId: string, value: Json | null): string {
  const form = clone(getForm(kind)) as JObj;
  const opts = isObj(get(form, "opts")) ? (get(form, "opts") as JObj) : obj();
  const o = isObj(get(opts, islandRef)) ? (clone(get(opts, islandRef) as JObj) as JObj) : obj();
  const rows = isObj(get(o, "rows")) ? (clone(get(o, "rows") as JObj) as JObj) : obj();
  if (value === null) delete rows[rowId];
  else rows[rowId] = clone(value);
  if (kind === "phone") {
    // the phone form has no operations (§8 is the desktop form's): edit, then repair (invalid rows are dropped there)
    if (Object.keys(rows).length > 0) o["rows"] = rows;
    else delete o["rows"];
    if (Object.keys(o).length > 0) opts[islandRef] = o;
    else delete opts[islandRef];
    form["opts"] = opts;
    setForm(kind, form);
    return "ok";
  }
  const op = obj();
  op["op"] = "setOpt";
  op["ref"] = islandRef;
  op["key"] = "rows";
  if (Object.keys(rows).length > 0) op["value"] = rows;
  const r = applyOp(form, op);
  if (!r.ok) return r.error;
  setForm(kind, r.form);
  return "ok";
}

// ---- your own button islands (`buttons:<n>`, LAYOUT.md §2.3; ACTIONS.md §9.1 row kind buttons.main) --------------

/** Where a new button island goes (the dock host's operations, LAYOUT.md §8.2). */
export type Placement = "roomColumn" | "underHeader" | "bottom" | "float";
export const PLACEMENTS: readonly { id: Placement; label: string }[] = [
  { id: "roomColumn", label: "Under the room list" },
  { id: "underHeader", label: "Under the room header" },
  { id: "bottom", label: "Along the bottom of the window" },
  { id: "float", label: "Floating over the chat, on the right" },
];
function placementOp(p: Placement): JObj {
  const to = obj();
  if (p === "roomColumn") Object.assign(to, { op: "dockBeside", target: "account", side: "top" });
  else if (p === "underHeader") Object.assign(to, { op: "dockBeside", target: "header", side: "bottom" });
  else if (p === "bottom") Object.assign(to, { op: "edge", side: "bottom" });
  else Object.assign(to, { op: "float", anchor: "r", dx: 16, dy: 0 });
  return to;
}

/** Every `buttons:<n>` ref of a desktop form that is placed (the root tree and the floats), in code-point order. */
export function buttonIslands(form: JObj): string[] {
  const out = new Set<string>();
  const walk = (n: Json | undefined) => {
    if (!isObj(n)) return;
    const i = get(n, "i");
    if (isStr(i) && i.startsWith("buttons:")) out.add(i);
    const c = get(n, "c");
    if (isArr(c)) for (const k of c) walk(k);
  };
  walk(get(form, "root"));
  const fl = get(form, "floats");
  if (isArr(fl)) for (const f of fl) if (isObj(f)) walk(get(f, "node"));
  return [...out].sort();
}

/** Every `buttons:*` string the form mentions anywhere (placed, hidden, opts) — a new instance id avoids them all. */
function usedButtonRefs(form: JObj): Set<string> {
  const s = new Set<string>(buttonIslands(form));
  const h = get(form, "hidden");
  if (isArr(h)) for (const x of h) if (isObj(x) && isStr(get(x, "i"))) s.add(get(x, "i") as string);
  const opts = get(form, "opts");
  if (isObj(opts)) for (const k of Object.keys(opts)) if (k.startsWith("buttons:")) s.add(k);
  return s;
}

/** Add an empty button island at `p` (desktop form). Answers the new ref, or an error ("too-many" at the limit of 8). */
export function addButtonIsland(p: Placement, items: Json[] = []): { ok: true; ref: string } | { ok: false; error: string } {
  const form = clone(getForm("desktop")) as JObj;
  if (buttonIslands(form).length >= 8) return { ok: false, error: "too-many" };
  const used = usedButtonRefs(form);
  let n = 1;
  while (used.has(`buttons:b${n}`)) n++;
  const ref = `buttons:b${n}`;
  const hidden = isArr(get(form, "hidden")) ? (get(form, "hidden") as Json[]).slice() : [];
  const leaf = obj();
  leaf["t"] = "island";
  leaf["i"] = ref;
  hidden.push(leaf);
  form["hidden"] = hidden;
  const op = obj();
  op["op"] = "restore";
  op["ref"] = ref;
  op["to"] = placementOp(p);
  const r = applyOp(form, op);
  if (!r.ok) return { ok: false, error: r.error };
  const f2 = r.form;
  const o = obj();
  const rows = obj();
  const main = obj();
  main["items"] = clone(items) as Json[];
  rows["main"] = main;
  o["rows"] = rows;
  const opts = isObj(get(f2, "opts")) ? (get(f2, "opts") as JObj) : obj();
  opts[ref] = o;
  f2["opts"] = opts;
  setForm("desktop", f2);
  return { ok: true, ref };
}

/** Remove a button island for good (its place and its buttons). */
export function removeButtonIsland(ref: string): string {
  const form = clone(getForm("desktop")) as JObj;
  let f = form;
  if (buttonIslands(form).includes(ref)) {
    const op = obj();
    op["op"] = "hide";
    op["ref"] = ref;
    const r = applyOp(form, op);
    if (!r.ok) return r.error;
    f = r.form;
  }
  const h = get(f, "hidden");
  if (isArr(h)) f["hidden"] = h.filter((x) => !(isObj(x) && get(x, "i") === ref));
  const opts = get(f, "opts");
  if (isObj(opts)) delete opts[ref];
  setForm("desktop", f);
  return "ok";
}

/** "Button island 1, 2 …" — in the order of their instance ids. */
export function buttonIslandName(form: JObj, ref: string): string {
  const i = buttonIslands(form).indexOf(ref);
  return `Button island ${i >= 0 ? i + 1 : ""}`.trim();
}
