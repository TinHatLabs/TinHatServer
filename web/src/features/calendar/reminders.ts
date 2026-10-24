// reminders.ts — calendar.rs reminder_loop (CAL-66..69) as an r.onReady background loop (only
// while a tab is open — WEB-EXCEPTIONS): first tick 25 s after start, then every 60 s, over EVERY
// joined room's calendar events. "New on the calendar", "Moved on the calendar", "Starting in N min".
// Seen keys persist (≤ 600, sorted tail) in localStorage `tinhat.calendar-seen`; gated by the
// calendar bell (pref calendar-reminders) AND the global desktop-notification switch (pref
// desktop-notifications, owned by settings). Web Notifications; click → focus tab + open the event.
import { peekClient } from "@/core/matrix";
import { getPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { toast } from "@/core/bus";
import { showNote } from "@/core/notes";
import { EVENT_TYPE, RSVP_TYPE, effectiveStart, isCanceled, relWhen } from "./model/calendar";
import { refresh } from "./calendarStore";
import { openCalendar } from "./entry";

const log = createLogger("calendar-reminders");
const SEEN_KEY = "tinhat.calendar-seen";
const NEW_EVENT_WINDOW_MS = 24 * 3600_000;
const REMIND_BEFORE_MS = 30 * 60_000;

function loadSeen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  let v = [...seen].sort();
  if (v.length > 600) v = v.slice(v.length - 600);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(v));
  } catch {
    /* quota — ignore */
  }
}

export const remindersPref = () => getPref("calendar-reminders", "1") !== "0";
export const desktopNotificationsOn = () => getPref("desktop-notifications", "1") !== "0";

/** Ask for Notification permission (from the bell toggle — a user gesture). */
export async function requestNotifyPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

function openAction(action?: string): void {
  if (!action?.startsWith("calendar:")) return;
  const rest = action.slice("calendar:".length);
  const slash = rest.lastIndexOf("/");
  // the reminder names the room the state lives in (= the calendar container)
  openCalendar({ containerId: rest.slice(0, slash), eventId: rest.slice(slash + 1) });
}

/** Phones (Android Chrome refuses `new Notification` outside a service worker; iOS Safari has no
 *  Notification outside an installed web app): the reminder shows as an in-app toast instead, with
 *  "Open" for the starting-soon one — the nearest equivalent while the app is open. */
function toastInstead(title: string, body: string, action?: string): void {
  toast(`${title} — ${body}`, { timeoutMs: 10_000, action: action ? { label: "Open", run: () => openAction(action) } : undefined });
}

function notify(title: string, body: string, action?: string): void {
  log.info(`${title}: ${body}`);
  // A5.5: whenever an OS notification can't be posted (no API, not allowed, a failure) → the in-app toast
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return toastInstead(title, body, action);
  // REACH §3.2: through core/notes — the push worker's registration when there is one (Android Chrome and
  // installed iOS web apps have no `new Notification`); a click comes back here and opens the event
  const ok = showNote({ title, body, tag: action || undefined, silent: false, onClick: action ? () => openAction(action) : undefined });
  if (!ok) {
    log.warn("notification failed");
    toastInstead(title, body, action);
  }
}

let seen: Set<string> | null = null;

export function reminderTick(now = Date.now()): void {
  const client = peekClient();
  const me = client?.getUserId() ?? "";
  if (!client || !me) return;
  seen ??= loadSeen();
  let dirty = false;
  const remind = remindersPref() && desktopNotificationsOn();
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    const events = room.currentState.getStateEvents(EVENT_TYPE);
    if (events.length === 0) continue;
    const mine = (room.currentState.getStateEvents(RSVP_TYPE, me)?.getContent() ?? {}) as Record<string, { status?: string }>;
    for (const ev of events) {
      const c = ev.getContent() as Record<string, unknown>;
      const id = ev.getStateKey() ?? "";
      const title = typeof c.title === "string" ? c.title.trim() : "";
      if (!title || isCanceled(c) || c.kind === "focus") continue;
      const start = effectiveStart(c);
      const createdBy = typeof c.createdBy === "string" ? c.createdBy : "";
      const createdAt = typeof c.createdAt === "number" ? c.createdAt : 0;
      const game = typeof c.game === "string" ? c.game : "";
      const keyNew = `new|${id}`;
      if (!seen.has(keyNew)) {
        seen.add(keyNew);
        dirty = true;
        if (remind && createdBy !== me && Math.max(now - createdAt, 0) < NEW_EVENT_WINDOW_MS && start > now) {
          notify("New on the calendar", game ? `${title} · ${game} · ${relWhen(start, now)}` : `${title} · ${relWhen(start, now)}`);
        }
      }
      const keyStart = `start|${id}|${start}`;
      if (!seen.has(keyStart)) {
        const prefix = `start|${id}|`;
        let moved = false;
        for (const k of [...seen]) {
          if (k.startsWith(prefix)) {
            moved = true;
            seen.delete(k);
          }
        }
        seen.add(keyStart);
        dirty = true;
        if (moved && remind && createdBy !== me && start > now) {
          notify("Moved on the calendar", game ? `${title} · ${game} is now ${relWhen(start, now)}` : `${title} is now ${relWhen(start, now)}`);
        }
      }
      if (start > now && start - now <= REMIND_BEFORE_MS) {
        const key = `soon|${id}|${start}`;
        if (!seen.has(key)) {
          seen.add(key);
          dirty = true;
          const status = mine?.[id]?.status ?? "";
          const going = createdBy === me || status === "yes" || status === "maybe";
          if (remind && going) {
            const mins = Math.max(Math.floor((start - now) / 60_000), 1);
            notify(`Starting in ${mins} min`, game ? `${title} · ${game}` : title, `calendar:${room.roomId}/${id}`);
          }
        }
      }
    }
  }
  if (dirty) saveSeen(seen);
  refresh();
}

let timers: Array<ReturnType<typeof setTimeout>> = [];

export function startReminders(): void {
  stopReminders();
  seen = loadSeen();
  timers.push(
    setTimeout(() => {
      reminderTick();
      timers.push(setInterval(() => reminderTick(), 60_000));
    }, 25_000),
  );
}

export function stopReminders(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}
