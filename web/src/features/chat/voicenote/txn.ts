// txn.ts — voice notes: ONE transaction id per draft, whatever happened to its local echo (docs/VOICE-NOTES.md §2
// "retry … the same transaction id"). The server de-duplicates by (device, txn id), so a send whose answer was lost
// can never post twice — as long as no attempt ever uses another id.
//
// js-sdk keeps a txn id → local echo mapping for good, also after the echo was CANCELLED (the timeline row's Delete, or
// a rebuild of the echo with new content), and then refuses the id ("addPendingEvent … known txnId"). That stale
// mapping is reconciled here, separately — the id itself never changes. Pure apart from js-sdk (txn.test.ts runs it on
// a real Room).
import { EventStatus, type MatrixEvent, type Room } from "matrix-js-sdk";

export type TxnPlan =
  /** this transaction already went through (its answer was lost, or the /sync echo came first) */
  | { kind: "done"; eventId: string }
  /** the failed local echo carries the right content: resend it as it is (same txn id) */
  | { kind: "resend"; event: MatrixEvent }
  /** send fresh with the same txn id (no echo, or a stale one reconciled) */
  | { kind: "send" };

/** Drop js-sdk's mapping of `txnId` when (and only when) it points at a CANCELLED echo. */
export function forgetCancelledTxn(room: Room, txnId: string): boolean {
  const map = (room as unknown as { txnToEvent?: Map<string, MatrixEvent> }).txnToEvent;
  const ev = map?.get(txnId);
  if (!map || !ev || ev.status !== EventStatus.CANCELLED) return false;
  map.delete(txnId);
  return true;
}

/** How to send attempt N of a draft. `rebuild` = the content changed since the last attempt (re-uploaded encrypted):
 *  a failed echo with the old content is cancelled and replaced (also when its media simply differs from `content`).
 *  `cancel` = client.cancelPendingEvent. */
/** The media reference of a voice note's content: the mxc of `url`, or of `file` (encrypted). */
export function mediaRef(c: Record<string, unknown> | null | undefined): string {
  const f = c?.file as { url?: unknown } | undefined;
  return f && typeof f.url === "string" ? `file:${f.url}` : typeof c?.url === "string" ? `url:${c.url}` : "";
}

export function planTxn(room: Room, txnId: string, rebuild: boolean, cancel: (ev: MatrixEvent) => void, content?: Record<string, unknown>): TxnPlan {
  const prev = room.getEventForTxnId(txnId);
  if (!prev) return { kind: "send" };
  const st = prev.status;
  if (st === null || st === EventStatus.SENT) {
    const id = prev.getId();
    if (id && !id.startsWith("~")) return { kind: "done", eventId: id };
  }
  // validated on every attempt: a failed echo whose media differs from what this attempt sends (a plaintext url while
  // the note now carries an encrypted file) is never resent as it is, whatever the caller's flag says
  const stale = !!content && mediaRef(prev.getContent()) !== mediaRef(content);
  if (st === EventStatus.NOT_SENT && !rebuild && !stale) return { kind: "resend", event: prev };
  if (st === EventStatus.NOT_SENT || st === EventStatus.QUEUED) cancel(prev);
  else if (st === EventStatus.SENDING || st === EventStatus.ENCRYPTING) throw new Error("this voice message is still being sent");
  forgetCancelledTxn(room, txnId);
  if (room.getEventForTxnId(txnId)) throw new Error("the previous attempt of this voice message is still pending");
  return { kind: "send" };
}

/** Delete of a draft: its failed (NOT_SENT / queued) local echo goes from the timeline too. */
export function cancelTxnEcho(room: Room, txnId: string, cancel: (ev: MatrixEvent) => void): boolean {
  const ev = room.getEventForTxnId(txnId);
  if (!ev || (ev.status !== EventStatus.NOT_SENT && ev.status !== EventStatus.QUEUED)) return false;
  cancel(ev);
  forgetCancelledTxn(room, txnId);
  return true;
}
