// state.ts — Tin Hat custom room-STATE helpers (port of native appstate.rs + the RBAC
// "managed types" rule from roles_model.rs / roles.rs container_of).
//
//   getState(roomId, type, key?)        content | undefined   (local store, no network)
//   getStateAll(roomId, type)           [{stateKey, sender, content}]
//   sendState(roomId, type, key, content)
//   ensureWritable(roomId, types)       best-effort: lower events[type] to 0 (admins only; my own server's rooms only,
//                                       each type once per room per session; foreign.ts plWritePlan decides)
//   provisionOnOpen(roomId)             room open: provisionRoom once per room per session (own server's rooms only)
//   provisionRoom(roomId) / provisionNewRoom(roomId)
//   containerOf(roomId)                 the space that holds the roles (or the room itself)
//   rolesActive(containerId)            the container has the `everyone` role
//   sendMessage / sendEvent             thin wrappers
//   inviteWithoutHistory(roomId, user)  an invite that does NOT hand over the room's history keys (the recorder)
//
// Wire truth: event type strings and JSON shapes are exactly the native ones — the desktop app
// reads what the web writes and vice versa.
import { EventType, Method, type IContent, type MatrixClient, type Room } from "matrix-js-sdk";
import { getClient, getClientEpoch, peekClient } from "./client";
import { managedHere, originHere } from "./foreignHere";
import { plWritePlan, serverPart } from "./foreign";
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

/** Call membership, both spellings (appstate.rs CALL_MEMBER_STATE_EVENTS): what joining a call asks ensureWritable for. */
export const CALL_MEMBER_STATE_EVENTS: readonly string[] = ["org.matrix.msc3401.call.member", "m.call.member"];

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

/** `${epoch}|${me}/${device}|${roomId}` → the types already lowered this session: the "one-time" of the must-fix round. */
const writableDone = new Map<string, Set<string>>();
/** Rooms on another server already logged as left alone (one line per room per session). */
const foreignNoted = new Set<string>();
/** Rooms provisioned on open this session (once per room). */
const openedOnce = new Set<string>();
/** One local power-level write per room at a time (ensureWritable, the roles reconciler, a moderator's change): each
 *  waits for the one before it and reads the state inside the queue (no lost update). */
const plChain = new Map<string, Promise<unknown>>();

function sessionKey(roomId: string): string {
  const c = peekClient();
  return `${getClientEpoch()}|${c?.getUserId() ?? ""}/${c?.getDeviceId() ?? ""}|${roomId}`;
}

function createOf(roomId: string): { sender: unknown; content: unknown } | null {
  const ev = room(roomId)?.currentState.getStateEvents(EventType.RoomCreate, "");
  return ev ? { sender: ev.getSender(), content: ev.getContent() } : null;
}

/** Run `fn` in the room's power-level queue (every local m.room.power_levels writer goes through this). */
export function withPowerLevelLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const epoch = getClientEpoch();
  const run = (plChain.get(roomId) ?? Promise.resolve()).then(() => {
    if (epoch !== getClientEpoch()) throw new Error("session ended"); // queued for a session that is gone
    return fn();
  });
  const tail = run.catch(() => undefined);
  plChain.set(roomId, tail);
  void tail.then(() => {
    if (plChain.get(roomId) === tail) plChain.delete(roomId);
  });
  return run;
}

/** Per room: the id of our latest power-level write and how long we wait for it. Until the store shows that event
 *  (or the wait runs out), the store may be missing it. Set only after the server accepted the write. */
const pendingEcho = new Map<string, { id: string; until: number }>();
const ECHO_WAIT_MS = 10_000;

function plEventId(roomId: string): string {
  return room(roomId)?.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getId() ?? "";
}

/**
 * Write m.room.power_levels (inside the room's queue) and wait ≤ 10 s until the store shows this very event, so the
 * next writer in the queue reads it rather than the state before it. A rejected write marks nothing. Every local
 * power-level writer uses this.
 */
