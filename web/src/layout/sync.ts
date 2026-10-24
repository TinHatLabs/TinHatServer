// sync.ts — LAYOUT.md §9 (v1.1): the account-data document dev.tinhat.layouts — entry order, version vectors, the
// per-layout reduction (the winner + the concurrent losers, "conflicts"), save() (a new entry that always wins its own
// merge), merge() (a join over the entries; the size rule only drops `previous` snapshots), and the device protocol
// (incoming documents, lost-race detection, re-assert, the newer-format latch) as a deterministic state machine.
import type { JObj, Json } from "./json";
import { canon, canonBytes, clone, cmpCp, get, has, isArr, isInt, isJsonValue, isObj, isStr, obj, sortedKeys } from "./json";
import { LIM, classicDesktop, classicPhone, isIdSyntax } from "./schema";
import { repairDesktop, repairPhone } from "./repair";

export const MAX_REV = 2147483647;
export const MAX_SAVED_AT = 9007199254740991;
export const ENTRY_KEYS = ["id", "name", "rev", "savedAt", "by", "vv", "deleted", "desktop", "phone", "previous", "quarantine"];
const DOC_KEYS = ["format", "v", "layouts", "conflicts"];
/** §9.2 input budget: a document over 1 MiB canonical or with more than 1024 entries is not read (ignored). */
export const DOC_BUDGET_BYTES = 1048576;
export const DOC_BUDGET_ENTRIES = 1024;

const cpLen = (s: string) => Array.from(s).length;
const nameOk = (n: Json | undefined): n is string => isStr(n) && cpLen(n) >= 1 && cpLen(n) <= 40;
/** An entry's `by` as read: at most 64 code points, no "#" ("" = unknown device, the default of an older draft). */
const byOk = (s: Json | undefined): s is string => isStr(s) && cpLen(s) <= 64 && !s.includes("#");
/** A device id (a saver): 1..64 code points, no "#" (the separator of chain keys). */
const deviceOk = (s: Json | undefined): s is string => byOk(s) && s.length >= 1;
/** The device part of a version-vector key: `<device>` or `<device>#<n>` (a later chain of that device, §9.6). */
const keyBase = (k: string): string => {
  const i = k.indexOf("#");
  return i < 0 ? k : k.slice(0, i);
};
/** A version-vector key: a device id, optionally followed by "#" and a canonical integer of 1..10 digits. */
export const vvKeyOk = (k: string): boolean => {
  const i = k.indexOf("#");
  return i < 0 ? deviceOk(k) : deviceOk(k.slice(0, i)) && /^[1-9][0-9]{0,9}$/.test(k.slice(i + 1));
};

// ---- entries -----------------------------------------------------------------------------------------------------
/** An entry's layout id (a valid id string), else null (such an entry cannot be merged). */
export function entryId(e: Json | undefined): string | null {
  if (!isObj(e)) return null;
  const id = get(e, "id");
  return isIdSyntax(id) ? id : null;
}
/** (rev, savedAt, by) with the defaults of an older draft: an invalid field reads as 0 / 0 / "". */
export function tupleOf(e: JObj): [number, number, string] {
  const rev = get(e, "rev");
  const at = get(e, "savedAt");
  const by = get(e, "by");
  return [
    isInt(rev) && rev >= 0 && rev <= MAX_REV ? rev : 0,
    isInt(at) && at >= 0 && at <= MAX_SAVED_AT ? at : 0,
    byOk(by) ? by : "",
  ];
}
export function cmpTuple(a: JObj, b: JObj): number {
  const x = tupleOf(a);
  const y = tupleOf(b);
  return x[0] - y[0] || x[1] - y[1] || cmpCp(x[2], y[2]);
}
/** The merge order: the tuple, then the canonical text (code-point order). A total order on entries. */
export function cmpEntry(a: JObj, b: JObj): number {
  return cmpTuple(a, b) || cmpCp(canon(a), canon(b));
}
export function higher(a: JObj | null | undefined, b: JObj | null | undefined): JObj | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return cmpEntry(a, b) >= 0 ? a : b;
}
export const isLive = (e: JObj): boolean => get(e, "deleted") !== true;
/** The entry's version vector: chain key → counter (valid keys, integers 1..2^31−1; anything else is absent). */
export function vvOf(e: JObj | null | undefined): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  const v = e ? get(e, "vv") : undefined;
  if (!isObj(v)) return out;
  for (const k of Object.keys(v)) {
    const n = v[k];
    if (vvKeyOk(k) && isInt(n) && n >= 1 && n <= MAX_REV) out[k] = n;
  }
  return out;
}
/**
 * The entry's own chain key (its save's "dot", §9.1): among the keys of its vv whose device part is its `by`, the one
 * with the largest counter (ties: the smaller key); null when there is none (an entry of an older draft).
 */
