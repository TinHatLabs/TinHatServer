// ConversationView.tsx — ConversationView.qml: the timeline (rows, grouping, day pills, NEW divider
// freeze, receipts, pagination with anchoring, bottom pinning + settle, wheel easing, jump chip, fox
// scroll bar, empty/loading/error states) + the composer. Reused by the main room page (primary) and
// floating chats (primary = false: no typing notices, receipts only while the main view isn't
// attending that room).
// 11.0 (islands C6/C7, `composerHost`): the desktop dock host's timeline island holds this view; its composer section
// renders into the composer island (Composer `portal`) — one view, two frames (ISLANDS-ARCH §0.9). The island draws the
// fill, so the view paints no background there; the divider above the typing strip stays (ConversationView.qml).
// Row window (web-perf-2): only a window of the loaded rows is in the DOM — the newest WIN_INIT at the end, grown by
// WIN_STEP from memory as the reader scrolls up (before the server is asked for older pages), capped at WIN_MAX with the
// far side trimmed; jumps, permalinks, the scroll memory and Home/End move the window first. The native ListView only
// creates the delegates it shows, so this is the same behaviour; without it a room kept every row it had shown (~17 DOM
// nodes / ~45–50 KB of heap per message) and a phone's first open of a 750-row room mounted all of them in one 3.6 s task.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { peekClient, useClient, useDmPeer, useIsDirect, useMember, useRoomState, liveTimelineChain, provisionOnOpen } from "@/core/matrix";
import { DM_WAITING_EXPLAIN, dmWaitingLine } from "@/features/nav/firstrun";
import { bus, useBus } from "@/core/bus";
import { useRegistry, menuValue, type MessageMenuCtx } from "@/core/registry";
import { usePref } from "@/core/prefs";
import { playUiSound } from "@/core/sounds";
import { useIsTouch } from "@/core/device";
import { BusyIndicator, Button, ConfirmDialog, DUR, EmptyState, Icon, Menu, MenuItem, MenuSeparator, SubMenu, animate, cx, useTip, type Rect } from "@/ui";
import { ChatBubble, canThread, type BubbleHandlers, type ReceiptUser } from "./ChatBubble";
import { Composer, type ComposerHandle } from "./Composer";
import { EmojiPicker } from "./EmojiPicker";
import { LightboxView } from "./Lightbox";
import * as settingsFeature from "@/features/settings";
import { useConvToast } from "./convToast";
import { buildRows, displayName, isDiceRow, isInteractive, type Row } from "./lib/model";
import { HAS_CHAT_SAMPLES, sampleEvents } from "./lib/samples";
import { dayLabel, sameDay } from "./lib/format";
import { newLineHint, newLineStart, newPillShown } from "./lib/catchup";
import { useRoomTimeline } from "./useRoomTimeline";
import { HEAD, TAIL, WIN_INIT, WIN_MAX, WIN_STEP, windowAround, windowNewer, windowOlder, windowRange, type RowWindow } from "./lib/rowwindow";
import { registerView, useChatStore } from "./store";
import { canPin, canRedactOthers, copyText, deleteLocal, redactMessage, retryLocal, markReadPosition, markThreadReadPosition, saveMedia, setPinned, toggleReaction } from "./actions";
import { useThreadTimeline } from "./threads/useThreadTimeline";
import { myReceipts, onThreadReceipts, receiptsVersion } from "./threads/receipts";
import { mainReceiptTarget, threadOf } from "./threads/core";
import { openThreadPanel } from "./threads/open";
import { mainFocusHeld } from "./threads/focusIntent";
import { mayDelete } from "./lib/deleteRule";
import { shareLinkNow } from "@/core/server";
import s from "./Conversation.module.css";
import { AmbienceLayer } from "./ambience/layer";
import { useBackgroundImage, useRoomBackground } from "./ambience/room";
import { useGameArt } from "./gamebg";

export interface ConversationViewProps {
  roomId: string;
  /** main room page (typing notices, autofocus, the reading view); false = floating chat */
  primary?: boolean;
  floating?: boolean;
  /** jump to this event once loaded (permalinks) */
  eventId?: string;
  mobile?: boolean;
  /** hidden by "fill the app" */
  hidden?: boolean;
  /** key for the host API (main = "main") */
  viewKey?: string;
  /** 11.0: the composer island's element (the composer section renders there); undefined = the composer sits under the
   *  timeline as before (floating chats, phones); null = the island is not there yet */
  composerHost?: HTMLElement | null;
  /** 10.8 Flat layout: the composer box draws its own card in the (flat) composer island */
  boxCard?: boolean;
  /** threads (docs/THREADS.md): show this thread (its root) instead of the room's main timeline — the Threads panel */
  threadRoot?: string;
  className?: string;
  style?: CSSProperties;
}

/** Keyed by room: one instance per open room (memory saved on unmount, restored on mount). */
export function ConversationView(p: ConversationViewProps) {
  return <Conversation key={p.threadRoot ? `${p.roomId}#${p.threadRoot}` : p.roomId} {...p} />;
}

const REACT_KEYS = ["👍", "❤️", "😂", "🔥", "🎉", "🦊"];

const dbg = (() => {
  try {
    const q = new URLSearchParams(location.search + "&" + (location.hash.split("?")[1] ?? ""));
    return q.get("debug") ?? "";
  } catch {
    return "";
  }
})();

