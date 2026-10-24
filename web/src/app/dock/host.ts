// host.ts — the dock host's pure rules (ISLANDS-ARCH §2.1, §2.7; islands C4), shared by DockHost.tsx and mirrored by the
// desktop's DockHost.qml (the same quantization, the same episode rule, the same focus-recovery order):
//   q(v)          measured lengths → whole pixels: ceil(round(64 v) / 64) (Qt's 1/64 px text grid, then up)
//   Episode       at most three solves per episode; still moving after the third → freeze the content sizes at the
//                 component-wise maximum of the last two measurement sets, solve once more, ignore reflows until the
//                 next external trigger
//   recoverTarget focus left in an island that is no longer visible → the first visible island in the region order
// (relative imports: loaded by the Node unit tests without the "@/" alias)
import type { SolveOut } from "../../layout/solve";

export type Content = Record<string, Record<string, number | boolean>>;

/** §2.1: a measured length in whole pixels. */
export function q(v: number): number {
  return Math.ceil(Math.round(64 * (Number(v) || 0)) / 64);
}

/** The component-wise maximum of two measurement sets (numbers only; flags from the newer set win). */
export function maxOf(a: Content, b: Content | null): Content {
  const out: Content = {};
  for (const [ref, e] of Object.entries(a)) out[ref] = { ...e };
  if (!b) return out;
  for (const [ref, e] of Object.entries(b)) {
    if (!out[ref]) {
      out[ref] = { ...e };
      continue;
    }
    for (const [k, v] of Object.entries(e)) if (typeof v === "number") out[ref][k] = Math.max(Number(out[ref][k] ?? 0), v);
  }
  return out;
}

/** One stabilization episode (§2.1). `measure()` the islands, then `next(content)` → the content to solve with, or
 *  null when this report is ignored (a reflow after the freeze). */
export class Episode {
  private pass = 0;
  private m1: Content | null = null;
  private m2: Content | null = null;
  frozen: Content | null = null;
  /** an external trigger: a new episode */
  reset(): void {
    this.pass = 0;
    this.m1 = this.m2 = null;
    this.frozen = null;
  }
  /** a solve is due with this measurement set (external or reflow) */
  next(measured: Content, reflow: boolean): Content | null {
    if (this.frozen) return reflow ? null : this.frozen;
    this.m2 = this.m1;
    this.m1 = measured;
    this.pass++;
    if (this.pass > 3) {
      this.frozen = maxOf(this.m1, this.m2);
      return this.frozen;
    }
    return measured;
  }
}

/** §2.7 focus recovery: the island to move a stranded focus to, or null (the focus is fine / nothing is visible). */
/** 10.8 (ISLANDS-ARCH §2.7, the invoker first): the focused island sat in a drawer panel (z band 20) that is now closed —
 *  the host hands the focus back to the drawer's handle instead of the first visible island. The desktop's
 *  DockHost.recoverFocus() does the same (Island.inDrawer + drawerHandle). */
export function inClosedDrawer(focusedRef: string | null, out: SolveOut | null): boolean {
  if (!focusedRef || !out) return false;
  const r = out.islands[focusedRef];
  if (!r) return false;
  const z = r.z ?? 0;
  return z >= 20 && z < 30 && !(r.vis !== false && r.w > 0 && r.h > 0);
}

export function recoverTarget(focusedRef: string | null, out: SolveOut | null, order: readonly string[]): string | null {
  if (!focusedRef || !out) return null;
  const r = out.islands[focusedRef];
  if (r && r.vis !== false && r.w > 0 && r.h > 0) return null;
  for (const ref of order) {
    const c = out.islands[ref];
    if (c && c.vis !== false && c.w > 0 && c.h > 0) return ref;
  }
  return null;
}