export function ownKey(e: JObj | null | undefined): string | null {
  if (!e) return null;
  const by = tupleOf(e)[2];
  if (by === "") return null;
  const v = vvOf(e);
  let best: string | null = null;
  for (const k of Object.keys(v).sort(cmpCp)) if (keyBase(k) === by && (best === null || v[k] > v[best])) best = k;
  return best;
}
/**
 * B includes A (A's save is in B's history): B.vv[own(A)] ≥ A.vv[own(A)]; for an entry without an own key, B.vv[k] ≥
 * A.vv[k] for every k of A.vv (so an entry without counters is included by every entry).
 */
export function includes(b: JObj, a: JObj): boolean {
  const vb = vvOf(b);
  const va = vvOf(a);
  const own = ownKey(a);
  if (own !== null) return (vb[own] ?? 0) >= va[own];
  for (const k of Object.keys(va)) if ((vb[k] ?? 0) < va[k]) return false;
  return true;
}
/** B strictly includes A: B includes A and A does not include B. */
const strictlyIncludes = (b: JObj, a: JObj): boolean => includes(b, a) && !includes(a, b);
/** The same entry (its save), ignoring a `previous` the size rule may have dropped from one copy. */
export const sameEntry = (a: JObj, b: JObj): boolean => canon(stripPrevious(a)) === canon(stripPrevious(b));
/** a and b claim the same save (the same own key and counter) — two different entries can only do so when a
 *  nonconforming writer reused a dot (a copied device id, a reset counter). */
const sameDot = (a: JObj, b: JObj): boolean => {
  const k = ownKey(a);
  return k !== null && k === ownKey(b) && vvOf(a)[k] === vvOf(b)[k];
};
/** §9.7: w carries m's save — w is m, or a different save whose history includes m (the complete merge order: an
 *  equal tuple or a reused dot never passes for m). */
export const carries = (w: JObj, m: JObj): boolean => sameEntry(w, m) || (includes(w, m) && !sameDot(w, m));
/** §9.2 the input budget: more than 1024 entries in layouts + conflicts, or over 1 MiB canonical. */
export function overBudget(doc: JObj): boolean {
  const n = (isArr(get(doc, "layouts")) ? (get(doc, "layouts") as Json[]).length : 0) + (isArr(get(doc, "conflicts")) ? (get(doc, "conflicts") as Json[]).length : 0);
  return n > DOC_BUDGET_ENTRIES || canonBytes(doc) > DOC_BUDGET_BYTES;
}
const vvKey = (e: JObj): string => {
  const v = vvOf(e);
  const o = obj();
  for (const k of sortedKeys(v as unknown as JObj)) o[k] = v[k];
  return canon(o);
};
/**
 * At most 16 counters, keys sorted (§9.1): first the keys of `first` in that order (a save: its own chain key, then
 * the own keys of the entries it incorporates; a read: the entry's own key), then the others, the larger counter
 * first (ties: the smaller key). A dropped counter only ever makes an entry claim less history (an older version can
 * resurface as a conflict, never disappear), and an entry's own key is never dropped.
 */
function capVv(vv: Record<string, number>, first: (string | null)[]): JObj {
  const keys = Object.keys(vv);
  let kept = keys;
  if (keys.length > LIM.vv) {
    const head: string[] = [];
    for (const k of first) if (k !== null && vv[k] !== undefined && !head.includes(k)) head.push(k);
    const rest = keys.filter((k) => !head.includes(k)).sort((a, b) => vv[b] - vv[a] || cmpCp(a, b));
    kept = head.concat(rest).slice(0, LIM.vv);
  }
  const o = obj();
  for (const k of kept.sort(cmpCp)) o[k] = vv[k];
  return o;
}

// ---- documents ---------------------------------------------------------------------------------------------------
export type DocRead = { kind: "ignore" } | { kind: "newer"; doc: JObj } | { kind: "ok"; doc: JObj };
/**
 * §9.2 read: not JSON data, not an object, not format tinhat-layouts, or over the input budget (1 MiB canonical, 1024
 * entries in `layouts` + `conflicts`) → ignore; v a number > 1 → newer (read-only, latched); v = 1 → ok.
 */
