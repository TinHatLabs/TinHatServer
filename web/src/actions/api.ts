// api.ts — the actions engine as JSON in / JSON out (ACTIONS.md §11): the functions the shared vectors call, and the
// shape the desktop's ActionsController (crates/app/src/actions_ctl.rs → crates/actions) answers with. Every function
// takes one JSON value and returns one; none throws; a malformed input answers {"error": "<code>"}.
import type { JObj, Json } from "../layout/json";
import { clone, get, has, isObj, isStr, obj } from "../layout/json";
import type { App } from "./table";
import { APPS, TABLE, actionById, reg } from "./table";
import type { EvalInput } from "./evaluate";
import { defaultKeys, drawer as drawerOf, evalMenu, evalRow, present, validateTarget } from "./evaluate";
import { aliasTier, choiceEntries, entriesOut, fold as foldText, keywordTier, nameTier, palette as paletteOf } from "./palette";
import { parseSequence } from "./keys";
import { checkUserBinding, effectiveBindings, matchKey, setUserBinding, shortcutsView } from "./bindings";

const err = (code: string): JObj => {
  const o = obj();
  o.error = code;
  return o;
};
const asApp = (v: Json | undefined): App | undefined => (isStr(v) && (APPS as readonly string[]).includes(v) ? (v as App) : undefined);
const asForm = (v: Json | undefined): "desktop" | "phone" | undefined => (v === "desktop" || v === "phone" ? v : undefined);
const asSnapshot = (v: Json | undefined): JObj => (isObj(v) ? v : obj());
const asObj = (v: Json | undefined): JObj | undefined => (isObj(v) ? v : undefined);
/** A plain JSON value (prototype-less objects) of any engine result. */
const out = (v: unknown): JObj => clone(v as Json) as JObj;

/**
 * evaluate {app, action, snapshot?, target?, context?, params?, row?, menu?, item?, form?, transient?} → the
 * Presentation (ACTIONS.md §7). `menu` + `item` (an index) take the action, target, label, when and forms from that
 * menu item.
 */
export function evaluate(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const ev: EvalInput = { app, action: "", snapshot: asSnapshot(get(input, "snapshot")) };
  const menuId = get(input, "menu");
  if (menuId !== undefined) {
    if (!isStr(menuId)) return err("bad-menu");
    const md = reg(TABLE.menus, menuId);
    if (!md) return err("unknown-menu");
    const idx = get(input, "item");
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= md.items.length) return err("bad-item");
    const it = md.items[idx];
    if (!isStr(it.a)) return err("not-an-action");
    ev.action = it.a;
    ev.menu = menuId;
    ev.item = it as unknown as JObj;
    if (it.target !== undefined) ev.target = it.target;
    const form = asForm(get(input, "form"));
    if (form) ev.form = form;
  } else {
    const a = get(input, "action");
    if (!isStr(a)) return err("bad-action");
    ev.action = a;
    const t = get(input, "target");
    if (t !== undefined) ev.target = t;
    const row = get(input, "row");
    if (row !== undefined) {
      if (!isStr(row) || !reg(TABLE.rows, row)) return err("unknown-row");
      ev.row = row;
    }
    if (get(input, "transient") === true) ev.transient = true;
  }
  const ctx = asObj(get(input, "context"));
  if (ctx) ev.context = ctx;
  const params = asObj(get(input, "params"));
  if (params) ev.params = params;
  return out(present(ev));
}

/** row {app, snapshot?, row, value, context?} → the RowOut (ACTIONS.md §9.4): a layout row value resolved for drawing. */
export function row(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const rk = get(input, "row");
  if (!isStr(rk) || !reg(TABLE.rows, rk)) return err("unknown-row");
  return out(evalRow(app, asSnapshot(get(input, "snapshot")), rk, get(input, "value") ?? null, asObj(get(input, "context"))));
}

/** menu {app, snapshot?, menu, form, context?} → the MenuOut (ACTIONS.md §9.7). */
export function menu(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const m = get(input, "menu");
  if (!isStr(m) || !reg(TABLE.menus, m)) return err("unknown-menu");
  const form = asForm(get(input, "form"));
  if (!form) return err("bad-form");
  return out(evalMenu(app, asSnapshot(get(input, "snapshot")), m, form, asObj(get(input, "context"))));
}

