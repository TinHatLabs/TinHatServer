// GuestConfirm.tsx — the confirm before Turn off / New link (Sunday QoL P10, TRIAGE A14.4/A27.0): both act on the server
// at once and can't be undone (Turn off removes the guests who are in and turns away whoever waits; New link turns away
// whoever waited with the old link), so the bar and Settings → Guests ask first and name how many people it affects
// (model.guestConfirm, shared words with the desktop's guests.rs). The desktop: HeaderIsland.qml / SettingsWindow.qml.
import { useState, type ReactNode } from "react";
import { useMembers, useRoomState, useSession } from "@/core/matrix";
import { ConfirmDialog } from "@/ui";
import { WAITING_TYPE, guestConfirm, guestsIn, parseWaiting } from "./model";
import { newGuestLink, turnGuestRoomOff, useGuests } from "./store";

/** `roomId` = the Guests room (null before it exists). `ask("off" | "link")` opens the confirm; render `dialog`. */
export function useGuestConfirm(roomId: string | null): { ask: (what: "off" | "link") => void; dialog: ReactNode } {
  const [what, setWhat] = useState<"off" | "link" | null>(null);
  const me = useSession().userId ?? "";
  const members = useMembers(roomId, "join");
  // not in the room on this device (a server admin from Settings): its members aren't known here — never "nobody"
  const joined = useRoomState(roomId, "m.room.member", me)?.membership === "join";
  const waitingState = useRoomState(roomId, WAITING_TYPE);
  const docWaiting = useGuests((st) => st.doc?.waiting.length ?? 0);
  const waiting = waitingState ? parseWaiting(waitingState).length : docWaiting;
  const words = what ? guestConfirm(what, joined ? guestsIn(members) : -1, waiting) : null;
  const dialog = (
    <ConfirmDialog
      open={!!words}
      onClose={() => setWhat(null)}
      dialogTitle={words?.title}
      message={words?.body}
      confirmText={words?.confirm}
      destructive={what === "off"}
      onConfirmed={() => void (what === "off" ? turnGuestRoomOff() : newGuestLink())}
    />
  );
  return { ask: setWhat, dialog };
}
