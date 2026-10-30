// model.ts — the nav data model: a port of the native src/nav.rs (build_nav, sort_rooms, the meta
// spaces, rollups, space order, joinable children via /hierarchy) + notify.rs (room notification
// modes) + rtc.rs (call participants) + activity.rs / status_ctl.rs (row sub-lines).
//
// One zustand store (`useNav`) recomputed in ONE pass (spaces + rooms of the active key + global
// list + badge + room→space map) so the UI never shows a half-updated state. Recompute triggers
// are coalesced to one per animation frame; every sync, state/tag/account-data/receipt change and
// a 3 s participant tick while a call is visible re-run it.
import { create } from "zustand";
import {
  ClientEvent,
  EventType,
  NotificationCountType,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { inviterServerHere, onClientChanged, peekClient, pickVia, serverPart } from "@/core/matrix";
import { getPref, onPrefChange, setPref } from "@/core/prefs";
import { EMPTY_DM_STRIP, dmStrip, type DmStrip, type DmStripRoom } from "./dmstrip";
import { adjustedUnread } from "./rollup";
import { rosterCounts } from "@/features/calls/callrules";
import { callerMembership, onMemberProbe } from "@/features/calls/memberprobe";

// ---- types -----------------------------------------------------------------------------------

export type MetaKey = "home" | "favourites" | "people" | "orphans";
export const META_SPACES: ReadonlyArray<{ key: MetaKey; label: string; icon: string }> = [
  { key: "home", label: "Home", icon: "go-home-symbolic" },
  { key: "favourites", label: "Favourites", icon: "starred-symbolic" },
  { key: "people", label: "People", icon: "system-users-symbolic" },
  { key: "orphans", label: "Rooms", icon: "view-list-details-symbolic" },
];

export interface SpaceEntry {
  key: string;
  label: string;
  kind: "meta" | "space";
  /** mxc of the space avatar ("" = letter avatar) */
  avatar: string;
  unread: number;
  highlight: boolean;
  membership?: "join" | "invite";
  inviter?: string;
  inviterMxid?: string;
  memberCount?: number;
}

export type NotifyMode = "all" | "mentions" | "mute";

export interface Participant {
  mxid: string;
  name: string;
  avatar: string;
}

export interface Activity {
  game: string;
  emoji: string;
  setBy: string;
  code: string;
}

export interface StatusLine {
  userId: string;
  name: string;
  text: string;
}

export interface RoomRow {
  id: string;
  name: string;
  avatar: string;
  unread: number;
  highlight: boolean;
  /** raw server notification_count (rollups, mark-all-read) */
  rawUnread: number;
  dm: boolean;
  favourite: boolean;
  call: boolean;
  membership: "join" | "invite" | "none";
  notifyMode: NotifyMode;
  muted: boolean;
  participants: Participant[];
  activity: Activity | null;
  statuses: StatusLine[];
  alias: string;
  publicJoin: boolean;
  isSpace: boolean;
  recency: number | null;
  /** REACH §1.4: a DM's other person (mxid, "" = unknown / not a DM) — the presence dot reads it */
  peer: string;
  inviter?: string;
  /** a pending invite's time (ms since the epoch; our own m.room.member event), 0 = unknown — Ctrl+K lists invites
   *  newest first (ACTIONS.md §4.3 lists.invite; the desktop's roomsJson `invitedAt`) */
  invitedAt?: number;
  joinRule?: string;
  memberCount?: number;
  topic?: string;
}

export interface NavSnapshot {
  spaces: SpaceEntry[];
  /** rows of the active key (sorted) */
  rooms: RoomRow[];
  /** every joined/invited non-space room, LoginController order (Ctrl+K, Alt+↑/↓ fallback) */
  globalRooms: RoomRow[];
  activeLabel: string;
  globalBadge: string;
  roomSpace: Map<string, string>;
  /** invited-space keys (for the new-invite toast) */
  invitedSpaceKeys: string[];
  /** REACH §1: the rail's DM strip (unread DMs + DM invites, newest first, ≤ 5 + overflow) */
  dmStrip: DmStrip;
  /** A5.10: rooms whose adjusted unread is > 0 + pending DM invites (spaces never) — the app badge */
  unreadRooms: number;
  /** true once the client has produced a snapshot with rooms */
  loaded: boolean;
}

// ---- constants (native) ----------------------------------------------------------------------

export const CALL_MEMBER_TYPES = ["org.matrix.msc3401.call.member", "m.call.member", "m.rtc.member"] as const;
const MEMBER_EXPIRES_MS = 14_400_000;
export const ACTIVITY_TYPE = "dev.tinhat.activity";
export const STATUS_TYPE = "dev.tinhat.userstatus";

// ---- helpers ---------------------------------------------------------------------------------

type Content = Record<string, unknown>;

function isSpace(r: Room): boolean {
  try {
    return r.isSpaceRoom();
  } catch {
    return false;
  }
}

/** m.direct turned around: DM room id → the person it is filed under (the first one, like matrix-sdk). */
function directPeers(c: MatrixClient): Map<string, string> {
  const content = c.getAccountData(EventType.Direct)?.getContent() as Record<string, unknown> | undefined;
  const out = new Map<string, string>();
  if (content)
    for (const [user, ids] of Object.entries(content))
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && !out.has(id)) out.set(id, user);
  return out;
}

