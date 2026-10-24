// avatarSeed.ts — THE colour identity of an avatar (selfhost/firstrun item 6). Avatar's disc colour is a hash of its
// `seed` (Avatar.tsx avatarHue); every surface passes its seed through this one function, so one person — and one
// room — has one colour everywhere: chat, the room list, the DM strip, the room / DM header, call tiles, the quick
// switcher, floating chats, the room info panel. Before, the same person was yellow in chat (their Matrix id) and orange
// on their call tile (the LiveKit identity "@user:server:DEVICE"), and a room was one colour in the list (its name) and
// another in its header (its id).
//   a person      their Matrix id; a LiveKit identity loses its device part
//   a DM          the other person (the DM looks like that person in the list, the strip and its header)
//   a room/space  its room id — never its name (a rename must not recolour it)
// SHARED LOGIC: the desktop's Avatar call sites use the same rule (docs/DESKTOP-PENDING-selfhost-firstrun.md §6) and
// replay avatarSeed.test.ts. Pure — no imports.

/**
 * The Matrix user id inside a LiveKit participant identity: "@user:server:DEVICE" → "@user:server". A plain user id is
 * returned as it is, a port included ("@user:server:8448"): the last part is a device only when it has a letter
 * (Synapse device ids are letters; a port is digits).
 */
export function personSeed(id: string): string {
  const s = (id ?? "").trim();
  if (!s.startsWith("@")) return s;
  const first = s.indexOf(":");
  const last = s.lastIndexOf(":");
  if (first < 0 || last === first) return s;
  const tail = s.slice(last + 1);
  return /[A-Za-z]/.test(tail) && !tail.includes("]") ? s.slice(0, last) : s;
}

/** The seed of an avatar: `dmPeer` (a DM's other person) wins; a person's id loses any device part; anything else
 *  (a room or space id) is used as it is. */
export function avatarSeed(id: string | null | undefined, dmPeer?: string | null): string {
  const peer = (dmPeer ?? "").trim();
  if (peer) return personSeed(peer);
  return personSeed(id ?? "");
}
