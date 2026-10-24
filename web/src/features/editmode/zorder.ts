// zorder.ts — edit mode's stacking rules (EDITMODE-UI §2, §20; the desktop's Island.qml + EditLayer.qml use the same
// numbers). Pure (relative imports: loaded by the Node unit tests).
//
// The dock host paints each island as ONE piece at the solver's z (docked 0 · overlaid panel 2 · floats 10-19 · drawer
// panels 20): its fill, its content, the PLACEHOLDER of absent content (edit mode only) and its frame line
// (app/dock/frame.ts FRAME_LAYERS) — so a floating island covers an absent island's placeholder the way it covers
// content. The edit layer sits above every island (LAYER_Z) and paints each island's chrome (veil, outline, chip, ⋯) at
// 1 + the island's z — a float's chrome above the docked ones' —, a stack's tab chips at 2 + its z, the gap handles at 2,
// then the hovered drop zone, the landing preview and the drag ghost above every band. Equal z-indices paint in DOM order.
// (Before 11.0's fix the edit layer drew the placeholders itself, in region order: the account card floated over the
// Room info placeholder vanished under it, chip and ⋯ included.)
import type { SolveOut } from "../../layout/solve";
import { REGION_ORDER } from "../../layout/schema";

/** The edit layer: above every island band (floats 10-19, drawer panels 20). */
export const LAYER_Z = 30;
/** An island's chrome — veil, outline, handle chip, ⋯ — stacked like the island itself. */
export const chromeZ = (islandZ: number | undefined): number => 1 + (islandZ ?? 0);
/** A stack's tab chips: above its islands' chrome. */
export const tabChipsZ = (stackZ: number | undefined): number => 2 + (stackZ ?? 0);
/** The gap handles: above the docked islands' chrome, under a float's. */
export const GAP_Z = 2;
/** A move in progress: the hovered zone, the landing preview and the ghost, above every island's chrome. */
export const ZONE_Z = 50;
export const PREVIEW_Z = 51;
export const GHOST_Z = 52;

/** The islands that get chrome — visible, under the layer's band — in the region order (the Tab order), then the rest
 *  (your own button islands) in ref order. This is also the layer's DOM order of the chrome. */
export function chromeRefs(out: SolveOut): string[] {
  const vis = Object.entries(out.islands)
    .filter(([, r]) => r.vis !== false && r.w > 0 && r.h > 0 && (r.z ?? 0) < LAYER_Z)
    .map(([ref]) => ref);
  const known = REGION_ORDER.filter((r) => vis.includes(r));
  const rest = vis.filter((r) => !REGION_ORDER.includes(r)).sort();
  return [...known, ...rest];
}
