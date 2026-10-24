// snapshot.ts — the app's state as the actions engine reads it (ACTIONS.md §4.3, §14.2): one merged snapshot built
// from providers. A provider is a function that returns a part ({values?, subjects?, current?, lists?, local?}) and
// may subscribe to its own stores to say "my part changed". The merged snapshot is rebuilt lazily after a change and
// keeps its identity while nothing changed, so rows and the palette re-evaluate only on real changes (GPU.md: no
// redraw unless something visible changed).
//
//   registerSnapshotProvider("calls", () => ({ values: { "call.in": useCall.getState().joined } }), (changed) => useCall.subscribe(changed));
//   const snap = useActionsSnapshot();   // React: re-renders when the snapshot changes
//
// Providers never throw into the engine: a provider that throws contributes nothing (logged once per id).
import { useSyncExternalStore } from "react";
import type { JObj, Json } from "../layout/json";
import { canonJson } from "../theme/canon";

export interface SubjectEntry {
  name?: string;
  alias?: string;
  values?: Record<string, Json>;
}
export interface SnapshotPart {
  values?: Record<string, Json | undefined>;
  subjects?: Record<string, Record<string, SubjectEntry>>;
  current?: { room?: string | null; activeSpace?: string | null };
  lists?: Record<string, string[]>;
  local?: Record<string, JObj>;
}
type Provider = { fn: () => SnapshotPart; off?: () => void };

const providers = new Map<string, Provider>();
const listeners = new Set<() => void>();
const failed = new Set<string>();
let cached: JObj | null = null;
let cachedKey = "";
let dirty = true;

function changed(): void {
  if (dirty) return;
  dirty = true;
  // notify on a microtask: a burst of store updates (one sync) rebuilds once
  queueMicrotask(() => {
    for (const l of [...listeners]) l();
  });
}

/** Register (or replace) a provider. `subscribe(changed)` returns an unsubscribe; the provider's part is re-read after
 *  every `changed()`. Returns a remover. */
export function registerSnapshotProvider(id: string, fn: () => SnapshotPart, subscribe?: (changed: () => void) => () => void): () => void {
  const old = providers.get(id);
  old?.off?.();
  const p: Provider = { fn };
  providers.set(id, p);
  if (subscribe) p.off = subscribe(changed);
  changed();
  return () => {
    if (providers.get(id) === p) {
      p.off?.();
      providers.delete(id);
      changed();
    }
  };
}

/** Rebuild after a provider's store changed outside a subscription (rare: a value read from a non-store source). */
export function snapshotChanged(): void {
  changed();
}

const put = (o: JObj, k: string, v: Json | undefined) => {
  if (v !== undefined) o[k] = v;
};

function build(): JObj {
  const values: JObj = Object.create(null);
  const subjects: JObj = Object.create(null);
  const current: JObj = Object.create(null);
  const lists: JObj = Object.create(null);
  const local: JObj = Object.create(null);
  for (const [id, p] of [...providers].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    let part: SnapshotPart;
    try {
      part = p.fn();
    } catch (e) {
      if (!failed.has(id)) {
        failed.add(id);
        console.warn(`[actions] snapshot provider ${id} threw`, e);
      }
      continue;
    }
    for (const [k, v] of Object.entries(part.values ?? {})) put(values, k, v);
    for (const [kind, byId] of Object.entries(part.subjects ?? {})) {
      const into = (subjects[kind] as JObj | undefined) ?? (subjects[kind] = Object.create(null) as JObj);
      for (const [sid, e] of Object.entries(byId)) {
        const prev = (into[sid] as JObj | undefined) ?? (Object.create(null) as JObj);
        if (e.name !== undefined) prev.name = e.name;
        if (e.alias !== undefined) prev.alias = e.alias;
        const vals = (prev.values as JObj | undefined) ?? (Object.create(null) as JObj);
        for (const [k, v] of Object.entries(e.values ?? {})) put(vals, k, v);
        prev.values = vals;
        into[sid] = prev;
      }
    }
    if (part.current) {
      if (part.current.room) current.room = part.current.room;
      if (part.current.activeSpace) current.activeSpace = part.current.activeSpace;
    }
    for (const [k, v] of Object.entries(part.lists ?? {})) lists[k] = [...v];
    for (const [k, v] of Object.entries(part.local ?? {})) local[k] = v;
  }
  const snap: JObj = Object.create(null);
  snap.values = values;
  snap.subjects = subjects;
  snap.current = current;
  snap.lists = lists;
  snap.local = local;
  return snap;
}

/** The merged snapshot (same object while nothing changed). */
export function getActionsSnapshot(): JObj {
  if (dirty || !cached) {
    const next = build();
    const key = canonJson(next);
    if (!cached || key !== cachedKey) {
      cached = next;
      cachedKey = key;
    }
    dirty = false;
  }
  return cached;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** React: the merged snapshot; re-renders when it changes. */
export function useActionsSnapshot(): JObj {
  return useSyncExternalStore(subscribe, getActionsSnapshot, getActionsSnapshot);
}

/** Test hook: drop every provider. */
export function resetSnapshotProviders(): void {
  for (const p of providers.values()) p.off?.();
  providers.clear();
  failed.clear();
  cached = null;
  dirty = true;
}

/** A copy of a snapshot with a part laid over it (subjects merged per id, values per name; lists / current / local
 *  replaced per key) — the palette adds the room and people lists to the live snapshot this way. */
export function withPart(snap: JObj, part: SnapshotPart): JObj {
  const out: JObj = Object.create(null);
  const src = (k: string): JObj => {
    const v = snap[k];
    return v && typeof v === "object" && !Array.isArray(v) ? (v as JObj) : (Object.create(null) as JObj);
  };
  const values: JObj = Object.assign(Object.create(null), src("values"));
  for (const [k, v] of Object.entries(part.values ?? {})) put(values, k, v);
  const subjects: JObj = Object.create(null);
  for (const [kind, byId] of Object.entries(src("subjects"))) subjects[kind] = Object.assign(Object.create(null), byId as JObj);
  for (const [kind, byId] of Object.entries(part.subjects ?? {})) {
    const into = (subjects[kind] as JObj | undefined) ?? (subjects[kind] = Object.create(null) as JObj);
    for (const [sid, e] of Object.entries(byId)) {
      const prev = into[sid] as JObj | undefined;
      const next: JObj = Object.create(null);
      if (prev) Object.assign(next, prev);
      if (e.name !== undefined) next.name = e.name;
      if (e.alias !== undefined) next.alias = e.alias;
      const vals: JObj = Object.assign(Object.create(null), (prev?.values as JObj | undefined) ?? {});
      for (const [k, v] of Object.entries(e.values ?? {})) put(vals, k, v);
      next.values = vals;
      into[sid] = next;
    }
  }
  const current: JObj = Object.assign(Object.create(null), src("current"));
  if (part.current?.room) current.room = part.current.room;
  if (part.current?.activeSpace) current.activeSpace = part.current.activeSpace;
  const lists: JObj = Object.assign(Object.create(null), src("lists"));
  for (const [k, v] of Object.entries(part.lists ?? {})) lists[k] = [...v];
  const local: JObj = Object.assign(Object.create(null), src("local"), part.local ?? {});
  out.values = values;
  out.subjects = subjects;
  out.current = current;
  out.lists = lists;
  out.local = local;
  return out;
}
