// backStack.ts — phone sheets that close on the browser / Android back button (ARCHITECTURE "mobile":
// "back via the chevron, an edge swipe, or the browser/Android back button").
//
// One shared, ordered stack of open sheets for the whole app, mirrored into history as same-URL entries
// whose state carries `twSheetDepth: k` (the router's `thDepth` and any other keys are kept):
//   * opening a sheet pushes one entry; closing it in the UI (back chevron, Escape, programmatic) pops
//     one entry again (our own history.back(), recognised and ignored by the popstate handler);
//   * a user back leaves a state with a smaller depth → the top-most sheets close, top first. A sheet
//     can veto (return false — e.g. a dirty editor that asks "Discard?"); its entry is pushed again.
//   * the logical order is open order, with one exception: sheets that register in the same
//     synchronous run — one React commit's effects (a child's effect runs before its parent's), or
//     back-to-back commits before the event loop turns — are ordered by level — an AppWindow sheet is
//     level 0, a sheet inside it (calendar event / editor) level 1 — so back closes the inner one first.
//     A sheet opened later (the Game Reel over the calendar's event sheet, a combo / menu bottom sheet
//     over the editor) is always the top, whatever its level (it used to slide under every level-1
//     sheet, so back closed the event sheet behind the reel).
// History writes are serialised: after our own back() we wait ~150 ms before the next push/back, so an
// asynchronous pop can never land on a newer entry.
import { useEffect, useRef } from "react";

interface Reg {
  id: number;
  level: number;
  batch: number;
  onBack: () => boolean | void;
}

const stack: Reg[] = [];
let seq = 0;
// registrations in one synchronous run (one React commit's effects) share a batch number
let batch = 0;
let batchOpen = false;
let selfPops = 0;
let lastBack = 0;
let timer = 0;
let listening = false;

const depthOf = (st: unknown): number => {
  const d = (st as { twSheetDepth?: unknown } | null)?.twSheetDepth;
  return typeof d === "number" && d > 0 ? d : 0;
};

function schedule(): void {
  if (timer) return;
  timer = window.setTimeout(
    () => {
      timer = 0;
      reconcile();
    },
    Math.max(0, 150 - (Date.now() - lastBack)),
  );
}

/** Bring the history depth in line with the number of open sheets (one step at a time for backs). */
function reconcile(): void {
  const want = stack.length;
  let cur = depthOf(history.state);
  if (cur > want) {
    selfPops++;
    lastBack = Date.now();
    history.back(); // the popstate reschedules us
    return;
  }
  const base = { ...((history.state as Record<string, unknown> | null) ?? {}) };
  while (cur < want) {
    cur++;
    history.pushState({ ...base, twSheetDepth: cur }, "");
  }
}

function onPop(): void {
  if (selfPops > 0) {
    selfPops--;
    schedule();
    return;
  }
  const depth = depthOf(history.state);
  // user back (or forward): close sheets above the new depth, top first
  while (stack.length > depth) {
    const top = stack[stack.length - 1];
    if (top.onBack() === false) break;
    // the owner unmounts / unregisters; drop it now so a second pop sees the next one
    const i = stack.indexOf(top);
    if (i >= 0) stack.splice(i, 1);
  }
  schedule();
}

function register(level: number, onBack: () => boolean | void): Reg {
  if (!listening) {
    listening = true;
    window.addEventListener("popstate", onPop);
  }
  if (!batchOpen) {
    batch++;
    batchOpen = true;
    queueMicrotask(() => (batchOpen = false));
  }
  const reg: Reg = { id: ++seq, level, batch, onBack };
  let i = stack.length;
  while (i > 0 && stack[i - 1].level > level && stack[i - 1].batch === batch) i--;
  stack.splice(i, 0, reg);
  schedule();
  return reg;
}

function unregister(reg: Reg): void {
  const i = stack.indexOf(reg);
  if (i < 0) return;
  stack.splice(i, 1);
  schedule();
}

/** Levels used by the primitives: sheets/windows 0 (inner sheets 1), dialogs 5, transient popups
 *  (menus, popovers, combo sheets) 9 — so the back button always closes the top-most thing even when a
 *  dialog or menu was opened over an inner (level 1) sheet. */
export const BACK_LEVEL_DIALOG = 5;
export const BACK_LEVEL_POPUP = 9;

/** While `active`, the sheet is a level of the phone back stack: the back button calls `onBack`
 *  (return false to stay open — the entry is pushed again). */
export function useBackToClose(active: boolean, onBack: () => boolean | void, level = 0): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!active) return;
    const reg = register(level, () => cb.current());
    return () => unregister(reg);
  }, [active, level]);
}
