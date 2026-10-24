// ConversationView.tsx — ConversationView.qml: the timeline (rows, grouping, day pills, NEW divider
// freeze, receipts, pagination with anchoring, bottom pinning + settle, wheel easing, jump chip, fox
// scroll bar, empty/loading/error states) + the composer. Reused by the main room page (primary) and
// floating chats (primary = false: no typing notices, receipts only while the main view isn't
// attending that room).
// 11.0 (islands C6/C7, `composerHost`): the desktop dock host's timeline island holds this view; its composer section
// renders into the composer island (Composer `portal`) — one view, two frames (ISLANDS-ARCH §0.9). The island draws the
// fill, so the view paints no background there; the divider above the typing strip stays (ConversationView.qml).
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { peekClient, useClient, useRoomState, ensureWritable, liveTimelineChain, TINHAT_MEMBER_STATE_EVENTS } from "@/core/matrix";
import { bus, useBus } from "@/core/bus";
import { useRegistry, menuValue, type MessageMenuCtx } from "@/core/registry";
import { usePref } from "@/core/prefs";
import { playUiSound } from "@/core/sounds";
import { useIsTouch } from "@/core/device";
import { BusyIndicator, ConfirmDialog, DUR, EmptyState, Icon, Menu, MenuItem, MenuSeparator, SubMenu, animate, cx, useTip, type Rect } from "@/ui";
import { ChatBubble, type BubbleHandlers, type ReceiptUser } from "./ChatBubble";
import { Composer, type ComposerHandle } from "./Composer";
import { EmojiPicker } from "./EmojiPicker";
import { LightboxView } from "./Lightbox";
import * as settingsFeature from "@/features/settings";
import { useConvToast } from "./convToast";
import { buildRows, displayName, isDiceRow, isInteractive, type Row } from "./lib/model";
import { HAS_CHAT_SAMPLES, sampleEvents } from "./lib/samples";
import { dayLabel, sameDay } from "./lib/format";
import { useRoomTimeline } from "./useRoomTimeline";
import { registerView, useChatStore } from "./store";
import { canPin, copyText, deleteLocal, redactMessage, retryLocal, saveMedia, sendReceipt, setPinned, toggleReaction } from "./actions";
import s from "./Conversation.module.css";

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
  className?: string;
  style?: CSSProperties;
}

