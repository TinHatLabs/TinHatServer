// hooks.ts — React hooks over the live Matrix client (ARCHITECTURE.md "Matrix — @/core/matrix").
//
// All hooks are safe before login (they return empty values) and re-render ONLY when their own
// value changes: each is a shared derived value (derive.ts) listening to the specific emitter
// events that can change it, coalesced per microtask.
//
//   useRooms()                       joined + invited rooms (Room[]; spaces included — filter with isSpaceRoom())
//   useRoom(id)                      Room | null
//   useRoomName(id)                  js-sdk computed name (DM → the other person's name)
//   useRoomAvatar(id)                mxc of the room's m.room.avatar (native: room.avatar_url()), or null
//   useMyMembership(id)              "join" | "invite" | "leave" | "ban" | "knock" | undefined
//   useMembers(id, which?)           MemberInfo[] (default join+invite; lazy-loads members on first use)
//   useMember(roomId, userId)        MemberInfo | null
//   useRoomState(roomId, type, key?) content | undefined   (empty {} content is returned as-is)
//   useRoomStateAll(roomId, type)    Map<stateKey, content>
//   useRoomStateEvents(roomId, type) StateEntry[] {stateKey, sender, content, ts, eventId}
//   usePowerLevels(roomId)           m.room.power_levels content | undefined
//   useAccountData(type)             global account-data content | undefined
//   useRoomAccountData(roomId, type) room account-data content | undefined
//   useRoomTags(roomId)              { [tag]: {order?} } (m.favourite, m.lowpriority, …)
//   useDirectRoomIds()               Set of room ids listed in m.direct
//   useIsDirect(roomId)              boolean
//   useUserProfile(userId)           { displayName?, avatarUrl?, loading } (profile API, cached 10 min)
//   useUnread(roomId)                { count, highlight } — server/SDK notification counts (the nav
//                                    applies the room's notify mode, native nav.rs TH-NOTIF-03)
//   useTyping(roomId)                user ids typing (not me)
//   useSpaces()                      joined spaces
//   useSpaceChildren(spaceId)        SpaceChild[] from m.space.child (non-empty via only)
//   useTimeline(roomId)              LOW-LEVEL live timeline + paginateBack (chat builds on it)
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ClientEvent,
  EventStatus,
  EventType,
  MatrixEventEvent,
  NotificationCountType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  UserEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
} from "matrix-js-sdk";
import { onClientChanged, peekClient } from "./client";
import { liveTimelineChain, paginateChainBack } from "./timeline";
import {
  arrayOfObjectsEqual,
  shallowArrayEqual,
  shallowMapEqual,
  shallowObjectEqual,
  useDerived,
  type DeriveSpec,
} from "./derive";

type Content = Record<string, unknown>;

// ---- rooms -----------------------------------------------------------------------------------

function attachRoomList(c: MatrixClient, changed: () => void) {
  c.on(ClientEvent.Room, changed);
  c.on(ClientEvent.DeleteRoom, changed);
  c.on(RoomEvent.MyMembership, changed);
  return () => {
    c.off(ClientEvent.Room, changed);
    c.off(ClientEvent.DeleteRoom, changed);
    c.off(RoomEvent.MyMembership, changed);
  };
}

const EMPTY_ROOMS: Room[] = [];

function visibleRooms(c: MatrixClient | null): Room[] {
  if (!c) return EMPTY_ROOMS;
  return c.getRooms().filter((r) => {
    const m = r.getMyMembership();
    return m === "join" || m === "invite";
  });
}

const roomsSpec: () => DeriveSpec<Room[]> = () => ({
  attach: attachRoomList,
  compute: visibleRooms,
  equal: shallowArrayEqual,
});

/** Joined + invited rooms (unsorted — the nav owns ordering). Spaces included. */
export function useRooms(): Room[] {
  return useDerived("rooms", roomsSpec);
}

/** A room by id (null until the client knows it). */
export function useRoom(roomId: string | null | undefined): Room | null {
  return useDerived(`room:${roomId ?? ""}`, () => ({
    attach: attachRoomList,
    compute: (c) => (roomId && c ? c.getRoom(roomId) : null),
  }));
}

