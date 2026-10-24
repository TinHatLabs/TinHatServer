// bindings.ts — the key bindings in effect (ACTIONS.md §8.2–§8.8): the table's defaults for one app, which actions a
// person may give a key, the device-local user document (`tinhat-shortcuts`, pref `shortcuts`), the checks a user
// binding must pass, the bindings in effect with the one each key press runs, the clashes Settings → Shortcuts flags,
// the Settings list itself, and the edits it makes. Pure; the desktop's crates/actions/src/bindings.rs is the same
// code, proven by the shared vectors (testvectors/actions/bindings/).
import type { JObj, Json } from "../layout/json";
import { canon, get, has, isArr, isObj, obj } from "../layout/json";
import { cmpCodePoint } from "../theme/canon";
import { utf8Length } from "../theme/limits";
import type { Action, App } from "./table";
import { TABLE, actionById, scopeChain, scopesOverlap } from "./table";
import { isFunctionKey, parseSequence, webClass } from "./keys";
import { fold } from "./palette";

export interface Binding {
  action: string;
  key: string;
  scope: string;
  typing: boolean;
  fixed: boolean;
  rank: number;
  hold: boolean;
  source: "default" | "user";
  params: JObj;
  /** this binding is the one its key runs (no binding of another action with the same key in an overlapping scope
   *  comes first in the dispatch order, §8.6) */
  wins: boolean;
}

export interface Conflict {
  key: string;
  actions: [string, string];
  scopes: [string, string];
}

const inApp = (a: Action, app: App) => a.apps.includes(app);

/** The table's default bindings for one app, in table order (action id, then shortcut spec, then key). */
export function defaultBindings(app: App): Binding[] {
  const out: Binding[] = [];
  for (const a of TABLE.actions) {
    if (!inApp(a, app) || !a.shortcut) continue;
    for (const s of a.shortcut) {
      const own = app === "web" ? s.web : s.desktop;
      for (const k of own ?? s.keys) {
        const p = parseSequence(k);
        if (!p.ok) continue; // the validator refuses such a table
        const params = obj();
        if (s.params) for (const pk of Object.keys(s.params).sort(cmpCodePoint)) params[pk] = s.params[pk];
        out.push({ action: a.id, key: p.text, scope: s.scope, typing: s.typing === true, fixed: s.fixed === true, rank: s.rank ?? 0, hold: a.hold === true, source: "default", params, wins: false });
      }
    }
  }
  return out;
}

/**
 * May a person give this action a key (ACTIONS.md §8.3)? It is in the app, placeable (no `contexts`), not `pending`,
 * none of its defaults is `fixed`, and it needs no stored target (no target, or one with an `absent` rule: a key runs
 * it on the room on screen, or opens its picker).
 */
export function assignable(a: Action, app: App): boolean {
  if (!inApp(a, app) || (a.contexts && a.contexts.length > 0) || a.pending !== undefined) return false;
  if ((a.shortcut ?? []).some((s) => s.fixed === true)) return false;
  return !a.target || a.target.absent !== undefined;
}

export type BindingCheck = { ok: true; key: string; scope: string; typing: boolean } | { ok: false; error: string };

/**
 * May `text` become a user binding of `actionId` in `app` (ACTIONS.md §8.4)? The first failure: unknown-action,
 * other-app, not-assignable, bad-sequence, reserved (keys.reserved), hold-key (a hold action takes a modifier held
 * alone or an F-key without modifiers), hold-only (a modifier alone is for a hold action), needs-modifier (outside a
 * window scope a key needs Ctrl, Alt or Meta, or is an F-key: a plain or Shift+ letter types), browser-reserved (web:
 * the browser never hands it to a page), fixed-taken (a fixed default of the app holds it in an overlapping scope).
 * The binding's scope and typing are the action's first default's (else `app`, typing on).
 */
