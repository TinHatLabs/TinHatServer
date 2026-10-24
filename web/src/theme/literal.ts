// literal.ts — ENGINE.md §1: the colour value, colour literals and the canonical text form.
//
// A colour is {r, g, b, a}: r/g/b integers 0..255, a = k/10000 for an integer k in 0..10000 (alpha carried
// with at most 4 decimals). Everything here is integer maths; no float printing or parsing is used.
// NO value imports: this file is loaded by the node unit tests (type stripping) as well as the app.

export interface Colour {
  r: number; // 0..255 integer
  g: number;
  b: number;
  a: number; // k / 10000, k integer 0..10000
}

export const WHITE: Colour = { r: 255, g: 255, b: 255, a: 1 };
export const BLACK: Colour = { r: 0, g: 0, b: 0, a: 1 };

/** Alpha in 1/10000 units (exact: a is always k/10000). */
export function alphaK(c: Colour): number {
  return Math.round(c.a * 10000);
}

export function isOpaque(c: Colour): boolean {
  return alphaK(c) >= 10000;
}

export function opaque(c: Colour): Colour {
  return { r: c.r, g: c.g, b: c.b, a: 1 };
}

export function sameColour(x: Colour, y: Colour): boolean {
  return x.r === y.r && x.g === y.g && x.b === y.b && alphaK(x) === alphaK(y);
}

const isDigit = (ch: number) => ch >= 48 && ch <= 57;

function hexVal(ch: number): number {
  if (ch >= 48 && ch <= 57) return ch - 48;
  if (ch >= 97 && ch <= 102) return ch - 87; // a-f
  if (ch >= 65 && ch <= 70) return ch - 55; // A-F
  return -1;
}

/**
 * The number grammar of the expression language and the canonical alpha:
 *   `D{1,4}`, `D{1,4}.D{1,4}` or `.D{1,4}` (D = ASCII digit). Returns k = value × 10000 as an exact
 *   integer, or -1 when the text is not such a number.
 */
export function parseDecimal4(s: string): number {
  const n = s.length;
  let i = 0;
  let ip = 0;
  let idigits = 0;
  while (i < n && isDigit(s.charCodeAt(i))) {
    if (++idigits > 4) return -1;
    ip = ip * 10 + (s.charCodeAt(i) - 48);
    i++;
  }
  let fp = 0;
  let fdigits = 0;
  if (i < n && s.charCodeAt(i) === 46 /* . */) {
    i++;
    while (i < n && isDigit(s.charCodeAt(i))) {
      if (++fdigits > 4) return -1;
      fp = fp * 10 + (s.charCodeAt(i) - 48);
      i++;
    }
    if (fdigits === 0) return -1; // "1." is not a number
  }
  if (i !== n || idigits + fdigits === 0) return -1;
  for (let d = fdigits; d < 4; d++) fp *= 10;
  return ip * 10000 + fp;
}

/**
 * Colour literal (§1): `#rgb`, `#rrggbb`, `#rrggbbaa` (CSS order, alpha LAST: k = round(aa × 10000 / 255),
 * computed exactly as floor((aa × 20000 + 255) / 510)) or the canonical `#rrggbb/A` (A = 0..1, ≤ 4 decimals).
 * Hex is case-insensitive. Returns null for anything else (no surrounding whitespace allowed).
 */
export function parseLiteral(s: string): Colour | null {
  if (s.length < 4 || s.charCodeAt(0) !== 35 /* # */) return null;
  const slash = s.indexOf("/");
  const hexEnd = slash < 0 ? s.length : slash;
  const hex: number[] = [];
  for (let i = 1; i < hexEnd; i++) {
    const v = hexVal(s.charCodeAt(i));
    if (v < 0) return null;
    hex.push(v);
  }
  if (slash >= 0) {
    if (hex.length !== 6) return null;
    const k = parseDecimal4(s.slice(slash + 1));
    if (k < 0 || k > 10000) return null;
    return { r: hex[0] * 16 + hex[1], g: hex[2] * 16 + hex[3], b: hex[4] * 16 + hex[5], a: k / 10000 };
  }
  if (hex.length === 3) return { r: hex[0] * 17, g: hex[1] * 17, b: hex[2] * 17, a: 1 };
  if (hex.length === 6) return { r: hex[0] * 16 + hex[1], g: hex[2] * 16 + hex[3], b: hex[4] * 16 + hex[5], a: 1 };
  if (hex.length === 8) {
    const aa = hex[6] * 16 + hex[7];
    const k = Math.floor((aa * 20000 + 255) / 510);
    return { r: hex[0] * 16 + hex[1], g: hex[2] * 16 + hex[3], b: hex[4] * 16 + hex[5], a: k / 10000 };
  }
  return null;
}

const HEX = "0123456789abcdef";
const hex2 = (v: number) => HEX[v >> 4] + HEX[v & 15];

/** `#rrggbb` (lower-case) of the RGB channels, alpha ignored. */
export function hex6(c: Colour): string {
  return "#" + hex2(c.r) + hex2(c.g) + hex2(c.b);
}

/**
 * Canonical text form (§1): `#rrggbb` when k = 10000, `#rrggbb/0` when k = 0, else `#rrggbb/0.dddd` with the
 * 4 zero-padded digits of k and trailing zeros stripped (`#1e6a76/0.18`, `#000000/0.5`, `#ffffff/0.0001`).
 */
export function formatColour(c: Colour): string {
  const k = alphaK(c);
  const h = hex6(c);
  if (k >= 10000) return h;
  if (k <= 0) return h + "/0";
  let d = String(k); // integer printing, 1..9999
  while (d.length < 4) d = "0" + d;
  let end = 4;
  while (d.charCodeAt(end - 1) === 48) end--;
  return h + "/0." + d.slice(0, end);
}
