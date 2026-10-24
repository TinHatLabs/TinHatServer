// ops.ts — the colour functions of the expression language (ENGINE.md §3) on engine colours.
//
// mix / lighter / darker / over are the web's ui/color.ts (Qt's pixels, bit for bit) — imported, never copied.
// lighter/darker turn each 16-bit channel into 8 bits with Qt 6's qt_div_257, round to nearest (color.ts qtDiv257,
// re-exported here; PORT-QUESTIONS Q5 — Qt 5's formula before).
// color.ts works on strings and keeps alpha to 3 decimals, so the engine feeds it the opaque `#rrggbb` form and
// carries the 4-decimal alpha itself (§1): mix interpolates it (lerpAlpha, the same expression color.ts uses),
// lighter/darker keep it (QColor::lighter/darker keep alpha). Contrast, best and guard are §2/§5.
import { mix as qtMix, over as qtOver, qtDarker, qtDiv257, qtLighter } from "../ui/color";
import type { Colour } from "./literal";
import { BLACK, WHITE, hex6, isOpaque, opaque, parseLiteral } from "./literal";
import { contrastOfY, lerpAlpha, luminance, mixok } from "./maths";

function fromHex(s: string): Colour {
  const c = s.length === 7 ? parseLiteral(s) : null;
  if (!c) throw new Error(`theme engine: color.ts returned "${s}"`);
  return c;
}

/** color.ts input: `#rrggbb`, or `rgba(r, g, b, a)` with a = k/10000 (JS prints it exactly, parseColor reads it back). */
function cssOf(c: Colour): string {
  return isOpaque(c) ? hex6(c) : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

/** alpha(x, n): same colour, alpha SET to n. */
export function setAlpha(x: Colour, n: number): Colour {
  return { r: x.r, g: x.g, b: x.b, a: n };
}

/** mix(x, y, t): Kirigami linearInterpolation in 8-bit sRGB (color.ts mix), alpha lerp to 4 decimals. */
export function mixC(x: Colour, y: Colour, t: number): Colour {
  const rgb = fromHex(qtMix(hex6(x), hex6(y), t));
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: lerpAlpha(x.a, y.a, t) };
}

/** lighter(x, f): QColor::lighter(int(round(f*100))) (color.ts qtLighter), alpha kept. */
export function lighterC(x: Colour, f: number): Colour {
  const rgb = fromHex(qtLighter(hex6(x), f));
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: x.a };
}

/** darker(x, f): QColor::darker(int(round(f*100))) (color.ts qtDarker), alpha kept. */
export function darkerC(x: Colour, f: number): Colour {
  const rgb = fromHex(qtDarker(hex6(x), f));
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: x.a };
}

/** over(top, under): top composited with its alpha over under (under's alpha ignored) → opaque (color.ts over). */
export function overC(top: Colour, under: Colour): Colour {
  return fromHex(qtOver(cssOf(top), hex6(under)));
}

/**
 * cr(fg, bg): WCAG contrast. bg counts as opaque (its alpha is ignored); a translucent fg is composited over it
 * first (over), as the text would be painted.
 */
export function cr(fg: Colour, bg: Colour): number {
  const b = opaque(bg);
  const f = isOpaque(fg) ? fg : overC(fg, b);
  return contrastOfY(luminance(f), luminance(b));
}

/** best(bg, c1, c2, …): the first candidate with cr ≥ 4.5 against bg, else the first one with the highest cr. */
export function bestC(bg: Colour, cands: Colour[]): Colour {
  let pick = cands[0];
  let pickCr = -1;
  for (const c of cands) {
    const r = cr(c, bg);
    if (r >= 4.5) return c;
    if (r > pickCr) {
      pickCr = r;
      pick = c;
    }
  }
  return pick;
}

/**
 * guard(fg, bg, n) (§5): fg if cr(fg, bg) ≥ n. Otherwise T = #ffffff when Y(bg) < 0.18 else #000000;
 * c(t) = mixok(fg, T, t). If c(1) fails too, T. Else bisection lo = 0, hi = 1, exactly 24 steps of
 * mid = (lo + hi) / 2 (pass → hi = mid, fail → lo = mid); the answer is c(hi), the smallest passing t found.
 */
export function guardC(fg: Colour, bg: Colour, n: number): Colour {
  if (cr(fg, bg) >= n) return fg;
  const T = luminance(bg) < 0.18 ? WHITE : BLACK;
  if (!(cr(mixok(fg, T, 1), bg) >= n)) return T;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cr(mixok(fg, T, mid), bg) >= n) hi = mid;
    else lo = mid;
  }
  return mixok(fg, T, hi);
}

/**
 * guardAll(fg, bgs, n) (§9 amendment, 2026-09-27): like guard(), but fg must reach n against EVERY surface in bgs
 * (text sits on the window, the islands, raised panels and hovered rows — in light themes the window is the darker
 * surface, in dark themes the hover). T comes from bgs[0] (surface.island); passes(c) = every cr(c, bg) ≥ n; the
 * same 24-step bisection.
 */
export function guardAllC(fg: Colour, bgs: Colour[], n: number): Colour {
  const passes = (c: Colour) => bgs.every((bg) => cr(c, bg) >= n);
  if (passes(fg)) return fg;
  const T = luminance(bgs[0]) < 0.18 ? WHITE : BLACK;
  if (!passes(mixok(fg, T, 1))) return T;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (passes(mixok(fg, T, mid))) hi = mid;
    else lo = mid;
  }
  return mixok(fg, T, hi);
}

export { BLACK, WHITE, qtDiv257 };
