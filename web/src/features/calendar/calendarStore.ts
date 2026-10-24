// calendarStore.ts — the calendar controller (port of calendar.rs CalendarController + the view
// state of CalendarWindow.qml), one app-wide zustand store like the native's single mirror:
//   setRoom(roomId)        on every room change → container (CAL-98), refresh
//   openContainer(id)      space picker / space menu (blanks events at once)
//   refresh()              snapshot from the LOCAL store (js-sdk room state) — sync, cheap
//   saveEvent / deleteEvent / rsvp / lockOption / saveGame / deleteGame / inviteMissing
//   openEvent(container, id) focus an event (switching container first when needed)
// All writes go into the CONTAINER room as unencrypted state (tw-spec §4). Live: listens to the
// container's room-state events (the native polls every 30 s + on reminder ticks; both kept).
import { withCurrentRelation } from "@/core/matrix/moved";
import { create } from "zustand";
import { EventType, RoomStateEvent, ClientEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { ensureWritable, getClient, onClientChanged, peekClient } from "@/core/matrix";
import { sendStateRetry as sendState } from "./retry";
import { toast } from "@/core/bus";
import { getPref, setPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import {
  CARD_KEY,
  EVENT_TYPE,
  GAME_TYPE,
  RSVP_PRUNE_MS,
  RSVP_TYPE,
  announceContent,
  announceText,
  autoColor,
  dayKey,
  effectiveEnd,
  effectiveStart,
  friendly,
  randHex4,
  slugify,
  type CalEvent,
  type CalGame,
  type Person,
  whenTextFor,
} from "./model/calendar";

const log = createLogger("calendar");
type Content = Record<string, unknown>;
const u64 = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export interface Container {
  id: string;
  label: string;
  avatar: string;
  space: boolean;
}

export interface Draft {
  dId: string;
  dTitle: string;
  dGame: string;
  dKind: string;
  dDate: string;
  dTime: number;
  dDuration: number;
  dNotes: string;
  dRules: string;
  dFreePlay: boolean;
  dJoin: boolean;
  dAnnounce: boolean;
  dOptions: Array<{ date: string; time: number; voted?: number }>;
  dChosen: number;
  dEndDate: string;
}

export type Tab = "month" | "upcoming" | "games";

export interface CalState {
  // ---- controller (calendar.rs) ----
  roomId: string;
  containerId: string;
  label: string;
  unjoinedParent: string;
  unjoinedLabel: string;
  missing: Person[];
  canInvite: boolean;
  sourceLabel: string;
  events: CalEvent[];
  games: CalGame[];
  upcoming: CalEvent[];
  containers: Container[];
  canEdit: boolean;
  isMod: boolean;
  myId: string;
  busy: boolean;
  lastError: string;
  remindersOn: boolean;
  gen: number;
  // ---- view (CalendarWindow.qml) ----
  windowOpen: boolean;
  tab: Tab;
  viewYear: number;
  viewMonth: number;
  selectedDay: string;
  selectedId: string;
  editing: boolean;
  gameEditing: boolean;
  draft: Draft;
  draftBase: string;
  pendingFocus: { container: string; id: string } | null;
  /** bumps when the editor should focus its title field */
  focusTitleSeq: number;
  /** my RSVP answers still on their way (click → write → sync), by event id — see `mineOf` */
  myPending: Record<string, PendingMine>;
}

/** An answer I gave that the room state doesn't show yet. Clicks in that window build on it (a vote
 *  followed quickly by "Maybe" kept only the vote the state already had — the second write carried the
 *  stale option list) and the pane / card show it at once. */
export interface PendingMine {
  status: string;
  options: number[];
  at: number;
  seq: number;
  done: boolean;
  /** when the write was acknowledged (0 while queued / in flight) */
  doneAt: number;
  /** the container the answer was written to (only that container's snapshot can confirm it) */
  cid: string;
}

const today = () => new Date();

export function emptyDraft(day?: string): Draft {
  const d = day ?? dayKey(today());
  return {
    dId: "",
    dTitle: "",
    dGame: "",
    dKind: "session",
    dDate: d,
    dTime: 19 * 60,
    dDuration: 180,
    dNotes: "",
    dRules: "",
    dFreePlay: true,
    dJoin: false,
    dAnnounce: true,
    dOptions: [],
    dChosen: -1,
    dEndDate: d,
  };
}

export const draftKey = (d: Draft) =>
  JSON.stringify([d.dId, d.dTitle, d.dGame, d.dKind, d.dDate, d.dTime, d.dDuration, d.dNotes, d.dRules, d.dFreePlay, d.dJoin, d.dOptions, d.dChosen, d.dEndDate]);

export const useCal = create<CalState>()(() => ({
  roomId: "",
  containerId: "",
  label: "",
  unjoinedParent: "",
  unjoinedLabel: "",
  missing: [],
  canInvite: false,
  sourceLabel: "",
  events: [],
  games: [],
  upcoming: [],
  containers: [],
  canEdit: false,
  isMod: false,
  myId: "",
  busy: false,
  lastError: "",
  remindersOn: getPref("calendar-reminders", "1") !== "0",
  gen: 0,
  windowOpen: false,
  tab: "month",
  viewYear: today().getFullYear(),
  viewMonth: today().getMonth(),
  selectedDay: dayKey(today()),
  selectedId: "",
  editing: false,
  gameEditing: false,
  draft: emptyDraft(),
  draftBase: "",
  pendingFocus: null,
  focusTitleSeq: 0,
  myPending: {},
}));

const set = useCal.setState;
const get = useCal.getState;

// ---------------------------------------------------------------------------------------------
// container resolution (calendar.rs container_for_room / unjoined_parent_space)
// ---------------------------------------------------------------------------------------------

const joined = (r: Room | null | undefined) => !!r && r.getMyMembership() === "join";

export function spaceChildIds(space: Room): string[] {
  return space.currentState
    .getStateEvents(EventType.SpaceChild)
    .filter((e) => {
      const via = (e.getContent() as { via?: unknown }).via;
      return Array.isArray(via) && via.length > 0;
    })
    .map((e) => e.getStateKey() ?? "");
}

export function containerForRoom(roomId: string, client: MatrixClient | null = peekClient()): string | null {
  const room = client?.getRoom(roomId);
  if (!client || !room) return null;
  if (room.isSpaceRoom()) return roomId;
  for (const ev of room.currentState.getStateEvents(EventType.SpaceParent)) {
    if ((ev.getContent() as { via?: unknown }).via === undefined) continue;
    const pid = ev.getStateKey() ?? "";
    const pr = client.getRoom(pid);
    if (pr && pr.isSpaceRoom() && joined(pr)) return pid;
  }
  for (const space of client.getRooms()) {
    if (!space.isSpaceRoom() || !joined(space)) continue;
    if (spaceChildIds(space).includes(roomId)) return space.roomId;
  }
  return roomId;
}

function unjoinedParentSpace(roomId: string, client: MatrixClient): string {
  const room = client.getRoom(roomId);
  if (!room || room.isSpaceRoom()) return "";
  for (const ev of room.currentState.getStateEvents(EventType.SpaceParent)) {
    if ((ev.getContent() as { via?: unknown }).via === undefined) continue;
    const pid = ev.getStateKey() ?? "";
    if (!joined(client.getRoom(pid))) return pid;
  }
  return "";
}

export const roomLabel = (r: Room | null | undefined, fallback = "") => (r ? r.name || r.getCanonicalAlias() || r.roomId : fallback);

function personOf(room: Room | null, mxid: string, cache: Map<string, Person>): Person {
  const hit = cache.get(mxid);
  if (hit) return hit;
  const m = room?.getMember(mxid);
  const local = mxid.replace(/^@+/, "").split(":")[0] ?? mxid;
  const p: Person = { mxid, name: m?.rawDisplayName && m.rawDisplayName !== mxid ? m.rawDisplayName : m?.name && m.name !== mxid ? m.name : local, avatar: m?.getMxcAvatarUrl() ?? "" };
  cache.set(mxid, p);
  return p;
}

// ---------------------------------------------------------------------------------------------
// snapshot (calendar.rs build_snapshot) — from the local store
// ---------------------------------------------------------------------------------------------

function myPowerLevel(room: Room, me: string): number {
  return room.getMember(me)?.powerLevel ?? room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent()?.users_default ?? 0;
}

export function buildSnapshot(cid: string, sourceRoom: string, client: MatrixClient) {
  const me = client.getUserId() ?? "";
  const room = client.getRoom(cid);
  const now = Date.now();
  const snap = {
    label: "",
    missing: [] as Person[],
    canInvite: false,
    sourceLabel: "",
    events: [] as CalEvent[],
    games: [] as CalGame[],
    upcoming: [] as CalEvent[],
    containers: [] as Container[],
    canEdit: false,
    isMod: false,
    myId: me,
  };
  if (!room) return snap;
  snap.label = roomLabel(room);
  snap.canEdit = room.currentState.maySendStateEvent(EVENT_TYPE, me);
  snap.canInvite = room.canInvite(me);
  snap.isMod = myPowerLevel(room, me) >= 50;
  const cache = new Map<string, Person>();

  // missing members (opened from a room ≠ container)
  if (sourceRoom && sourceRoom !== cid) {
    const src = client.getRoom(sourceRoom);
    if (src) {
      snap.sourceLabel = roomLabel(src);
      const inContainer = (u: string) => {
        const m = room.getMember(u);
        return m && (m.membership === "join" || m.membership === "invite");
      };
      snap.missing = src
        .getJoinedMembers()
        .filter((m) => m.userId !== me && !inContainer(m.userId))
        .map((m) => ({ mxid: m.userId, name: m.name || m.userId, avatar: m.getMxcAvatarUrl() ?? "" }))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }
  }

  // games
  for (const ev of room.currentState.getStateEvents(GAME_TYPE)) {
    const c = ev.getContent() as Content;
    const name = str(c.name);
    if (!name) continue;
    const slug = ev.getStateKey() ?? "";
    snap.games.push({ slug, name, color: str(c.color) || autoColor(slug), rules: str(c.rules), server: str(c.server), catalogId: str(c.catalogId) || undefined });
  }
  snap.games.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  const colorOf = (game: string) => {
    if (!game) return "";
    const slug = slugify(game);
    const lg = game.toLowerCase();
    const g = snap.games.find((x) => x.slug === slug) ?? snap.games.find((x) => x.name.toLowerCase() === lg);
    return g ? g.color : autoColor(slug);
  };

  // RSVPs: event id → [(user, status, options)]
  const rsvps = new Map<string, Array<{ user: string; status: string; options: number[] }>>();
  for (const ev of room.currentState.getStateEvents(RSVP_TYPE)) {
    const user = ev.getStateKey() ?? "";
    const map = ev.getContent() as Content;
    if (!map || typeof map !== "object") continue;
    for (const [eid, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Content;
      const status = str(e.status);
      const options = Array.isArray(e.options) ? (e.options.filter((x) => Number.isInteger(x)) as number[]) : [];
      if (!status && options.length === 0) continue;
      let l = rsvps.get(eid);
      if (!l) rsvps.set(eid, (l = []));
      l.push({ user, status, options });
    }
  }

  for (const ev of room.currentState.getStateEvents(EVENT_TYPE)) {
    const c = ev.getContent() as Content;
    const title = str(c.title);
    if (!title.trim()) continue;
    const id = ev.getStateKey() ?? "";
    const game = str(c.game);
    const effStart = effectiveStart(c);
    const effEnd = effectiveEnd(c);
    const createdBy = str(c.createdBy) || ev.getSender() || "";
    const opts = Array.isArray(c.options) ? (c.options as Content[]) : [];
    const list = rsvps.get(id) ?? [];
    const rs = { yes: [] as Person[], no: [] as Person[], maybe: [] as Person[] };
    const my = { status: "", options: [] as number[] };
    for (const r of list) {
      if (r.status === "yes" || r.status === "no" || r.status === "maybe") rs[r.status].push(personOf(room, r.user, cache));
      if (r.user === me) {
        my.status = r.status;
        my.options = r.options;
      }
    }
    const options = opts.map((o, i) => ({
      start: u64(o?.start),
      end: u64(o?.end),
      votes: list.filter((r) => r.options.includes(i)).map((r) => personOf(room, r.user, cache)),
    }));
    const announce = c.announce && typeof c.announce === "object" && !Array.isArray(c.announce) ? (c.announce as CalEvent["announce"]) : null;
    snap.events.push({
      id,
      title,
      game,
      gameColor: colorOf(game),
      kind: str(c.kind) || "session",
      start: u64(c.start),
      end: u64(c.end),
      effStart,
      effEnd,
      allDay: c.allDay === true,
      notes: str(c.notes),
      rules: str(c.rules),
      freePlay: c.freePlay === true,
      joinIfYouCan: c.joinIfYouCan === true,
      options,
      chosen: typeof c.chosen === "number" && Number.isInteger(c.chosen) ? c.chosen : -1,
      createdBy,
      creator: personOf(room, createdBy, cache),
      createdAt: u64(c.createdAt),
      updatedAt: u64(c.updatedAt),
      canceled: c.canceled === true,
      hasCard: !!announce,
      announce,
      gameId: str(c.gameId),
      past: effEnd > 0 && effEnd < now,
      canEdit: snap.isMod || createdBy === me,
      rsvp: rs,
      my,
      raw: c,
    });
  }
  snap.events.sort((a, b) => {
    const ka = a.effStart === 0 ? Infinity : a.effStart;
    const kb = b.effStart === 0 ? Infinity : b.effStart;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  snap.upcoming = snap.events
    .filter((e) => !e.canceled && e.kind !== "focus" && e.effStart > 0 && e.effEnd >= now && e.effStart <= now + 14 * 86400000)
    .slice(0, 5);

  for (const r of client.getRooms()) {
    if (!r.isSpaceRoom() || !joined(r)) continue;
    snap.containers.push({ id: r.roomId, label: roomLabel(r), avatar: r.getMxcAvatarUrl() ?? "", space: true });
  }
  if (!snap.containers.some((x) => x.id === cid)) snap.containers.unshift({ id: cid, label: snap.label, avatar: room.getMxcAvatarUrl() ?? "", space: false });
  return snap;
}

// ---------------------------------------------------------------------------------------------
// refresh + live updates
// ---------------------------------------------------------------------------------------------

const WATCHED = new Set([EVENT_TYPE, RSVP_TYPE, GAME_TYPE, EventType.RoomPowerLevels, EventType.RoomMember, EventType.RoomName, EventType.SpaceParent, EventType.SpaceChild]);
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const membersRequested = new Set<string>();

/** true while the calendar shows a container the user picked (space picker / space menu / card). */
let pinned = false;

export function refresh(): void {
  const client = peekClient();
  let { containerId: cid } = get();
  const { roomId } = get();
  if (!client) return;
  // Joining / leaving a space (or a late sync of it) can change the room's container (CAL-98).
  if (roomId && !pinned) {
    const want = containerForRoom(roomId, client);
    if (want && want !== cid) {
      set({ containerId: want, events: [], upcoming: [], selectedId: "", editing: false, gameEditing: false });
      cid = want;
    }
  }
  if (!cid) return;
  const gen = get().gen + 1;
  set({ gen, busy: true });
  // Admin-only, idempotent: unlock the calendar types for PL-0 members (CAL-99).
  void ensureWritable(cid, [EVENT_TYPE, RSVP_TYPE, GAME_TYPE]);
  // Lazy-loaded members: the missing-members banner needs the full JOIN/INVITE lists of both rooms
  // (calendar.rs reads them from the store) — fetch once per room, then rebuild.
  for (const rid of roomId && roomId !== cid ? [cid, roomId] : []) {
    const r = client.getRoom(rid);
    if (r && !membersRequested.has(rid)) {
      membersRequested.add(rid);
      void r
        .loadMembersIfNeeded()
        .then((loaded) => loaded && scheduleRefresh(50))
        .catch(() => membersRequested.delete(rid));
    }
  }
  const snap = buildSnapshot(cid, roomId, client);
  if (get().gen !== gen || get().containerId !== cid) return;
  const unjoined = roomId && cid === roomId ? unjoinedParentSpace(roomId, client) : "";
  set({ ...snap, unjoinedParent: unjoined, unjoinedLabel: unjoined ? roomLabel(client.getRoom(unjoined), "") : "", busy: false });
  pruneMine();
  applyPendingFocus();
  onEventsChanged();
  maybeLinkLegacyCards();
}

/** Coalesced refresh (state events arrive in bursts). */
export function scheduleRefresh(ms = 60): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, ms);
}

let detach: (() => void) | null = null;
function attach(): void {
  detach?.();
  detach = null;
  const client = peekClient();
  if (!client) return;
  const onState = (ev: MatrixEvent) => {
    const rid = ev.getRoomId();
    const { containerId, roomId } = get();
    if ((rid === containerId || rid === roomId) && WATCHED.has(ev.getType())) scheduleRefresh();
  };
  const onRoom = () => scheduleRefresh(300);
  const onMembership = (room: Room) => {
    if (room.isSpaceRoom()) scheduleRefresh(300);
  };
  client.on(RoomStateEvent.Events, onState);
  client.on(ClientEvent.Room, onRoom);
  client.on(RoomEvent.MyMembership, onMembership);
  detach = () => {
    client.off(RoomStateEvent.Events, onState);
    client.off(ClientEvent.Room, onRoom);
    client.off(RoomEvent.MyMembership, onMembership);
  };
}
onClientChanged(() => {
  attach();
  if (!peekClient()) {
    linked.clear();
    set({ roomId: "", containerId: "", events: [], upcoming: [], games: [], containers: [], selectedId: "", editing: false });
  }
});

/** On every room change (the shell's current room). */
export function setRoom(roomId: string): void {
  if (!roomId || roomId === get().roomId) return;
  const client = peekClient();
  if (!client) return;
  if (!detach) attach();
  const cid = containerForRoom(roomId, client);
  if (!cid) return;
  pinned = false;
  if (cid !== get().containerId) set({ roomId, containerId: cid, events: [], upcoming: [], selectedId: "" });
  else set({ roomId });
  refresh();
}

/** Space picker / space context menu: switch the calendar to another container. */
export function openContainer(cid: string): void {
  if (!cid) return;
  if (!detach) attach();
  pinned = cid !== containerForRoom(get().roomId);
  if (cid !== get().containerId) {
    // "Don't flash another space's events while the new snapshot builds."
    set({ containerId: cid, events: [], upcoming: [], selectedId: "", editing: false, gameEditing: false });
  }
  refresh();
}

function onEventsChanged(): void {
  const { selectedId, events } = get();
  if (selectedId && !events.some((e) => e.id === selectedId)) set({ selectedId: "" });
}

// ---------------------------------------------------------------------------------------------
// view actions (CalendarWindow.qml)
// ---------------------------------------------------------------------------------------------

export function focusEvent(id: string): void {
  const ev = get().events.find((e) => e.id === id);
  const patch: Partial<CalState> = { selectedId: id, editing: false, tab: "month" };
  if (ev && ev.effStart) {
    const d = new Date(ev.effStart);
    patch.viewYear = d.getFullYear();
    patch.viewMonth = d.getMonth();
    patch.selectedDay = dayKey(d);
  }
  set(patch);
}

function applyPendingFocus(): void {
  const pf = get().pendingFocus;
  if (!pf || pf.container !== get().containerId) return;
  if (!get().events.some((e) => e.id === pf.id)) return;
  set({ pendingFocus: null });
  focusEvent(pf.id);
}

/** Open the calendar on an event (card click, reminder click, save) — CAL-07/08. */
export function openEvent(container: string, id: string): void {
  if (container && container !== get().containerId) {
    set({ pendingFocus: { container, id } });
    openContainer(container);
  } else {
    set({ pendingFocus: { container: container || get().containerId, id } });
    applyPendingFocus();
  }
}

export function goToday(): void {
  const d = today();
  set({ viewYear: d.getFullYear(), viewMonth: d.getMonth(), selectedDay: dayKey(d) });
}

export function shiftMonth(delta: number): void {
  let m = get().viewMonth + delta;
  let y = get().viewYear;
  while (m < 0) {
    m += 12;
    y--;
  }
  while (m > 11) {
    m -= 12;
    y++;
  }
  set({ viewMonth: m, viewYear: y });
}

export function startNew(key?: string): void {
  const s = get();
  const d = { ...emptyDraft(key && key.length ? key : s.selectedDay), dAnnounce: s.roomId.length > 0 };
  draftContainer = s.containerId;
  editorGen++;
  set({ draft: d, draftBase: draftKey(d), selectedId: "", editing: true, tab: "month", focusTitleSeq: s.focusTitleSeq + 1 });
}

/** The container the open editor belongs to — a save goes THERE even if the user switched rooms or
 *  spaces meanwhile (review finding: a draft started in space A used to be written into space B). */
let draftContainer = "";
export const getDraftContainer = () => draftContainer;
/** Bumps whenever an editor session starts — a late failure must not resurrect an older draft. */
let editorGen = 0;
export const getEditorGen = () => editorGen;

export function startEdit(ev: CalEvent): void {
  const s = get();
  const base = ev.start || ev.effStart || 0;
  let dDate = s.selectedDay;
  let dTime = 19 * 60;
  if (base > 0) {
    const d = new Date(base);
    dDate = dayKey(d);
    dTime = d.getHours() * 60 + Math.floor(d.getMinutes() / 15) * 15;
  }
  const e = ev.end || 0;
  const draft: Draft = {
    dId: ev.id,
    dTitle: ev.title,
    dGame: ev.game || "",
    dKind: ev.kind || "session",
    dDate,
    dTime,
    // TH-CAL-13: a non-preset duration is KEPT
    dDuration: e > base && base > 0 ? Math.round((e - base) / 60000) : 0,
    dNotes: ev.notes || "",
    dRules: ev.rules || "",
    dFreePlay: !!ev.freePlay,
    dJoin: !!ev.joinIfYouCan,
    dAnnounce: false,
    dOptions: (ev.options || []).map((o) => {
      const od = new Date(o.start);
      return { date: dayKey(od), time: od.getHours() * 60 + Math.floor(od.getMinutes() / 15) * 15, voted: o.votes.length };
    }),
    dChosen: ev.chosen ?? -1,
    dEndDate: ev.end && ev.end > 0 ? dayKey(new Date(ev.end)) : dDate,
  };
  draftContainer = s.containerId;
  editorGen++;
  set({ draft, draftBase: draftKey(draft), editing: true });
}

export const setDraft = (patch: Partial<Draft>) => set({ draft: { ...get().draft, ...patch } });
export const isDirty = () => get().editing && draftKey(get().draft) !== get().draftBase;

// ---------------------------------------------------------------------------------------------
// writes (calendar.rs)
// ---------------------------------------------------------------------------------------------

function fail(e: unknown, raw = false): void {
  const msg = raw ? String((e as Error)?.message ?? e) : friendly(e);
  log.warn(`write failed: ${msg}`);
  set({ lastError: msg });
  toast(msg, { kind: "error", timeoutMs: 6000 });
}

const EVENT_TYPES = [EVENT_TYPE, RSVP_TYPE, GAME_TYPE];

function stateContent(cid: string, type: string, key: string): Content | undefined {
  const ev = peekClient()?.getRoom(cid)?.currentState.getStateEvents(type, key);
  return ev ? (ev.getContent() as Content) : undefined;
}

export interface SavePayload {
  id: string;
  title: string;
  game: string;
  kind: string;
  start: number;
  end: number;
  allDay: boolean;
  notes: string;
  rules: string;
  freePlay: boolean;
  joinIfYouCan: boolean;
  options: Array<{ start: number; end: number }>;
  chosen?: number;
  canceled?: boolean;
  announceWhen: string;
  announceRoom?: string;
  announceHint?: string;
}

/** calendar.rs do_save_event — returns the event id. */
async function doSaveEvent(cid: string, v: SavePayload): Promise<string> {
  const title = v.title.trim();
  if (!title) throw new UserError("Give it a title");
  const kind = v.kind || "session";
  const start = u64(v.start);
  const end = u64(v.end);
  const options = (v.options || []).filter((o) => u64(o.start) > 0).map((o) => ({ start: u64(o.start), end: u64(o.end) }));
  if (kind === "proposal") {
    if (options.length === 0 && start === 0) throw new UserError("Add at least one proposed time");
  } else if (kind === "focus") {
    if (start === 0 || end < start) throw new UserError("Pick the first and the last day");
  } else if (start === 0) throw new UserError("Pick a date and time");
  const client = getClient();
  const me = client.getUserId() ?? "";
  const room = client.getRoom(cid);
  if (!room) throw new UserError("Not signed in");
  await ensureWritable(cid, EVENT_TYPES);
  const now = Date.now();
  const givenId = (v.id || "").trim();
  const isNew = !givenId;
  const id = isNew ? `ev-${now}-${randHex4()}` : givenId;
  const existing = isNew ? undefined : stateContent(cid, EVENT_TYPE, id);
  const game = (v.game || "").trim();
  const announceRef = existing && existing.announce && typeof existing.announce === "object" && !Array.isArray(existing.announce) ? (existing.announce as Content) : null;
  const content: Content = {
    title,
    game,
    kind,
    start,
    end,
    allDay: kind === "focus" || v.allDay === true,
    notes: (v.notes || "").trim(),
    rules: (v.rules || "").trim(),
    freePlay: v.freePlay === true,
    joinIfYouCan: v.joinIfYouCan === true,
    options,
    chosen: Number.isInteger(v.chosen) ? (v.chosen as number) : typeof existing?.chosen === "number" ? (existing.chosen as number) : -1,
    createdBy: str(existing?.createdBy) || me,
    createdAt: u64(existing?.createdAt) || now,
    updatedAt: now,
    canceled: typeof v.canceled === "boolean" ? v.canceled : existing?.canceled === true,
  };
  // DECISIONS D6 (native bug fixed on the web): an editor save keeps the reel's `gameId` while the
  // game is unchanged (native REBUILDS the content and drops it — the reel then re-writes it 30 s later).
  if (existing && typeof existing.gameId === "string" && existing.gameId && str(existing.game).trim() === game) content.gameId = existing.gameId;
  if (announceRef) content.announce = announceRef;
  try {
    await sendState(cid, EVENT_TYPE, id, content);
  } catch (e) {
    throw new UserError(friendly(e));
  }
  log.info(`saved ${id} '${title}' kind=${kind} start=${start} new=${isNew}`);

  if (game) {
    const slug = slugify(game);
    const g = stateContent(cid, GAME_TYPE, slug);
    if (!(g && str(g.name))) {
      await sendState(cid, GAME_TYPE, slug, { name: game, color: autoColor(slug), rules: "", server: "", updatedAt: now }).catch(() => undefined);
    }
  }
  if (isNew && kind !== "focus") await doRsvp(cid, id, "yes", []).catch(() => undefined);

  const when = (v.announceWhen || "").trim();
  const want = (v.announceRoom || "").trim();
  const hint = (v.announceHint || "").trim();
  if (want) {
    await postCard(cid, id, want, content, when);
  } else if (!isNew) {
    let aref = announceRef;
    if (!aref) {
      const oldTitle = str(existing?.title) || title;
      aref = (await adoptCards(cid, [[id, oldTitle]], [hint])).get(id) ?? null;
    }
    if (aref) {
      const newRef = (await syncAnnouncement(cid, id, aref, content, when)) ?? aref;
      if (JSON.stringify(announceRef) !== JSON.stringify(newRef)) {
        content.announce = newRef;
        await sendState(cid, EVENT_TYPE, id, content).catch(() => undefined);
      }
    }
  }
  return id;
}

class UserError extends Error {}

/** The content to write when only the card ref changes: if the store already holds a NEWER version
 *  of the event (someone edited it while the card was being sent) keep that and just set the ref. */
function withAnnounce(cid: string, id: string, content: Content): Content {
  const cur = stateContent(cid, EVENT_TYPE, id);
  if (cur && str(cur.title) && u64(cur.updatedAt) > u64(content.updatedAt)) return { ...cur, announce: content.announce };
  return content;
}

async function postCard(cid: string, id: string, announce: string, content: Content, when: string): Promise<void> {
  const client = getClient();
  const me = client.getUserId() ?? "";
  if (!client.getRoom(announce)) return;
  try {
    const r = await client.sendMessage(announce, announceContent(announceText(content, when), cid, id) as never);
    content.announce = { room: announce, event: r.event_id, by: me };
    await sendState(cid, EVENT_TYPE, id, withAnnounce(cid, id, content)).catch((e) => log.warn(`could not record the announcement on ${id}: ${e}`));
  } catch (e) {
    log.warn(`announce failed: ${e}`);
  }
}

/** Edit my card (m.replace) or reply with a fresh one when it is someone else's. Returns a NEW ref. */
async function syncAnnouncement(cid: string, id: string, announce: Content, content: Content, when: string): Promise<Content | null> {
  const client = getClient();
  const me = client.getUserId() ?? "";
  const roomId = str(announce.room);
  const msgId = str(announce.event);
  const by = str(announce.by);
  if (!roomId || !msgId || !client.getRoom(roomId)) return null;
  const text = announceText(content, when);
  const fresh = announceContent(text, cid, id);
  if (by === me) {
    const c: Content = { ...fresh, body: `* ${text}`, "m.new_content": fresh, "m.relates_to": { rel_type: "m.replace", event_id: msgId } };
    await client.sendEvent(roomId, EventType.RoomMessage, c as never).catch((e) => log.warn(`card edit failed: ${e}`));
    return null;
  }
  try {
    const r = await client.sendEvent(roomId, EventType.RoomMessage, { ...fresh, "m.relates_to": { "m.in_reply_to": { event_id: msgId } } } as never);
    return { room: roomId, event: r.event_id, by: me };
  } catch (e) {
    log.warn(`card re-post failed: ${e}`);
    return null;
  }
}

/** My last 150 timeline events of a room (decrypted), newest first. */
async function recentEvents(room: Room, n: number): Promise<MatrixEvent[]> {
  const client = getClient();
  const tl = room.getLiveTimeline();
  for (let i = 0; i < 3 && tl.getEvents().length < n; i++) {
    const more = await client.paginateEventTimeline(tl, { backwards: true, limit: n }).catch(() => false);
    if (!more) break;
  }
  const evs = tl.getEvents().slice(-n);
  await Promise.all(evs.filter((e) => e.isEncrypted() && e.isDecryptionFailure() === false && !e.getClearContent()).map((e) => client.decryptEventIfNeeded(e).catch(() => undefined)));
  return evs.reverse();
}

/** calendar.rs adopt_cards: find MY earlier card for events without a ref (marker or title line). */
export async function adoptCards(cid: string, wanted: Array<[string, string]>, hints: string[]): Promise<Map<string, Content>> {
  const found = new Map<string, Content>();
  const client = peekClient();
  const me = client?.getUserId() ?? "";
  if (!client || !me || wanted.length === 0) return found;
  const rooms: string[] = [];
  for (const h of hints) if (h && !rooms.includes(h)) rooms.push(h);
  for (const r of client.getRooms()) {
    if (rooms.length >= 12) break;
    if (!joined(r) || rooms.includes(r.roomId)) continue;
    if (containerForRoom(r.roomId, client) === cid) rooms.push(r.roomId);
  }
  outer: for (const rid of rooms) {
    const room = client.getRoom(rid);
    if (!room) continue;
    for (const ev of await recentEvents(room, 150)) {
      if (found.size === wanted.length) break outer;
      if (ev.getSender() !== me || ev.getType() !== EventType.RoomMessage) continue;
      const c = withCurrentRelation((ev.getOriginalContent?.() ?? ev.getContent()) as Content, ev.getUnsigned?.());
      const rel = (c["m.relates_to"] ?? {}) as Content;
      const isEdit = rel.rel_type === "m.replace";
      const src = (isEdit ? c["m.new_content"] : c) as Content | undefined;
      if (!src) continue;
      let body = str(src.body);
      if (body.startsWith("* ")) body = body.slice(2);
      for (const [id, title] of wanted) {
        if (!title || found.has(id)) continue;
        const marker = ((src[CARD_KEY] ?? {}) as Content).event === id;
        if (!(marker || body.startsWith(`📅 **${title}**`) || body.startsWith(`📅 ~~${title}~~`))) continue;
        const target = isEdit ? str(rel.event_id) : ev.getId() ?? "";
        if (!target) continue;
        log.info(`adopted my earlier card ${target} in ${rid} for ${id}`);
        found.set(id, { room: rid, event: target, by: me });
        break;
      }
    }
  }
  return found;
}

// My last-written RSVP map per container (calendar.rs rsvp_cache).
const rsvpCache = new Map<string, Content>();
/** Answers this client cleared (container → event id → when): a stale store must not bring them back. */
const rsvpCleared = new Map<string, Map<string, number>>();

async function doRsvp(cid: string, id: string, status: string, options: number[]): Promise<void> {
  const client = getClient();
  const me = client.getUserId() ?? "";
  await ensureWritable(cid, EVENT_TYPES);
  const cur = stateContent(cid, RSVP_TYPE, me);
  const map: Content = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...cur } : {};
  const last = rsvpCache.get(cid);
  if (last) {
    for (const [eid, entry] of Object.entries(last)) {
      const mine = map[eid] as Content | undefined;
      const at = mine && typeof mine === "object" && typeof mine.at === "number" ? mine.at : undefined;
      const newer = at === undefined ? true : u64((entry as Content)?.at) > at;
      if (newer) map[eid] = entry;
    }
  }
  const cleared = rsvpCleared.get(cid) ?? new Map<string, number>();
  for (const [eid, at] of cleared) {
    const entry = map[eid] as Content | undefined;
    if (entry && u64(entry.at) <= at) delete map[eid];
  }
  const now = Date.now();
  const live = new Map<string, Content>();
  for (const ev of client.getRoom(cid)?.currentState.getStateEvents(EVENT_TYPE) ?? []) {
    const c = ev.getContent() as Content;
    if (str(c.title)) live.set(ev.getStateKey() ?? "", c);
  }
  for (const [eid, entry] of Object.entries(map)) {
    const c = live.get(eid);
    const keep = c ? (() => {
      const e = effectiveEnd(c);
      return e === 0 || e + RSVP_PRUNE_MS > now;
    })() : u64((entry as Content)?.at) + RSVP_PRUNE_MS > now && u64((entry as Content)?.at) > 0;
    if (!keep) delete map[eid];
  }
  if (!status && options.length === 0) {
    delete map[id];
    cleared.set(id, now);
    rsvpCleared.set(cid, cleared);
  } else {
    map[id] = { status, options, at: now };
    cleared.delete(id);
  }
  try {
    await sendState(cid, RSVP_TYPE, me, map);
  } catch (e) {
    throw new UserError(friendly(e));
  }
  rsvpCache.set(cid, map);
}

async function doLockOption(cid: string, id: string, index: number): Promise<Content> {
  const cur = stateContent(cid, EVENT_TYPE, id);
  if (!cur) throw new UserError("Event vanished");
  const content: Content = { ...cur };
  const opts = Array.isArray(cur.options) ? (cur.options as Content[]) : [];
  if (index >= 0) {
    const o = opts[index];
    if (!o) throw new UserError("No such option");
    content.start = u64(o.start);
    content.end = u64(o.end);
    content.chosen = index;
  } else {
    content.start = 0;
    content.end = 0;
    content.chosen = -1;
  }
  content.updatedAt = Date.now();
  try {
    await sendState(cid, EVENT_TYPE, id, content);
  } catch (e) {
    throw new UserError(friendly(e));
  }
  return content;
}

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  set({ lastError: "" });
  try {
    const r = await fn();
    refresh();
    return r;
  } catch (e) {
    fail(e instanceof UserError ? e.message : e, e instanceof UserError);
    refresh();
    return undefined;
  }
}

// ---- public write API ---------------------------------------------------------------------------

/** Resolves to the saved event id, or "" when the write failed (lastError says why). */
export async function saveEvent(p: SavePayload, container?: string): Promise<string> {
  const cid = container || get().containerId;
  if (!cid) return "";
  const id = await run(() => doSaveEvent(cid, p));
  if (id) {
    set({ pendingFocus: { container: cid, id } });
    applyPendingFocus();
  }
  return id ?? "";
}

export async function deleteEvent(id: string, when: string): Promise<void> {
  const cid = get().containerId;
  if (!cid || !id) return;
  await run(async () => {
    const cur = stateContent(cid, EVENT_TYPE, id);
    if (cur && str(cur.title)) {
      const canceled = { ...cur, canceled: true };
      let aref = cur.announce && typeof cur.announce === "object" ? (cur.announce as Content) : null;
      if (!aref) aref = (await adoptCards(cid, [[id, str(cur.title)]], [get().roomId])).get(id) ?? null;
      if (aref) await syncAnnouncement(cid, id, aref, canceled, when);
    }
    try {
      await sendState(cid, EVENT_TYPE, id, {});
    } catch (e) {
      throw new UserError(friendly(e));
    }
  });
}

/** One RSVP write at a time per container: two quick answers used to read the same stale map and
 *  the second write dropped the first (review finding; native has the same window). */
const rsvpQueue = new Map<string, Promise<unknown>>();
let pendingSeq = 0;
const PENDING_MS = 20_000;
const sameOptions = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

const matchesState = (p: PendingMine, ev: CalEvent) => p.status === (ev.my.status || "") && sameOptions(p.options, ev.my.options);

/** My answer as the UI should see it: the pending one while its write is queued / in flight, and after
 *  the acknowledgement until the room state shows it (at most 20 s — then the state wins, e.g. another
 *  of my devices answered meanwhile), else the state's. Build every RSVP click on this, never on
 *  `ev.my` alone. Entries are dropped once the state has caught up (`pruneMine`, on every refresh) or
 *  20 s after the acknowledgement (a timer, so the UI re-renders). */
export function mineOf(ev: CalEvent, pending: Record<string, PendingMine> = get().myPending): { status: string; options: number[] } {
  const p = pending[ev.id];
  if (!p) return ev.my;
  if (!p.done) return p;
  if (matchesState(p, ev) || Date.now() - p.doneAt >= PENDING_MS) return ev.my;
  return p;
}

/** Drop acknowledged pending answers the room state now shows (so a later change from another device
 *  can never resurrect them). */
function pruneMine(): void {
  const { myPending, events, containerId } = get();
  const ids = Object.keys(myPending);
  if (!ids.length) return;
  let next: Record<string, PendingMine> | null = null;
  for (const id of ids) {
    const p = myPending[id];
    // another container's answer can't be confirmed from this snapshot — its 20 s timer drops it
    if (!p.done || p.cid !== containerId) continue;
    const ev = events.find((e) => e.id === id);
    if (!ev || matchesState(p, ev) || Date.now() - p.doneAt >= PENDING_MS) {
      next ??= { ...myPending };
      delete next[id];
    }
  }
  if (next) set({ myPending: next });
}
/** `mineOf` as a hook (re-renders when a pending answer comes or goes). */
export function useMine(ev: CalEvent | null): { status: string; options: number[] } {
  const p = useCal((x) => (ev ? x.myPending[ev.id] : undefined));
  if (!ev) return { status: "", options: [] };
  return mineOf(ev, p ? { [ev.id]: p } : {});
}

/** `container` (widgets: Up next answers events of every space) defaults to the calendar's current container. */
export async function rsvp(id: string, status: string, options: number[], container?: string): Promise<void> {
  const cid = container || get().containerId;
  if (!cid || !id) return;
  const seq = ++pendingSeq;
  const entry: PendingMine = { status, options: [...options], at: Date.now(), seq, done: false, doneAt: 0, cid };
  set((x) => ({ myPending: { ...x.myPending, [id]: entry } }));
  const settle = (ok: boolean) =>
    set((x) => {
      const cur = x.myPending[id];
      if (!cur || cur.seq !== seq) return {};
      const next = { ...x.myPending };
      if (ok) next[id] = { ...cur, done: true, doneAt: Date.now() };
      else delete next[id]; // failed: show the state's answer again (the error banner says why)
      return { myPending: next };
    });
  const expire = () =>
    set((x) => {
      const cur = x.myPending[id];
      if (!cur || cur.seq !== seq) return {};
      const next = { ...x.myPending };
      delete next[id];
      return { myPending: next };
    });
  const prev = rsvpQueue.get(cid) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() =>
      run(async () => {
        await doRsvp(cid, id, status, options);
        return true;
      }),
    )
    .then((ok) => {
      settle(ok === true);
      if (ok === true) {
        pruneMine(); // the sync may already have delivered it
        setTimeout(expire, PENDING_MS);
      }
    });
  rsvpQueue.set(cid, next);
  await next;
}

