// mentions/tracker.ts — what goes into the Mentions list (contract WIDGETS.md §13): every LIVE event the account's push
// rules HIGHLIGHT, judged after decryption — js-sdk's own evaluation (getPushActionsForEvent, the one behind the rail's
// mention badges), so encrypted rooms count (the server's /notifications can't see inside them). Encrypted events wait
// for their MatrixEventEvent.Decrypted; edits (m.replace) and our own events never add a row. A mention arrives seen
// when its room is on screen (the main view, focused window), and so does everything of the first sync of a device that
// has no list yet (it predates the widget). A room that comes on screen has its mentions so far marked seen.
// Recording runs for the whole session, whether or not a Mentions widget is shown (nothing leaves the device).
import { ClientEvent, MatrixEventEvent, RoomEvent, SyncState, type MatrixEvent, type IRoomTimelineData } from "matrix-js-sdk";
import { peekClient } from "@/core/matrix";
import { onAttendedRoom } from "@/features/chat";
import { hadMentions, loadMentions, markMentionsSeen, recordMention, settleMentions } from "./store";

let stop: (() => void) | null = null;

export function installMentionTracker(): void {
  stop?.();
  const c = peekClient();
  const me = c?.getUserId();
  if (!c || !me) return;
  loadMentions(me);
  let firstFill = !hadMentions();
  let attended: string | null = null;
  const pending = new Set<string>();

  const consider = (ev: MatrixEvent, afterDecrypt: boolean) => {
    const room = ev.getRoomId();
    const id = ev.getId();
    const sender = ev.getSender();
    if (!room || !id || !id.startsWith("$") || !sender || sender === me) return;
    if (!afterDecrypt && ev.isEncrypted() && ev.getClearContent() === null) {
      pending.add(id); // judged once it is decrypted
      return;
    }
    const rel = (ev.getWireContent()?.["m.relates_to"] ?? ev.getContent()?.["m.relates_to"]) as { rel_type?: unknown } | undefined;
    if (rel?.rel_type === "m.replace") return;
    const actions = c.getPushActionsForEvent(ev, afterDecrypt);
    if (!actions?.tweaks?.highlight) return;
    recordMention({ r: room, e: id, s: sender, t: ev.getTs(), ...(firstFill || attended === room ? { seen: true } : {}) });
  };
  const onTimeline = (ev: MatrixEvent, _room: unknown, toStart: boolean | undefined, removed: boolean, data: IRoomTimelineData) => {
    if (toStart || removed || !data?.liveEvent) return;
    consider(ev, false);
  };
  const onDecrypted = (ev: MatrixEvent, err?: Error) => {
    const id = ev.getId();
    if (!id || !pending.has(id)) return;
    pending.delete(id);
    if (!err && !ev.isDecryptionFailure()) consider(ev, true);
  };
  const onSync = (state: SyncState) => {
    if (state !== SyncState.Syncing || !firstFill) return;
    firstFill = false; // the first network sync is in: from here on, new is new
    settleMentions();
  };
  c.on(RoomEvent.Timeline, onTimeline);
  c.on(MatrixEventEvent.Decrypted, onDecrypted);
  c.on(ClientEvent.Sync, onSync);
  const offAttend = onAttendedRoom((r) => {
    attended = r;
    if (r) markMentionsSeen({ r, upTo: Date.now() });
  });
  stop = () => {
    c.off(RoomEvent.Timeline, onTimeline);
    c.off(MatrixEventEvent.Decrypted, onDecrypted);
    c.off(ClientEvent.Sync, onSync);
    offAttend();
    stop = null;
  };
}