export function readDoc(v: Json | undefined): DocRead {
  if (!isObj(v) || !isJsonValue(v) || get(v, "format") !== "tinhat-layouts") return { kind: "ignore" };
  const ver = get(v, "v");
  if (typeof ver !== "number") return { kind: "ignore" };
  if (overBudget(v)) return { kind: "ignore" };
  if (ver > 1) return { kind: "newer", doc: v };
  if (ver !== 1) return { kind: "ignore" };
  return { kind: "ok", doc: v };
}

/**
 * §9.1 defaults-filled (a copy): rev / savedAt / by = their tuple values; vv = its valid counters, capped at 16 (the
 * entry's `by` kept first, then the largest), keys sorted; a tombstone keeps only id, rev, savedAt, by, vv, deleted and
 * its unknown keys (no forms, no previous, no quarantine); a live entry loses a `deleted` that is not `true`, gets its
 * id as name when it has no valid one, the built-in Classic for a form that is not an object, loses a `previous` that
 * is not an object with desktop and phone objects (a snapshot's own `previous` and `quarantine` are dropped) and a
 * `quarantine` that is not an object. Unknown keys stay.
 */
export function fillDefaults(e: JObj): JObj {
  const o = clone(e);
  const [rev, at, by] = tupleOf(o);
  o["rev"] = rev;
  o["savedAt"] = at;
  o["by"] = by;
  o["vv"] = capVv(vvOf(o), [ownKey(o)]);
  if (!isLive(o)) {
    o["deleted"] = true;
    for (const k of ["name", "desktop", "phone", "previous", "quarantine"]) delete o[k];
    return o;
  }
  if (has(o, "deleted")) delete o["deleted"];
  if (!nameOk(get(o, "name"))) o["name"] = get(o, "id") as string;
  if (!isObj(get(o, "desktop"))) o["desktop"] = classicDesktop();
  if (!isObj(get(o, "phone"))) o["phone"] = classicPhone();
  if (has(o, "previous")) {
    const p = get(o, "previous");
    if (!isObj(p) || !isObj(get(p, "desktop")) || !isObj(get(p, "phone"))) delete o["previous"];
    else {
      delete p["previous"];
      delete p["quarantine"];
    }
  }
  if (has(o, "quarantine") && !isObj(get(o, "quarantine"))) delete o["quarantine"];
  return o;
}

/**
 * §9.3 the per-layout reduction of a set of entries of one id (defaults-filled): identical entries once; per version
 * vector the highest in merge order; w = the highest of all; the conflicts = every other remaining entry that no other
 * remaining entry strictly includes and that w does not include, without `previous`. Returns [w, …conflicts] (conflicts
 * in merge order, highest first). A join: reduce(reduce(A) ∪ B) = reduce(A ∪ B).
 */
export function reduce(entries: JObj[]): JObj[] {
  if (entries.length === 0) return [];
  const byText = new Map<string, JObj>();
  for (const e of entries) byText.set(canon(e), e);
  const byVv = new Map<string, JObj>();
  for (const e of byText.values()) {
    const k = vvKey(e);
    byVv.set(k, higher(byVv.get(k), e) as JObj);
  }
  const rest = [...byVv.values()];
  let w = rest[0];
  for (const e of rest) if (cmpEntry(e, w) > 0) w = e;
  const conflicts = rest.filter((e) => e !== w && !includes(w, e) && !rest.some((d) => d !== e && strictlyIncludes(d, e)));
  conflicts.sort((a, b) => -cmpEntry(a, b));
  return [w, ...conflicts.map(stripPrevious)];
}
function stripPrevious(e: JObj): JObj {
  if (!has(e, "previous")) return e;
  const c = clone(e);
  delete c["previous"];
  return c;
}

