// evaluate.ts — availability, targets and presentation of an action (ACTIONS.md §4–§7, §9). Pure: a snapshot of the
// app's state in, JSON data out; the Rust port (crates/actions) reproduces every result byte for byte.
//
// Rules that keep the two implementations identical: own keys only (get/has), no locale functions (ASCII case only),
// no regular expressions, strings are measured in code points, map iteration sorts keys by code point, arrays keep
// their order.
import type { JObj, Json } from "../layout/json";
import { get, has, isArr, isInt, isObj, isStr, obj } from "../layout/json";
import { cmpCodePoint } from "../theme/canon";
import type { Action, App, ConfirmSpec, Look, ParamSpec, RowKind, Scale, TargetKind, TargetSpec, When } from "./table";
import { LOOKS, SCALES, TABLE, actionById, reg } from "./table";

// ---- the snapshot ------------------------------------------------------------------------------------------------

/**
 * The app's state as the evaluator sees it (ACTIONS.md §4.3):
 *   values:   global predicate / state values by name
 *   subjects: kind → id → { name?, values? } (scoped values; also the existence and names of targets)
 *   current:  { room?, activeSpace? } — the defaults of `absent` targets
 *   local:    this device's table of device-local targets (local id → { <kind key>: value, label? })
 */
export type Snapshot = JObj;

const sortedKeys = (o: JObj): string[] => Object.keys(o).sort(cmpCodePoint);
const objAt = (o: Json | undefined, k: string): JObj | undefined => {
  if (!isObj(o)) return undefined;
  const v = get(o, k);
  return isObj(v) ? v : undefined;
};
const strAt = (o: Json | undefined, k: string): string | undefined => {
  if (!isObj(o)) return undefined;
  const v = get(o, k);
  return isStr(v) ? v : undefined;
};

/** Subjects of one evaluation: subject kind → id. */
export type Subjects = Record<string, string>;

export interface Env {
  app: App;
  snap: Snapshot;
  subj: Subjects;
  params: JObj;
}

/** The subject entry `snapshot.subjects[kind][id]`, if the snapshot lists it. */
export function subjectEntry(snap: Snapshot, kind: string, id: string): JObj | undefined {
  return objAt(objAt(objAt(snap, "subjects"), kind), id);
}

/** The value of a declared predicate or state (global, or the scoped subject's), or undefined (ACTIONS.md §4.2). */
export function readValue(name: string, env: Env): Json | undefined {
  const def = reg(TABLE.predicates, name) ?? reg(TABLE.states, name);
  if (!def) return undefined;
  if (def.source === "app") return name === "platform.web" ? env.app === "web" : undefined;
  if (def.scope === "global") {
    const vals = objAt(env.snap, "values");
    return vals ? get(vals, name) : undefined;
  }
  const id = has(env.subj, def.scope) ? env.subj[def.scope] : undefined;
  if (id === undefined) return undefined;
  const e = subjectEntry(env.snap, def.scope, id);
  const vals = e ? objAt(e, "values") : undefined;
  return vals ? get(vals, name) : undefined;
}

/** A `when` / `requires` rule (ACTIONS.md §4.1). Absent → true. Anything malformed → false. */
export function evalWhen(w: When | undefined, env: Env): boolean {
  if (w === undefined) return true;
  if (typeof w === "string") return readValue(w, env) === true;
  if (!isObj(w as unknown)) return false;
  const o = w as unknown as JObj;
  const keys = Object.keys(o);
  if (keys.length !== 1) return false;
  const k = keys[0];
  const v = o[k];
  if (k === "not") return !evalWhen(v as When, env);
  if (k === "all" && Array.isArray(v)) {
    let r = true;
    for (const x of v) if (!evalWhen(x as When, env)) r = false;
    return r;
  }
  if (k === "any" && Array.isArray(v)) {
    let r = false;
    for (const x of v) if (evalWhen(x as When, env)) r = true;
    return r;
  }
  if (k === "eq" && Array.isArray(v) && v.length === 2 && isStr(v[0]) && isStr(v[1])) {
    const got = readValue(v[0], env);
    return isStr(got) && got === v[1];
  }
  if (k === "param" && Array.isArray(v) && v.length === 2 && isStr(v[0]) && isStr(v[1])) {
    return has(env.params, v[0]) && env.params[v[0]] === v[1];
  }
  return false;
}

// ---- values, params, targets --------------------------------------------------------------------------------------

