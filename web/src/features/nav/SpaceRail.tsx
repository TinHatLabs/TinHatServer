// SpaceRail.tsx — ThSpaceRail.qml: the 68 px spaces rail. Meta bubbles (Home, Favourites,
// People, Rooms) pinned at the top, the DM strip (REACH §1: unread DMs + DM invites, DmStrip.tsx — it
// pushes the spaces down and is not rendered at all while empty), a divider, the user's real spaces in their saved drag order
// (scrolls when it overflows), invited spaces after them, a divider and the "+" disc pinned at the
// foot. Selection pill + squircle, hover morph, rollup badges, drag-to-reorder (≥ 6 px vertical),
// right-click menus (space menu / invited-space Join-Decline menu).
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { Avatar, Icon, Menu, MenuItem, MenuSectionLabel, UnreadBadge, avatarSeed, hideTooltip, useIsland, useTip } from "@/ui";
import { selectSpace, setDragging, setSpaceOrder, useNavStore, type SpaceEntry } from "./model";
import { SpaceMenu } from "./menus";
import { DmStrip } from "./DmStrip";
import { acceptInvite, rejectInvite } from "./actions";
import { openNavDialog } from "./dialogs";
import { swallowNextClick } from "./touch";
import { railOrder, type PhoneSections } from "./sections";
import s from "./SpaceRail.module.css";

const SLOT = 56; // bubble 52 + spacing 4
let railScroll = 0;

/** The phone rail (the stack's home): the three islands' contents in one 68 px column, as before islands. */
export function SpaceRail({ mobile, sections }: { mobile?: boolean; sections?: PhoneSections }) {
  const st = useSpacesState(mobile);
  // 11.0 (EDITMODE-UI §12): the phone form's rail sections, in its order (absent = nav · dms · spaces)
  const part = (r: string) =>
    r === "nav" ? <MetaBubbles key="nav" meta={st.meta} activeKey={st.activeKey} /> : r === "dms" ? <DmStrip key="dms" /> : <SpacesList key="spaces" {...st} />;
  return (
    <div className={s.rail} data-mobile={mobile ? "" : undefined}>
      <div className={s.col}>{sections ? railOrder(sections).map(part) : (["nav", "dms", "spaces"] as const).map(part)}</div>
      <SpaceMenus menu={st.menu} onClose={() => st.setMenu(null)} />
    </div>
  );
}

// ---- the rail's three islands (islands C6/C7, ISLANDS-ARCH §3.2; Main.qml's NavIsland / DmsIsland / SpacesIsland) ------
// The desktop dock host places each in its own frame (68 wide, inset 4): the 68 px bubbles are centred in the 60 px
// content box, so they sit exactly where they sat in the rail (the pill on the island's edge, under its frame).

/** `nav`: the meta spaces (Home · Favourites · People · Rooms). */
export function NavIsland({ orient }: { orient?: "v" | "h" } = {}) {
  const spaces = useNavStore((st) => st.spaces);
  const activeKey = useNavStore((st) => st.activeKey);
  const meta = spaces.filter((sp) => sp.kind === "meta");
  const ref = useRef<HTMLDivElement>(null);
  useRowReport(ref, orient === "h");
  return (
    <div ref={ref} className={s.islandCol} data-orient={orient === "h" ? "h" : undefined}>
      <MetaBubbles meta={meta} activeKey={activeKey} />
    </div>
  );
}

/**
 * 11.0 (decision 6, the Side monitor preset): an island laid out in a row (`opts.<ref>.orient = "h"`) reports its
 * natural width to the dock host (the registry's orientH pref is `auto` along the row), measured on its max-content
 * row; the island is "explicit"-measured then (Shell).
 */
function useRowReport(el: RefObject<HTMLElement | null>, on: boolean): void {
  const isl = useIsland();
  const report = isl?.report;
  useLayoutEffect(() => {
    const e = el.current;
    if (!on || !e || !report) return;
    // natural height = one bubble slot (52 px; the row itself fills the island to centre it)
    const send = () => report({ w: Math.ceil(e.scrollWidth), h: 52 });
    const ro = new ResizeObserver(send);
    ro.observe(e);
    send();
    return () => ro.disconnect();
  }, [el, on, report]);
}

