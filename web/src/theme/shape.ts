// shape.ts — a theme's `shape` block (ENGINE.md §4, step 1b; ISLANDS-ARCH §3.4): the island geometry in layout px —
// corner radius, the gap between islands, the margin around them, the frame's border width. The desktop's twin is
// crates/theme/src/shape.rs (the same rules, the same test names). A theme without the block (every library theme,
// OLED and Goose) gets the defaults; a value that is not an integer inside its bounds is ignored (the default stays),
// never clamped, so a hand-edited theme cannot produce a geometry no other client would draw. Keys this reader does
// not know stay in the file (the theme document keeps them).
export interface Shape {
  radius: number;
  gap: number;
  margin: number;
  border: number;
}
export const SHAPE_DEFAULTS: Readonly<Shape> = Object.freeze({ radius: 12, gap: 6, margin: 6, border: 1 });
export const SHAPE_BOUNDS: Readonly<Record<keyof Shape, readonly [number, number]>> = Object.freeze({
  radius: [0, 24],
  gap: [0, 24],
  margin: [0, 24],
  border: [0, 2],
});
const KEYS = ["radius", "gap", "margin", "border"] as const;

export function readShape(theme: unknown): Shape {
  const out: Shape = { ...SHAPE_DEFAULTS };
  const s = theme !== null && typeof theme === "object" && !Array.isArray(theme) ? (theme as Record<string, unknown>).shape : undefined;
  if (s === null || typeof s !== "object" || Array.isArray(s)) return out;
  for (const k of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
    const v = (s as Record<string, unknown>)[k];
    const [lo, hi] = SHAPE_BOUNDS[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}
