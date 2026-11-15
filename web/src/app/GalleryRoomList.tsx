// GalleryRoomList.tsx — #/__gallery/roomlist (dev, no account): the real room list (RoomPanel) over fixture rows, for
// the room filter's browser check (tools/room-filter-e2e.mjs, QOL L3 2026-11-14): typing never opens a room, the first
// match is highlighted, Enter acts on it, accents / handles / is:unread match, "Search everywhere" on no match. Every
// room the list asks to open is recorded in [data-opened] (the bus's openRoom; nothing is marked read here).
import { useEffect, useState } from "react";
import { bus } from "@/core/bus";
import { RoomPanel } from "@/features/nav/RoomList";
import { useNavStore, type RoomRow } from "@/features/nav/model";

const row = (id: string, name: string, extra: Partial<RoomRow> = {}): RoomRow => ({
  id, name, avatar: "", unread: 0, highlight: false, rawUnread: 0, dm: false, favourite: false, call: false, membership: "join",
  notifyMode: "all", muted: false, participants: [], activity: null, statuses: [], alias: "", publicJoin: false, isSpace: false,
  recency: null, peer: "", ...extra,
});

export const GALLERY_ROOMS: RoomRow[] = [
  row("!invite:example.org", "General chatter", { membership: "invite" }),
  row("!general:example.org", "General", { alias: "#general:example.org" }),
  row("!cafe:example.org", "Café Crème", { membership: "none", alias: "#cafe:example.org" }),
  row("!valheim:example.org", "valheim-mods", { unread: 3, rawUnread: 3 }),
  row("!night:example.org", "Game night", { unread: 1, rawUnread: 1, highlight: true }),
];

export function GalleryRoomList() {
  const [opened, setOpened] = useState<string[]>([]);
  useEffect(() => {
    useNavStore.setState({ rooms: GALLERY_ROOMS, globalRooms: GALLERY_ROOMS, activeKey: "home", activeLabel: "Home", loaded: true });
    const off = bus.on("openRoom", ({ roomId }) => setOpened((o) => [...o, roomId]));
    return () => {
      off?.();
    };
  }, []);
  return (
    <div style={{ display: "flex", gap: 16, height: "100vh" }}>
      <div style={{ width: 300, height: 640, position: "relative", display: "flex", flexDirection: "column" }}>
        <RoomPanel currentRoomId={null} active island />
      </div>
      <pre data-opened="">{opened.join("\n")}</pre>
    </div>
  );
}
