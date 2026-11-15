// threads/rows.ts — what threads change in the chat's rows (docs/THREADS.md), pure and SDK-free so the unit tests and
// the desktop's mirror (crates/app/src/threads_rows.rs) run the same cases. lib/model.ts buildRows calls it:
//   threadPlan   which thread each event is in, which events are rows in this view (main: thread replies leave;
//                a thread's panel: its own events only), and the replies seen per root
//   rootThread   the summary under a root in the main timeline (server bundle + seen replies, my unread count)
//   fallbackQuote  whether a thread message's m.in_reply_to is only the spec's fallback (no quote shown)
import type { MatrixEvent } from "matrix-js-sdk";
import { bundleOf, relationTarget, summarize, threadIds, threadOf, threadUnread, type MyReceipt, type ReplyRef } from "./core";

/** threads: the summary under a thread root in the main timeline. */
export interface ThreadInfo {
  count: number;
  lastSender: string;
  lastName: string;
  lastTs: number;
  /** newest first, up to 3 (the avatars) */
  repliers: { id: string; name: string }[];
  /** replies by others after my last receipt in this thread (core threadUnread) */
  unread: number;
  mine: boolean;
}

/** The facts the thread rules need from one event. */
export interface EvLike {
  id: string;
  sender: string;
  ts: number;
  /** the content as sent (an encrypted event keeps m.relates_to in the clear) */
  wire: unknown;
  redacted: boolean;
  /** the raw event (its unsigned m.relations bundle) */
  raw: unknown;
}

export function evLike(ev: MatrixEvent, redacted: boolean): EvLike {
  return { id: ev.getId() ?? ev.getTxnId() ?? "", sender: ev.getSender() ?? "", ts: ev.getTs(), wire: ev.getWireContent() ?? ev.getContent(), redacted, raw: ev.event };
}

export interface ThreadPlan {
  /** per event: its thread ("" = main) */
  tids: string[];
  /** per event: shown in this view */
  inView: boolean[];
  /** main view: per root, the replies seen (direct m.thread events) */
  seen: Map<string, ReplyRef[]>;
  /** every event's ts (a receipt reads up to its event's ts when that event is loaded, review #5) */
  tsOf: Map<string, number>;
}

/** In a thread's view: its own events, the root, and what relates to the root itself (its reactions and edits). */
function inThreadView(id: string, tid: string, wire: unknown, root: string): boolean {
  return tid === root || id === root || (tid === "" && relationTarget(wire) === root);
}

/** The thread each event was last seen in: js-sdk strips a redacted event's relation (MSC3389 isn't in any room version
 *  yet), so a reply deleted while loaded would fall into the main timeline as a stray "deleted" row. The desktop keeps
 *  the relation when it stamps the redaction (room.rs stamp_redacted). Bounded. */
const lastThread = new Map<string, string>();

/** view null = the main timeline, a root = that thread's panel. */
export function threadPlan(evs: EvLike[], view: string | null): ThreadPlan {
  const tids = threadIds(evs.map((e) => ({ event_id: e.id, content: e.wire })));
  evs.forEach((e, i) => {
    if (tids[i] !== "") {
      if (!lastThread.has(e.id) && lastThread.size > 20000) lastThread.clear();
      lastThread.set(e.id, tids[i]);
    } else if (e.redacted && lastThread.has(e.id)) tids[i] = lastThread.get(e.id)!;
  });
  const inView = evs.map((e, i) => (view === null ? tids[i] === "" : inThreadView(e.id, tids[i], e.wire, view)));
  const tsOf = new Map<string, number>();
  for (const e of evs) tsOf.set(e.id, e.ts);
  const seen = new Map<string, ReplyRef[]>();
  if (view === null)
    evs.forEach((e, i) => {
      // a deleted reply whose relation js-sdk stripped still counts as its thread's tombstone (round 2 #6)
      const root = threadOf(e.wire) || (e.redacted && tids[i] !== "" && relationTarget(e.wire) === "" ? tids[i] : "");
      if (!root) return;
      const r: ReplyRef = { id: e.id, sender: e.sender, ts: e.ts, redacted: e.redacted };
      const l = seen.get(root);
      if (l) l.push(r);
      else seen.set(root, [r]);
    });
  return { tids, inView, seen, tsOf };
}

/** The summary under a root (null = no thread on it). */
export function rootThread(
  root: EvLike,
  seen: Map<string, ReplyRef[]>,
  me: string,
  receipts: MyReceipt[],
  nameOf: (userId: string) => string,
  tsOf: Map<string, number> = new Map(),
): ThreadInfo | null {
  const mine0 = seen.get(root.id) ?? [];
  const bundle = bundleOf(root.raw);
  const sum = summarize(bundle, mine0, me);
  if (!sum) return null;
  const replies: ReplyRef[] = [...mine0];
  if (bundle && !replies.some((r) => r.id === bundle.latest.id)) replies.push({ ...bundle.latest });
  const known = [...[...tsOf.entries()].map(([id, ts]) => ({ id, ts })), { id: root.id, ts: root.ts }, ...replies.map((r) => ({ id: r.id, ts: r.ts }))];
  return {
    count: sum.count,
    lastSender: sum.lastSender,
    lastName: nameOf(sum.lastSender),
    lastTs: sum.lastTs,
    repliers: sum.repliers.map((u) => ({ id: u, name: nameOf(u) })),
    unread: threadUnread(root.id, known, replies, me, receipts),
    mine: sum.mine,
  };
}

/** A thread message's m.in_reply_to with is_falling_back is only for clients without threads: no quote. */
export function fallbackQuote(threadId: string, rel: Record<string, unknown> | null | undefined): boolean {
  return threadId !== "" && rel?.is_falling_back === true;
}

function wire(ev: MatrixEvent): unknown {
  return ev.getWireContent() ?? ev.getContent();
}

/** The thread's events in display order: the room's and the fetched ones merged by id (the room's copy wins: it
 *  carries live redactions and edits), sorted by ts, local echoes last. */
export function mergeThread(root: string, roomEvents: MatrixEvent[], pending: MatrixEvent[], fetched: MatrixEvent[], rootEv: MatrixEvent | null): MatrixEvent[] {
  const byId = new Map<string, MatrixEvent>();
  for (const ev of fetched) {
    const id = ev.getId();
    if (id) byId.set(id, ev);
  }
  if (rootEv?.getId()) byId.set(rootEv.getId()!, rootEv);
  for (const ev of roomEvents) {
    const id = ev.getId();
    if (id) byId.set(id, ev);
  }
  const all = [...byId.values()];
  const ids = threadIds(all.map((e) => ({ event_id: e.getId() ?? "", content: wire(e) })));
  const keep = all.filter((e, i) => inThreadView(e.getId() ?? "", ids[i], wire(e), root));
  keep.sort((a, b) => (a.getTs() !== b.getTs() ? a.getTs() - b.getTs() : (a.getId() ?? "") < (b.getId() ?? "") ? -1 : 1));
  // a local echo is in the thread when its own relation (or its target's) says so
  const pend = pending.length ? threadIds([...keep, ...pending].map((e) => ({ event_id: e.getId() ?? e.getTxnId() ?? "", content: wire(e) }))).slice(keep.length) : [];
  return [...keep, ...pending.filter((_, i) => pend[i] === root)];
}

/** threads/receipts.ts: js-sdk 42's synthesizeReceipt (models/read-receipt) builds its receipt event with the room's id;
 *  sync's ephemeral events (the server's receipts, and the cached sync replayed) are mapped without one. */
export function isSynthetic(ev: MatrixEvent): boolean {
  return !!ev.getRoomId();
}
