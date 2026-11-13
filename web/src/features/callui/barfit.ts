// barfit.ts — how the call bar fits a narrow call (docs/TWO-PANE.md §3; the desktop's CallBarFit.js, same rule, same
// vectors: testvectors/callbar-fit.json). Pure, so the Node unit test checks the numbers the bar uses.
//
// The bar first scales down to fit its column (down to `minScale`: 0.7 with a mouse, like 10.1 TH-CALL-05; 0.85 on a
// touch screen, so a button stays ≥ 40 px). When even that is too wide, the last buttons before Leave move into a
// "More" menu (one round button), from the right: Mute and Leave never move.
//
// Widths are MEASURED (astra review 2026-11-07: a fixed 54 px per button looped fold → unfold → fold as soon as a moved
// cell was wider, e.g. the now-playing strip): `widths` = every movable cell in row order, each as drawn the last time it
// was on screen (+ the row's spacing, + its divider when it has one; BAR_CELL when it never was), `more` = the More cell.
// The bar's natural width is rebuilt from them (fullW), the count is the fewest from the right that fit, and moving
// buttons back out needs half a More cell to spare, so a stale width can never make it loop.
//
//   fullW     the bar's natural width with nothing moved (its row + padding), in px at scale 1
//   availW    the width the bar may take (its column minus the margin)
//   widths    the movable cells' widths in row order (or `foldable` × `cell` when absent)
//   more      the More cell's width (default `cell`)
//   fold0     how many are in More now (0 = none)
export interface BarFitIn {
  fullW: number;
  availW: number;
  minScale: number;
  widths?: number[];
  more?: number;
  foldable?: number;
  cell?: number;
  fold0?: number;
}
export interface BarFitOut {
  /** how many of the foldable buttons (counted from the right) move into More; 0 = no More button */
  fold: number;
  /** the bar's scale (minScale…1) */
  scale: number;
}

export const BAR_CELL = 54; // a 50 px call button + the row's 4 px spacing
export const BAR_SEP = 5; // a divider: 1 px + the row's 4 px spacing
export const MIN_SCALE_MOUSE = 0.7;
export const MIN_SCALE_TOUCH = 0.85;

const num = (v: number) => (Number.isFinite(v) ? v : 0);

/** A call-bar item that never moves into More (the desktop's Main.qml foldKeeps, same vectors): the host's `keep` list
 *  (Mute, Leave) and every hold item (push to talk) — a menu row is one click, a hold action needs its press AND its
 *  release (security review round 4, UI-1: a folded "Push to talk (hold)" ran as a press with no release and left the
 *  mic open). Anything that isn't an item keeps its place. */
export function foldKeeps(it: { a?: unknown; hold?: unknown } | null | undefined, keep: readonly string[]): boolean {
  if (!it || typeof it !== "object") return true;
  if (it.hold === true) return true;
  return Array.isArray(keep) && keep.indexOf(it.a as string) >= 0;
}

export function barFit(i: BarFitIn): BarFitOut {
  const full = Math.max(0, num(i.fullW));
  const avail = Math.max(0, num(i.availW));
  const minScale = Math.min(1, Math.max(0.1, num(i.minScale) || MIN_SCALE_MOUSE));
  const cell = Math.max(1, num(i.cell ?? 0) || BAR_CELL);
  const widths = Array.isArray(i.widths)
    ? i.widths.map((w) => Math.max(0, num(w)))
    : new Array<number>(Math.max(0, Math.floor(num(i.foldable ?? 0)))).fill(cell);
  const more = Math.max(0, num(i.more ?? cell));
  const fold0 = Math.max(0, Math.floor(num(i.fold0 ?? 0)));
  const limit = avail / minScale;
  // the width drawn with the last k moved (+ More)
  const drawnWith = (w: number, k: number) => {
    if (k <= 0) return w;
    let cut = 0;
    for (let j = widths.length - k; j < widths.length; j++) cut += widths[j];
    return w - cut + more;
  };
  // the fewest from the right that fit at the smallest scale (all of them when none do)
  const need = (w: number) => {
    if (w <= limit + 1e-9) return 0;
    for (let k = 1; k <= widths.length; k++) if (drawnWith(w, k) <= limit + 1e-9) return k;
    return widths.length;
  };
  let fold = need(full);
  if (fold0 > 0 && fold < fold0) fold = Math.min(fold0, widths.length, need(full + more / 2));
  const drawn = drawnWith(full, fold);
  return { fold, scale: drawn <= 0 ? 1 : Math.max(minScale, Math.min(1, avail / drawn)) };
}
