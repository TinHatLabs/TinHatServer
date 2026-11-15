// actions.ts — docs/NOTIF-ACTIONS.md, the page's end of a notification's buttons (core/notes.ts hands them over
// once signed in and synced, for the account they were posted for):
//   markRead(room, event)   POST /rooms/{room}/read_markers {m.fully_read, m.read | m.read.private} on the notified
//                           event through core/matrix/receipts.ts (the in-app "Mark as read" call: m.read only in a
//                           room of my own server, receiptRule.ts), only in a joined room; the window is not raised
//   compose(room, event, thread)  open the room with the composer focused (browsers have no inline reply field);
//                           threads: a notified event in a thread opens that thread with ITS composer focused, so
//                           the reply goes into the thread (the desktop's inline reply: threadReplyContent)
import { bus, openRoom } from "@/core/bus";
import { threadOf } from "@/features/chat/threads/core";
import { createLogger } from "@/core/log";
import { getClientEpoch, getSession, peekClient } from "@/core/matrix";
import { sendReadMarkers } from "@/core/matrix/receipts";
import { setNoteActions } from "@/core/notes";
import { focusComposer, showsRoom } from "@/features/chat";
import { getView } from "@/features/chat/store";
import { threadOpenIn, useThreadsPanel } from "@/features/chat/threads/state";
import { parseHash } from "@/app/router";
import { holdMainFocusFor, releaseMainFocus } from "@/features/chat/threads/focusIntent";
import { badgeRoomRead } from "./client";
import { THREAD_FOCUS_DELAYS, retryComposeFocus } from "./composefocus";
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
        () => {
          log.info("mark as read: markers sent");
          badgeRoomRead(room);
        },
        (e: unknown) => log.warn(`mark as read failed: ${(e as Error)?.message ?? e}`),
      );
    },
    compose(room, event = "", thread = "") {
      // threads: the thread the notified event is in (the notification's own word, else the loaded event, else the
      // server's copy); the thread panel focuses its composer itself
      // a lookup that waits on the server: only the newest Reply, in the same session, acts (round 2 review)
      // dropped when anything moved on meanwhile: a newer Reply, any navigation, another client (sign-out / sign-in)
      const seq = ++composeSeq;
      endHold?.(); // a newer Reply: the older one's hold and focus tries end now, not after this one's lookup
      const epoch = getClientEpoch();
      const hash0 = location.hash;
      void notifiedThread(room, event, thread).then((root) => {
        if (seq !== composeSeq || getClientEpoch() !== epoch || location.hash !== hash0 || getSession().state !== "ready") return;
        if (root) composeThread(room, root);
        else composeMain(room);
      });
    },
  });
}

let composeSeq = 0;

/** threads: the thread root of a notified event ("" = main timeline / unknown). */
async function notifiedThread(room: string, event: string, thread: string): Promise<string> {
  if (eventOk(thread)) return thread;
  if (!eventOk(event)) return "";
  const c = peekClient();
  const ev = c?.getRoom(room)?.findEventById(event);
  if (ev) return threadOf(ev.getWireContent() ?? ev.getContent());
  try {
    const raw = (await c?.fetchRoomEvent(room, event)) as { content?: unknown } | undefined;
    return threadOf(raw?.content);
  } catch {
    return "";
  }
}

/** Typing or clicking ends a thread Reply's hold on the main composer (the person chose where the keyboard goes). */
function onPersonInput(fn: () => void): () => void {
  const opts = { capture: true, passive: true };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Tab") fn();
  };
  document.addEventListener("pointerdown", fn, opts);
  document.addEventListener("keydown", key, opts);
  return () => {
    document.removeEventListener("pointerdown", fn, opts);
    document.removeEventListener("keydown", key, opts);
  };
}
let endHold: (() => void) | null = null;

/** round 4 (G-threads T3): Reply on a thread's notification — the room + that thread, the keyboard in the THREAD's
 *  composer and kept there: the main composer is held (threads/focusIntent.ts) until the person clicks or tabs; the
 *  thread composer is asked a few times (the room's views mount a moment later), never over what the person chose. */
function composeThread(room: string, root: string): void {
  endHold?.();
  // review: a composer that already has the keyboard (the main one, say) gives it up — the hold only stops new focus
  const was = document.activeElement;
  if (was instanceof HTMLElement && was !== document.body) was.blur();
  holdMainFocusFor(room, root);
  const off = onPersonInput(() => stopHold());
  const timer = window.setTimeout(() => stopHold(), 60_000);
  // review: abandoned — the page went to another room (sign-out included), or the thread closed / never opened
  let seen = false;
  const offThread = useThreadsPanel.subscribe((st) => {
    if (st.open[room] === root) seen = true;
    else if (seen) stopHold();
  });
  const never = window.setTimeout(() => {
    if (!seen && threadOpenIn(room) !== root) stopHold();
  }, 5_000);
  const onHash = () => {
    const r = parseHash(location.hash);
    if (r.name !== "room" || r.target !== room) stopHold();
  };
  window.addEventListener("hashchange", onHash);
  let cancelTries = () => {};
  function stopHold(): void {
    off();
    offThread();
    cancelTries();
    window.clearTimeout(timer);
    window.clearTimeout(never);
    window.removeEventListener("hashchange", onHash);
    releaseMainFocus();
    if (endHold === stopHold) endHold = null;
  }
  endHold = stopHold;
  bus.emit("openThread", { roomId: room, eventId: root });
  cancelTries = retryComposeFocus(
    {
      active: () => document.activeElement,
      body: document.body,
      tryFocus: () => {
        if (threadOpenIn(room) === root) getView(`thread:${room}`)?.focusComposer();
      },
      after: (ms, fn) => window.setTimeout(fn, ms),
      onInput: (fn) => {
        const opts = { capture: true, passive: true };
        document.addEventListener("pointerdown", fn, opts);
        document.addEventListener("keydown", fn, opts);
        return () => {
          document.removeEventListener("pointerdown", fn, opts);
          document.removeEventListener("keydown", fn, opts);
        };
      },
    },
    THREAD_FOCUS_DELAYS,
  );
}

function composeMain(room: string): void {
  endHold?.();
  openRoom(room);
  // the room's view mounts a moment later: try a few times, never over what the person went to meanwhile
  retryComposeFocus({
    active: () => document.activeElement,
    body: document.body,
    tryFocus: () => {
      if (showsRoom(room)) focusComposer();
    },
    after: (ms, fn) => window.setTimeout(fn, ms),
    onInput: (fn) => {
      const opts = { capture: true, passive: true };
      document.addEventListener("pointerdown", fn, opts);
      document.addEventListener("keydown", fn, opts);
      return () => {
        document.removeEventListener("pointerdown", fn, opts);
        document.removeEventListener("keydown", fn, opts);
      };
    },
  });
}
