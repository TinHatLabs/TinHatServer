// pinstate.ts — QA W1 (2026-11-07): which of a room's pins still count. The composer's 📌 N + its list (PinnedPopover)
// and the action snapshot's room.pinnedCount read the same answer: the room's pin list minus the messages known to be
// deleted (lib/pins.ts shownPins) — a loaded event that is (being) redacted, or an older pin fetched as redacted.
import { RoomEvent, type MatrixEvent } from "matrix-js-sdk";
import { onClientChanged, peekClient } from "@/core/matrix";
import { isLocallyRedacted } from "./lib/model";
import { shownPins } from "./lib/pins";

/** An older pin fetched once per session (null = it could not be read); `deleted` = it was redacted. */
export interface FetchedPin {
  event: MatrixEvent;
  deleted: boolean;
}

const fetched = new Map<string, FetchedPin>();
const listeners = new Set<() => void>();
/** targets of redactions seen live (bounded): a fetch that was in flight when its redaction arrived reads as deleted */
const redactedIds = new Set<string>();

// One client-wide watcher (not per mounted room): a redaction of an older pin counts whichever room is on screen.
// Another account (or sign-out) starts from nothing.
let watched: ReturnType<typeof peekClient> = null;
let installed = false;
const onTimeline = (ev: MatrixEvent) => noteRedaction(ev);
function watch(): void {
  const c = peekClient();
  if (c === watched) return;
  watched?.off(RoomEvent.Timeline, onTimeline as never);
  fetched.clear();
  redactedIds.clear();
  watched = c;
  c?.on(RoomEvent.Timeline, onTimeline as never);
}
function ensureWatch(): void {
  if (!installed) {
    installed = true;
    onClientChanged(watch);
  }
  watch();
}

export function fetchedPin(id: string): FetchedPin | undefined {
  return fetched.get(id);
}

/** Remember a fetched pin; a deleted one tells the readers to count again. */
export function rememberFetchedPin(id: string, event: MatrixEvent): FetchedPin {
  ensureWatch();
  const f = { event, deleted: isLocallyRedacted(event) || redactedIds.has(id) };
  fetched.set(id, f);
  if (f.deleted) for (const l of listeners) l();
  return f;
}

/** A redaction arrived (from the server: a local echo can still fail) for an older pin fetched before it was deleted,
 *  or still being fetched: it now counts as deleted. */
function noteRedaction(ev: MatrixEvent): void {
  if (!ev.isRedaction() || ev.status != null) return;
  const target = (ev.event as { redacts?: unknown }).redacts ?? (ev.getContent() as { redacts?: unknown }).redacts;
  if (typeof target !== "string") return;
  redactedIds.add(target);
  if (redactedIds.size > 500) redactedIds.delete(redactedIds.values().next().value as string);
  const f = fetched.get(target);
  if (!f || f.deleted) return;
  f.deleted = true;
  for (const l of listeners) l();
}

export function onFetchedPinDeleted(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The room's pinned ids (strings only, as stored). */
export function roomPinIds(roomId: string): string[] {
  const st = peekClient()?.getRoom(roomId)?.currentState.getStateEvents("m.room.pinned_events", "")?.getContent() as { pinned?: unknown } | undefined;
  return Array.isArray(st?.pinned) ? st.pinned.filter((x): x is string => typeof x === "string") : [];
}

/** `all` (the room's pin ids) minus the ones known to be deleted. */
export function shownPinIds(roomId: string, all: readonly string[] = roomPinIds(roomId)): string[] {
  ensureWatch();
  const room = peekClient()?.getRoom(roomId);
  const deleted = all.filter((id) => {
    const ev = room?.findEventById(id);
    return ev ? isLocallyRedacted(ev) : fetched.get(id)?.deleted === true;
  });
  return shownPins(all, deleted);
}
