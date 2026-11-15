// threads/useThreadTimeline.ts — one thread's events for its panel (docs/THREADS.md), the same shape as
// useRoomTimeline so ConversationView runs on either. The thread = its root + every event in it (threads/core
// threadIds: the m.thread replies and their edits / reactions), from two places:
//   - the room's loaded timeline + pending local echoes (js-sdk runs with threadSupport off, so live thread events
//     arrive in the room's own timeline);
//   - pages of the server's /relations/{root}?recurse (spec v1.10 MSC3981; a server without recursion still returns
//     the replies themselves), newest first, decrypted here, for the part of the thread the room hasn't loaded.
// The desktop's thread-mode RoomController (room.rs load_thread_data) reads the same two sources.
import { useCallback, useEffect, useRef, useState } from "react";
import { ClientEvent, Direction, MatrixEventEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { liveTimelineChain, peekClient, useClient } from "@/core/matrix";
import type { RoomTimeline } from "../useRoomTimeline";
import { mergeThread } from "./rows";

const PAGE = 50;

async function fetchPage(c: MatrixClient, roomId: string, root: string, from: string | undefined): Promise<{ events: MatrixEvent[]; next: string | null }> {
  const res = await c.fetchRelations(roomId, root, null, null, { dir: Direction.Backward, from, limit: PAGE, recurse: true });
  const mapper = c.getEventMapper();
  const events = res.chunk.map(mapper);
  await Promise.all(events.map((e) => c.decryptEventIfNeeded(e).catch(() => undefined)));
  return { events, next: res.next_batch ?? null };
}

async function fetchRoot(c: MatrixClient, roomId: string, root: string): Promise<MatrixEvent | null> {
  try {
    const raw = await c.fetchRoomEvent(roomId, root);
    const ev = c.getEventMapper()(raw);
    await c.decryptEventIfNeeded(ev).catch(() => undefined);
    return ev;
  } catch {
    return null;
  }
}

export function useThreadTimeline(roomId: string | null | undefined, root: string | null | undefined): RoomTimeline & { rootMissing: boolean } {
  const client = useClient();
  const [, force] = useState(0);
  const st = useRef({
    key: "",
    version: 0,
    events: [] as MatrixEvent[],
    fetched: [] as MatrixEvent[],
    rootEv: null as MatrixEvent | null,
    next: undefined as string | null | undefined, // undefined = no page yet, null = the end
    loadingBack: false,
    known: false,
    rootMissing: false,
  });
  const key = roomId && root ? `${roomId}|${root}` : "";

  const snapshot = useCallback(() => {
    const room: Room | null = roomId ? (peekClient()?.getRoom(roomId) ?? null) : null;
    if (!room || !root) {
      st.current.events = [];
      st.current.known = false;
      return;
    }
    const chain = liveTimelineChain(room).events;
    const c = peekClient();
    const ignoring = (c?.getIgnoredUsers().length ?? 0) > 0;
    const shown = ignoring ? chain.filter((e) => !c!.isUserIgnored(e.getSender() ?? "")) : chain;
    const fetched = ignoring ? st.current.fetched.filter((e) => !c!.isUserIgnored(e.getSender() ?? "")) : st.current.fetched;
    st.current.events = mergeThread(root, shown, room.getPendingEvents(), fetched, st.current.rootEv);
    st.current.known = true;
  }, [roomId, root]);

  if (st.current.key !== key) {
    st.current.key = key;
    st.current.fetched = [];
    st.current.rootEv = null;
    st.current.next = undefined;
    st.current.loadingBack = false;
    st.current.rootMissing = false;
    snapshot();
  }

  const paginate = useCallback(
    async (_limit = PAGE): Promise<"ok" | "end" | "error"> => {
      const c = peekClient();
      if (!c || !roomId || !root) return "end";
      if (st.current.next === null) return "end";
      if (st.current.loadingBack) return "ok";
      const myKey = `${roomId}|${root}`;
      st.current.loadingBack = true;
      force((n) => n + 1);
      try {
        const first = st.current.next === undefined;
        const [page, rootEv] = await Promise.all([
          fetchPage(c, roomId, root, st.current.next ?? undefined),
          first && !c.getRoom(roomId)?.findEventById(root) ? fetchRoot(c, roomId, root) : Promise.resolve(null),
        ]);
        if (st.current.key !== myKey) return "ok";
        st.current.fetched = [...st.current.fetched, ...page.events];
        st.current.next = page.next;
        if (rootEv) st.current.rootEv = rootEv;
        if (first && !rootEv && !c.getRoom(roomId)?.findEventById(root)) st.current.rootMissing = true;
        return page.next ? "ok" : "end";
      } catch {
        return "error";
      } finally {
        if (st.current.key === myKey) {
          st.current.loadingBack = false;
          snapshot();
          st.current.version++;
        }
        force((n) => n + 1);
      }
    },
    [roomId, root, snapshot],
  );

  /** the newest page again, merged in (a gap after a limited sync, review #4) */
  const refreshNewest = useCallback(async () => {
    const c = peekClient();
    if (!c || !roomId || !root || st.current.next === undefined) return;
    const myKey = `${roomId}|${root}`;
    try {
      // newest pages until one overlaps what is held (a gap longer than a page is filled too; round 2 #2), at most 6
      const have = new Set(st.current.fetched.map((e) => e.getId()));
      const add: MatrixEvent[] = [];
      let from: string | undefined;
      for (let i = 0; i < 6; i++) {
        const page = await fetchPage(c, roomId, root, from);
        if (st.current.key !== myKey) return;
        let overlap = false;
        for (const e of page.events) {
          if (have.has(e.getId())) overlap = true;
          else add.push(e);
        }
        if (overlap || !page.next) break;
        from = page.next;
      }
      st.current.fetched = [...st.current.fetched, ...add];
      snapshot();
      st.current.version++;
      force((n) => n + 1);
    } catch {
      /* the next reset or scroll tries again */
    }
  }, [roomId, root, snapshot]);

  useEffect(() => {
    const c = client;
    if (!c || !roomId || !root) return;
    let scheduled = false;
    const bump = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        snapshot();
        st.current.version++;
        force((n) => n + 1);
      });
    };
    const onRoomArg = (_e: unknown, room: Room | undefined) => {
      if (room?.roomId === roomId) bump();
    };
    // review #3 / round 2 #1: a redaction of an event this panel fetched itself — js-sdk only redacts (and only emits
    // Redaction for) what its own timelines hold, so the redaction event itself is read as it arrives
    const redactFetched = (redaction: MatrixEvent, room: Room) => {
      const target = redaction.event.redacts ?? (redaction.getContent() as { redacts?: string }).redacts;
      if (!target) return;
      for (const ev of [...st.current.fetched, ...(st.current.rootEv ? [st.current.rootEv] : [])])
        if (ev.getId() === target && !ev.isRedacted()) ev.makeRedacted(redaction, room);
    };
    const onRedaction = (redaction: MatrixEvent, room: Room | undefined) => {
      if (room?.roomId !== roomId) return;
      redactFetched(redaction, room);
      bump();
    };
    const onTimeline = (ev: MatrixEvent, room: Room | undefined) => {
      if (room?.roomId !== roomId) return;
      if (ev.getType() === "m.room.redaction") redactFetched(ev, room);
      bump();
    };
    // review #4: after a gappy sync the room's timeline lost what came in meanwhile — fetch the newest page again
    const onReset = (r: Room | undefined) => {
      if (r?.roomId !== roomId) return;
      void refreshNewest();
      bump();
    };
    const onEv = (ev: MatrixEvent) => {
      if (ev.getRoomId() === roomId) bump();
    };
    const onRoom = (r: Room | undefined) => {
      if (r?.roomId === roomId) bump();
    };
    c.on(RoomEvent.Timeline, onTimeline);
    c.on(RoomEvent.TimelineReset, onReset);
    c.on(RoomEvent.Redaction, onRedaction);
    c.on(RoomEvent.RedactionCancelled, onRoomArg);
    c.on(RoomEvent.LocalEchoUpdated, onRoomArg);
    c.on(RoomEvent.Receipt, onRoomArg);
    c.on(MatrixEventEvent.Decrypted, onEv);
    c.on(MatrixEventEvent.Replaced, onEv);
    c.on(ClientEvent.Room, onRoom);
    snapshot();
    force((n) => n + 1);
    // the newest page of the thread at once
    if (st.current.next === undefined) void paginate();
    return () => {
      c.off(RoomEvent.Timeline, onTimeline);
      c.off(RoomEvent.TimelineReset, onReset);
      c.off(RoomEvent.Redaction, onRedaction);
      c.off(RoomEvent.RedactionCancelled, onRoomArg);
      c.off(RoomEvent.LocalEchoUpdated, onRoomArg);
      c.off(RoomEvent.Receipt, onRoomArg);
      c.off(MatrixEventEvent.Decrypted, onEv);
      c.off(MatrixEventEvent.Replaced, onEv);
      c.off(ClientEvent.Room, onRoom);
    };
  }, [client, roomId, root, snapshot, paginate, refreshNewest]);

  return {
    events: st.current.events,
    canBack: st.current.next !== null,
    loadingBack: st.current.loadingBack,
    paginate,
    version: st.current.version,
    // sun-l2's receipt counter (the NEW line follows read receipts): here a receipt already bumps `version`
    receiptsVersion: st.current.version,
    known: st.current.known,
    rootMissing: st.current.rootMissing,
  };
}