/** Filter helper: attach a client-level listener but only fire for one room. */
function forRoom(roomId: string, changed: () => void) {
  return (...args: unknown[]) => {
    for (const a of args) {
      const rid =
        (a as { roomId?: string } | null)?.roomId ??
        (typeof (a as MatrixEvent | null)?.getRoomId === "function" ? (a as MatrixEvent).getRoomId() : undefined);
      if (rid === roomId) return changed();
    }
  };
}

export function useRoomName(roomId: string | null | undefined): string {
  return useDerived(`roomName:${roomId ?? ""}`, () => ({
    attach: (c, changed) => {
      const f = forRoom(roomId ?? "", changed);
      c.on(RoomEvent.Name, f);
      c.on(ClientEvent.Room, f);
      c.on(RoomEvent.MyMembership, f);
      return () => {
        c.off(RoomEvent.Name, f);
        c.off(ClientEvent.Room, f);
        c.off(RoomEvent.MyMembership, f);
      };
    },
    compute: (c) => (roomId && c?.getRoom(roomId)?.name) || "",
  }));
}

function attachStateType(roomId: string, types: string[] | null, c: MatrixClient, changed: () => void) {
  const onEvents = (ev: MatrixEvent) => {
    if (ev.getRoomId() === roomId && (!types || types.includes(ev.getType()))) changed();
  };
  const onRoom = (r: Room) => {
    if (r.roomId === roomId) changed();
  };
  const onMembership = (r: Room) => {
    if (r.roomId === roomId) changed();
  };
  c.on(RoomStateEvent.Events, onEvents);
  c.on(ClientEvent.Room, onRoom);
  c.on(RoomEvent.MyMembership, onMembership);
  return () => {
    c.off(RoomStateEvent.Events, onEvents);
    c.off(ClientEvent.Room, onRoom);
    c.off(RoomEvent.MyMembership, onMembership);
  };
}

/** mxc:// of the room's own avatar (m.room.avatar), or null. */
export function useRoomAvatar(roomId: string | null | undefined): string | null {
  return useDerived(`roomAvatar:${roomId ?? ""}`, () => ({
    attach: (c, changed) => attachStateType(roomId ?? "", [EventType.RoomAvatar], c, changed),
    compute: (c) => (roomId && c?.getRoom(roomId)?.getMxcAvatarUrl()) || null,
  }));
}

export function useMyMembership(roomId: string | null | undefined): string | undefined {
  return useDerived(`myMembership:${roomId ?? ""}`, () => ({
    attach: attachRoomList,
    compute: (c) => (roomId ? c?.getRoom(roomId)?.getMyMembership() : undefined),
  }));
}

// ---- members ---------------------------------------------------------------------------------

/** An immutable snapshot of a RoomMember (safe for React equality). */
export interface MemberInfo {
  userId: string;
  /** Disambiguated display name (js-sdk `member.name`). */
  name: string;
  /** Display name as set by the user (falls back to the user id). */
  rawName: string;
  avatarMxc: string | null;
  membership: string;
  powerLevel: number;
  /** The live js-sdk object (mutable — don't use it for equality). */
  member: RoomMember;
}

function memberInfo(m: RoomMember): MemberInfo {
  return {
    userId: m.userId,
    name: m.name,
    rawName: m.rawDisplayName || m.userId,
    avatarMxc: m.getMxcAvatarUrl() ?? null,
    membership: m.membership ?? "leave",
    powerLevel: m.powerLevel,
    member: m,
  };
}

function memberInfoEqual(a: MemberInfo | null, b: MemberInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.userId === b.userId &&
    a.name === b.name &&
    a.rawName === b.rawName &&
    a.avatarMxc === b.avatarMxc &&
    a.membership === b.membership &&
    a.powerLevel === b.powerLevel
  );
}