export type Known = Record<string, JObj[]>;
/** The document's entries per id (`layouts` ∪ `conflicts`, valid ids, defaults-filled), reduced. */
export function entriesOf(doc: JObj | null | undefined): Map<string, JObj[]> {
  const acc = new Map<string, JObj[]>();
  if (!doc) return acc;
  for (const key of ["layouts", "conflicts"]) {
    const ls = get(doc, key);
    if (!isArr(ls)) continue;
    for (const e of ls) {
      const id = entryId(e);
      if (id === null) continue;
      if (!acc.has(id)) acc.set(id, []);
      (acc.get(id) as JObj[]).push(fillDefaults(e as JObj));
    }
  }
  const out = new Map<string, JObj[]>();
  for (const id of [...acc.keys()].sort(cmpCp)) out.set(id, reduce(acc.get(id) as JObj[]));
  return out;
}
/** The current entry (the winner) of an id in a document, or null. */
export const rawEntry = (doc: JObj | null | undefined, id: string): JObj | null => entriesOf(doc).get(id)?.[0] ?? null;

/** `known[k]` as a list of defaults-filled entries whose own id is valid (keyed by that id). */
function knownEntries(known: Known): Map<string, JObj[]> {
  const out = new Map<string, JObj[]>();
  if (!isObj(known)) return out;
  for (const k of sortedKeys(known as unknown as JObj)) {
    const v = (known as unknown as JObj)[k];
    const list = isArr(v) ? v : isObj(v) ? [v] : [];
    for (const e of list) {
      const id = entryId(e);
      if (id === null || !isJsonValue(e)) continue; // §1.4: a value outside the input domain is not an entry
      if (!out.has(id)) out.set(id, []);
      (out.get(id) as JObj[]).push(fillDefaults(e as JObj));
    }
  }
  return out;
}

/**
 * merge(raw, known, justSaved?) — per id reduce(raw's entries ∪ known's); `layouts` = the winners sorted by id,
 * `conflicts` (only when not empty) = the other entries sorted by id, then merge order (highest first); raw's unknown
 * top-level keys kept; `format`, `v: 1`. The size rule: while the canonical size exceeds 65,536 bytes, drop `previous`
 * from the live winner with the oldest savedAt (ties: the smaller id) other than `justSaved`, then from `justSaved`;
 * `tooLarge` when even that is not enough (a save is refused; a re-assert puts the document anyway). Nothing else is
 * ever dropped: no entry, no tombstone, no conflict, no quarantine.
 */
export function merge(raw0: JObj | null | undefined, known: Known, justSaved: string | null = null): { doc: JObj; tooLarge: boolean } {
  const raw = isObj(raw0) && isJsonValue(raw0) ? raw0 : null; // §1.4: anything else reads as no document
  const acc = new Map<string, JObj[]>();
  const add = (id: string, list: JObj[]) => {
    if (!acc.has(id)) acc.set(id, []);
    (acc.get(id) as JObj[]).push(...list);
  };
  for (const [id, list] of entriesOf(isObj(raw) ? raw : null)) add(id, list);
  for (const [id, list] of knownEntries(known)) add(id, list);
  const layouts: JObj[] = [];
  const conflicts: JObj[] = [];
  for (const id of [...acc.keys()].sort(cmpCp)) {
    const r = reduce(acc.get(id) as JObj[]);
    layouts.push(clone(r[0]));
    for (const c of r.slice(1)) conflicts.push(clone(c));
  }
  const doc = obj();
  if (isObj(raw)) for (const k of Object.keys(raw)) if (!DOC_KEYS.includes(k)) doc[k] = clone(raw[k]);
  doc["format"] = "tinhat-layouts";
  doc["v"] = 1;
  doc["layouts"] = layouts;
  if (conflicts.length) doc["conflicts"] = conflicts;
  while (canonBytes(doc) > LIM.docBytes) {
    const cands = layouts.filter((e) => isLive(e) && has(e, "previous") && get(e, "id") !== justSaved);
    cands.sort((a, b) => tupleOf(a)[1] - tupleOf(b)[1] || cmpCp(get(a, "id") as string, get(b, "id") as string));
    let victim: JObj | undefined = cands[0];
    if (!victim) victim = layouts.find((e) => get(e, "id") === justSaved && isLive(e) && has(e, "previous"));
    if (!victim) return { doc, tooLarge: true };
    delete victim["previous"];
  }
  return { doc, tooLarge: false };
}

