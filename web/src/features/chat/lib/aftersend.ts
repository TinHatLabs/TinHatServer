// chat/lib/aftersend.ts — 2-7: what to do once a message is really sent (Memories "Add photos" adds the photo to my list),
// kept under the message's transaction id until it IS sent: a first send that fails keeps it, and the Retry or the
// automatic resend after a reconnect (L1, same transaction id) delivers it. No imports: the unit test runs it in Node.

const pending = new Map<string, (eventId: string) => void>();

/** Remember `hook` for the message sent with transaction id `txn`. */
export function keepAfterSend(txn: string, hook: (eventId: string) => void): void {
  if (txn) pending.set(txn, hook);
}

/** The message with transaction id `txn` was sent as `eventId`: run its hook once (none → nothing). */
export function deliverAfterSend(txn: string | undefined, eventId: string): void {
  if (!txn || !eventId) return;
  const h = pending.get(txn);
  if (!h) return;
  pending.delete(txn);
  h(eventId);
}

/** Send with a hook: kept until a send of that transaction succeeds (this one or a later resend). */
export async function sendWithAfterSend(txn: string, send: () => Promise<{ event_id: string }>, hook: (eventId: string) => void): Promise<void> {
  keepAfterSend(txn, hook);
  const r = await send();
  deliverAfterSend(txn, r.event_id);
}

/** Sign-out / account change: nothing carries over. */
export function clearAfterSend(): void {
  pending.clear();
}

/** How many hooks wait (tests). */
export function afterSendWaiting(): number {
  return pending.size;
}