function attachMembers(roomId: string, c: MatrixClient, changed: () => void) {
  const onState = (_ev: unknown, state: RoomState) => {
    if (state?.roomId === roomId) changed();
  };
  const onUpdate = (state: RoomState) => {
    if (state?.roomId === roomId) changed();
  };
  const onMember = (_ev: unknown, member: RoomMember) => {
    if (member?.roomId === roomId) changed();
  };
  const onRoom = (r: Room) => {
    if (r.roomId === roomId) changed();
  };
  c.on(RoomStateEvent.Members, onState);
  c.on(RoomStateEvent.NewMember, onState);
  c.on(RoomStateEvent.Update, onUpdate);
  c.on(RoomMemberEvent.Name, onMember);
  c.on(RoomMemberEvent.Membership, onMember);
  c.on(RoomMemberEvent.PowerLevel, onMember);
  c.on(ClientEvent.Room, onRoom);
  return () => {
    c.off(RoomStateEvent.Members, onState);
    c.off(RoomStateEvent.NewMember, onState);
    c.off(RoomStateEvent.Update, onUpdate);
    c.off(RoomMemberEvent.Name, onMember);
    c.off(RoomMemberEvent.Membership, onMember);
    c.off(RoomMemberEvent.PowerLevel, onMember);
    c.off(ClientEvent.Room, onRoom);
  };
}

const loadingMembers = new Set<string>();

/** Load the full member list of a lazily-loaded room once (idempotent). */
export async function ensureMembersLoaded(roomId: string): Promise<void> {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (!room || loadingMembers.has(roomId)) return;
  loadingMembers.add(roomId);
  try {
    await room.loadMembersIfNeeded();
  } catch {
    loadingMembers.delete(roomId); // retry next time
  }
}

export type MemberFilter = "joinInvite" | "join" | "invite" | "all";

/** Members of a room as snapshots, ordered as js-sdk returns them (sort in the UI). */
export function useMembers(roomId: string | null | undefined, which: MemberFilter = "joinInvite"): MemberInfo[] {
  return useDerived(`members:${roomId ?? ""}:${which}`, () => ({
    attach: (c, changed) => attachMembers(roomId ?? "", c, changed),
    onFirstSubscribe: () => {
      if (roomId) void ensureMembersLoaded(roomId);
    },
    compute: (c) => {
      const room = roomId ? c?.getRoom(roomId) : null;
      if (!room) return [];
      return room
        .getMembers()
        .filter((m) => {
          const ms = m.membership;
          if (which === "all") return true;
          if (which === "join") return ms === "join";
          if (which === "invite") return ms === "invite";
          return ms === "join" || ms === "invite";
        })
        .map(memberInfo);
    },
    equal: (a, b) => a.length === b.length && a.every((x, i) => memberInfoEqual(x, b[i]!)),
  }));
}

export function useMember(roomId: string | null | undefined, userId: string | null | undefined): MemberInfo | null {
  return useDerived(`member:${roomId ?? ""}:${userId ?? ""}`, () => ({
    attach: (c, changed) => attachMembers(roomId ?? "", c, changed),
    compute: (c) => {
      const m = roomId && userId ? c?.getRoom(roomId)?.getMember(userId) : null;
      return m ? memberInfo(m) : null;
    },
    equal: memberInfoEqual,
  }));
}

// ---- room state ------------------------------------------------------------------------------

function stateContent(c: MatrixClient | null, roomId: string, type: string, key: string): Content | undefined {
  const ev = c?.getRoom(roomId)?.currentState.getStateEvents(type, key);
  return ev ? (ev.getContent() as Content) : undefined;
}

/** Content of one state event (by type + state key), or undefined. */
export function useRoomState<T extends Content = Content>(
  roomId: string | null | undefined,
  type: string,
  stateKey = "",
): T | undefined {
  return useDerived(`state:${roomId ?? ""}:${type}:${stateKey}`, () => ({
    attach: (c, changed) => attachStateType(roomId ?? "", [type], c, changed),
    compute: (c) => (roomId ? stateContent(c, roomId, type, stateKey) : undefined),
  })) as T | undefined;
}

/** Every state event of a type: state_key → content. */
export function useRoomStateAll<T extends Content = Content>(roomId: string | null | undefined, type: string): Map<string, T> {
  return useDerived(`stateAll:${roomId ?? ""}:${type}`, () => ({
    attach: (c, changed) => attachStateType(roomId ?? "", [type], c, changed),
    compute: (c) => {
      const out = new Map<string, T>();
      const evs = roomId ? c?.getRoom(roomId)?.currentState.getStateEvents(type) ?? [] : [];
      for (const ev of evs) out.set(ev.getStateKey() ?? "", ev.getContent() as T);
      return out;
    },
    equal: shallowMapEqual,
  }));
}

