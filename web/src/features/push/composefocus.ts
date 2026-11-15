// composefocus.ts — Reply on a notification opens the room with the composer focused (docs/NOTIF-ACTIONS.md). The
// room's view mounts a moment later, so the focus is tried a few times; a try must never take the focus back from
// whatever the person went to meanwhile. Pure: the DOM comes in through FocusEnv (composefocus.test.ts).

export const COMPOSE_FOCUS_DELAYS: readonly number[] = [0, 120, 350, 800];
/** round 4: a thread Reply waits for the room AND its Threads panel (opening from another page loads both) */
export const THREAD_FOCUS_DELAYS: readonly number[] = [0, 120, 350, 800, 1500, 2500, 4000];

export interface FocusEnv<E> {
  /** The focused element; null or the page body when nothing is. */
  active(): E | null;
  body: E | null;
  /** Ask the room's composer for the focus. May do nothing while the view is not mounted. */
  tryFocus(): void;
  /** Run `fn` after `ms`. */
  after(ms: number, fn: () => void): void;
  /** Call `fn` on the person's next press or key; returns the unsubscribe. */
  onInput(fn: () => void): () => void;
}

/**
 * Try at each delay, until the person acts or something else holds the focus. A try is skipped while the composer it
 * reached still holds the focus (the view may yet remount, so the later ticks keep watching). Returns the cancel.
 */
export function retryComposeFocus<E>(env: FocusEnv<E>, delays: readonly number[] = COMPOSE_FOCUS_DELAYS): () => void {
  const start = env.active();
  let ours: E | null = null;
  let stopped = false;
  let left = delays.length;
  const off = env.onInput(() => stop());
  function stop(): void {
    if (stopped) return;
    stopped = true;
    off();
  }
  const empty = (a: E | null) => a === null || a === env.body;
  function tick(): void {
    if (stopped) return;
    const now = env.active();
    if (!empty(now) && now !== ours && (ours !== null || now !== start)) return stop();
    if (empty(now) || now !== ours) {
      env.tryFocus();
      const after = env.active();
      if (!empty(after) && after !== now) ours = after;
    }
    if (--left <= 0) stop();
  }
  for (const ms of delays) env.after(ms, tick);
  return stop;
}