/** Active children (m.space.child with a non-empty via array) of a space. */
export function spaceChildIds(space: Room): string[] {
  const out: string[] = [];
  for (const ev of space.currentState.getStateEvents(EventType.SpaceChild)) {
    const via = (ev.getContent() as { via?: unknown }).via;
    const id = ev.getStateKey();
    if (id && Array.isArray(via) && via.length > 0) out.push(id);
  }
  return out;
}

interface PushRule {
  rule_id: string;
  enabled?: boolean;
  actions?: unknown[];
  conditions?: Array<{ kind?: string; key?: string; pattern?: string }>;
}
interface PushRules {
  global?: { override?: PushRule[]; room?: PushRule[]; underride?: PushRule[] };
}

function pushRules(c: MatrixClient): PushRules {
  return ((c.getAccountData(EventType.PushRules)?.getContent() as PushRules | undefined) ?? c.pushRules ?? {}) as PushRules;
}

const notifies = (actions: unknown[] | undefined) => Array.isArray(actions) && actions.some((a) => a === "notify");

/** User-defined mode for a room, or null (notify.rs user_defined_room_notification_mode). */
export function userDefinedMode(rules: PushRules, roomId: string): NotifyMode | null {
  const g = rules.global ?? {};
  for (const r of g.override ?? []) {
    if (r.enabled === false) continue;
    const hit = r.rule_id === roomId || (r.conditions ?? []).some((cd) => cd.kind === "event_match" && cd.key === "room_id" && cd.pattern === roomId);
    if (hit && !notifies(r.actions)) return "mute";
  }
  for (const r of g.room ?? []) {
    if (r.rule_id !== roomId || r.enabled === false) continue;
    return notifies(r.actions) ? "all" : "mentions";
  }
  return null;
}

/** Effective mode: user-defined, else All for DMs and Mentions-only for other rooms (notify.rs:467). */
export function effectiveMode(rules: PushRules, roomId: string, dm: boolean): NotifyMode {
  return userDefinedMode(rules, roomId) ?? (dm ? "all" : "mentions");
}

/** rtc.rs call_member_users_from — live MatrixRTC members, deduped, first-seen order. */
// GPU.md §2.8 (D3): call memberships and statuses expire by time, not by an event. The build notes the earliest
// future expiry it saw; ONE timeout rebuilds then (it was a 3 s interval for as long as any row showed a call or a
// status — a crashed client's membership kept it ticking for up to 4 h).
let nextExpiry = Infinity;
function noteExpiry(at: number): void {
  if (at < nextExpiry) nextExpiry = at;
}

export function callMemberUsers(room: Room, now = Date.now()): string[] {
  const users: string[] = [];
  for (const t of CALL_MEMBER_TYPES) {
    let evs: MatrixEvent[] = [];
    try {
      evs = room.currentState.getStateEvents(t) ?? [];
    } catch {
      evs = [];
    }
    for (const ev of evs) {
      const sender = ev.getSender();
      if (!sender) continue;
      const content = ev.getContent() as Content;
      const originTs = ev.getTs() || undefined;
      const liveAt = (o: Content) => {
        const exp = typeof o.expires === "number" ? o.expires : MEMBER_EXPIRES_MS;
        const created = typeof o.created_ts === "number" ? o.created_ts : originTs;
        if (created === undefined) return true;
        const live = now <= created + exp;
        if (live) noteExpiry(created + exp);
        return live;
      };
      let live: boolean;
      if (Array.isArray(content.memberships)) live = (content.memberships as unknown[]).some((m) => !!m && typeof m === "object" && liveAt(m as Content));
      else if (!content || Object.keys(content).length === 0) live = false;
      else live = liveAt(content);
      // kicked / left: they can't withdraw their membership any more (callrules.rosterCounts); no member event here
      // (lazy loading): probed once (memberprobe.ts), counts until the answer, which rebuilds the nav
      if (live && !users.includes(sender) && rosterCounts(callerMembership(room.roomId, sender))) users.push(sender);
    }
  }
  return users;
}

const memberLoads = new Set<string>();
/** Lazy-loaded rooms may not hold the member event of a call participant / status author yet:
 *  load the members once (like the SDK the desktop uses does) and rebuild. */
function wantMembers(room: Room): void {
  if (memberLoads.has(room.roomId)) return;
  memberLoads.add(room.roomId);
  room
    .loadMembersIfNeeded()
    .then(() => scheduleRefresh())
    .catch(() => {});
}

