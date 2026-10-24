// QuickSwitcher.tsx — the Ctrl+K palette (QuickSwitcher.qml; ACTIONS.md §10): one field over rooms, pending invites,
// people and every action, ranked by the shared engine (src/actions/palette.ts — the desktop runs the same code in
// Rust, proven by the palette vectors). 432 × 378 centred over the grey modal veil, as the room switcher it grew from.
// An empty query lists the pending invites (newest first), then the rooms as Ctrl+K always did (the room you are in
// last); `>` actions only, `@` people, `#` rooms and invites (2026-09-28: invites are back, as in 10.8's desktop
// switcher; §10.1). An invite row = the room list's avatar and name + its "Invited" pill, never a badge. Enter runs the
// selection: a room opens, an invite shows where it waits with Accept / Decline (showInvite — never accepted or
// declined here), a person gets a DM, an action runs (src/actions/run.ts) — or, when it needs a target (a theme, a
// status, a sound …), the palette switches to stage 2 and lists the choices (Backspace on an empty field goes back).
// ↑/↓, Enter, Esc, pointer MOVE selects (not mere enter), click runs. Phones: a full-screen search with big rows.
// 11.0 step 5 (THEMES-UI.md §14.5): pickRoom() — the same switcher as a room PICKER ("Share ‹name› to…"): its own
// title and placeholder, rooms only (the palette's `#` mode, never an invite: you can't share into a room you have not
// joined), the room open now listed first, and a pick handed to `onPick` instead of opening the room
// (QuickSwitcher.qml's pickRoom).
import { focusComposer } from "@/features/chat";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useBus } from "@/core/bus";
import { useBackToClose } from "@/ui/backStack";
import { peekClient, useSession } from "@/core/matrix";
import { PALETTE_PEOPLE } from "@/actions/decisions";
import { winningKeys } from "@/actions/shortcutsStore";
import { Avatar, Icon, OverlayPortal, SearchField, UnreadBadge, avatarSeed, useIsMobile, usePopupStack } from "@/ui";
import { palette, type PaletteItem } from "@/actions/palette";
import { actionById, TABLE } from "@/actions/table";
import { runAction, setPickHost } from "@/actions/run";
import { useActionsSnapshot, withPart, type SnapshotPart } from "@/actions/snapshot";
import { navigate } from "@/app/router";
import { navInDrawerNow, openDrawer, useDrawerStore } from "./ThNav";
import { selectSpace, useNavStore, type RoomRow } from "./model";
import { getCurrentRoom, openRoomId } from "./open";
import { paletteRoomLists } from "./palettelists";
import s from "./QuickSwitcher.module.css";

/** Pick mode (THEMES-UI.md §14.5 "Share to a room…"): the same switcher with its own title and placeholder, the room
 *  open now listed first, and a pick handed to `onPick` instead of opening the room. */
export interface RoomPick {
  title: string;
  placeholder: string;
  onPick: (roomId: string) => void;
}
const useQs = create<{ open: boolean; stage: string | null; n: number; pick: RoomPick | null }>()(() => ({ open: false, stage: null, n: 0, pick: null }));
/** Open the palette (at stage 2 of an action that picks its target, when `stage` is given). */
export const openQuickSwitcher = (stage?: string) => useQs.setState((st) => ({ open: true, stage: stage ?? null, n: st.n + 1, pick: null }));
export const closeQuickSwitcher = () => useQs.setState({ open: false, stage: null, pick: null });
/** Open it as a room picker. */
export const pickRoom = (pick: RoomPick) => useQs.setState((st) => ({ open: true, stage: null, n: st.n + 1, pick }));
export const quickSwitcherOpen = () => useQs.getState().open;

/** The palette's view of the room list (nav order), the pending invites (newest first) and the people it can find
 *  (ACTIONS.md §4.3, §10.1; palettelists.ts — the desktop's QuickSwitcher.qml _buildSnapshot builds the same). */
function paletteLists(rooms: RoomRow[]): SnapshotPart {
  const part = paletteRoomLists(rooms);
  const { room, person } = part.subjects;
  const people = part.lists.person;
  // product decision (3), decisions.ts PALETTE_PEOPLE: your (joined) DM partners; "roomMembers" adds the room on
  // screen's members
  if (PALETTE_PEOPLE === "roomMembers") {
    const me = peekClient()?.getUserId() ?? "";
    const cur = getCurrentRoom();
    for (const m of (cur ? peekClient()?.getRoom(cur)?.getJoinedMembers() : undefined) ?? []) {
      if (m.userId === me || person[m.userId]) continue;
      person[m.userId] = { name: m.name || m.userId, values: {} };
      people.push(m.userId);
    }
  }
  return {
    subjects: { room, person },
    lists: { room: part.lists.room, invite: part.lists.invite, person: people },
    current: { room: getCurrentRoom() },
  };
}

