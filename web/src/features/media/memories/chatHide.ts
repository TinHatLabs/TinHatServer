// memories/chatHide.ts — 12.1.17: a Memories photo leaves the chat (docs/MEMORIES-PHOTOS.md "In the chat"). The chat
// hides an image message that its OWN SENDER's valid Memories list names (photos.ts hiddenInChat = memphotos.rs
// hidden_in_chat, shared vectors `chat_hidden`); a moderator's take-down puts it back. Fail closed: no room, a list
// that doesn't validate, an event that can't be read → shown. "Quiet" (a hidden photo, or one posted by "Add photos"
// with its marker) also skips the notification, the receive sound and the unread count.
import { useMemo } from "react";
import { NotificationCountType, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { usePowerLevels, useRoomStateEvents, peekClient } from "@/core/matrix";
import { MEMORIES_TYPE, chatCounts, chatIndex, hiddenInChat, quietInChat, type ChatIndex, type ChatMsg } from "./photos";
import { moderatorsOf } from "./photosStore";

/** A timeline event as the shared chat rules see it (its decrypted type and its original content). */
export function chatMsgOf(ev: MatrixEvent): ChatMsg {
  const content = ev.getOriginalContent() as Record<string, unknown> | undefined;
  // the relation (a thread's) rides outside the encryption: the wire copy when the cleartext lacks it (round 2)
  const rel = (ev.getWireContent() as Record<string, unknown> | undefined)?.["m.relates_to"];
  return {
    event_id: ev.getId(),
    sender: ev.getSender(),
    type: ev.getType(),
    redacted: ev.isRedacted() || !!ev.localRedactionEvent?.(),
    content: content && typeof content === "object" && !content["m.relates_to"] && rel ? { ...content, "m.relates_to": rel } : content,
  };
}

// one index per room, rebuilt when the room's lists or its power levels change (keyed by their event ids)
const cached = new WeakMap<Room, { sig: string; idx: ChatIndex }>();

/** The room's chat index from its current state (null = no room: nothing hidden). */
export function roomChatIndex(room: Room | null | undefined): ChatIndex {
  if (!room) return null;
  const evs = room.currentState.getStateEvents(MEMORIES_TYPE) as MatrixEvent[];
  const pl = room.currentState.getStateEvents("m.room.power_levels", "");
  // review: a redacted list keeps its event id (its content goes): the redaction (a pending local one too) is part of the key
  const red = (e: MatrixEvent | null | undefined) => (e?.isRedacted() ? "~r" : e?.localRedactionEvent?.() ? "~l" : "");
  const sig = `${evs.map((e) => `${e.getId() ?? ""}${red(e)}`).join(",")}|${pl?.getId() ?? ""}${red(pl)}`;
  const hit = cached.get(room);
  if (hit && hit.sig === sig) return hit.idx;
  const states = evs.map((e) => ({ state_key: e.getStateKey(), sender: e.getSender(), content: e.getContent() }));
  const idx = chatIndex(states, moderatorsOf(room, [...new Set(evs.map((e) => e.getStateKey() ?? ""))]));
  cached.set(room, { sig, idx });
  return idx;
}

/** Is this event hidden from this room's chat? */
export function hiddenEvent(room: Room | null | undefined, ev: MatrixEvent): boolean {
  return hiddenInChat(roomChatIndex(room), chatMsgOf(ev));
}

/** Quiet: no notification, no receive sound, not counted unread. */
export function quietEvent(room: Room | null | undefined, ev: MatrixEvent): boolean {
  return quietInChat(roomChatIndex(room), chatMsgOf(ev));
}

/** The room's chat index for a view: follows the room's lists and power levels. */
export function useChatIndex(roomId: string | null | undefined): ChatIndex {
  const states = useRoomStateEvents(roomId, MEMORIES_TYPE);
  const pl = usePowerLevels(roomId);
  return useMemo(() => roomChatIndex(roomId ? peekClient()?.getRoom(roomId) : null), [roomId, states, pl]);
}

/** How far back the unread correction looks (the newest events of the live timeline). Known limit: more quiet photos
 *  than that since the last read stay counted until the room is read. */
const QUIET_WINDOW = 200;

/** The quiet messages the room's counts hold: after my read receipt in the live timeline, from someone else, notifying
 *  (and highlighting) by my push rules, and UNCOUNTED by the shared rule (round 2, review #1: never a thread's message —
 *  the client runs without thread support, so thread replies sit in this timeline too). One index for the whole scan. */
export function quietUnread(c: MatrixClient | null | undefined, room: Room | null | undefined): { total: number; highlight: number } {
  const out = { total: 0, highlight: 0 };
  if (!c || !room) return out;
  const idx = roomChatIndex(room);
  const me = c.getUserId() ?? "";
  const upTo = room.getEventReadUpTo(me) ?? "";
  const evs = room.getLiveTimeline().getEvents();
  for (let i = evs.length - 1, seen = 0; i >= 0 && seen < QUIET_WINDOW; i--, seen++) {
    const ev = evs[i]!;
    if (ev.getId() === upTo) break;
    if (ev.getSender() === me || !chatCounts(idx, chatMsgOf(ev)).uncounted) continue;
    const a = c.getPushActionsForEvent(ev);
    if (a?.notify) out.total++;
    if (a?.tweaks?.highlight) out.highlight++;
  }
  return out;
}

/** A room's notification + highlight counts without its quiet messages (never below 0). */
export function countsWithoutQuiet(c: MatrixClient | null | undefined, room: Room): { total: number; highlight: number } {
  const total = room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0;
  const highlight = room.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0;
  if (total <= 0 && highlight <= 0) return { total, highlight };
  const q = quietUnread(c, room);
  return { total: Math.max(0, total - q.total), highlight: Math.max(0, highlight - q.highlight) };
}

/** A room's notification count without its quiet messages. */
export function totalWithoutQuiet(c: MatrixClient | null | undefined, room: Room): number {
  return countsWithoutQuiet(c, room).total;
}

/** A room's highlight count without its quiet messages. */
export function highlightWithoutQuiet(c: MatrixClient | null | undefined, room: Room): number {
  return countsWithoutQuiet(c, room).highlight;
}
