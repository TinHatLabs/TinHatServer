// state.ts — Tin Hat custom room-STATE helpers (port of native appstate.rs + the RBAC
// "managed types" rule from roles_model.rs / roles.rs container_of).
//
//   getState(roomId, type, key?)        content | undefined   (local store, no network)
//   getStateAll(roomId, type)           [{stateKey, sender, content}]
//   sendState(roomId, type, key, content)
//   ensureWritable(roomId, types)       best-effort: lower events[type] to 0 (admins only)
//   provisionRoom(roomId) / provisionNewRoom(roomId)
//   containerOf(roomId)                 the space that holds the roles (or the room itself)
//   rolesActive(containerId)            the container has the `everyone` role
//   sendMessage / sendEvent             thin wrappers
//   inviteWithoutHistory(roomId, user)  an invite that does NOT hand over the room's history keys (the recorder)
//
// Wire truth: event type strings and JSON shapes are exactly the native ones — the desktop app
// reads what the web writes and vice versa.
import { EventType, Method, type IContent, type MatrixClient, type Room } from "matrix-js-sdk";
import { getClient, peekClient } from "./client";
import { createLogger } from "@/core/log";

const log = createLogger("appstate");

type Content = Record<string, unknown>;

// ---- event type constants (native names) -----------------------------------------------------

export const ROLE_TYPE = "dev.tinhat.role";
export const MEMBER_ROLES_TYPE = "dev.tinhat.member_roles";
export const CALL_MOD_TYPE = "dev.tinhat.call.moderation";
export const EVERYONE_ROLE = "everyone";

/** Call-recording marker: `{active: true, by}` while recording; empty content = off. */
export const RECORD_TYPE = "dev.tinhat.record";
/** Clip bookmark: state_key = epoch-ms stamp, content `{at: ms}`. */
export const CLIP_TYPE = "dev.tinhat.clip";
/** Room opt-out for join sounds: `{enabled: false}` (absent = enabled). */
export const JOINSOUNDS_ROOM_TYPE = "dev.tinhat.joinsounds";
/** Extended-profile key holding the user's join sound url. */
export const JOINSOUND_PROFILE_KEY = "dev.tinhat.joinsound";

/**
 * Every custom room-STATE type a standard (PL 0) member must be able to send (appstate.rs
 * TINHAT_MEMBER_STATE_EVENTS). Keep in sync with the native list.
 */
export const TINHAT_MEMBER_STATE_EVENTS: readonly string[] = [
  "dev.tinhat.afk",
  "dev.tinhat.userstatus",
  "dev.tinhat.activity",
  "dev.tinhat.watchparty",
  "dev.tinhat.watchparty.playback",
  "dev.tinhat.watchparty.viewer",
  "dev.tinhat.mediaparty.history", // Media Party 11.4: the room's last 50 plays (CONTRACT §2), written by the advancer
  "dev.tinhat.soundboard",
  "dev.tinhat.clip",
  "dev.tinhat.record",
  "dev.tinhat.calendar.event",
  "dev.tinhat.calendar.rsvp",
  "dev.tinhat.calendar.game",
  "dev.tinhat.games.prefs",
  "dev.tinhat.games.spin",
  // widgets W1: the space's Sticky note — the friend group's (with roles active the reconciler owns it: edit_space_note)
  "dev.tinhat.note",
  "org.matrix.msc3401.call.member",
  "m.call.member",
];

/**
 * Types whose `events[<type>]` power level the RBAC reconciler owns once a space has roles
 * (roles_model.rs MANAGED_EVENT_TYPES) — ensureWritable must never lower these then.
 */
export const MANAGED_EVENT_TYPES: readonly string[] = [
  "m.room.name",
  "m.room.topic",
  "m.room.avatar",
  "m.room.join_rules",
  "m.room.canonical_alias",
  "m.room.power_levels",
  ROLE_TYPE,
  MEMBER_ROLES_TYPE,
  "m.space.child",
  "m.space.parent",
  "m.room.pinned_events",
  CALL_MOD_TYPE,
  "dev.tinhat.soundboard",
  "dev.tinhat.record",
  "dev.tinhat.games.settings",
  "dev.tinhat.games.adjust",
  "dev.tinhat.note",
];

// ---- reads (local store) ---------------------------------------------------------------------

function room(roomId: string, client: MatrixClient | null = peekClient()): Room | null {
  return client?.getRoom(roomId) ?? null;
}

/** Content of one state event, or undefined. An empty `{}` ("cleared") is returned as-is. */
export function getState<T extends Content = Content>(roomId: string, type: string, stateKey = ""): T | undefined {
  const ev = room(roomId)?.currentState.getStateEvents(type, stateKey);
  return ev ? (ev.getContent() as T) : undefined;
}

export interface StateTriple<T extends Content = Content> {
  stateKey: string;
  sender: string;
  content: T;
}

/** All state events of a type as (state_key, sender, content). */
export function getStateAll<T extends Content = Content>(roomId: string, type: string): StateTriple<T>[] {
  const evs = room(roomId)?.currentState.getStateEvents(type) ?? [];
  return evs.map((ev) => ({ stateKey: ev.getStateKey() ?? "", sender: ev.getSender() ?? "", content: ev.getContent() as T }));
}

/** May the signed-in user send this state type here (by the room's power levels)? */
export function canSendState(roomId: string, type: string): boolean {
  const c = peekClient();
  const r = room(roomId, c);
  const me = c?.getUserId();
  if (!r || !me) return false;
  return r.currentState.maySendStateEvent(type, me);
}

