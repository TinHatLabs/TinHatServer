// useRoomTimeline.ts — the js-sdk timeline of one room (+ pending local echoes), with back-pagination
// that REPORTS failures (CHAT-79 toast) — built like core's useTimeline.
//
// "The timeline" is the live EventTimeline PLUS every timeline js-sdk linked behind it
// (core/matrix/timeline.ts): after a gappy sync the live timeline alone holds only the events since
// the gap and — once back-pagination joins it to the old one — has no back token either, so the
// conversation you left vanished and "This is the start of the conversation" took its place
// (2026-09-23; tools/timeline-loop.mjs gappy/gappyIn/floating/e2ee). Pagination grows the
// chain's OLDEST end.
import { useCallback, useEffect, useRef, useState } from "react";
import { ClientEvent, MatrixEventEvent, RoomEvent, type MatrixEvent, type Room } from "matrix-js-sdk";
import { liveTimelineChain, paginateChainBack, peekClient, useClient } from "@/core/matrix";

export interface RoomTimeline {
  events: MatrixEvent[];
  canBack: boolean;
  loadingBack: boolean;
  /** resolves "ok" | "end" | "error" */
  paginate: (limit?: number) => Promise<"ok" | "end" | "error">;
  version: number;
  /** the room object has been seen (false = not joined / unknown) */
  known: boolean;
}

export function useRoomTimeline(roomId: string | null | undefined): RoomTimeline {
  const client = useClient();
  const [, force] = useState(0);
  const st = useRef({ version: 0, loadingBack: false, events: [] as MatrixEvent[], canBack: true, roomId: undefined as string | null | undefined, known: false });

  const snapshot = useCallback(() => {
    const room = roomId ? peekClient()?.getRoom(roomId) : null;
    if (!room) {
      st.current.events = [];
      st.current.canBack = false;
      st.current.known = false;
      return;
    }
    const chain = liveTimelineChain(room);
    const pending = room.getPendingEvents();
    st.current.events = pending.length ? [...chain.events, ...pending] : [...chain.events];
    st.current.canBack = chain.canBack;
    st.current.known = true;
  }, [roomId]);

  if (st.current.roomId !== roomId) {
    st.current.roomId = roomId;
    st.current.loadingBack = false;
    snapshot();
  }

  useEffect(() => {
    const c = client;
    if (!c || !roomId) return;
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
    const onEv = (ev: MatrixEvent) => {
      if (ev.getRoomId() === roomId) bump();
    };
    const onRoom = (r: Room | undefined) => {
      if (r?.roomId === roomId) bump();
    };
    const onReceipt = (_e: unknown, room: Room) => {
      if (room?.roomId === roomId) bump();
    };
    c.on(RoomEvent.Timeline, onRoomArg);
    c.on(RoomEvent.TimelineReset, onRoom);
    c.on(RoomEvent.Redaction, onRoomArg);
    c.on(RoomEvent.RedactionCancelled, onRoomArg);
    c.on(RoomEvent.LocalEchoUpdated, onRoomArg);
    c.on(RoomEvent.Receipt, onReceipt);
    c.on(MatrixEventEvent.Decrypted, onEv);
    c.on(MatrixEventEvent.Replaced, onEv);
    c.on(ClientEvent.Room, onRoom);
    snapshot();
    force((n) => n + 1);
    return () => {
      c.off(RoomEvent.Timeline, onRoomArg);
      c.off(RoomEvent.TimelineReset, onRoom);
      c.off(RoomEvent.Redaction, onRoomArg);
      c.off(RoomEvent.RedactionCancelled, onRoomArg);
      c.off(RoomEvent.LocalEchoUpdated, onRoomArg);
      c.off(RoomEvent.Receipt, onReceipt);
      c.off(MatrixEventEvent.Decrypted, onEv);
      c.off(MatrixEventEvent.Replaced, onEv);
      c.off(ClientEvent.Room, onRoom);
    };
  }, [client, roomId, snapshot]);

  const paginate = useCallback(
    async (limit = 50): Promise<"ok" | "end" | "error"> => {
      const c = peekClient();
      const room = roomId ? c?.getRoom(roomId) : null;
      if (!c || !room) return "end";
      if (st.current.loadingBack) return "ok";
      st.current.loadingBack = true;
      force((n) => n + 1);
      try {
        await paginateChainBack(c, room, limit);
        // js-sdk answers "more" for a page that joined the live timeline to an older one, and the
        // joined page nulls the live back token — the chain's head is the truth either way
        const more = liveTimelineChain(room).canBack;
        st.current.canBack = more;
        return more ? "ok" : "end";
      } catch {
        return "error";
      } finally {
        st.current.loadingBack = false;
        if (st.current.roomId === roomId) {
          snapshot();
          st.current.version++;
        }
        force((n) => n + 1);
      }
    },
    [roomId, snapshot],
  );

  return {
    events: st.current.events,
    canBack: st.current.canBack,
    loadingBack: st.current.loadingBack,
    paginate,
    version: st.current.version,
    known: st.current.known,
  };
}
