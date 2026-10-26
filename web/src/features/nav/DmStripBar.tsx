// DmStripBar.tsx — REACH §1.2/§1.3 + A2.14: the rail's DM strip between the meta bubbles and the divider above
// the real spaces. Unread DMs + DM invites (model.ts → dmstrip.ts), newest first, ≤ 5 bubbles + "+N".
//
//   bubble   52 px slot, 44 px CIRCLE (a DM never morphs — people aren't places), the room avatar → the
//            peer's → the initial; hover = the rail's 18 px pill; red unread badge bottom-right (99+);
//            presence dot bottom-left (12 px, 2 px ring in the rail colour) when the peer shares
//   invite   the invited-space look: dashed 2 px accent ring, accent dot top-right, avatar at 0.7
//   "+N"     a meta disc (accent 0.34, onAccent bold); click → People
//   click    joined → People + open the DM (phones: the room page, People underneath); invite → People,
//            its row with Accept / Decline scrolled into view (no flash — the desktop just selects People)
//   menu     right-click / 500 ms long-press: Open · Mark as read  |  Accept · Decline
//   motion   bubbles fade + resize in and out over the rail's dur (none with reduced motion)
// (Not "DmStrip.tsx": next to dmstrip.ts, a case-insensitive disk (macOS, Windows) resolved "./DmStrip" to the model
// and the app stopped at "Starting up 5%"; src/app/casefold.test.ts keeps that from coming back.)
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Avatar, Menu, MenuItem, MenuSectionLabel, UnreadBadge, avatarSeed, cx, durMs, hideTooltip, useAnimate, useTip } from "@/ui";
import { PresenceDot, usePresence, viewOf } from "@/features/presence";
import { acceptInvite, markRoomRead, rejectInvite } from "./actions";
import { openRoomId } from "./open";
import { selectSpace, useNavStore } from "./model";
import type { DmStrip as Strip, DmStripEntry } from "./dmstrip";
import { swallowNextClick } from "./touch";
import r from "./SpaceRail.module.css";
import s from "./DmStrip.module.css";

type Item = { key: string; entry: DmStripEntry | null; more: number };
type Shown = Item & { phase: "in" | "idle" | "out" };

function itemsOf(strip: Strip): Item[] {
  const out: Item[] = strip.entries.map((e) => ({ key: e.id, entry: e, more: 0 }));
  if (strip.overflow > 0) out.push({ key: "+more", entry: null, more: strip.overflow });
  return out;
}

/** Keep leaving bubbles for one `dur` so they can fade + shrink; new ones get the enter animation — only while the
 *  motion switch is on (GPU.md §1: focused, no Reduce motion in the app or the OS); otherwise changes snap. */
function useAnimated(items: Item[]): Shown[] {
  const reduce = !useAnimate();
  const [list, setList] = useState<Shown[]>(() => items.map((i) => ({ ...i, phase: "idle" })));
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setList((prev) => {
      const live = new Set(prev.filter((p) => p.phase !== "out").map((p) => p.key));
      const next: Shown[] = items.map((i) => ({ ...i, phase: live.has(i.key) || reduce ? "idle" : "in" }));
      if (!reduce)
        prev.forEach((p, idx) => {
          if (!items.some((i) => i.key === p.key)) next.splice(Math.min(idx, next.length), 0, { ...p, phase: "out" });
        });
      return next;
    });
  }, [items, reduce]);
  useEffect(() => {
    if (!list.some((l) => l.phase === "out")) return;
    const t = window.setTimeout(() => setList((l) => l.filter((x) => x.phase !== "out")), durMs() + 40);
    return () => window.clearTimeout(t);
  }, [list]);
  return list;
}

/** Select People and bring a DM's row (an invite with Accept / Decline) into view. */
function revealRow(roomId: string): void {
  window.requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-row][data-room-id="${CSS.escape(roomId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
  });
}

export function openStripDm(e: DmStripEntry): void {
  hideTooltip();
  selectSpace("people");
  if (e.invite) revealRow(e.id);
  else openRoomId(e.id);
}

