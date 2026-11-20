// memories/index.tsx — Memories entry points: the room-header button (RoomHeaderBar.qml:218-226,
// left of the call button) and the window registration (864×720, min 480×420, "memories").
//
// Memories opens on EVERY server (docs/MEMORIES-PHOTOS.md): on one without a call recorder (memories:false) the window
// shows photos only (photos.ts windowMode); the recording actions stay gated (core/server offer.ts).
import { useRef } from "react";
import type { Registries } from "@/core/registry";
import { useServerFeature } from "@/core/server";
import { windowMode } from "./photos";
import { HeaderIconButton } from "@/ui";
import { MemoriesWindow, memoriesTitle, openMemoriesWindow } from "./MemoriesWindow";
import type { MessageMenuCtx } from "@/core/registry";
import { peekClient } from "@/core/matrix";
import { toast } from "@/core/bus";
import { MEMORIES_WORDS, addToMemories, inMyMemories, removeFromMemories } from "./photosStore";
import { CHAT_WORDS } from "./photos";

/** The message menu's "Add to Memories" applies to MY sent image messages (docs/MEMORIES-PHOTOS.md: your own images only). */
function myImage(ctx: MessageMenuCtx): boolean {
  const ev = ctx.event;
  const id = ev.getId() ?? "";
  const me = peekClient()?.getUserId() ?? "";
  return !!id && id.startsWith("$") && ev.getSender() === me && !ev.isRedacted() && ev.getType() === "m.room.message" && ev.getContent()?.msgtype === "m.image";
}

/** Open (or raise) the Memories window for `roomId` (`open` = session id | "latest" — gate hook). */
export function openMemories(roomId: string, open?: string): void {
  if (!roomId) return;
  openMemoriesWindow(roomId, open);
}

/** Room header "Memories" button (HeaderIconButton camera-video-symbolic). */
export function MemoriesHeaderButton({ roomId }: { roomId: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const mode = windowMode(useServerFeature("memories"));
  return (
    <HeaderIconButton
      ref={ref}
      iconName="camera-video-symbolic"
      tip={mode.tip}
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
  // Memories photos: on my own image, after "Save as…" (50); removing never deletes the message. 12.1.17: adding takes
  // it out of the chat (memories/chatHide.ts), removing brings it back
  offs.push(
    r.messageMenu.add({
      id: "memories-photo",
      order: 55,
      label: (ctx) => (inMyMemories(ctx.roomId, ctx.event.getId() ?? "") ? "Remove from Memories" : "Add to Memories"),
      icon: (ctx) => (inMyMemories(ctx.roomId, ctx.event.getId() ?? "") ? "list-remove-symbolic" : "image-x-generic"),
      visible: myImage,
      run: (ctx) => {
        const id = ctx.event.getId() ?? "";
        // R3-2 (review): re-checked when it runs: a menu left open across an account switch never queues the old
        // account's photo under the new one (the photo must be the current account's own message)
        const owner = peekClient();
        if (!owner || ctx.event.getSender() !== owner.getUserId()) return;
        const on = inMyMemories(ctx.roomId, id);
        (on ? removeFromMemories(ctx.roomId, id, owner) : addToMemories(ctx.roomId, id, ctx.event.getTs(), owner)).then(
          () => {
            if (peekClient() === owner) toast(on ? CHAT_WORDS.removed_toast : CHAT_WORDS.added_toast);
          },
          (e) => {
            if ((e as Error)?.name !== "StaleSession" && peekClient() === owner) toast((e as Error)?.message || MEMORIES_WORDS.forbidden);
          },
        );
      },
    }),
  );
}
