// holdLatch.ts — a hold button's press and its ONE release (security review round 4, UI-1 round 2: a held push-to-talk
// button that unmounted, re-rendered, dimmed or moved mid-hold never sent its release, so the mic stayed open). The
// desktop's ActionButton.qml runs the same holdStep (between its BEGIN hold-latch pure / END hold-latch pure markers);
// both replay testvectors/hold-latch/vectors.json.
//
// holdStep(state, op): `down` starts a hold unless one is held or the button is gone; every other op ends a held hold
// exactly once: up, cancel, lostcapture (the pointer was taken away), disable (dimmed, edit mode, the item no longer a
// hold), hide, reparent, unmount (the button is gone: no new press after it). An unknown op ends it too (fail safe).
export type HoldOp = "down" | "up" | "cancel" | "lostcapture" | "disable" | "hide" | "reparent" | "unmount";
export interface HoldState {
  held: boolean;
  disposed: boolean;
}
export interface HoldStepOut {
  st: HoldState;
  emit: "down" | "up" | null;
}

export function holdStep(st: HoldState, op: string): HoldStepOut {
  const held = !!(st && st.held);
  const disposed = !!(st && st.disposed);
  if (op === "down") {
    if (held || disposed) return { st: { held, disposed }, emit: null };
    return { st: { held: true, disposed }, emit: "down" };
  }
  const gone = disposed || op === "unmount";
  if (held) return { st: { held: false, disposed: gone }, emit: "up" };
  return { st: { held: false, disposed: gone }, emit: null };
}

/** One button's latch: press(onDown, onUp) runs onDown when a hold starts and keeps onUp for its end; end(op) runs it
 *  once. The release never depends on the button still being enabled, mounted or the same element. */
export class HoldLatch {
  private st: HoldState = { held: false, disposed: false };
  private release: (() => void) | null = null;
  private owner: number | undefined;
  get held(): boolean {
    return this.st.held;
  }
  get disposed(): boolean {
    return this.st.disposed;
  }
  press(onDown: () => void, onUp: () => void, owner?: number): void {
    const r = holdStep(this.st, "down");
    this.st = r.st;
    if (r.emit !== "down") return;
    this.release = onUp;
    this.owner = owner;
    onDown();
  }
  /** end(op), only from the pointer that started the hold (a second finger on the button ends nothing) */
  endBy(owner: number, op: Exclude<HoldOp, "down">): void {
    if (this.st.held && this.owner !== undefined && owner !== this.owner) return;
    this.end(op);
  }
  end(op: Exclude<HoldOp, "down">): void {
    const r = holdStep(this.st, op);
    this.st = r.st;
    if (r.emit !== "up") return;
    const f = this.release;
    this.release = null;
    f?.();
  }
}

/** The held button's element can no longer be pressed or released by the person holding it: detached, or not rendered
 *  (display: none on it or an ancestor, visibility: hidden). */
export function holdTargetGone(el: Element): boolean {
  if (!el.isConnected) return true;
  const c = el as Element & { checkVisibility?: (o: object) => boolean };
  if (typeof c.checkVisibility === "function") return !c.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  if (el.getClientRects().length === 0) return true;
  if (typeof getComputedStyle !== "function") return false;
  const v = getComputedStyle(el).visibility;
  return v === "hidden" || v === "collapse";
}