/** The code points of a string (a lone surrogate counts as one, and is refused by every check below). */
export function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0) as number);
  return out;
}
const lone = (c: number) => c >= 0xd800 && c <= 0xdfff;
/** Not allowed in a token (ids, keys, references, emoji): space and every control / line separator. */
export const badToken = (c: number): boolean => c <= 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0x2028 || c === 0x2029 || lone(c);
/** Not allowed in text: controls and line separators. */
export const badText = (c: number): boolean => c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || lone(c);

/** A value of a declared value type (ACTIONS.md §5.4); `enumValues` for the type "enum". */
export function checkValue(type: string, v: Json | undefined, enumValues?: string[]): boolean {
  if (!isStr(v)) return false;
  if (type === "enum") return !!enumValues && enumValues.includes(v);
  const t = reg(TABLE.valueTypes, type);
  if (!t) return false;
  if (t.values) {
    if (t.values.includes(v)) return true;
    return t.or !== undefined ? checkValue(t.or, v) : false;
  }
  const cps = codePoints(v);
  for (const c of cps) if (t.token ? badToken(c) : badText(c)) return false;
  if (t.prefix !== undefined && !t.prefix.some((p) => v.startsWith(p))) return false;
  if (t.min !== undefined && cps.length < t.min) return false;
  if (t.max !== undefined && cps.length > t.max) return false;
  if (t.server === true) {
    // "@local:server": a ':' after a non-empty localpart, and a non-empty server after it
    const colon = cps.indexOf(0x3a, 2);
    if (colon < 0 || colon === cps.length - 1) return false;
  }
  if (t.charset !== undefined) {
    const allowed = codePoints(t.charset);
    for (const c of cps) if (!allowed.includes(c)) return false;
  }
  return true;
}

/** A param value → its normalized form, or undefined when invalid (ACTIONS.md §5.5). */
export function checkParam(spec: ParamSpec, v: Json | undefined): Json | undefined {
  switch (spec.type) {
    case "enum":
      return isStr(v) && !!spec.values && spec.values.includes(v) ? v : undefined;
    case "text": {
      if (!isStr(v)) return undefined;
      const cps = codePoints(v);
      if (cps.length < 1 || cps.length > (spec.max ?? 80)) return undefined;
      for (const c of cps) if (badText(c)) return undefined;
      return v;
    }
    case "emoji": {
      if (!isStr(v)) return undefined;
      const cps = codePoints(v);
      if (cps.length < 1 || cps.length > 16) return undefined;
      for (const c of cps) if (badToken(c)) return undefined;
      return v;
    }
    case "colour": {
      if (!isStr(v) || v.length !== 7 || v[0] !== "#") return undefined;
      let out = "#";
      for (let i = 1; i < 7; i++) {
        const c = v.charCodeAt(i);
        if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66)) out += v[i];
        else if (c >= 0x41 && c <= 0x46) out += String.fromCharCode(c + 32);
        else return undefined;
      }
      return out;
    }
    case "int": {
      if (!isInt(v)) return undefined;
      if (spec.min !== undefined && v < spec.min) return undefined;
      if (spec.max !== undefined && v > spec.max) return undefined;
      return v === 0 ? 0 : v; // -0 → 0
    }
  }
  return undefined;
}

/** A device-local id (the `local` key of a row item target): 1–12 of a–z, 0–9. */
export function isLocalId(v: Json | undefined): boolean {
  if (!isStr(v) || v.length < 1 || v.length > 12) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) return false;
  }
  return true;
}

export type TargetCheck = { ok: true; target: JObj } | { ok: false; error: string; key?: string };

/**
 * Validate a row item's `target` object for an action (ACTIONS.md §5.6). `undefined` (no target) is valid. The
 * first failure, in this order: not-object, too-many-keys, not-targetable, then each key in code-point order:
 * not-pickable / not-portable / bad-value (the subject key), bad-local (`local`), bad-value (a param), unknown-key.
 * The result holds the normalized values (colour in lower case, -0 as 0). `transient`: the target is run, never
 * stored (a palette choice) — a device-local kind's own key is then allowed (no not-portable).
 */