export async function lockOption(id: string, index: number, when: string): Promise<void> {
  const cid = get().containerId;
  if (!cid) return;
  await run(async () => {
    const content = await doLockOption(cid, id, index);
    let aref = content.announce && typeof content.announce === "object" ? (content.announce as Content) : null;
    if (!aref) aref = (await adoptCards(cid, [[id, str(content.title)]], [get().roomId])).get(id) ?? null;
    if (aref) {
      const newRef = await syncAnnouncement(cid, id, aref, content, when);
      if (newRef) await sendState(cid, EVENT_TYPE, id, { ...content, announce: newRef }).catch(() => undefined);
      else if (!content.announce) await sendState(cid, EVENT_TYPE, id, { ...content, announce: aref }).catch(() => undefined);
    }
  });
}

export async function saveGame(g: { slug: string; name: string; color: string; server: string; rules: string }): Promise<void> {
  const cid = get().containerId;
  if (!cid) return;
  await run(async () => {
    const name = g.name.trim();
    if (!name) throw new UserError("Give the game a name");
    await ensureWritable(cid, EVENT_TYPES);
    const slug = g.slug || slugify(name);
    const existing = stateContent(cid, GAME_TYPE, slug);
    const c: Content = { name, color: g.color, rules: g.rules, server: g.server, updatedAt: Date.now() };
    // D6: keep the reel's `catalogId` link (native drops it on every save).
    if (existing && typeof existing.catalogId === "string" && existing.catalogId) c.catalogId = existing.catalogId;
    try {
      await sendState(cid, GAME_TYPE, slug, c);
    } catch (e) {
      throw new UserError(friendly(e));
    }
  });
}

