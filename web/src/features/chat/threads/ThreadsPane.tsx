// threads/ThreadsPane.tsx — the right panel's "Threads" tab (docs/THREADS.md; the desktop's ThreadsPane.qml):
//   the list   all threads / my threads, newest activity first (threads/core threadList), each with its root's sender
//              and text, the summary line and an unread dot; from the server's /threads (spec v1.4) merged with the
//              thread events the room has loaded since;
//   a thread   Back (→ the list) + the thread in a ConversationView in thread mode (root, replies, its own composer).
// Phones: the right panel is a full-screen sheet; the hardware / browser back goes thread → list → room.
// Keyboard: ↑/↓ walk the list, Enter opens; Escape in a thread goes back to the list; focus returns to the control that
// opened the thread (a summary, the message menu's opener) when it is still there, else to the list row.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ClientPrefix, Method, type MatrixEvent } from "matrix-js-sdk";
import { peekClient, useClient } from "@/core/matrix";
import { Avatar, BasicButton, Icon, cx } from "@/ui";
import { useBackToClose } from "@/ui/backStack";
import { useIsMobile } from "@/ui/formFactor";
import { ConversationView } from "../ConversationView";
import { useRoomTimeline } from "../useRoomTimeline";
import { displayName } from "../lib/model";
import { bundleOf, summarize, summaryText, threadList, threadOf, threadUnread, type ReplyRef } from "./core";
import { evLike, threadPlan } from "./rows";
import { myReceipts, onThreadReceipts, receiptsVersion } from "./receipts";
import { THREAD_BACK_LEVEL, moreThreadPages, setOpenThread, setThreadsFilter, threadTakesBack, useThreadsPanel } from "./state";
import { useRightPanelStore } from "@/features/spaces/panelState";
import { getView } from "../store";
import { chatMsgOf, hiddenInChat, useChatIndex } from "@/features/media";
import s from "./Threads.module.css";

interface ListItem {
  root: string;
  rootSender: string;
  rootName: string;
  snippet: string;
  count: number;
  lastName: string;
  lastTs: number;
  unread: number;
  mine: boolean;
}