function memberName(room: Room, uid: string): string {
  const m = room.getMember(uid);
  if (!m) wantMembers(room);
  return m?.name || room.client.getUser(uid)?.displayName || uid;
}
function memberAvatar(room: Room, uid: string): string {
  return room.getMember(uid)?.getMxcAvatarUrl() ?? "";
}

export function activityOf(room: Room): Activity | null {
  const c = room.currentState.getStateEvents(ACTIVITY_TYPE, "")?.getContent() as Content | undefined;
  const game = typeof c?.game === "string" ? c.game.trim() : "";
  if (!c || !game) return null;
  return {
    game,
    emoji: typeof c.emoji === "string" ? c.emoji : "",
    setBy: typeof c.setBy === "string" ? c.setBy : "",
    code: typeof c.code === "string" ? c.code : "",
  };
}

export function statusesOf(room: Room, now = Date.now()): StatusLine[] {
  const out: StatusLine[] = [];
  for (const ev of room.currentState.getStateEvents(STATUS_TYPE) ?? []) {
    const c = ev.getContent() as Content;
    const text = typeof c.text === "string" ? c.text.trim() : "";
    if (!text) continue;
    if (typeof c.expiresAt === "number" && c.expiresAt <= now) continue;
    if (typeof c.expiresAt === "number") noteExpiry(c.expiresAt);
    const uid = ev.getStateKey() ?? "";
    if (!uid) continue;
    out.push({ userId: uid, name: memberName(room, uid), text });
  }
  return out;
}

function inviterOf(room: Room, me: string): { name: string; mxid: string } {
  const ev = room.currentState.getMember(me)?.events.member ?? room.currentState.getStateEvents(EventType.RoomMember, me);
  const mxid = ev?.getSender() ?? "";
  if (!mxid) return { name: "", mxid: "" };
  const m = room.currentState.getMember(mxid);
  const local = mxid.replace(/^@/, "").split(":")[0] ?? mxid;
  return { name: m?.name && m.name !== mxid ? m.name : local, mxid };
}

function joinRuleOf(room: Room): string {
  return (room.currentState.getStateEvents(EventType.RoomJoinRules, "")?.getContent()?.join_rule as string | undefined) ?? "invite";
}

// ---- joinable children (/hierarchy, cached 60 s) ---------------------------------------------

interface HierRoom {
  room_id: string;
  name?: string;
  topic?: string;
  avatar_url?: string;
  join_rule?: string;
  room_type?: string;
  num_joined_members?: number;
}
const hierCache = new Map<string, { at: number; rooms: HierRoom[]; inflight?: boolean }>();
/** bumped on every sign-in/out: a request started for the previous client must not refill the caches */
let clientGen = 0;

function joinableChildren(c: MatrixClient, spaceId: string): HierRoom[] {
  const hit = hierCache.get(spaceId);
  const fresh = hit && Date.now() - hit.at < 60_000;
  if (!fresh && !hit?.inflight) {
    hierCache.set(spaceId, { at: hit?.at ?? 0, rooms: hit?.rooms ?? [], inflight: true });
    const gen = clientGen;
    c.getRoomHierarchy(spaceId, 100, 1)
      .then((res) => {
        if (gen !== clientGen) return;
        const rooms = (res.rooms as unknown as HierRoom[]).filter(
          (r) => r.room_id !== spaceId && !r.room_type && (r.join_rule === "public" || r.join_rule === "restricted"),
        );
        hierCache.set(spaceId, { at: Date.now(), rooms });
        scheduleRefresh();
      })
      .catch(() => {
        if (gen === clientGen) hierCache.set(spaceId, { at: Date.now(), rooms: [] });
      });
  }
  return hit?.rooms ?? [];
}

// ---- invited-space member count (room summary, cached 10 min) --------------------------------

