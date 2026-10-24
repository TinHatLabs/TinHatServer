// names.ts — a person's / a room's name and avatar for widget rows: the room member when a room is known (the name
// people see in that room), else the global profile, else the localpart. Sample people and rooms (ids on the reserved
// `sample.invalid` server — the gallery's previews, the review screenshots) never touch the network: their names come
// from SAMPLE_NAMES and they have no avatar image.
import { peekClient, useMember, useRoomName, useUserProfile } from "@/core/matrix";

export const SAMPLE_SERVER = "sample.invalid";
export const isSample = (id: string | null | undefined): boolean => !!id && id.endsWith(`:${SAMPLE_SERVER}`);

/** Display names of the sample people and rooms (ids → names). */
export const SAMPLE_NAMES: Readonly<Record<string, string>> = {
  "@ana:sample.invalid": "Ana",
  "@bo:sample.invalid": "Bo",
  "@cy:sample.invalid": "Cy",
  "@dee:sample.invalid": "Dee",
  "@eli:sample.invalid": "Eli",
  "@fay:sample.invalid": "Fay",
  "@gus:sample.invalid": "Gus",
  "@hal:sample.invalid": "Hal",
  "@ivy:sample.invalid": "Ivy",
  "@jo:sample.invalid": "Jo",
  "@kit:sample.invalid": "Kit",
  "@me:sample.invalid": "You",
  "!lounge:sample.invalid": "Game lounge",
  "!squad:sample.invalid": "Squad chat",
  "!raid:sample.invalid": "Raid planning",
};

export function localpartOf(mxid: string): string {
  return mxid.replace(/^@/, "").split(":")[0] ?? mxid;
}

export function usePerson(mxid: string, roomId?: string | null): { name: string; avatar: string | null } {
  const sample = isSample(mxid);
  const none = !mxid;
  const m = useMember(sample || none ? null : roomId || null, sample || none || !roomId ? null : mxid);
  const p = useUserProfile(sample || none || roomId ? null : mxid);
  if (none) return { name: "", avatar: null };
  if (sample) return { name: SAMPLE_NAMES[mxid] ?? localpartOf(mxid), avatar: null };
  if (m) return { name: m.rawName && m.rawName !== mxid ? m.rawName : m.name || localpartOf(mxid), avatar: m.avatarMxc };
  return { name: p.displayName || localpartOf(mxid), avatar: p.avatarUrl ?? null };
}

/** Non-React: the best name we have right now (row order, summaries, tooltips). */
export function nameNow(mxid: string, roomId?: string | null): string {
  if (isSample(mxid)) return SAMPLE_NAMES[mxid] ?? localpartOf(mxid);
  const c = peekClient();
  const m = roomId ? c?.getRoom(roomId)?.getMember(mxid) : null;
  const n = m?.rawDisplayName || m?.name;
  if (n && n !== mxid) return n;
  const u = c?.getUser(mxid);
  return u?.displayName || localpartOf(mxid);
}

/** React: a room's name ("" while unknown); sample rooms from SAMPLE_NAMES. */
export function useRoomLabel(roomId: string | null | undefined): string {
  const sample = isSample(roomId);
  const n = useRoomName(sample ? null : roomId);
  return sample ? (SAMPLE_NAMES[roomId!] ?? "") : n;
}

/** Non-React: a room's name right now. */
export function roomNameNow(roomId: string): string {
  if (isSample(roomId)) return SAMPLE_NAMES[roomId] ?? "";
  return peekClient()?.getRoom(roomId)?.name ?? "";
}
