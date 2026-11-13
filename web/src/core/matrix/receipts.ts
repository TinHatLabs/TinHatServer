// receipts.ts — every read receipt and read marker the app sends goes through this file (the one guarded decision;
// the desktop's receipts.rs is the same). The rule is receiptRule.ts's: a public m.read only in a room of my own
// server (isManaged), anything else, an unknown create event included, m.read.private. receiptRule.ts says why, and
// why rooms on connected Tin Hat servers are private too on this branch.
//
//   publicReceiptHere(roomId)          the rule for a room in the local store
//   sendReadMarkers(roomId, eventId)   m.fully_read + the receipt, one read_markers call (Mark as read everywhere)
//   sendReadPosition(ev)               the receipt alone, unthreaded (the open room's reading position)
//
// The lint in receipts.test.ts fails on any receipt / read-marker send outside this file.
import { type MatrixEvent, Method, ReceiptType } from "matrix-js-sdk";
import { peekClient } from "./client";
import { managedHere } from "./foreignHere";
import { markersBody } from "./receiptRule";

/** The rule for a room in the local store: exactly foreignHere's managedHere (the store read the power-level guard
 *  uses; unknown room / no create state → false = private), so the two can't drift. */
export function publicReceiptHere(roomId: string): boolean {
  return managedHere(roomId);
}

/** m.fully_read + the receipt publicReceiptHere allows, on eventId: exactly markersBody's body (the vectors' and the
 *  desktop's). Posted directly rather than through setRoomReadMarkersHttpRequest, which drops m.read.private unless the
 *  server advertises Matrix v1.4 or org.matrix.msc2285.stable: a private receipt must never silently become
 *  "fully-read only" (a server that doesn't know the key still ignores it: never a public fallback). */
export async function sendReadMarkers(roomId: string, eventId: string): Promise<void> {
  const c = peekClient();
  if (!c) throw new Error("not signed in");
  const body = markersBody(eventId, publicReceiptHere(roomId));
  await c.http.authedRequest(Method.Post, `/rooms/${encodeURIComponent(roomId)}/read_markers`, undefined, body);
}

/** The receipt alone (unthreaded), public or private as publicReceiptHere says. */
export async function sendReadPosition(ev: MatrixEvent): Promise<void> {
  const c = peekClient();
  const roomId = ev.getRoomId();
  if (!c || !roomId) return;
  await c.sendReadReceipt(ev, publicReceiptHere(roomId) ? ReceiptType.Read : ReceiptType.ReadPrivate, true);
}
