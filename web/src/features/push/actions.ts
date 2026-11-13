// actions.ts — docs/NOTIF-ACTIONS.md, the page's end of a notification's buttons (core/notes.ts hands them over
// once signed in and synced, for the account they were posted for):
//   markRead(room, event)   POST /rooms/{room}/read_markers {m.fully_read, m.read | m.read.private} on the notified
//                           event through core/matrix/receipts.ts (the in-app "Mark as read" call: m.read only in a
//                           room of my own server, receiptRule.ts), only in a joined room; the window is not raised
//   compose(room)           open the room with the composer focused (browsers have no inline reply field)
import { openRoom } from "@/core/bus";
import { createLogger } from "@/core/log";
import { peekClient } from "@/core/matrix";
import { sendReadMarkers } from "@/core/matrix/receipts";
import { setNoteActions } from "@/core/notes";
import { focusComposer } from "@/features/chat";
import { eventOk } from "./notifactions";

const log = createLogger("notifactions");

export function installNoteActions(): void {
  setNoteActions({
    markRead(room, event) {
      const c = peekClient();
      if (!eventOk(event) || !c) return;
      if (c.getRoom(room)?.getMyMembership() !== "join") {
        log.info("mark as read: not a joined room — nothing sent");
        return;
      }
      // public or private: receipts.ts decides for the room (receiptRule.ts)
      sendReadMarkers(room, event).then(
        () => log.info("mark as read: markers sent"),
        (e: unknown) => log.warn(`mark as read failed: ${(e as Error)?.message ?? e}`),
      );
    },
    compose(room) {
      openRoom(room);
      // the room's view mounts a moment later: try a few times
      for (const ms of [0, 120, 350, 800]) window.setTimeout(() => focusComposer(), ms);
    },
  });
}