function snippetOfEvent(ev: MatrixEvent | undefined): string {
  if (!ev) return "";
  if (ev.isRedacted()) return "Message deleted";
  if (ev.isDecryptionFailure() || ev.getType() === "m.room.encrypted") return "Encrypted message";
  const b = (ev.getContent() as { body?: unknown }).body;
  return typeof b === "string" ? b.replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

/** The server's thread roots (newest activity first; each with its bundled summary), decrypted: `pages` pages of 50.
 *  `more` = the server has older ones ("Load more threads"). */
async function fetchRoots(roomId: string, pages: number): Promise<{ evs: MatrixEvent[]; more: boolean }> {
  const c = peekClient();
  if (!c) return { evs: [], more: false };
  const mapper = c.getEventMapper();
  const evs: MatrixEvent[] = [];
  let from: string | undefined;
  for (let i = 0; i < pages; i++) {
    const res = (await c.http.authedRequest(
      Method.Get,
      `/rooms/${encodeURIComponent(roomId)}/threads`,
      { include: "all", limit: "50", ...(from ? { from } : {}) },
      undefined,
      { prefix: ClientPrefix.V1 },
    )) as { chunk?: unknown[]; next_batch?: string };
    evs.push(...(res.chunk ?? []).map((e) => mapper(e as never)));
    from = res.next_batch;
    if (!from) break;
  }
  await Promise.all(evs.map((e) => c.decryptEventIfNeeded(e).catch(() => undefined)));
  return { evs, more: !!from };
}

/** The room's threads for the list (and the header's unread dot): server roots + roots seen in the loaded timeline. */
export function useThreadItems(roomId: string, fetchServer: boolean): { items: ListItem[]; loading: boolean; error: boolean; more: boolean; loadMore: () => void } {
  const client = useClient();
  const me = client?.getUserId() ?? "";
  const tl = useRoomTimeline(roomId);
  const receiptsV = useSyncExternalStore(onThreadReceipts, receiptsVersion, receiptsVersion);
  const [server, setServer] = useState<MatrixEvent[]>([]);
  const [loading, setLoading] = useState(fetchServer);
  const [error, setError] = useState(false);
  // the pager lives in the panel's store per room: Back from a thread keeps the pages loaded (review)
  const pages = useThreadsPanel((st) => st.pages[roomId] ?? 1);
  const [more, setMore] = useState(false);
  // roots the loaded timeline has replies for but the server list didn't name yet → fetch the list again (debounced)
  const localRoots = useMemo(() => {
    const set = new Set<string>();
    for (const ev of tl.events) {
      const r = threadOf(ev.getWireContent() ?? ev.getContent());
      if (r) set.add(r);
    }
    return [...set].sort().join(",");
  }, [tl.events]);
  useEffect(() => {
    if (!fetchServer || !client) return;
    let gone = false;
    const t = window.setTimeout(
      () => {
        fetchRoots(roomId, pages)
          .then(({ evs, more: m }) => {
            if (!gone) {
              setServer(evs);
              setMore(m);
              setError(false);
            }
          })
          .catch(() => !gone && setError(true))
          .finally(() => !gone && setLoading(false));
      },
      server.length ? 1500 : 0,
    );
    return () => {
      gone = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, fetchServer, client, localRoots, pages]);

  // 12.1.17: a photo in Memories isn't listed here (its comments live in Memories' viewer, which opens its thread)
  const memIdx = useChatIndex(roomId);
  const items = useMemo(() => {
    const room = client?.getRoom(roomId) ?? null;
    const receipts = myReceipts(roomId);
    const roots = new Map<string, MatrixEvent | undefined>();
    for (const ev of server) if (ev.getId()) roots.set(ev.getId()!, ev);
    // the same plan as the timeline's (threads/rows.ts): tombstones, and every loaded event's ts for the receipts
    const plan = threadPlan(
      tl.events.map((ev) => evLike(ev, ev.isRedacted())),
      null,
    );
    const seen = plan.seen;
    for (const r of seen.keys()) if (!roots.has(r)) roots.set(r, room?.findEventById(r));
    // roots the room has loaded with a server summary, their replies not loaded (review #13: the header's dot)
    for (const ev of tl.events) {
      const id = ev.getId();
      if (id && !roots.has(id) && bundleOf(ev.event)) roots.set(id, ev);
    }
    const out: ListItem[] = [];
    for (const [root, ev0] of roots) {
      const ev = room?.findEventById(root) ?? ev0;
      if (ev && hiddenInChat(memIdx, chatMsgOf(ev))) continue;
      // the server copy carries the bundled summary (the room's copy may be older than its last reply)
      const bundle = bundleOf(ev0?.event) ?? bundleOf(ev?.event);
      const mineSeen = seen.get(root) ?? [];
      const sum = summarize(bundle, mineSeen, me);
      if (!sum) continue;
      const replies: ReplyRef[] = [...mineSeen];
      if (bundle && !replies.some((r) => r.id === bundle.latest.id)) replies.push({ ...bundle.latest });
      const known = [...[...plan.tsOf.entries()].map(([id, ts]) => ({ id, ts })), { id: root, ts: ev?.getTs() ?? 0 }, ...replies.map((r) => ({ id: r.id, ts: r.ts }))];
      const sender = ev?.getSender() ?? "";
      out.push({
        root,
        rootSender: sender,
        rootName: sender ? displayName(room, sender) : "",
        snippet: snippetOfEvent(ev) || "Message not loaded",
        count: sum.count,
        lastName: displayName(room, sum.lastSender),
        lastTs: sum.lastTs,
        unread: threadUnread(root, known, replies, me, receipts),
        mine: sum.mine,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, tl.version, tl.events, receiptsV, roomId, me, client, memIdx]);
  return { items, loading, error, more, loadMore: () => moreThreadPages(roomId) };
}

export function ThreadsPane({ roomId }: { roomId: string }) {
  const open = useThreadsPanel((st) => st.open[roomId] ?? null);
  const mobile = useIsMobile();
  const opener = useThreadsPanel((st) => st.opener);
  const focusEvent = useThreadsPanel((st) => st.focus[roomId] ?? "");
  const focusSeq = useThreadsPanel((st) => st.focusSeq);
  const listRef = useRef<HTMLDivElement>(null);
  const lastRoot = useRef<string | null>(null);
  const close = useCallback(() => {
    const root = open;
    setOpenThread(roomId, null);
    // focus back where the thread was opened from, else to its row in the list
    requestAnimationFrame(() => {
      if (opener && opener.isConnected) opener.focus();
      else if (root) listRef.current?.querySelector<HTMLElement>(`[data-root="${CSS.escape(root)}"]`)?.focus();
    });
  }, [roomId, open, opener]);
  // phones: back goes thread → list (the sheet's own back then closes the panel)
  // phone widths (a phone, or the panel overlaying the room): an open thread is a level of the back stack — Back closes
  // the thread first (to the list), then the panel, then the room (threadTakesBack; PM 2026-11-14 Android Back)
  const overlay = useRightPanelStore((st) => st.overlay);
  // level 1: the panel (level 0) and the thread may register in one commit (a notification / deep link opens both):
  // the inner one is still closed first (round 2 review)
  useBackToClose(threadTakesBack({ threadOpen: !!open, phone: mobile, overlay }), close, THREAD_BACK_LEVEL);
  useEffect(() => {
    lastRoot.current = open;
    // review (focus): an opened thread takes the keyboard — its composer — so Escape reaches the pane
    if (open) requestAnimationFrame(() => getView(`thread:${roomId}`)?.focusComposer());
  }, [open, roomId]);
  if (open) {
    return (
      <div
        className={s.pane}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className={s.threadHead}>
          <button type="button" className={s.back} onClick={close} aria-label="Back to threads">
            <Icon name="go-previous-symbolic" size={16} />
            <span>Threads</span>
          </button>
        </div>
        <div className={s.threadBody}>
          <ConversationView
            key={`${open}|${focusEvent}|${focusEvent ? focusSeq : 0}`}
            roomId={roomId}
            threadRoot={open}
            primary={false}
            viewKey={`thread:${roomId}`}
            mobile={mobile}
            eventId={focusEvent && focusEvent !== open ? focusEvent : undefined}
          />
        </div>
      </div>
    );
  }
  // keyed by room: another room's list never shows its roots or its pager (review)
  return <ThreadList key={roomId} roomId={roomId} listRef={listRef} />;
}

function ThreadList({ roomId, listRef }: { roomId: string; listRef: React.RefObject<HTMLDivElement | null> }) {
  const filter = useThreadsPanel((st) => st.filter);
  const me = useClient()?.getUserId() ?? "";
  const { items, loading, error, more, loadMore } = useThreadItems(roomId, true);
  const order = useMemo(() => threadList(items.map((i) => ({ root: i.root, rootSender: i.rootSender, lastTs: i.lastTs, mine: i.mine })), filter, me), [items, filter, me]);
  const byRoot = useMemo(() => new Map(items.map((i) => [i.root, i])), [items]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-root]") ?? [])];
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const last = rows.length - 1;
    const to = e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowDown" ? (i < 0 ? 0 : Math.min(last, i + 1)) : i < 0 ? last : Math.max(0, i - 1);
    e.preventDefault();
    rows[to].focus();
  };
  return (
    <div className={s.pane}>
      <div className={s.filters} role="group" aria-label="Which threads">
        <BasicButton text="All threads" checked={filter === "all"} onClick={() => setThreadsFilter("all")} className={s.filterBtn} />
        <BasicButton text="My threads" checked={filter === "mine"} onClick={() => setThreadsFilter("mine")} className={s.filterBtn} />
      </div>
      <div ref={listRef} className={s.list} role="list" aria-label="Threads" onKeyDown={onKey}>
        {order.map((root) => {
          const it = byRoot.get(root)!;
          const label = `${it.rootName}: ${it.snippet}. ${summaryText(it.count, it.lastName, it.lastTs, now)}${it.unread > 0 ? ". Unread replies" : ""}`;
          return (
            <div role="listitem" key={root}>
              <button type="button" className={cx(s.item, it.unread > 0 && s.itemUnread)} data-root={root} aria-label={label} onClick={(e) => setOpenThread(roomId, root, e.currentTarget)}>
                <Avatar size={28} name={it.rootName || "?"} seed={it.rootSender} className={s.itemAv} />
                <span className={s.itemMain} aria-hidden>
                  <span className={s.itemName}>{it.rootName}</span>
                  <span className={s.itemText}>{it.snippet}</span>
                  <span className={s.itemSum}>{summaryText(it.count, it.lastName, it.lastTs, now)}</span>
                </span>
                {it.unread > 0 && <span className={s.dot} aria-hidden />}
              </button>
            </div>
          );
        })}
        {more && (
          <div role="listitem">
            <button type="button" className={s.more} onClick={loadMore}>
              Load more threads
            </button>
          </div>
        )}
        {!order.length && (
          <div className={s.empty}>{loading ? "Loading threads…" : error ? "Couldn't load the threads" : filter === "mine" ? "You're not in any threads here yet" : "No threads here yet"}</div>
        )}
      </div>
    </div>
  );
}