export function DmStrip() {
  const strip = useNavStore((st) => st.dmStrip);
  const items = useMemo(() => itemsOf(strip), [strip]);
  const shown = useAnimated(items);
  const [menu, setMenu] = useState<{ entry: DmStripEntry; x: number; y: number } | null>(null);
  if (!shown.length && !menu) return null;
  return (
    <>
      {shown.map((it) => (
        <div key={it.key} className={cx(s.slot, it.phase === "in" && s.enter, it.phase === "out" && s.leave)} data-dm-slot={it.key} aria-hidden={it.phase === "out" || undefined}>
          {it.entry ? <DmBubble entry={it.entry} onMenu={(x, y) => setMenu({ entry: it.entry!, x, y })} /> : <MoreBubble n={it.more} />}
        </div>
      ))}
      {menu && <DmMenu entry={menu.entry} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </>
  );
}

function DmMenu({ entry, x, y, onClose }: { entry: DmStripEntry; x: number; y: number; onClose: () => void }) {
  return (
    <Menu open modal onClose={onClose} anchor={{ x, y }} title={entry.name}>
      <MenuSectionLabel text={<span className={r.sectionName}>{entry.name}</span>} />
      {entry.invite ? (
        <>
          <MenuItem text="Accept" icon="dialog-ok-apply-symbolic" onTriggered={() => void acceptInvite(entry.id, entry.name)} />
          <MenuItem text="Decline" icon="dialog-close-symbolic" onTriggered={() => void rejectInvite(entry.id, entry.name)} />
        </>
      ) : (
        <>
          <MenuItem text="Open" icon="go-next-symbolic" onTriggered={() => openStripDm(entry)} />
          <MenuItem text="Mark as read" icon="checkmark-symbolic" onTriggered={() => void markRoomRead(entry.id)} />
        </>
      )}
    </Menu>
  );
}

/** Touch: long-press (500 ms, ≤ 10 px of travel) = right-click; the tap that ends it is swallowed. */
function useLongPress(onContext: (x: number, y: number) => void) {
  const lp = useRef<{ t: number; x: number; y: number } | null>(null);
  const fired = useRef(false);
  useEffect(
    () => () => {
      if (lp.current) window.clearTimeout(lp.current.t);
    },
    [],
  );
  const cancel = () => {
    if (lp.current) window.clearTimeout(lp.current.t);
    lp.current = null;
  };
  return {
    fired,
    handlers: {
      onPointerDown: (e: RPointerEvent) => {
        if (e.pointerType !== "touch") return;
        const x = e.clientX,
          y = e.clientY;
        lp.current = {
          t: window.setTimeout(() => {
            lp.current = null;
            fired.current = true;
            window.setTimeout(() => (fired.current = false), 800);
            navigator.vibrate?.(10);
            swallowNextClick();
            onContext(x, y);
          }, 500),
          x,
          y,
        };
      },
      onPointerMove: (e: RPointerEvent) => {
        const l = lp.current;
        if (l && Math.hypot(e.clientX - l.x, e.clientY - l.y) > 10) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
  };
}

function DmBubble({ entry, onMenu }: { entry: DmStripEntry; onMenu: (x: number, y: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const pres = usePresence(entry.peer || null);
  const n = entry.unread;
  const tip = entry.invite
    ? `${entry.name} wants to chat — click to look`
    : `${entry.name} — ${n === 1 ? "1 new message" : `${n} new messages`}${pres ? ` · ${viewOf(pres).label}` : ""}`;
  useTip(ref, tip);
  const lp = useLongPress(onMenu);
  return (
    <button
      ref={ref}
      type="button"
      className={r.bubble}
      data-dm={entry.id}
      data-invite={entry.invite ? "" : undefined}
      aria-label={tip}
      onPointerEnter={(e) => e.pointerType !== "touch" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      {...lp.handlers}
      onClick={() => {
        if (lp.fired.current) {
          lp.fired.current = false;
          return;
        }
        openStripDm(entry);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (lp.fired.current) return; // Android fires contextmenu after our long-press
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className={r.pill} style={{ height: hover ? 18 : 0 }} />
      <span className={r.disc} style={{ borderRadius: 22 }}>
        <Avatar size={44} radius={22} name={entry.name} seed={avatarSeed(entry.id, entry.peer)} imageSource={entry.avatar || null} style={entry.invite ? { opacity: 0.7 } : undefined} />
      </span>
      {entry.invite && (
        <svg className={r.inviteRing} width="52" height="52" viewBox="0 0 52 52" aria-hidden>
          <rect x="1" y="1" width="50" height="50" rx="25" ry="25" fill="none" stroke="var(--th-dm-invite-ring)" strokeWidth="2" strokeDasharray="4 3" />
        </svg>
      )}
      {entry.invite && <span className={r.inviteDot} />}
      {!entry.invite && n > 0 && <UnreadBadge count={n} highlight className={r.badge} />}
      {pres && <PresenceDot row={pres} size={12} ring="var(--th-dm-presence-ring)" ringWidth={2} className={s.presence} />}
    </button>
  );
}

function MoreBubble({ n }: { n: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const tip = `${n} more — open People`;
  useTip(ref, tip);
  return (
    <button
      ref={ref}
      type="button"
      className={r.bubble}
      data-dm-more={n}
      aria-label={tip}
      onPointerEnter={(e) => e.pointerType !== "touch" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={() => {
        hideTooltip();
        selectSpace("people");
      }}
    >
      <span className={r.pill} style={{ height: hover ? 18 : 0 }} />
      <span className={r.disc} data-meta="" data-lit={hover ? "" : undefined} style={{ borderRadius: hover ? 12 : 22 }}>
        <span className={s.more}>+{n}</span>
      </span>
    </button>
  );
}