export function validateTarget(a: Action, t: Json | undefined, transient = false): TargetCheck {
  const out = obj();
  if (t === undefined) return { ok: true, target: out };
  if (!isObj(t)) return { ok: false, error: "not-object" };
  const keys = sortedKeys(t);
  if (keys.length > (TABLE.limits.targetKeys ?? 4)) return { ok: false, error: "too-many-keys" };
  if (keys.length === 0) return { ok: true, target: out };
  const spec = a.target;
  if (!spec) return { ok: false, error: "not-targetable" };
  const kind = reg(TABLE.targetKinds, spec.kind);
  if (!kind) return { ok: false, error: "not-targetable" };
  for (const k of keys) {
    const v = t[k];
    if (kind.stored && kind.key !== undefined && k === kind.key) {
      if (spec.pickable === false) return { ok: false, error: "not-pickable", key: k };
      if (!kind.portable && !transient) return { ok: false, error: "not-portable", key: k };
      if (!checkValue(kind.value as string, v, spec.values)) return { ok: false, error: "bad-value", key: k };
      out[k] = v;
      continue;
    }
    if (k === "local" && kind.stored && !kind.portable) {
      if (spec.pickable === false) return { ok: false, error: "not-pickable", key: k };
      if (!isLocalId(v)) return { ok: false, error: "bad-local", key: k };
      out[k] = v;
      continue;
    }
    const ps = spec.params ? reg(spec.params, k) : undefined;
    if (ps) {
      const n = checkParam(ps, v);
      if (n === undefined) return { ok: false, error: "bad-value", key: k };
      out[k] = n;
      continue;
    }
    return { ok: false, error: "unknown-key", key: k };
  }
  return { ok: true, target: out };
}

export interface Resolution {
  subj: Subjects;
  params: JObj;
  pick: boolean;
  /** the value came from the stored target (its key or a device-local id), not the absent rule or a context */
  stored: boolean;
  /** null | target-invalid | target-missing | target-unknown */
  error: string | null;
  /** the validation error code when error = target-invalid */
  invalid?: string;
  /** the label of a device-local target (its entry in snapshot.local) */
  localLabel?: string;
}

export interface EvalInput {
  app: App;
  action: string;
  snapshot: Snapshot;
  /** a row item's / menu item's target object */
  target?: Json;
  /** the target is run, never stored (a palette choice; §5.6) */
  transient?: boolean;
  /** subjects the surrounding context supplies: kind → id */
  context?: JObj;
  /** invocation params (a key binding's, a host's) — validated like the target's */
  params?: JObj;
  /** the row kind the item sits in ("header.main") */
  row?: string;
  /** the menu the item sits in, its item (label / when / forms), and the form */
  menu?: string;
  item?: JObj;
  form?: "desktop" | "phone";
}

/** Resolve an action's target and subjects (ACTIONS.md §5.7). */
export function resolveTarget(a: Action, input: EvalInput): Resolution {
  const subj: Subjects = Object.create(null);
  const params = obj();
  const r: Resolution = { subj, params, pick: false, stored: false, error: null };
  const ctx = isObj(input.context) ? input.context : undefined;
  if (ctx) for (const k of sortedKeys(ctx)) if (isStr(ctx[k])) subj[k] = ctx[k] as string;
  const spec: TargetSpec | undefined = a.target;
  // an invalid target or invocation param stops here: the action is unavailable, nothing is resolved from it
  const chk = validateTarget(a, input.target, input.transient === true);
  if (!chk.ok) {
    r.error = "target-invalid";
    r.invalid = chk.error;
    return r;
  }
  const inv = obj();
  if (isObj(input.params)) {
    for (const p of sortedKeys(input.params)) {
      const ps = spec && spec.params ? reg(spec.params, p) : undefined;
      const n = ps ? checkParam(ps, input.params[p]) : undefined;
      if (n === undefined) {
        r.error = "target-invalid";
        r.invalid = "bad-param";
        return r;
      }
      inv[p] = n;
    }
  }
  if (!spec) return r;
  const kind = reg(TABLE.targetKinds, spec.kind) as TargetKind;
  const t = chk.target;
  // params: the item's, then the invocation's (the invocation's win)
  if (spec.params) {
    for (const p of sortedKeys(spec.params as unknown as JObj)) if (has(t, p)) params[p] = t[p];
  }
  for (const p of sortedKeys(inv)) params[p] = inv[p];
  let fromItem = false;
  let value: string | undefined;
  if (kind.key !== undefined && has(t, kind.key)) {
    value = t[kind.key] as string;
    fromItem = true;
    r.stored = true;
  } else if (has(t, "local")) {
    const e = objAt(objAt(input.snapshot, "local"), t.local as string);
    const lv = e && kind.key !== undefined ? get(e, kind.key) : undefined;
    if (isStr(lv) && checkValue(kind.value as string, lv)) {
      value = lv;
      fromItem = true;
      r.stored = true;
      const lab = strAt(e, "label");
      if (lab !== undefined) r.localLabel = lab;
    } else r.pick = true;
  }
  if (value !== undefined) {
    const vt = kind.value !== undefined ? reg(TABLE.valueTypes, kind.value) : undefined;
    const listed = !!vt && !!vt.values && vt.values.includes(value);
    if (kind.subject === undefined || listed) params[kind.key as string] = value;
    else subj[kind.subject] = value;
  } else if (!r.pick) {
    const inCtx = kind.subject !== undefined && has(subj, kind.subject);
    if (!inCtx) {
      const rule = spec.absent;
      if (rule === "currentRoom" || rule === "activeSpace") {
        const id = strAt(objAt(input.snapshot, "current"), rule === "currentRoom" ? "room" : "activeSpace");
        if (id === undefined) {
          if (r.error === null) r.error = "target-missing";
        } else {
          subj[kind.subject as string] = id;
          fromItem = true; // a default subject must exist like a stored one
        }
      } else if (rule === "pick") r.pick = true;
      else if (rule === undefined) {
        if (r.error === null) r.error = "target-missing";
      }
    }
  }
  if (spec.params) {
    for (const p of sortedKeys(spec.params as unknown as JObj)) {
      const ps = reg(spec.params, p) as ParamSpec;
      if (ps.required && !has(params, p)) r.pick = true;
    }
  }
  if (fromItem && kind.subject !== undefined && r.error === null && has(subj, kind.subject)) {
    if (!subjectEntry(input.snapshot, kind.subject, subj[kind.subject])) r.error = "target-unknown";
  }
  return r;
}