/** `dms`: the DM strip (unread DMs + DM invites, "+N"); the island is absent while it is empty (useDmStripEmpty). */
export function DmsIsland({ orient }: { orient?: "v" | "h" } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  useRowReport(ref, orient === "h");
  return (
    <div ref={ref} className={s.islandCol} data-orient={orient === "h" ? "h" : undefined}>
      <DmStrip />
    </div>
  );
}
/** The DM strip has nothing to show (the `dms` island leaves the layout). */
export function useDmStripEmpty(): boolean {
  return useNavStore((st) => st.dmStrip.entries.length === 0 && st.dmStrip.overflow === 0);
}

/** `spaces`: the divider, the real spaces (drag to reorder, scrolls), add / join — fills its island. */
export function SpacesIsland({ orient }: { orient?: "v" | "h" } = {}) {
  const st = useSpacesState(false);
  const h = orient === "h";
  return (
    <div className={s.islandSpaces} data-orient={h ? "h" : undefined}>
      {/* a row: no drag-to-reorder in 11.0 (its maths is vertical; EDITMODE-UI §17) */}
      <SpacesList {...st} startPress={h ? noPress : st.startPress} />
      <SpaceMenus menu={st.menu} onClose={() => st.setMenu(null)} />
    </div>
  );
}

type SpacesState = ReturnType<typeof useSpacesState>;
type RailMenu = { entry: SpaceEntry; x: number; y: number } | null;

/** The spaces list's state: the live drag (committed on release), the scroll memory, the context menu. */
function useSpacesState(mobile?: boolean) {
  const spaces = useNavStore((st) => st.spaces);
  const activeKey = useNavStore((st) => st.activeKey);
  const meta = spaces.filter((sp) => sp.kind === "meta");
  const real = spaces.filter((sp) => sp.kind === "space" && sp.membership !== "invite");
  const invited = spaces.filter((sp) => sp.kind === "space" && sp.membership === "invite");
  const stripShown = useNavStore((st) => st.dmStrip.entries.length > 0);

  // drag state (local; committed on release)
  const [drag, setDrag] = useState<{ key: string; order: string[]; dy: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // the rail keeps its scroll position across remounts (phone stack, dock open/close)
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = railScroll;
    const save = () => (railScroll = el.scrollTop);
    el.addEventListener("scroll", save, { passive: true });
    return () => el.removeEventListener("scroll", save);
  }, []);
  const [menu, setMenu] = useState<RailMenu>(null);

  const ordered = drag ? drag.order.map((k) => real.find((r) => r.key === k)).filter((x): x is SpaceEntry => !!x) : real;

  // the live gesture's teardown (one reorder at a time; also run on unmount)
  const gesture = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      gesture.current?.();
    },
    [],
  );

  const startPress = (e: RPointerEvent, entry: SpaceEntry) => {
    if (e.button !== 0 || gesture.current) return;
    const pid = e.pointerId;
    const invite = entry.membership === "invite";
    const startY = e.clientY;
    const el = e.currentTarget as HTMLElement;
    const grab = startY - el.getBoundingClientRect().top;
    let dragging = false;
    let order = real.map((r) => r.key);
    const list = listRef.current;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return; // a second finger never drives this gesture
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (invite || mobile || Math.abs(dy) < 6) return;
        dragging = true;
        hideTooltip();
        setDragging(true);
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      // the slot under the pointer → live swap
      const from = order.indexOf(entry.key);
      if (list) {
        const top = list.getBoundingClientRect().top - list.scrollTop;
        const slot = Math.max(0, Math.min(order.length - 1, Math.floor((ev.clientY - top) / SLOT)));
        if (slot !== from) {
          order = [...order];
          order.splice(from, 1);
          order.splice(slot, 0, entry.key);
        }
        const idx = order.indexOf(entry.key);
        const slotTop = top + idx * SLOT;
        // follow the pointer on Y (the grab offset keeps the bubble under the pointer)
        setDrag({ key: entry.key, order, dy: ev.clientY - grab - slotTop });
      }
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      gesture.current = null;
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      detach();
      if (dragging && ev.type === "pointercancel") {
        // cancelled (scroll takeover, window lost): drop the drag, keep the saved order
        setDrag(null);
        setDragging(false);
        return;
      }
      if (dragging) {
        setDrag(null);
        setDragging(false);
        setSpaceOrder(order);
        // swallow the click that follows a drag
        const kill = (ce: MouseEvent) => {
          ce.stopPropagation();
          ce.preventDefault();
        };
        window.addEventListener("click", kill, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", kill, { capture: true }), 50);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    gesture.current = () => {
      detach();
      if (dragging) setDragging(false); // unmounted mid-drag: release the held rail updates, commit nothing
    };
  };

  return {
    meta,
    activeKey,
    showDivider: real.length > 0 || invited.length > 0 || stripShown,
    listRef,
    ordered,
    invited,
    drag,
    startPress,
    menu,
    setMenu,
    onMenu: (entry: SpaceEntry, x: number, y: number) => setMenu({ entry, x, y }),
  };
}