const countCache = new Map<string, { at: number; n: number; inflight?: boolean }>();
function invitedMemberCount(c: MatrixClient, room: Room): number {
  const id = room.roomId;
  const hit = countCache.get(id);
  if ((!hit || Date.now() - hit.at > 600_000) && !hit?.inflight) {
    countCache.set(id, { at: hit?.at ?? 0, n: hit?.n ?? 0, inflight: true });
    // B1 pickVia: the room id's own server (pre-v12), else whoever invited me, else my own server — a v12 id carries
    // none (nav.rs invited_space_member_count asks the same)
    const via = pickVia({ target: id, hints: [inviterServerHere(id), serverPart(c.getUserId())] })[0] ?? "";
    const base = c.getHomeserverUrl().replace(/\/$/, "");
    const tok = c.getAccessToken();
    const gen = clientGen;
    const tryUrls = [
      `${base}/_matrix/client/v1/room_summary/${encodeURIComponent(id)}?via=${encodeURIComponent(via)}`,
      `${base}/_matrix/client/unstable/im.nheko.summary/rooms/${encodeURIComponent(id)}/summary?via=${encodeURIComponent(via)}`,
    ];
    (async () => {
      for (const u of tryUrls) {
        try {
          const r = await fetch(u, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
          if (!r.ok) continue;
          const j = (await r.json()) as { num_joined_members?: number };
          if (gen !== clientGen) return;
          if (typeof j.num_joined_members === "number") {
            countCache.set(id, { at: Date.now(), n: j.num_joined_members });
            scheduleRefresh();
            return;
          }
        } catch {
          /* next */
        }
      }
      // fallback: joined members visible in the stripped invite state
      if (gen !== clientGen) return;
      const n = room.currentState.getJoinedMemberCount();
      countCache.set(id, { at: Date.now(), n: Math.max(n, 1) });
      scheduleRefresh();
    })();
  }
  return hit?.n ?? 0;
}

// ---- the build (nav.rs build_nav) -------------------------------------------------------------

const pendingChildren = new Map<string, { space: string; at: number }>();
/** A room was just attached to `spaceId` (New room in <space>): treat it as a child until /sync
 *  delivers the m.space.child (so the rail stays on the space and the row shows up there at once). */
export function notePendingChild(roomId: string, spaceId: string): void {
  pendingChildren.set(roomId, { space: spaceId, at: Date.now() });
  scheduleRefresh();
}

export interface LiveRoster {
  roomId: string;
  users: Participant[];
}

let liveRoster: LiveRoster | null = null;
/** The calls engine's live SFU roster for the room we are IN (nav shows it instead of state). */
export function setLiveRoster(r: LiveRoster | null): void {
  const same =
    (r === null && liveRoster === null) ||
    (r && liveRoster && r.roomId === liveRoster.roomId && r.users.map((u) => u.mxid).join() === liveRoster.users.map((u) => u.mxid).join());
  liveRoster = r;
  if (!same) scheduleRefresh();
}

/** REACH §1.1: a DM's other person — the m.direct entry it is filed under, an invite's inviter, else the
 *  SDK's guess (the one other member); "" when nobody fits. */
function dmPeer(room: Room, me: string, filed: string | undefined, membership: "join" | "invite"): string {
  if (filed && filed !== me) return filed;
  if (membership === "invite") return inviterOf(room, me).mxid;
  try {
    const g = room.guessDMUserId();
    return g && g !== me ? g : "";
  } catch {
    return "";
  }
}

/** A2.14 + parity item h: the DM's one other person, or "". An invite names its inviter only when the invite's
 *  member state shows exactly the inviter besides us (a group invite, or state without the inviter: nobody). */
function peerOf(room: Room, me: string, filed: string | undefined, membership: "join" | "invite"): string {
  if (membership === "invite") {
    const inviter = inviterOf(room, me).mxid;
    const others = room.currentState
      .getMembers()
      .filter((m) => m.userId !== me && (m.membership === "join" || m.membership === "invite"))
      .map((m) => m.userId);
    return inviter && others.length === 1 && others[0] === inviter ? inviter : "";
  }
  return room.getInvitedAndJoinedMemberCount() === 2 ? dmPeer(room, me, filed, membership) : "";
}

/** The peer's member avatar (REACH §1.2: a DM without a room avatar shows the person's picture). */
function peerAvatar(c: MatrixClient, room: Room, peer: string): string {
  const m = room.getMember(peer);
  if (!m) wantMembers(room);
  return m?.getMxcAvatarUrl() || c.getUser(peer)?.avatarUrl || "";
}

/** When the invite came (our own m.room.member event) — an invite's recency on the DM strip. */
function inviteTime(room: Room, me: string): number {
  const ev = room.currentState.getMember(me)?.events.member ?? room.currentState.getStateEvents(EventType.RoomMember, me);
  return ev?.getTs() || 0;
}

function rowFor(c: MatrixClient, room: Room, membership: "join" | "invite", dms: Map<string, string>, rules: PushRules, now: number): RoomRow {
  const me = c.getUserId() ?? "";
  // a DM invite (is_direct on my member event) is a DM before it is filed in m.direct (matrix-sdk is_direct)
  const dm =
    dms.has(room.roomId) ||
    (membership === "invite" && (room.currentState.getStateEvents(EventType.RoomMember, me)?.getContent() as { is_direct?: boolean } | undefined)?.is_direct === true);
  const mode = effectiveMode(rules, room.roomId, dm);
  const muted = mode === "mute";
  const total = room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0;
  const hl = room.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0;
  // A5.3: the settings-adjusted number (0 muted, highlights in mentions mode, else the notification count)
  const unread = adjustedUnread({ mode, notif: total, highlight: hl, isSpace: false });
  let participants: Participant[] = [];
  const liveUsers = callMemberUsers(room, now);
  if (liveRoster && liveRoster.roomId === room.roomId) participants = liveRoster.users;
  else participants = liveUsers.map((u) => ({ mxid: u, name: memberName(room, u), avatar: memberAvatar(room, u) }));
  const alias = room.getCanonicalAlias() ?? "";
  const jr = joinRuleOf(room);
  // A2.14: a person only when the DM has exactly one other member (joined or invited) — no dot otherwise
  const peer = dm ? peerOf(room, me, dms.get(room.roomId), membership) : "";
  const roomAvatar = room.getMxcAvatarUrl() ?? "";
  // a lazily-loaded DM names itself after the bare user id until the hero's member event is loaded
  // (the desktop SDK shows the display name) — load the members once; the name event rebuilds us
  if (membership === "join" && /^@[^:]+:/.test(room.name) && !memberLoads.has(room.roomId)) wantMembers(room);
  const row: RoomRow = {
    id: room.roomId,
    name: room.name || alias || room.roomId,
    avatar: roomAvatar || (peer ? peerAvatar(c, room, peer) : ""),
    unread: membership === "invite" ? 0 : unread,
    highlight: hl > 0,
    rawUnread: membership === "invite" ? 0 : total,
    dm,
    favourite: !!room.tags?.["m.favourite"],
    call: liveUsers.length > 0 || participants.length > 0,
    membership,
    notifyMode: mode,
    muted,
    participants,
    activity: dm ? null : activityOf(room),
    statuses: dm ? [] : statusesOf(room, now),
    alias,
    publicJoin: jr === "public" || jr === "knock",
    isSpace: isSpace(room),
    recency: membership === "invite" ? null : room.getLastActiveTimestamp() > 0 ? room.getLastActiveTimestamp() : null,
    peer,
  };
  if (membership === "invite") {
    row.inviter = inviterOf(room, me).name;
    row.invitedAt = inviteTime(room, me);
  }
  return row;
}

/** nav.rs sort_rooms — stable, highest first. */
export function sortRooms(rows: RoomRow[]): RoomRow[] {
  const unreadOf = (r: RoomRow) => !r.muted && r.unread > 0;
  const idx = new Map(rows.map((r, i) => [r.id, i]));
  return [...rows].sort((a, b) => {
    const t = (x: boolean, y: boolean) => Number(y) - Number(x);
    return (
      t(a.membership === "invite", b.membership === "invite") ||
      t(unreadOf(a) && a.dm, unreadOf(b) && b.dm) ||
      t(a.favourite, b.favourite) ||
      t(a.call, b.call) ||
      t(unreadOf(a), unreadOf(b)) ||
      (a.recency !== null && b.recency !== null
        ? b.recency - a.recency
        : a.recency !== null
          ? -1
          : b.recency !== null
            ? 1
            : 0) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
      idx.get(a.id)! - idx.get(b.id)!
    );
  });
}

export function readSpaceOrder(): string[] {
  const v: unknown = getPref("space_order", [] as string[]);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function metaMember(f: { isSpace: boolean; parented: boolean; dm: boolean; favourite: boolean }, key: string): boolean {
  if (f.isSpace) return false;
  switch (key) {
    case "home":
      return !f.parented || f.dm;
    case "favourites":
      return f.favourite;
    case "people":
      return f.dm;
    case "orphans":
      return !f.parented && !f.dm;
    default:
      return false;
  }
}

const leftLocally = new Map<string, number>();
/** A leave / decline succeeded on the server: drop the row now instead of when /sync echoes it
 *  (a long-poll can take seconds; the row would otherwise sit there looking un-left). */
export function noteLeft(roomId: string): void {
  leftLocally.set(roomId, Date.now());
  scheduleRefresh();
}

export function buildNav(c: MatrixClient, activeKey: string): NavSnapshot {
  const now = Date.now();
  for (const [id, at] of leftLocally) if (now - at > 60_000 || !c.getRoom(id) || c.getRoom(id)!.getMyMembership() === "leave") leftLocally.delete(id);
  const all = c.getRooms().filter((r) => !leftLocally.has(r.roomId));
  const joined = all.filter((r) => r.getMyMembership() === "join");
  // account safety (core/safety.ts): an invite from someone I ignore is hidden (the server stops sending new ones)
  const invited = all.filter((r) => r.getMyMembership() === "invite" && !c.isUserIgnored(inviterOf(r, c.getUserId() ?? "").mxid));
  const dms = directPeers(c);
  const rules = pushRules(c);

  // spaces + parent index
  interface SE {
    id: string;
    label: string;
    avatar: string;
    children: Set<string>;
  }
  let spaceEntries: SE[] = [];
  const parented = new Set<string>();
  for (const s of joined.filter(isSpace)) {
    const children = new Set(spaceChildIds(s));
    for (const ch of children) parented.add(ch);
    spaceEntries.push({ id: s.roomId, label: s.name || s.getCanonicalAlias() || s.roomId, avatar: s.getMxcAvatarUrl() ?? "", children });
  }
  // rooms just created into a space: listed there before the m.space.child comes back via /sync
  for (const [roomId, pc] of pendingChildren) {
    if (now - pc.at > 30_000) {
      pendingChildren.delete(roomId);
      continue;
    }
    const se = spaceEntries.find((x) => x.id === pc.space);
    if (!se) continue;
    if (se.children.has(roomId)) pendingChildren.delete(roomId);
    else {
      se.children.add(roomId);
      parented.add(roomId);
    }
  }
  const order = readSpaceOrder();
  if (order.length) {
    const pos = (id: string) => {
      const i = order.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    spaceEntries = spaceEntries.map((s, i) => ({ s, i })).sort((a, b) => pos(a.s.id) - pos(b.s.id) || a.i - b.i).map((x) => x.s);
  }
  const roomSpace = new Map<string, string>();
  for (const se of spaceEntries) for (const ch of se.children) if (!roomSpace.has(ch)) roomSpace.set(ch, se.id);

  const me = c.getUserId() ?? "";
  const invitedSpaces = invited
    .filter(isSpace)
    .map((s) => {
      const inv = inviterOf(s, me);
      return {
        key: s.roomId,
        label: s.name || s.getCanonicalAlias() || s.roomId,
        kind: "space" as const,
        avatar: s.getMxcAvatarUrl() ?? "",
        unread: 0,
        highlight: false,
        membership: "invite" as const,
        inviter: inv.name,
        inviterMxid: inv.mxid,
        memberCount: invitedMemberCount(c, s),
      };
    })
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));

  // per-room facts + rows. A5.3: every rollup sums what the rows show (settings-adjusted, spaces skipped)
  const rowsById = new Map<string, RoomRow>();
  let total = 0;
  let unreadRooms = 0;
  const facts = joined.map((r) => {
    const row = rowFor(c, r, "join", dms, rules, now);
    rowsById.set(r.roomId, row);
    const adj = row.isSpace ? 0 : row.unread;
    total += adj;
    if (adj > 0) unreadRooms++;
    return { id: r.roomId, isSpace: row.isSpace, parented: parented.has(r.roomId), dm: row.dm, favourite: row.favourite, adj, hl: !row.isSpace && !row.muted && row.highlight };
  });
  const invRows = invited.map((r) => rowFor(c, r, "invite", dms, rules, now));
  // A5.1: a pending DM invite counts 1 on People (and in the global badge / app badge, A5.10)
  const dmInvites = invRows.filter((r) => r.dm && !r.isSpace).length;
  total += dmInvites;
  unreadRooms += dmInvites;

  const spaces: SpaceEntry[] = [];
  for (const m of META_SPACES) {
    let n = m.key === "people" ? dmInvites : 0;
    let hl = false;
    for (const f of facts)
      if (metaMember(f, m.key)) {
        n += f.adj;
        hl ||= f.hl;
      }
    spaces.push({ key: m.key, label: m.label, kind: "meta", avatar: "", unread: n, highlight: hl });
  }
  let activeLabel = META_SPACES.find((m) => m.key === activeKey)?.label ?? "";
  for (const se of spaceEntries) {
    let n = 0;
    let hl = false;
    for (const id of se.children) {
      const r = rowsById.get(id);
      if (r && !r.isSpace) {
        n += r.unread;
        hl ||= !r.muted && r.highlight;
      }
    }
    if (se.id === activeKey) activeLabel = se.label;
    spaces.push({ key: se.id, label: se.label, kind: "space", avatar: se.avatar, unread: n, highlight: hl, membership: "join" });
  }
  for (const inv of invitedSpaces) {
    if (inv.key === activeKey) activeLabel = inv.label;
    spaces.push(inv);
  }

  // rooms of the active key
  const activeChildren = activeKey.startsWith("!") ? (spaceEntries.find((s) => s.id === activeKey)?.children ?? new Set<string>()) : null;
  const rows: RoomRow[] = [];
  for (const f of facts) {
    const include = activeChildren ? !f.isSpace && activeChildren.has(f.id) : metaMember(f, activeKey);
    if (include) rows.push(rowsById.get(f.id)!);
  }
  for (const r of invRows) {
    // REACH §1.3: a DM invite is also listed under People (the strip's invite bubble opens People on it)
    const show = activeChildren ? activeChildren.has(r.id) : activeKey === "home" || (activeKey === "people" && r.dm && !r.isSpace);
    if (show) rows.push(r);
  }
  if (activeKey.startsWith("!") && spaceEntries.some((s) => s.id === activeKey)) {
    const joinedIds = new Set(joined.map((r) => r.roomId));
    for (const h of joinableChildren(c, activeKey)) {
      if (joinedIds.has(h.room_id)) continue;
      if (invRows.some((r) => r.id === h.room_id)) continue;
      rows.push({
        id: h.room_id,
        name: h.name || h.room_id,
        avatar: h.avatar_url ?? "",
        unread: 0,
        highlight: false,
        rawUnread: 0,
        dm: false,
        favourite: false,
        call: false,
        membership: "none",
        notifyMode: "all",
        muted: false,
        participants: [],
        activity: null,
        statuses: [],
        alias: "",
        publicJoin: h.join_rule === "public",
        isSpace: false,
        recency: null,
        peer: "",
        joinRule: h.join_rule,
        memberCount: h.num_joined_members ?? 0,
        topic: h.topic ?? "",
      });
    }
  }

  // global list (bridge.rs rooms_json order ≈ sort_rooms)
  const globalRooms = sortRooms([...facts.filter((f) => !f.isSpace).map((f) => rowsById.get(f.id)!), ...invRows.filter((r) => !r.isSpace)]);

  // REACH §1: the DM strip over ALL joined + invited rooms, whatever space is active
  const stripRooms: DmStripRoom[] = [];
  for (const f of facts) {
    const r = rowsById.get(f.id)!;
    if (f.isSpace || !r.dm) continue;
    stripRooms.push({ id: r.id, dm: true, membership: "join", unread: r.unread, highlight: r.highlight, recency: r.recency ?? 0, name: r.name, avatar: r.avatar, peer: r.peer });
  }
  for (const r of invRows) {
    if (r.isSpace || !r.dm) continue;
    const room = c.getRoom(r.id);
    stripRooms.push({ id: r.id, dm: true, membership: "invite", unread: 0, highlight: false, recency: room ? inviteTime(room, me) : 0, name: r.name, avatar: r.avatar, peer: r.peer });
  }

  return {
    spaces,
    rooms: sortRooms(rows),
    globalRooms,
    activeLabel,
    globalBadge: total === 0 ? "" : total > 99 ? "99+" : String(total),
    roomSpace,
    invitedSpaceKeys: invitedSpaces.map((s) => s.key),
    dmStrip: dmStrip(stripRooms),
    unreadRooms,
    loaded: all.length > 0,
  };
}

// ---- the store --------------------------------------------------------------------------------

export interface NavState extends NavSnapshot {
  activeKey: string;
  /** a rail drag is in progress (incoming space updates are held until the drop) */
  dragging: boolean;
  heldSpaces: SpaceEntry[] | null;
  /** the room id the now-playing editor is open for ("" = none) — survives list refreshes */
  editingRoomId: string;
  rev: number;
}

const EMPTY: NavSnapshot = {
  spaces: META_SPACES.map((m) => ({ key: m.key, label: m.label, kind: "meta" as const, avatar: "", unread: 0, highlight: false })),
  rooms: [],
  globalRooms: [],
  activeLabel: "Home",
  globalBadge: "",
  roomSpace: new Map(),
  invitedSpaceKeys: [],
  dmStrip: EMPTY_DM_STRIP,
  unreadRooms: 0,
  loaded: false,
};

export const useNavStore = create<NavState>()(() => ({
  ...EMPTY,
  activeKey: "home",
  dragging: false,
  heldSpaces: null,
  editingRoomId: "",
  rev: 0,
}));

let raf = 0;
let timer = 0;
/** Coalesce recomputes (a sync batch of 200 events → one build). */
export function scheduleRefresh(): void {
  if (raf || timer) return;
  const run = () => {
    // whichever fires first cancels the other (a background tab gets no rAF; stale callbacks would
    // pile up and rebuild in a burst when it becomes visible)
    window.cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    raf = 0;
    timer = 0;
    refreshNow();
  };
  raf = window.requestAnimationFrame(run);
  // background tabs get no rAF — fall back to a timer
  timer = window.setTimeout(run, 250);
}

export function refreshNow(): void {
  const c = peekClient();
  const st = useNavStore.getState();
  if (!c) {
    useNavStore.setState({ ...EMPTY, rev: st.rev + 1 });
    return;
  }
  nextExpiry = Infinity;
  let snap = buildNav(c, st.activeKey);
  // the selected space went away (left / declined / kicked): back to Home instead of an empty,
  // label-less list (a key that never appeared yet — a space created a moment ago — is kept)
  if (st.activeKey.startsWith("!") && st.spaces.some((x) => x.key === st.activeKey) && !snap.spaces.some((x) => x.key === st.activeKey)) {
    useNavStore.setState({ activeKey: "home" });
    snap = buildNav(c, "home");
  }
  // an unchanged strip keeps its identity (the rail's bubbles re-render only on a real change)
  if (JSON.stringify(snap.dmStrip) === JSON.stringify(st.dmStrip)) snap = { ...snap, dmStrip: st.dmStrip };
  if (st.dragging) {
    // mirror rule: never reassign the rail mid-drag (qml/AppCore.qml:1432)
    useNavStore.setState({ ...snap, spaces: st.spaces, heldSpaces: snap.spaces, rev: st.rev + 1 });
  } else {
    useNavStore.setState({ ...snap, rev: st.rev + 1 });
  }
  armExpiry();
}

let expiryTimer = 0;
let expiryAt = Infinity;
function armExpiry(): void {
  if (nextExpiry === expiryAt && expiryTimer) return;
  window.clearTimeout(expiryTimer);
  expiryTimer = 0;
  expiryAt = nextExpiry;
  if (!Number.isFinite(nextExpiry)) return;
  // (a timeout longer than 2^31 ms fires at once — cap it; a re-arm follows the rebuild)
  expiryTimer = window.setTimeout(() => {
    expiryTimer = 0;
    expiryAt = Infinity;
    scheduleRefresh();
  }, Math.min(2_000_000_000, Math.max(0, nextExpiry - Date.now()) + 50));
}

export function selectSpace(key: string): void {
  if (!key) return;
  // the highlight moves instantly, the rows follow in the same frame
  useNavStore.setState({ activeKey: key });
  refreshNow();
}

export function setDragging(on: boolean): void {
  const st = useNavStore.getState();
  if (on) useNavStore.setState({ dragging: true });
  else {
    useNavStore.setState({ dragging: false, heldSpaces: null, ...(st.heldSpaces ? { spaces: st.heldSpaces } : {}) });
  }
}

export function setSpaceOrder(keys: string[]): void {
  setPref("space_order", keys);
  refreshNow();
}

export function spaceOf(roomId: string): string {
  return useNavStore.getState().roomSpace.get(roomId) ?? "home";
}

export function setEditingRoom(id: string): void {
  useNavStore.setState({ editingRoomId: id });
}

// ---- wiring to the client ----------------------------------------------------------------------

let detach: (() => void) | null = null;
let tick = 0;

let offProbe: (() => void) | null = null;
function attach(c: MatrixClient) {
  const f = () => scheduleRefresh();
  const stateF = (ev: MatrixEvent) => {
    const t = ev.getType();
    if (
      t === EventType.SpaceChild ||
      t === EventType.RoomCreate ||
      t === EventType.RoomName ||
      t === EventType.RoomAvatar ||
      t === EventType.RoomCanonicalAlias ||
      t === EventType.RoomJoinRules ||
      t === EventType.RoomMember ||
      t === ACTIVITY_TYPE ||
      t === STATUS_TYPE ||
      (CALL_MEMBER_TYPES as readonly string[]).includes(t)
    )
      f();
  };
  const accF = (ev: MatrixEvent) => {
    const t = ev.getType();
    if (t === EventType.Direct || t === EventType.PushRules || t === "m.ignored_user_list") f();
  };
  const unreadRooms = new Set<Room>();
  const bindUnread = () => {
    for (const r of c.getRooms()) {
      if (!unreadRooms.has(r)) {
        r.on(RoomEvent.UnreadNotifications, f);
        unreadRooms.add(r);
      }
    }
  };
  const onRoom = () => {
    bindUnread();
    f();
  };
  c.on(ClientEvent.Sync, f);
  c.on(ClientEvent.Room, onRoom);
  const onDelete = (roomId: string) => {
    for (const r of unreadRooms)
      if (r.roomId === roomId) {
        r.off(RoomEvent.UnreadNotifications, f);
        unreadRooms.delete(r);
      }
    f();
  };
  c.on(ClientEvent.DeleteRoom, onDelete);
  c.on(ClientEvent.AccountData, accF);
  c.on(RoomEvent.MyMembership, f);
  c.on(RoomEvent.Name, f);
  c.on(RoomEvent.Tags, f);
  c.on(RoomEvent.Receipt, f);
  c.on(RoomEvent.Timeline, f);
  c.on(RoomStateEvent.Events, stateF);
  offProbe?.();
  offProbe = onMemberProbe(f); // a probed call member's membership arrived (memberprobe.ts)
  bindUnread();
  // participants / statuses: expiry is time-based → one timeout at the next expiry (armExpiry, after each build)
  const offPref = onPrefChange("space_order", f);
  scheduleRefresh();
  return () => {
    c.off(ClientEvent.Sync, f);
    c.off(ClientEvent.Room, onRoom);
    c.off(ClientEvent.DeleteRoom, onDelete);
    c.off(ClientEvent.AccountData, accF);
    c.off(RoomEvent.MyMembership, f);
    c.off(RoomEvent.Name, f);
    c.off(RoomEvent.Tags, f);
    c.off(RoomEvent.Receipt, f);
    c.off(RoomEvent.Timeline, f);
    c.off(RoomStateEvent.Events, stateF);
    for (const r of unreadRooms) r.off(RoomEvent.UnreadNotifications, f);
    window.clearInterval(tick);
    window.clearTimeout(expiryTimer);
    expiryTimer = 0;
    expiryAt = Infinity;
    offPref();
  };
}

/** Install once (feature setup). Follows sign-in / sign-out. */
export function installNavModel(): void {
  const rebind = () => {
    detach?.();
    detach = null;
    const c = peekClient();
    clientGen++;
    hierCache.clear();
    countCache.clear();
    memberLoads.clear();
    if (c) detach = attach(c);
    else useNavStore.setState({ ...EMPTY, activeKey: "home", editingRoomId: "" });
  };
  onClientChanged(rebind);
  rebind();
}

/** Force a refetch of a space's joinable children on the next build. */
export function invalidateHierarchy(spaceId?: string): void {
  if (spaceId) hierCache.delete(spaceId);
  else hierCache.clear();
}