// ---- presentation ------------------------------------------------------------------------------------------------

export interface ConfirmOut {
  kind: string;
  title: string;
  text: string;
  confirmLabel: string;
  askReason: boolean;
}

export interface Presentation {
  exists: boolean;
  visible: boolean;
  enabled: boolean;
  /** the first failing stage: unknown | app | context | form | target | requires | when (null = available) */
  why: string | null;
  /** the target error when why = target: target-invalid:<code> | target-missing | target-unknown */
  whyTarget: string | null;
  pick: boolean;
  active: boolean | null;
  label: string;
  shortLabel: string | null;
  icon: string | null;
  tip: string | null;
  look: string | null;
  danger: boolean;
  /** the surface's one primary call to action (the composer's Send) */
  primary: boolean;
  hold: boolean;
  subject: string | null;
  params: JObj;
  targetName: string | null;
  targetIcon: string | null;
  /** an emoji to draw as the glyph (a target value's), else null */
  emoji: string | null;
  confirm: ConfirmOut | null;
  /** the split (▴) part: the action it runs and that action's target (ACTIONS.md §3) */
  split: { a: string; target: JObj } | null;
}

/** The enumerated value faces of the target: the stored key's value, then each enum param (code-point order). */
function valueFaces(spec: TargetSpec | undefined, kind: TargetKind | undefined, r: Resolution): JObj[] {
  const out: JObj[] = [];
  if (!spec || !kind) return out;
  const face = (labels?: Record<string, string>, shorts?: Record<string, string>, icons?: Record<string, string>, v?: Json, emojis?: Record<string, string>) => {
    if (!isStr(v)) return;
    const f = obj();
    const l = labels ? reg(labels, v) : undefined;
    const s = shorts ? reg(shorts, v) : undefined;
    const i = icons ? reg(icons, v) : undefined;
    const e = emojis ? reg(emojis, v) : undefined;
    if (isStr(l)) f.label = l;
    if (isStr(s)) f.shortLabel = s;
    if (isStr(i)) f.icon = i;
    if (isStr(e)) f.emoji = e;
    if (Object.keys(f).length > 0) out.push(f);
  };
  if (kind.key !== undefined && has(r.params, kind.key)) face(spec.labels, spec.shortLabels, spec.icons, r.params[kind.key], spec.emojis);
  if (spec.params) {
    for (const p of sortedKeys(spec.params as unknown as JObj)) {
      const ps = reg(spec.params, p) as ParamSpec;
      if (ps.type === "enum" && has(r.params, p)) face(ps.labels, ps.shortLabels, ps.icons, r.params[p]);
    }
  }
  return out;
}

/** The name of the target: the subject's name, a device-local label, the kind's fallback — or the label (else the
 *  value) of a stored value that names no subject. Null when the action has no target or nothing resolved. */
function targetName(a: Action, r: Resolution, snap: Snapshot): string | null {
  const spec = a.target;
  if (!spec) return null;
  const kind = reg(TABLE.targetKinds, spec.kind) as TargetKind;
  if (kind.subject !== undefined && has(r.subj, kind.subject)) {
    const e = subjectEntry(snap, kind.subject, r.subj[kind.subject]);
    const n = e ? strAt(e, "name") : undefined;
    if (n !== undefined) return n;
    if (r.localLabel !== undefined) return r.localLabel;
    return kind.fallbackName;
  }
  const key = kind.key;
  const v = key !== undefined && has(r.params, key) ? r.params[key] : undefined;
  if (isStr(v)) {
    const l = spec.labels ? reg(spec.labels, v) : undefined;
    return isStr(l) ? l : v;
  }
  return null;
}

