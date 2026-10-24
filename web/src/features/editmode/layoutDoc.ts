// layoutDoc.ts — which layout this device renders and the device side of the layout sync (LAYOUT.md §9, EDITMODE-UI
// §9, §13, §16): the engine's device protocol (`Device`: counter, chains, known, own, lost, the newer-format latch)
// persisted per account in localStorage `tinhat.layouts.<userId>` BEFORE any put that carries a save; the projection of
// the best document this device knows (`project(merge(raw, known), layout-active)`), or the device-local reset override
// (pref `layout-override`) → the desktop and phone forms the shell renders. No document yet = the device's own forms
// (actions/layoutStore.ts: the prefs layout-desktop / layout-phone — button rows and button islands made before the
// first save; Classic when none), which the first save of `main` copies verbatim.
//
// The account-data I/O (reading `dev.tinhat.layouts`, PUTs with retries, re-asserts) is layoutSync.ts; this file only
// holds state and answers what to render / what to put. Gate mode `?layoutsync=0`: the account is neither read nor
// written (saves stay in the device state of this page).
import { useSyncExternalStore } from "react";
import { Device, canon, classicDesktop, classicPhone, clone, merge, project, type JObj, type Json, type Projection } from "@/layout";
import { get, isArr, isInt, isObj, isStr, obj } from "@/layout/json";
import { getPrefRaw, onPrefChange, removePref, setPrefRaw } from "@/core/prefs";
import { LAYOUT_DESKTOP_PREF, LAYOUT_PHONE_PREF, getDeviceForm } from "@/actions/layoutStore";

export const ACTIVE_PREF = "layout-active";
export const OVERRIDE_PREF = "layout-override";
const STORE_PREFIX = "tinhat.layouts.";

export const layoutSyncEnabled = (): boolean => typeof location === "undefined" || !/[?&]layoutsync=0\b/.test(location.search);

export interface Rendered {
  /** the layout id this device renders (its entry, or `main` for built-in Classic) */
  id: string;
  name: string;
  desktop: JObj;
  phone: JObj;
  /** "classic" = no document entry yet · "doc" = the synced entry · "override" = the device-local reset */
  source: "classic" | "doc" | "override";
  /** the document says v > 1: no writes of any kind (EDITMODE-UI §13) */
  readOnly: boolean;
  /** the live layouts {id, name} (code-point order of ids) */
  layouts: { id: string; name: string }[];
  /** the active entry has a `previous` version (Restore previous version) */
  hasPrevious: boolean;
  /** conflicts of the active layout (LAYOUT §9.4) or this device's lost save of it */
  conflict: boolean;
  /** the active entry's tuple — the reset override's base */
  tuple: [number, number, string];
}

// ---- state ------------------------------------------------------------------------------------------------------
let device: Device | null = null;
let userId: string | null = null;
let rendered: Rendered = classicRendered();
const listeners = new Set<() => void>();
let wantPutHook: (() => void) | null = null;

function classicRendered(): Rendered {
  return {
    id: "main",
    name: "Main",
    desktop: getDeviceForm("desktop"),
    phone: getDeviceForm("phone"),
    source: "classic",
    readOnly: false,
    layouts: [],
    hasPrevious: false,
    conflict: false,
    tuple: [0, 0, ""],
  };
}

function emit(): void {
  for (const l of [...listeners]) l();
}

// ---- persistence (localStorage, per account) -----------------------------------------------------------------------
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Persist the device state (LAYOUT §9.7 durability). Answers false when it could not be stored — then nothing that
 *  carries a save may be put (a reload would reuse counters and claim history it never had). */
function persist(): boolean {
  if (!device || !userId) return false;
  const d = device;
  const o = obj();
  o["v"] = 1;
  o["name"] = d.name;
  o["counter"] = d.counter;
  o["chains"] = clone(d.chains as unknown as Json);
  const known = obj();
  for (const [id, list] of Object.entries(d.known)) known[id] = clone(list as unknown as Json);
  o["known"] = known;
  const own = obj();
  for (const [id, e] of Object.entries(d.own)) own[id] = clone(e);
  o["own"] = own;
  const lost = obj();
  for (const [id, e] of Object.entries(d.lost)) lost[id] = clone(e);
  o["lost"] = lost;
  o["maxV"] = d.maxV;
  o["raw"] = d.raw ? clone(d.raw) : null;
  o["wantPut"] = d.wantPut;
  o["lastSaved"] = d.lastSaved;
  const st = storage();
  if (!st) return false;
  try {
    st.setItem(STORE_PREFIX + userId, JSON.stringify(o));
    return true;
  } catch {
    return false; // quota: the put waits (takePut), the next save / receive retries
  }
}

