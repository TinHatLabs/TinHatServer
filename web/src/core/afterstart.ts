// afterstart.ts — work the first screen doesn't need (prefetching split-off chunks, warm-up probes, data only a menu or
// a window reads) waits until this page's session is up and the browser has an idle moment, so it never competes with
// the start for the network or the main thread. On a phone over a slow link that is most of the start (web-perf
// 2026-11-07: a cold start is bandwidth-bound, a warm one main-thread-bound).
//
//   afterStart(() => void import("./Heavy"));      // queued; runs once, after the first "sessionReady" + idle
//
// Each task runs in its own idle slot (no pile-up into one long task). A task queued after the start ran gets the next
// idle slot. Nothing runs before a session is ready (the sign-in screen needs none of this), nor while signed out.
import { bus } from "./bus";

const queue: Array<() => void> = [];
let open = false;
let pumping = false;

type IdleWin = { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
function idle(cb: () => void): void {
  const w = (typeof window !== "undefined" ? window : undefined) as IdleWin | undefined;
  if (w?.requestIdleCallback) w.requestIdleCallback(cb, { timeout: 2000 });
  else setTimeout(cb, 50);
}

function pump(): void {
  if (pumping || !open) return;
  const next = queue.shift();
  if (!next) return;
  pumping = true;
  idle(() => {
    pumping = false;
    if (!open) {
      queue.unshift(next); // signed out meanwhile: it waits for the next session
      return;
    }
    try {
      next();
    } catch {
      /* a warm-up task never breaks the app */
    }
    pump();
  });
}

/** Run `fn` once, after this page's first session is ready and the browser is idle. */
export function afterStart(fn: () => void): void {
  queue.push(fn);
  pump();
}

/** ms after "sessionReady" before the queue opens: the first room list / timeline paint and the trailing work of the
 *  first sync (receipts, key queries, onReady hooks) go first. */
const SETTLE_MS = 1500;
let settle: ReturnType<typeof setTimeout> | null = null;
if (typeof window !== "undefined") {
  bus.on("sessionReady", () => {
    if (open || settle) return;
    settle = setTimeout(() => {
      settle = null;
      open = true;
      pump();
    }, SETTLE_MS);
  });
  // signed out: nothing more runs (and a pending settle is dropped) until the next session is ready and settled — the
  // queue keeps what hasn't run; finished tasks never run again
  bus.on("loggedOut", () => {
    if (settle) clearTimeout(settle);
    settle = null;
    open = false;
  });
}