/** Keyed by room: one instance per open room (memory saved on unmount, restored on mount). */
export function ConversationView(p: ConversationViewProps) {
  return <Conversation key={p.roomId} {...p} />;
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

function Conversation({ roomId, primary = true, floating = false, eventId, mobile = false, hidden = false, viewKey, className, style, composerHost, boxCard }: ConversationViewProps) {
  const inIsland = composerHost !== undefined;
  const client = useClient();
  const me = client?.getUserId() ?? "";
  const room = client?.getRoom(roomId) ?? null;
  const touch = useIsTouch();
  const tl = useRoomTimeline(roomId);
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
    const fresh = buildRows({ room, me, myName, events, uploads: roomUploads, pinned });
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
  }, [tl.version, tl.events, roomUploads, pinned, me, myName, room]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // CHAT-83: the first load failed and nothing is cached → error state; retried every 5 s
  const [loadError, setLoadError] = useState("");

  // ---- geometry
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
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
  const reader = primary || !mainShowsIt;
  const readerRef = useRef(reader && attending);
  readerRef.current = reader && attending;

  // a permalink open must not mark the room read before the jump has happened
  const permalinkPending = useRef(!!eventId);
  const markRead = useCallback(() => {
    if (!readerRef.current || permalinkPending.current) return;
    const r = peekClient()?.getRoom(roomId);
    if (!r) return;
    const evs = liveTimelineChain(r).events;
    for (let i = evs.length - 1; i >= 0; i--) {
      const id = evs[i].getId();
      if (id && !id.startsWith("~")) {
        sendReceipt(roomId, evs[i]);
        return;
      }
    }
  }, [roomId]);

  // ---- NEW divider freeze (3.1 step 8 + 3.2)
  const nw = useRef<{ frozen: boolean; marker: string; hint: number; tail: string; divider: string; settled: boolean }>({
    frozen: false,
    marker: "",
    hint: 0,
    tail: "",
    divider: "",
    settled: false,
  });
  if (!nw.current.frozen && room && (rows.length > 0 || !tl.canBack)) {
    nw.current.frozen = true;
    nw.current.marker = room.getEventReadUpTo(me) ?? "";
    nw.current.hint = room.getUnreadNotificationCount() ?? 0;
    const real = rows.filter((r) => !r.echo);
    nw.current.tail = real.length ? real[real.length - 1].id : "";
  }
  const recomputeDivider = () => {
    const n = nw.current;
    if (!n.frozen || n.divider || n.settled) return;
    const rs = rows;
    if (!rs.length) return;
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
          if (n.hint <= 0) return;
          start = Math.max(-1, rs.length - 1 - n.hint);
        }
      }
    } else if (n.hint <= 0) return;
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
    for (let j = start + 1; j < end; j++) {
      if (rs[j].sender !== me && !rs[j].echo) {
        n.divider = rs[j].id;
        return;
      }
    }
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
    let last = "";
    for (const e of evs) {
      const id = e.getId() ?? "";
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
  }, [tl.version, rows, room, me]);

  // ---- scrolling primitives
  const nearBottom = () => {
    const el = scroller.current;
    if (!el) return true;
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

  // when the last older-page load FAILED (performance.now()); -Infinity = never. It was useRef(0) —
  // "failed at page start" — which muted the first-page fill below for the first 5 s after every page
  // load: a room opened then (the desktop's last-room restore, a phone tapping a room right after iOS
  // reloaded the tab) kept the ≤10 events the sync cache holds and never loaded more — a blank room when
  // those were not message rows, and on touch nothing to scroll that could have asked for more.
  const lastFail = useRef(Number.NEGATIVE_INFINITY);
  /** `auto` = the first-page fill (retried quietly every 5 s); a scroll-driven load toasts its failure. */
  const loadOlder = useCallback(async (auto = false) => {
    if (!tl.canBack || tl.loadingBack) return;
    anchor.current = topRowProbe();
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
    if (el.scrollTop < 1.5 * el.clientHeight && performance.now() - lastFail.current > 1500) void loadOlderRef.current();
  };

  const afterUserScroll = () => {
    stick.current = nearBottom();
    setAtBottom(stick.current);
    if (stick.current) {
      setNewBelow(0);
      markRead();
    }
    rememberTop();
    maybeLoadOlder();
  };
  const rememberTop = (atBottom = stick.current) => {
    const t = atBottom ? null : topRowProbe();
    const cur = useChatStore.getState().memory[roomId];
    useChatStore.setState((st) => ({
      memory: { ...st.memory, [roomId]: { ...(cur ?? { draft: "", replyToId: "", replyToBody: "", replyToName: "", staged: [] }), atBottom, topId: t?.id ?? "" } },
    }));
  };

  const jumpToLatest = useCallback(() => {
    stopAnim();
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
      // look a few pages back for it ("Older than what's loaded — click to look for it")
      for (let i = 0; i < 6; i++) {
        const r0 = peekClient()?.getRoom(roomId);
        if (!r0 || !liveTimelineChain(r0).canBack) break;
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
    [roomId, tl.paginate],
  );

  // host API (bus jump, drop staging, focus)
  useEffect(
    () =>
      registerView(viewKey ?? (primary ? "main" : `float:${roomId}`), {
        jumpTo: (id) => void jumpTo(id),
        focusComposer: () => composer.current?.focus(),
        stageFiles: (f) => composer.current?.stage(f),
      }),
    [viewKey, primary, roomId, jumpTo],
  );

  // ---- mount: restore scroll, autofocus, room-open side effects
  useLayoutEffect(() => {
    const mem = useChatStore.getState().memory[roomId];
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
  useEffect(() => {
    if (primary && !mobile) {
      const t = window.setTimeout(() => composer.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [primary, mobile]);
  useEffect(() => {
    if (!primary) return;
    const c = peekClient();
    const r = c?.getRoom(roomId);
    if (!c || !r) return;
    // CHAT-127: keys from backup for this room; admins provision member-state power levels
    const crypto = c.getCrypto() as unknown as { restoreKeyBackup?: (o?: unknown) => Promise<unknown> } | undefined;
    void crypto;
    const me2 = c.getUserId() ?? "";
    if (r.currentState.maySendStateEvent("m.room.power_levels", me2)) void ensureWritable(roomId, TINHAT_MEMBER_STATE_EVENTS).catch(() => {});
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
  }, [rows]);

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
    if (!el || !hasHeight || el.clientHeight === 0 || tl.loadingBack || !tl.canBack || loadError) return;
    const wait = 5000 - (performance.now() - lastFail.current);
    if (wait > 0) {
      const t = window.setTimeout(() => setFillRetry((n) => n + 1), wait + 50);
      return () => window.clearTimeout(t);
    }
    if (rows.length < 20 || el.scrollHeight <= el.clientHeight * 1.5) void loadOlder(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, tl.canBack, tl.loadingBack, loadError, fillRetry, hasHeight]);

  // becoming the attending reader at the bottom → mark read
  useEffect(() => {
    if (reader && attending && stick.current) markRead();
  }, [reader, attending, markRead, tl.version]);

  // ---- user scroll input
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
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
        animateTo(0);
        settleUntil.current = 0;
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
  const dragRef = useRef<{ y0: number; top0: number } | null>(null);
  const barShown = bar.size < 1 && !touch && (bar.moving || bar.edge || bar.hover || bar.drag);
  const thumbH = Math.max(0.08, Math.min(1, bar.size));
  const thumbPos = Math.min(1 - thumbH, bar.pos);

  // ---- message actions
  const [menu, setMenu] = useState<{ row: Row; at: { x: number; y: number } | HTMLElement } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Row | null>(null);
  const [reactFor, setReactFor] = useState<Row | null>(null);
  const [reactRect, setReactRect] = useState<Rect | null>(null);
  const msgMenuItems = useRegistry("messageMenu");

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
      onImage: (src, w, h, caption) =>
        floating ? setLocalLb({ src, name: caption || undefined }) : bus.emit("openLightbox", { roomId, items: [{ src, name: caption, mimetype: `${w}x${h}` }], index: 0 }),
      viewTop: () => scroller.current?.getBoundingClientRect().top ?? 0,
    }),
    [roomId, jumpTo],
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

  return (
    <div className={cx(s.conv, mobile && s.mobile, inIsland && s.island, className)} style={{ ...style, display: hidden ? "none" : undefined }}>
      <div className={s.tlWrap}>
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
          <div ref={content} className={s.content} role="log" aria-label="Messages" aria-relevant="additions">
            {!tl.canBack && tl.known && rows.length > 0 && <div className={s.startHeader}>This is the start of the conversation</div>}
            {rows.map((row, i) => {
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
          </div>
        </div>
        {tl.loadingBack && rows.length > 0 && (
          <div className={s.histSpin}>
            <BusyIndicator size={27} />
          </div>
        )}
        {(loading || empty || failed) && (
          <div className={s.emptyWrap}>
            {failed ? (
              <EmptyState iconName="network-disconnect-symbolic" title="Couldn't load this conversation" explanation={loadError} />
            ) : loading ? (
              <EmptyState loading title="" />
            ) : (
              <EmptyState iconName="dialog-messages-symbolic" title="No messages" explanation="Say something to get started." />
            )}
          </div>
        )}
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
              dragRef.current = { y0: e.clientY, top0: el.scrollTop };
              setBar((b) => ({ ...b, drag: true }));
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              const el = scroller.current;
              if (!d || !el) return;
              const r = e.currentTarget.getBoundingClientRect();
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
        me={me}
        narrow={narrow}
        onSent={() => {
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
  ]);
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
        if (canEdit) items.push({ order: 30, key: "edit", node: <MenuItem text="Edit" icon="document-edit-symbolic" onTriggered={onEdit} /> });
        if (pinOk)
          items.push({
            order: 40,
            key: "pin",
            node: <MenuItem text={row.pinned ? "Unpin" : "Pin message"} icon="window-pin-symbolic" onTriggered={() => void setPinned(roomId, row.eventId!, !row.pinned)} />,
          });
        if (row.media && !locked) items.push({ order: 50, key: "save", node: <MenuItem text="Save as…" icon="document-save-symbolic" onTriggered={() => void saveMedia(row.media!)} /> });
        if (!locked && !row.redacted) items.push({ order: 60, key: "copy", node: <MenuItem text="Copy text" icon="edit-copy-symbolic" onTriggered={() => void copyText(row.body)} /> });
        if (row.eventId)
          items.push({
            order: 70,
            key: "link",
            node: <MenuItem text="Copy link" icon="link-symbolic" onTriggered={() => void copyText(`https://matrix.to/#/${roomId}/${row.eventId}`).then(() => notify("Message link copied"))} />,
          });
        if (row.mine && inter)
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
