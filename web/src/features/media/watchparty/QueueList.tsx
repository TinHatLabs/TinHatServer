// watchparty/QueueList.tsx — the Media Party queue (11.3 QOL, the Media Party QOL spec §5; the twin of the
// queue section of the desktop's WatchPartyWindow.qml):
//   header  "Queue · 12 · 48 min left" (queue.ts upcomingLabel) + Shuffle (upcoming only, seeded) + Clear played + Clear
//           — the three are host-gated like Clear always was
//   rows    grip · number, or "Now playing" (accent) on the playing row · "Up next" on the one after it · art · title ·
//           artist · source badge · added-by avatar (the name in its tooltip) · Play now (host) / Play next (anyone in the
//           party) / Remove on hover or keyboard focus (always shown on touch, + a "⋯" menu button — a phone-narrow row
//           keeps Play now + "⋯" so the title stays readable; Play next / Remove are in the menu); played rows at 55 %
//   drag    press the grip (or a row, after 6 px of travel — mouse only) → the row follows the pointer, a drop line marks
//           the target, drop = ONE moveItem(from, to) write; auto-scrolls near the list's edges
//   menu    right-click (long-press / "⋯" on touch): Play now · Play next · Move to top · Move up · Move down · Open link ·
//           Copy link · Remove; double-click a row = Play now
//   follow  the list scrolls to keep the playing row in view when the playing url changes
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMember } from "@/core/matrix";
import { toast } from "@/core/bus";
import { Avatar, Button, Menu, MenuItem, MenuSeparator, ToolButton, animate, cx, useTip, type MenuAnchor } from "@/ui";
import { shortName } from "../shared/format";
import { clearPlayed, clearQueue, moveItem, moveToNext, playUrl, removeAt, shuffleUpcoming, upcomingLabel, type QueueItem } from "./engine";
import { serviceLabel } from "./links";
import s from "./WatchParty.module.css";
import { openExternal } from "@/core/openlink";

export interface QueueListProps {
  roomId: string;
  queue: QueueItem[];
  nowUrl: string;
  inParty: boolean;
  canControl: boolean;
  hostName: string;
  /** touch / phone: the row actions are always shown, plus the "⋯" menu button */
  touch: boolean;
  /** the column is ≥ 470 px: Shuffle / Clear played show their labels beside the icons (the desktop's rule) */
  labels: boolean;
  /** the window's OSD (a host-gated action someone else may not take) */
  notify: (icon: string, text: string) => void;
}

/** The header's label: "Queue", "Queue · 12" or "Queue · 12 · 48 min left". */
export function queueTitle(queue: QueueItem[], nowUrl: string): string {
  if (!queue.length) return "Queue";
  const left = upcomingLabel(queue, nowUrl);
  return `Queue · ${queue.length}${left ? ` · ${left}` : ""}`;
}

/** moveItem(from, to) target for a drop into gap `slot` (0 … n, the gap before row `slot`). */
export function dropTarget(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

function AddedBy({ roomId, userId }: { roomId: string; userId: string }) {
  const m = useMember(roomId, userId);
  const ref = useRef<HTMLSpanElement>(null);
  const name = m?.name ?? shortName(userId);
  useTip(ref, `Added by ${name}`);
  return (
    <span ref={ref} className={s.qBy} aria-label={`Added by ${name}`}>
      <Avatar name={name} seed={userId} size={18} imageSource={m?.avatarMxc ?? ""} />
    </span>
  );
}

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let e = el; e; e = e.parentElement) {
    const oy = getComputedStyle(e).overflowY;
    if ((oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight + 1) return e;
  }
  return null;
}

interface DragState {
  from: number;
  pointerId: number;
  x0: number;
  y0: number;
  started: boolean;
  el: HTMLElement;
  scroller: HTMLElement | null;
  scroll0: number;
  /** the scroller's range at the start (the dragged row's own transform must not grow it) */
  maxScroll: number;
}
interface DragView {
  from: number;
  dy: number;
  to: number;
  lineY: number;
}

