// badgesync.ts — the page's half of the hidden-page badge (docs/NOTIFICATIONS.md, A5.10). Pure: the worker and the
// Cache Storage write come in as arguments (badgesync.test.ts).

/** The rooms in `prev` that are no longer in `ids`. */
export function roomsRead(prev: readonly string[], ids: readonly string[]): string[] {
  const now = new Set(ids);
  return prev.filter((r) => !now.has(r));
}

export interface BadgeWorker {
  postMessage(m: unknown): void;
}

/** After the unread set is written (the worker counts from it), tell the worker; with no worker, nothing was pushed
 *  and the page's own count is the whole count. Never rejects. */
export async function syncHidden(read: string[], written: Promise<unknown>, worker: () => Promise<BadgeWorker | null | undefined>, alone: () => void): Promise<void> {
  try {
    await written;
    const w = await worker();
    if (w) w.postMessage({ type: "tinhat-badge-sync", read });
    else alone();
  } catch {
    /* the badge never breaks anything */
  }
}