const noPress = () => undefined;

/** A space's right-click menu (an invited space: Join / Decline) — portaled, so it lives with the list's state. */
function SpaceMenus({ menu, onClose }: { menu: RailMenu; onClose: () => void }) {
  if (!menu) return null;
  if (menu.entry.membership === "invite")
    return (
      <Menu open modal onClose={onClose} anchor={{ x: menu.x, y: menu.y }} title={menu.entry.label}>
        <MenuSectionLabel text={<span className={s.sectionName}>{menu.entry.label}</span>} />
        <MenuItem text="Join space" icon="list-add-user" onTriggered={() => void acceptInvite(menu.entry.key, menu.entry.label)} />
        <MenuItem text="Decline" icon="dialog-close-symbolic" onTriggered={() => void rejectInvite(menu.entry.key, menu.entry.label)} />
      </Menu>
    );
  return <SpaceMenu spaceId={menu.entry.key} label={menu.entry.label} anchor={{ x: menu.x, y: menu.y }} onClose={onClose} />;
}

/** The meta spaces' bubbles (Home, Favourites, People, Rooms). */
function MetaBubbles({ meta, activeKey }: { meta: SpaceEntry[]; activeKey: string }) {
  return (
    <>
      {meta.map((m) => (
        <Bubble key={m.key} entry={m} selected={activeKey === m.key} />
      ))}
    </>
  );
}

/** The divider, the real spaces (+ invited ones after them), the divider and the "+". */
function SpacesList(p: Pick<SpacesState, "showDivider" | "listRef" | "ordered" | "invited" | "activeKey" | "drag" | "startPress" | "onMenu">) {
  return (
    <>
      {/* one divider under the strip = the one above the real spaces (REACH §1.2) */}
      {p.showDivider && <div className={s.divider} />}
      <div className={s.list} ref={p.listRef}>
        {p.ordered.map((sp) => (
          <Bubble
            key={sp.key}
            entry={sp}
            selected={p.activeKey === sp.key}
            dragging={p.drag?.key === sp.key}
            dragDy={p.drag?.key === sp.key ? p.drag.dy : 0}
            anyDrag={!!p.drag}
            onPointerDown={(e) => p.startPress(e, sp)}
            onContext={(x, y) => p.onMenu(sp, x, y)}
          />
        ))}
        {p.invited.map((sp) => (
          <Bubble key={sp.key} entry={sp} selected={p.activeKey === sp.key} onContext={(x, y) => p.onMenu(sp, x, y)} />
        ))}
      </div>
      <div className={s.divider} />
      <AddItem />
    </>
  );
}