export function checkUserBinding(app: App, actionId: string, text: Json | undefined): BindingCheck {
  const a = actionById(actionId);
  if (!a) return { ok: false, error: "unknown-action" };
  if (!inApp(a, app)) return { ok: false, error: "other-app" };
  if (!assignable(a, app)) return { ok: false, error: "not-assignable" };
  const p = parseSequence(text);
  if (!p.ok) return { ok: false, error: "bad-sequence" };
  if (TABLE.keys.reserved.includes(p.text)) return { ok: false, error: "reserved" };
  const plainF = isFunctionKey(p.key) && !p.ctrl && !p.alt && !p.shift && !p.meta;
  if (a.hold === true) {
    if (!p.bare && !plainF) return { ok: false, error: "hold-key" };
  } else if (p.bare) return { ok: false, error: "hold-only" };
  const first = a.shortcut && a.shortcut.length > 0 ? a.shortcut[0] : undefined;
  const scope = first ? first.scope : "app";
  if (a.hold !== true && !scope.startsWith("window:") && !p.ctrl && !p.alt && !p.meta && !isFunctionKey(p.key)) return { ok: false, error: "needs-modifier" };
  if (app === "web" && webClass(p.text) === "reserved") return { ok: false, error: "browser-reserved" };
  for (const b of defaultBindings(app)) {
    if (b.fixed && b.key === p.text && scopesOverlap(scope, b.scope)) return { ok: false, error: "fixed-taken" };
  }
  return { ok: true, key: p.text, scope, typing: first ? first.typing === true : true };
}

export interface UserBindings {
  /** action id → canonical sequences ([] = no key) — only actions of this app that passed the checks */
  entries: Record<string, string[]>;
  /** entries this app does not know (another app's, a newer version's): kept verbatim so a save never drops them */
  unknown: JObj;
  notes: string[];
}

/**
 * Read the device-local user document `{format: "tinhat-shortcuts", version: 1, bindings: {id: [seq…]}}`
 * (ACTIONS.md §8.5). Never throws; anything unusable becomes a note: not-object, too-large, bad-format, bad-version,
 * bad-field bindings, too-many-actions, `other-app <id>`, `unknown-action <id>`, `bad-entry <id>`, `too-many <id>`,
 * `bad-sequence <id> <index>`, `duplicate <id> <key>`, `<check error> <id> <key>`, `no-usable-key <id>` (a non-empty
 * list whose every key failed: dropped, the defaults stay).
 */
export function readUserBindings(app: App, doc: Json | undefined): UserBindings {
  const res: UserBindings = { entries: Object.create(null) as Record<string, string[]>, unknown: obj(), notes: [] };
  if (doc === undefined || doc === null) return res;
  if (!isObj(doc)) {
    res.notes.push("not-object");
    return res;
  }
  if (utf8Length(canon(doc)) > (TABLE.limits.bindingsBytes ?? 16384)) {
    res.notes.push("too-large");
    return res;
  }
  if (get(doc, "format") !== "tinhat-shortcuts") {
    res.notes.push("bad-format");
    return res;
  }
  if (get(doc, "version") !== 1) {
    res.notes.push("bad-version");
    return res;
  }
  const bs = get(doc, "bindings");
  if (!isObj(bs)) {
    res.notes.push("bad-field bindings");
    return res;
  }
  let ids = Object.keys(bs).sort(cmpCodePoint);
  const maxActions = TABLE.limits.bindingsActions ?? 256;
  if (ids.length > maxActions) {
    ids = ids.slice(0, maxActions);
    res.notes.push("too-many-actions");
  }
  const per = TABLE.limits.bindingsPerAction ?? 4;
  for (const id of ids) {
    const v = bs[id];
    const a = actionById(id);
    if (!a || !inApp(a, app)) {
      res.unknown[id] = v;
      res.notes.push(`${a ? "other-app" : "unknown-action"} ${id}`);
      continue;
    }
    if (!isArr(v)) {
      res.notes.push(`bad-entry ${id}`);
      continue;
    }
    let list = v;
    if (list.length > per) {
      list = list.slice(0, per);
      res.notes.push(`too-many ${id}`);
    }
    const keys: string[] = [];
    list.forEach((x, i) => {
      const p = parseSequence(x);
      if (!p.ok) {
        res.notes.push(`bad-sequence ${id} ${i}`);
        return;
      }
      if (keys.includes(p.text)) {
        res.notes.push(`duplicate ${id} ${p.text}`);
        return;
      }
      const c = checkUserBinding(app, id, p.text);
      if (!c.ok) {
        res.notes.push(`${c.error} ${id} ${p.text}`);
        return;
      }
      keys.push(p.text);
    });
    // a list whose every key failed is not a choice of "no key": the entry is dropped and the defaults stay
    if (list.length > 0 && keys.length === 0) {
      res.notes.push(`no-usable-key ${id}`);
      continue;
    }
    res.entries[id] = keys;
  }
  return res;
}

