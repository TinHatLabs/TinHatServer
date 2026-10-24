// roomCall.ts — "who is in this room's call" read straight from MatrixRTC membership state (the wire
// data; rtc.rs:80-135 liveness rule), for the header call button and the "… is in a call · Join"
// banner. The calls engine will expose `useRoomCall(roomId)` with SFU truth for OUR call; this is the
// chat's read-only fallback until integration wires that in (see CORE-CHANGES / integration notes).
import { useEffect, useState } from "react";
import { RoomStateEvent, type MatrixEvent } from "matrix-js-sdk";
import { peekClient, useClient } from "@/core/matrix";

const TYPES = ["org.matrix.msc3401.call.member", "m.call.member", "m.rtc.member"];
const DEFAULT_EXPIRE = 14400000;

type C = Record<string, unknown>;

function liveEntry(c: C, fallbackTs: number, now: number): boolean {
  if (!c || Object.keys(c).length === 0) return false;
  const created = typeof c.created_ts === "number" ? c.created_ts : fallbackTs;
  const expires = typeof c.expires === "number" ? c.expires : DEFAULT_EXPIRE;
  if (!created) return true;
  return now <= created + expires;
}

function isLive(ev: MatrixEvent, now: number): boolean {
  const c = ev.getContent() as C;
  if (Array.isArray(c.memberships)) {
    return (c.memberships as C[]).some((m) => liveEntry(m, ev.getTs(), now));
  }
  return liveEntry(c, ev.getTs(), now);
}

export interface RoomCallInfo {
  active: boolean;
  participants: Array<{ userId: string; name: string }>;
}

export function readRoomCall(roomId: string): RoomCallInfo {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (!c || !room) return { active: false, participants: [] };
  const now = Date.now();
  const seen = new Set<string>();
  const out: RoomCallInfo["participants"] = [];
  for (const t of TYPES) {
    for (const ev of room.currentState.getStateEvents(t)) {
      if (!isLive(ev, now)) continue;
      const u = ev.getSender() ?? "";
      if (!u || seen.has(u)) continue;
      seen.add(u);
      const m = room.getMember(u);
      out.push({ userId: u, name: m?.name && m.name !== u ? m.name : u.replace(/^@/, "").split(":")[0] });
    }
  }
  return { active: out.length > 0, participants: out };
}

export function useRoomCallInfo(roomId: string): RoomCallInfo {
  const client = useClient();
  const [v, setV] = useState(() => readRoomCall(roomId));
  useEffect(() => {
    // GPU.md §2.8 (D6): only a real change re-renders (the 30 s expiry re-read made a new object every time)
    const upd = () =>
      setV((cur) => {
        const next = readRoomCall(roomId);
        return JSON.stringify(next) === JSON.stringify(cur) ? cur : next;
      });
    upd();
    if (!client) return;
    const on = (ev: MatrixEvent) => {
      if (ev.getRoomId() === roomId && TYPES.includes(ev.getType())) upd();
    };
    client.on(RoomStateEvent.Events, on);
    const t = window.setInterval(upd, 30000);
    return () => {
      client.off(RoomStateEvent.Events, on);
      window.clearInterval(t);
    };
  }, [client, roomId]);
  return v;
}

/** Main:5245-5291 banner wording. */
export function callBannerText(names: string[]): string {
  if (names.length === 0) return "There's a call going on in this room";
  if (names.length === 1) return `${names[0]} is in a call`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in a call`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are in a call`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are in a call`;
}