export interface StateEntry<T extends Content = Content> {
  stateKey: string;
  sender: string;
  content: T;
  ts: number;
  eventId: string;
}

/** Every state event of a type with sender + timestamp (native appstate::get_state_all). */
export function useRoomStateEvents<T extends Content = Content>(roomId: string | null | undefined, type: string): StateEntry<T>[] {
  return useDerived(`stateEvents:${roomId ?? ""}:${type}`, () => ({
    attach: (c, changed) => attachStateType(roomId ?? "", [type], c, changed),
    compute: (c) => {
      const evs = roomId ? c?.getRoom(roomId)?.currentState.getStateEvents(type) ?? [] : [];
      return evs.map((ev) => ({
        stateKey: ev.getStateKey() ?? "",
        sender: ev.getSender() ?? "",
        content: ev.getContent() as T,
        ts: ev.getTs(),
        eventId: ev.getId() ?? "",
      }));
    },
    equal: arrayOfObjectsEqual,
  }));
}

export function usePowerLevels(roomId: string | null | undefined): Content | undefined {
  return useRoomState(roomId, EventType.RoomPowerLevels, "");
}

// ---- account data ----------------------------------------------------------------------------

export function useAccountData<T extends Content = Content>(type: string): T | undefined {
  return useDerived(`accountData:${type}`, () => ({
    attach: (c, changed) => {
      const f = (ev: MatrixEvent) => {
        if (ev.getType() === type) changed();
      };
      c.on(ClientEvent.AccountData, f);
      return () => c.off(ClientEvent.AccountData, f);
    },
    compute: (c) => c?.getAccountData(type as never)?.getContent() as Content | undefined,
  })) as T | undefined;
}

export function useRoomAccountData<T extends Content = Content>(roomId: string | null | undefined, type: string): T | undefined {
  return useDerived(`roomAccountData:${roomId ?? ""}:${type}`, () => ({
    attach: (c, changed) => {
      const f = (ev: MatrixEvent, room: Room) => {
        if (room?.roomId === roomId && ev.getType() === type) changed();
      };
      const onRoom = (r: Room) => {
        if (r.roomId === roomId) changed();
      };
      c.on(RoomEvent.AccountData, f);
      c.on(ClientEvent.Room, onRoom);
      return () => {
        c.off(RoomEvent.AccountData, f);
        c.off(ClientEvent.Room, onRoom);
      };
    },
    compute: (c) => (roomId ? (c?.getRoom(roomId)?.getAccountData(type)?.getContent() as Content | undefined) : undefined),
  })) as T | undefined;
}

