// poll.ts — one shared interval per key, however many surfaces want it (reference-counted): the wallet refresh runs
// once a minute per wallet even when the call bar, the phone strip and the game panel all ask for it.
export interface Timers {
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}
const polls = new Map<string, { n: number; id: number }>();

/** Start (or join) the shared poll for `key`; the returned release stops it when the last holder lets go. */
export function acquirePoll(key: string, tick: () => void, ms: number, timers: Timers = globalThis as unknown as Timers): () => void {
  let p = polls.get(key);
  if (!p) {
    p = { n: 0, id: timers.setInterval(tick, ms) };
    polls.set(key, p);
  }
  p.n++;
  let released = false;
  return () => {
    if (released) return; // a double release must not take another holder's share
    released = true;
    const q = polls.get(key);
    if (!q) return;
    if (--q.n <= 0) {
      timers.clearInterval(q.id);
      polls.delete(key);
    }
  };
}