export function QueueList({ roomId, queue: shared, nowUrl, inParty, canControl, hostName, touch, labels, notify }: QueueListProps) {
  // a drop shows the new order at once (one write; the room's echo replaces it, or 5 s pass)
  const [optimistic, setOptimistic] = useState<QueueItem[] | null>(null);
  useEffect(() => setOptimistic(null), [shared]);
  useEffect(() => {
    if (!optimistic) return;
    const t = window.setTimeout(() => setOptimistic(null), 5000);
    return () => window.clearTimeout(t);
  }, [optimistic]);
  const queue = optimistic ?? shared;
  const nowIdx = nowUrl ? queue.findIndex((q) => q.url === nowUrl) : -1;
  const nextIdx = nowIdx >= 0 && nowIdx + 1 < queue.length ? nowIdx + 1 : -1;
  const upcoming = nowIdx >= 0 ? queue.length - nowIdx - 1 : queue.length;
  const hostTip = (what: string) => (!canControl && inParty ? `Only the host (${hostName}) can ${what}` : "");
  const denied = () => notify("user-identity", `Only the host (${hostName}) controls playback`);

  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [view, setView] = useState<DragView | null>(null);
  const lastY = useRef(0);
  const raf = useRef(0);
  const [menu, setMenu] = useState<{ i: number; anchor: MenuAnchor } | null>(null);

  // ---- follow the playing row (the list's own scroll only — never the side panel / window) -------------------------
  useEffect(() => {
    const list = listRef.current;
    if (!list || !nowUrl || list.scrollHeight <= list.clientHeight + 1) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-qrow]")).find((r) => r.dataset.url === nowUrl);
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    let to: number | null = null;
    if (top < list.scrollTop) to = Math.max(0, top - 4);
    else if (bottom > list.scrollTop + list.clientHeight) to = bottom - list.clientHeight + 4;
    if (to !== null) list.scrollTo({ top: to, behavior: animate() ? "smooth" : "auto" });
  }, [nowUrl]);

  // ---- drag to reorder ---------------------------------------------------------------------------------------------
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-qrow]") ?? []);
  const measure = (y: number, from: number): { to: number; lineY: number } => {
    const list = listRef.current;
    const rs = rows();
    if (!list || !rs.length) return { to: from, lineY: 0 };
    let slot = 0;
    rs.forEach((r, i) => {
      if (i === from) return;
      const b = r.getBoundingClientRect();
      if (b.top + b.height / 2 < y) slot = i + 1;
    });
    const to = dropTarget(from, slot);
    const lb = list.getBoundingClientRect();
    const ref = slot === 0 ? rs[0].getBoundingClientRect().top - 3 : rs[slot - 1].getBoundingClientRect().bottom + 1;
    return { to, lineY: ref - lb.top + list.scrollTop };
  };
  const update = (y: number) => {
    const d = drag.current;
    if (!d) return;
    const scrolled = (d.scroller?.scrollTop ?? 0) - d.scroll0;
    const m = measure(y, d.from);
    setView({ from: d.from, dy: y - d.y0 + scrolled, to: m.to, lineY: m.lineY });
  };
  const autoScroll = () => {
    const d = drag.current;
    if (!d?.started) return;
    const sc = d.scroller;
    if (sc) {
      const r = sc.getBoundingClientRect();
      const zone = 36;
      const y = lastY.current;
      let v = 0;
      if (y < r.top + zone) v = -Math.ceil(((r.top + zone - y) / zone) * 12);
      else if (y > r.bottom - zone) v = Math.ceil(((y - (r.bottom - zone)) / zone) * 12);
      if (v) {
        const before = sc.scrollTop;
        sc.scrollTop = Math.max(0, Math.min(d.maxScroll, before + v));
        if (sc.scrollTop !== before) update(y);
      }
    }
    raf.current = requestAnimationFrame(autoScroll);
  };
  const begin = (y: number) => {
    const d = drag.current;
    if (!d) return;
    d.started = true;
    try {
      d.el.setPointerCapture(d.pointerId);
    } catch {
      /* the pointer is gone */
    }
    d.scroller = scrollParentOf(listRef.current);
    d.scroll0 = d.scroller?.scrollTop ?? 0;
    d.maxScroll = d.scroller ? d.scroller.scrollHeight - d.scroller.clientHeight : 0;
    lastY.current = y;
    update(y);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(autoScroll);
  };
  const end = (y: number | null) => {
    const d = drag.current;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    setView(null);
    if (!d?.started || y === null) return;
    const { to } = measure(y, d.from);
    if (to === d.from) return;
    const n = [...queue];
    const [it] = n.splice(d.from, 1);
    n.splice(to, 0, it);
    setOptimistic(n);
    moveItem(d.from, to);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const rowHandlers = (i: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (!inParty || queue.length < 2 || e.button !== 0) return;
      const t = e.target as HTMLElement;
      const viaGrip = !!t.closest("[data-grip]");
      // buttons act; touch drags only by the grip (a row swipe scrolls)
      if (!viaGrip && (t.closest("button") || e.pointerType !== "mouse")) return;
      drag.current = { from: i, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, el: e.currentTarget, scroller: null, scroll0: 0, maxScroll: 0 };
      if (viaGrip) {
        e.preventDefault();
        begin(e.clientY);
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
        begin(e.clientY);
      }
      lastY.current = e.clientY;
      update(e.clientY);
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      if (drag.current && e.pointerId === drag.current.pointerId) end(e.clientY);
    },
    onPointerCancel: () => end(null),
  });

  // ---- actions -----------------------------------------------------------------------------------------------------
  const playNow = (i: number) => {
    if (!inParty) return;
    if (!canControl) return denied();
    playUrl(queue[i].url);
  };
  const linkOf = (q: QueueItem) => q.source?.url || q.url;
  const copyLink = (q: QueueItem) => {
    void navigator.clipboard
      ?.writeText(linkOf(q))
      .then(() => toast("Link copied"))
      .catch(() => toast("Couldn't copy the link"));
  };

  const title = queueTitle(queue, nowUrl);
  const m = menu && queue[menu.i] ? menu : null;
  const mq = m ? queue[m.i] : null;
  return (
    <>
      <div className={s.queueHead}>
        <span className={s.queueTitle} data-testid="mp-queue-title">
          {title}
        </span>
        <span className={s.queueBtns}>
          {upcoming >= 2 && <ToolButton iconName="media-playlist-shuffle-symbolic" iconSize={16} label={labels ? "Shuffle" : undefined} disabled={!canControl} tip={hostTip("shuffle the queue") || "Shuffle — what's up next, for everyone"} className={s.headBtn} onClick={() => shuffleUpcoming()} />}
          {nowIdx > 0 && <ToolButton iconName="edit-clear-history-symbolic" iconSize={16} label={labels ? "Clear played" : undefined} disabled={!canControl} tip={hostTip("clear the queue") || "Clear played — remove what already played, for everyone"} className={s.headBtn} onClick={() => clearPlayed()} />}
          {queue.length > 0 && <Button text="Clear" flat disabled={!canControl} title={hostTip("clear the queue") || "Clear the queue (for everyone)"} onClick={() => clearQueue()} />}
        </span>
      </div>
      {queue.length > 0 ? (
        <div ref={listRef} className={cx(s.queue, view && s.queueDragging)} data-testid="mp-queue">
          {queue.map((q, i) => {
            const b = serviceLabel(q.source?.service, q.kind);
            const isNow = i === nowIdx;
            const isNext = i === nextIdx;
            const dragging = view?.from === i;
            const style: CSSProperties | undefined = dragging ? { transform: `translateY(${view!.dy}px)` } : undefined;
            return (
              <div
                key={`${i}-${q.url}`}
                data-qrow=""
                data-url={q.url}
                data-testid="mp-queue-row"
                className={cx(s.qRow, isNow && s.qNow, nowIdx >= 0 && i < nowIdx && s.qPlayed, dragging && s.qDrag, touch && s.qTouch)}
                style={style}
                {...rowHandlers(i)}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest("button")) return;
                  playNow(i);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ i, anchor: { x: e.clientX, y: e.clientY } });
                }}
              >
                {inParty && <span className={s.grip} data-grip="" aria-hidden title="Drag to reorder" />}
                {isNow ? <span className={s.tagNow}>Now playing</span> : <span className={s.qNum}>{`${i + 1}.`}</span>}
                {isNext && <span className={s.tagNext}>Up next</span>}
                {q.art && <img className={s.qArt} src={q.art} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />}
                <span className={s.qTitle} title={[q.title || q.url, q.artist].filter(Boolean).join(" — ")}>
                  {q.title || q.url}
                  {q.artist && <span className={s.qArtist}>{` · ${q.artist}`}</span>}
                </span>
                {b && <span className={s.badge}>{b}</span>}
                {q.addedBy && <AddedBy roomId={roomId} userId={q.addedBy} />}
                <span className={s.qActions}>
                  <ToolButton iconName="media-playback-start" iconSize={16} tip={canControl ? "Play now" : `Play now — only the host (${hostName})`} disabled={!canControl} className={s.rowBtn} onClick={() => playNow(i)} />
                  <ToolButton iconName="media-playlist-append" iconSize={16} tip="Play next" disabled={!inParty || isNow || isNext} className={cx(s.rowBtn, s.qOptional)} onClick={() => moveToNext(i)} />
                  <ToolButton iconName="edit-delete-remove-symbolic" iconSize={16} tip="Remove from the queue" disabled={!inParty} className={cx(s.rowBtn, s.qOptional)} onClick={() => removeAt(i)} />
                  {touch && <ToolButton iconName="view-more-horizontal-symbolic" iconSize={16} tip="More" className={s.rowBtn} onClick={(e) => setMenu({ i, anchor: e.currentTarget })} />}
                </span>
              </div>
            );
          })}
          {view && view.to !== view.from && <div className={s.dropLine} style={{ top: view.lineY }} data-testid="mp-drop-line" />}
        </div>
      ) : (
        <div className={s.dimSmall}>Queue is empty — paste a link or search below and add something.</div>
      )}
      {m && mq && (
        <Menu open anchor={m.anchor} onClose={() => setMenu(null)} title={mq.title || "Queue item"}>
          <MenuItem text="Play now" icon="media-playback-start" disabled={!canControl} onTriggered={() => playNow(m.i)} />
          <MenuItem text="Play next" icon="media-playlist-append" disabled={!inParty || m.i === nowIdx || m.i === nextIdx} onTriggered={() => moveToNext(m.i)} />
          <MenuSeparator />
          <MenuItem text="Move to top" icon="go-top-symbolic" disabled={!inParty || m.i === 0} onTriggered={() => moveItem(m.i, 0)} />
          <MenuItem text="Move up" icon="go-up-symbolic" disabled={!inParty || m.i === 0} onTriggered={() => moveItem(m.i, m.i - 1)} />
          <MenuItem text="Move down" icon="go-down-symbolic" disabled={!inParty || m.i === queue.length - 1} onTriggered={() => moveItem(m.i, m.i + 1)} />
          <MenuSeparator />
          <MenuItem text="Open link" icon="link-symbolic" onTriggered={() => openExternal(linkOf(mq))} />
          <MenuItem text="Copy link" icon="edit-copy-symbolic" onTriggered={() => copyLink(mq)} />
          <MenuSeparator />
          <MenuItem text="Remove" icon="edit-delete-remove-symbolic" danger disabled={!inParty} onTriggered={() => removeAt(m.i)} />
        </Menu>
      )}
    </>
  );
}
