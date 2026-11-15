// mentions/tracker.ts — what goes into the Mentions list (contract WIDGETS.md §13): every LIVE event the account's push
// rules HIGHLIGHT, judged after decryption — js-sdk's own evaluation (getPushActionsForEvent, the one behind the rail's
// mention badges), so encrypted rooms count (the server's /notifications can't see inside them). Encrypted events wait
// for their MatrixEventEvent.Decrypted; edits (m.replace) and our own events never add a row. A mention arrives seen
// when its own timeline is on screen (the main view of its room in a focused window; a thread's mention only with that
// thread open in the panel — 12.1.16 fix 1-3), and so does everything of the first sync of a device that
// has no list yet (it predates the widget). A room (or thread) that comes on screen has its mentions so far marked seen.
// Recording runs for the whole session, whether or not a Mentions widget is shown (nothing leaves the device).
import { ClientEvent, MatrixEventEvent, RoomEvent, SyncState, type MatrixEvent, type IRoomTimelineData } from "matrix-js-sdk";
import { peekClient } from "@/core/matrix";
import { onAttendedRoom } from "@/features/chat";
import { threadOf } from "@/features/chat/threads/core";
import { useThreadsPanel } from "@/features/chat/threads/state";
import { shownTimelines } from "@/features/chat/threads/shown";
import { useRightPanelStore } from "@/features/spaces/panelState";
import { getMentions, hadMentions, loadMentions, markMentionsSeen, recordMention, settleMentions } from "./store";
import { attendedSeenIds, recordLookup } from "./attendSeen";

let stop: (() => void) | null = null;
/** review (1-3): how long the screen must be stable before what it shows marks mentions seen */
const SETTLE_MS = 400;
/** review (1-3): a mention's failed thread lookup is tried again after this long */
const RESOLVE_RETRY_MS = 120_000;

export function installMentionTracker(): void {
  stop?.();
  const c = peekClient();
  const me = c?.getUserId();
  if (!c || !me) return;
  loadMentions(me);
  let firstFill = !hadMentions();
  let attended: string | null = null;
  const pending = new Set<string>();
  // 1-3: each mention's thread ("" = main), as recorded or looked up — what decides whether it is on screen. A mention
  // from an earlier run isn't in here until its lookup (resolveLater) answers: until then no timeline counts as its own.
  const threads = new Map<string, string>();
  const tried = new Map<string, number>(); // lookups: when each was last tried (a failure waits RESOLVE_RETRY_MS)
  // the timelines of `room` on screen: its main timeline in the focused main view (unless a phone's Threads sheet
  // covers it), plus the thread open in the right panel there (threads/shown.ts)
  const shownThreads = (room: string): string[] => shownTimelines(room, attended === room);
  const markNow = () => {
    const r = attended;
    if (!r) return;
    const list = getMentions();
    for (const e of attendedSeenIds(list, r, shownThreads(r), Date.now(), threads)) markMentionsSeen({ e });
    resolveLater(r, list.filter((m) => m.r === r && !m.seen && !threads.has(m.e)).map((m) => m.e));
  };
  // review: what came on screen is judged once things have settled (opening another room's thread changes the room,
  // the panel and its thread one after another — a half-done switch must not mark anything seen)
  let settle: ReturnType<typeof setTimeout> | null = null;
  const markShown = () => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      markNow();
    }, SETTLE_MS);
  };
  // a failed lookup is tried again by itself (the room may stay on screen with nothing else happening)
  let retry: ReturnType<typeof setTimeout> | null = null;
  const retryLater = () => {
    if (retry) return;
    retry = setTimeout(() => {
      retry = null;
      markShown();
    }, RESOLVE_RETRY_MS + 1000);
  };
  const resolveLater = (room: string, ids: string[]) => {
    const now = Date.now();
    const todo = ids.filter((e) => now - (tried.get(e) ?? -Infinity) >= RESOLVE_RETRY_MS);
    if (!todo.length) return;
    for (const e of todo) tried.set(e, now);
    void (async () => {
      let any = false;
      for (const e of todo) {
        const local = c.getRoom(room)?.findEventById(e);
        let content: unknown = local ? (local.getWireContent() ?? local.getContent()) : undefined;
        if (content === undefined) {
          try {
            content = ((await c.fetchRoomEvent(room, e)) as { content?: unknown }).content;
          } catch {
            content = undefined; // failed: recorded as unknown, tried again after RESOLVE_RETRY_MS
            retryLater();
          }
        }
        if (stop !== stopNow) return; // signed out / reinstalled meanwhile
        if (recordLookup(threads, e, content)) any = true;
      }
      if (any) markShown();
    })();
  };

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
    const th = threadOf(ev.getWireContent() ?? ev.getContent());
    threads.set(id, th);
    // while the screen is settling (a switch under way) it is recorded unseen: the pending check judges it
    recordMention({ r: room, e: id, s: sender, t: ev.getTs(), ...(firstFill || (!settle && attended === room && shownThreads(room).includes(th)) ? { seen: true } : {}) });
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
  // a room coming on screen: its mentions so far are read — 1-3: those of the timelines shown, not a closed thread's
  const offAttend = onAttendedRoom((r) => {
    attended = r;
    if (r) markShown();
  });
  // …and a thread opened in its panel brings that thread's mentions on screen
  const offPanel = useRightPanelStore.subscribe(markShown);
  const offThreads = useThreadsPanel.subscribe(markShown);
  const stopNow = () => {
    if (settle) clearTimeout(settle);
    if (retry) clearTimeout(retry);
    c.off(RoomEvent.Timeline, onTimeline);
    c.off(MatrixEventEvent.Decrypted, onDecrypted);
    c.off(ClientEvent.Sync, onSync);
    offAttend();
    offPanel();
    offThreads();
    stop = null;
  };
  stop = stopNow;
}
