// threads/receipts.ts — my own read receipts per room and per thread (MSC3771), for the threads' unread dots.
// js-sdk runs with threadSupport off (see docs/THREADS.md), so its receipt store drops threaded receipts whose
// thread it doesn't track; this keeps them. Fed by every m.receipt the client sees (the cached sync replays the
// accumulated ones, unthreaded + one per thread) and by the receipts this app sends (optimistic).
// The desktop reads the same facts from matrix-sdk's store (Room::load_user_receipt per ReceiptThread).
import { RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { onClientChanged, peekClient } from "@/core/matrix";
import { myReceiptsIn } from "@/core/matrix/receipts";
import type { MyReceipt } from "./core";
import { isSynthetic } from "./rows";

/** roomId → "<thread>|<type>" (thread: "" unthreaded, "main", or a root; type: public / private kept apart — a public
 *  receipt may lag behind the private one, review #6) → the newest receipt, by its event's ts */
const store = new Map<string, Map<string, { eventId: string; ts: number }>>();
const subs = new Set<() => void>();
let version = 0;

export function receiptsVersion(): number {
  return version;
}
export function onThreadReceipts(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
function bump() {
  version++;
  for (const cb of subs) cb();
}

/** Record one receipt of mine (keeps the newest by ts per room + thread + type — "sent" = one this app just sent; `ts` = the receipted event's ts when
 *  this app sent it, the receipt's own ts when it came from the server). */
export function noteMyReceipt(roomId: string, thread: string, eventId: string, ts: number, type = "sent"): void {
  let per = store.get(roomId);
  if (!per) store.set(roomId, (per = new Map()));
  const key = `${thread}|${type}`;
  const old = per.get(key);
  if (old && (old.ts > ts || old.eventId === eventId)) return;
  per.set(key, { eventId, ts });
  bump();
}

/** All my receipts in a room, thread-tagged (core.threadUnread picks the ones that count). */
export function myReceipts(roomId: string): MyReceipt[] {
  const per = store.get(roomId);
  if (!per) return [];
  return [...per.entries()].map(([key, r]) => ({ thread: key.slice(0, key.lastIndexOf("|")), eventId: r.eventId, ts: r.ts }));
}

let attached: MatrixClient | null = null;
function onReceipt(ev: MatrixEvent, room: Room) {
  const me = attached?.getUserId();
  if (!me || !room) return;
  // js-sdk's own synthetic receipts (its local echo of a receipt, the implicit one for a sender) carry a room_id; the
  // server's (sync, and the cached sync replayed) don't. A synthetic one has no thread_id when js-sdk's thread mode is
  // off, so it would read as unthreaded and clear every thread (review #1): only the server's count.
  if (isSynthetic(ev)) return;
  for (const r of myReceiptsIn(ev.getContent(), me)) noteMyReceipt(room.roomId, r.thread, r.eventId, r.ts, r.type);
}


/** Called once at start-up (chat feature init): follows the published client, before its first sync. */
export function installThreadReceipts(): void {
  const attach = () => {
    const c = peekClient();
    if (c === attached) return;
    if (attached) attached.off(RoomEvent.Receipt, onReceipt);
    store.clear();
    attached = c;
    if (c) c.on(RoomEvent.Receipt, onReceipt);
    bump();
  };
  onClientChanged(attach);
  attach();
}
