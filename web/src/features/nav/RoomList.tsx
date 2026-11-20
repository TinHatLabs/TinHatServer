// RoomList.tsx — ThRoomList.qml: the room panel next to the rail. Header (active space label, the
// hover gear, "+" → app menu), the "Filter rooms…" field (Ctrl+F, Esc clears, Down → list; the first
// match highlighted, Enter acts on it — typing never opens a room, P1 2026-11-14), the rows (invites pinned, joinable "Not joined"
// rows, call participant strip, now-playing line + inline editor, statuses), empty states, the
// invited-space card, and the floating footer card (you · bug · nav toggle · ☰).
// 11.0 (islands C6/C7): on the desktop the dock host places three islands out of this file — `rooms` (RoomsIsland: the
// header, the filter, the list, with the sign-in busy mark above them; no own background, fade or card inset), `widgets`
// (WidgetsIsland: r.railExtras) and `account` (AccountIsland: the card, with the one-time question card floating just
// above it). Phones keep the whole panel (RoomPanel) exactly as before.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type RefObject } from "react";
import { bus, useBus } from "@/core/bus";
import { EditableRow, RowButton, bespokeOk, shownItems, useRow } from "@/actions/ui/rowHost";
import { useRoomName, useSession, useUserProfile } from "@/core/matrix";
import { useRegistry } from "@/core/registry";
import { useShortcut } from "@/core/shortcuts";
import {
  Avatar,
  BasicTextField,
  BusyIndicator,
  Button,
  GlowButton,
  HintLabel,
  Icon,
  Menu,
  MenuItem,
  SearchField,
  ToolButton,
  UnreadBadge,
  cx,
  hideTooltip,
  localpart,
  useTip,
  useContentInk,
  useIsland,
  useStillLabel,
  avatarSeed,
} from "@/ui";
import { PadRoomListBar } from "@/features/pad";
import { acceptInvite, rejectInvite, setActivity } from "./actions";
import { openNavDialog } from "./dialogs";
import { NO_ROOMS_LABEL, noRoomsPlan, type NoRoomsPlan } from "./firstrun";
import { newRoomOpen } from "./newMenu";
import { AppMenu, NewMenu, RegistryMenuItems, RoomMenu, openBugReport } from "./menus";
import { setEditingRoom, useNavStore, type Participant, type RoomRow, type SpaceEntry } from "./model";
import { useNavMode, toggleSidebar } from "./navmode";
import { openRoomId } from "./open";
import { rowGesture } from "./rowGesture";
import { filterEnter, filterRooms } from "./roomFilter";
import { runAction } from "@/actions/run";
import { usePartGlyphs } from "./callinfo";
import { ParticipantVolumeMenu } from "@/features/callui";
import { useServerFeature } from "@/core/server";
import { accountName } from "@/features/guests/model";
import { MyStatusLine, StatusPopover, avatarDot, useMyPresence, usePresence, viewOf } from "@/features/presence";
import { TourOfferCard } from "@/features/selfhost/asks";
import { openQuickSwitcher, searchEverywhere } from "./QuickSwitcher";
import { useIsTouch } from "@/core/device";
import { swallowNextClick } from "./touch";
import { listPlan, type PhoneSections } from "./sections";
import s from "./RoomList.module.css";
import { PersonName, PrestigeFor } from "@/features/spaces/PersonName";
import { PrestigeInRow } from "@/features/spaces/PrestigeInRow";

const scrollMemory = new Map<string, number>();

// 12.1.5 double-click → call: ONE armed row for the whole list (Astra 2026-10-30, second pass). A joined row's own first
// click arms it; any press that is not on a row, or is on a control inside one (Accept, Decline, the now-playing pencil /
// editor), disarms it; a click on another row re-arms or disarms. The browser pairs two clicks by time and distance, not
// by element, so an arm kept per row could be paired with a press that began somewhere else.
const rowArm = { room: "", t: 0 };
const disarmRows = () => {
  rowArm.room = "";
  rowArm.t = 0;
};
function onRowControl(target: EventTarget | null, row: Element): boolean {
  const hit = (target as Element | null)?.closest?.("button, input, textarea, select, [contenteditable], [role='button']");
  return !!hit && hit !== row && row.contains(hit);
}
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const row = (e.target as Element | null)?.closest?.("[data-row]");
      if (!row || onRowControl(e.target, row)) disarmRows();
    },
    true,
  );
}

export interface RoomPanelProps {
  currentRoomId: string | null;
  /** inside the corner dock (256 px list) */
  inDock?: boolean;
  /** Ctrl+F owner (the visible nav) */
  active?: boolean;
  mobile?: boolean;
  /** a room was picked / the bug button pressed (the dock closes) */
  onPicked?: () => void;
  /** 11.0: the dock host's `rooms` island — header, filter and list only (the card, the widgets and the question cards
   *  are islands of their own) */
  island?: boolean;
  /** 11.0 (EDITMODE-UI §12, phones): the phone form's list sections — rooms shown, widgets before / after the rows,
   *  the account card at the top / bottom, each possibly hidden; absent = today */
  sections?: PhoneSections;
}

/** The card floating above the footer card (the notification question, else the presence question): its height
 *  + 8, so the list's last room and the footer fade clear it too (desktop ThRoomList: bottomMargin + askCard.height + 8). */
