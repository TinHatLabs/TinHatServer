// memories/inflight.ts — one shared read per key while it runs (photosStore): a second caller joins the read in
// flight, and the entry goes when the read settles — also when the read finished at once (the loaded timeline already
// held the event, so the read had nothing to wait for). Registering a read only after starting it left a finished
// read's entry behind for good, and every later read of that photo joined it and fetched nothing (lab interop
// 2026-11-14). No imports: the unit test runs it in plain Node.

/** The read in flight for `key`, or `start()` begun now (after the entry is in `map`). */
export function joinOrStart<T>(map: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const cur = map.get(key);
  if (cur) return cur;
  const p: Promise<T> = Promise.resolve()
    .then(start)
    .finally(() => {
      if (map.get(key) === p) map.delete(key);
    });
  map.set(key, p);
  return p;
}