// ---- writes ----------------------------------------------------------------------------------

/** Write a raw custom state event. Resolves with the event id. */
export async function sendState(roomId: string, type: string, stateKey: string, content: Content): Promise<string> {
  const res = await getClient().sendStateEvent(roomId, type as never, content as never, stateKey);
  return res.event_id;
}

/** Send a room message (m.room.message). */
export async function sendMessage(roomId: string, content: IContent): Promise<string> {
  const res = await getClient().sendMessage(roomId, content as never);
  return res.event_id;
}

/**
 * Invite WITHOUT the room's history (2026-10-23, rooms are encrypted by default): js-sdk's client.invite() hands every
 * invitee the keys to the room's earlier messages (MSC4268 — what a person you invite should get). An account that
 * only records calls (the Memories recorder) must not get them: a plain /invite. The desktop's room.rs does the same.
 */
export async function inviteWithoutHistory(roomId: string, userId: string): Promise<void> {
  await getClient().http.authedRequest(Method.Post, `/rooms/${encodeURIComponent(roomId)}/invite`, undefined, { user_id: userId });
}

/** Send any timeline event type (reactions, custom events, …). Encrypted rooms encrypt it. */
export async function sendEvent(roomId: string, type: string, content: IContent): Promise<string> {
  const res = await getClient().sendEvent(roomId, type as never, content as never);
  return res.event_id;
}

// ---- RBAC container (roles.rs) ---------------------------------------------------------------

/**
 * The room that holds the roles for `roomId`: its parent space (m.space.parent with a non-empty
 * `via`, canonical first, that we have JOINED), or the room itself. A space is its own container.
 */
export function containerOf(roomId: string): string {
  const c = peekClient();
  const r = room(roomId, c);
  if (!r || !c) return roomId;
  if (r.isSpaceRoom()) return roomId;
  const parents: Array<{ canonical: boolean; id: string }> = [];
  for (const ev of r.currentState.getStateEvents(EventType.SpaceParent)) {
    const content = ev.getContent() as { via?: unknown; canonical?: unknown };
    const pid = ev.getStateKey() ?? "";
    if (!pid || !Array.isArray(content.via) || content.via.length === 0) continue;
    parents.push({ canonical: content.canonical === true, id: pid });
  }
  // Stable sort, canonical first (keeps the store's order among equals).
  parents.sort((a, b) => Number(b.canonical) - Number(a.canonical));
  for (const p of parents) {
    if (c.getRoom(p.id)?.getMyMembership() === "join") return p.id;
  }
  return roomId;
}

/** Roles are active in a container iff the `everyone` role exists (non-empty object content). */
export function rolesActive(containerId: string): boolean {
  const content = getState(containerId, ROLE_TYPE, EVERYONE_ROLE);
  return !!content && typeof content === "object" && Object.keys(content).length > 0;
}

// ---- ensure_writable / provisioning ----------------------------------------------------------

/**
 * Best-effort: lower the required power level of each custom type to 0 so any member can use it.
 * Only someone who may edit m.room.power_levels does anything; everyone else returns silently
 * (the live rooms are provisioned already). Managed types are skipped when the room's container
 * has roles active — the RBAC reconciler owns them (docs/RBAC.md §4).
 */
export async function ensureWritable(roomId: string, eventTypes: readonly string[]): Promise<void> {
  let types = [...eventTypes];
  if (types.some((t) => MANAGED_EVENT_TYPES.includes(t)) && rolesActive(containerOf(roomId))) {
    types = types.filter((t) => !MANAGED_EVENT_TYPES.includes(t));
  }
  if (types.length === 0) return;
  const pl = getState(roomId, EventType.RoomPowerLevels, "");
  if (!pl) return;
  const events = (pl.events && typeof pl.events === "object" ? pl.events : {}) as Record<string, unknown>;
  if (types.every((t) => events[t] === 0)) return;
  if (!canSendState(roomId, EventType.RoomPowerLevels)) return;
  const next: Content = { ...pl, events: { ...events } };
  for (const t of types) (next.events as Record<string, unknown>)[t] = 0;
  try {
    await sendState(roomId, EventType.RoomPowerLevels, "", next);
  } catch (e) {
    log.debug(`ensureWritable ${roomId}: ${(e as Error)?.message ?? e}`);
  }
}

/** Admin-only, idempotent: make every Tin Hat member-state type sendable by PL-0 members. */
export function provisionRoom(roomId: string): Promise<void> {
  return ensureWritable(roomId, TINHAT_MEMBER_STATE_EVENTS);
}

/**
 * Provision a room we JUST created: wait (≤ 10 s) for its power levels to arrive through the
 * one sync loop, then provision (native provision_new_room — never a second sync).
 */
export async function provisionNewRoom(roomId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (getState(roomId, EventType.RoomPowerLevels, "")) {
      await provisionRoom(roomId);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log.warn(`${roomId} never synced power levels; members may lack call permission`);
}

/** Some(content) while recording is enabled for this room. */
export function recordEnabled(roomId: string): Content | undefined {
  const v = getState(roomId, RECORD_TYPE, "");
  return v && v.active === true ? v : undefined;
}

/** Epoch milliseconds (the `ts` / `expiresAt` fields the native writes). */
export const nowMs = (): number => Date.now();