export interface Effective {
  bindings: Binding[];
  conflicts: Conflict[];
  notes: string[];
  unknown: JObj;
}

/** The dispatch order of two bindings that share a key (§8.6): rank, a person's own before a default, action id,
 *  then list order. */
function before(x: Binding, xi: number, y: Binding, yi: number): boolean {
  if (x.rank !== y.rank) return x.rank < y.rank;
  if (x.source !== y.source) return x.source === "user";
  const c = cmpCodePoint(x.action, y.action);
  if (c !== 0) return c < 0;
  return xi < yi;
}

/**
 * The bindings in effect (ACTIONS.md §8.6): the defaults — an action with a user entry drops its (non-fixed) defaults
 * for the person's list — then the user's, by action id. `wins`: no binding of ANOTHER action with the same key in an
 * overlapping scope comes before it in the dispatch order. Every clash — two bindings of different actions with the
 * same key in overlapping scopes, not both fixed — in list order.
 */
export function effectiveBindings(app: App, doc?: Json): Effective {
  const user = readUserBindings(app, doc);
  const out: Binding[] = [];
  for (const b of defaultBindings(app)) {
    if (!b.fixed && has(user.entries, b.action)) continue;
    out.push(b);
  }
  for (const id of Object.keys(user.entries).sort(cmpCodePoint)) {
    const a = actionById(id) as Action;
    for (const k of user.entries[id]) {
      const c = checkUserBinding(app, id, k);
      if (!c.ok) continue;
      out.push({ action: id, key: c.key, scope: c.scope, typing: c.typing, fixed: false, rank: 0, hold: a.hold === true, source: "user", params: obj(), wins: false });
    }
  }
  const conflicts: Conflict[] = [];
  for (let i = 0; i < out.length; i++) {
    let wins = true;
    for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      const x = out[i];
      const y = out[j];
      if (x.key !== y.key || x.action === y.action || !scopesOverlap(x.scope, y.scope)) continue;
      if (before(y, j, x, i)) wins = false;
      if (j > i && !(x.fixed && y.fixed)) conflicts.push({ key: x.key, actions: [x.action, y.action], scopes: [x.scope, y.scope] });
    }
    out[i].wins = wins;
  }
  return { bindings: out, conflicts, notes: user.notes, unknown: user.unknown };
}

/** The actions a key press runs, in dispatch order (§8.7): bindings of the key whose scope is in the chain of the
 *  focused scope (innermost first), typing ones only while a text field has focus, holds left out (their hosts watch
 *  the key's press and release), a non-fixed binding only when it `wins` its key. The host runs the first one that is
 *  available right now. */
export function matchKey(bindings: Binding[], key: string, scope: string, typing: boolean): string[] {
  const chain = scopeChain(scope);
  const list: { b: Binding; i: number; ci: number }[] = [];
  bindings.forEach((b, i) => {
    // a clash's loser never runs (the hosts give a key to its winner only, §8.6); fixed ones stay (focus decides)
    if (b.key !== key || b.hold || (!b.fixed && !b.wins)) return;
    const ci = chain.indexOf(b.scope);
    if (ci < 0 || (typing && !b.typing)) return;
    list.push({ b, i, ci });
  });
  list.sort((x, y) => x.ci - y.ci || (before(x.b, x.i, y.b, y.i) ? -1 : before(y.b, y.i, x.b, x.i) ? 1 : 0));
  const out: string[] = [];
  for (const { b } of list) if (!out.includes(b.action)) out.push(b.action);
  return out;
}

/**
 * The user document after one edit (ACTIONS.md §8.8): `keys` null = back to the action's defaults (its entry removed),
 * else the action's keys (each parsed and checked — a key that fails is left out; duplicates once; at most
 * limits.bindingsPerAction), [] = no key; a non-empty list whose every key fails changes nothing. An entry equal to the
 * action's defaults is removed. Entries this app does not know are kept. An edit that would take the document past
 * limits.bindingsActions entries or limits.bindingsBytes (what a reader keeps, §8.5) changes nothing: the document is
 * answered as it was. Answers the new document, or null when it holds no entry (the host removes the pref).
 */