// ---- the projection (§9.4) ---------------------------------------------------------------------------------------
export interface Projection {
  read: "ok" | "newer" | "ignore";
  /** the live layout ids, in id order */
  layouts: string[];
  /** the layout this device renders: the asked id if live, else main, else the first live one, else built-in Classic */
  active: string;
  name: string;
  desktop: JObj;
  phone: JObj;
  notes: { desktop: string[]; phone: string[] };
  /** the active layout's concurrent losers (merge order, highest first): who, when, whether a delete */
  conflicts: { rev: number; savedAt: number; by: string; deleted: boolean }[];
  /** the active layout carries a quarantined original (a form this version had to replace) */
  quarantine: boolean;
}
/** project(doc, activeId) — what a device renders from an account-data value. Never throws. */
export function project(v: Json | undefined, activeId: string | null): Projection {
  const r = readDoc(v);
  const E = r.kind === "ignore" ? new Map<string, JObj[]>() : entriesOf(r.doc);
  const live = [...E.keys()].filter((id) => isLive((E.get(id) as JObj[])[0])).sort(cmpCp);
  let active = activeId !== null && live.includes(activeId) ? activeId : live.includes("main") ? "main" : live.length ? live[0] : null;
  const list = active !== null ? (E.get(active) as JObj[]) : null;
  const e = list ? list[0] : null;
  const d = repairDesktop(e ? (get(e, "desktop") ?? null) : null);
  const p = repairPhone(e ? (get(e, "phone") ?? null) : null);
  const nm = e ? get(e, "name") : undefined;
  if (active === null) active = "main";
  return {
    read: r.kind,
    layouts: live,
    active,
    name: e && nameOk(nm) ? nm : active === "main" && !e ? "Main" : active,
    desktop: e ? d.form : classicDesktop(),
    phone: e ? p.form : classicPhone(),
    notes: { desktop: e ? d.notes : [], phone: e ? p.notes : [] },
    conflicts: (list ?? []).slice(1).map((c) => {
      const [rev, savedAt, by] = tupleOf(c);
      return { rev, savedAt, by, deleted: !isLive(c) };
    }),
    quarantine: !!e && isObj(get(e, "quarantine")),
  };
}

// ---- save --------------------------------------------------------------------------------------------------------
export interface SaveReq {
  id: string;
  /** {name?, desktop, phone, discardQuarantine?} (a live layout) or {deleted: true} */
  edit: JObj;
  /** the entry the edit session started from (null for a new layout) */
  start: JObj | null;
  /** Restore / Dismiss: the concurrent loser whose version vector this save incorporates */
  also?: JObj | null;
  now: number;
  by: string;
  /** this device's save counter after this save (every successful save increments it) */
  seq: number;
  /** the version-vector key this save counts under (default `by`): `by`, or `by#<n>` for a later chain (§9.6) */
  key?: string;
}
export type SaveResult = { ok: true; entry: JObj; doc: JObj } | { ok: true; noop: true } | { ok: false; error: string };

const replaced = (notes: string[]) => notes.length > 0 && notes[0].startsWith("replaced-by-classic");

