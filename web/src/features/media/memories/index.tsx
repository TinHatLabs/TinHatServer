// memories/index.tsx — Memories entry points: the room-header button (RoomHeaderBar.qml:218-226,
// left of the call button) and the window registration (864×720, min 480×420, "memories").
//
// selfhost/firstrun item 1: on a server that says it has no Memories (core/server) the button draws nothing and the
// window never opens (the `memories.*` actions are hidden by the gate too).
import { useRef } from "react";
import type { Registries } from "@/core/registry";
import { serverFeatureOn, useServerFeature } from "@/core/server";
import { HeaderIconButton } from "@/ui";
import { MemoriesWindow, memoriesTitle, openMemoriesWindow } from "./MemoriesWindow";

/** Open (or raise) the Memories window for `roomId` (`open` = session id | "latest" — gate hook). */
export function openMemories(roomId: string, open?: string): void {
  if (!roomId || !serverFeatureOn("memories")) return;
  openMemoriesWindow(roomId, open);
}

/** Room header "Memories" button (HeaderIconButton camera-video-symbolic). */
export function MemoriesHeaderButton({ roomId }: { roomId: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  if (!useServerFeature("memories")) return null;
  return (
    <HeaderIconButton
      ref={ref}
      iconName="camera-video-symbolic"
      tip="Memories — relive this room's recorded calls"
      aria-label="Memories"
      disabled={!roomId}
      onClick={() => openMemories(roomId)}
    />
  );
}

export function registerMemories(r: Registries, offs: Array<() => void>): void {
  offs.push(
    r.windows.add({
      id: "memories",
      order: 0,
      title: memoriesTitle,
      icon: "camera-video-symbolic",
      component: MemoriesWindow,
      // native sizes are the CLIENT area; AppWindow sizes include its 30 px title bar
      defaultSize: { width: 864, height: 720 + 30 },
      minSize: { width: 480, height: 420 + 30 },
    }),
  );
  // chat hosts r.roomHeaderActions in native order: game reel 10, calendar 20, memories 30, call 40
  offs.push(r.roomHeaderActions.add({ id: "media-memories", order: 30, component: MemoriesHeaderButton }));
}
