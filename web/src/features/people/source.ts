// source.ts — where the add-people picker's people come from (the desktop's people_ctl.rs reads the same three):
//   knownPeople()        everyone you share a joined room or DM with, from the client's own state (no network, every
//                        server); a DM = a room filed in m.direct
//   searchDirectory(t)   your server's user directory (what it makes searchable is the server's choice), 10 results
//   lookupProfile(id)    YOUR homeserver's profile look-up (it asks the other server over federation), with the
//                        status + errcode the picker's lookupOutcome turns into plain words
//   memberIds(roomId)    who is already in the room/space (joined or invited): dimmed in the picker
import { EventType, type MatrixClient } from "matrix-js-sdk";
import { errParts, peekClient } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { DIRECTORY_MAX, atrim, type DirectoryHit, type KnownPerson } from "./people";

const log = createLogger("people");

function joinedOrInvited(m: { membership?: string }): boolean {
  return m.membership === "join" || m.membership === "invite";
}

export function knownPeople(c: MatrixClient | null = peekClient()): KnownPerson[] {
  if (!c) return [];
  const me = c.getUserId() ?? "";
  const direct = (c.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>;
  const dmRooms = new Set<string>();
  for (const ids of Object.values(direct)) if (Array.isArray(ids)) for (const id of ids) dmRooms.add(id);
  const out = new Map<string, KnownPerson>();
  for (const room of c.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    const dm = dmRooms.has(room.roomId);
    for (const m of room.getMembers()) {
      if (m.userId === me || !joinedOrInvited(m)) continue;
      const name = (m.rawDisplayName && m.rawDisplayName !== m.userId ? m.rawDisplayName : "") || "";
      const avatar = m.getMxcAvatarUrl() ?? "";
      const p = out.get(m.userId);
      if (!p) out.set(m.userId, { mxid: m.userId, name, avatar, dm, shared: 1 });
      else {
        p.shared += 1;
        // a DM's name and picture win (that's how you know them); else the first one seen
        if ((dm && !p.dm) || !p.name) {
          if (name) p.name = name;
          if (avatar) p.avatar = avatar;
        }
        p.dm = p.dm || dm;
      }
    }
  }
  return [...out.values()];
}

export async function searchDirectory(term: string): Promise<DirectoryHit[]> {
  const c = peekClient();
  if (!c || !atrim(term)) return [];
  try {
    const r = await c.searchUserDirectory({ term: atrim(term), limit: DIRECTORY_MAX });
    return r.results.map((u) => ({ mxid: u.user_id, name: u.display_name ?? "", avatar: u.avatar_url ?? "" }));
  } catch (e) {
    const p = errParts(e);
    log.warn(`directory search failed: ${p.status ?? 0} ${p.errcode} ${p.message}`);
    return [];
  }
}

export interface ProfileAnswer {
  status: number;
  errcode: string;
  message: string;
  name: string;
  avatar: string;
}

export async function lookupProfile(mxid: string): Promise<ProfileAnswer> {
  const c = peekClient();
  if (!c) return { status: 0, errcode: "", message: "not signed in", name: "", avatar: "" };
  try {
    const p = (await c.getProfileInfo(mxid)) as unknown;
    // a 2xx without a profile object is no answer (never "found"); the desktop's lookup_profile does the same
    if (!p || typeof p !== "object" || Array.isArray(p)) return { status: 0, errcode: "", message: "no profile in the answer", name: "", avatar: "" };
    const o = p as { displayname?: unknown; avatar_url?: unknown };
    return { status: 200, errcode: "", message: "", name: typeof o.displayname === "string" ? o.displayname : "", avatar: typeof o.avatar_url === "string" ? o.avatar_url : "" };
  } catch (e) {
    const p = errParts(e);
    log.info(`profile look-up ${p.status ?? 0} ${p.errcode} ${p.message}`);
    return { status: p.status ?? 0, errcode: p.errcode, message: p.message, name: "", avatar: "" };
  }
}

export function memberIds(roomId: string | null | undefined, c: MatrixClient | null = peekClient()): string[] {
  const room = roomId && c ? c.getRoom(roomId) : null;
  if (!room) return [];
  return room
    .getMembers()
    .filter(joinedOrInvited)
    .map((m) => m.userId);
}