/** save(raw, known, req) → a NEW entry for req.id that wins its own merge + the document to put. */
export function save(raw: JObj | null, known: Known, req: SaveReq): SaveResult {
  const rd = raw ? readDoc(raw) : null;
  if (rd && rd.kind === "newer") return { ok: false, error: "bad-save: newer format" };
  const rawDoc = rd && rd.kind === "ok" ? rd.doc : null;
  if (!isObj(req)) return { ok: false, error: "bad-op: bad request" };
  const { id, edit, now, by, seq } = req;
  const start = req.start ?? null;
  const also = req.also ?? null;
  const vkey = req.key === undefined ? by : req.key;
  // §1.4 / §9.5: the request's shape (start and also are entries: JSON objects when given)
  const entryOk = (e: unknown) => e === null || (isObj(e) && isJsonValue(e));
  if (!isIdSyntax(id) || !isObj(edit) || !isJsonValue(edit) || !entryOk(start) || !entryOk(also) || !isInt(now) || now < 0 || now > MAX_SAVED_AT || !deviceOk(by) || !isInt(seq) || seq < 1)
    return { ok: false, error: "bad-op: bad request" };
  if (!isStr(vkey) || !vvKeyOk(vkey) || keyBase(vkey) !== by || (vkey !== by && Number(vkey.slice(by.length + 1)) > MAX_REV))
    return { ok: false, error: "bad-op: bad request" };
  if (seq > MAX_REV) return { ok: false, error: "bad-save: exhausted" };
  const del = get(edit, "deleted") === true;
  if (!del && (!isObj(get(edit, "desktop")) || !isObj(get(edit, "phone")))) return { ok: false, error: "bad-op: bad request" };
  const state = reduceWith(rawDoc, known, id, []);
  const base = state[0] ?? null;
  if (base && tupleOf(base)[0] >= MAX_REV) return { ok: false, error: "bad-save: exhausted" };
  const discard = get(edit, "discardQuarantine") === true;
  let name: string = id;
  if (del) {
    if ((!base || !isLive(base)) && !also) return { ok: true, noop: true };
  } else {
    name = nameOk(get(edit, "name")) ? (get(edit, "name") as string) : base && isLive(base) && nameOk(get(base, "name")) ? (get(base, "name") as string) : id;
    if (!also && !discard && start && isLive(start) && canon(get(start, "desktop")) === canon(get(edit, "desktop")) && canon(get(start, "phone")) === canon(get(edit, "phone")) && get(start, "name") === name)
      return { ok: true, noop: true };
    if (!base || !isLive(base)) {
      const m = merge(rawDoc, known).doc;
      const liveCount = (get(m, "layouts") as JObj[]).filter((e) => isLive(e) && get(e, "id") !== id).length;
      if (liveCount >= LIM.layouts) return { ok: false, error: "bad-save: too many layouts" };
    }
  }
  // version vector: the component-wise max of the incorporated entries, own counter = seq, at most 16 devices
  const vv: Record<string, number> = Object.create(null);
  for (const src of [start, also]) {
    const v = vvOf(src);
    for (const k of Object.keys(v)) vv[k] = Math.max(vv[k] ?? 0, v[k]);
  }
  vv[vkey] = seq;
  const e = obj();
  if (!del && base) for (const k of Object.keys(base)) if (!ENTRY_KEYS.includes(k)) e[k] = clone(base[k]);
  e["id"] = id;
  e["rev"] = base ? tupleOf(base)[0] + 1 : 1;
  e["savedAt"] = now;
  e["by"] = by;
  e["vv"] = capVv(vv, [vkey, ownKey(also), ownKey(start)]);
  if (del) e["deleted"] = true;
  else {
    e["name"] = name;
    e["desktop"] = clone(get(edit, "desktop") as JObj);
    e["phone"] = clone(get(edit, "phone") as JObj);
    if (base && isLive(base)) {
      const differ = canon(get(base, "desktop")) !== canon(get(e, "desktop")) || canon(get(base, "phone")) !== canon(get(e, "phone"));
      if (differ) {
        const p = clone(base);
        delete p["previous"];
        delete p["quarantine"];
        e["previous"] = p;
      } else if (isObj(get(base, "previous"))) e["previous"] = clone(get(base, "previous") as JObj);
      // quarantine: the originals this version could not read, kept until explicitly discarded (§9.5)
      if (!discard) {
        const q = isObj(get(base, "quarantine")) ? clone(get(base, "quarantine") as JObj) : obj();
        if (!has(q, "desktop") && replaced(repairDesktop(get(base, "desktop") ?? null).notes)) q["desktop"] = clone(get(base, "desktop") ?? null);
        if (!has(q, "phone") && replaced(repairPhone(get(base, "phone") ?? null).notes)) q["phone"] = clone(get(base, "phone") ?? null);
        if (Object.keys(q).length) e["quarantine"] = q;
      }
    }
  }
  const k2: Known = Object.assign(Object.create(null), known) as Known;
  k2[id] = reduce([...state, e]);
  const m = merge(rawDoc, k2, id);
  if (m.tooLarge) return { ok: false, error: "bad-layout: too large" };
  return { ok: true, entry: e, doc: m.doc };
}
/** reduce(raw's entries of id ∪ known[id] ∪ extra). */
function reduceWith(raw: JObj | null, known: Known, id: string, extra: JObj[]): JObj[] {
  const list: JObj[] = [...(entriesOf(raw).get(id) ?? []), ...(knownEntries(known).get(id) ?? []), ...extra];
  return reduce(list);
}

