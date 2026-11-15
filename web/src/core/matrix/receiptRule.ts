// receiptRule.ts — which read receipt a room gets, pure (the desktop's receipts.rs has the same functions). Every
// receipt / read marker the app sends goes through receipts.ts, which asks this.
//
// THE RULE (fix/notif-actions-foreign-receipts, 2026-11-07): a room is "mine" only when isManaged(create, ownServer)
// holds (foreign.ts: the create sender and every v12 additional_creators entry on my own server). Mine → a public
// m.read, as always. Anything else, a missing create event (unknown) included → a private m.read.private (plus the
// m.fully_read marker wherever the public path sends one): a public receipt there would tell another server's people
// when I read.
// Fail-private on purpose: rooms on connected Tin Hat servers get private receipts too on this branch. The open-network
// work (slice 1) narrows that later with its connected-servers list; until then, never widen this check here.
//
//   receiptKey(publicOk)              "m.read" | "m.read.private"
//   publicReceiptOk(create, own)      the decision (create event or null, my server)
//   markersBody(event, publicOk)      the POST /rooms/{room}/read_markers body for one event
// Vectors: features/push/testvectors/notifactions.json `receiptRule` (byte-identical on the desktop).
import { isManaged } from "./foreign";

export type ReceiptKey = "m.read" | "m.read.private";

export function receiptKey(publicOk: boolean): ReceiptKey {
  return publicOk ? "m.read" : "m.read.private";
}

/** THE RULE: no create event known → false; else isManaged. */
export function publicReceiptOk(create: Parameters<typeof isManaged>[0], ownServer: string): boolean {
  return !!create && isManaged(create, ownServer);
}

export type MarkersBody = { "m.fully_read": string; "m.read"?: string; "m.read.private"?: string };

/** The read_markers body: m.fully_read plus the receipt key receiptKey picks (in that key order, as the vectors). */
export function markersBody(event: string, publicOk: boolean): MarkersBody {
  return { "m.fully_read": event, [receiptKey(publicOk)]: event };
}

/** threads: my receipts in one m.receipt event's content (public and private alike), each with its thread_id ("" =
 *  unthreaded). Here with the other receipt keys (receipts.ts re-exports it). */
export function myReceiptsIn(content: unknown, me: string): { thread: string; eventId: string; ts: number; type: string }[] {
  const out: { thread: string; eventId: string; ts: number; type: string }[] = [];
  if (!content || typeof content !== "object") return out;
  for (const [eventId, byType] of Object.entries(content as Record<string, unknown>)) {
    if (!byType || typeof byType !== "object") continue;
    for (const type of ["m.read", "m.read.private"]) {
      const byUser = (byType as Record<string, unknown>)[type];
      const r = byUser && typeof byUser === "object" ? (byUser as Record<string, unknown>)[me] : undefined;
      if (!r || typeof r !== "object") continue;
      const rr = r as { ts?: unknown; thread_id?: unknown };
      out.push({ eventId, ts: typeof rr.ts === "number" ? rr.ts : 0, thread: typeof rr.thread_id === "string" ? rr.thread_id : "", type });
    }
  }
  return out;
}
