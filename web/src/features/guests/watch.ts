// watch.ts — noticing (docs/GUESTS.md "Noticing"): when a new id appears in the Guests room's `dev.tinhat.guests.waiting`
// and this user is a member who isn't a guest, "Ana is waiting to come in as a guest" — a toast with Open, the
// notify chime, and a desktop notification (the Notifications setting; click → the Guests room) unless the Guests room
// is open in a focused window (its row is right there). Each id once per device (model.arrivals; the announced ids are
// kept in the device pref `guests.seen`, so a reload or a re-sync never repeats one); the notice closes when that guest
// leaves the list (let in or turned away — by anyone). Sync only, never a timer: the server writes the list.
import { RoomStateEvent, type MatrixEvent } from "matrix-js-sdk";
import { openRoom, toast } from "@/core/bus";
import { peekClient } from "@/core/matrix";
import { closeNotes, showNote } from "@/core/notes";
import { getPref, setPref } from "@/core/prefs";
import { onServerOffer } from "@/core/server";
import { playUiSound } from "@/core/sounds";
import { serverOf } from "@/features/nav/dmTarget";
import { getCurrentRoom } from "@/features/nav/open";
import { GUESTS_TYPE, WAITING_TYPE, arrivals, departures, isGuestAccount, isGuestsRoom, noticeText, parseGuestState, parseWaiting, type Waiter } from "./model";
import { guestRoomOffered, refreshGuests, useGuests } from "./store";

export const SEEN_PREF = "guests.seen";
const tagOf = (id: string) => `guest:${id}`;

function readSeen(): string[] {
  const v: unknown = getPref(SEEN_PREF, [] as string[]);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function announce(roomId: string, w: Waiter): void {
  const text = noticeText(w.name);
  const here = getCurrentRoom() === roomId && document.visibilityState === "visible" && document.hasFocus();
  if (!here) toast(text, { timeoutMs: 8000, action: { label: "Open", run: () => openRoom(roomId) } });
  if (!here && getPref("desktop-notifications", "1") !== "0") showNote({ title: text, tag: tagOf(w.id), room: roomId, silent: true });
  playUiSound("notify");
}

/** Start noticing for the signed-in session (r.onReady); returns the stop. */
export function watchGuests(): () => void {
  const c = peekClient();
  if (!c) return () => {};
  const me = c.getUserId() ?? "";
  let shown: string[] = [];

  const check = (roomId: string) => {
    const room = c.getRoom(roomId);
    if (!room) return;
    const st = (type: string, key = "") => room.currentState.getStateEvents(type, key)?.getContent();
    const alias = st("m.room.canonical_alias")?.alias;
    const docRoom = useGuests.getState().doc?.room ?? null;
    if (!isGuestsRoom({ roomId, docRoom, hasGuestState: !!st(GUESTS_TYPE), canonicalAlias: typeof alias === "string" ? alias : null, server: serverOf(me) })) return;
    const waiting = parseWaiting(st(WAITING_TYPE));
    // the notices of guests who left the list (let in / turned away by anyone) close
    for (const id of departures(shown, waiting)) void closeNotes(tagOf(id));
    shown = shown.filter((id) => waiting.some((w) => w.id === id));
    const on = parseGuestState(st(GUESTS_TYPE))?.on ?? useGuests.getState().doc?.on ?? false;
    const eligible = guestRoomOffered() && on && room.getMyMembership() === "join" && !isGuestAccount(me);
    const before = readSeen();
    const r = arrivals({ seen: before, waiting, now: Date.now(), eligible });
    if (r.seen.length !== before.length || r.seen.some((id, i) => id !== before[i])) setPref(SEEN_PREF, r.seen);
    for (const w of r.notify) {
      announce(roomId, w);
      shown.push(w.id);
    }
  };

  const onState = (ev: MatrixEvent) => {
    const roomId = ev.getRoomId();
    if (!roomId) return;
    const t = ev.getType();
    if (t === WAITING_TYPE) check(roomId);
    else if (t === GUESTS_TYPE) {
      void refreshGuests(); // turned on / off: the link and the roles may have changed
      check(roomId);
    } else if (t === "m.room.member" && ev.getStateKey() === me) check(roomId); // joined it just now
  };
  c.on(RoomStateEvent.Events, onState);

  const checkAll = () => {
    for (const r of c.getRooms()) if (r.currentState.getStateEvents(WAITING_TYPE, "")) check(r.roomId);
  };
  checkAll();
  // the doc names the room (or the offer switches the feature on) after the first look: look again
  const offDoc = useGuests.subscribe((n, p) => {
    if (n.doc?.room && n.doc.room !== p.doc?.room) check(n.doc.room);
  });
  const offOffer = onServerOffer(checkAll);
  return () => {
    c.off(RoomStateEvent.Events, onState);
    offDoc();
    offOffer();
    for (const id of shown) void closeNotes(tagOf(id));
  };
}
