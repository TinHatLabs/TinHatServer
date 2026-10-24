// colour.ts — the colour popover's maths (THEMES-UI.md §13.9): HSV ↔ RGB with the standard six-sector formula in
// doubles, channels round(x × 255) — the desktop's ColourPopover.qml does the same — and the engine's canonical text.
import { formatColour, parseLiteral, type Colour } from "@/theme/literal";
import { cssColour } from "@/ui/themeNames";

export interface Hsv {
  h: number; // 0 ≤ h < 360
  s: number; // 0..1
  v: number; // 0..1
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const ch = (t: number) => Math.min(255, Math.max(0, Math.round((t + m) * 255)));
  return [ch(r), ch(g), ch(b)];
}

/** Canonical text of rgb + alpha (0..1, kept to 2 decimals as the popover sets it). */
export function colourText(rgb: [number, number, number], alpha = 1): string {
  const k = Math.round(Math.min(1, Math.max(0, alpha)) * 100) * 100;
  const c: Colour = { r: rgb[0], g: rgb[1], b: rgb[2], a: k / 10000 };
  return formatColour(c);
}

/** A colour literal the popover can show (null for an expression it cannot). */
export function literalOf(text: string | undefined | null): Colour | null {
  return text ? parseLiteral(text) : null;
}

/** CSS of a canonical colour (inline swatches): the runtime's own conversion (themeNames.ts cssColour). */
export function cssOf(text: string): string {
  return parseLiteral(text) ? cssColour(text) : "transparent";
}