export async function deleteGame(slug: string): Promise<void> {
  const cid = get().containerId;
  if (!cid || !slug) return;
  await run(async () => {
    try {
      await sendState(cid, GAME_TYPE, slug, {});
    } catch (e) {
      throw new UserError(friendly(e));
    }
  });
}

export async function inviteMissing(): Promise<void> {
  const { containerId: cid, missing } = get();
  if (!cid || missing.length === 0) return;
  const client = getClient();
  let ok = 0;
  const failed: string[] = [];
  for (const m of missing) {
    try {
      await client.invite(cid, m.mxid);
      ok++;
    } catch {
      failed.push(m.mxid);
    }
  }
  if (failed.length) fail(`Invited ${ok}; couldn't invite ${failed.join(", ")}`, true);
  refresh();
}

export function applyReminders(on: boolean): void {
  setPref("calendar-reminders", on ? "1" : "0");
  set({ remindersOn: on });
}

export const clearError = () => set({ lastError: "" });

// ---- legacy-card adoption (CAL-61): once per container per session -----------------------------

const linked = new Set<string>();
let linking = false;

function maybeLinkLegacyCards(): void {
  const { containerId: cid, events, windowOpen, roomId } = get();
  if (!cid || !windowOpen || linked.has(cid) || linking) return;
  // Once per container per session, at window load (CalendarWindow.qml:437-453) — an event created
  // later in this session is between its first write and its `announce` write, never "legacy".
  linked.add(cid);
  const list = events.filter((e) => !e.hasCard && e.canEdit);
  if (list.length === 0) return;
  linking = true;
  void (async () => {
    try {
      const wanted: Array<[string, string]> = list.map((e) => [e.id, e.title]);
      const found = await adoptCards(cid, wanted, [roomId]);
      for (const ev of list) {
        const aref = found.get(ev.id);
        if (!aref) continue;
        const cur = stateContent(cid, EVENT_TYPE, ev.id);
        if (!cur || !str(cur.title) || cur.announce) continue;
        const when = whenTextFor(ev, ev.kind === "proposal" ? ev.chosen : undefined);
        const newRef = (await syncAnnouncement(cid, ev.id, aref, cur, when)) ?? aref;
        await sendState(cid, EVENT_TYPE, ev.id, { ...cur, announce: newRef }).catch(() => undefined);
      }
    } finally {
      linking = false;
    }
  })();
}

export function setWindowOpen(open: boolean): void {
  set({ windowOpen: open });
  if (open) {
    refresh();
    maybeLinkLegacyCards();
  }
}

// ---- hooks for other surfaces ------------------------------------------------------------------

/** Next events of the current container (header chip, "Today" cards). */
export const useCalendarUpcoming = () => useCal((s) => s.upcoming);
/** One event of the mirrored calendar (null when the store mirrors another container). */
export function useCalendarEvent(container: string, id: string): CalEvent | null {
  return useCal((s) => (s.containerId === container ? s.events.find((e) => e.id === id) ?? null : null));
}