export function useRoomTags(roomId: string | null | undefined): Record<string, { order?: number }> {
  return useDerived(`tags:${roomId ?? ""}`, () => ({
    attach: (c, changed) => {
      const f = (_ev: MatrixEvent, room: Room) => {
        if (room?.roomId === roomId) changed();
      };
      const onRoom = (r: Room) => {
        if (r.roomId === roomId) changed();
      };
      c.on(RoomEvent.Tags, f);
      c.on(ClientEvent.Room, onRoom);
      return () => {
        c.off(RoomEvent.Tags, f);
        c.off(ClientEvent.Room, onRoom);
      };
    },
    compute: (c) => (roomId ? (c?.getRoom(roomId)?.tags ?? {}) : {}) as Record<string, { order?: number }>,
    equal: shallowObjectEqual as (a: Record<string, { order?: number }>, b: Record<string, { order?: number }>) => boolean,
  }));
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function directIds(c: MatrixClient | null): ReadonlySet<string> {
  const content = c?.getAccountData(EventType.Direct)?.getContent() as Record<string, string[]> | undefined;
  if (!content) return EMPTY_SET;
  const out = new Set<string>();
  for (const ids of Object.values(content)) if (Array.isArray(ids)) for (const id of ids) out.add(id);
  return out;
}

function setEqual(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Room ids listed in m.direct (native room.is_direct()). */
export function useDirectRoomIds(): ReadonlySet<string> {
  return useDerived("directIds", () => ({
    attach: (c, changed) => {
      const f = (ev: MatrixEvent) => {
        if (ev.getType() === EventType.Direct) changed();
      };
      c.on(ClientEvent.AccountData, f);
      return () => c.off(ClientEvent.AccountData, f);
    },
    compute: directIds,
    equal: setEqual,
  }));
}

export function useIsDirect(roomId: string | null | undefined): boolean {
  const ids = useDirectRoomIds();
  return !!roomId && ids.has(roomId);
}

/**
 * A joined DM's one other person, "" when the room isn't one: filed in m.direct, exactly two members (joined or
 * invited) — the user it is filed under, else the SDK's guess. The rule of nav's room rows (features/nav/model.ts
 * peerOf for joined rooms), so a DM's header, floating chat and room info show the person the room list shows
 * (selfhost/firstrun item 6: one colour per person).
 */
export function dmPeerOf(c: MatrixClient | null, roomId: string): string {
  const room = roomId ? c?.getRoom(roomId) : null;
  if (!c || !room) return "";
  const me = c.getUserId() ?? "";
  const direct = c.getAccountData(EventType.Direct)?.getContent() as Record<string, string[]> | undefined;
  let filed: string | null = null;
  for (const [user, ids] of Object.entries(direct ?? {})) {
    if (Array.isArray(ids) && ids.includes(roomId)) {
      filed = user;
      break;
    }
  }
  if (filed === null || room.getInvitedAndJoinedMemberCount() !== 2) return "";
  if (filed && filed !== me) return filed;
  try {
    const g = room.guessDMUserId();
    return g && g !== me ? g : "";
  } catch {
    return "";
  }
}

/** React: a DM's person and their picture (a room: "" and null) — what a DM's avatar shows when the room has no picture
 *  of its own, as in the room list (nav model peerAvatar). */
export function useDmFace(roomId: string | null | undefined): { peer: string; avatar: string | null } {
  const peer = useDmPeer(roomId);
  const m = useMember(roomId, peer || null);
  return { peer, avatar: m?.avatarMxc ?? null };
}

/** React: dmPeerOf (re-renders on m.direct and member changes). */
export function useDmPeer(roomId: string | null | undefined): string {
  return useDerived(`dmPeer:${roomId ?? ""}`, () => ({
    attach: (c, changed) => {
      const offMembers = attachMembers(roomId ?? "", c, changed);
      const f = (ev: MatrixEvent) => {
        if (ev.getType() === EventType.Direct) changed();
      };
      c.on(ClientEvent.AccountData, f);
      return () => {
        offMembers();
        c.off(ClientEvent.AccountData, f);
      };
    },
    compute: (c) => (roomId ? dmPeerOf(c, roomId) : ""),
  }));
}

// ---- unread / typing -------------------------------------------------------------------------

export interface Unread {
  count: number;
  highlight: number;
}

const ZERO_UNREAD: Unread = { count: 0, highlight: 0 };

export function useUnread(roomId: string | null | undefined): Unread {
  return useDerived(`unread:${roomId ?? ""}`, () => {
    let bound: Room | null = null;
    return {
      attach: (c, changed) => {
        const bind = () => {
          const r = roomId ? c.getRoom(roomId) : null;
          if (r === bound) return;
          bound?.off(RoomEvent.UnreadNotifications, changed);
          bound = r;
          bound?.on(RoomEvent.UnreadNotifications, changed);
        };
        const onRoom = (r: Room) => {
          if (r.roomId === roomId) {
            bind();
            changed();
          }
        };
        const f = forRoom(roomId ?? "", changed);
        bind();
        c.on(ClientEvent.Room, onRoom);
        c.on(RoomEvent.Receipt, f);
        c.on(RoomEvent.Timeline, f);
        return () => {
          bound?.off(RoomEvent.UnreadNotifications, changed);
          bound = null;
          c.off(ClientEvent.Room, onRoom);
          c.off(RoomEvent.Receipt, f);
          c.off(RoomEvent.Timeline, f);
        };
      },
      compute: (c) => {
        const r = roomId ? c?.getRoom(roomId) : null;
        if (!r) return ZERO_UNREAD;
        return {
          count: r.getUnreadNotificationCount(NotificationCountType.Total),
          highlight: r.getUnreadNotificationCount(NotificationCountType.Highlight),
        };
      },
      equal: shallowObjectEqual,
    };
  });
}

const NO_TYPING: string[] = [];

export function useTyping(roomId: string | null | undefined): string[] {
  return useDerived(`typing:${roomId ?? ""}`, () => ({
    attach: (c, changed) => {
      const f = (_ev: MatrixEvent, member: RoomMember) => {
        if (member?.roomId === roomId) changed();
      };
      c.on(RoomMemberEvent.Typing, f);
      return () => c.off(RoomMemberEvent.Typing, f);
    },
    compute: (c) => {
      const room = roomId ? c?.getRoom(roomId) : null;
      if (!room || !c) return NO_TYPING;
      const me = c.getUserId();
      const ids = room.currentState
        .getMembers()
        .filter((m) => m.typing && m.userId !== me)
        .map((m) => m.userId);
      return ids.length ? ids : NO_TYPING;
    },
    equal: shallowArrayEqual,
  }));
}

// ---- spaces ----------------------------------------------------------------------------------

export function useSpaces(): Room[] {
  return useDerived("spaces", () => ({
    attach: (c, changed) => {
      const d = attachRoomList(c, changed);
      // A room becomes a space only via its create event (arrives with the room's state).
      const f = (ev: MatrixEvent) => {
        if (ev.getType() === EventType.RoomCreate) changed();
      };
      c.on(RoomStateEvent.Events, f);
      return () => {
        d();
        c.off(RoomStateEvent.Events, f);
      };
    },
    compute: (c) => (c ? c.getRooms().filter((r) => r.getMyMembership() === "join" && r.isSpaceRoom()) : EMPTY_ROOMS),
    equal: shallowArrayEqual,
  }));
}

export interface SpaceChild {
  roomId: string;
  via: string[];
  /** m.space.child `order` (spec: lexicographic, printable ASCII ≤ 50 chars) if valid. */
  order?: string;
  suggested: boolean;
  /** origin_server_ts of the child event (spec tie-breaker). */
  ts: number;
}

/** m.space.child entries with a non-empty `via` (the spec's "present" children), unsorted. */
export function useSpaceChildren(spaceId: string | null | undefined): SpaceChild[] {
  return useDerived(`spaceChildren:${spaceId ?? ""}`, () => ({
    attach: (c, changed) => attachStateType(spaceId ?? "", [EventType.SpaceChild], c, changed),
    compute: (c) => {
      const evs = spaceId ? c?.getRoom(spaceId)?.currentState.getStateEvents(EventType.SpaceChild) ?? [] : [];
      const out: SpaceChild[] = [];
      for (const ev of evs) {
        const content = ev.getContent() as { via?: unknown; order?: unknown; suggested?: unknown };
        const via = Array.isArray(content.via) ? content.via.filter((v): v is string => typeof v === "string") : [];
        const roomId = ev.getStateKey();
        if (!roomId || via.length === 0) continue;
        const order =
          typeof content.order === "string" && content.order.length <= 50 && /^[\x20-\x7E]*$/.test(content.order)
            ? content.order
            : undefined;
        out.push({ roomId, via, order, suggested: content.suggested === true, ts: ev.getTs() });
      }
      return out;
    },
    equal: (a, b) =>
      a.length === b.length &&
      a.every(
        (x, i) =>
          x.roomId === b[i]!.roomId &&
          x.order === b[i]!.order &&
          x.suggested === b[i]!.suggested &&
          x.ts === b[i]!.ts &&
          shallowArrayEqual(x.via, b[i]!.via),
      ),
  }));
}

// ---- user profiles ---------------------------------------------------------------------------

export interface UserProfile {
  displayName?: string;
  avatarUrl?: string;
  loading: boolean;
}

interface ProfileEntry {
  value: UserProfile;
  fetchedAt: number;
  inflight: Promise<void> | null;
}

const PROFILE_TTL = 10 * 60 * 1000;
const profiles = new Map<string, ProfileEntry>();
const profileListeners = new Map<string, Set<() => void>>();
const NO_PROFILE: UserProfile = { loading: false };

onClientChanged(() => profiles.clear());

function notifyProfile(userId: string) {
  for (const l of profileListeners.get(userId) ?? []) l();
}

function setProfile(userId: string, value: UserProfile, fetchedAt = Date.now()) {
  const prev = profiles.get(userId);
  if (prev && shallowObjectEqual(prev.value, value)) {
    prev.fetchedAt = fetchedAt;
    return;
  }
  profiles.set(userId, { value, fetchedAt, inflight: prev?.inflight ?? null });
  notifyProfile(userId);
}

/** Best local guess (any room's member event) while the profile API answers. */
function localGuess(c: MatrixClient, userId: string): UserProfile | null {
  const u = c.getUser(userId);
  if (u?.displayName || u?.avatarUrl) return { displayName: u.displayName, avatarUrl: u.avatarUrl, loading: true };
  for (const r of c.getRooms()) {
    const m = r.getMember(userId);
    if (m) return { displayName: m.rawDisplayName || undefined, avatarUrl: m.getMxcAvatarUrl() ?? undefined, loading: true };
  }
  return null;
}

function fetchProfile(userId: string, force = false): void {
  const c = peekClient();
  if (!c || !userId) return;
  const cur = profiles.get(userId);
  if (cur?.inflight) return;
  if (!force && cur && Date.now() - cur.fetchedAt < PROFILE_TTL && !cur.value.loading) return;
  if (!cur) {
    const g = localGuess(c, userId);
    profiles.set(userId, { value: g ?? { loading: true }, fetchedAt: 0, inflight: null });
  }
  const entry = profiles.get(userId)!;
  entry.inflight = c
    .getProfileInfo(userId)
    .then((p) => {
      if (peekClient() !== c) return;
      setProfile(userId, { displayName: p.displayname || undefined, avatarUrl: p.avatar_url || undefined, loading: false });
    })
    .catch(() => {
      if (peekClient() !== c) return;
      const prev = profiles.get(userId)?.value;
      setProfile(userId, { displayName: prev?.displayName, avatarUrl: prev?.avatarUrl, loading: false });
    })
    .finally(() => {
      const e = profiles.get(userId);
      if (e) e.inflight = null;
    });
}

/** Force a re-fetch (e.g. after the settings pane changed our display name / avatar). */
export function refreshUserProfile(userId: string): void {
  fetchProfile(userId, true);
}

/** Put a known value into the cache (e.g. right after setDisplayName). */
export function primeUserProfile(userId: string, p: Partial<Omit<UserProfile, "loading">>): void {
  const prev = profiles.get(userId)?.value ?? NO_PROFILE;
  setProfile(userId, { ...prev, ...p, loading: false });
}

/** Our own User object emits when setDisplayName/setAvatarUrl run: one listener pair per user id. */
const userWatch = new Map<string, () => void>();

function watchUser(uid: string) {
  if (userWatch.has(uid)) return;
  const c = peekClient();
  const u = uid && c ? c.getUser(uid) : null;
  if (!u) return;
  const onUser = () => primeUserProfile(uid, { displayName: u.displayName, avatarUrl: u.avatarUrl });
  u.on(UserEvent.DisplayName, onUser);
  u.on(UserEvent.AvatarUrl, onUser);
  userWatch.set(uid, () => {
    u.off(UserEvent.DisplayName, onUser);
    u.off(UserEvent.AvatarUrl, onUser);
  });
}

onClientChanged(() => {
  for (const off of userWatch.values()) off();
  userWatch.clear();
});

export function useUserProfile(userId: string | null | undefined): UserProfile {
  const uid = userId ?? "";
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = profileListeners.get(uid);
      if (!set) profileListeners.set(uid, (set = new Set()));
      set.add(cb);
      fetchProfile(uid);
      watchUser(uid);
      return () => {
        set!.delete(cb);
        if (set!.size === 0) {
          profileListeners.delete(uid);
          userWatch.get(uid)?.();
          userWatch.delete(uid);
        }
      };
    },
    [uid],
  );
  const get = useCallback(() => profiles.get(uid)?.value ?? NO_PROFILE, [uid]);
  return useSyncExternalStore(subscribe, get, get);
}

