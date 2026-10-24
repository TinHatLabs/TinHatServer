// CalendarHarness.tsx — DEV ONLY (`?calharness=1`): the chat area is a stub in this worktree, so
// this floating strip stands in for its two hosts — a RoomHeaderBar-like row rendering the
// calendar's r.roomHeaderActions, and faux bubbles rendering the CalendarCard renderer for every
// calendar card message in the current room's live timeline. Integration never shows it.
// Colours (site map `dev-skip`): role variables; the header / own-bubble gradients keep their OLED literals.
import { useEffect, useState } from "react";
import { RoomEvent, type MatrixEvent } from "matrix-js-sdk";
import { peekClient } from "@/core/matrix";
import { useRegistry } from "@/core/registry";
import { hasCardMarker, CalendarCard } from "./CalendarCard";

export function CalendarHarness({ roomId }: { roomId: string }) {
  const actions = useRegistry("roomHeaderActions");
  const [cards, setCards] = useState<MatrixEvent[]>([]);
  useEffect(() => {
    const client = peekClient();
    const room = roomId ? client?.getRoom(roomId) : null;
    if (!client || !room) return;
    const scan = () => {
      const evs = room.getLiveTimeline().getEvents().filter((e) => hasCardMarker(e) && !e.isRelation("m.replace"));
      setCards(evs.slice(-3));
    };
    scan();
    const on = () => setTimeout(scan, 50);
    client.on(RoomEvent.Timeline, on);
    client.on(RoomEvent.LocalEchoUpdated, on);
    return () => {
      client.off(RoomEvent.Timeline, on);
      client.off(RoomEvent.LocalEchoUpdated, on);
    };
  }, [roomId]);
  const me = peekClient()?.getUserId();
  return (
    <div data-testid="cal-harness" style={{ position: "fixed", left: 380, right: 20, top: 16, zIndex: 50, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
      <div data-room-header style={{ pointerEvents: "auto", height: 58, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, padding: "0 12px", background: "linear-gradient(#1d1d1d, var(--th-surface-island))", borderRadius: 8 }}>
        <span style={{ flex: 1, color: "var(--th-text-secondary)" }}>calendar harness · {roomId}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {actions.map((a) => (
            <a.component key={a.id} roomId={roomId} />
          ))}
        </span>
      </div>
      {cards.map((ev) => {
        const mine = ev.getSender() === me;
        return (
          <div key={ev.getId()} style={{ pointerEvents: "auto", alignSelf: mine ? "flex-end" : "flex-start", maxWidth: 520, padding: "8px 12px", borderRadius: 12, background: mine ? "linear-gradient(#227784, #18555e)" : "var(--th-surface-island)", border: mine ? "none" : "1px solid var(--th-border-subtle)" }}>
            <CalendarCard roomId={roomId} event={ev} />
          </div>
        );
      })}
    </div>
  );
}
