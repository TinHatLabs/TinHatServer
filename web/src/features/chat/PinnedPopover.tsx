// PinnedPopover.tsx — "📌 N" composer button (only when N > 0) → 360 px "Pinned messages" popover:
// "<sender> · MMM d, <time>" + a 3-line body per pin, incl. pins older than the loaded window
// (max 20 fetched, cached per event); click → close + jump/flash (CV:1733-1789; room.rs:4207-4233).
import { useEffect, useRef, useState } from "react";
import { MatrixEvent, RoomEvent } from "matrix-js-sdk";
import { peekClient, useRoomState } from "@/core/matrix";
import { Popover, ToolButton } from "@/ui";
import { fmtPinnedWhen } from "./lib/format";
import { displayName, isLocallyRedacted } from "./lib/model";
import { pinRowBody } from "./lib/pins";
import { fetchedPin, onFetchedPinDeleted, rememberFetchedPin, shownPinIds } from "./pinstate";
import { htmlToText } from "./lib/html";
import s from "./Composer.module.css";

interface PinRow {
  id: string;
  sender: string;
  ts: number;
  body: string;
  /** QA W1: the message was deleted — not a pin for the 📌 N button or this list */
  deleted: boolean;
}

async function loadPin(roomId: string, id: string): Promise<PinRow | null> {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (!c || !room) return null;
  const local = room.findEventById(id);
  const toRow = (ev: MatrixEvent, knownDeleted = false): PinRow => {
    const cont = ev.getContent() as Record<string, unknown>;
    const deleted = knownDeleted || isLocallyRedacted(ev);
    const text = typeof cont.formatted_body === "string" ? htmlToText(cont.formatted_body) : String(cont.body ?? "");
    const body = pinRowBody({ encrypted: ev.getType() === "m.room.encrypted", redacted: deleted, text });
    return { id, sender: ev.getSender() ?? "", ts: ev.getTs(), body, deleted };
  };
  if (local) return toRow(local);
  const known = fetchedPin(id);
  if (known) return toRow(known.event, known.deleted);
  try {
    const raw = await c.fetchRoomEvent(roomId, id);
    const ev = new MatrixEvent(raw);
    if (ev.isEncrypted()) await c.decryptEventIfNeeded(ev).catch(() => {});
    const f = rememberFetchedPin(id, ev);
    return toRow(f.event, f.deleted);
  } catch {
    return null; // transient — try again next time the popover opens
  }
}

/** The pins the 📌 N button counts and the list shows (QA W1: pinstate.ts shownPinIds — a deleted message is not one). */
export function usePinnedIds(roomId: string): string[] {
  const st = useRoomState<{ pinned?: string[] }>(roomId, "m.room.pinned_events");
  const [, bump] = useState(0);
  const shown = useRef("");
  useEffect(() => {
    const c = peekClient();
    // re-render only when the answer changes (new messages in the room don't re-render the composer)
    const check = () => {
      const now = shownPinIds(roomId).join(",");
      if (now !== shown.current) bump((n) => n + 1);
    };
    // a redaction of a loaded message, one undone, or history loaded with a pin already deleted (Redaction misses the
    // last); an older (fetched) pin's redaction comes through pinstate's own watcher → onFetchedPinDeleted
    const onRoom = (_ev: MatrixEvent, room: { roomId?: string } | undefined) => {
      if (room?.roomId === roomId) check();
    };
    const onReset = (room: { roomId?: string } | undefined) => {
      if (room?.roomId === roomId) check();
    };
    c?.on(RoomEvent.Redaction, onRoom);
    c?.on(RoomEvent.RedactionCancelled, onRoom);
    c?.on(RoomEvent.Timeline, onRoom as never);
    c?.on(RoomEvent.TimelineReset, onReset as never);
    const off = onFetchedPinDeleted(check);
    return () => {
      c?.off(RoomEvent.Redaction, onRoom);
      c?.off(RoomEvent.RedactionCancelled, onRoom);
      c?.off(RoomEvent.Timeline, onRoom as never);
      c?.off(RoomEvent.TimelineReset, onReset as never);
      off();
    };
  }, [roomId]);
  const all = Array.isArray(st?.pinned) ? st!.pinned!.filter((x) => typeof x === "string") : [];
  const ids = shownPinIds(roomId, all);
  shown.current = ids.join(",");
  return ids;
}

export function PinnedButton({ roomId, onJump }: { roomId: string; onJump: (id: string) => void }) {
  const pinned = usePinnedIds(roomId);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!pinned.length) return null;
  return (
    <>
      <ToolButton ref={btn} tip="Pinned messages" className={s.pinBtn} onClick={() => setOpen((o) => !o)}>
        <span className={s.pinLabel}>📌 {pinned.length}</span>
      </ToolButton>
      <PinnedPopover roomId={roomId} open={open} onClose={() => setOpen(false)} anchor={btn.current} onJump={onJump} />
    </>
  );
}

/** The "Pinned messages" list (a bottom sheet on phones). */
export function PinnedPopover({ roomId, open, onClose, anchor, onJump }: { roomId: string; open: boolean; onClose: () => void; anchor: HTMLElement | null; onJump: (id: string) => void }) {
  const pinned = usePinnedIds(roomId);
  const [rows, setRows] = useState<PinRow[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const ids = pinned.slice(-20).reverse();
    void Promise.all(ids.map((id) => loadPin(roomId, id))).then((r) => alive && setRows(r.filter((x): x is PinRow => !!x && !x.deleted)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, roomId, pinned.join(",")]);
  const room = peekClient()?.getRoom(roomId) ?? null;
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="above" align="end" gap={6} margins={8} plain padding={0} title="Pinned messages" className={s.pinPop}>
      <div className={s.pinInner}>
        <div className={s.pinTitle}>Pinned messages</div>
        <div className={s.pinList}>
          {rows.map((r) => (
            <div
              key={r.id}
              className={s.pinRow}
              onClick={() => {
                onClose();
                onJump(r.id);
              }}
            >
              <span className={s.pinWho}>
                {displayName(room, r.sender)} · {fmtPinnedWhen(r.ts)}
              </span>
              <span className={s.pinBody}>{withSlashBreaks(r.body)}</span>
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}

/** Qt's Text.Wrap (UAX#14) may break a URL after "/"; Chromium keeps the whole URL together and drops it to
 *  the next line. A <wbr> after every "/" gives the popover the native's line breaks (copying stays clean). */
function withSlashBreaks(text: string): React.ReactNode {
  if (!text.includes("/")) return text;
  const parts = text.split("/");
  return parts.map((p, i) => (i < parts.length - 1 ? [p, "/", <wbr key={i} />] : p));
}
