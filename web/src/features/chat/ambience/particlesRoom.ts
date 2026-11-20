// particlesRoom.ts — which room the ☰ Particles ▸ rows are about (12.1.17: Chat background was hard to find on a
// phone): the open room; on a phone, where the ☰ menu sits on the room list and no room is open there, the last room
// you opened (the shell's `last-room`, the one the phone widgets follow too). The desktop layout (both apps) keeps
// "no room open = only the personal rows". Pure (no DOM, no client), for the unit tests.
export function particlesRoomFor(open: string | null | undefined, last: string, phone: boolean): string {
  if (open) return open;
  return phone && last.startsWith("!") ? last : "";
}