export function setUserBinding(app: App, doc: Json | undefined, actionId: string, keys: Json[] | null): JObj | null {
  const user = readUserBindings(app, doc);
  const entries: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const id of Object.keys(user.unknown)) entries[id] = user.unknown[id];
  for (const id of Object.keys(user.entries)) entries[id] = user.entries[id];
  const a = actionById(actionId);
  if (a && inApp(a, app) && assignable(a, app)) {
    if (keys === null) delete entries[actionId];
    else {
      const list: string[] = [];
      for (const k of keys) {
        const c = checkUserBinding(app, actionId, k);
        if (c.ok && !list.includes(c.key) && list.length < (TABLE.limits.bindingsPerAction ?? 4)) list.push(c.key);
      }
      const defaults = defaultBindings(app).filter((b) => b.action === actionId).map((b) => b.key);
      // keys whose every one failed change nothing (only an empty list means "no key")
      if (keys.length > 0 && list.length === 0) {
        /* the entry stays as it was */
      } else if (canon(list) === canon(defaults)) delete entries[actionId];
      else entries[actionId] = list;
    }
  }
  const ids = Object.keys(entries).sort(cmpCodePoint);
  if (ids.length === 0) return null;
  const bs = obj();
  for (const id of ids) bs[id] = entries[id];
  const out = obj();
  out.bindings = bs;
  out.format = "tinhat-shortcuts";
  out.version = 1;
  if (ids.length > (TABLE.limits.bindingsActions ?? 256) || utf8Length(canon(out)) > (TABLE.limits.bindingsBytes ?? 16384)) {
    return isObj(doc) ? doc : null;
  }
  return out;
}

export interface ShortcutItem {
  a: string;
  label: string;
  icon: string | null;
  /** the keys it has now (the person's, else the defaults), in order */
  keys: string[];
  defaults: string[];
  /** the person changed its keys (the document has an entry) */
  changed: boolean;
  hold: boolean;
  /** per key: the other actions that also have it (a clash, §8.6) — [{key, with: [action ids]}] in key order */
  clashes: { key: string; with: string[] }[];
  /** web: the keys the browser also uses (Tin Hat takes them while it has the focus) */
  browser: string[];
}
export interface ShortcutGroup {
  group: string;
  label: string;
  items: ShortcutItem[];
}

/**
 * Settings → Shortcuts (ACTIONS.md §8.8): every assignable action of the app, per group in `groups` order (empty
 * groups left out), each group by folded label (§10.3, code-point order) then id, with its keys, defaults, clashes
 * and (web) the browser's keys. `conflicts` counts the clashes (pairs).
 */
export function shortcutsView(app: App, doc?: Json): { groups: ShortcutGroup[]; conflicts: number; notes: string[] } {
  const eff = effectiveBindings(app, doc);
  const user = readUserBindings(app, doc);
  const groups: ShortcutGroup[] = [];
  for (const g of TABLE.groups) {
    const acts = TABLE.actions
      .filter((a) => a.group === g.id && assignable(a, app))
      .map((a) => ({ a, f: fold(a.label) }))
      .sort((x, y) => cmpCodePoint(x.f, y.f) || cmpCodePoint(x.a.id, y.a.id));
    const items: ShortcutItem[] = [];
    for (const { a } of acts) {
      const keys: string[] = [];
      for (const b of eff.bindings) if (b.action === a.id && !keys.includes(b.key)) keys.push(b.key);
      const defaults: string[] = [];
      for (const b of defaultBindings(app)) if (b.action === a.id && !defaults.includes(b.key)) defaults.push(b.key);
      const clashes: { key: string; with: string[] }[] = [];
      for (const k of keys) {
        const w: string[] = [];
        for (const c of eff.conflicts) {
          if (c.key !== k) continue;
          const other = c.actions[0] === a.id ? c.actions[1] : c.actions[1] === a.id ? c.actions[0] : null;
          if (other !== null && !w.includes(other)) w.push(other);
        }
        if (w.length > 0) clashes.push({ key: k, with: w });
      }
      const icon = a.iconByApp && has(a.iconByApp, app) ? (a.iconByApp[app] as string) : a.icon;
      items.push({
        a: a.id, label: a.label, icon, keys, defaults, changed: has(user.entries, a.id), hold: a.hold === true, clashes,
        browser: app === "web" ? keys.filter((k) => webClass(k) === "browser") : [],
      });
    }
    if (items.length > 0) groups.push({ group: g.id, label: g.label, items });
  }
  return { groups, conflicts: eff.conflicts.length, notes: user.notes };
}