/** Ctrl+K on a pending invite (ACTIONS.md §14.3; Main.qml showInvite takes the same steps): the invite shows where it
 *  waits with Accept / Decline — its room list row; nothing is accepted or declined here. The rail goes to People (a DM
 *  invite) or Home (a room invite), as a clicked invite notification does, unless the list on screen already holds
 *  the row (followRoom's rule); a tucked nav's drawer opens (it stays open until the pointer has been over it and left,
 *  as the desktop's); phones show the list page; the row scrolls into view once the list holds it (given up after 3 s,
 *  RoomsIsland.qml revealRoom). */
function showInvite(roomId: string, mobile: boolean): void {
  const st = useNavStore.getState();
  if (!st.rooms.some((r) => r.id === roomId)) {
    const key = st.globalRooms.find((r) => r.id === roomId)?.dm ? "people" : "home";
    if (st.activeKey !== key) selectSpace(key);
  }
  if (mobile) {
    if (location.hash.startsWith("#/room/")) navigate({ name: "home" });
  } else if (navInDrawerNow() && !useDrawerStore.getState().opened) openDrawer();
  const until = Date.now() + 3000;
  const reveal = () => {
    const row = document.querySelector<HTMLElement>(`[data-row][data-room-id="${CSS.escape(roomId)}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
    else if (Date.now() < until) window.setTimeout(reveal, 50);
  };
  window.requestAnimationFrame(reveal);
}

export function QuickSwitcherHost() {
  const { open, stage, n, pick } = useQs();
  const session = useSession();
  useBus("openQuickSwitcher", () => {
    if (session.state === "ready") openQuickSwitcher();
  });
  useBus("loggedOut", () => closeQuickSwitcher());
  // an action run from a button without its target picks it here (src/actions/run.ts)
  useEffect(() => {
    setPickHost((id) => openQuickSwitcher(id));
    return () => setPickHost(null);
  }, []);
  const mobile = useIsMobile();
  if (!open) return null;
  // Desktop: when the switcher closes (Esc, a click outside, or a room picked) the typing focus goes back
  // to the composer of the room on screen — the room just opened mounts its view a moment later, so try
  // again until a composer holds the focus (fix/polish item 6). Phones: no (it would pop the keyboard).
  const close = (refocusComposer = true) => {
    closeQuickSwitcher();
    if (mobile || !refocusComposer) return;
    let tries = 0;
    // the user moving on (a click, a key, the switcher again) cancels the pending refocus
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
    };
    window.setTimeout(() => {
      if (cancelled) return;
      window.addEventListener("pointerdown", cancel, true);
      window.addEventListener("keydown", cancel, true);
    }, 0);
    window.setTimeout(cancel, 600);
    const refocus = () => {
      if (cancelled || useQs.getState().open) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && a.tagName === "TEXTAREA" && a.closest("[data-room-page]")) return;
      if (a && a !== document.body && a.closest('[role="dialog"], [role="menu"]')) return; // something else took over
      focusComposer();
      if (++tries < 6) window.setTimeout(refocus, 80);
    };
    window.setTimeout(refocus, 0);
  };
  return <QuickSwitcher key={n} initialStage={stage} pick={pick} onClose={close} />;
}

function QuickSwitcher({ initialStage, pick, onClose }: { initialStage: string | null; pick: RoomPick | null; onClose: (refocusComposer?: boolean) => void }) {
  const mobile = useIsMobile();
  const global = useNavStore((st) => st.globalRooms);
  const live = useActionsSnapshot();
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<string | null>(initialStage);
  const [cur, setCur] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowsById = useMemo(() => new Map(global.map((r) => [r.id, r])), [global]);
  const snap = useMemo(() => withPart(live, paletteLists(global)), [live, global]);
  // pick mode asks for rooms only (the `#` prefix); on an empty query the room open now comes first
  const out = useMemo(() => palette("web", snap, pick ? `#${query}` : query, stage ?? undefined), [snap, query, stage, pick]);
  const results = useMemo(() => {
    // pick mode: joined rooms only (`#` also lists invites — you can't share into a room you have not joined)
    const items = pick ? out.items.filter((it) => it.kind === "room") : out.items;
    if (!pick || query.trim()) return items;
    const cur = getCurrentRoom();
    return [...items.filter((it) => it.id === cur), ...items.filter((it) => it.id !== cur)];
  }, [out, pick, query]);
  usePopupStack(true, ref, { onEscape: () => onClose(), onOutside: () => onClose() });
  useBackToClose(mobile, () => onClose()); // phones: the full-screen search closes on the back button
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [stage]);
  useEffect(() => setCur(0), [query, stage]);
  // a sync can shrink the list under the selection: keep it on a real row
  const curIdx = results.length ? Math.max(0, Math.min(cur, results.length - 1)) : 0;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${curIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [curIdx]);
  const stageAction = stage ? actionById(stage) : undefined;
  const T = TABLE.palette.texts;
  const choose = (it: PaletteItem | undefined) => {
    if (!it || !it.enabled) return;
    if (it.kind === "room") {
      onClose();
      if (pick) pick.onPick(it.id);
      else openRoomId(it.id);
      return;
    }
    if (it.kind === "invite") {
      // where it waits with Accept / Decline (showInvite, ACTIONS.md §14.3) — never accepted here
      onClose();
      showInvite(it.id, mobile);
      return;
    }
    if (it.kind === "person") {
      onClose(false);
      void runAction("person.message", { source: "palette", target: { person: it.id } });
      return;
    }
    if (it.kind === "action" && it.pick) {
      // stage 2: pick the target here
      setStage(it.id);
      setQuery("");
      return;
    }
    onClose(false);
    if (it.a) void runAction(it.a, { source: "palette", target: it.kind === "choice" ? it.target : null });
  };
  const placeholder = pick ? pick.placeholder : stageAction ? T.pickPlaceholder.replace("{label}", stageAction.label) : T.placeholder;
  const empty = query.trim() ? T.empty.replace("{query}", query.trim()) : stage ? T.empty.replace("{query}", "") : T.emptyRooms;
  return (
    <OverlayPortal>
      {!mobile && <div className={s.dim} />}
      <div ref={ref} className={s.box} data-mobile={mobile ? "" : undefined} role="dialog" aria-label={pick ? pick.title : "Jump to a room, a person or an action"}>
        {pick && <div className={s.pickTitle}>{pick.title}</div>}
        <div className={s.top}>
          {mobile && (
            <button type="button" className={s.back} aria-label="Close" onClick={() => onClose()}>
              <Icon name="go-previous-symbolic" size={22} />
            </button>
          )}
          {stageAction && (
            <button type="button" className={s.stage} onClick={() => (setStage(null), setQuery(""))} title="Back to everything">
              {stageAction.label}
              <Icon name="go-next-symbolic" size={12} color="var(--th-action-palette-stage-fg)" />
            </button>
          )}
          <SearchField
            ref={inputRef}
            className={s.field}
            placeholder={placeholder}
            aria-label={placeholder}
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCur(Math.max(0, Math.min(results.length - 1, curIdx + 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCur(Math.max(0, curIdx - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[curIdx]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              } else if (e.key === "Backspace" && stage && query === "" && !initialStage) {
                e.preventDefault();
                setStage(null);
              }
            }}
          />
        </div>
        <div ref={listRef} className={s.list} role="listbox">
          {results.map((it, i) => (
            <div
              key={`${it.kind}:${it.id}`}
              data-i={i}
              data-kind={it.kind}
              role="option"
              aria-selected={i === curIdx}
              aria-disabled={!it.enabled || undefined}
              className={s.row}
              data-current={i === curIdx ? "" : undefined}
              data-off={it.enabled ? undefined : ""}
              onPointerMove={() => i !== curIdx && setCur(i)}
              onClick={() => choose(it)}
            >
              <div className={s.inner}>
                <Lead it={it} room={rowsById.get(it.id)} size={mobile ? 36 : 28} />
                <span className={s.name}>{it.label}</span>
                {/* an invite: the room list's "Invited" pill (the word is the table's palette.texts.inviteMarker,
                    ACTIONS.md §10.1) — and no unread badge */}
                {it.kind === "invite" && <span className={s.invitePill}>{T.inviteMarker}</span>}
                {it.kind === "room" && <UnreadBadge count={rowsById.get(it.id)?.unread ?? 0} highlight={rowsById.get(it.id)?.highlight ?? false} />}
                {!mobile && (() => {
                  // the first key in effect on this device (Settings → Shortcuts may have changed it, ACTIONS.md §8.8)
                  const hint = it.kind === "action" && it.a ? (winningKeys(it.a)[0] ?? null) : it.hint;
                  return hint ? <span className={s.hint}>{hint}</span> : null;
                })()}
                {it.kind === "choice" && it.active === true && <Icon name="checkmark-symbolic" size={16} color="var(--th-action-palette-hint-fg)" />}
                {it.pick && <Icon name="go-next-symbolic" size={16} color="var(--th-action-palette-hint-fg)" />}
              </div>
            </div>
          ))}
          {results.length === 0 && <div className={s.empty}>{empty}</div>}
        </div>
      </div>
    </OverlayPortal>
  );
}

/** The leading glyph of a palette row: a room's / an invite's (the room list's picture) / a person's avatar, an
 *  action's or a choice's icon. */
function Lead({ it, room, size }: { it: PaletteItem; room: RoomRow | undefined; size: number }) {
  // selfhost/firstrun item 6: the room list's colour (a room's id; a DM's person) and a person's own
  if (it.kind === "room" || it.kind === "invite") return <Avatar size={size} name={it.label} seed={avatarSeed(it.id, room?.dm ? room.peer : "")} imageSource={room?.avatar || null} />;
  if (it.kind === "person") return <Avatar size={size} name={it.label} seed={avatarSeed(it.id)} imageSource={null} />;
  return (
    <span className={s.icon} style={{ width: size, height: size }}>
      {it.emoji ? (
        <span className={s.emoji}>{it.emoji}</span>
      ) : (
        it.icon && <Icon name={it.icon} size={22} color={it.enabled ? "var(--th-action-palette-icon)" : "var(--th-action-palette-item-fg-disabled)"} />
      )}
    </span>
  );
}
