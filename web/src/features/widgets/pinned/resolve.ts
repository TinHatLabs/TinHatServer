// pinned/resolve.ts — the Pinned widget's rows (contract WIDGETS.md §11): the first `n` pinned events of a room through
// the widgets' shared event resolver (../eventRows.ts — the loaded timeline's copy or a fetched + decrypted one, the
// shared snippet). A pin whose event can't be fetched has no row (as in the chat's pinned popover).
import { useMemo } from "react";
import { useEventRows, type EventRow } from "../eventRows";

export type PinRow = Omit<EventRow, "room">;

/** The rows of the first `n` pinned ids (`ids` newest first, pinOrder) of `roomId`, in that order, plus whether some are
 *  still being fetched. */
export function usePinRows(roomId: string | null, ids: readonly string[], n: number): { rows: PinRow[]; loading: boolean } {
  const refs = useMemo(() => (roomId ? ids.slice(0, Math.max(0, n)).map((id) => ({ room: roomId, id })) : []), [roomId, ids, n]);
  const { rows, loading } = useEventRows(refs);
  return useMemo(() => {
    const out: PinRow[] = [];
    for (const r of refs) {
      const row = rows.get(`${r.room}\u0000${r.id}`);
      if (row) out.push({ id: row.id, sender: row.sender, ts: row.ts, kind: row.kind, text: row.text });
    }
    return { rows: out, loading };
  }, [refs, rows, loading]);
}
