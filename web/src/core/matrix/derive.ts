// derive.ts — shared, ref-counted derived values over matrix-js-sdk emitters, for hooks.
//
// Every hook in hooks.ts is `useDerived(key, spec)`: components asking for the same key share ONE
// listener set on the client and ONE computed value; recomputation is coalesced to a microtask
// (a sync batch of 200 events → one recompute), and React only re-renders when `equal` says the
// value changed. Entries are keyed by the client epoch, so login/logout starts fresh.
import { useSyncExternalStore } from "react";
import { getClientEpoch, onClientChanged, peekClient } from "./client";
import type { MatrixClient } from "matrix-js-sdk";

export interface DeriveSpec<T> {
  /** Attach listeners; call `changed()` whenever the value may have changed. Return a detacher. */
  attach(client: MatrixClient, changed: () => void): () => void;
  /** Compute the current value (must be cheap-ish and side-effect free). */
  compute(client: MatrixClient | null): T;
  /** Default Object.is. */
  equal?: (a: T, b: T) => boolean;
  /** Called once when the first subscriber arrives (e.g. start a lazy member load). */
  onFirstSubscribe?: (client: MatrixClient, changed: () => void) => void;
}

class Derived<T> {
  private listeners = new Set<() => void>();
  private detach: (() => void) | null = null;
  private scheduled = false;
  private value: T;
  private readonly equal: (a: T, b: T) => boolean;

  constructor(
    private readonly key: string,
    private readonly spec: DeriveSpec<T>,
    private readonly client: MatrixClient | null,
  ) {
    this.equal = spec.equal ?? Object.is;
    this.value = spec.compute(client);
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    if (!this.detach) {
      if (this.client) {
        this.detach = this.spec.attach(this.client, this.changed);
        this.spec.onFirstSubscribe?.(this.client, this.changed);
      } else {
        this.detach = () => undefined;
      }
      this.recompute(); // anything that changed between render and subscribe
    }
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) {
        // Deferred teardown: StrictMode double-mounts and quick remounts keep the entry.
        setTimeout(() => {
          if (this.listeners.size === 0) this.dispose();
        }, 1000);
      }
    };
  };

  getSnapshot = (): T => this.value;

  get idle(): boolean {
    return this.listeners.size === 0;
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
    if (cache.get(this.key) === this) cache.delete(this.key);
  }

  private changed = () => {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.recompute();
    });
  };

  private recompute() {
    const next = this.spec.compute(this.client);
    if (this.equal(this.value, next)) return;
    this.value = next;
    for (const l of [...this.listeners]) l();
  }
}

const cache = new Map<string, Derived<unknown>>();

onClientChanged(() => {
  for (const d of cache.values()) d.dispose();
  cache.clear();
});

function getDerived<T>(key: string, make: () => DeriveSpec<T>): Derived<T> {
  const full = `${getClientEpoch()}|${key}`;
  let d = cache.get(full) as Derived<T> | undefined;
  if (!d) {
    d = new Derived(full, make(), peekClient());
    cache.set(full, d as Derived<unknown>);
    // Created during a render that never committed → collect it.
    const created = d;
    setTimeout(() => {
      if (created.idle) created.dispose();
    }, 5000);
  }
  return d;
}

function subscribeEpoch(cb: () => void) {
  return onClientChanged(cb);
}

/** React: a shared derived value. `key` must uniquely describe (spec + arguments). */
export function useDerived<T>(key: string, make: () => DeriveSpec<T>): T {
  useSyncExternalStore(subscribeEpoch, getClientEpoch, getClientEpoch); // re-key on login/logout
  const d = getDerived(key, make);
  return useSyncExternalStore(d.subscribe, d.getSnapshot, d.getSnapshot);
}

/** Non-React: read the current value of a derived key once (computes if nobody watches it). */
export function readDerived<T>(key: string, make: () => DeriveSpec<T>): T {
  return getDerived(key, make).getSnapshot();
}

// ---- equality helpers ------------------------------------------------------------------------

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

export function shallowObjectEqual<T extends object>(a: T | null | undefined, b: T | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a) as Array<keyof T>;
  const kb = Object.keys(b) as Array<keyof T>;
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/** Arrays of flat objects compared field by field. */
export function arrayOfObjectsEqual<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!shallowObjectEqual(a[i], b[i])) return false;
  return true;
}

export function shallowMapEqual<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k) || !Object.is(b.get(k), v)) return false;
  }
  return true;
}