/**
 * place {row, item} → {ok: true, item} | {ok: false, error, key?} — may this item be put into a row of this kind
 * (edit mode; ACTIONS.md §9.3)? The first failure: unknown-row, bad-item, unknown-action, context (a contextOnly
 * action in a row that provides none of its contexts), bad-flag (hideWhenOff / sepBefore not boolean), then the
 * target's (validateTarget). The answer's item is the normalized item: {a, target? (only when not empty),
 * hideWhenOff? / sepBefore? (only when true)}.
 */
export function place(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const rk = get(input, "row");
  const rowDef = isStr(rk) ? reg(TABLE.rows, rk) : undefined;
  const fail = (error: string, key?: string): JObj => {
    const o = obj();
    o.ok = false;
    o.error = error;
    if (key !== undefined) o.key = key;
    return o;
  };
  if (!rowDef) return fail("unknown-row");
  const item = get(input, "item");
  if (!isObj(item) || !isStr(get(item, "a"))) return fail("bad-item");
  const a = actionById(item.a as string);
  if (!a) return fail("unknown-action");
  if (a.contexts && !a.contexts.some((c) => rowDef.contexts.includes(c))) return fail("context");
  for (const f of ["hideWhenOff", "sepBefore"]) {
    if (has(item, f) && typeof item[f] !== "boolean") return fail("bad-flag", f);
  }
  const chk = validateTarget(a, get(item, "target"));
  if (!chk.ok) return fail(chk.error, chk.key);
  const norm = obj();
  norm.a = a.id;
  if (Object.keys(chk.target).length > 0) norm.target = chk.target;
  for (const f of ["hideWhenOff", "sepBefore"]) if (item[f] === true) norm[f] = true;
  const o = obj();
  o.ok = true;
  o.item = norm;
  return o;
}

/** target {action, target, transient?} → validateTarget's answer (ACTIONS.md §5.6). */
export function target(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const id = get(input, "action");
  const a = isStr(id) ? actionById(id) : undefined;
  if (!a) return err("unknown-action");
  return out(validateTarget(a, get(input, "target"), get(input, "transient") === true));
}

/** palette {app, snapshot?, query?, stage?} → the PaletteOut (ACTIONS.md §10). */
export function palette(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const q = get(input, "query");
  if (q !== undefined && !isStr(q)) return err("bad-query");
  const st = get(input, "stage");
  if (st !== undefined && !isStr(st)) return err("bad-stage");
  return out(paletteOf(app, asSnapshot(get(input, "snapshot")), (q as string | undefined) ?? "", st as string | undefined));
}

/** choices {app, snapshot?, action} → {items: [...]} | {items: null} — stage 2's entries before ranking (§10.6). */
export function choices(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const id = get(input, "action");
  if (!isStr(id)) return err("bad-action");
  const ch = choiceEntries(app, asSnapshot(get(input, "snapshot")), id);
  const o = obj();
  o.items = ch === null ? null : (out(entriesOut(ch)) as unknown as Json);
  return o;
}

/** fold {text} → {folded} ; score {text, query, as: name|keyword|alias} → {tier} (the ranking's parts, §10.3–§10.4). */
export function fold(input: Json): JObj {
  if (!isObj(input) || !isStr(get(input, "text"))) return err("bad-input");
  const o = obj();
  o.folded = foldText(input.text as string);
  return o;
}
export function score(input: Json): JObj {
  if (!isObj(input) || !isStr(get(input, "text")) || !isStr(get(input, "query"))) return err("bad-input");
  const as = get(input, "as");
  const t = foldText(input.text as string);
  const q = foldText(input.query as string);
  const o = obj();
  if (as === "name") o.tier = nameTier(t, q);
  else if (as === "keyword") o.tier = keywordTier(t, q);
  else if (as === "alias") o.tier = aliasTier(t, q);
  else return err("bad-as");
  return o;
}

