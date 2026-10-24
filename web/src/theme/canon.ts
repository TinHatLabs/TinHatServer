// canon.ts — the byte-stable JSON forms of the theme contract files (test vectors, the library, share payloads).
// NO value imports.

/** Code-point order of two strings (= UTF-8 byte order = Rust's `str` Ord). */
export function cmpCodePoint(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1; // an astral code point sorts after every BMP one
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

const keysOf = (o: object) => Object.keys(o).sort(cmpCodePoint);

/** Compact JSON, object keys sorted (code-point order) at every level. */
export function canonJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + keysOf(o).map((k) => JSON.stringify(k) + ":" + canonJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/**
 * Pretty JSON with object keys sorted (code-point order) at every level and a final newline — the test-vector file
 * format. Same bytes as JSON.stringify(sorted, null, 2) and as serde_json::to_string_pretty of a BTreeMap-backed
 * value: 2-space indent, `": "`, one element per line, empty `[]` / `{}`, non-ASCII kept as UTF-8.
 */
export function prettyJson(v: unknown): string {
  return prettyAt(v, "") + "\n";
}

function prettyAt(v: unknown, ind: string): string {
  const inner = ind + "  ";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[\n" + v.map((x) => inner + prettyAt(x, inner)).join(",\n") + "\n" + ind + "]";
  }
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = keysOf(o);
    if (keys.length === 0) return "{}";
    return "{\n" + keys.map((k) => inner + JSON.stringify(k) + ": " + prettyAt(o[k], inner)).join(",\n") + "\n" + ind + "}";
  }
  return JSON.stringify(v);
}
