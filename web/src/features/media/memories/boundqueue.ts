// memories/boundqueue.ts — R3-2: one write of my Memories list per room at a time, and each queued write bound to the
// account (session) and room that queued it. A sign-out or an account switch drops whatever is still queued, and a
// write that is under way stops at its next step: account A's photo never lands in account B's Memories. No imports:
// the unit test runs it in plain Node.

/** The queued write's account is gone (signed out / switched): dropped, silently. */
export class StaleSession extends Error {
  constructor() {
    super("Signed out");
    this.name = "StaleSession";
  }
}

/** Queue `task` on `key`'s chain for `owner` (the session that queued it). It runs only while `current()` is still
 *  `owner`; `task` gets `check()` to call after each await (throws StaleSession once the session changed). */
export function queueBound<O>(chains: Map<string, Promise<void>>, key: string, owner: O | null | undefined, current: () => O | null | undefined, task: (check: () => void) => Promise<void>): Promise<void> {
  const check = () => {
    if (owner === null || owner === undefined || current() !== owner) throw new StaleSession();
  };
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => {
    check();
    return task(check);
  });
  chains.set(key, next.catch(() => {}));
  return next;
}