/** drawer {app, snapshot?, row} → {groups: [...]} — the edit-mode drawer of a row kind (ACTIONS.md §9.6). */
export function drawer(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const rk = get(input, "row");
  if (!isStr(rk) || !reg(TABLE.rows, rk)) return err("unknown-row");
  const o = obj();
  o.groups = out(drawerOf(app, asSnapshot(get(input, "snapshot")), rk, foldText)) as unknown as Json;
  return o;
}

/**
 * summary {app} → the per-app view of the table (ACTIONS.md §11): every action of the app in id order with its
 * group, placeable / contexts, target kind, toggle state, flags, icon, label, default keys and whether the palette
 * lists it.
 */
export function summary(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const actions: Json[] = [];
  for (const a of TABLE.actions) {
    if (!a.apps.includes(app)) continue;
    const byApp = a.iconByApp ? get(a.iconByApp as unknown as JObj, app) : undefined;
    const e = obj();
    e.id = a.id;
    e.group = a.group;
    e.placeable = !a.contexts;
    e.contexts = a.contexts ? [...a.contexts] : [];
    e.target = a.target ? a.target.kind : null;
    e.toggle = a.toggle ? a.toggle.state : null;
    e.hold = a.hold === true;
    e.danger = a.danger === true;
    e.confirm = a.confirm ? a.confirm.kind : null;
    e.icon = isStr(byApp) ? byApp : a.icon;
    e.label = a.label;
    e.keys = defaultKeys(a, app);
    e.palette = !a.contexts && a.palette !== false && a.hold !== true && a.pending === undefined;
    e.pending = a.pending ?? null;
    actions.push(e);
  }
  const o = obj();
  o.app = app;
  o.actions = actions;
  return o;
}

// ---- key bindings (ACTIONS.md §8) -------------------------------------------------------------------------------

/** sequence {text} → {ok: true, text, key, ctrl, alt, shift, meta, bare} | {ok: false, error} (§8.1). */
export function sequence(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  return out(parseSequence(get(input, "text")));
}
/** checkBinding {app, action, key} → {ok: true, key, scope, typing} | {ok: false, error} (§8.4). */
export function checkBinding(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const a = get(input, "action");
  if (!isStr(a)) return err("bad-action");
  return out(checkUserBinding(app, a, get(input, "key")));
}
/** effective {app, doc?} → {bindings, conflicts, notes, unknown} (§8.5, §8.6); `doc` = the user document (absent = none). */
export function effective(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  return out(effectiveBindings(app, get(input, "doc")));
}
/** matchKey {app, doc?, key, scope?, typing?} → {actions: [ids in dispatch order]} (§8.7); scope default main. */
export function matchKeyApi(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const k = get(input, "key");
  if (!isStr(k)) return err("bad-key");
  const sc = get(input, "scope");
  if (sc !== undefined && !isStr(sc)) return err("bad-scope");
  const o = obj();
  o.actions = matchKey(effectiveBindings(app, get(input, "doc")).bindings, k, (sc as string | undefined) ?? "main", get(input, "typing") === true);
  return o;
}
/** setBinding {app, doc?, action, keys: [..] | null} → {doc: <the new document> | null} (§8.8). */
export function setBinding(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  const a = get(input, "action");
  if (!isStr(a)) return err("bad-action");
  const ks = get(input, "keys");
  if (ks !== null && !Array.isArray(ks)) return err("bad-keys");
  const o = obj();
  o.doc = setUserBinding(app, get(input, "doc"), a, ks as Json[] | null);
  return o;
}
/** shortcuts {app, doc?} → {groups: [{group, label, items}], conflicts, notes} — Settings → Shortcuts (§8.8). */
export function shortcuts(input: Json): JObj {
  if (!isObj(input)) return err("bad-input");
  const app = asApp(get(input, "app"));
  if (!app) return err("bad-app");
  return out(shortcutsView(app, get(input, "doc")));
}

/** Every entry point by name (the vector files' `kind`). */
export const API: Record<string, (input: Json) => JObj> = {
  sequence,
  checkBinding,
  effective,
  matchKey: matchKeyApi,
  setBinding,
  shortcuts,
  evaluate,
  row,
  menu,
  place,
  target,
  palette,
  choices,
  fold,
  score,
  drawer,
  summary,
};