function targetIcon(a: Action, r: Resolution): string | null {
  const spec = a.target;
  if (!spec) return null;
  const kind = reg(TABLE.targetKinds, spec.kind) as TargetKind;
  for (const f of valueFaces(spec, kind, r)) if (isStr(get(f, "icon"))) return f.icon as string;
  return null;
}

/** Fill `{name}` (the target's name) and `{<text state>}` placeholders (a global one, or one of the subject's
 *  scope: `{room.pinnedCount}`), left to right (ACTIONS.md §7.3); an absent value fills "". */
export function fill(s: string, name: string | null, env: Env): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "{") {
      const j = s.indexOf("}", i + 1);
      const inner = j > i ? s.slice(i + 1, j) : "";
      if (j > i && isPlaceholderName(inner)) {
        if (inner === "name") {
          out += name ?? "";
          i = j + 1;
          continue;
        }
        const def = reg(TABLE.states, inner);
        if (def && def.type === "text") {
          const v = readValue(inner, env);
          out += isStr(v) ? v : "";
          i = j + 1;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** [a-zA-Z][a-zA-Z0-9.]* */
function isPlaceholderName(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alpha = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (i === 0 ? !alpha : !(alpha || (c >= 0x30 && c <= 0x39) || c === 0x2e)) return false;
  }
  return true;
}

function toggleActive(a: Action, r: Resolution, env: Env): boolean | null {
  const tg = a.toggle;
  if (!tg) return null;
  const v = readValue(tg.state, env);
  const aw = tg.activeWhen;
  let want: Json | undefined;
  if (aw === undefined) want = true;
  else if (typeof aw === "string") want = aw;
  else if (isObj(aw as unknown) && has(aw as unknown as JObj, "param")) {
    const p = (aw as { param: string }).param;
    want = has(r.params, p) ? r.params[p] : undefined;
  } else if (isObj(aw as unknown) && has(aw as unknown as JObj, "subject")) {
    const kind = a.target ? reg(TABLE.targetKinds, a.target.kind) : undefined;
    if (kind?.subject !== undefined && has(r.subj, kind.subject)) want = r.subj[kind.subject];
  }
  if (want === undefined || want === null) return false;
  if (Array.isArray(v)) return isStr(want) && v.includes(want);
  return v !== undefined && v !== null && v === want;
}

function confirmOut(c: ConfirmSpec | undefined, name: string | null, env: Env): ConfirmOut | null {
  if (!c) return null;
  if (c.onlyWhen !== undefined && !evalWhen(c.onlyWhen, env)) return null;
  let title = c.title;
  let text = c.text;
  let confirmLabel = c.confirmLabel;
  for (const v of c.variants ?? []) {
    if (evalWhen(v.when, env)) {
      if (v.title !== undefined) title = v.title;
      if (v.text !== undefined) text = v.text;
      if (v.confirmLabel !== undefined) confirmLabel = v.confirmLabel;
      break;
    }
  }
  return {
    kind: c.kind,
    title: fill(title, name, env),
    text: fill(text, name, env),
    confirmLabel: fill(confirmLabel, name, env),
    askReason: c.askReason === true,
  };
}

/** Everything a host needs to draw and run one action in one place (ACTIONS.md §7). */
export function present(input: EvalInput): Presentation {
  const a = actionById(input.action);
  if (!a) {
    return {
      exists: false, visible: false, enabled: false, why: "unknown", whyTarget: null, pick: false, active: null,
      label: input.action, shortLabel: null, icon: null, tip: null, look: null, danger: false, primary: false,
      hold: false, subject: null, params: obj(), targetName: null, targetIcon: null, emoji: null, confirm: null,
      split: null,
    };
  }
  const exists = a.apps.includes(input.app);
  // placement: a contextOnly action needs a row / menu that provides one of its contexts
  let placed = true;
  let rowWhen: When | undefined;
  let rowRequires: When | undefined;
  let override: JObj | undefined;
  if (input.row !== undefined) {
    const rk = reg(TABLE.rows, input.row);
    const provided = rk ? rk.contexts : [];
    if (a.contexts && !a.contexts.some((c) => provided.includes(c))) placed = false;
    const ov = rk && rk.overrides ? reg(rk.overrides, a.id) : undefined;
    if (ov) {
      override = ov as unknown as JObj;
      rowWhen = ov.when;
      rowRequires = ov.requires;
    }
  } else if (input.menu !== undefined) {
    const md = reg(TABLE.menus, input.menu);
    const provided = md && md.context !== undefined ? [md.context] : [];
    if (a.contexts && !a.contexts.some((c) => provided.includes(c))) placed = false;
  }
  const r = resolveTarget(a, input);
  const env: Env = { app: input.app, snap: input.snapshot, subj: r.subj, params: r.params };
  const item = isObj(input.item) ? input.item : undefined;
  let formOk = true;
  if (item && Array.isArray(get(item, "forms"))) formOk = input.form !== undefined && (item.forms as Json[]).includes(input.form);
  // the stages in order (ACTIONS.md §7.1): a bad target dims before `requires` is asked (it names no subject to ask)
  let why: string | null = null;
  let visible = true;
  let enabled = true;
  if (!exists) why = "app";
  else if (!placed) why = "context";
  else if (!formOk) why = "form";
  else if (r.error !== null) why = "target";
  else if (!evalWhen(a.requires, env) || !evalWhen(rowRequires, env)) why = "requires";
  else {
    let whenOk = evalWhen(a.when, env);
    if (!evalWhen(rowWhen, env)) whenOk = false;
    if (item && has(item, "when") && !evalWhen(item.when as unknown as When, env)) whenOk = false;
    if (!whenOk) why = "when";
  }
  if (why === "app" || why === "context" || why === "form" || why === "requires") visible = false;
  if (why !== null) enabled = false;

  const kind = a.target ? reg(TABLE.targetKinds, a.target.kind) : undefined;
  const active = toggleActive(a, r, env);
  let label = a.label;
  let shortLabel: string | null = a.shortLabel ?? null;
  let icon: string | null = a.icon;
  const byApp = a.iconByApp ? get(a.iconByApp as unknown as JObj, input.app) : undefined;
  if (isStr(byApp)) icon = byApp;
  let tip: string | null = a.tip ?? null;
  let emoji: string | null = null;
  const apply = (f: JObj | undefined) => {
    if (!f) return;
    if (isStr(get(f, "label"))) label = f.label as string;
    if (isStr(get(f, "shortLabel"))) shortLabel = f.shortLabel as string;
    if (isStr(get(f, "icon"))) icon = f.icon as string;
    if (isStr(get(f, "tip"))) tip = f.tip as string;
    if (isStr(get(f, "emoji"))) emoji = f.emoji as string;
  };
  // the face layers (ACTIONS.md §7.2): value faces → toggle → first variant → the stored target's face → row override
  // → menu item label
  for (const f of valueFaces(a.target, kind, r)) apply(f);
  if (a.toggle) apply((active ? a.toggle.on : a.toggle.off) as unknown as JObj | undefined);
  for (const v of a.variants ?? []) {
    if (evalWhen(v.when, env)) {
      apply(v as unknown as JObj);
      break;
    }
  }
  if (a.targetFace && r.stored) apply(a.targetFace as unknown as JObj);
  let look: string | null = null;
  if (override) {
    apply(override);
    if (isStr(get(override, "look"))) look = override.look as string;
  }
  if (item && isStr(get(item, "label"))) label = item.label as string;
  const tName = targetName(a, r, input.snapshot);
  const subject = kind && kind.subject !== undefined && has(r.subj, kind.subject) ? r.subj[kind.subject] : null;
  const nameForText = tName ?? (kind ? kind.fallbackName : null);
  return {
    exists,
    visible,
    enabled,
    why,
    whyTarget: why === "target" ? (r.error === "target-invalid" ? `target-invalid:${r.invalid}` : r.error) : null,
    pick: r.pick,
    active,
    label: fill(label, nameForText, env),
    shortLabel: shortLabel === null ? null : fill(shortLabel, nameForText, env),
    icon,
    tip: tip === null ? null : fill(tip, nameForText, env),
    look,
    danger: a.danger === true,
    primary: a.primary === true,
    hold: a.hold === true,
    subject,
    params: r.params,
    targetName: tName,
    targetIcon: targetIcon(a, r),
    emoji,
    confirm: confirmOut(a.confirm, nameForText, env),
    split: splitOut(a),
  };
}

function splitOut(a: Action): { a: string; target: JObj } | null {
  if (!a.split) return null;
  const t = obj();
  const st = a.split.target;
  if (isObj(st as Json | undefined)) for (const k of sortedKeys(st as JObj)) t[k] = (st as JObj)[k];
  return { a: a.split.a, target: t };
}

// ---- rows and menus ------------------------------------------------------------------------------------------------

/** One button of a row (or item of a menu) as the host draws it (ACTIONS.md §9.4). */
export interface ItemOut {
  /** the stored action id ("" when the item has none) */
  a: string;
  /** the id is in this version's table (false → the "needs a newer Tin Hat" placeholder, §9.5) */
  known: boolean;
  state: "shown" | "dimmed" | "hidden";
  /** the first failing stage: bad | unknown | app | context | form | target | requires | when (null = available) */
  why: string | null;
  label: string;
  shortLabel: string | null;
  icon: string | null;
  tip: string | null;
  /** how this button draws: the row's look, or the row kind's override for this action */
  look: Look;
  active: boolean | null;
  danger: boolean;
  primary: boolean;
  /** running it opens its target picker (no stored target, absent = pick) */
  pick: boolean;
  hold: boolean;
  /** the resolved subject (a room, person, sound … id) and its kind — hosts draw avatars / emoji from it */
  subject: string | null;
  subjectKind: string | null;
  targetName: string | null;
  targetIcon: string | null;
  /** an emoji to draw as the glyph (hosts prefer it to the icon) */
  emoji: string | null;
  /** the item's target, normalized (null: none, or invalid) */
  target: JObj | null;
  split: { a: string; target: JObj } | null;
  sepBefore: boolean;
  hideWhenOff: boolean;
}

/** The layout's item id syntax (LAYOUT.md §3.9: [a-z][a-zA-Z0-9.]{0,63}); anything else cannot be stored. */
export function isItemId(s: string): boolean {
  if (s.length < 1 || s.length > 64) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const lower = c >= 0x61 && c <= 0x7a;
    if (i === 0 ? !lower : !(lower || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2e)) return false;
  }
  return true;
}

function placeholderItem(a: string, why: "bad" | "unknown", look: Look, hideOff: boolean, sep: boolean): ItemOut {
  const ph = TABLE.placeholder;
  const bad = why === "bad";
  return {
    a, known: false, state: bad || hideOff ? "hidden" : "dimmed", why,
    label: bad ? "" : ph.label, shortLabel: null, icon: bad ? null : ph.icon, tip: bad ? null : ph.tip, look,
    active: null, danger: false, primary: false, pick: false, hold: false, subject: null, subjectKind: null, targetName: null,
    targetIcon: null, emoji: null, target: null, split: null, sepBefore: sep, hideWhenOff: hideOff,
  };
}

/** One row / menu item's state (ACTIONS.md §9.4): not visible → hidden; unavailable → dimmed, or hidden with
 *  hideWhenOff; else shown. An item that is not an object with an `a` of the item id syntax is hidden (why bad); an
 *  id this version does not know is the placeholder (dimmed, or hidden with hideWhenOff). `item` is the layout row item
 *  {a, target?, hideWhenOff?, sepBefore?}; `look` the row's. */
export function evalItem(
  app: App,
  snap: Snapshot,
  item: Json,
  where: { row?: string; menu?: string; form?: "desktop" | "phone"; context?: JObj; look?: Look },
): ItemOut {
  const look: Look = where.look ?? "icon";
  const io = isObj(item) ? item : undefined;
  const hideOff = io !== undefined && get(io, "hideWhenOff") === true;
  const sep = io !== undefined && get(io, "sepBefore") === true;
  if (!io || !isStr(get(io, "a")) || !isItemId(io.a as string)) {
    return placeholderItem(io && isStr(get(io, "a")) ? (io.a as string) : "", "bad", look, hideOff, sep);
  }
  const id = io.a as string;
  const a = actionById(id);
  if (!a) return placeholderItem(id, "unknown", look, hideOff, sep);
  const p = present({
    app,
    action: id,
    snapshot: snap,
    target: get(io, "target"),
    context: where.context,
    row: where.row,
    menu: where.menu,
    item: where.menu !== undefined ? io : undefined,
    form: where.form,
  });
  const state = !p.visible ? "hidden" : !p.enabled ? (hideOff ? "hidden" : "dimmed") : "shown";
  const chk = validateTarget(a, get(io, "target"));
  const kind = a.target ? reg(TABLE.targetKinds, a.target.kind) : undefined;
  return {
    a: id, known: true, state, why: p.why, label: p.label, shortLabel: p.shortLabel, icon: p.icon, tip: p.tip,
    look: (p.look as Look | null) ?? look, active: p.active, danger: p.danger, primary: p.primary, pick: p.pick,
    hold: p.hold,
    subject: p.subject, subjectKind: p.subject !== null && kind && kind.subject !== undefined ? kind.subject : null,
    targetName: p.targetName, targetIcon: p.targetIcon, emoji: p.emoji,
    target: chk.ok && has(io, "target") ? chk.target : null,
    split: p.split, sepBefore: sep, hideWhenOff: hideOff,
  };
}

export interface RowOut {
  row: string;
  look: Look;
  scale: Scale;
  style: string;
  editable: boolean;
  items: ItemOut[];
}

/**
 * A layout row value (the layout's opts.<island>.rows.<row>, LAYOUT.md §3.9) resolved for drawing (ACTIONS.md §9.4):
 * `look` / `scale` as stored when valid, else the row kind's defaults; the first `limits.rowItems` items, each
 * through evalItem. Any value is accepted (not an object → no items, the defaults). The row kind must exist.
 */
export function evalRow(app: App, snap: Snapshot, rowKind: string, row: Json, context?: JObj): RowOut {
  const rk = reg(TABLE.rows, rowKind) as RowKind;
  const ro = isObj(row) ? row : undefined;
  const sl = ro ? get(ro, "look") : undefined;
  const ss = ro ? get(ro, "scale") : undefined;
  const look: Look = isStr(sl) && (LOOKS as readonly string[]).includes(sl) ? (sl as Look) : rk.look;
  const scale: Scale = isStr(ss) && (SCALES as readonly string[]).includes(ss) ? (ss as Scale) : rk.scale;
  const raw = ro && isArr(get(ro, "items")) ? (ro.items as Json[]) : [];
  const items = raw.slice(0, TABLE.limits.rowItems ?? 24).map((it) => evalItem(app, snap, it, { row: rowKind, context, look }));
  return { row: rowKind, look, scale, style: rk.style, editable: rk.editable, items };
}

/** The default keys of an action in an app (the table's shortcut specs; the app's own list wins), in table order. */
export function defaultKeys(a: Action, app: App): string[] {
  const out: string[] = [];
  for (const s of a.shortcut ?? []) {
    const own = app === "web" ? s.web : s.desktop;
    for (const k of own ?? s.keys) if (!out.includes(k)) out.push(k);
  }
  return out;
}

export interface DrawerItem {
  a: string;
  label: string;
  icon: string | null;
  pick: boolean;
}
export interface DrawerGroup {
  group: string;
  label: string;
  items: DrawerItem[];
}

/**
 * The edit-mode drawer for a row kind (ACTIONS.md §9.6): every action of the app that may go into the row — its
 * contexts provided by the row (or none), not hidden by `requires` in this snapshot — per group in
 * the table's group order, each group by folded label (code-point order), then id. Empty groups are left out.
 */
export function drawer(app: App, snap: Snapshot, rowKind: string, fold: (s: string) => string): DrawerGroup[] {
  const rk = reg(TABLE.rows, rowKind) as RowKind;
  const out: DrawerGroup[] = [];
  for (const g of TABLE.groups) {
    const items: { k: string; it: DrawerItem }[] = [];
    for (const a of TABLE.actions) {
      if (a.group !== g.id || !a.apps.includes(app)) continue;
      if (a.contexts && !a.contexts.some((c) => rk.contexts.includes(c))) continue;
      const p = present({ app, action: a.id, snapshot: snap, row: rowKind });
      if (!p.visible) continue;
      items.push({ k: fold(a.label), it: { a: a.id, label: a.label, icon: a.icon, pick: p.pick } });
    }
    items.sort((x, y) => cmpCodePoint(x.k, y.k) || cmpCodePoint(x.it.a, y.it.a));
    if (items.length > 0) out.push({ group: g.id, label: g.label, items: items.map((x) => x.it) });
  }
  return out;
}

export interface SubmenuOut {
  menu: string;
  state: "shown" | "hidden";
  label: string;
  items: (ItemOut | SubmenuOut)[];
}
export interface MenuOut {
  menu: string;
  items: (ItemOut | SubmenuOut)[];
}

/** A menu from the table (ACTIONS.md §9.7); a submenu is shown when any of its items is. */
export function evalMenu(app: App, snap: Snapshot, menuId: string, form: "desktop" | "phone", context?: JObj, depth = 0): MenuOut {
  const md = reg(TABLE.menus, menuId);
  const out: MenuOut = { menu: menuId, items: [] };
  if (!md || depth > 4) return out;
  for (const it of md.items) {
    if (it.menu !== undefined) {
      const sub = evalMenu(app, snap, it.menu, form, context, depth + 1);
      const sd = reg(TABLE.menus, it.menu);
      const shown = sub.items.some((x) => x.state === "shown" || x.state === "dimmed");
      out.items.push({ menu: it.menu, state: shown ? "shown" : "hidden", label: sd?.label ?? it.menu, items: sub.items });
      continue;
    }
    out.items.push(evalItem(app, snap, it as unknown as Json, { menu: menuId, form, context }));
  }
  return out;
}
