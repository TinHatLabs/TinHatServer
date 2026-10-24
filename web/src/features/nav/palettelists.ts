// palettelists.ts — the Ctrl+K palette's view of the room list (ACTIONS.md §4.3, §10.1): the room subjects (joined
// rooms and pending invites — spaces are not listed), the nav's room order, the pending invites newest first
// (`lists.invite`, 2026-09-28: Ctrl+K lists them again) and your JOINED DM partners as the people (decision 3,
// §15 — a pending DM invite is its invite row, never a person too: that row's Enter would start a DM beside the invite).
// Pure (type imports + dmstrip's code-point compare only), so palettelists.test.ts runs under plain Node. The desktop
// builds the same in QuickSwitcher.qml (_buildSnapshot) and orders its invites with nav.rs `palette_invite_order`
// (the same five test names as palettelists.test.ts).
import type { SubjectEntry } from "@/actions/snapshot";
import { cmpCodePoints } from "./dmstrip";
import type { RoomRow } from "./model";

/** One pending invite as Ctrl+K orders it: the room id, the room list's name for it, the invite time (ms since the
 *  epoch — our own m.room.member event; 0 = unknown). */
export interface PaletteInvite {
  id: string;
  name: string;
  at: number;
}

/** ACTIONS.md §4.3 `lists.invite`: newest first; ties by the lowercased name compared by code point, then by the id —
 *  the DM strip's rule (nav.rs `palette_invite_order`). The room ids in that order. */
export function paletteInviteOrder(invites: readonly PaletteInvite[]): string[] {
  return [...invites]
    .sort((a, b) => (b.at || 0) - (a.at || 0) || cmpCodePoints(a.name.toLowerCase(), b.name.toLowerCase()) || cmpCodePoints(a.id, b.id))
    .map((i) => i.id);
}

export interface PaletteRoomLists {
  subjects: { room: Record<string, SubjectEntry>; person: Record<string, SubjectEntry> };
  lists: { room: string[]; invite: string[]; person: string[] };
}

/** The room list's part of the palette's snapshot: every non-space row as a room subject (nav order), the pending
 *  invites newest first, your joined DM partners (the room on screen's members, PALETTE_PEOPLE "roomMembers", are the
 *  caller's). */
export function paletteRoomLists(rows: readonly RoomRow[]): PaletteRoomLists {
  const room: Record<string, SubjectEntry> = {};
  const person: Record<string, SubjectEntry> = {};
  const order: string[] = [];
  const people: string[] = [];
  const invites: PaletteInvite[] = [];
  for (const r of rows) {
    if (r.isSpace) continue;
    const invite = r.membership === "invite";
    order.push(r.id);
    room[r.id] = {
      name: r.name,
      ...(r.alias ? { alias: r.alias } : {}),
      // an invite has nothing unread to show (the room list draws its "Invited" pill, never a badge)
      values: { "room.joined": r.membership === "join", "room.invited": invite, "room.hasUnread": !invite && r.unread > 0, "room.isDm": r.dm },
    };
    if (invite) invites.push({ id: r.id, name: r.name, at: r.invitedAt ?? 0 });
    else if (r.membership === "join" && r.dm && r.peer && !person[r.peer]) {
      person[r.peer] = { name: r.name, values: {} };
      people.push(r.peer);
    }
  }
  return { subjects: { room, person }, lists: { room: order, invite: paletteInviteOrder(invites), person: people } };
}
