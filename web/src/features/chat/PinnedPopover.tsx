// PinnedPopover.tsx — "📌 N" composer button (only when N > 0) → 360 px "Pinned messages" popover:
// "<sender> · MMM d, <time>" + a 3-line body per pin, incl. pins older than the loaded window
// (max 20 fetched, cached per event); click → close + jump/flash (CV:1733-1789; room.rs:4207-4233).
import { useEffect, useRef, useState } from "react";
import { MatrixEvent } from "matrix-js-sdk";
import { peekClient, useRoomState } from "@/core/matrix";
import { Popover, ToolButton } from "@/ui";
import { fmtPinnedWhen } from "./lib/format";
import { displayName } from "./lib/model";
import { htmlToText } from "./lib/html";
import s from "./Composer.module.css";

interface PinRow {
  id: string;
  sender: string;
  ts: number;
  body: string;
}

const fetched = new Map<string, PinRow | null>();

async function loadPin(roomId: string, id: string): Promise<PinRow | null> {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (!c || !room) return null;
  const local = room.findEventById(id);
  const toRow = (ev: MatrixEvent): PinRow => {
    const enc = ev.getType() === "m.room.encrypted";
    const cont = ev.getContent() as Record<string, unknown>;
    const body = enc
      ? "Encrypted message — open the room around it to read it"
      : ev.isRedacted()
        ? "Message deleted"
        : typeof cont.formatted_body === "string"
          ? htmlToText(cont.formatted_body)
          : String(cont.body ?? "");
    return { id, sender: ev.getSender() ?? "", ts: ev.getTs(), body };
  };
  if (local) return toRow(local);
  if (fetched.has(id)) return fetched.get(id)!;
  try {
    const raw = await c.fetchRoomEvent(roomId, id);
    const ev = new MatrixEvent(raw);
    if (ev.isEncrypted()) await c.decryptEventIfNeeded(ev).catch(() => {});
    const r = toRow(ev);
    fetched.set(id, r);
    return r;
  } catch {
    return null; // transient — try again next time the popover opens
  }
}

export function usePinnedIds(roomId: string): string[] {
  const st = useRoomState<{ pinned?: string[] }>(roomId, "m.room.pinned_events");
  return Array.isArray(st?.pinned) ? st!.pinned!.filter((x) => typeof x === "string") : [];
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
    void Promise.all(ids.map((id) => loadPin(roomId, id))).then((r) => alive && setRows(r.filter((x): x is PinRow => !!x)));
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
