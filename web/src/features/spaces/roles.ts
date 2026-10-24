// roles.ts — the RBAC read side over the live client (port of native roles.rs): container lookup,
// the roles of a container, effective permissions in BOTH modes (roles when the container has the
// `everyone` role, else the room's own power levels), member badges and space tags.
//
// Hooks re-render only when their value changes (useDerived from @/core/matrix):
//   useContainer(roomId)            the space that holds the roles (or the room itself)
//   useRolesState(containerId)      RolesState (model.ts) of that container
//   useEffectivePerms(roomId, mxid?) {rank, perms, rolesActive, container}
//   useRoleTags(roomId)             Map<mxid, {name, color}> — highest CUSTOM role per member
//   useMemberRole(roomId, mxid)     RoleTag | null (the contract chat / nav / callui call)
// Plain functions (no React): containerOf, loadRolesState, effectivePerms, powerLevelOf,
// roleBadgeFor, tagFor.
import { useMemo } from "react";
import { ClientEvent, EventType, RoomEvent, RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { peekClient, useDerived, usePowerLevels } from "@/core/matrix";
import {
  EVERYONE,
  MEMBER_ROLES_TYPE,
  ROLE_TYPE,
  RolesState,
  permsFromPowerLevels,
  permsJson,
  plLabel,
  roleBadgeFrom,
  tagBadgeFrom,
  isObject,
} from "./model";

// ---- container -----------------------------------------------------------------------------------

/**
 * roles.rs container_of: a space is its own container; else the canonical-first m.space.parent
 * (non-empty `via`, non-empty key) that we have JOINED; else the room itself.
 */
export function containerOf(roomId: string, client: MatrixClient | null = peekClient()): string {
  const room = client?.getRoom(roomId);
  if (!room || !client) return roomId;
  if (room.isSpaceRoom()) return roomId;
  const parents: Array<{ canonical: boolean; id: string }> = [];
  for (const ev of room.currentState.getStateEvents(EventType.SpaceParent)) {
    const c = ev.getContent() as { via?: unknown; canonical?: unknown };
    const pid = ev.getStateKey() ?? "";
    if (!pid || !Array.isArray(c.via) || c.via.length === 0) continue;
    parents.push({ canonical: c.canonical === true, id: pid });
  }
  parents.sort((a, b) => Number(b.canonical) - Number(a.canonical)); // stable
  for (const p of parents) if (client.getRoom(p.id)?.getMyMembership() === "join") return p.id;
  return roomId;
}

function attachContainer(roomId: string, c: MatrixClient, changed: () => void) {
  const onState = (ev: MatrixEvent) => {
    if (ev.getRoomId() === roomId && (ev.getType() === EventType.SpaceParent || ev.getType() === EventType.RoomCreate)) changed();
  };
  c.on(RoomStateEvent.Events, onState);
  c.on(RoomEvent.MyMembership, changed);
  c.on(ClientEvent.Room, changed);
  return () => {
    c.off(RoomStateEvent.Events, onState);
    c.off(RoomEvent.MyMembership, changed);
    c.off(ClientEvent.Room, changed);
  };
}

export function useContainer(roomId: string | null | undefined): string {
  return useDerived(`spaces:container:${roomId ?? ""}`, () => ({
    attach: (c, changed) => attachContainer(roomId ?? "", c, changed),
    compute: (c) => (roomId ? containerOf(roomId, c) : ""),
  }));
}

// ---- roles state ----------------------------------------------------------------------------------

const EMPTY_STATE = new RolesState();

/** The roles of a container from the local store (roles.rs load_state). */
export function loadRolesState(containerId: string, client: MatrixClient | null = peekClient()): RolesState {
  const room = containerId ? client?.getRoom(containerId) : null;
  if (!room) return EMPTY_STATE;
  const roles = room.currentState.getStateEvents(ROLE_TYPE).map((e) => [e.getStateKey() ?? "", e.getContent()] as const);
  const members = room.currentState.getStateEvents(MEMBER_ROLES_TYPE).map((e) => [e.getStateKey() ?? "", e.getContent()] as const);
  if (roles.length === 0 && members.length === 0) return EMPTY_STATE;
  return RolesState.fromState(roles, members);
}

export function useRolesState(containerId: string | null | undefined): RolesState {
  return useDerived(`spaces:roles:${containerId ?? ""}`, () => ({
    attach: (c, changed) => {
      const f = (ev: MatrixEvent) => {
        if (ev.getRoomId() === containerId && (ev.getType() === ROLE_TYPE || ev.getType() === MEMBER_ROLES_TYPE)) changed();
      };
      const onRoom = (r: Room) => {
        if (r.roomId === containerId) changed();
      };
      c.on(RoomStateEvent.Events, f);
      c.on(ClientEvent.Room, onRoom);
      return () => {
        c.off(RoomStateEvent.Events, f);
        c.off(ClientEvent.Room, onRoom);
      };
    },
    compute: (c) => (containerId ? loadRolesState(containerId, c) : EMPTY_STATE),
    equal: (a, b) => a === b || a.signature() === b.signature(),
  }));
}

// ---- power levels ---------------------------------------------------------------------------------

/** A member's power level in `room` as a plain number (room creators' "infinite" = 100). */
export function powerLevelOf(room: Room | null | undefined, mxid: string): number {
  if (!room) return 0;
  const m = room.getMember(mxid);
  if (m) return m.powerLevel === Infinity ? 100 : m.powerLevel;
  // not a (loaded) member: read the content, hydra creators first
  const create = room.currentState.getStateEvents(EventType.RoomCreate, "");
  const version = String((create?.getContent() as { room_version?: unknown })?.room_version ?? "1");
  if (create && /^\d+$/.test(version) && Number(version) >= 12) {
    const extra = (create.getContent() as { additional_creators?: unknown }).additional_creators;
    if (create.getSender() === mxid || (Array.isArray(extra) && extra.includes(mxid))) return 100;
  }
  const pl = room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() as Record<string, unknown> | undefined;
  const users = pl && isObject(pl.users) ? pl.users : {};
  const v = users[mxid];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  const d = pl?.users_default;
  return typeof d === "number" && Number.isInteger(d) ? d : 0;
}

// ---- effective permissions ---------------------------------------------------------------------------

export interface Perms {
  rank: number;
  /** every catalogue key → granted */
  perms: Record<string, boolean>;
  rolesActive: boolean;
  container: string;
}

/** roles.rs effective_perms_with: the container's roles when active, else this room's power levels. */
export function effectivePermsWith(room: Room | null, mxid: string, st: RolesState, container: string): Perms {
  if (st.active()) return { rank: st.rankOf(mxid), perms: permsJson(st.permsOf(mxid)), rolesActive: true, container };
  const level = powerLevelOf(room, mxid);
  const pl = room?.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
  return { rank: level, perms: permsJson(permsFromPowerLevels(level, pl)), rolesActive: false, container };
}

/** What `mxid` (default: me) may do in `roomId`. */
export function effectivePerms(roomId: string, mxid?: string, client: MatrixClient | null = peekClient()): Perms {
  const me = mxid ?? client?.getUserId() ?? "";
  const room = client?.getRoom(roomId) ?? null;
  if (!room || !me) return { rank: 0, perms: permsJson([]), rolesActive: false, container: roomId };
  const container = containerOf(roomId, client);
  return effectivePermsWith(room, me, loadRolesState(container, client), container);
}

/** React: effective permissions of `mxid` (default: me) in `roomId`, live. */
export function useEffectivePerms(roomId: string | null | undefined, mxid?: string | null): Perms {
  const container = useContainer(roomId);
  const st = useRolesState(container);
  const pl = usePowerLevels(roomId);
  const client = peekClient();
  const me = mxid || client?.getUserId() || "";
  return useMemo(() => {
    const room = roomId ? (client?.getRoom(roomId) ?? null) : null;
    if (!roomId || !room || !me) return { rank: 0, perms: permsJson([]), rolesActive: false, container: roomId ?? "" };
    return effectivePermsWith(room, me, st, container);
    // pl: the room's power levels changed → recompute (the member PLs derive from it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, me, st, container, pl, client]);
}

// ---- badges / tags ------------------------------------------------------------------------------------

export interface TagInfo {
  roleId: string;
  name: string;
  color: string;
}

/** 10.4 space tag of `mxid` in `roomId` (highest custom role of the container), or null. */
export function tagFor(roomId: string, mxid: string, client: MatrixClient | null = peekClient()): TagInfo | null {
  const st = loadRolesState(containerOf(roomId, client), client);
  if (!st.active()) return null;
  const r = st.tagRoleOf(mxid);
  return r ? { roleId: r.id, name: r.name, color: r.color } : null;
}

/** role_badge_for: the top assigned role (roles active), else the PL word (Admin | Mod | Member), colour "". */
export function roleBadgeFor(roomId: string, mxid: string, power: number, client: MatrixClient | null = peekClient()): { name: string; color: string } {
  const st = loadRolesState(containerOf(roomId, client), client);
  const [name, color] = roleBadgeFrom(st, mxid, power);
  return { name, color };
}

/** Every member's space tag in `roomId`: Map<mxid, {roleId,name,color}> (only members that have one). */
export function useRoleTags(roomId: string | null | undefined): Map<string, TagInfo> {
  const container = useContainer(roomId);
  const st = useRolesState(container);
  return useMemo(() => {
    const out = new Map<string, TagInfo>();
    if (!st.active()) return out;
    for (const mxid of st.members.keys()) {
      const r = st.tagRoleOf(mxid);
      if (r) out.set(mxid, { roleId: r.id, name: r.name, color: r.color });
    }
    return out;
  }, [st]);
}

/** Role contract (index.tsx): the tag that decides how `userId` is shown in `roomId`. */
export interface RoleTag {
  roleId: string;
  /** role display name, e.g. "Streamer" */
  name: string;
  /** CSS colour for the member's name (custom-role colour), "" = default */
  color: string;
  /** short space tag shown after the name (10.4 space tags) */
  tag?: string;
}

export function useMemberRoleImpl(roomId: string | null | undefined, userId: string | null | undefined): RoleTag | null {
  const container = useContainer(roomId);
  const st = useRolesState(container);
  return useMemo(() => {
    if (!userId || !st.active()) return null;
    const r = st.tagRoleOf(userId);
    return r ? { roleId: r.id, name: r.name, color: r.color, tag: r.name } : null;
  }, [st, userId]);
}

export { EVERYONE, tagBadgeFrom, roleBadgeFrom, plLabel };
