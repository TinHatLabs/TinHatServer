// maths.ts — ENGINE.md §2: the deterministic colour maths (sRGB tables, cbrt, OKLab, luminance, contrast).
//
// Only IEEE-754 double + - * /, comparisons, floor and sqrt; every formula is written in the order the contract
// gives (`a*x + b*y + c*z` = ((a*x) + (b*y)) + (c*z)). No pow/cbrt/exp/log/trig, no fused multiply-add. The Rust
// port writes the same expressions in the same order and gets the same bits.
import type { Colour } from "./literal";
import tables from "./engine-tables.json" with { type: "json" };

/** SRGB_TO_LIN[v] = sRGB decode of v/255 (literal table, engine-tables.json). */
const LIN: readonly number[] = tables.SRGB_TO_LIN;
/** ENC_MID[i] = sRGB decode of (i + 0.5)/255: the encode thresholds. */
const MID: readonly number[] = tables.ENC_MID;

if (LIN.length !== 256 || MID.length !== 255) throw new Error("engine-tables.json: bad table sizes");

export function srgbToLinear(v: number): number {
  return LIN[v];
}

/** sRGB encode of a linear value: clamp to [0,1], then the number of ENC_MID entries that are < x. */
export function linearToSrgb(x: number): number {
  if (!(x > 0)) return 0; // x <= 0 (clamped to 0: no threshold is < 0)
  if (x > 1) x = 1;
  let lo = 0;
  let hi = 255;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (MID[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** cbrt by exactly 64 Newton steps: y0 = 1 if x < 1 else x; y = (2*y + x/(y*y)) / 3. */
export function cbrt(x: number): number {
  if (x === 0) return 0;
  if (x < 0) return -cbrt(-x);
  let y = x < 1 ? 1.0 : x;
  for (let i = 0; i < 64; i++) y = (2 * y + x / (y * y)) / 3;
  return y;
}

export interface Lab {
  L: number;
  A: number;
  B: number;
}

const labCache = new Map<number, Lab>();

/** OKLab of an 8-bit sRGB colour (alpha ignored). Memoised per RGB: the maths is pure. */
export function toOklab(c: Colour): Lab {
  const key = (c.r << 16) | (c.g << 8) | c.b;
  const hit = labCache.get(key);
  if (hit) return hit;
  const r = LIN[c.r];
  const g = LIN[c.g];
  const b = LIN[c.b];
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = cbrt(l);
  const m_ = cbrt(m);
  const s_ = cbrt(s);
  const lab: Lab = {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    A: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    B: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
  labCache.set(key, lab);
  return lab;
}

/** OKLab → 8-bit sRGB channels: inverse matrices, cube as (x*x)*x, clamp to [0,1], table encode. */
export function fromOklab(L: number, A: number, B: number): [number, number, number] {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.2914855480 * B;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

/** OKLab chroma sqrt(A*A + B*B). */
export function chroma(c: Colour): number {
  const lab = toOklab(c);
  return Math.sqrt(lab.A * lab.A + lab.B * lab.B);
}

/** WCAG relative luminance of the RGB channels (alpha ignored). */
export function luminance(c: Colour): number {
  return 0.2126 * LIN[c.r] + 0.7152 * LIN[c.g] + 0.0722 * LIN[c.b];
}

/** (max(Y1,Y2) + 0.05) / (min(Y1,Y2) + 0.05). */
export function contrastOfY(y1: number, y2: number): number {
  const hi = y1 > y2 ? y1 : y2;
  const lo = y1 > y2 ? y2 : y1;
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Linear interpolation of the 4-decimal alpha: k = round((a1 + (a2 - a1) * t) * 10000), clamped to 0..10000.
 * (`mix` in ui/color.ts interpolates alpha with the same expression; the engine keeps 4 decimals, §1.)
 */
export function lerpAlpha(a1: number, a2: number, t: number): number {
  let k = Math.round((a1 + (a2 - a1) * t) * 10000);
  if (k < 0) k = 0;
  if (k > 10000) k = 10000;
  return k / 10000;
}

/** mixok(x, y, t): OKLab interpolation p + (q - p) * t per component, alpha linear (lerpAlpha). */
export function mixok(x: Colour, y: Colour, t: number): Colour {
  const p = toOklab(x);
  const q = toOklab(y);
  const [r, g, b] = fromOklab(p.L + (q.L - p.L) * t, p.A + (q.A - p.A) * t, p.B + (q.B - p.B) * t);
  return { r, g, b, a: lerpAlpha(x.a, y.a, t) };
}