// ---- timeline (low level) --------------------------------------------------------------------

export interface TimelineState {
  /** The live timeline + every timeline linked behind it (timeline.ts), oldest → newest (+ pending local echoes at the end). */
  events: MatrixEvent[];
  /** More history exists on the server. */
  canPaginateBack: boolean;
  /** A back-pagination request is running. */
  loadingBack: boolean;
  /** Load `limit` older events (no-op while loading / at the start). Resolves true if more remain. */
  paginateBack: (limit?: number) => Promise<boolean>;
  /** Bumps on every change (decryption, edits, redactions, local-echo status…). */
  version: number;
}

/**
 * LOW-LEVEL live timeline for one room: the chat feature builds grouping, read markers, edits
 * and jump-to-event on top of it. Re-renders on new/decrypted/redacted/replaced events and local
 * echo status changes in THIS room only (coalesced per animation-free microtask).
 */
export function useTimeline(roomId: string | null | undefined): TimelineState {
  const [, force] = useState(0);
  const st = useRef({ version: 0, loadingBack: false, events: [] as MatrixEvent[], canBack: true, roomId: undefined as string | null | undefined });
  const client = peekClient();

  const snapshot = useCallback(() => {
    const room = roomId ? peekClient()?.getRoom(roomId) : null;
    if (!room) {
      st.current.events = [];
      st.current.canBack = false;
      return;
    }
    // the live timeline + every timeline linked behind it (a gappy sync splits the history — timeline.ts)
    const chain = liveTimelineChain(room);
    const pending = room.getPendingEvents();
    st.current.events = pending.length ? [...chain.events, ...pending] : [...chain.events];
    st.current.canBack = chain.canBack;
  }, [roomId]);

  // Switching rooms: show the new room's events on this very render, not one effect later.
  if (st.current.roomId !== roomId) {
    st.current.roomId = roomId;
    st.current.loadingBack = false;
    snapshot();
  }

  useEffect(() => {
    const c = peekClient();
    if (!c || !roomId) return;
    let scheduled = false;
    const bump = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        snapshot();
        st.current.version++;
        force((n) => n + 1);
      });
    };
    const onTimeline = (_ev: MatrixEvent, room: Room | undefined) => {
      if (room?.roomId === roomId) bump();
    };
    const onEventRoom = (ev: MatrixEvent) => {
      if (ev.getRoomId() === roomId) bump();
    };
    const onRoom = (r: Room | undefined) => {
      if (r?.roomId === roomId) bump();
    };
    const onLocalEcho = (_ev: MatrixEvent, room: Room) => {
      if (room?.roomId === roomId) bump();
    };
    c.on(RoomEvent.Timeline, onTimeline);
    c.on(RoomEvent.TimelineReset, onRoom);
    c.on(RoomEvent.Redaction, onTimeline);
    c.on(RoomEvent.LocalEchoUpdated, onLocalEcho);
    c.on(MatrixEventEvent.Decrypted, onEventRoom);
    c.on(MatrixEventEvent.Replaced, onEventRoom);
    c.on(ClientEvent.Room, onRoom);
    snapshot();
    force((n) => n + 1);
    return () => {
      c.off(RoomEvent.Timeline, onTimeline);
      c.off(RoomEvent.TimelineReset, onRoom);
      c.off(RoomEvent.Redaction, onTimeline);
      c.off(RoomEvent.LocalEchoUpdated, onLocalEcho);
      c.off(MatrixEventEvent.Decrypted, onEventRoom);
      c.off(MatrixEventEvent.Replaced, onEventRoom);
      c.off(ClientEvent.Room, onRoom);
    };
  }, [client, roomId, snapshot]);

  const paginateBack = useCallback(
    async (limit = 30): Promise<boolean> => {
      const c = peekClient();
      const room = roomId ? c?.getRoom(roomId) : null;
      if (!c || !room || st.current.loadingBack) return st.current.canBack;
      st.current.loadingBack = true;
      force((n) => n + 1);
      try {
        await paginateChainBack(c, room, limit);
        return liveTimelineChain(room).canBack;
      } catch {
        return st.current.canBack;
      } finally {
        st.current.loadingBack = false;
        snapshot();
        st.current.version++;
        force((n) => n + 1);
      }
    },
    [roomId, snapshot],
  );

  return {
    events: st.current.events,
    canPaginateBack: st.current.canBack,
    loadingBack: st.current.loadingBack,
    paginateBack,
    version: st.current.version,
  };
}

/** True if an event is a local echo that failed to send. */
export function isSendFailed(ev: MatrixEvent): boolean {
  return ev.status === EventStatus.NOT_SENT;
}
