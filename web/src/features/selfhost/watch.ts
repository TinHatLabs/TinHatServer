// watch.ts — "this device sent its first message" (selfhost/firstrun item 2: the notifications question waits for it).
// One listener per session, off again after the first hit; the pref is per device (localStorage), like tour_seen.
import { EventStatus, RoomEvent, type MatrixEvent } from "matrix-js-sdk";
import { peekClient } from "@/core/matrix";
import { getPref, setPref } from "@/core/prefs";

export const SENT_FIRST_PREF = "firstrun.sent";

export function watchFirstMessage(): () => void {
  if (getPref(SENT_FIRST_PREF, false)) return () => {};
  const c = peekClient();
  if (!c) return () => {};
  const me = c.getUserId();
  // a local echo of ours reaching SENT: typed and sent from this device (the clear type, also in encrypted rooms)
  const on = (ev: MatrixEvent) => {
    if (ev.status !== EventStatus.SENT || ev.getSender() !== me || ev.getType() !== "m.room.message") return;
    setPref(SENT_FIRST_PREF, true);
    c.off(RoomEvent.LocalEchoUpdated, on);
  };
  c.on(RoomEvent.LocalEchoUpdated, on);
  return () => c.off(RoomEvent.LocalEchoUpdated, on);
}