function load(uid: string, matrixDevice: string): Device {
  let st: JObj | null = null;
  try {
    const raw = storage()?.getItem(STORE_PREFIX + uid);
    if (raw) {
      const v = JSON.parse(raw) as Json;
      if (isObj(v) && get(v, "v") === 1 && isStr(get(v, "name"))) st = v;
    }
  } catch {
    st = null;
  }
  if (!st) {
    // a device that has no saved state takes a NEW device id (LAYOUT §9.7 durability: an old id with a lower counter
    // would make new saves look old) — the Matrix device id + a random suffix; 1-64 code points, no `#`
    const base = (matrixDevice || "web").replace(/#/g, "").slice(0, 48);
    const d = new Device(`${base}-${Math.random().toString(36).slice(2, 8)}`);
    return d;
  }
  const d = new Device(get(st, "name") as string);
  const n = get(st, "counter");
  d.counter = isInt(n) && n >= 0 ? n : 0;
  const ch = get(st, "chains");
  if (isObj(ch))
    for (const [id, c] of Object.entries(ch))
      if (isObj(c) && isStr(get(c, "key")) && isInt(get(c, "last"))) d.chains[id] = { key: get(c, "key") as string, last: get(c, "last") as number };
  const kn = get(st, "known");
  if (isObj(kn)) for (const [id, list] of Object.entries(kn)) if (isArr(list)) d.known[id] = list.filter(isObj) as JObj[];
  const ow = get(st, "own");
  if (isObj(ow)) for (const [id, e] of Object.entries(ow)) if (isObj(e)) d.own[id] = e;
  const lo = get(st, "lost");
  if (isObj(lo)) for (const [id, e] of Object.entries(lo)) if (isObj(e)) d.lost[id] = e;
  const mv = get(st, "maxV");
  d.maxV = isInt(mv) && mv >= 1 ? mv : 1;
  const raw = get(st, "raw");
  d.raw = isObj(raw) ? raw : null;
  d.wantPut = get(st, "wantPut") === true;
  const ls = get(st, "lastSaved");
  d.lastSaved = isStr(ls) ? ls : null;
  return d;
}

// ---- the projection ---------------------------------------------------------------------------------------------
function activeId(): string {
  const v = getPrefRaw(ACTIVE_PREF);
  if (v === null) return "main";
  try {
    const s = JSON.parse(v) as unknown;
    return typeof s === "string" && s ? s : "main";
  } catch {
    return v || "main";
  }
}

export interface Override {
  id: string;
  base: [number, number, string];
}
export function readOverride(): Override | null {
  const v = getPrefRaw(OVERRIDE_PREF);
  if (!v) return null;
  try {
    const o = JSON.parse(v) as Json;
    if (!isObj(o) || get(o, "v") !== 1 || get(o, "form") !== "classic" || !isStr(get(o, "id"))) return null;
    const b = get(o, "base");
    const base: [number, number, string] =
      isArr(b) && b.length === 3 && isInt(b[0]) && isInt(b[1]) && isStr(b[2]) ? [b[0], b[1], b[2]] : [0, 0, ""];
    return { id: get(o, "id") as string, base };
  } catch {
    return null;
  }
}

/** The document this device would render from: what it has seen merged with what it knows. */
function bestDoc(): JObj | null {
  if (!device) return null;
  if (device.readOnly) return device.raw;
  return merge(device.raw, device.known).doc;
}

function recompute(): void {
  const doc = bestDoc();
  const act = activeId();
  const p: Projection = project(doc ?? undefined, act);
  const hasEntry = p.layouts.length > 0;
  const ids = p.layouts;
  const names = ids.map((id) => ({ id, name: nameOf(doc, id) ?? id }));
  const cur = hasEntry ? device?.best(p.active) ?? null : null;
  const r: Rendered = {
    id: p.active,
    name: p.name,
    desktop: hasEntry ? p.desktop : getDeviceForm("desktop"),
    phone: hasEntry ? p.phone : getDeviceForm("phone"),
    source: hasEntry ? "doc" : "classic",
    readOnly: p.read === "newer" || !!device?.readOnly,
    layouts: names,
    hasPrevious: !!cur && isObj(get(cur, "previous")),
    conflict: (p.conflicts?.length ?? 0) > 0 || !!(device && device.lost[p.active]),
    tuple: cur ? tupleOfEntry(cur) : [0, 0, ""],
  };
  const ov = readOverride();
  // a reset override covers the layout it was made for (switching the device to another layout shows that one)
  if (ov && ov.id === r.id) {
    r.desktop = classicDesktop();
    r.phone = classicPhone();
    r.source = "override";
  }
  // keep identities when nothing changed (the shell re-solves on a new form object)
  const same = (a: JObj, b: JObj) => canon(a) === canon(b);
  if (same(r.desktop, rendered.desktop)) r.desktop = rendered.desktop;
  if (same(r.phone, rendered.phone)) r.phone = rendered.phone;
  const changed =
    r.desktop !== rendered.desktop ||
    r.phone !== rendered.phone ||
    r.id !== rendered.id ||
    r.name !== rendered.name ||
    r.source !== rendered.source ||
    r.readOnly !== rendered.readOnly ||
    r.hasPrevious !== rendered.hasPrevious ||
    r.conflict !== rendered.conflict ||
    canon(r.layouts as unknown as Json) !== canon(rendered.layouts as unknown as Json) ||
    canon(r.tuple as unknown as Json) !== canon(rendered.tuple as unknown as Json);
  if (!changed) return;
  rendered = r;
  emit();
}

function tupleOfEntry(e: JObj): [number, number, string] {
  const rev = get(e, "rev");
  const at = get(e, "savedAt");
  const by = get(e, "by");
  return [isInt(rev) ? rev : 0, isInt(at) ? at : 0, isStr(by) ? by : ""];
}

function nameOf(doc: JObj | null, id: string): string | null {
  if (!doc) return null;
  const ls = get(doc, "layouts");
  if (!isArr(ls)) return null;
  for (const e of ls) if (isObj(e) && get(e, "id") === id && isStr(get(e, "name"))) return get(e, "name") as string;
  return null;
}

// ---- public API -------------------------------------------------------------------------------------------------
export function getRendered(): Rendered {
  return rendered;
}
export function subscribeRendered(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
/** React: the layout this device renders (live). */
export function useRendered(): Rendered {
  return useSyncExternalStore(subscribeRendered, getRendered, getRendered);
}

onPrefChange(ACTIVE_PREF, recompute);
onPrefChange(OVERRIDE_PREF, recompute);
onPrefChange(LAYOUT_DESKTOP_PREF, recompute);
onPrefChange(LAYOUT_PHONE_PREF, recompute);

/** Signed in (or another account): this account's device state (layoutSync.ts calls it). */
export function attach(uid: string, matrixDevice: string): void {
  userId = uid;
  device = load(uid, matrixDevice);
  recompute();
}
/** Signed out: forget the in-memory state (the stored one stays with the account on this browser). */
export function detach(): void {
  device = null;
  userId = null;
  recompute();
}
export function onWantPut(cb: () => void): void {
  wantPutHook = cb;
}
export function wantsPut(): boolean {
  return !!device && device.wantPut && !device.readOnly;
}

/**
 * The document to PUT now — null when nothing is wanted (or the state that carries it is not durable). The device's
 * `wantPut` is cleared in memory only: the stored state keeps wanting the put until the server accepted it (putDone),
 * so a tab closed mid-PUT sends it again at the next start.
 */
export function takePut(): JObj | null {
  if (!device || !device.wantPut || device.readOnly) return null;
  if (!persist()) return null; // not durable: never publish (the stored state wants the put either way)
  const server: { doc: JObj | null } = { doc: null };
  const lastSaved = device.lastSaved;
  if (device.put(server) !== "put" || !server.doc) return null;
  pendingLastSaved = lastSaved;
  return server.doc;
}
let pendingLastSaved: string | null = null;
export function putFailed(): void {
  if (!device) return;
  device.wantPut = true;
  if (pendingLastSaved && !device.lastSaved) device.lastSaved = pendingLastSaved;
  pendingLastSaved = null;
  persist();
}
/** The server accepted the PUT: now the stored state may stop wanting it. */
export function putDone(): void {
  pendingLastSaved = null;
  persist();
}

/** An incoming `dev.tinhat.layouts` content. Answers the device's result ("ok", "lost main", "ignored", …). */
export function receive(content: Json | undefined): string {
  if (!device) return "ignored";
  const r = device.receive(content ?? null);
  persist();
  recompute();
  return r;
}

export type SaveOutcome = "saved" | "noop" | "read-only" | string;

/**
 * One save (Done, Keep for all devices, Restore previous, New, Rename, Delete — EDITMODE-UI §16). While an edit session
 * of `id` is open only its Done may save that layout (`fromSession`): any other save would consume the session's start
 * entry (Device.save closes it) and the Done after it would claim history it does not have → "busy".
 */
export function saveLayout(id: string, edit: JObj, fromSession = false): SaveOutcome {
  if (!device) {
    // not signed in yet (cannot happen from the UI): nothing to save into
    return "bad-op: bad request";
  }
  if (!fromSession && device.sessions.has(id)) return "busy";
  const res = device.save(id, edit, Date.now());
  if (res === "saved") {
    persist();
    recompute();
    wantPutHook?.();
  }
  return res;
}

/** Restore mine (take) / Dismiss (keep the current) of the active layout's first conflict (§13). */
export function resolveConflict(take: boolean): SaveOutcome {
  if (!device) return "none";
  const res = device.resolve(rendered.id, Date.now(), take, 0);
  if (res === "saved") {
    persist();
    recompute();
    wantPutHook?.();
  } else if (res === "none" && device.lost[rendered.id]) {
    // only a local hint (the document holds no conflict): clear it
    delete device.lost[rendered.id];
    persist();
    recompute();
  }
  return res;
}

/**
 * An edit session of `id` opens / ends (LAYOUT §9.7 begin): the save at Done then builds on the entry the session
 * STARTED from, so a change another device made meanwhile is not claimed as included (it becomes `previous`, and that
 * device is told its change was replaced — Restore mine). Answers the start entry's tuple.
 */
export function beginSession(id: string): [number, number, string] {
  if (!device) return [0, 0, ""];
  device.begin(id);
  const st = device.sessions.get(id);
  return st ? tupleOfEntry(st) : [0, 0, ""];
}
export function endSession(id: string): void {
  device?.sessions.delete(id);
}

/** The active entry's `previous` forms (Restore previous version), or null. */
export function previousOf(id: string): { name: string; desktop: JObj; phone: JObj } | null {
  const e = device?.best(id);
  const p = e ? get(e, "previous") : undefined;
  if (!isObj(p) || !isObj(get(p, "desktop")) || !isObj(get(p, "phone"))) return null;
  const nm = get(p, "name");
  return { name: isStr(nm) ? nm : id, desktop: get(p, "desktop") as JObj, phone: get(p, "phone") as JObj };
}

/** Which layout this device uses (device-local, EDITMODE-UI §13). */
export function setActive(id: string): void {
  setPrefRaw(ACTIVE_PREF, JSON.stringify(id));
}

// ---- the device-local reset (§9) --------------------------------------------------------------------------------
export function setOverride(): void {
  const o = { v: 1, id: rendered.id, form: "classic", base: rendered.tuple };
  setPrefRaw(OVERRIDE_PREF, JSON.stringify(o));
}
export function clearOverride(): void {
  removePref(OVERRIDE_PREF);
}
/** Keep for all devices: save Classic as the active layout (the replaced entry becomes `previous`). */
export function keepOverride(): SaveOutcome {
  const ed = obj();
  ed["name"] = rendered.name;
  ed["desktop"] = classicDesktop();
  ed["phone"] = classicPhone();
  const r = saveLayout(rendered.id, ed);
  if (r === "saved" || r === "noop") clearOverride();
  return r;
}

/** A new layout id: `l` + base36 of now (unique among the known ids). */
export function newLayoutId(): string {
  const known = new Set(rendered.layouts.map((l) => l.id));
  let t = Date.now();
  let id = `l${t.toString(36)}`;
  while (known.has(id)) id = `l${(++t).toString(36)}`;
  return id;
}

/** Test hook (dev / debug): the device state. */
export function debugState(): Json {
  return device ? (device.stateJson() as Json) : null;
}
