// notifypick.ts — which event a room's message notification is about, and the order its posts may land in
// (fix1216 6-9, 6-3). Pure: no SDK, no DOM; notify.ts hands it the timeline and its push-rule check.
import { threadOf } from "../chat/threads/core";

export interface EvLike {
  getSender(): string | null | undefined;
  getType(): string;
  getContent(): any;
  getWireContent?(): any;
  getId(): string | null | undefined;
}

export interface Notified {
  sender: string;
  /** the body trimmed; "" when it has none (still encrypted) or only whitespace: the generic wording then */
  text: string;
  eventId: string;
  thread: string;
}

const MESSAGE_TYPES = new Set(["m.room.message", "m.sticker", "m.room.encrypted"]);
const WINDOW = 30;

function info(ev: EvLike): Notified {
  const body = ev.getContent()?.body;
  return {
    sender: ev.getSender() ?? "",
    text: typeof body === "string" ? body.trim() : "",
    eventId: ev.getId() ?? "",
    thread: threadOf(ev.getWireContent?.() ?? ev.getContent()),
  };
}

/** The event a room's notification is about: the newest NOTIFYING message among the last 30 events (its event,
 *  sender and thread are kept even when its text is blank — 6-9: Mark as read and Reply need them, as on the
 *  desktop), else the newest message with text. null = nothing to show. */
export function pickNotified(evs: readonly EvLike[], notifies: (e: EvLike) => boolean): Notified | null {
  const recent = evs.slice(-WINDOW);
  const notifying = recent.filter(notifies);
  const pick = notifying.length ? notifying[notifying.length - 1] : null;
  if (pick) return MESSAGE_TYPES.has(pick.getType()) ? info(pick) : null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const ev = recent[i]!;
    if (!MESSAGE_TYPES.has(ev.getType())) continue;
    const body = ev.getContent()?.body;
    if (typeof body === "string" && body.trim()) return info(ev);
  }
  return null;
}

// 6-3: a room's notifications post in the order they were planned. A post waits for its sender's picture; a later
// post of the same room may be ready first, and the older one must not land over it (same tag = it replaces).
const tickets = new Map<string, number>();

/** Take the next post ticket for a room (when the post is planned, before any wait). */
export function postTicket(room: string): number {
  const n = (tickets.get(room) ?? 0) + 1;
  tickets.set(room, n);
  return n;
}

/** Is this still the room's newest planned post? (checked right before posting) */
export function isNewestPost(room: string, ticket: number): boolean {
  return tickets.get(room) === ticket;
}

/** Forget every room's tickets (the engine stopped). */
export function forgetPosts(): void {
  tickets.clear();
}
