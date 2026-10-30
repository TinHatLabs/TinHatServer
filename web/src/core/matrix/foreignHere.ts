// foreignHere.ts — the store reads behind foreign.ts's rules (rooms on another server, MATRIX-FRONTEND-DESIGN.md B0/B1):
//   managedHere(roomId)         isManaged for a room in the local store
//   originHere(roomId)          its origin, for log lines
//   childViaFor(roomId)         the `via` of every joined space's m.space.child for this room (+ those senders' servers)
//   inviterServerHere(roomId)   the server of whoever invited me
// The desktop's foreign_room.rs has the same four.
import { EventType } from "matrix-js-sdk";
import { peekClient } from "./client";
import { isManaged, roomOrigin, serverPart } from "./foreign";

/** isManaged for a room in the local store (my server = my user id's). Unknown room / no create state → false. */
export function managedHere(roomId: string): boolean {
  const c = peekClient();
  const ev = c?.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomCreate, "");
  if (!c || !ev) return false;
  return isManaged({ sender: ev.getSender(), content: ev.getContent() }, serverPart(c.getUserId()));
}

/** The origin of a room in the local store, for log lines ("another server" when unknown). */
export function originHere(roomId: string): string {
  const ev = peekClient()?.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomCreate, "");
  return (ev && roomOrigin({ sender: ev.getSender(), content: ev.getContent() })) || "another server";
}

/** Every joined space's m.space.child `via` for this room, plus those events' senders' servers (as hints). */
export function childViaFor(roomId: string): { via: string[]; senders: string[] } {
  const c = peekClient();
  const via: string[] = [];
  const senders: string[] = [];
  // a fixed order (by space id), so both apps ask the same servers first whatever order their stores keep
  const spaces = [...(c?.getRooms() ?? [])].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  for (const space of spaces) {
    if (!space.isSpaceRoom() || space.getMyMembership() !== "join") continue;
    const ev = space.currentState.getStateEvents(EventType.SpaceChild, roomId);
    const v = (ev?.getContent() as { via?: unknown } | undefined)?.via;
    if (!ev || !Array.isArray(v) || v.length === 0) continue;
    for (const s of v) if (typeof s === "string") via.push(s);
    const from = serverPart(ev.getSender());
    if (from) senders.push(from);
  }
  return { via, senders };
}

/** The server of the person who invited me to this room (my own member event's sender), or "". */
export function inviterServerHere(roomId: string): string {
  const c = peekClient();
  const me = c?.getUserId();
  const ev = me ? c?.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomMember, me) : null;
  return ev && (ev.getContent() as { membership?: string }).membership === "invite" ? serverPart(ev.getSender()) : "";
}