function Conversation({ roomId, primary = true, floating = false, eventId, mobile = false, hidden = false, viewKey, className, style, composerHost, boxCard, threadRoot }: ConversationViewProps) {
  const inIsland = composerHost !== undefined;
  const client = useClient();
  const me = client?.getUserId() ?? "";
  const room = client?.getRoom(roomId) ?? null;
  const touch = useIsTouch();
  // threads: a thread's panel runs on that thread's events (root + replies), the main view on the room's timeline
  const roomTl = useRoomTimeline(threadRoot ? null : roomId);
  const threadTl = useThreadTimeline(threadRoot ? roomId : null, threadRoot ?? null);
  const tl = threadRoot ? threadTl : roomTl;
  const memKey = threadRoot ? `${roomId}#thread:${threadRoot}` : roomId;
  // threads: my receipts per thread (the summaries' unread dots)
  const receiptsV = useSyncExternalStore(onThreadReceipts, receiptsVersion, receiptsVersion);
  const uploads = useChatStore((st) => st.uploads);
  const roomUploads = useMemo(() => uploads.filter((u) => u.roomId === roomId), [uploads, roomId]);
  const pinnedState = useRoomState<{ pinned?: string[] }>(roomId, "m.room.pinned_events");
  const pinned = useMemo(() => (Array.isArray(pinnedState?.pinned) ? pinnedState!.pinned! : []), [pinnedState]);
  const clock = String(usePref("clock", "system"));
  const notify = useConvToast();
  const [localLb, setLocalLb] = useState<{ src: string; name?: string } | null>(null);
  const myName = room?.getMember(me)?.rawDisplayName ?? "";

  // rows keep their object identity while nothing visible changed, so memo'd bubbles skip re-rendering
  const rowCache = useRef(new Map<string, { sig: string; row: Row }>());
  const rows = useMemo(() => {
    // the gates' sample rows (widgets W3, debug flag + ?chatsamples=…): local events after the real ones, never sent
    const events = HAS_CHAT_SAMPLES ? [...tl.events, ...sampleEvents(roomId, me)] : tl.events;
    const fresh = buildRows({ room, me, myName, events, uploads: roomUploads, pinned, threads: { view: threadRoot ?? null, receipts: myReceipts(roomId) } });
    const next = new Map<string, { sig: string; row: Row }>();
    const out = fresh.map((r) => {
      const sig = rowSig(r);
      const old = rowCache.current.get(r.id);
      const keep = old && old.sig === sig ? old.row : r;
      next.set(r.id, { sig, row: keep });
      return keep;
    });
    rowCache.current = next;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl.version, tl.events, roomUploads, pinned, me, myName, room, threadRoot, receiptsV]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const threadTlRef = useRef(threadTl);
  threadTlRef.current = threadTl;
  const tlRef = useRef(tl);
  tlRef.current = tl;

  // CHAT-83: the first load failed and nothing is cached → error state; retried every 5 s
  const [loadError, setLoadError] = useState("");

  // ---- geometry
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // the room's shared background (docs/AMBIENCE.md): the scene everywhere, its particles only in the main view
  const roomBg = useRoomBackground(roomId);
  const roomBgImg = useBackgroundImage(roomId, roomBg);
  const gameArt = useGameArt(roomId, !hidden); // sun-gamebg: the game people here play, where the room set no background
  // a hidden conversation (display: none) runs nothing
  const shownBg = useMemo(() => (primary && !floating && !hidden ? roomBg : { ...roomBg, effect: "none" as const }), [roomBg, primary, floating, hidden]);
  const getContent = useCallback(() => content.current, []);
  const getScroller = useCallback(() => scroller.current, []);
  const [viewW, setViewW] = useState(1200);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const stick = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const expectTop = useRef<number | null>(null);
  const settleUntil = useRef(0);
  const anim = useRef<{ raf: number; target: number } | null>(null);

  // ---- the row window (web-perf-2): the scroll memory's row when the room reopens scrolled up, else the newest rows
  const [win, setWin] = useState<RowWindow>(() => {
    const mem = useChatStore.getState().memory[memKey];
    if (mem && !mem.atBottom && mem.topId) {
      const i = rows.findIndex((r) => r.id === mem.topId);
      if (i >= 0) return windowAround(rows, i);
    }
    return TAIL;
  });
  // the default window follows the newest rows only while the view is stuck to the end; scrolled up, its first row
  // stays put (new messages must not pull rows out from above the reader)
  const tailStart = useRef<string | null>(null);
  let effWin = win;
  if (win.start === null && !stick.current && tailStart.current && rows.some((r) => r.id === tailStart.current)) effWin = { start: tailStart.current, end: win.end };
  // the row holding the keyboard focus (read from the DOM of the last commit, so a removed row never counts): the
  // default window never moves past it
  const focusedId = effWin.start === null ? focusedRowId(content.current) : null;
  if (effWin.start === null && focusedId) {
    const fi = rows.findIndex((r) => r.id === focusedId);
    if (fi >= 0 && fi < windowRange(rows, effWin)[0]) effWin = { start: fi === 0 ? HEAD : rows[fi].id, end: effWin.end };
  }
  const [winStart, winEnd] = windowRange(rows, effWin);
  if (win.start === null) tailStart.current = rows[winStart]?.id ?? null;
  const shown = useMemo(() => rows.slice(winStart, winEnd), [rows, winStart, winEnd]);
  const tailHidden = winEnd < rows.length;
  const winRef = useRef(effWin);
  winRef.current = effWin;
  const storedWin = useRef(win); // the stored window (callbacks of earlier renders read it)
  storedWin.current = win;
  const tailHiddenRef = useRef(tailHidden);
  tailHiddenRef.current = tailHidden;
  /** after the next render: centre this row (a jump into rows outside the window) / go to the top (Home) */
  const pendingCentre = useRef<string | null>(null);
  const pendingTop = useRef(false);
  /** after the next render: the keyboard's message focus (onLogKey moved the window) */
  const pendingFocus = useRef<{ to: "first" | "last" | "before" | "after"; from: string } | null>(null);

  const rowW = Math.max(0, viewW - 16);
  const maxBubble = Math.max(120, Math.floor(rowW * (mobile ? 0.84 : 0.74)));
  // icon-only Send below 360 px (CV:1791); floating chats need it earlier so nothing clips (D7/Q4)
  const narrow = viewW < (floating ? 460 : 360);

  // ---- attending / reader (3.5)
  const [focused, setFocused] = useState(() => document.visibilityState === "visible" && document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(document.visibilityState === "visible" && document.hasFocus());
    window.addEventListener("focus", on);
    window.addEventListener("blur", on);
    document.addEventListener("visibilitychange", on);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", on);
      document.removeEventListener("visibilitychange", on);
    };
  }, []);
  const attending = focused && !hidden;
  useEffect(() => {
    if (!primary) return;
    useChatStore.setState({ mainRoom: roomId, mainAttending: attending });
    return () => {
      if (useChatStore.getState().mainRoom === roomId) useChatStore.setState({ mainRoom: null, mainAttending: false });
    };
  }, [primary, roomId, attending]);
  // tell the notifier (settings' setAttending, when present) which views show which room (3.5)
  useEffect(() => {
    const set = (settingsFeature as unknown as Record<string, unknown>).setAttending as ((token: string, roomId: string | null) => void) | undefined;
    if (!set) return;
    const token = viewKey ?? (primary ? "main" : `float:${roomId}`);
    set(token, attending ? roomId : null);
    return () => set(token, null);
  }, [attending, roomId, primary, viewKey]);
  const mainShowsIt = useChatStore((st) => st.mainRoom === roomId && st.mainAttending);
  // threads: a thread's panel reads its own thread (thread receipts), whatever the main view shows
  const reader = primary || !!threadRoot || !mainShowsIt;
  const readerRef = useRef(reader && attending);
  readerRef.current = reader && attending;

  // a permalink open must not mark the room read before the jump has happened
  const permalinkPending = useRef(!!eventId);
  const markRead = useCallback(() => {
    if (!readerRef.current || permalinkPending.current) return;
    const r = peekClient()?.getRoom(roomId);
    if (!r) return;
    if (threadRoot) {
      // threads (MSC3771): this thread's receipt on its newest event
      const evs = threadTlRef.current.events;
      for (let i = evs.length - 1; i >= 0; i--) {
        const id = evs[i].getId();
        if (id && !id.startsWith("~") && evs[i].status == null) {
          // the root itself sits in the main timeline (a thread receipt on it would be refused): nothing to read yet
          if (id !== threadRoot) markThreadReadPosition(roomId, threadRoot, evs[i]);
          return;
        }
      }
      return;
    }
    // threads (MSC3771): the main timeline's receipt ("main") on its newest event that is NOT in a thread
    const evs = liveTimelineChain(r).events.filter((e) => {
      const id = e.getId();
      return !!id && !id.startsWith("~");
    });
    const target = mainReceiptTarget(evs.map((e) => ({ event_id: e.getId()!, content: e.getWireContent() ?? e.getContent() })));
    const ev = target ? evs.find((e) => e.getId() === target) : undefined;
    if (ev) markReadPosition(roomId, ev);
  }, [roomId, threadRoot]);

  // ---- NEW divider freeze (3.1 step 8 + 3.2)
  // waiting (A35.1): the line is above everything loaded; seen (P2 a): it has been on screen since the room opened;
  // hunting: "Jump to NEW" is loading older pages to find it
  const nw = useRef<{ frozen: boolean; marker: string; hint: number; tail: string; divider: string; settled: boolean; waiting: boolean; seen: boolean; hunting: boolean }>({
    frozen: false,
    marker: "",
    hint: 0,
    tail: "",
    divider: "",
    settled: false,
    waiting: false,
    seen: false,
    hunting: false,
  });
  const [, setNewTick] = useState(0);
  if (!nw.current.frozen && room && (rows.length > 0 || !tl.canBack)) {
    nw.current.frozen = true;
    // threads: a thread's panel has no NEW divider (the main receipt doesn't describe it)
    nw.current.marker = threadRoot ? "" : (room.getEventReadUpTo(me) ?? "");
    nw.current.hint = newLineHint(threadRoot ?? "", room.getUnreadNotificationCount() ?? 0);
    const real = rows.filter((r) => !r.echo);
    nw.current.tail = real.length ? real[real.length - 1].id : "";
  }
  const recomputeDivider = () => {
    const n = nw.current;
    if (!n.frozen || n.divider || n.settled) return;
    const rs = rows;
    if (!rs.length) return;
    // only rows up to the freeze-time tail are candidates — and the unread count is measured from there too (review:
    // messages arriving meanwhile must not count as the older unread ones)
    let end = rs.length;
    if (n.tail) {
      let li = -1;
      for (let i = rs.length - 1; i >= 0; i--)
        if (rs[i].id === n.tail) {
          li = i;
          break;
        }
      end = li >= 0 ? li + 1 : rs.length;
    }
    let start = -1;
    if (n.marker) {
      start = rs.findIndex((r) => r.id === n.marker);
      if (start < 0) {
        // the receipt may rest on a non-row event: find the row just before it in the timeline
        const evs = tl.events;
        const mi = evs.findIndex((e) => e.getId() === n.marker);
        if (mi >= 0) {
          const ids = new Set(rs.map((r) => r.id));
          start = -1;
          for (let i = mi; i >= 0; i--) {
            const id = evs[i].getId();
            if (id && ids.has(id)) {
              start = rs.findIndex((r) => r.id === id);
              break;
            }
          }
          if (start < 0 && mi >= 0) start = -1;
        } else {
          const s0 = newLineStart(end, n.hint, tl.canBack);
          if (s0 === null) return;
          if (s0 === "more") {
            n.waiting = true; // A35.1
            return;
          }
          start = s0;
        }
      }
    } else {
      // no read marker at all: the same rule (A35.1 review: it used to call the whole loaded window new)
      const s1 = newLineStart(end, n.hint, tl.canBack);
      if (s1 === null) return;
      if (s1 === "more") {
        n.waiting = true;
        return;
      }
      start = s1;
    }
    for (let j = start + 1; j < end; j++) {
      if (rs[j].sender !== me && !rs[j].echo) {
        n.divider = rs[j].id;
        n.waiting = false;
        return;
      }
    }
    n.waiting = false;
    if (n.tail) n.settled = true;
  };
  recomputeDivider();
  const dividerId = nw.current.divider;

  // ---- receipts ("Seen by", newest 30 rows)
  const receipts = useMemo(() => {
    const out = new Map<string, ReceiptUser[]>();
    if (!room) return out;
    const evs = tl.events;
    const rowIds = new Set(rows.slice(-30).filter((r) => !r.echo).map((r) => r.id));
    if (!rowIds.size) return out;
    const nearest = new Map<string, string>();
    // A35.5: only the tail from the oldest of those rows on (it walked the whole loaded timeline per receipt)
    let from = evs.length;
    for (let i = evs.length - 1, found = 0; i >= 0 && found < rowIds.size; i--)
      if (rowIds.has(evs[i]!.getId() ?? "")) {
        from = i;
        found++;
      }
    let last = "";
    for (let i = from; i < evs.length; i++) {
      const id = evs[i]!.getId() ?? "";
      if (rowIds.has(id)) last = id;
      if (last) nearest.set(id, last);
    }
    for (const m of room.getJoinedMembers()) {
      if (m.userId === me) continue;
      const up = room.getEventReadUpTo(m.userId, true);
      if (!up) continue;
      const rid = nearest.get(up);
      if (!rid) continue;
      const list = out.get(rid) ?? [];
      list.push({ userId: m.userId, name: m.name || m.userId, avatar: m.getMxcAvatarUrl() ?? null });
      out.set(rid, list);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl.version, tl.receiptsVersion, rows, room, me]);

  // ---- scrolling primitives
  const nearBottom = () => {
    const el = scroller.current;
    if (!el) return true;
    if (tailHiddenRef.current) return false; // newer rows are outside the window: the end of the DOM is not the end
    return el.scrollHeight <= el.clientHeight || el.scrollTop >= el.scrollHeight - el.clientHeight - 36;
  };
  const setTop = (v: number) => {
    const el = scroller.current;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const t = Math.max(0, Math.min(max, v));
    if (Math.abs(el.scrollTop - t) < 0.5) return;
    expectTop.current = t;
    el.scrollTop = t;
  };
  const toEnd = () => {
    const el = scroller.current;
    if (el) setTop(el.scrollHeight);
  };
  const stopAnim = () => {
    if (anim.current) cancelAnimationFrame(anim.current.raf);
    anim.current = null;
  };
  // the scroll glide takes the `slow` duration step (GPU.md §1: one duration token; 0 = a jump while the motion
  // switch is off — unfocused, hidden or Reduce motion)
  const animateTo = (target: number, ms = DUR.slow) => {
    const el = scroller.current;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    target = Math.max(0, Math.min(max, target));
    stopAnim();
    const from = el.scrollTop;
    const t0 = performance.now();
    const step = (t: number) => {
      // read the switch every frame: a glide in flight jumps to its end the moment the window loses the focus
      const k = !animate() ? 1 : Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setTop(from + (target - from) * e);
      if (anchor.current) anchor.current = topRowProbe(); // keep a pending older-page anchor current
      if (k < 1) anim.current = { raf: requestAnimationFrame(step), target };
      else {
        anim.current = null;
        afterUserScroll();
      }
    };
    anim.current = { raf: requestAnimationFrame(step), target };
  };

  // The row under the list's top edge (or the first one below it, in a gap between rows) + its offset —
  // the native _topIndexProbe (ListView.indexAt), by GEOMETRY. It used to hit-test (elementFromPoint),
  // which answers with whatever is painted on top: leaving a room through the quick switcher probes
  // while its full-window veil is still up, found no row and fell back to the FIRST loaded row, so the
  // room reopened at the top of its loaded history instead of where the reader was (fix/timeline
  // review 2026-09-24; the same for any overlay or the history spinner over the top edge).
  const topRowProbe = (): { id: string; offset: number } | null => {
    const el = scroller.current;
    const c = content.current;
    if (!el || !c) return null;
    const top = el.getBoundingClientRect().top;
    const rows = c.querySelectorAll<HTMLElement>(":scope > [data-row-id]");
    if (!rows.length) return null;
    // rows are stacked top → bottom: binary-search the first whose bottom is below the top edge
    let lo = 0;
    let hi = rows.length - 1;
    let hit = rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom > top + 2) {
        hit = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const r = rows[hit];
    return { id: r.dataset.rowId!, offset: r.getBoundingClientRect().top - top };
  };

  /** index (in rows) of the row holding the focus, -1 = none: a window step never trims it out of the DOM */
  const focusedRow = (): number => {
    const a = document.activeElement as HTMLElement | null;
    const c = content.current;
    if (!a || !c || !c.contains(a)) return -1;
    const id = a.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    return id ? rowsRef.current.findIndex((r) => r.id === id) : -1;
  };
  /** older rows from memory into the window (anchored like an older page); false = none left in memory */
  const revealOlder = (): boolean => {
    const next = windowOlder(rowsRef.current, winRef.current, focusedRow());
    if (!next) return false;
    if (!anchor.current) anchor.current = topRowProbe();
    winRef.current = next;
    setWin(next);
    return true;
  };
  /** newer rows into the window while the tail is hidden and the reader nears the end of the DOM */
  const maybeRevealNewer = () => {
    const el = scroller.current;
    if (!el || !tailHiddenRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 1.5 * el.clientHeight) return;
    const next = windowNewer(rowsRef.current, winRef.current, focusedRow());
    if (!next) return;
    if (!anchor.current) anchor.current = topRowProbe();
    winRef.current = next;
    setWin(next);
  };
  /** the newest rows again (jump to the latest, a send); the window shrinks back to WIN_INIT */
  const showTail = () => {
    const [st, en] = windowRange(rowsRef.current, winRef.current);
    if (storedWin.current.start === null && storedWin.current.end === null && en - st <= WIN_INIT) return;
    winRef.current = TAIL;
    setWin({ ...TAIL }); // a new object: re-render even when the stored window was already TAIL (a frozen start)
  };
  /** index (in rows) of the last row whose top is above the list's bottom edge, -1 = none */
  const bottomRow = (): number => {
    const el = scroller.current;
    const c = content.current;
    if (!el || !c) return -1;
    const bottom = el.getBoundingClientRect().bottom;
    const rs = c.querySelectorAll<HTMLElement>(":scope > [data-row-id]");
    let lo = 0;
    let hi = rs.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid].getBoundingClientRect().top < bottom) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const id = hit >= 0 ? rs[hit].dataset.rowId : undefined;
    return id ? rowsRef.current.findIndex((r) => r.id === id) : -1;
  };
  /** scrolled up while rows arrive: keep the window ≤ WIN_MAX by hiding the newest rows (below the screen) */
  const trimNewer = () => {
    const rs = rowsRef.current;
    const [st, en] = windowRange(rs, winRef.current);
    if (en - st <= WIN_MAX) return;
    const keep = Math.max(focusedRow(), bottomRow());
    const ne = Math.max(st + WIN_MAX - WIN_STEP, keep + WIN_STEP + 1);
    if (ne >= en) return;
    const next: RowWindow = { start: st === 0 ? HEAD : rs[st].id, end: rs[ne - 1].id };
    winRef.current = next;
    setWin(next);
  };

  // when the last older-page load FAILED (performance.now()); -Infinity = never. It was useRef(0) —
  // "failed at page start" — which muted the first-page fill below for the first 5 s after every page
  // load: a room opened then (the desktop's last-room restore, a phone tapping a room right after iOS
  // reloaded the tab) kept the ≤10 events the sync cache holds and never loaded more — a blank room when
  // those were not message rows, and on touch nothing to scroll that could have asked for more.
  const lastFail = useRef(Number.NEGATIVE_INFINITY);
  /** `auto` = the first-page fill (retried quietly every 5 s); a scroll-driven load toasts its failure. */
  const loadOlder = useCallback(async (auto = false) => {
    if (!tl.canBack || tl.loadingBack) return;
    if (revealOlder()) return; // older rows still in memory above the window: those first (the error retry, the fill)
    anchor.current = topRowProbe();
    {
      // the page lands above the first loaded row: show it (HEAD), keep the window ≤ WIN_MAX once it is there
      const rs = rowsRef.current;
      const [, end] = windowRange(rs, winRef.current);
      const keep = focusedRow();
      const ne = end > WIN_MAX - WIN_STEP ? Math.max(WIN_MAX - WIN_STEP, keep + 1) : end;
      const next: RowWindow = { start: HEAD, end: ne >= rs.length ? null : rs[ne - 1].id };
      if (next.start !== winRef.current.start || next.end !== winRef.current.end) {
        winRef.current = next;
        setWin(next);
      }
    }
    const r = await tl.paginate(50);
    if (r === "error") {
      lastFail.current = performance.now();
      anchor.current = null;
      if (rowsRef.current.length === 0) setLoadError("Couldn't reach the server — showing what's cached. Trying again…");
      else if (!auto) notify("Couldn't load older messages — scroll up to try again");
    } else setLoadError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl.canBack, tl.loadingBack, tl.paginate]);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  const maybeLoadOlder = () => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollTop >= 1.5 * el.clientHeight) return;
    if (revealOlder()) return;
    if (performance.now() - lastFail.current > 1500) void loadOlderRef.current();
  };

  const afterUserScroll = () => {
    stick.current = nearBottom();
    setAtBottom(stick.current);
    if (stick.current) {
      setNewBelow(0);
      markRead();
      const [st, en] = windowRange(rowsRef.current, winRef.current);
      if (en - st > WIN_MAX && focusedRow() < 0) showTail();
    }
    rememberTop();
    maybeLoadOlder();
    maybeRevealNewer();
  };
  const rememberTop = (atBottom = stick.current) => {
    const t = atBottom ? null : topRowProbe();
    const cur = useChatStore.getState().memory[memKey];
    useChatStore.setState((st) => ({
      memory: { ...st.memory, [memKey]: { ...(cur ?? { draft: "", replyToId: "", replyToBody: "", replyToName: "", staged: [] }), atBottom, topId: t?.id ?? "" } },
    }));
  };

  const jumpToLatest = useCallback(() => {
    stopAnim();
    showTail();
    stick.current = true;
    setAtBottom(true);
    toEnd();
    setNewBelow(0);
    markRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markRead]);
  // 11.0 buttons: "Jump to the latest message" from a button of your own or the Ctrl+K palette (features/actions)
  useBus("openSurface", (p) => {
    if (p.id === "jumpToLatest" && primary && !floating) jumpToLatest();
  });

  const flash = (id: string) => {
    setFlashId(id);
    window.setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1600);
  };
  const centreRow = (id: string): boolean => {
    const el = scroller.current;
    const row = el?.querySelector(`[data-row-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (el && !row) {
      const i = rowsRef.current.findIndex((r) => r.id === id);
      if (i < 0) return false;
      // loaded but outside the window: move the window there; the rows layout effect centres it after the render
      settleUntil.current = 0;
      stick.current = false;
      setAtBottom(false);
      pendingCentre.current = id;
      const next = windowAround(rowsRef.current, i);
      winRef.current = next;
      setWin(next);
      return true;
    }
    if (!el || !row) return false;
    settleUntil.current = 0;
    stick.current = false;
    setAtBottom(false);
    const r = row.getBoundingClientRect();
    const v = el.getBoundingClientRect();
    setTop(el.scrollTop + (r.top - v.top) - (v.height - r.height) / 2);
    flash(id);
    return true;
  };
  const jumpTo = useCallback(
    async (id: string) => {
      if (centreRow(id)) return;
      // threads (review #16): a message in a thread never shows in the main timeline — open its thread instead
      if (!threadRoot) {
        const t = await threadRootOf(roomId, id);
        if (t) {
          // the thread opens centred on that reply
          openThreadPanel(roomId, t, null, id);
          return;
        }
      }
      // look a few pages back for it ("Older than what's loaded — click to look for it")
      for (let i = 0; i < 6; i++) {
        const r0 = peekClient()?.getRoom(roomId);
        // a thread's view pages its own thread (useThreadTimeline), the main view the room's chain
        if (!r0 || !(threadRoot ? tlRef.current.canBack : liveTimelineChain(r0).canBack)) break;
        // a page already on its way (the thread's first fetch): wait for it instead of counting it (review)
        for (let w = 0; w < 100 && tlRef.current.loadingBack; w++) await new Promise((res) => setTimeout(res, 100));
        const r = await tl.paginate(100);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        if (rowsRef.current.some((x) => x.id === id)) {
          requestAnimationFrame(() => centreRow(id));
          return;
        }
        if (r !== "ok") break;
      }
      notify("That message isn't loaded — scroll up to find it");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomId, tl.paginate, threadRoot],
  );

  // P2 a: "Jump to NEW" — centre the NEW line; when it waits for older history (A35.1), load older pages until it
  // lands (at most 6 pages of 100), then jump. Seen once it has been jumped to.
  const markNewSeen = () => {
    if (nw.current.seen) return;
    nw.current.seen = true;
    setNewTick((x) => x + 1);
  };
  // the hunt stops when the view goes away (a room switch / close): no more pages fetched for a view that is gone
  const huntAlive = useRef(true);
  useEffect(() => {
    huntAlive.current = true;
    return () => {
      huntAlive.current = false;
    };
  }, [roomId]);
  const jumpToNew = async () => {
    const n = nw.current;
    if (n.divider && centreRow(n.divider)) return markNewSeen();
    if (n.hunting) return;
    n.hunting = true;
    setNewTick((x) => x + 1);
    let ended = false;
    try {
      for (let i = 0; i < 6 && !n.divider && n.waiting && huntAlive.current; i++) {
        const r0 = peekClient()?.getRoom(roomId);
        if (!r0 || !liveTimelineChain(r0).canBack) {
          ended = true;
          break;
        }
        const r = await tl.paginate(100);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        if (r === "end") ended = true;
        if (r !== "ok") break;
      }
    } finally {
      n.hunting = false;
    }
    if (!huntAlive.current) return;
    setNewTick((x) => x + 1);
    if (n.divider) {
      requestAnimationFrame(() => {
        if (huntAlive.current && n.divider && centreRow(n.divider)) markNewSeen();
      });
      return;
    }
    // the history ended without a line: nothing to find; else (6 pages, or a page failed) the pill stays for another try
    if (ended || !n.waiting) markNewSeen();
    else notify("The NEW line is further back — scroll up to find it");
  };
  // P2 a: the NEW line's row is on screen: seen
  const checkNewSeen = () => {
    const n = nw.current;
    const el = scroller.current;
    if (n.seen || !n.divider || !el) return;
    const row = el.querySelector(`[data-row-id="${CSS.escape(n.divider)}"]`) as HTMLElement | null;
    if (!row) return;
    const r = row.getBoundingClientRect();
    const v = el.getBoundingClientRect();
    if (v.height > 0 && r.bottom > v.top && r.top < v.bottom) markNewSeen();
  };
  const checkNewSeenRef = useRef(checkNewSeen);
  checkNewSeenRef.current = checkNewSeen;
  // once the line is placed, look after the view has settled where it opens (two frames: the scroll to the end lands
  // in a layout effect of its own)
  useEffect(() => {
    if (!dividerId) return;
    let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => checkNewSeenRef.current())));
    return () => cancelAnimationFrame(raf);
  }, [dividerId]);

  // host API (bus jump, drop staging, focus)
  useEffect(
    () =>
      registerView(viewKey ?? (primary ? "main" : `float:${roomId}`), {
        jumpTo: (id) => void jumpTo(id),
        // round 4: a pending thread Reply holds the room's MAIN composer (threads/focusIntent.ts)
        focusComposer: () => {
          if (!threadRoot && mainFocusHeld(roomId)) return;
          composer.current?.focus();
        },
        stageFiles: (f) => composer.current?.stage(f),
      }),
    [viewKey, primary, roomId, jumpTo, threadRoot],
  );

  // ---- mount: restore scroll, autofocus, room-open side effects
  useLayoutEffect(() => {
    const mem = useChatStore.getState().memory[memKey];
    settleUntil.current = performance.now() + 4000;
    if (mem && !mem.atBottom && mem.topId) {
      const el = scroller.current;
      const row = el?.querySelector(`[data-row-id="${CSS.escape(mem.topId)}"]`) as HTMLElement | null;
      // a view mounted hidden (the call fills the app) measures a zero-height list: restoring would park
      // it at the top of the loaded history — stay pinned to the end instead (shown → ResizeObserver)
      if (el && row && el.clientHeight > 0) {
        stick.current = false;
        settleUntil.current = 0;
        setAtBottom(false);
        setTop(el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top);
        return;
      }
    }
    // not restored (mounted hidden, the row is gone): pinned to the end — of the newest rows, not of the window the
    // scroll memory picked (it would hide every newer message and let them be marked read)
    showTail();
    toEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 3.1 step 2 — leaving the room: remember where the reader IS (native _remember on a switch and on
  // destruction, CV:263-277/1896). rememberTop() used to run on user scrolls only, so a programmatic return
  // to the end (jump chip, End, Esc, sending a message) left an old "scrolled up at X" behind and coming
  // back reopened the room up in its history instead of on the latest messages. A layout cleanup runs
  // before React detaches this view's DOM, so the probe still measures the real list.
  useLayoutEffect(
    () => () => {
      if (scroller.current?.isConnected && scroller.current.clientHeight > 0) rememberTop(stick.current || nearBottom());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // not on touch: on an iPad (desktop layout) the on-screen keyboard came up with every room opened, at launch too
  // (verify pass, 2026-10-25)
  useEffect(() => {
    if (primary && !mobile && !touch) {
      // round 4 (G-threads T3): not while a notification's Reply wants a THREAD's composer (threads/focusIntent.ts) —
      // this mount used to take the keyboard from it, and the reply went to the main timeline
      const t = window.setTimeout(() => {
        if (!threadRoot && mainFocusHeld(roomId)) return;
        composer.current?.focus();
      }, 0);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, mobile, touch]);
  useEffect(() => {
    if (!primary) return;
    const c = peekClient();
    const r = c?.getRoom(roomId);
    if (!c || !r) return;
    // CHAT-127: keys from backup for this room; admins provision member-state power levels — once per room per
    // session and only in my own server's rooms (the must-fix round, MATRIX-FRONTEND-DESIGN.md B5 rule 1: this used to
    // rewrite rooms on other servers too). The desktop's room.rs does the same.
    const crypto = c.getCrypto() as unknown as { restoreKeyBackup?: (o?: unknown) => Promise<unknown> } | undefined;
    void crypto;
    provisionOnOpen(roomId);
  }, [primary, roomId]);

  // CHAT-131 debug hooks: ?debug=layout logs the composer position; ?debug=bubble pops the room out after 6 s
  useEffect(() => {
    if (!primary) return;
    if (dbg === "layout") {
      const t = window.setInterval(() => {
        const c = document.querySelector("textarea")?.getBoundingClientRect();
        if (c) console.log(`[layout] composer x=${Math.round(c.x)} y=${Math.round(c.y)} w=${Math.round(c.width)} h=${Math.round(c.height)} vv=${window.visualViewport?.height ?? 0}`);
      }, 1000);
      return () => window.clearInterval(t);
    }
    if (dbg === "bubble") {
      const t = window.setTimeout(() => bus.emit("openFloatingChat", { roomId }), 6000);
      return () => window.clearTimeout(t);
    }
  }, [primary, roomId]);

  // permalink jump
  const jumped = useRef("");
  useEffect(() => {
    if (!eventId || jumped.current === eventId || !rows.length) return;
    jumped.current = eventId;
    requestAnimationFrame(() => void jumpTo(eventId).finally(() => (permalinkPending.current = false)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, rows.length > 0]);

  // ---- rows changed: anchor older pages, pin to the end, count new-below, receive sound
  const prevRows = useRef<Row[] | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const prev = prevRows.current;
    prevRows.current = rows;
    if (!el) return;
    if (pendingCentre.current) {
      const id = pendingCentre.current;
      if (el.querySelector(`[data-row-id="${CSS.escape(id)}"]`)) {
        pendingCentre.current = null;
        anchor.current = null;
        centreRow(id);
        return;
      }
    }
    if (pendingTop.current) {
      pendingTop.current = false;
      anchor.current = null;
      setTop(0);
      afterUserScroll(); // at the top: the next older page, as an animated Home ends
      return;
    }
    if (anchor.current) {
      const a = anchor.current;
      const row = el.querySelector(`[data-row-id="${CSS.escape(a.id)}"]`) as HTMLElement | null;
      if (row) {
        const d = row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
        if (Math.abs(d) > 0.5) setTop(el.scrollTop + d);
      }
      if (!tl.loadingBack) anchor.current = null;
      if (!stick.current) return;
    }
    if (!prev) {
      if (stick.current) toEnd();
      return;
    }
    if (prev === rows) {
      // only the window moved (a step, back to the tail)
      if (stick.current) toEnd();
      return;
    }
    // stuck at the end with a grown window: back to the newest WIN_INIT (the rows above are off screen)
    if (stick.current && !tailHiddenRef.current && winEnd - winStart > WIN_MAX && focusedRow() < 0) showTail();
    else if (!stick.current && winEnd - winStart > WIN_MAX) trimNewer();
    // tail appends
    const prevLast = prev.filter((r) => !r.echo).pop() ?? null;
    let appended: Row[] = [];
    if (prevLast) {
      const i = rows.findIndex((r) => r.id === prevLast.id);
      if (i >= 0) appended = rows.slice(i + 1).filter((r) => !r.echo);
    } else appended = rows.filter((r) => !r.echo);
    const newestPrev = prev.filter((r) => !r.echo).pop();
    const newestNow = rows.filter((r) => !r.echo).pop();
    if (stick.current || performance.now() < settleUntil.current) {
      toEnd();
      if (appended.length) queueMicrotask(markRead);
    } else {
      const others = appended.filter((r) => r.sender !== me && !r.echo).length;
      if (others) setNewBelow((n) => n + others);
    }
    if (readerRef.current && newestNow && newestPrev && newestNow.id !== newestPrev.id && newestNow.ts > newestPrev.ts && newestNow.sender !== me && !tl.loadingBack) {
      playUiSound("receive");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, shown]);
  // a scroll-bar drag in progress starts again from the last pointer position once the rows changed: the list's height
  // (the drag's scale) and maybe its position (an anchor correction above) moved
  useLayoutEffect(() => {
    const dr = dragRef.current;
    const el = scroller.current;
    if (dr && el) dragRef.current = { y0: dr.last, top0: el.scrollTop, last: dr.last };
  }, [shown]);
  // the keyboard's message focus once the window it asked for is rendered (after the anchor correction above)
  useLayoutEffect(() => {
    const pf = pendingFocus.current;
    const c = content.current;
    if (!pf || !c) return;
    pendingFocus.current = null;
    const lines = [...c.querySelectorAll<HTMLElement>("[data-msg-line]")];
    if (!lines.length) return;
    let k = pf.to === "first" ? 0 : lines.length - 1;
    if (pf.to === "before" || pf.to === "after") {
      const at = lines.findIndex((l) => l.closest<HTMLElement>("[data-row-id]")?.dataset.rowId === pf.from);
      k = at < 0 ? k : pf.to === "before" ? Math.max(0, at - 1) : Math.min(lines.length - 1, at + 1);
    }
    lines[k].focus({ preventScroll: true });
    lines[k].scrollIntoView({ block: "nearest" });
  }, [shown]);

  // content height changes (images, embeds) while stuck/settling → stay pinned
  // hasHeight: false while the view is display:none (the call fills the app, a minimised chat-head)
  const [hasHeight, setHasHeight] = useState(true);
  useEffect(() => {
    const c = content.current;
    const el = scroller.current;
    if (!c || !el) return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth);
      setHasHeight(el.clientHeight > 0);
      if (anchor.current) return;
      if (stick.current || performance.now() < settleUntil.current) toEnd();
    });
    ro.observe(c);
    ro.observe(el);
    setViewW(el.clientWidth);
    setHasHeight(el.clientHeight > 0);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // first page: fill the viewport (and keep filling until it scrolls — a view that doesn't scroll can't
  // ask for more by scrolling, least of all on touch). After a failure, try again once the 5 s back-off
  // is over (the loadError interval covers the empty-room case). Never while hidden: a display:none list
  // measures 0 ≤ 0 × 1.5 whatever it holds, so it would page through the room's whole history — it
  // fills when it is shown again (hasHeight).
  const [fillRetry, setFillRetry] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !hasHeight || el.clientHeight === 0 || tl.loadingBack || loadError) return;
    if (!tl.canBack) {
      // nothing more on the server: still fill from memory
      if (shown.length < 20 || el.scrollHeight <= el.clientHeight * 1.5) revealOlder();
      return;
    }
    const wait = 5000 - (performance.now() - lastFail.current);
    if (wait > 0) {
      const t = window.setTimeout(() => setFillRetry((n) => n + 1), wait + 50);
      return () => window.clearTimeout(t);
    }
    if (shown.length < 20 || el.scrollHeight <= el.clientHeight * 1.5) {
      if (!revealOlder()) void loadOlder(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, shown.length, tl.canBack, tl.loadingBack, loadError, fillRetry, hasHeight]);

  // becoming the attending reader at the bottom → mark read
  useEffect(() => {
    if (reader && attending && stick.current) markRead();
  }, [reader, attending, markRead, tl.version]);

  // ---- user scroll input
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      checkNewSeenRef.current(); // P2 a: every scroll, ours (wheel, keys, jumps) too
      if (expectTop.current != null && Math.abs(el.scrollTop - expectTop.current) < 1.5) {
        expectTop.current = null;
        return;
      }
      expectTop.current = null;
      settleUntil.current = 0;
      if (anchor.current) anchor.current = topRowProbe(); // the reader moved while older rows load
      if (!anim.current) afterUserScroll();
      if (dbg === "scroll") console.log(`[scroll] y=${Math.round(el.scrollTop)} run=${anim.current ? 1 : 0} ${nearBottom() ? "atEnd" : ""} ${el.scrollTop <= 0 ? "atTop" : ""}`);
      bumpBar();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      settleUntil.current = 0;
      const line = e.deltaMode === 1;
      const notch = line || Math.abs(e.deltaY) >= 100;
      e.preventDefault();
      if (e.deltaY < 0) {
        stick.current = false;
        setAtBottom(false);
      }
      if (notch) {
        const notches = line ? e.deltaY / 3 : e.deltaY / 100;
        const base = anim.current ? anim.current.target : el.scrollTop;
        animateTo(base + notches * 108);
      } else {
        stopAnim();
        setTop(el.scrollTop + e.deltaY);
        afterUserScroll();
      }
      bumpBar();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    if (!touch) el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touch]);

  // keys: PgUp/PgDn/Home/End when no text field has focus (primary view)
  useEffect(() => {
    if (!primary || floating) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        page(e.key === "PageUp" ? -1 : 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        settleUntil.current = 0;
        if (windowRange(rowsRef.current, winRef.current)[0] > 0) {
          // the first loaded row is outside the window: show the oldest rows, then go to the top
          stopAnim();
          stick.current = false;
          setAtBottom(false);
          const rs = rowsRef.current;
          const e0 = Math.min(rs.length, WIN_MAX - WIN_STEP);
          const next: RowWindow = { start: HEAD, end: e0 >= rs.length ? null : rs[e0 - 1].id };
          pendingTop.current = true;
          winRef.current = next;
          setWin(next);
        } else animateTo(0);
      } else if (e.key === "End") {
        e.preventDefault();
        jumpToLatest();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, floating, jumpToLatest]);

  const page = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    settleUntil.current = 0;
    const base = anim.current ? anim.current.target : el.scrollTop;
    animateTo(base + dir * 0.85 * el.clientHeight);
  };

  // ---- fox scroll bar (FSB): 6 px thumb, 10 on hover/drag, track, edge hover 28 px
  const [bar, setBar] = useState({ size: 1, pos: 0, moving: false, edge: false, hover: false, drag: false });
  const moveT = useRef(0);
  const bumpBar = () => {
    const el = scroller.current;
    if (!el) return;
    window.clearTimeout(moveT.current);
    setBar((b) => ({ ...b, moving: true, size: el.clientHeight / Math.max(1, el.scrollHeight), pos: el.scrollTop / Math.max(1, el.scrollHeight) }));
    moveT.current = window.setTimeout(() => setBar((b) => ({ ...b, moving: false })), 700);
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setBar((b) => ({ ...b, size: el.clientHeight / Math.max(1, el.scrollHeight), pos: el.scrollTop / Math.max(1, el.scrollHeight) }));
  }, [rows, viewW]);
  const dragRef = useRef<{ y0: number; top0: number; last: number } | null>(null);
  const barShown = bar.size < 1 && !touch && (bar.moving || bar.edge || bar.hover || bar.drag);
  const thumbH = Math.max(0.08, Math.min(1, bar.size));
  const thumbPos = Math.min(1 - thumbH, bar.pos);

  // ---- message actions
  const [menu, setMenu] = useState<{ row: Row; at: { x: number; y: number } | HTMLElement } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Row | null>(null);
  const [reactFor, setReactFor] = useState<Row | null>(null);
  const [reactRect, setReactRect] = useState<Rect | null>(null);
  const msgMenuItems = useRegistry("messageMenu");

  const onLogKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const box = e.currentTarget;
    const t = e.target as HTMLElement;
    const line = t.matches("[data-msg-line]") ? t : null;
    if (t !== box && !line) return; // keys inside a message's own controls are theirs
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the list consumed it: no window-level Escape (back to the bottom, close a pane) as well
      composer.current?.focus();
      return;
    }
    const lines = [...box.querySelectorAll<HTMLElement>("[data-msg-line]")];
    if (!lines.length) return;
    const i = line ? lines.indexOf(line) : -1;
    const last = lines.length - 1;
    // the row window (web-perf-2): a key that walks past the rows in the DOM moves the window first and focuses after the
    // render (pendingFocus) — the newest row when the tail is hidden, the first loaded row for Home, one row further
    // at either edge
    {
      const rs = rowsRef.current;
      const [ws, we] = windowRange(rs, winRef.current);
      const tailOut = we < rs.length;
      const lineRow = line?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? "";
      let pf: { to: "first" | "last" | "before" | "after"; from: string } | null = null;
      if ((e.key === "End" || ((e.key === "ArrowUp" || e.key === "ArrowDown") && i < 0)) && tailOut) {
        stick.current = true;
        setAtBottom(true);
        showTail();
        pf = { to: "last", from: "" };
      } else if (e.key === "Home" && ws > 0) {
        const e0 = Math.min(rs.length, WIN_MAX - WIN_STEP);
        const next: RowWindow = { start: HEAD, end: e0 >= rs.length ? null : rs[e0 - 1].id };
        stick.current = false;
        setAtBottom(false);
        winRef.current = next;
        setWin(next);
        pf = { to: "first", from: "" };
      } else if (e.key === "ArrowUp" && i === 0 && ws > 0 && lineRow) {
        if (revealOlder()) pf = { to: "before", from: lineRow };
      } else if (e.key === "ArrowDown" && i === last && tailOut && lineRow) {
        const next = windowNewer(rs, winRef.current, focusedRow());
        if (next) {
          winRef.current = next;
          setWin(next);
          pf = { to: "after", from: lineRow };
        }
      }
      if (pf) {
        e.preventDefault();
        e.stopPropagation();
        pendingFocus.current = pf;
        return;
      }
    }
    const to =
      e.key === "ArrowUp" ? (i < 0 ? last : Math.max(0, i - 1)) : e.key === "ArrowDown" ? (i < 0 ? last : Math.min(last, i + 1)) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    lines[to].focus({ preventScroll: true });
    lines[to].scrollIntoView({ block: "nearest" });
  };
  const handlers: BubbleHandlers = useMemo(
    () => ({
      onReact: (row, key) => void toggleReaction(roomId, row, key),
      onReactPicker: (row) => {
        // CV:620-627 — centred in the whole ConversationView (timeline + typing strip + composer), not the list
        const r = (scroller.current?.closest(`.${s.conv}`) ?? scroller.current)?.getBoundingClientRect();
        setReactRect(r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
        setReactFor(row);
      },
      onReply: (row) => composer.current?.startReply(row),
      onEdit: (row) => composer.current?.startEdit(row),
      onMenu: (row, at) => setMenu({ row, at }),
      onJump: (id) => void jumpTo(id),
      onRetry: (row) => retryLocal(roomId, row),
      onDeleteLocal: (row) => deleteLocal(row),
      // threads: open (or start) a message's thread in the Threads panel; none inside a thread's own panel
      onThread: threadRoot ? undefined : (row, opener) => row.eventId && openThreadPanel(roomId, row.eventId, opener),
      onImage: (src, w, h, caption) =>
        floating ? setLocalLb({ src, name: caption || undefined }) : bus.emit("openLightbox", { roomId, items: [{ src, name: caption, mimetype: `${w}x${h}` }], index: 0 }),
      viewTop: () => scroller.current?.getBoundingClientRect().top ?? 0,
    }),
    [roomId, jumpTo, threadRoot],
  );

  useEffect(() => {
    if (!loadError) return;
    const t = window.setInterval(() => void loadOlderRef.current(), 5000);
    return () => window.clearInterval(t);
  }, [loadError]);

  // ---- states (CV:1096-1131)
  const failed = rows.length === 0 && !!loadError;
  const loading = !failed && rows.length === 0 && (tl.loadingBack || (!tl.known && !!client));
  const empty = !failed && rows.length === 0 && !tl.canBack && tl.known && !tl.loadingBack;
  // D09.3 (Sunday QoL): a DM whose other person hasn't accepted yet says so instead of looking like an empty chat
  const dmPeer = useDmPeer(roomId);
  const dmPeerMember = useMember(roomId, dmPeer || null);
  const waitingFor = dmWaitingLine(useIsDirect(roomId), dmPeer, dmPeerMember?.membership, dmPeerMember?.rawName);

  return (
    <div className={cx(s.conv, mobile && s.mobile, inIsland && s.island, className)} style={{ ...style, display: hidden ? "none" : undefined }}>
      <div className={s.tlWrap}>
        <AmbienceLayer background={shownBg} image={roomBgImg} art={gameArt} content={getContent} scroller={getScroller} mobile={mobile} />
        <div
          ref={scroller}
          className={s.scroller}
          onPointerMove={(e) => {
            if (touch) return;
            const r = e.currentTarget.getBoundingClientRect();
            const edge = r.right - e.clientX <= 28;
            if (edge !== bar.edge) setBar((b) => ({ ...b, edge }));
          }}
          onPointerLeave={() => bar.edge && setBar((b) => ({ ...b, edge: false }))}
          onTouchStart={() => {
            settleUntil.current = 0;
            stopAnim();
          }}
        >
          <div
            ref={content}
            className={s.content}
            role="log"
            aria-label="Messages"
            aria-relevant="additions"
            // keyboard (a11y pass; the desktop's message list does the same): the list is a Tab stop of its own (links and
            // controls inside messages keep theirs); ↑/↓ walk the messages (↑ from the list = the newest), Home/End the
            // ends, Enter / Menu key / Shift+F10 on a message opens its action menu (ChatBubble), Escape goes back to the
            // composer
            tabIndex={0}
            onKeyDown={onLogKey}
          >
            {!tl.canBack && tl.known && rows.length > 0 && winStart === 0 && !threadRoot && <div className={s.startHeader}>This is the start of the conversation</div>}
            {shown.map((row, k) => {
              const i = winStart + k;
              const prev = i > 0 ? rows[i - 1] : null;
              const newDay = !prev || !sameDay(prev.ts, row.ts);
              const isDiv = row.id === dividerId;
              const grouped = !!prev && !newDay && !isDiv && prev.sender === row.sender && row.ts - prev.ts < 7 * 60 * 1000;
              return (
                <ChatBubble
                  key={row.id}
                  row={row}
                  roomId={roomId}
                  me={me}
                  grouped={grouped}
                  dayLabel={newDay ? dayLabel(row.ts) : null}
                  isDivider={isDiv}
                  maxBubble={maxBubble}
                  receipts={receipts.get(row.id) ?? NO_RECEIPTS}
                  flash={flashId === row.id}
                  clock={clock}
                  touch={touch}
                  previewsOn={i >= rows.length - 60}
                  h={handlers}
                />
              );
            })}
            {waitingFor && rows.length > 0 && !tailHidden && (
              <div className={s.waitingFor} data-dm-waiting="">
                {waitingFor}
              </div>
            )}
          </div>
        </div>
        {tl.loadingBack && rows.length > 0 && (
          <div className={s.histSpin}>
            <BusyIndicator size={27} label="Loading older messages" />
          </div>
        )}
        {(loading || empty || failed) && (
          <div className={s.emptyWrap}>
            {failed ? (
              // QOL A29.3: no dead end — Try again now (the 5 s retry keeps going too)
              <EmptyState iconName="network-disconnect-symbolic" title="Couldn't load this conversation" explanation={loadError}>
                <Button text="Try again" onClick={() => void loadOlderRef.current()} />
              </EmptyState>
            ) : loading ? (
              <EmptyState loading title="" loadingLabel="Loading messages…" />
            ) : (
              <EmptyState
                iconName={waitingFor ? "contact-new-symbolic" : "dialog-messages-symbolic"}
                title={waitingFor || "No messages"}
                explanation={waitingFor ? DM_WAITING_EXPLAIN : "Say something to get started."}
              />
            )}
          </div>
        )}
        {rows.length > 0 && newPillShown(!!dividerId, nw.current.waiting, nw.current.seen) && <NewPill onClick={() => void jumpToNew()} />}
        {!atBottom && rows.length > 0 && <JumpChip n={newBelow} onClick={jumpToLatest} />}
        {!touch && (
          <div
            className={cx(s.bar, (bar.hover || bar.drag) && s.barFat)}
            style={{ opacity: barShown ? 1 : 0 }}
            onPointerEnter={() => setBar((b) => ({ ...b, hover: true }))}
            onPointerLeave={() => setBar((b) => ({ ...b, hover: false }))}
            onPointerDown={(e) => {
              const el = scroller.current;
              if (!el) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              settleUntil.current = 0;
              const r = e.currentTarget.getBoundingClientRect();
              const y = (e.clientY - r.top) / r.height;
              if (y < thumbPos || y > thumbPos + thumbH) setTop((y - thumbH / 2) * el.scrollHeight);
              dragRef.current = { y0: e.clientY, top0: el.scrollTop, last: e.clientY };
              setBar((b) => ({ ...b, drag: true }));
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              const el = scroller.current;
              if (!d || !el) return;
              const r = e.currentTarget.getBoundingClientRect();
              d.last = e.clientY;
              setTop(d.top0 + ((e.clientY - d.y0) / r.height) * el.scrollHeight);
              afterUserScroll();
              bumpBar();
            }}
            onPointerUp={() => {
              dragRef.current = null;
              setBar((b) => ({ ...b, drag: false }));
              afterUserScroll();
            }}
          >
            <span className={s.track} />
            <span
              className={cx(s.thumb, bar.hover && s.thumbHover, bar.drag && s.thumbDrag)}
              style={{ top: `calc(${thumbPos * 100}% + 2px)`, height: `calc(${thumbH * 100}% - 4px)` }}
            />
          </div>
        )}
      </div>
      <div className={s.sep} />
      <Composer
        ref={composer}
        portal={composerHost}
        boxCard={boxCard}
        roomId={roomId}
        primary={primary}
        floating={floating}
        mobile={mobile}
        rows={rows}
        thread={threadRoot}
        me={me}
        narrow={narrow}
        onSent={() => {
          showTail();
          stick.current = true;
          setAtBottom(true);
          requestAnimationFrame(toEnd);
        }}
        onEscapeEmpty={jumpToLatest}
        onPage={page}
        onJump={(id) => void jumpTo(id)}
      />
      {menu && (
        <MessageMenu
          row={menu.row}
          roomId={roomId}
          at={menu.at}
          items={msgMenuItems}
          onClose={() => setMenu(null)}
          onReply={() => composer.current?.startReply(menu.row)}
          onThread={handlers.onThread ? () => handlers.onThread!(menu.row, null) : undefined}
          onEdit={() => composer.current?.startEdit(menu.row)}
          onReactMore={() => handlers.onReactPicker(menu.row, document.body)}
          onDelete={() => setConfirmDel(menu.row)}
          mobile={mobile}
        />
      )}
      <ConfirmDialog
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        dialogTitle="Delete message?"
        message="Delete this message for everyone?"
        confirmText="Delete"
        destructive
        onConfirmed={() => {
          const r = confirmDel;
          if (r?.eventId) void redactMessage(roomId, r.eventId);
        }}
      />
      {localLb && <LightboxView item={localLb} contained onClose={() => setLocalLb(null)} />}
      <EmojiPicker
        open={!!reactFor}
        onClose={() => setReactFor(null)}
        center={reactRect}
        onPick={(e) => {
          if (reactFor) void toggleReaction(roomId, reactFor, e);
        }}
      />
    </div>
  );
}

const NO_RECEIPTS: ReceiptUser[] = [];

/** threads: the thread an event is in ("" = main / unknown) — the loaded copy, else the server's (one fetch). */
async function threadRootOf(roomId: string, id: string): Promise<string> {
  const c = peekClient();
  const ev = c?.getRoom(roomId)?.findEventById(id);
  if (ev) return threadOf(ev.getWireContent() ?? ev.getContent());
  if (!c || !id.startsWith("$")) return "";
  try {
    const raw = (await c.fetchRoomEvent(roomId, id)) as { content?: unknown };
    return threadOf(raw?.content);
  } catch {
    return "";
  }
}

/** The row id holding the focus inside this list, null = none (the document's focus, not an event's memory). */
function focusedRowId(list: HTMLElement | null): string | null {
  const a = document.activeElement as HTMLElement | null;
  if (!list || !a || !list.contains(a)) return null;
  return a.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null;
}

/** Everything a bubble shows — equal signatures ⇒ the old Row object is reused. */
function rowSig(r: Row): string {
  return JSON.stringify([
    r.eventId,
    r.sender,
    r.ts,
    r.msgtype,
    r.body,
    r.formatted,
    r.edited,
    r.redacted,
    r.undecryptable,
    r.utdCode,
    r.pending,
    r.failed,
    r.failReason,
    r.echo,
    r.replyTo,
    r.reactions.map((x) => [x.key, x.count, x.mine, x.myEventId, x.who]),
    r.mentionsMe,
    r.pinned,
    r.media && [r.media.url, r.media.file?.url, r.media.w, r.media.h, r.media.size, r.media.localUrl],
    r.previewUrl,
    r.calendar,
    r.embeds.length,
    r.threadId,
    r.thread,
  ]);
}

/** P2 a: "Jump to NEW" (top of the timeline) — back to where you left off in a busy room. */
function NewPill({ onClick }: { onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, "Jump to where you left off", { delay: 500 });
  return (
    <button ref={ref} type="button" className={s.newPill} onClick={onClick} aria-label="Jump to NEW">
      <Icon name="go-up-symbolic" size={16} color="var(--th-timeline-jump-icon-unread)" />
      <span className={s.jumpLabel}>Jump to NEW</span>
    </button>
  );
}

function JumpChip({ n, onClick }: { n: number; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, n > 0 ? "Jump to the new messages" : "Jump to the latest message", { delay: 500 });
  return (
    <button ref={ref} type="button" className={cx(s.jump, n > 0 && s.jumpNew)} onClick={onClick} aria-label="Jump to the latest message">
      {n > 0 && <span className={s.jumpLabel}>{n === 1 ? "1 new message" : `${n} new messages`}</span>}
      <Icon name="go-bottom-symbolic" size={16} color={n > 0 ? "var(--th-timeline-jump-icon-unread)" : "var(--th-timeline-jump-icon)"} />
    </button>
  );
}

function MessageMenu({
  row,
  roomId,
  at,
  items,
  onClose,
  onReply,
  onThread,
  onEdit,
  onReactMore,
  onDelete,
  mobile,
}: {
  row: Row;
  roomId: string;
  at: { x: number; y: number } | HTMLElement;
  items: ReturnType<typeof useRegistry<"messageMenu">>;
  onClose: () => void;
  onReply: () => void;
  /** threads: "Reply in thread" (absent inside a thread's panel) */
  onThread?: () => void;
  onEdit: () => void;
  onReactMore: () => void;
  onDelete: () => void;
  mobile?: boolean;
}) {
  const inter = isInteractive(row);
  const canEdit = row.mine && inter && !row.media && (row.msgtype === "m.text" || row.msgtype === "m.emote" || row.msgtype === "m.notice") && !isDiceRow(row);
  const pinOk = inter && canPin(roomId);
  const ctx: MessageMenuCtx | null = row.event ? { roomId, event: row.event } : null;
  const extra = ctx ? items.filter((it) => (it.visible ? it.visible(ctx) : true)) : [];
  const locked = row.undecryptable;
  const notify = useConvToast();
  return (
    <Menu open onClose={onClose} anchor={at instanceof HTMLElement ? at : at} placement={at instanceof HTMLElement ? "below" : "at"} title="Message">
      {mobile && inter && (
        <div className={s.quickRow}>
          {REACT_KEYS.map((k) => {
            const on = row.reactions.some((r) => r.key === k && r.mine);
            return (
              <button
                key={k}
                type="button"
                className={cx(s.quickBtn, on && s.quickOn)}
                aria-label={on ? `Take back your ${k}` : `React ${k}`}
                onClick={() => {
                  void toggleReaction(roomId, row, k);
                  onClose();
                }}
              >
                {k}
              </button>
            );
          })}
          <button
            type="button"
            className={s.quickBtn}
            aria-label="More reactions"
            onClick={() => {
              onClose();
              onReactMore();
            }}
          >
            <Icon name="face-smile-symbolic" size={22} color="var(--th-bubble-quick-react-icon)" />
          </button>
        </div>
      )}
      {(() => {
        // native order (react 10 … copy link 70, delete 80 after a separator); r.messageMenu items slot in by `order`
        const items: Array<{ order: number; key: string; node: ReactNode }> = [];
        if (!locked && !mobile)
          items.push({
            order: 10,
            key: "react",
            node: (
              <SubMenu title="React" disabled={!inter}>
                {REACT_KEYS.map((k) => (
                  <MenuItem key={k} text={k} onTriggered={() => void toggleReaction(roomId, row, k)} />
                ))}
                <MenuSeparator />
                <MenuItem text="More…" icon="list-add-symbolic" onTriggered={onReactMore} />
              </SubMenu>
            ),
          });
        if (inter) items.push({ order: 20, key: "reply", node: <MenuItem text="Reply" icon="mail-reply-sender-symbolic" onTriggered={onReply} /> });
        if (inter && onThread && canThread(row)) items.push({ order: 25, key: "thread", node: <MenuItem text="Reply in thread" icon="dialog-messages-symbolic" onTriggered={onThread} /> });
        if (canEdit) items.push({ order: 30, key: "edit", node: <MenuItem text="Edit" icon="document-edit-symbolic" onTriggered={onEdit} /> });
        if (pinOk)
          items.push({
            order: 40,
            key: "pin",
            node: <MenuItem text={row.pinned ? "Unpin" : "Pin message"} icon="window-pin-symbolic" onTriggered={() => void setPinned(roomId, row.eventId!, !row.pinned)} />,
          });
        if (row.media && !locked) items.push({ order: 50, key: "save", node: <MenuItem text="Save as…" icon="document-save-symbolic" onTriggered={() => void saveMedia(row.media!)} /> });
        if (!locked && !row.redacted) items.push({ order: 60, key: "copy", node: <MenuItem text="Copy text" icon="edit-copy-symbolic" onTriggered={() => void copyText(row.body).then((ok) => ok && notify("Text copied"))} /> });
        if (row.eventId)
          items.push({
            order: 70,
            key: "link",
            node: <MenuItem text="Copy link" icon="link-symbolic" onTriggered={() => void copyText(shareLinkNow(roomId, "", row.eventId!)).then(() => notify("Message link copied"))} />,
          });
        if (mayDelete(!!row.mine, inter, !row.mine && canRedactOthers(roomId)))
          items.push({
            order: 80,
            key: "delete",
            node: (
              <>
                <MenuSeparator />
                <MenuItem text="Delete" icon="delete-symbolic" onTriggered={onDelete} />
              </>
            ),
          });
        if (ctx)
          for (const it of extra)
            items.push({
              order: it.order,
              key: `x-${it.id}`,
              node: (
                <>
                  {it.separatorBefore && <MenuSeparator />}
                  <MenuItem
                    text={menuValue(it.label, ctx)}
                    icon={it.icon ? menuValue(it.icon, ctx) : undefined}
                    danger={it.danger}
                    disabled={it.enabled ? !it.enabled(ctx) : false}
                    onTriggered={() => it.run(ctx)}
                  />
                </>
              ),
            });
        return items
          .map((x, i) => ({ ...x, i }))
          .sort((p, q) => p.order - q.order || p.i - q.i)
          .map((x) => <Fragment key={x.key}>{x.node}</Fragment>);
      })()}
      {row.echo && row.failed && (
        <>
          <MenuItem text="Retry" icon="view-refresh" onTriggered={() => retryLocal(roomId, row)} />
          <MenuItem text="Delete" icon="delete-symbolic" onTriggered={() => deleteLocal(row)} />
        </>
      )}
    </Menu>
  );
}

export { displayName };
