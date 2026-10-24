// fold.ts — the widget stack's fold rule in the dock host's widgets island (islands C6/C7; the desktop's WidgetHost.qml
// `folded` / `_total`, the same numbers): the island's natural height is the stack with every widget OPEN, the least it
// can take is every widget folded to its header; the island's height comes back as the stack's max height and widgets
// fold bottom-up until the stack fits. Pure (relative imports only: the Node unit tests load it).
//
// A widget counts at the height it last had OPEN — never at the height it shows while folded (the header only): a stack
// sitting exactly at its limit would otherwise fold, measure smaller, unfold, measure larger … forever (the desktop's
// 64470a9c found it as a starved GUI thread). The rule reads those remembered heights only, so folding never changes
// its own input; sub-pixel sums get a 0.5 px tolerance.

/** A folded widget: 1 + 30 + 1. */
export const FOLDED_H = 32;
/** The stack's gap between widgets. */
export const STACK_GAP = 6;
/** "+ Add widget": 22 px, 4 px under the last widget (the stack's gap − 2). */
export const ADD_ROW = 22 + 4;

export interface FoldItem {
  w: string;
  /** its height open (remembered while it was open); a user-collapsed or Small widget = FOLDED_H */
  openH: number;
  /** may auto-fold (open, not Small, not the one the user just opened) */
  foldable: boolean;
}

/** The stack's height with every widget at `openH` (fold = false) or at its header (fold = true). */
export function stackTotal(items: readonly FoldItem[], fold: boolean): number {
  let t = ADD_ROW;
  items.forEach((it, i) => (t += (fold ? FOLDED_H : Math.max(FOLDED_H, it.openH)) + (i > 0 ? STACK_GAP : 0)));
  return t;
}

/** The widgets that fold so the stack fits `maxH`: bottom-up, skipping those that can't. */
export function foldToFit(items: readonly FoldItem[], maxH: number): Set<string> {
  const out = new Set<string>();
  let total = stackTotal(items, false);
  for (let j = items.length - 1; j >= 0 && total > maxH + 0.5; j--) {
    const it = items[j]!;
    const saving = Math.max(FOLDED_H, it.openH) - FOLDED_H;
    if (!it.foldable || saving <= 0) continue;
    out.add(it.w);
    total -= saving;
  }
  return out;
}