// ---- the device protocol (§9.6) ---------------------------------------------------------------------------------
export class Device {
  name: string;
  counter = 0;
  known: Known = Object.create(null);
  own: Record<string, JObj> = Object.create(null);
  lost: Record<string, JObj> = Object.create(null);
  raw: JObj | null = null;
  /** the newer-format latch: the highest `v` ever seen; > 1 = read-only for good (never cleared by a v1 event) */
  maxV = 1;
  sessions = new Map<string, JObj | null>();
  wantPut = false;
  lastSaved: string | null = null;
  /** per layout: the chain key this device's saves count under and the counter of its last save there (§9.6) */
  chains: Record<string, { key: string; last: number }> = Object.create(null);
  constructor(name: string) {
    this.name = name;
  }
  /**
   * The vv key of save `seq` of `id` (§9.6): the chain's key while the save builds on this device's last save of the
   * layout (start or also carries its counter), else a new chain `<name>#<seq>` — a save never claims an earlier own
   * save it does not incorporate, so a lost save stays a conflict until it is resolved.
   */
  private keyFor(id: string, start: JObj | null, also: JObj | null, seq: number): string {
    const c = this.chains[id];
    if (!c) return this.name;
    const inc = Math.max(vvOf(start)[c.key] ?? 0, vvOf(also)[c.key] ?? 0);
    return inc >= c.last ? c.key : `${this.name}#${seq}`;
  }
  get readOnly(): boolean {
    return this.maxV > 1;
  }
  state(id: string): JObj[] {
    return reduceWith(this.raw && this.maxV === 1 ? this.raw : null, this.known, id, []);
  }
  best(id: string): JObj | null {
    return this.state(id)[0] ?? null;
  }
  begin(id: string): string {
    if (this.sessions.has(id)) return "open";
    this.sessions.set(id, this.best(id));
    return "begun";
  }
  private commit(id: string, r: SaveResult, seq: number, key: string): string {
    if (!r.ok) return r.error;
    if ("noop" in r) return "noop";
    this.counter = seq;
    this.chains[id] = { key, last: seq };
    this.known[id] = reduce([...this.state(id), r.entry]);
    this.own[id] = r.entry;
    this.wantPut = true;
    this.lastSaved = id;
    return "saved";
  }
  private rawForSave(): JObj | null {
    return this.maxV === 1 ? this.raw : null;
  }
  save(id: string, edit: JObj, now: number): string {
    if (this.readOnly) return "read-only";
    const start = this.sessions.has(id) ? (this.sessions.get(id) as JObj | null) : this.best(id);
    this.sessions.delete(id);
    const seq = this.counter + 1;
    const key = this.keyFor(id, start, null, seq);
    const r = save(this.rawForSave(), this.known, { id, edit, start, now, by: this.name, seq, key });
    if (!r.ok) this.sessions.set(id, start);
    return this.commit(id, r, seq, key);
  }
  /**
   * Restore (take = true: the conflict's version becomes current) or Dismiss (take = false: the current version stays)
   * of conflict number `pick` (0 = the highest in merge order) of `id` — a save that incorporates both (§9.6).
   */
  resolve(id: string, now: number, take: boolean, pick = 0): string {
    if (this.readOnly) return "read-only";
    const st = this.state(id);
    const m = isInt(pick) && pick >= 0 ? st[1 + pick] : undefined;
    if (!m || this.sessions.has(id)) return "none";
    const w = st[0];
    const src = take ? m : w;
    const edit = obj();
    if (!src || !isLive(src)) edit["deleted"] = true;
    else {
      if (isStr(get(src, "name"))) edit["name"] = get(src, "name") as string;
      edit["desktop"] = clone(get(src, "desktop") as JObj);
      edit["phone"] = clone(get(src, "phone") as JObj);
    }
    const seq = this.counter + 1;
    const key = this.keyFor(id, w, m, seq);
    const r = save(this.rawForSave(), this.known, { id, edit, start: w, also: m, now, by: this.name, seq, key });
    const res = this.commit(id, r, seq, key);
    if (res === "saved" && this.lost[id] && includes(r.ok && "entry" in r ? r.entry : m, this.lost[id])) delete this.lost[id];
    return res;
  }
  /** The document this device would put now (merge of what it has seen and what it knows). */
  pending(): JObj {
    return merge(this.rawForSave(), this.known, this.lastSaved).doc;
  }
  put(server: { doc: JObj | null }): string {
    if (!this.wantPut || this.readOnly) return "idle";
    server.doc = this.pending();
    this.wantPut = false;
    this.lastSaved = null;
    return "put";
  }
  /** An incoming account-data document (every event, the echo of this device's own put included). */
  receive(d: Json | null | undefined): string {
    const r = readDoc(d ?? undefined);
    if (r.kind === "ignore") return "ignored";
    const ver = get(r.doc, "v") as number;
    if (ver > 1) {
      // the newer-format latch: never cleared by a v1 event (a delayed or reordered one cannot re-open writes)
      if (ver > this.maxV) this.maxV = ver;
      this.raw = clone(r.doc);
      return "read-only";
    }
    if (this.readOnly) {
      this.raw = clone(r.doc);
      return "read-only";
    }
    const doc = clone(r.doc);
    // known := per id reduce(known ∪ D); a union over the input budget (§9.2) is not taken: the device keeps what it
    // knows, so `known` never outgrows what any device can read
    const next: Known = Object.assign(Object.create(null), this.known) as Known;
    for (const [id, list] of entriesOf(doc)) next[id] = reduce([...(knownEntries(this.known).get(id) ?? []), ...list]);
    const merged = merge(doc, next).doc;
    if (overBudget(merged)) return "ignored";
    this.raw = doc;
    this.known = next;
    const reports: string[] = [];
    for (const id of sortedKeys(this.own as unknown as JObj)) {
      const m = this.own[id];
      const w = this.best(id);
      if (!w || sameEntry(w, m)) continue; // still the current version: pending
      if (!carries(w, m)) {
        this.lost[id] = m;
        reports.push(`lost ${id}`);
      }
      delete this.own[id];
    }
    // a lost save that the current version now carries was resolved (here or on another device): clear the hint
    for (const id of sortedKeys(this.lost as unknown as JObj)) {
      const w = this.best(id);
      if (w && carries(w, this.lost[id])) delete this.lost[id];
    }
    if (canon(merged) !== canon(doc)) this.wantPut = true;
    return reports.length ? reports.join(",") : "ok";
  }
  stateJson(): JObj {
    const o = obj();
    const map = (k: Record<string, JObj | JObj[]>) => {
      const x = obj();
      for (const id of sortedKeys(k as unknown as JObj)) x[id] = clone(k[id] as Json);
      return x;
    };
    o["counter"] = this.counter;
    const ch = obj();
    for (const id of sortedKeys(this.chains as unknown as JObj)) {
      const c = obj();
      c["key"] = this.chains[id].key;
      c["last"] = this.chains[id].last;
      ch[id] = c;
    }
    o["chains"] = ch;
    o["known"] = map(this.known);
    o["own"] = map(this.own);
    o["lost"] = map(this.lost);
    o["maxV"] = this.maxV;
    o["readOnly"] = this.readOnly;
    o["wantPut"] = this.wantPut;
    return o;
  }
}