export async function sendPowerLevels(roomId: string, content: Record<string, unknown>): Promise<void> {
  const id = await sendState(roomId, EventType.RoomPowerLevels, "", content);
  const until = Date.now() + ECHO_WAIT_MS;
  pendingEcho.set(roomId, { id, until });
  while (plEventId(roomId) !== id && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  if (plEventId(roomId) === id) pendingEcho.delete(roomId);
}

/**
 * The room's power levels as the next write must start from: the store's — or undefined while our latest write isn't
 * in it yet (writing now could undo it; the caller skips this time). After the wait runs out the store is trusted.
 */
export function powerLevelsForWrite(roomId: string): Record<string, unknown> | undefined {
  const ev = room(roomId)?.currentState.getStateEvents(EventType.RoomPowerLevels, "");
  const p = pendingEcho.get(roomId);
  if (p) {
    if ((ev?.getId() ?? "") !== p.id && Date.now() < p.until) return undefined;
    pendingEcho.delete(roomId);
  }
  return ev ? (ev.getContent() as Record<string, unknown>) : undefined;
}

/**
 * Best-effort: lower the required power level of each Tin Hat type to 0 so any member can use it — the one write
 * `plWritePlan` (foreign.ts, shared vectors) allows. Called when a Tin Hat feature is used, on joining a call, on room
 * open (provisionOnOpen) and for a room we just made. The must-fix round (MATRIX-FRONTEND-DESIGN.md B0/B5 rule 1):
 *  - a room on another server is never written (its power levels stay as its owners set them; the feature works only
 *    as far as they allow) — logged once per room;
 *  - only dev.tinhat.* types and call membership, only while above 0, only when I may edit power levels;
 *  - each type lowered once per room per session, logged (a refusal isn't remembered: the next use asks again);
 *  - one write per room at a time, in the queue every local power-level writer shares, each waiting for its own echo
 *    (sendPowerLevels), so none starts from state an earlier one replaced.
 * Managed types are skipped when the room's container has roles active — the RBAC reconciler owns them (docs/RBAC.md §4).
 */
export function ensureWritable(roomId: string, eventTypes: readonly string[]): Promise<void> {
  if (!managedHere(roomId)) {
    if (!foreignNoted.has(roomId)) {
      foreignNoted.add(roomId);
      log.info(`power levels left alone in ${roomId}: it lives on ${originHere(roomId)}`);
    }
    return Promise.resolve();
  }
  return withPowerLevelLock(roomId, () => writeOnce(roomId, eventTypes));
}

async function writeOnce(roomId: string, eventTypes: readonly string[]): Promise<void> {
  let types = [...eventTypes];
  if (types.some((t) => MANAGED_EVENT_TYPES.includes(t)) && rolesActive(containerOf(roomId))) {
    types = types.filter((t) => !MANAGED_EVENT_TYPES.includes(t));
  }
  const c = peekClient();
  const key = sessionKey(roomId);
  const done = writableDone.get(key) ?? new Set<string>();
  const plan = plWritePlan({
    create: createOf(roomId),
    own: serverPart(c?.getUserId()),
    pl: powerLevelsForWrite(roomId) ?? null,
    types,
    canEdit: canSendState(roomId, EventType.RoomPowerLevels),
    done: [...done],
  });
  if (plan.reason !== "write" || !plan.content) return;
  log.info(`power levels: letting members send ${plan.types.join(", ")} in ${roomId}`);
  try {
    await sendPowerLevels(roomId, plan.content);
    for (const t of plan.types) done.add(t);
    writableDone.set(key, done);
  } catch (e) {
    log.debug(`ensureWritable ${roomId}: ${(e as Error)?.message ?? e}`);
  }
}

/** Admin-only, idempotent: make every Tin Hat member-state type sendable by PL-0 members. */
export function provisionRoom(roomId: string): Promise<void> {
  return ensureWritable(roomId, TINHAT_MEMBER_STATE_EVENTS);
}

/**
 * Room open (ConversationView; the desktop's room.rs): provision once per room per session — my own server's rooms
 * only (ensureWritable never writes a room on another server). What keeps PL-0 members able to call / use the extras
 * in a room an admin opens, including types added in a later release.
 */
export function provisionOnOpen(roomId: string): void {
  if (openedOnce.has(sessionKey(roomId))) return;
  openedOnce.add(sessionKey(roomId));
  void provisionRoom(roomId).catch(() => undefined);
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
