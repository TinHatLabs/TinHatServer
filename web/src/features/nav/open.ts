// open.ts — openRoomId (qml/Main.qml:8157-8176), the rail following an opened room, and
// Alt+↑/↓ stepping (stepRoom, Main.qml:8182-8212).
//
// Everyone opens rooms through the bus `openRoom` (the shell turns it into the #/room route and
// persists `last-room`); the nav listens to the same event and switches the rail to the space that
// owns the room when the CURRENT list does not contain it (a DM visible in People keeps People).
import { bus, openRoom } from "@/core/bus";
import { peekClient } from "@/core/matrix";
import { selectSpace, spaceOf, useNavStore } from "./model";

let currentRoom: string | null = null;
export function setCurrentRoom(id: string | null) {
  currentRoom = id;
}
export function getCurrentRoom(): string | null {
  return currentRoom;
}

/** Called for every room that opens (bus openRoom), from anywhere. */
export function followRoom(roomId: string): void {
  if (!roomId || !roomId.startsWith("!")) return;
  const st = useNavStore.getState();
  if (!st.loaded) return;
  if (st.rooms.some((r) => r.id === roomId)) return;
  const key = spaceOf(roomId);
  if (key !== st.activeKey) selectSpace(key);
}

export function openRoomId(roomId: string): void {
  if (!roomId) return;
  openRoom(roomId);
}

let installed = false;
export function installOpenFollow(): void {
  if (installed) return;
  installed = true;
  bus.on("openRoom", ({ roomId }) => followRoom(roomId));
}

// ---- Alt+↑ / Alt+↓ ----------------------------------------------------------------------------------

let snap: { at: number; ids: string[] } | null = null;

export function stepRoom(dir: 1 | -1, unreadOnly: boolean): void {
  const st = useNavStore.getState();
  const now = Date.now();
  if (!snap || now - snap.at > 4000) {
    const src = st.rooms.length ? st.rooms : st.globalRooms;
    snap = { at: now, ids: src.filter((r) => !r.isSpace && r.membership === "join").map((r) => r.id) };
  }
  snap.at = now;
  const ids = snap.ids;
  if (!ids.length) return;
  const unreadOf = (id: string) => (st.rooms.find((r) => r.id === id) ?? st.globalRooms.find((r) => r.id === id))?.unread ?? 0;
  const cur = currentRoom ? ids.indexOf(currentRoom) : -1;
  let i = cur;
  for (let n = 0; n < ids.length; n++) {
    i = (i + dir + ids.length) % ids.length;
    if (i === cur) return;
    if (unreadOnly && unreadOf(ids[i]!) === 0) continue;
    if (peekClient()?.getRoom(ids[i]!)?.getMyMembership() !== "join") continue; // left since the snapshot
    openRoomId(ids[i]!);
    return;
  }
}

/** NAV-99: at sign-in, reopen `last-room` — retry every 0.7 s up to 8× while the list loads. */
export function restoreLastRoom(getLast: () => string, hasRoom: () => boolean): () => void {
  let tries = 0;
  const t = window.setInterval(() => {
    tries++;
    if (hasRoom() || tries > 8) {
      window.clearInterval(t);
      return;
    }
    const last = getLast();
    if (!last) {
      window.clearInterval(t);
      return;
    }
    const r = peekClient()?.getRoom(last);
    if (r && r.getMyMembership() === "join" && !r.isSpaceRoom()) {
      window.clearInterval(t);
      openRoomId(last);
    }
  }, 700);
  return () => window.clearInterval(t);
}
