// firstrun.ts — L4 first-run rules (Sunday QoL, TRIAGE D09.3 + A01.0/P4). SHARED LOGIC: the desktop's
// crates/app/src/first_run.rs applies the same rules; both replay testvectors/first-run.json (byte copy in
// src/features/nav/testvectors/first-run.json and the desktop's crates/app/src/testvectors/first-run.json).
//
//   dmWaitingLine   a DM whose other person hasn't accepted yet: "Waiting for Sam to join" (else "")
//   noRoomsPlan     no room open and none in the list: "No rooms yet" + New DM / New room (or the invites hint)

/** Under "Waiting for … to join" in an empty DM. */
export const DM_WAITING_EXPLAIN = "They'll see your messages once they join.";

/** `dm` = the room is a DM; `peer` = its one other person ("" = none); `membership` = theirs in the room; `name` = their
 *  display name (blank → the user id). The line only while the other person is still invited. */
export function dmWaitingLine(dm: boolean, peer: string, membership: string | null | undefined, name: string | null | undefined): string {
  if (!dm || !peer || membership !== "invite") return "";
  const n = (name ?? "").trim() || peer;
  return `Waiting for ${n} to join`;
}

/** D09.4: a DM invite's tooltip names who is really asking — the display name AND the full address (a display name
 *  alone can copy anyone's): "Sam (@sam:example.com) wants to chat — click to look". */
export function dmInviteTip(name: string, mxid: string): string {
  const n = name.trim();
  const m = mxid.trim();
  const who = m && n && n !== m ? `${n} (${m})` : n || m || "Someone";
  return `${who} wants to chat — click to look`;
}

export type NoRoomsButton = "newDm" | "newRoom";
export interface NoRoomsPlan {
  title: string;
  explanation: string;
  buttons: NoRoomsButton[];
}

/** The timeline island before any room is open, when the account has no rooms (spaces don't count): null = there are
 *  rooms (the usual "Pick a room to start"). `invites` = pending room / DM invites. */
export function noRoomsPlan(rooms: number, invites: number): NoRoomsPlan | null {
  if (rooms > 0) return null;
  if (invites > 0) return { title: "You've been invited", explanation: "Your invites are in your room list. Accept one to start chatting.", buttons: [] };
  return { title: "No rooms yet", explanation: "Start a chat with a friend, or make a room for your group.", buttons: ["newDm", "newRoom"] };
}

export const NO_ROOMS_LABEL: Readonly<Record<NoRoomsButton, string>> = { newDm: "New DM…", newRoom: "New room…" };