/** Replay a scripted sync scenario (the `sync` vectors, LAYOUT.md §10.1). */
export function runSync(v: JObj): JObj {
  const names = (get(v, "devices") as string[]).slice();
  const devs = new Map<string, Device>();
  for (const n of names) devs.set(n, new Device(n));
  const server: { doc: JObj | null } = { doc: isObj(get(v, "server")) ? clone(get(v, "server") as JObj) : null };
  const log: string[] = [];
  const steps = get(v, "steps") as JObj[];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const ev = get(s, "event") as string;
    const d = devs.get(get(s, "device") as string);
    let res: string;
    const id = get(s, "id") as string;
    const now = get(s, "now") as number;
    switch (ev) {
      case "begin":
        res = (d as Device).begin(id);
        break;
      case "save":
        res = (d as Device).save(id, get(s, "edit") as JObj, now);
        break;
      case "delete": {
        const ed = obj();
        ed["deleted"] = true;
        res = (d as Device).save(id, ed, now);
        break;
      }
      case "restore":
      case "dismiss": {
        const pk = get(s, "pick");
        res = (d as Device).resolve(id, now, ev === "restore", isInt(pk) ? pk : 0);
        break;
      }
      case "put":
        res = (d as Device).put(server);
        break;
      case "deliver":
        res = (d as Device).receive(server.doc);
        break;
      case "incoming":
        res = (d as Device).receive(get(s, "doc"));
        break;
      case "serverPut":
        server.doc = clone(get(s, "doc") as JObj);
        res = "set";
        break;
      default:
        res = "bad-step";
    }
    log.push(`${i} ${get(s, "device") ?? "-"} ${ev}: ${res}`);
  }
  const out = obj();
  out["log"] = log;
  out["server"] = server.doc;
  const ds = obj();
  for (const n of names.slice().sort(cmpCp)) ds[n] = (devs.get(n) as Device).stateJson();
  out["devices"] = ds;
  return out;
}
