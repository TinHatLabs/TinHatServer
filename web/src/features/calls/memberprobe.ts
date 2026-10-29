// memberprobe.ts — the room membership of a call member this client has no member event for (guest-leave, 12.1).
//
// The roster rule (callrules.rosterCounts) counts an unknown membership, but lazy loading never brings in who LEFT:
// the sync only carries members the timeline needs and /members (loadMembersIfNeeded) excludes leaves. So a guest
// removed before this session started stayed "in the call" by their bare id until their membership expired. For such a
// caller: one read of their m.room.member state per (room, user), cached for the client's life; 404 = never a member.
// Listeners (the rosters) rebuild when an answer arrives. A later change comes through sync (the member event wins).
import { peekClient } from "@/core/matrix";

let forClient: unknown = null;
const known = new Map<string, string>();
const asked = new Set<string>();
const subs = new Set<() => void>();

/** Subscribe to answers (returns the unsubscribe). */
export function onMemberProbe(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

/** The user's membership in the room: the member event when this client has it, else a probed answer, else undefined
 *  (asked now; the rosters hear about the answer through onMemberProbe). */
export function callerMembership(roomId: string, userId: string): string | undefined {
  const c = peekClient();
  if (c !== forClient) {
    forClient = c;
    known.clear();
    asked.clear();
  }
  const room = c?.getRoom(roomId);
  const m = room?.getMember(userId);
  if (m?.membership) return m.membership;
  const k = `${roomId}|${userId}`;
  if (known.has(k)) return known.get(k);
  if (!c || !room || asked.has(k)) return undefined;
  asked.add(k);
  c.getStateEvent(roomId, "m.room.member", userId)
    .then((content) => {
      if (c !== forClient) return; // a late answer for a client that's gone never lands in the next one's cache
      const ms = (content as { membership?: unknown } | null)?.membership;
      known.set(k, typeof ms === "string" ? ms : "");
    })
    .catch((e: { httpStatus?: number; errcode?: string }) => {
      if (c !== forClient) return;
      if (e?.httpStatus === 404 || e?.errcode === "M_NOT_FOUND") known.set(k, "leave"); // never a member
      // anything else: stays unknown (counts), not asked again this session
    })
    .finally(() => {
      if (c !== forClient) return;
      for (const f of subs) f();
    });
  return undefined;
}
