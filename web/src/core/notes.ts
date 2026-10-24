// notes.ts — REACH §3.2 + A2.9: ONE way to post a system notification from the page, and the page's end of
// the push worker's clicks.
//
//   showNote({title, body, tag, room?, onClick?, timeoutMs?})   → true when posted
//   closeNotes(tag)                                             close every shown note with that tag
//   closeAllNotes()                                             sign-out (A2.9)
//   setNoteRegistration(reg)                                    features/push hands over the worker
//
// With the push worker's registration the note goes through registration.showNotification — Android Chrome
// refuses `new Notification`, and an installed iOS web app has only this path; clicks then arrive as the
// worker's postMessage ({type: "tinhat-open-room", room} opens the room; "tinhat-note-click" runs the page's
// own handler). Without a registration (no push support) it is the classic `new Notification`.
// A `tinhat-open-room` that arrives before the app is signed in and synced waits for sessionReady (A2.9).
import { bus, openRoom } from "@/core/bus";
import { getSession } from "@/core/matrix/session";
import { createLogger } from "@/core/log";

const log = createLogger("notes");

let reg: ServiceWorkerRegistration | null = null;
let pushHere: () => boolean = () => false;

export function setNoteRegistration(r: ServiceWorkerRegistration | null): void {
  reg = r;
}

/** features/push: is web push on (and confirmed) for THIS device? (A5.4: then a hidden page leaves messages to the
 *  push; a visible one reports its own foreground so the gateway holds this device's pushes — A6) */
export function setPushActiveHere(fn: () => boolean): void {
  pushHere = fn;
}

/** A5.4: a message-type note (a room message, an invite) is the push's job while the page is hidden and push
 *  is on here — the page posting it too made two alerts for one message. */
export function pushCoversNow(): boolean {
  return typeof document !== "undefined" && document.visibilityState !== "visible" && pushHere();
}

export function noteRegistration(): ServiceWorkerRegistration | null {
  return reg;
}

export interface Note {
  title: string;
  body?: string;
  /** an http(s) URL; a page blob: URL is dropped on the worker path (the notification service can't read it) */
  icon?: string;
  tag?: string;
  /** our sounds are our own (snd.*) — default true */
  silent?: boolean;
  requireInteraction?: boolean;
  /** close again after this many ms */
  timeoutMs?: number;
  /** the room it is about: a click opens it */
  room?: string;
  /** anything else a click should do (runs in this page) */
  onClick?: () => void;
  /** a message / invite the gateway also pushes: skipped while pushCoversNow() (A5.4) */
  pushCovered?: boolean;
}

const appIcon = () => `${import.meta.env.BASE_URL}appicon/tinhat-192.png`;
const clicks = new Map<string, () => void>();
let seq = 0;

/** Post one notification. Never throws; false when the browser can't / won't. */
export function showNote(n: Note): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  if (n.pushCovered && pushCoversNow()) return true; // the push posts this one
  const r = reg;
  if (r) {
    const id = `n${Date.now().toString(36)}-${++seq}`;
    if (n.onClick) {
      clicks.set(id, n.onClick);
      while (clicks.size > 50) clicks.delete(clicks.keys().next().value!);
    }
    const icon = n.icon && !n.icon.startsWith("blob:") ? n.icon : appIcon();
    const opts: NotificationOptions & { renotify?: boolean } = {
      body: n.body,
      icon,
      badge: appIcon(),
      tag: n.tag,
      silent: n.silent ?? true,
      requireInteraction: n.requireInteraction,
      data: { room: n.room ?? "", note: n.onClick ? id : "", user: getSession().userId ?? "" },
    };
    r.showNotification(n.title, opts).then(
      () => {
        if (n.timeoutMs && n.tag) window.setTimeout(() => void closeNotes(n.tag!, id), n.timeoutMs);
      },
      (e: unknown) => log.debug(`showNotification: ${(e as Error)?.message ?? e}`),
    );
    return true;
  }
  try {
    const note = new Notification(n.title, {
      body: n.body,
      icon: n.icon || appIcon(),
      tag: n.tag,
      silent: n.silent ?? true,
      requireInteraction: n.requireInteraction,
    });
    note.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      if (n.room) openRoom(n.room);
      n.onClick?.();
      note.close();
    };
    if (n.timeoutMs) window.setTimeout(() => note.close(), n.timeoutMs);
    if (n.tag) classic.set(n.tag, note);
    return true;
  } catch (e) {
    log.debug(`Notification failed: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

const classic = new Map<string, Notification>();

/** Close the notes with this tag (only the one with `noteId` when given — a newer note under the tag stays). */
export async function closeNotes(tag: string, noteId?: string): Promise<void> {
  const c = classic.get(tag);
  if (c && !noteId) {
    classic.delete(tag);
    try {
      c.close();
    } catch {
      /* gone */
    }
  }
  if (!reg) return;
  try {
    for (const n of await reg.getNotifications({ tag })) {
      if (noteId && (n.data as { note?: string } | null)?.note !== noteId) continue;
      n.close();
    }
  } catch {
    /* ignore */
  }
}

/** A2.9 sign-out: every note this origin still shows goes. */
export async function closeAllNotes(): Promise<void> {
  for (const n of classic.values()) {
    try {
      n.close();
    } catch {
      /* gone */
    }
  }
  classic.clear();
  clicks.clear();
  if (!reg) return;
  try {
    for (const n of await reg.getNotifications()) n.close();
  } catch {
    /* ignore */
  }
}

// ---- the worker's clicks ---------------------------------------------------------------------------------------

let pendingRoom: { room: string; user: string } | null = null;

function openWhenReady(room: string, user: string): void {
  const s = getSession();
  if (s.state === "ready" && s.userId) {
    if (user && user !== s.userId) {
      log.info("a notification of another account was clicked — not opening it here");
      return;
    }
    openRoom(room);
    return;
  }
  pendingRoom = { room, user }; // A2.9: until signed in and synced
}

bus.on("sessionReady", ({ userId }) => {
  const p = pendingRoom;
  pendingRoom = null;
  if (p && (!p.user || p.user === userId)) openRoom(p.room);
});
bus.on("loggedOut", () => {
  pendingRoom = null;
});

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: unknown; room?: unknown; note?: unknown; user?: unknown } | null;
    if (!d || typeof d !== "object") return;
    const user = typeof d.user === "string" ? d.user : "";
    if (d.type === "tinhat-open-room" && typeof d.room === "string" && d.room.startsWith("!")) openWhenReady(d.room, user);
    else if (d.type === "tinhat-note-click" && typeof d.note === "string") {
      const run = clicks.get(d.note);
      clicks.delete(d.note);
      if (run) run();
      else if (typeof d.room === "string" && d.room.startsWith("!")) openWhenReady(d.room, user);
    }
  });
}