function Bubble({
  entry,
  selected,
  dragging,
  dragDy = 0,
  anyDrag,
  onPointerDown,
  onContext,
}: {
  entry: SpaceEntry;
  selected: boolean;
  dragging?: boolean;
  dragDy?: number;
  anyDrag?: boolean;
  onPointerDown?: (e: RPointerEvent) => void;
  onContext?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const invite = entry.membership === "invite";
  const meta = entry.kind === "meta";
  const tip = meta ? entry.label : invite ? `Invited by ${entry.inviter || entry.inviterMxid?.replace(/^@([^:]+):.*/, "$1") || "someone"} — click to look` : `${entry.label}  ·  drag to reorder`;
  useTip(ref, tip, { disabled: anyDrag });
  // touch: long-press = right-click (iOS Safari fires no contextmenu); the ending tap is swallowed
  const lp = useRef<{ t: number; x: number; y: number } | null>(null);
  const lpFired = useRef(false);
  useEffect(
    () => () => {
      if (lp.current) window.clearTimeout(lp.current.t);
    },
    [],
  );
  const morph = selected || hover || dragging;
  const radius = morph ? 12 : 22;
  const pillH = selected ? 32 : hover ? 18 : 0;
  const icon = meta ? (entry.key === "home" ? "go-home-symbolic" : entry.key === "favourites" ? "starred-symbolic" : entry.key === "people" ? "system-users-symbolic" : "view-list-details-symbolic") : "";
  return (
    <button
      ref={ref}
      type="button"
      className={s.bubble}
      data-dragging={dragging ? "" : undefined}
      data-selected={selected ? "" : undefined}
      aria-label={entry.label}
      aria-current={selected ? "true" : undefined}
      style={dragging ? { transform: `translateY(${dragDy}px)`, zIndex: 5, transition: "none" } : undefined}
      onPointerEnter={(e) => e.pointerType !== "touch" && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        if (e.pointerType !== "touch" || meta || !onContext) return;
        const x = e.clientX,
          y = e.clientY;
        lp.current = {
          t: window.setTimeout(() => {
            lp.current = null;
            lpFired.current = true;
            window.setTimeout(() => (lpFired.current = false), 800);
            navigator.vibrate?.(10);
            swallowNextClick();
            onContext(x, y);
          }, 500),
          x,
          y,
        };
      }}
      onPointerMove={(e) => {
        const l = lp.current;
        if (l && Math.hypot(e.clientX - l.x, e.clientY - l.y) > 10) {
          window.clearTimeout(l.t);
          lp.current = null;
        }
      }}
      onPointerUp={() => {
        if (lp.current) window.clearTimeout(lp.current.t);
        lp.current = null;
      }}
      onPointerCancel={() => {
        if (lp.current) window.clearTimeout(lp.current.t);
        lp.current = null;
      }}
      onClick={() => {
        if (lpFired.current) {
          lpFired.current = false;
          return;
        }
        selectSpace(entry.key);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (lpFired.current) return; // Android fires contextmenu after our long-press
        if (!meta && onContext) onContext(e.clientX, e.clientY);
      }}
    >
      <span className={s.pill} style={{ height: pillH, ["--pill-len" as string]: `${pillH}px` }} />
      <span className={s.disc} style={{ borderRadius: radius, transform: dragging ? "scale(1.12)" : undefined }} data-meta={meta ? "" : undefined} data-lit={meta && morph ? "" : undefined}>
        {meta ? (
          <Icon name={icon} size={24} color={morph ? "var(--th-rail-nav-icon-active)" : "var(--th-rail-nav-icon)"} accentColor={morph ? "var(--th-rail-nav-icon-lit-active)" : "var(--th-rail-nav-icon-lit)"} hovered={hover} active={selected} />
        ) : (
          <Avatar size={44} radius={radius} name={entry.label} seed={avatarSeed(entry.key)} imageSource={entry.avatar || null} style={invite ? { opacity: 0.7 } : undefined} />
        )}
      </span>
      {!meta && selected && !invite && <span className={s.ring} style={{ borderRadius: radius + 4 }} />}
      {invite && (
        <svg className={s.inviteRing} width="52" height="52" viewBox="0 0 52 52" aria-hidden>
          <rect x="1" y="1" width="50" height="50" rx={radius + 3} ry={radius + 3} fill="none" stroke="var(--th-space-invite-ring)" strokeWidth="2" strokeDasharray="4 3" />
        </svg>
      )}
      {invite && <span className={s.inviteDot} />}
      {entry.unread > 0 && <UnreadBadge count={entry.unread} highlight={entry.highlight} className={s.badge} />}
    </button>
  );
}

function AddItem() {
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  useTip(ref, "Join with a link, or make a space");
  return (
    <div className={s.addRow}>
      <button
        ref={ref}
        type="button"
        className={s.add}
        aria-label="Join with a link, or make a space"
        onPointerEnter={(e) => e.pointerType !== "touch" && setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={() => openNavDialog({ kind: "joinSpace" })}
      >
        <Icon name="list-add-symbolic" size={22} color={hover ? "var(--th-space-add-icon-hover)" : "var(--th-space-add-icon)"} hovered={hover} />
      </button>
    </div>
  );
}
