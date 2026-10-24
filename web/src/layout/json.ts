// json.ts — JSON data for the layout engine (LAYOUT.md §1): the colour contract's reader and canonical printer, reused
// (ISLANDS-ARCH §6.9: "the layout engine reuses both, it does not get a third implementation").
//
// Every object that can hold a key taken from user data is created WITHOUT a prototype (obj(), clone()), so a key such
// as "__proto__" or "constructor" is an ordinary own key, exactly like the Rust port's maps (ENGINE.md §9, Q1).
// NO value imports except the theme contract's canon.ts / limits.ts.
import { canonJson, cmpCodePoint, prettyJson } from "../theme/canon";
import { MAX_NESTING, isJsonData, isWellFormed, toWellFormed, utf8Length } from "../theme/limits";

export type Json = null | boolean | number | string | Json[] | JObj;
export interface JObj {
  [k: string]: Json;
}

export const isObj = (v: unknown): v is JObj => v !== null && typeof v === "object" && !Array.isArray(v);

/** §1.4: the most values a JSON-value check visits (a value reached twice counts twice). */
export const MAX_VALUES = 1048576;
/**
 * LAYOUT.md §1.4 — the input domain: a runtime value that JSON text could have produced. null, booleans, FINITE
 * numbers, strings and keys without a lone surrogate, arrays and plain objects (prototype Object.prototype or null)
 * nested at most 128 deep (the root is level 1), at most 2^20 values visited. Anything else — undefined, NaN, ±Infinity,
 * a function, a symbol, a bigint, a Map / Date / typed array / class instance, a hole in an array, a cycle (it ends at
 * the depth limit) or a huge shared-reference DAG (the visit budget) — is not JSON data. Iterative; never throws.
 * (The Rust port's inputs are JSON trees by construction; it checks the depth only.)
 */
export function isJsonValue(v: unknown): boolean {
  const stack: [unknown, number][] = [[v, 1]];
  let visits = 0;
  while (stack.length > 0) {
    const [x, depth] = stack.pop() as [unknown, number];
    if (++visits > MAX_VALUES) return false;
    if (x === null || typeof x === "boolean") continue;
    if (typeof x === "number") {
      if (!Number.isFinite(x)) return false;
      continue;
    }
    if (typeof x === "string") {
      if (!isWellFormed(x)) return false;
      continue;
    }
    if (typeof x !== "object") return false;
    if (depth > MAX_NESTING) return false;
    if (Array.isArray(x)) {
      if (visits + stack.length + x.length > MAX_VALUES) return false;
      for (let i = 0; i < x.length; i++) {
        if (!(i in x)) return false; // a hole
        stack.push([x[i], depth + 1]);
      }
      continue;
    }
    const proto = Object.getPrototypeOf(x);
    if (proto !== null && proto !== Object.prototype) return false;
    const keys = Object.keys(x);
    if (visits + stack.length + keys.length > MAX_VALUES) return false;
    for (const k of keys) {
      if (!isWellFormed(k)) return false;
      stack.push([(x as Record<string, unknown>)[k], depth + 1]);
    }
  }
  return true;
}
export const isArr = (v: unknown): v is Json[] => Array.isArray(v);
export const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** An OWN property (never an inherited one). */
export const get = (o: JObj, k: string): Json | undefined => (has(o, k) ? o[k] : undefined);
/** A JSON number whose value is integral (1.0 and 1e2 are integers, 1.5 is not; -0 is 0). */
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
export const isStr = (v: unknown): v is string => typeof v === "string";

/** A new object without a prototype (safe for any key). */
export function obj(): JObj {
  return Object.create(null) as JObj;
}

/** Build a prototype-less object from [key, value] pairs (keys are trusted literals or checked data). */
export function mk(pairs: [string, Json | undefined][]): JObj {
  const o = obj();
  for (const [k, v] of pairs) if (v !== undefined) o[k] = v;
  return o;
}

/** Deep copy into prototype-less objects; a non-finite number becomes null (what JSON.stringify prints for it). */
export function clone<T extends Json | undefined>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  if (v !== null && typeof v === "object") {
    const o = obj();
    for (const k of Object.keys(v)) o[k] = clone((v as JObj)[k]);
    return o as T;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return null as T;
  return v;
}

/**
 * JSON text → data, read exactly like the colour contract's reader (ENGINE.md §9, Rust `json.rs`): strict JSON,
 * arrays/objects nested at most 128 deep, no lone surrogate made by a `\u` escape (a raw lone surrogate in the text
 * reads as U+FFFD), duplicate keys: the last wins, `__proto__` is an ordinary key, a number that overflows a double
 * reads as null. Never throws.
 */
export function readJson(text: unknown): { ok: true; value: Json } | { ok: false } {
  if (typeof text !== "string") return { ok: false };
  let v: unknown;
  try {
    v = JSON.parse(toWellFormed(text));
  } catch {
    return { ok: false };
  }
  if (!isJsonData(v)) return { ok: false };
  return { ok: true, value: clone(v as Json) };
}

/** Canonical compact JSON (keys in code-point order, ECMAScript numbers) — the contract's byte form. */
export const canon = (v: Json | undefined): string => (v === undefined ? "" : canonJson(v));
/** Canonical pretty JSON + final newline — the test-vector file format. */
export const pretty = (v: Json): string => prettyJson(v);
export const sameJson = (a: Json | undefined, b: Json | undefined): boolean => canon(a) === canon(b);
export const cmpCp = cmpCodePoint;
export const sortedKeys = (o: JObj): string[] => Object.keys(o).sort(cmpCodePoint);
/** UTF-8 bytes of the canonical form. */
export const canonBytes = (v: Json): number => utf8Length(canonJson(v));

/** Floor division with a positive divisor (LAYOUT.md §5.1; Rust `div_euclid`). Exact for |a| < 2^53. */
export function fdiv(a: number, b: number): number {
  if (!(b > 0)) throw new Error(`layout: fdiv by ${b}`);
  return Math.floor(a / b);
}

export const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
