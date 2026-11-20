// contract.ts — the frozen play contract v1 (the contract freeze: testvectors/games/views/, byte-identical in the
// server and the desktop; INDEX.json md5 510330ad…) read the way the contract's README asks apps to: its schema.json is
// the producer contract, and the app checks every frame and HTTP answer against it TOLERANTLY: unknown fields and
// unknown frame types are ignored, a known field with a wrong type or value refuses the whole thing (malformed.json:
// 32 must-reject, 3 must-tolerate). A refused view is dropped (the last good one stays on screen), never half-drawn.
//
// The validator is the JSON Schema 2020-12 subset the contract uses: type, const, enum, properties, required,
// additionalProperties, propertyNames, items, minItems, maxItems, minimum, maximum, minLength, maxLength, pattern, anyOf,
// oneOf (exactly one branch), $ref. Tolerance: where the schema says `additionalProperties: false`, an unexpected key is
// ignored (a later server's additive field), EXCEPT the names that carry secrets or who-did-what (PRIVATE below): one of
// those out of place is refused (a Mechanic's `card` in a Sharp's view, an `owner` on an open board card: the leaks
// malformed.json plants). So an older app keeps reading a newer server's views, and a leak is never drawn.
// Pure: no React, no app imports (the unit tests run it in plain Node).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = Record<string, unknown>;

/** Field names that carry hidden cards, secret roles' state or who-did-what: never tolerated where the schema doesn't
 *  put them. */
export const PRIVATE: ReadonlySet<string> = new Set(["card", "cards", "deal", "kept", "shown", "owner", "by", "who", "armed", "mutes", "mutes_left", "peek", "peeks", "market", "whispers", "seed", "slots", "audit", "reveal", "you", "hole", "deck", "five", "best"]);

export interface Contract {
  defs: Record<string, Schema>;
  /** the PRIVATE names this contract uses (a later schema may add more) */
  known: ReadonlySet<string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const patterns = new Map<string, RegExp>();
function re(p: string): RegExp {
  let r = patterns.get(p);
  if (!r) patterns.set(p, (r = new RegExp(p, "u")));
  return r;
}

function typeOk(t: unknown, v: unknown): boolean {
  const one = (x: unknown) => {
    switch (x) {
      case "null":
        return v === null;
      case "boolean":
        return typeof v === "boolean";
      case "integer":
        return typeof v === "number" && Number.isSafeInteger(v);
      case "number":
        return typeof v === "number" && Number.isFinite(v);
      case "string":
        return typeof v === "string";
      case "array":
        return Array.isArray(v);
      case "object":
        return isObj(v);
      default:
        return false;
    }
  };
  return Array.isArray(t) ? t.some(one) : one(t);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Does `v` fit `s` (tolerant: extra object keys are fine)? */
export function fits(c: Contract, s: Schema, v: unknown, depth = 0, strict = false): boolean {
  if (depth > 64) return false;
  if (typeof s.$ref === "string") {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    const d = m ? c.defs[m[1]!] : undefined;
    if (!d || !fits(c, d, v, depth + 1, strict)) return false;
  }
  if (own(s, "const") && !same(s.const, v)) return false;
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) return false;
  if (own(s, "type") && !typeOk(s.type, v)) return false;
  if (Array.isArray(s.anyOf) && !s.anyOf.some((b) => fits(c, b as Schema, v, depth + 1, strict))) return false;
  if (Array.isArray(s.oneOf) && s.oneOf.filter((b) => fits(c, b as Schema, v, depth + 1, strict)).length !== 1) return false;
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) return false;
    if (typeof s.maximum === "number" && v > s.maximum) return false;
  }
  if (typeof v === "string") {
    const n = [...v].length;
    if (typeof s.minLength === "number" && n < s.minLength) return false;
    if (typeof s.maxLength === "number" && n > s.maxLength) return false;
    if (typeof s.pattern === "string" && !re(s.pattern).test(v)) return false;
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) return false;
    if (typeof s.maxItems === "number" && v.length > s.maxItems) return false;
    if (isObj(s.items) && !v.every((x) => fits(c, s.items as Schema, x, depth + 1, strict))) return false;
  }
  if (isObj(v)) {
    if (Array.isArray(s.required) && !s.required.every((k) => typeof k === "string" && own(v, k))) return false;
    if (isObj(s.properties)) {
      for (const [k, ps] of Object.entries(s.properties)) if (own(v, k) && !fits(c, ps as Schema, v[k], depth + 1, strict)) return false;
    }
    if (isObj(s.propertyNames) && !Object.keys(v).every((k) => fits(c, s.propertyNames as Schema, k, depth + 1, strict))) return false;
    const props = isObj(s.properties) ? s.properties : {};
    // additionalProperties as a schema (maps like `paid`, `net`): every value must fit
    if (isObj(s.additionalProperties)) {
      for (const [k, x] of Object.entries(v)) if (!own(props, k) && !fits(c, s.additionalProperties as Schema, x, depth + 1, strict)) return false;
    }
    // `false`: a contract name out of place is refused; a name the contract never uses is tolerated (ignored)
    if (s.additionalProperties === false) {
      for (const k of Object.keys(v)) if (!own(props, k) && (strict || c.known.has(k))) return false;
    }
  }
  return true;
}

export function contractOf(schemaJson: unknown): Contract {
  const d = isObj(schemaJson) && isObj(schemaJson.$defs) ? (schemaJson.$defs as Record<string, Schema>) : {};
  const known = new Set<string>();
  const walk = (o: unknown) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (isObj(o)) {
      if (isObj(o.properties)) for (const k of Object.keys(o.properties)) known.add(k);
      for (const x of Object.values(o)) walk(x);
    }
  };
  walk(d);
  for (const k of [...known]) if (!PRIVATE.has(k)) known.delete(k);
  return { defs: d, known };
}

/** `v` checked against the contract's `$defs[def]`; null = refused. `strict` = the schema exactly (what this app SENDS:
 *  it is the producer there). */
export function check<T>(c: Contract, def: string, v: unknown, strict = false): T | null {
  const s = c.defs[def];
  return s && fits(c, s, v, 0, strict) ? (v as T) : null;
}