function useFloatingCardHeight(ref: RefObject<HTMLDivElement | null>): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const panel = ref.current;
    if (!panel || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    const cards = () => panel.querySelectorAll<HTMLElement>(":scope > [data-status-question], :scope > [data-notify-question]");
    const measure = () => {
      let max = 0;
      cards().forEach((el) => (max = Math.max(max, el.offsetHeight)));
      setH(max ? max + 8 : 0);
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      cards().forEach((el) => ro.observe(el));
      measure();
    };
    const mo = new MutationObserver(watch);
    mo.observe(panel, { childList: true });
    watch();
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [ref]);
  return h;
}

export function RoomPanel({ currentRoomId, inDock, active = true, mobile, onPicked, island, sections }: RoomPanelProps) {
  // 12.1.5 (assembly review): another room on screen (keyboard Alt+Up/Down, Ctrl+K, a notification…) disarms the
  // double-click; the armed room's own click opening it does not (the desktop's RoomsIsland.qml does the same)
  useEffect(() => {
    if (currentRoomId !== rowArm.room) disarmRows();
  }, [currentRoomId]);
  const plan = mobile && sections ? listPlan(sections) : null;
  const touch = useIsTouch();
  const rooms = useNavStore((st) => st.rooms);
  const activeKey = useNavStore((st) => st.activeKey);
  const activeLabel = useNavStore((st) => st.activeLabel);
  const loaded = useNavStore((st) => st.loaded);
  const spaces = useNavStore((st) => st.spaces);
  const editingRoomId = useNavStore((st) => st.editingRoomId);
  const session = useSession();
  const activeEntry = spaces.find((sp) => sp.key === activeKey);
  const activeInvited = activeEntry?.membership === "invite";
  const realSpace = activeKey.startsWith("!");

  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const floatCard = useFloatingCardHeight(panelRef);
  const filterRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ kind: "app" | "new"; anchor: HTMLElement | { x: number; y: number } } | { kind: "room"; roomId: string; x: number; y: number } | null>(null);
  // 11.0 buttons: the ☰ menu and the room filter from a button of your own or the Ctrl+K palette (features/actions)
  useBus("openSurface", (p) => {
    if (!active) return;
    if (p.id === "appMenu") setMenu({ kind: "app", anchor: p.anchor ?? { x: 16, y: window.innerHeight - 64 } });
    else if (p.id === "roomFilter" && filterRef.current) {
      filterRef.current.focus();
      filterRef.current.select();
    }
  });
  const [partMenu, setPartMenu] = useState<{ userId: string; roomId: string; x: number; y: number } | null>(null);

  // ---- scroll memory per rail key (phones: the list unmounts while a room is open — coming back
  // must land where you were, not at the top) ----
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = scrollMemory.get(activeKey) ?? 0;
    const save = () => scrollMemory.set(activeKey, el.scrollTop);
    el.addEventListener("scroll", save, { passive: true });
    return () => el.removeEventListener("scroll", save);
  }, [activeKey, activeInvited]);

  // ---- rows never move under the pointer (TH-NAV-05) ----
  const [hovered, setHovered] = useState(false);
  const frozen = useRef<string[] | null>(null);
  const ordered = useMemo(() => {
    const byId = new Map(rooms.map((r) => [r.id, r]));
    if (hovered && frozen.current) {
      const keep = frozen.current.filter((id) => byId.has(id));
      // new rows go in at their sorted index
      for (let i = 0; i < rooms.length; i++) {
        const id = rooms[i]!.id;
        if (!keep.includes(id)) keep.splice(Math.min(i, keep.length), 0, id);
      }
      return keep.map((id) => byId.get(id)!);
    }
    return rooms;
  }, [rooms, hovered]);
  useEffect(() => {
    frozen.current = ordered.map((r) => r.id);
  }, [ordered]);

  // ---- filter (ACTIONS.md §10.8: the shared matcher — accents, the address / the DM's handle, is:unread, is:mention) ----
  const q = query.trim();
  const filtered = useMemo(() => filterRooms(query, ordered), [query, ordered]);
  const matches = useCallback((r: RoomRow) => filtered.shown.has(r.id), [filtered]);
  // P1 (2026-11-14): the row Enter acts on, drawn highlighted while the filter has text; typing never opens it
  const firstId = filtered.first?.id ?? "";
  // the row the keyboard is on (the Tab stop moves with it while inside the list; leaving the list resets it)
  const [kbRow, setKbRow] = useState("");
  // a11y round 2 (M2, the desktop's RoomsIsland does the same): the room list is ONE Tab stop — the row of the room on
  // screen when the filter shows it, else the first row it shows (the other rows: ↑/↓/Home/End from there)
  const matchCount = ordered.filter(matches).length;

  const pick = useCallback(
    (id: string) => {
      openRoomId(id);
      onPicked?.();
    },
    [onPicked],
  );
  // P1 (2026-11-14, replaces D5's 100 ms auto-accept, which opened — and marked read — every room you typed past): the
  // field only filters; Enter acts on the first match as a click on it would (open, or the join dialog)
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return; // mount / StrictMode re-run: nothing was typed
    lastQuery.current = query;
    listRef.current?.scrollTo({ top: 0 });
  }, [query]);

  useShortcut(
    "Ctrl+F",
    () => {
      if (activeInvited || !filterRef.current) return false;
      filterRef.current.focus();
      filterRef.current.select();
    },
    { enabled: active && !mobile, whenTyping: true, action: "nav.roomList.filter" },
  );
  const filterWrap = useRef<HTMLSpanElement>(null);
  useTip(filterWrap, query ? "" : "Ctrl+F", { delay: 700 });

  // A01.0 / P4 (Sunday QoL): phones have no start page beside the list — an account with no rooms at all gets the same
  // "No rooms yet" + New DM / New room here (the desktop layout shows it in the timeline island, Shell.tsx)
  const joinedRooms = useNavStore((st) => st.globalRooms.filter((r) => r.membership === "join").length);
  const invitedRooms = useNavStore((st) => st.globalRooms.filter((r) => r.membership === "invite").length);
  const noRooms = loaded && session.state === "ready" ? noRoomsPlan(joinedRooms, invitedRooms) : null;

  // ---- empty label ----
  let empty = "";
  if (matchCount === 0 && !activeInvited) {
    if (q) empty = "No matching rooms";
    else if (session.syncDown) empty = "Can't reach the server — your rooms will show up when it's back";
    else if (!loaded || session.state !== "ready") empty = "Catching up…";
    else empty = "No rooms here yet";
  }

  // header gear fades in on hover (joined real space only)
  const [headHover, setHeadHover] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);

  const rovingId =
    (ordered.find((r) => r.id === kbRow && matches(r)) ?? ordered.find((r) => r.id === currentRoomId && matches(r)) ?? ordered.find((r) => matches(r)))?.id ?? "";
  return (
    <div
      ref={panelRef}
      className={island ? cx(s.panel, s.islandRooms) : s.panel}
      data-dock={inDock ? "" : undefined}
      data-mobile={mobile ? "" : undefined}
      style={floatCard ? ({ "--float-card": `${floatCard}px` } as CSSProperties) : undefined}
    >
      {island && <RoomsBusyMark />}
      {plan?.account === "top" && <AccountCard active={active} mobile={mobile} onBug={() => (openBugReport(), onPicked?.())} onMenu={(el) => setMenu({ kind: "app", anchor: el })} />}
      {(!plan || plan.rooms) && (
      <div className={s.header} onPointerEnter={() => setHeadHover(true)} onPointerLeave={() => setHeadHover(false)}>
        <div className={s.headLabel} style={{ marginRight: mobile ? 8 + 46 * (2 + (realSpace && !activeInvited ? 1 : 0)) : touch ? 8 + 44 * (1 + (realSpace && !activeInvited ? 1 : 0)) : 8 + 32 + (realSpace && !activeInvited ? 28 : 0) }}>
          {activeLabel}
        </div>
        {realSpace && !activeInvited && (
          <ToolButton
            className={cx(s.headBtn, s.gear)}
            style={{ opacity: headHover || mobile ? 1 : undefined }}
            iconName="configure-symbolic"
            iconSize={16}
            tip="Space settings  (Ctrl+Shift+,)"
            onClick={() => bus.emit("openSpaceSettings", { spaceId: activeKey, tab: "overview" })}
          />
        )}
        {mobile && (
          <ToolButton className={cx(s.headBtn, s.searchBtn)} iconName="edit-find" iconSize={16} tip="Jump to room…" onClick={() => openQuickSwitcher()} />
        )}
        <ToolButton
          ref={plusRef}
          className={s.headBtn}
          iconName="list-add-symbolic"
          iconSize={16}
          tip={activeKey.startsWith("!") ? "New DM or room" : "New DM"}
          onClick={(e) => setMenu({ kind: "new", anchor: e.currentTarget })}
        />
      </div>
      )}
      {!activeInvited && (!plan || plan.rooms) && (
        <div className={s.filter}>
          <span ref={filterWrap} className={s.filterWrap}>
            <SearchField
              ref={filterRef}
              className={s.search}
              placeholder="Filter rooms…"
              aria-label="Filter rooms"
              value={query}
              onValueChange={setQuery}
              onAccepted={(v) => {
                // Enter (phones: the search key) = a click on the first match; an empty field (the ✕) does nothing
                const go = filterEnter(v, ordered);
                if (go?.kind === "askJoin") openNavDialog({ kind: "joinConfirm", roomId: go.row.id, name: go.row.name });
                else if (go?.kind === "open") pick(go.row.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  listRef.current?.querySelector<HTMLElement>("[data-row]:not([hidden])")?.focus();
                }
              }}
            />
          </span>
        </div>
      )}
      {activeInvited && activeEntry ? (
        <SpaceInviteCard entry={activeEntry} />
      ) : (
        <div
          ref={listRef}
          className={s.list}
          data-rooms-list=""
          onPointerEnter={(e) => e.pointerType !== "touch" && setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          {(!plan || plan.rooms) && <PadRoomListBar />}
          {plan?.widgets === "before" && <RailExtras mobile />}
          {/* a11y round 2 (M5): the "Rooms" list holds only its rows (the Pad bar, the widgets and the empty line are not
              list items — screen readers mis-counted it); display: contents, so nothing moves */}
          <div
            className={s.rowsList}
            role="list"
            aria-label="Rooms"
            onFocus={(e) => {
              const id = (e.target as HTMLElement).closest?.("[data-row]")?.getAttribute("data-room-id");
              if (id && (e.target as HTMLElement).hasAttribute("data-row")) setKbRow(id);
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKbRow("");
            }}
          >
          {(!plan || plan.rooms) && ordered.map((r) => (
            <RoomRowView
              key={r.id}
              row={r}
              roving={r.id === rovingId}
              hidden={!matches(r)}
              first={r.id === firstId}
              selected={r.id === currentRoomId}
              isOpen={r.id === currentRoomId}
              editing={r.id === editingRoomId}
              mobile={mobile}
              onPick={pick}
              onMenu={(roomId, x, y) => setMenu({ kind: "room", roomId, x, y })}
              onPartMenu={(userId, x, y) => setPartMenu({ userId, roomId: r.id, x, y })}
            />
          ))}
          </div>
          {empty && (!plan || plan.rooms) && (mobile && noRooms && !q ? (
            <NoRoomsCard plan={noRooms} />
          ) : (
            <div className={s.empty}>
              {empty}
              {/* A10.3: no room matches — the same text in Ctrl+K, which also finds people and actions */}
              {q && <Button className={s.emptyAction} text="Search everywhere" icon="edit-find" onClick={() => searchEverywhere(query)} />}
            </div>
          ))}
          {mobile && (!plan || plan.widgets === "after") && <RailExtras mobile />}
        </div>
      )}
      {!island && !inDock && !mobile && <RailExtras />}
      {!island && <div className={s.footerFade} />}
      {/* the calm first run (selfhost/firstrun): only the tour offer here — notifications and online status are asked
          later, in context (features/selfhost) */}
      {!island && <TourOfferCard mobile={mobile} />}
      {!island && (!plan || plan.account === "bottom") && <AccountCard active={active} mobile={mobile} onBug={() => (openBugReport(), onPicked?.())} onMenu={(el) => setMenu({ kind: "app", anchor: el })} />}
      {menu?.kind === "app" && <AppMenu anchor={menu.anchor} onClose={() => setMenu(null)} />}
      {menu?.kind === "new" && <NewMenu anchor={menu.anchor} onClose={() => setMenu(null)} />}
      {menu?.kind === "room" && <RoomMenu roomId={menu.roomId} anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
      {partMenu && <ParticipantMenu {...partMenu} onClose={() => setPartMenu(null)} />}
    </div>
  );
}

/** r.railExtras (widgets: the widget stack) — between the list and the account card; phones: inside the list. */
function RailExtras({ mobile, island }: { mobile?: boolean; island?: boolean }) {
  const extras = useRegistry("railExtras");
  return (
    <>
      {extras.map((x) => (
        <x.component key={x.id} mobile={mobile} island={island} />
      ))}
    </>
  );
}

// ---- the dock host's islands (islands C6/C7) ----------------------------------------------------------------------

/** `rooms`: the active space's name, the filter, the list (+ the invited-space card) — the island draws the fill. */
export function RoomsIsland({ currentRoomId, active, onPicked }: { currentRoomId: string | null; active: boolean; onPicked?: () => void }) {
  return <RoomPanel currentRoomId={currentRoomId} active={active} onPicked={onPicked} island />;
}

/** The sign-in / "Loading your rooms…" busy mark (GPU.md §2.5: still, stepping on each stage) above the room list. */
function RoomsBusyMark() {
  const session = useSession();
  const loaded = useNavStore((st) => st.loaded);
  const busy = session.state !== "ready" || !loaded;
  const label = useStillLabel(session.state === "starting" || session.state === "booting" ? "Signing in…" : "Loading your rooms…", busy && session.state !== "ready", session.state);
  if (!busy || session.state === "ready") return null;
  return (
    <div className={s.islandLoading}>
      <BusyIndicator size={32} progress={session.state} />
      <span>{label}</span>
    </div>
  );
}

/** `widgets`: r.railExtras (the widget stack sizes itself through useIsland()); none in corner mode (the desktop's
 *  WidgetHost.shown: no widgets in the drawer of corner mode, v1) — the island is then absent. */
export function WidgetsIsland() {
  const corner = useNavMode() === "corner";
  const none = useRegistry("railExtras").length === 0;
  const isl = useIsland();
  const report = isl?.report;
  useEffect(() => {
    if (corner || none) report?.({ empty: true });
  }, [corner, none, report]);
  return corner || none ? null : <RailExtras island />;
}

/** `account`: you, the bug button, the nav toggle, ☰ — with the calm first run's tour offer floating just above the
 *  island, over the room list, as it floated above the footer card. The Flat
 *  layout style (`flat`, 10.8): the island is flat on the room list's colour and the card is its own card again, 6 px in
 *  and 9 px up (the question card 8 px above the card), the way it sat before islands. */
export function AccountIsland({ onPicked, flat }: { onPicked?: () => void; flat?: boolean }) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  return (
    <div className={flat ? s.accountFlat : undefined}>
      <div className={s.accountAnchor}>
        <TourOfferCard island={flat ? "flat" : true} />
        <AccountCard island={flat ? "flat" : true} onBug={() => (openBugReport(), onPicked?.())} onMenu={(el) => setMenu(el)} />
      </div>
      {menu && <AppMenu anchor={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ---- one row -----------------------------------------------------------------------------------------

interface RowProps {
  row: RoomRow;
  /** a11y round 2 (M2): this row is the list's one Tab stop */
  roving: boolean;
  hidden: boolean;
  /** P1: the filter's first match — drawn highlighted, the one Enter in the filter acts on */
  first?: boolean;
  selected: boolean;
  isOpen: boolean;
  editing: boolean;
  mobile?: boolean;
  onPick: (id: string) => void;
  onMenu: (roomId: string, x: number, y: number) => void;
  onPartMenu: (userId: string, x: number, y: number) => void;
}

const RoomRowView = memo(function RoomRowView({ row, roving, hidden, first, selected, isOpen, editing, mobile, onPick, onMenu, onPartMenu }: RowProps) {
  const ink = useContentInk();
  const isInvite = row.membership === "invite";
  const notJoined = row.membership === "none";
  const isDM = row.dm;
  const openRow = !isDM && isOpen && !isInvite && !notJoined;
  const showActivity = !!row.activity;
  const editorShown = openRow && editing;
  const lp = useRef<{ t: number; x: number; y: number } | null>(null);
  const parts = row.participants;
  const shownParts = selected ? parts : parts.slice(0, 6);

  const lpFired = useRef(false);
  useEffect(
    () => () => {
      if (lp.current) window.clearTimeout(lp.current.t); // a row that vanishes mid-hold opens nothing
    },
    [],
  );
  // REACH §2.6 place 2: the peer's dot on a DM row; the state in the tooltip, or in the secondary line when
  // the row has one (a custom status, A4.5)
  const pres = usePresence(isDM ? row.peer || null : null);
  const presView = pres ? viewOf(pres) : null;
  const presRoom = useRoomName(pres?.state === "call" ? pres.room : null);
  const rowRef = useRef<HTMLDivElement>(null);
  useTip(rowRef, pres && presView ? `${row.name} · ${presView.label}${pres.state === "call" && presRoom ? ` · ${presRoom}` : ""}` : "", { delay: 600 });
  const click = () => {
    // the tap that ends a long-press must not also open the room
    if (lpFired.current) {
      lpFired.current = false;
      return;
    }
    const g = rowGesture({ gesture: "click", membership: row.membership });
    if (g === "askJoin") openNavDialog({ kind: "joinConfirm", roomId: row.id, name: row.name });
    else if (g === "open") onPick(row.id);
  };
  // 12.1.5 (2026-10-30): a double-click joins the room's call. The click before it has already opened the room
  // (never delayed); the browser's dblclick follows the OS double-click interval, so two slow clicks stay two clicks.
  // The join is the call.join action (the call button's path: its gates, the switch when in another call, and every
  // consent sheet inside joinCall). Invites, rooms you are not in, phones and touch input: nothing (rowGesture.ts).
  // Armed = the pair's first click landed on this row itself (not on Accept / a row button / the editor) while the row
  // was a joined room, and nothing was pressed since (rowArm above): a double-click that starts on Accept never joins.
  const lastPointer = useRef("mouse");
  const dblclick = (e: React.MouseEvent<HTMLDivElement>) => {
    const age = e.timeStamp - rowArm.t;
    const armed = rowArm.room === row.id && rowArm.t > 0 && age >= 0 && age < 5000;
    disarmRows();
    if (onRowControl(e.target, e.currentTarget)) return; // the row's own buttons and the editor
    // a mouse only: a touch or pen double-tap never joins (assembly review: a pen on a desktop-size tablet browser)
    if (rowGesture({ gesture: "dblclick", membership: row.membership, touch: !!mobile || lastPointer.current !== "mouse", armed }) !== "call") return;
    if (!selected) onPick(row.id);
    void runAction("call.join", { source: "host", target: { room: row.id } });
  };

  return (
    <div
      ref={rowRef}
      className={s.row}
      data-row=""
      data-room-id={row.id}
      data-presence={pres?.state}
      data-selected={selected ? "" : undefined}
      data-filter-first={first ? "" : undefined}
      role="listitem"
      tabIndex={roving ? 0 : -1}
      hidden={hidden}
      aria-label={row.name}
      onClick={(e) => {
        // a pair's first click arms the double-click (the second click, detail 2, never does)
        if (e.detail <= 1) {
          if (!onRowControl(e.target, e.currentTarget) && row.membership === "join" && lastPointer.current === "mouse") {
            rowArm.room = row.id;
            rowArm.t = e.timeStamp;
          } else disarmRows();
        }
        click();
      }}
      onDoubleClick={dblclick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // keys inside the now-playing editor / buttons are theirs
        if (e.key === "Enter") click();
        else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
          e.preventDefault();
          const rows = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-row]:not([hidden])") ?? [])];
          const i = rows.indexOf(e.currentTarget);
          const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
          rows[to]?.focus();
        } else if (e.key === "Escape") {
          // a11y round 2 (M2): back to the filter (the desktop's room list does the same)
          const f = e.currentTarget.closest(`.${s.panel}`)?.querySelector<HTMLElement>("input[aria-label='Filter rooms']");
          if (f) {
            e.preventDefault();
            e.stopPropagation();
            f.focus();
          }
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (lpFired.current) return; // Android also fires contextmenu after our long-press
        onMenu(row.id, e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        lastPointer.current = e.pointerType; // (a press on a control or outside the rows disarms: the document listener)
        if (e.pointerType !== "touch") return;
        const x = e.clientX,
          y = e.clientY;
        lp.current = {
          t: window.setTimeout(() => {
            lp.current = null;
            lpFired.current = true;
            window.setTimeout(() => (lpFired.current = false), 800);
            navigator.vibrate?.(10);
            swallowNextClick();
            onMenu(row.id, x, y);
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
    >
      <div className={s.wash} />
      <div className={s.main}>
        <Avatar
          className={s.avatar}
          size={mobile ? 36 : 28}
          radius={isDM ? (mobile ? 18 : 14) : 8}
          name={row.name}
          seed={avatarSeed(row.id, row.dm ? row.peer : "")}
          imageSource={row.avatar || null}
          {...(pres ? avatarDot(pres, "var(--row-surface)") : { showDot: row.call, dotColor: "var(--th-rooms-item-call-dot)" })}
        />
        {row.favourite && <Icon name="starred-symbolic" size={12} color="var(--th-rooms-item-favourite-icon)" className={s.star} />}
        {isInvite && row.dm && row.peer ? (
          // D09.4 (Sunday QoL): a DM invite shows who is really asking — the inviter's full address, server included, in
          // grey under the name (a display name alone can copy anyone's; the desktop's RoomsIsland.qml)
          <span className={s.nameCol}>
            <span className={s.name} style={{ color: "var(--th-rooms-item-not-joined-fg)", fontWeight: 700 }}>
              <PersonName mxid={row.peer} roomId={row.id}>{row.name}</PersonName>
            </span>
            <span className={s.inviterAddr} data-inviter-addr="">
              {row.peer}
            </span>
          </span>
        ) : (
          <>
          {isDM && <PrestigeInRow mxid={row.peer} roomId={row.id} rowGap={4} />}
          <span
            className={s.name}
            style={{
              color: notJoined ? "var(--th-rooms-item-not-joined-fg)" : undefined,
              fontWeight: row.unread > 0 || isInvite ? 700 : undefined,
              opacity: row.muted ? 0.55 : undefined,
            }}
          >
            {row.name}
          </span>
          </>
        )}
        {row.muted && !isInvite && <Icon name="notifications-disabled-symbolic" size={14} color="var(--th-rooms-item-muted-icon)" className={s.flex0} />}
        {(isInvite || notJoined) && <span className={cx(s.pill, isInvite ? s.pillInvite : s.pillNone)}>{isInvite ? "Invited" : "Not joined"}</span>}
        {isInvite && !mobile && (
          <>
            <Button
              className={s.accept}
              text="Accept"
              onClick={(e) => {
                e.stopPropagation();
                void acceptInvite(row.id, row.name);
              }}
            />
            <ToolButton
              className={s.decline}
              iconName="dialog-close-symbolic"
              tip="Decline invite"
              onClick={(e) => {
                e.stopPropagation();
                void rejectInvite(row.id, row.name);
              }}
            />
          </>
        )}
        {!isInvite && row.unread > 0 && <UnreadBadge count={row.unread} highlight={row.highlight} className={s.badge} />}
        {!isInvite && row.unread === 0 && <span className={s.spacer1} />}
      </div>
      {isInvite && mobile && (
        // phones: thumb-sized Accept / Decline on their own line (the desktop's 26 px buttons squeeze the name)
        <div className={s.inviteActions}>
          <Button
            text="Accept"
            onClick={(e) => {
              e.stopPropagation();
              void acceptInvite(row.id, row.name);
            }}
          />
          <Button
            text="Decline"
            onClick={(e) => {
              e.stopPropagation();
              void rejectInvite(row.id, row.name);
            }}
          />
        </div>
      )}
      {!isDM && (showActivity || (openRow && !editorShown)) && (
        <div className={s.sub}>
          {!row.activity?.emoji && <Icon name="applications-games-symbolic" size={14} color={showActivity ? "var(--th-rooms-activity-icon)" : "var(--th-rooms-activity-icon-off)"} className={s.flex0} />}
          <span className={cx(s.subLabel, showActivity ? s.playing : s.setPlaying)}>
            {(row.activity?.emoji ? row.activity.emoji + " " : "") + (showActivity ? `Now playing: ${row.activity!.game}` : "Set now playing…")}
          </span>
          {openRow && (
            <ToolButton
              className={s.pencil}
              iconName="document-edit-symbolic"
              iconSize={10}
              tip="Edit now playing"
              onClick={(e) => {
                e.stopPropagation();
                setEditingRoom(row.id);
              }}
            />
          )}
        </div>
      )}
      {editorShown && <ActivityEditor row={row} />}
      {isDM && presView?.chip && (
        // A4.5: a DM's custom status is its secondary line — "🎯 Looking for group · In a call · <room>" in the
        // status colour (the desktop ThRoomList.qml presLine)
        <div className={s.dmStatus} data-dm-status="" style={{ color: ink(presView.chip.color) }}>
          {presView.label}
          {pres?.state === "call" && presRoom ? ` · ${presRoom}` : ""}
        </div>
      )}
      {shownParts.length > 0 && (
        <div className={s.parts}>
          {shownParts.map((p) => (
            <ParticipantRow key={p.mxid} roomId={row.id} p={p} onMenu={onPartMenu} />
          ))}
        </div>
      )}
      {!isDM && row.statuses.length > 0 && (
        <div className={s.statuses}>
          {row.statuses.map((st) => (
            <div key={st.userId} className={s.status}>
              <PrestigeFor mxid={st.userId} roomId={row.id} />
              {st.name}: {st.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function ActivityEditor({ row }: { row: RoomRow }) {
  const [v, setV] = useState(row.activity?.game ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  const prevGame = row.activity?.game ?? "";
  const prevCode = row.activity?.code ?? "";
  return (
    <div className={s.sub} onClick={(e) => e.stopPropagation()}>
      <BasicTextField
        ref={ref}
        className={s.editor}
        placeholder="What are you playing?"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditingRoom("");
          }
        }}
        onAccepted={(t) => {
          void setActivity(row.id, t.trim(), prevGame, prevCode);
          setEditingRoom("");
        }}
      />
      <ToolButton
        className={s.pencil}
        iconName="edit-clear-symbolic"
        iconSize={16}
        tip="Clear now playing"
        onClick={() => {
          setV("");
          void setActivity(row.id, "", prevGame, prevCode);
          setEditingRoom("");
        }}
      />
    </div>
  );
}


function ParticipantRow({ roomId, p, onMenu }: { roomId: string; p: Participant; onMenu: (userId: string, x: number, y: number) => void }) {
  const g = usePartGlyphs(roomId, p.mxid);
  const lp = useRef(0);
  const lpAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => window.clearTimeout(lp.current), []);
  return (
    <div
      className={s.part}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(p.mxid, e.clientX, e.clientY);
      }}
      onPointerDown={(e: RPointerEvent) => {
        if (e.pointerType !== "touch") return;
        e.stopPropagation(); // the row's own long-press (room menu) must not start as well
        const x = e.clientX,
          y = e.clientY;
        lpAt.current = { x, y };
        lp.current = window.setTimeout(() => {
          swallowNextClick();
          onMenu(p.mxid, x, y);
        }, 500);
      }}
      onPointerMove={(e) => {
        const a = lpAt.current;
        if (a && Math.hypot(e.clientX - a.x, e.clientY - a.y) > 10) {
          window.clearTimeout(lp.current);
          lpAt.current = null;
        }
      }}
      onPointerUp={() => window.clearTimeout(lp.current)}
      onPointerCancel={() => window.clearTimeout(lp.current)}
    >
      <Avatar size={20} name={p.name} seed={p.mxid} imageSource={p.avatar || null} className={s.flex0} />
      {/* textDim like ThRoomList.qml (the desktop colours roles in chat/members/profile, not here) */}
      <PrestigeInRow mxid={p.mxid} roomId={roomId} rowGap={4} />
      <span className={s.partName}>
        {p.name}
      </span>
      {g.mutedByMe && <Icon name="audio-volume-muted-symbolic" size={14} color="var(--th-rooms-caller-muted-icon)" className={s.flex0} />}
      {g.serverMutedBy && (
        <TipSpan tip={`Muted by ${g.serverMutedBy}`} className={s.smute}>
          <Icon name="microphone-sensitivity-muted-symbolic" size={14} color="var(--th-rooms-caller-server-muted-icon)" />
          <Icon name="security-high-symbolic" size={8} color="var(--th-rooms-caller-server-muted-icon)" className={s.shield} />
        </TipSpan>
      )}
      {g.gameChat && (
        <TipSpan
          tip={g.gameChatMe ? "In game chat with you — you hear each other in-game, so their mic is muted here" : "In the game's voice chat"}
          className={s.flex0}
        >
          <Icon name="audio-input-microphone-symbolic" size={14} color="var(--th-rooms-caller-game-chat-icon)" />
        </TipSpan>
      )}
      {g.aside && (
        <TipSpan
          tip={g.aside === "with-you" ? "Aside with you" : "Pulled aside — you don't hear their mic. Right-click to join them"}
          className={s.flex0}
        >
          <Icon name="audio-input-microphone-symbolic" size={14} color="var(--th-rooms-caller-aside-icon)" />
        </TipSpan>
      )}
    </div>
  );
}

/** A span with a tooltip that mounts together with its element (useTip binds once, at mount). */
function TipSpan({ tip, className, children }: { tip: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useTip(ref, tip);
  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}

/** Per-person menu (anchored to the panel natively) = callui's ParticipantVolumeMenu — the
 *  same menu as a call tile's (volumes, local mutes, moderation, profile). INTEGRATION #5: rendered
 *  directly (no bus hop), so exactly one menu opens whatever else listens. */
function ParticipantMenu({ userId, roomId, x, y, onClose }: { userId: string; roomId: string; x: number; y: number; onClose: () => void }) {
  const name = useNavStore((st) => (st.rooms.find((r) => r.id === roomId) ?? st.globalRooms.find((r) => r.id === roomId))?.participants.find((p) => p.mxid === userId)?.name);
  return <ParticipantVolumeMenu mxid={userId} name={name} roomId={roomId} anchor={{ x, y, width: 0, height: 0 }} onClose={onClose} />;
}

// ---- invited space card (SpaceInviteCard.qml) -------------------------------------------------------

function SpaceInviteCard({ entry }: { entry: SpaceEntry }) {
  const [busy, setBusy] = useState(false);
  const inviter = entry.inviter || (entry.inviterMxid ? localpart(entry.inviterMxid) : "");
  const n = entry.memberCount ?? 0;
  const sub = n > 0 || entry.inviterMxid ? [n > 0 ? `${n} member${n === 1 ? "" : "s"}` : "", entry.inviterMxid ?? ""].filter(Boolean).join("  ·  ") : "";
  return (
    <div className={s.inviteCard}>
      <div className={s.inviteCol}>
        <Avatar size={64} radius={16} name={entry.label} seed={avatarSeed(entry.key)} imageSource={entry.avatar || null} className={s.center} />
        <div className={s.inviteText}>
          {inviter ? (
            <>
              <PrestigeFor mxid={entry.inviterMxid} roomId={entry.key} />
              <b>{inviter}</b> invited you to <b>{entry.label}</b>
            </>
          ) : (
            <>
              You're invited to <b>{entry.label}</b>
            </>
          )}
        </div>
        {sub && <MiddleElide className={s.inviteSub} text={sub} />}
        <GlowButton
          className={s.joinBtn}
          text="Join space"
          busy={busy}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await acceptInvite(entry.key, entry.label);
            setBusy(false);
          }}
        />
        <Button className={s.center} flat text="Decline" disabled={busy} onClick={() => void rejectInvite(entry.key, entry.label)} />
        <HintLabel className={s.inviteHint}>You'll see its rooms after you join.</HintLabel>
      </div>
    </div>
  );
}

/** Text.ElideMiddle: keep the head and the tail, "…" in the middle (canvas-measured, re-fits on resize). */
function MiddleElide({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = document.createElement("canvas").getContext("2d");
    const fit = () => {
      if (!ctx) return setShown(text);
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const max = el.clientWidth;
      if (!max || ctx.measureText(text).width <= max) return setShown(text);
      let lo = 0,
        hi = text.length;
      const cut = (n: number) => text.slice(0, Math.ceil(n / 2)) + "…" + text.slice(text.length - Math.floor(n / 2));
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(cut(mid)).width <= max) lo = mid;
        else hi = mid - 1;
      }
      setShown(cut(lo));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div ref={ref} className={className} title={shown !== text ? text : undefined}>
      {shown}
    </div>
  );
}

// ---- the account card (Main.qml's AccountIsland.qml) ------------------------------------------------------------------
// Phones: floating over the list's bottom edge (the rooms scroll under it through the fade). Desktop (`island`): the
// content of the dock host's `account` island — the island draws the card (fill, frame, radius); 8 / 6 px from its
// edges like the card's, 46 px tall with the island's inset.

function AccountCard({ onBug, onMenu, mobile, island, active = true }: { onBug: () => void; onMenu: (el: HTMLElement) => void; mobile?: boolean; island?: boolean | "flat"; active?: boolean }) {
  const session = useSession();
  const me = session.userId ?? "";
  const prof = useUserProfile(me || null);
  const mode = useNavMode();
  const corner = mode === "corner";
  // REACH §2.7: your avatar or name opens "Your status" (phones: the same body as the account sheet);
  // your own dot + status line = the server's view of you (A2.15), so they show only while you share
  const myPres = useMyPresence();
  // docs/SELFHOST.md: no Reach presence service on this server → no "Your status" (the name and picture stay)
  const presenceOn = useServerFeature("presence");
  const meRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  useTip(meRef, statusOpen || !presenceOn ? "" : "Your status");
  // 11.0 buttons: the card's buttons are a row of the actions table (account.main): the stored row or the preset's
  // default (Report a problem, Tuck nav into corner, Menu — phones leave the nav toggle out by its own rule)
  const row = useRow("account", "main", { form: mobile ? "phone" : "desktop" });
  // 11.0 buttons: Your status from a button of your own or the Ctrl+K palette (features/actions)
  useBus("openSurface", (p) => {
    if (active && p.id === "status" && me) setStatusOpen(true);
  });
  return (
    <div ref={cardRef} className={island === "flat" ? s.accountCard : island ? s.accountRow : s.footer} onPointerDown={(e) => e.stopPropagation()}>
      <div
        ref={meRef}
        className={s.meBtn}
        role={presenceOn ? "button" : undefined}
        tabIndex={presenceOn ? 0 : undefined}
        aria-label={presenceOn ? "Your status" : undefined}
        aria-haspopup={presenceOn ? "dialog" : undefined}
        aria-expanded={presenceOn ? statusOpen : undefined}
        data-footer-me=""
        onClick={() => presenceOn && me && setStatusOpen(true)}
        onKeyDown={(e) => {
          if (presenceOn && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            if (me) setStatusOpen(true);
          }
        }}
      >
        <Avatar size={30} name={prof.displayName || me} seed={me} imageSource={prof.avatarUrl ?? null} className={s.flex0} {...avatarDot(presenceOn ? myPres : null, "var(--me-surface)")} />
        <span className={s.meCol}>
          <span className={s.me}>
            <PersonName mxid={me}>{accountName(me, prof.displayName)}</PersonName>
          </span>
          {presenceOn && <MyStatusLine />}
        </span>
      </div>
      <EditableRow row={row} title="Your account card">
        {shownItems(row).map(({ item: it, i }) => {
          const key = `${it.a}:${i}`;
          if (!bespokeOk(row, it)) return <RowButton key={key} row={row} item={it} className={s.footBtn} />;
          switch (it.a) {
            case "app.bugReport":
              return <ToolButton key={key} className={s.footBtn} iconName="tools-report-bug-symbolic" tip="Report a problem (sends your note + current session log)" onClick={onBug} />;
            case "app.sidebar.toggle":
              return (
                <ToolButton
                  key={key}
                  className={s.footBtn}
                  iconName={corner ? "sidebar-expand-left-symbolic" : "sidebar-collapse-left-symbolic"}
                  active={corner}
                  tip={corner ? "Pin nav as sidebar" : "Tuck nav into corner"}
                  onClick={() => {
                    hideTooltip();
                    toggleSidebar();
                  }}
                />
              );
            case "app.menu.open":
              return <ToolButton key={key} className={s.footBtn} iconName="settings-configure-symbolic" tip="Menu — settings, theme, sign out…  (Ctrl+, opens Settings)" onClick={(e) => onMenu(e.currentTarget)} />;
            default:
              return <RowButton key={key} row={row} item={it} className={s.footBtn} />;
          }
        })}
      </EditableRow>
      {/* the desktop statusPop sits on the footer card's left edge, 8 px above it */}
      {statusOpen && presenceOn && <StatusPopover anchor={cardRef.current} onClose={() => setStatusOpen(false)} />}
    </div>
  );
}

/** A01.0 / P4: the phone list's "No rooms yet" (Shell.tsx draws the same plan in the desktop layout's timeline island). */
function NoRoomsCard({ plan }: { plan: NoRoomsPlan }) {
  return (
    <div className={s.empty} data-no-rooms-card="">
      <div className={s.noRooms}>
        <div className={s.noRoomsTitle}>{plan.title}</div>
        <div>{plan.explanation}</div>
        {plan.buttons.length > 0 && (
          <div className={s.noRoomsButtons}>
            {plan.buttons.map((b) => (
              <Button
                key={b}
                text={NO_ROOMS_LABEL[b]}
                highlighted={b === "newDm"}
                onClick={() => openNavDialog(b === "newDm" ? { kind: "newChat" } : newRoomOpen("home", "Home"))}
                data-no-rooms={b}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
