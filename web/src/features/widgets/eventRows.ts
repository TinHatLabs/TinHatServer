// eventRows.ts — widgets W1: a message as the timeline holds it, for a widget row (Pinned, Mentions; contract WIDGETS.md
// §11–§12): the loaded timeline's own MatrixEvent when it is there (decrypted with it), else fetched once and decrypted
// the way the chat's pinned popover does (PinnedPopover.tsx loadPin: fetchRoomEvent + decryptEventIfNeeded), cached per
// event for the session in memory only (never stored). The row's snippet comes from the shared rule
// (src/widgets/recent.ts snippetOf): an event that could not be decrypted reads "Encrypted message", a redacted one
// "Message deleted". An event that can't be fetched (gone, no access) resolves to null — the widget leaves it out.
import { useEffect, useMemo, useState } from "react";
import { ClientEvent, MatrixEvent, MatrixEventEvent, RoomEvent, type MatrixClient } from "matrix-js-sdk";
import { onClientChanged, peekClient } from "@/core/matrix";
import { snippetOf, type SnippetKind } from "@/widgets/recent";

export interface EventRef {
  room: string;
  id: string;
}

export interface EventRow {
  room: string;
  id: string;
  sender: string;
  ts: number;
  kind: SnippetKind;
  text: string;
}

const key = (r: EventRef) => `${r.room}\u0000${r.id}`;
/** room \0 event id → the fetched event's row (null = could not be fetched) */
const fetched = new Map<string, EventRow | null>();
const inflight = new Map<string, Promise<void>>();
onClientChanged(() => {
  fetched.clear();
  inflight.clear();
});

/** An event as the timeline shows it → the shared snippet input: a decryption failure / not yet decrypted stays
 *  `m.room.encrypted` (js-sdk shows a failed event as an m.bad.encrypted message — the rule reads it as encrypted). */
export function snippetInput(ev: MatrixEvent): { type: string; content: unknown; redacted: boolean } {
  const undecrypted = ev.isDecryptionFailure() || (ev.getWireType() === "m.room.encrypted" && ev.getClearContent() === null);
  return { type: undecrypted ? "m.room.encrypted" : ev.getType(), content: ev.getContent(), redacted: ev.isRedacted() };
}

export function rowOf(room: string, id: string, ev: MatrixEvent): EventRow {
  const sn = snippetOf(snippetInput(ev));
  return { room, id, sender: ev.getSender() ?? "", ts: ev.getTs(), kind: sn.kind, text: sn.text };
}

async function fetchRow(c: MatrixClient, r: EventRef): Promise<void> {
  try {
    const raw = await c.fetchRoomEvent(r.room, r.id);
    const ev = new MatrixEvent(raw);
    if (ev.isEncrypted()) await c.decryptEventIfNeeded(ev).catch(() => {});
    fetched.set(key(r), rowOf(r.room, r.id, ev));
  } catch {
    fetched.set(key(r), null);
  }
}

/**
 * The rows of `refs` (key "room\0id" → row, or null when the event can't be fetched; absent while it is being fetched)
 * and whether some are still loading. Re-renders when one of them is decrypted, redacted, arrives in a live timeline or
 * is fetched.
 */
export function useEventRows(refs: readonly EventRef[]): { rows: ReadonlyMap<string, EventRow | null>; loading: boolean } {
  const sig = refs.map(key).join("\u0001");
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const c = peekClient();
    if (!c || !refs.length) return;
    let alive = true;
    const bump = () => alive && setRev((x) => x + 1);
    const mine = new Set(refs.map(key));
    const onEvent = (ev: MatrixEvent) => {
      if (mine.has(`${ev.getRoomId()}\u0000${ev.getId()}`)) bump();
    };
    const onRedaction = (ev: MatrixEvent) => {
      if (mine.has(`${ev.getRoomId()}\u0000${ev.getAssociatedId()}`)) bump();
    };
    c.on(MatrixEventEvent.Decrypted, onEvent);
    c.on(RoomEvent.Timeline, onEvent);
    c.on(RoomEvent.Redaction, onRedaction);
    c.on(ClientEvent.Room, bump);
    for (const r of refs) {
      const k = key(r);
      if (c.getRoom(r.room)?.findEventById(r.id) || fetched.has(k)) continue;
      let p = inflight.get(k);
      if (!p) {
        p = fetchRow(c, r).finally(() => inflight.delete(k));
        inflight.set(k, p);
      }
      void p.then(bump);
    }
    return () => {
      alive = false;
      c.off(MatrixEventEvent.Decrypted, onEvent);
      c.off(RoomEvent.Timeline, onEvent);
      c.off(RoomEvent.Redaction, onRedaction);
      c.off(ClientEvent.Room, bump);
    };
    // `refs` is keyed by `sig`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return useMemo(() => {
    const c = peekClient();
    const rows = new Map<string, EventRow | null>();
    let loading = false;
    for (const r of refs) {
      const k = key(r);
      const local = c?.getRoom(r.room)?.findEventById(r.id);
      if (local) rows.set(k, rowOf(r.room, r.id, local));
      else if (fetched.has(k)) rows.set(k, fetched.get(k)!);
      else loading = true;
    }
    return { rows, loading };
    // `rev` re-reads the local events and the fetch cache
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, rev]);
}
