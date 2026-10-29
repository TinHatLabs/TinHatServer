// store.ts — web port of the native SpaceController (space.rs): ONE open space at a time, its four
// models (summary / members / roles / rooms), the invite picker's directory search, and every
// action of the Space settings window (settings, invites, kick/ban/unban cascade, role editing and
// assignment, "Set up roles", the power-level reconciler, leave).
//
// Shape of every action (run_action): clear lastError, busy++, check the permission locally (a
// human sentence), do the call, wait for the local store to show the write (settle, ≤ 4 s), then
// status (+ toast 4 s) or lastError (+ toast 6 s), then refresh(). statusRev / errorRev bump on
// every set so repeats of the same text still show. The web also refreshes live (debounced 250 ms)
// when a relevant state event arrives for the open space or one of its children.
import { create } from "zustand";
import { EventType, RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { ensureMembersLoaded, peekClient, uploadFile } from "@/core/matrix";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import {
  EVERYONE,
  MEMBER_ROLES_TYPE,
  ROLE_TYPE,
  RolesState,
  defaultTemplate,
  derivePowerLevels,
  isKnownPermission,
  jsonEqual,
  lockoutError,
  migrateFromPowerLevels,
  newRoleId,
  permissionLabel,
  plural,
  reconcileTail,
  roleToContent,
  stateKeyFor,
  cmpStr,
  type Role,
} from "./model";
import { effectivePermsWith, loadRolesState, powerLevelOf, type Perms } from "./roles";
import { rl } from "./ratelimit";
import { isRoomId } from "@/app/router";
import { shareLinkNow } from "@/core/server";
import { goneText } from "./leftWords";

const log = createLogger("spaces");

// ---- model shapes (the native JSON models) ---------------------------------------------------------

export interface RoleRef {
  id: string;
  name: string;
  color: string;
}

export interface MemberRow {
  mxid: string;
  name: string;
  avatar: string | null;
  membership: "join" | "invite" | "ban";
  rank: number;
  power: number;
  roles: string[];
  topRole: RoleRef | null;
  tag: RoleRef | null;
  isMe: boolean;
  canKick: boolean;
  canBan: boolean;
  canEditRoles: boolean;
  reason: string;
}

export interface RoleRow {
  id: string;
  name: string;
  color: string;
  rank: number;
  hoist: boolean;
  permissions: string[];
  memberCount: number;
  editable: boolean;
  deletable: boolean;
  isEveryone: boolean;
}

export interface RoomRow {
  id: string;
  name: string;
  avatar: string | null;
  joined: boolean;
  synced: boolean;
  canSync: boolean;
}

export interface Summary {
  id: string;
  name: string;
  topic: string;
  avatar: string | null;
  alias: string;
  link: string;
  joinRule: "public" | "invite" | "restricted" | "knock";
  memberCount: number;
  invitedCount: number;
  bannedCount: number;
  roomCount: number;
  encrypted: boolean;
  membership: string;
  isMember: boolean;
  canManageSpace: boolean;
  canManageRoles: boolean;
  canManageRooms: boolean;
  canInvite: boolean;
  canKick: boolean;
  canBan: boolean;
  outOfSyncRooms: number;
}

export interface UserHit {
  mxid: string;
  name: string;
  avatar: string | null;
  alreadyMember: boolean;
}

interface Snapshot {
  summary: Summary;
  members: MemberRow[];
  roles: RoleRow[];
  myPerms: Record<string, boolean>;
  rooms: RoomRow[];
  rolesActive: boolean;
  myRank: number;
}

export interface SpaceAdminState {
  spaceId: string;
  busy: boolean;
  inflight: number;
  rev: number;
  /** null until the first snapshot for the open space */
  summary: Summary | null;
  members: MemberRow[];
  roles: RoleRow[];
  myPerms: Record<string, boolean>;
  rooms: RoomRow[];
  rolesActive: boolean;
  myRank: number;
  userSearch: UserHit[];
  userSearchQuery: string;
  status: string;
  statusRev: number;
  lastError: string;
  errorRev: number;
}

const INITIAL: SpaceAdminState = {
  spaceId: "",
  busy: false,
  inflight: 0,
  rev: 0,
  summary: null,
  members: [],
  roles: [],
  myPerms: {},
  rooms: [],
  rolesActive: false,
  myRank: 0,
  userSearch: [],
  userSearchQuery: "",
  status: "",
  statusRev: 0,
  lastError: "",
  errorRev: 0,
};

export const useSpaceAdmin = create<SpaceAdminState>()(() => ({ ...INITIAL }));
const set = useSpaceAdmin.setState;
const get = useSpaceAdmin.getState;

function begin() {
  const n = get().inflight + 1;
  set({ inflight: n, busy: true });
}
function end() {
  const n = Math.max(0, get().inflight - 1);
  set({ inflight: n, busy: n > 0 });
}
function setStatusText(msg: string) {
  set((s) => ({ status: msg, statusRev: s.statusRev + 1 }));
  toast(msg, { kind: "success", timeoutMs: 4000 });
}
function setErrorText(msg: string) {
  log.warn(msg);
  set((s) => ({ lastError: msg, errorRev: s.errorRev + 1 }));
  toast(msg, { kind: "error", timeoutMs: 6000 });
}

// ---- helpers over the client -------------------------------------------------------------------------

const errText = (e: unknown) => {
  const m = (e as { data?: { error?: string }; message?: string })?.data?.error ?? (e as Error)?.message ?? String(e);
  return m;
};

function localpart(mxid: string): string {
  const i = mxid.indexOf(":");
  return (i > 0 ? mxid.slice(1, i) : mxid.replace(/^@/, "")) || mxid;
}

/** matrix-sdk RoomMember::name(): the display name, else the localpart. */
function memberName(room: Room, mxid: string): string {
  const m = room.getMember(mxid);
  const dn = (m?.events.member?.getContent() as { displayname?: unknown } | undefined)?.displayname;
  if (typeof dn === "string" && dn.trim()) return dn;
  return localpart(mxid);
}

/** Every m.space.child with a non-empty `via`, sorted by id (child_ids). */
export function childIds(space: Room): string[] {
  const out: string[] = [];
  for (const ev of space.currentState.getStateEvents(EventType.SpaceChild)) {
    const via = (ev.getContent() as { via?: unknown }).via;
    const k = ev.getStateKey() ?? "";
    if (k && Array.isArray(via) && via.length > 0) out.push(k);
  }
  return [...new Set(out)].sort(cmpStr);
}

function joinedChild(client: MatrixClient, id: string): Room | null {
  const r = client.getRoom(id);
  return r && r.getMyMembership() === "join" ? r : null;
}

function plContent(room: Room): Record<string, unknown> | undefined {
  const ev = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
  return ev ? (ev.getContent() as Record<string, unknown>) : undefined;
}

function canWritePowerLevels(room: Room, me: string): boolean {
  return room.currentState.maySendStateEvent(EventType.RoomPowerLevels, me);
}

function joinRuleStr(room: Room): Summary["joinRule"] {
  const jr = (room.currentState.getStateEvents(EventType.RoomJoinRules, "")?.getContent() as { join_rule?: string } | undefined)?.join_rule;
  switch (jr) {
    case "public":
      return "public";
    case "knock":
      return "knock";
    case "restricted":
    case "knock_restricted":
      return "restricted";
    default:
      return "invite";
  }
}

function membershipOf(room: Room, mxid: string): string | undefined {
  return room.getMember(mxid)?.membership;
}

function roomDisplayName(room: Room): string {
  return room.name || room.getCanonicalAlias() || room.roomId;
}

// ---- snapshot (space.rs build_snapshot) ----------------------------------------------------------------

async function buildSnapshot(spaceId: string): Promise<Snapshot> {
  const client = peekClient();
  if (!client) throw new Error("Not signed in");
  if (!spaceId.startsWith("!")) throw new Error(`Bad space id: ${spaceId}`);
  const space = client.getRoom(spaceId);
  if (!space) throw new Error("That space isn't loaded");
  const me = client.getUserId() ?? "";
  const joined = space.getMyMembership() === "join";
  if (joined) await ensureMembersLoaded(spaceId).catch(() => undefined);

  const st = joined ? loadRolesState(spaceId, client) : new RolesState();
  const active = st.active();
  const my: Perms = joined ? effectivePermsWith(space, me, st, spaceId) : { rank: 0, perms: {}, rolesActive: false, container: spaceId };
  const myRank = my.rank;
  const has = (k: string) => !!my.perms[k];

  // members
  const rows: MemberRow[] = [];
  let nJoin = 0,
    nInvite = 0,
    nBan = 0;
  if (joined) {
    for (const m of space.currentState.getMembers()) {
      const ms = m.membership;
      if (ms !== "join" && ms !== "invite" && ms !== "ban") continue;
      if (ms === "join") nJoin++;
      else if (ms === "invite") nInvite++;
      else nBan++;
      const mxid = m.userId;
      const power = m.powerLevel === Infinity ? 100 : m.powerLevel;
      const isMe = mxid === me;
      let rank: number, roleIds: string[], top: RoleRef | null;
      if (active) {
        const rs = st.rolesOf(mxid);
        roleIds = rs.map((r) => r.id);
        top = rs[0] ? { id: rs[0].id, name: rs[0].name, color: rs[0].color } : null;
        rank = st.rankOf(mxid);
      } else {
        top = power >= 100 ? { id: "pl", name: "Admin", color: "" } : power >= 50 ? { id: "pl", name: "Moderator", color: "" } : null;
        rank = power;
        roleIds = [];
      }
      const outranked = rank < myRank;
      const tagRole = active ? st.tagRoleOf(mxid) : null;
      const reason = (m.events.member?.getContent() as { reason?: unknown } | undefined)?.reason;
      rows.push({
        mxid,
        name: memberName(space, mxid),
        avatar: m.getMxcAvatarUrl() ?? null,
        membership: ms,
        rank,
        power,
        roles: roleIds,
        topRole: top,
        tag: tagRole ? { id: tagRole.id, name: tagRole.name, color: tagRole.color } : null,
        isMe,
        canKick: has("kick") && !isMe && ms !== "ban" && outranked,
        canBan: has("ban") && !isMe && outranked,
        canEditRoles: active && has("manage_roles") && ms !== "ban" && (isMe || outranked),
        reason: typeof reason === "string" ? reason : "",
      });
    }
  }
  const section = (m: string) => (m === "join" ? 0 : m === "invite" ? 1 : 2);
  rows.sort(
    (a, b) =>
      section(a.membership) - section(b.membership) ||
      b.rank - a.rank ||
      b.power - a.power ||
      cmpStr(a.name.toLowerCase(), b.name.toLowerCase()) ||
      cmpStr(a.mxid, b.mxid),
  );
  const joinedIds = new Set(rows.filter((r) => r.membership === "join").map((r) => r.mxid));

  // roles
  const canManageRoles = has("manage_roles");
  const roles: RoleRow[] = st.sortedRoles().map((r) => {
    const isEveryone = r.id === EVERYONE;
    const count = isEveryone ? nJoin : [...st.members.entries()].filter(([m, ids]) => joinedIds.has(m) && ids.includes(r.id)).length;
    const editable = canManageRoles && (myRank >= 100 || r.rank < myRank);
    return {
      id: r.id,
      name: r.name,
      color: r.color,
      rank: r.rank,
      hoist: r.hoist,
      permissions: [...r.permissions],
      memberCount: count,
      editable,
      deletable: editable && !isEveryone,
      isEveryone,
    };
  });

  // rooms
  const rooms: RoomRow[] = [];
  let outOfSync = 0;
  const children = joined ? childIds(space) : [];
  for (const cid of children) {
    const room = joinedChild(client, cid);
    if (!room) {
      rooms.push({ id: cid, name: cid, avatar: null, joined: false, synced: true, canSync: false });
      continue;
    }
    let synced = true;
    if (active) {
      const cur = plContent(room);
      synced = !cur || jsonEqual(derivePowerLevels(cur, st, false), cur);
    }
    const canSync = active && canWritePowerLevels(room, me);
    if (!synced) outOfSync++;
    rooms.push({ id: cid, name: roomDisplayName(room), avatar: room.getMxcAvatarUrl() ?? null, joined: true, synced, canSync });
  }

  const alias = space.getCanonicalAlias() ?? "";
  const topic = (space.currentState.getStateEvents(EventType.RoomTopic, "")?.getContent() as { topic?: unknown } | undefined)?.topic;
  const summary: Summary = {
    id: spaceId,
    name: roomDisplayName(space),
    topic: typeof topic === "string" ? topic : "",
    avatar: space.getMxcAvatarUrl() ?? null,
    alias,
    link: shareLinkNow(spaceId, alias),
    joinRule: joinRuleStr(space),
    memberCount: joined ? nJoin : space.getJoinedMemberCount(),
    invitedCount: nInvite,
    bannedCount: nBan,
    roomCount: children.length,
    encrypted: space.hasEncryptionStateEvent(),
    membership: space.getMyMembership(),
    isMember: joined,
    canManageSpace: has("manage_space"),
    canManageRoles,
    canManageRooms: has("manage_rooms"),
    canInvite: has("invite"),
    canKick: has("kick"),
    canBan: has("ban"),
    outOfSyncRooms: outOfSync,
  };
  return { summary, members: rows, roles, myPerms: my.perms, rooms, rolesActive: active, myRank: Math.max(0, myRank) };
}

// ---- fresh member lists -----------------------------------------------------------------------------------

/**
 * Re-fetch a room's member list from the server (/members). With lazy-loaded members, a sync
 * store restored from IndexedDB can miss a join that happened in a gappy stretch while still
 * reporting the members as "loaded" — an admin tool must not act on that, so the Space settings
 * window refreshes the lists of the space and its joined children when it opens and on Refresh
 * (the native reads its own store, which syncs /members itself).
 */
export async function freshMembers(roomId: string): Promise<void> {
  const client = peekClient();
  const room = client?.getRoom(roomId);
  if (!client || !room || room.getMyMembership() !== "join") return;
  try {
    await ensureMembersLoaded(roomId).catch(() => undefined);
    // GET /members (not leave). NOT room.clearLoadedMembersIfNeeded(): js-sdk's IndexedDB
    // clearOutOfBandMembers throws DataError for a room without stored OOB members, and the
    // IndexedDBStore then degrades the whole sync store to memory.
    const resp = (await client.members(roomId, undefined, "leave")) as unknown as { chunk?: unknown[] };
    const map = client.getEventMapper();
    const missing = (resp.chunk ?? [])
      .map((raw) => map(raw as never))
      // only members the local store lost; anything it has came through /sync and stays
      .filter((ev) => ev.getType() === EventType.RoomMember && !room.currentState.getStateEvents(EventType.RoomMember, ev.getStateKey() ?? ""));
    if (missing.length) {
      log.info(`${roomId}: ${missing.length} member(s) missing from the local store — added from /members`);
      room.currentState.setStateEvents(missing);
    }
  } catch (e) {
    log.warn(`member reload ${roomId}: ${errText(e)}`);
  }
}

async function freshSpaceMembers(spaceId: string) {
  const c = peekClient();
  const space = c?.getRoom(spaceId);
  if (!c || !space || space.getMyMembership() !== "join") return;
  await Promise.all([spaceId, ...childIds(space).filter((id) => joinedChild(c, id))].map(freshMembers));
}

// ---- lifecycle ------------------------------------------------------------------------------------------

let refreshSeq = 0;

/** open(spaceId): track a space (clears the models when it changes) and load everything. */
export function openSpace(spaceId: string) {
  if (spaceId !== get().spaceId) {
    set({ ...INITIAL, spaceId, statusRev: get().statusRev, errorRev: get().errorRev, rev: get().rev + 1 });
  }
  if (!spaceId) return;
  attachLive();
  void refresh().then(() => freshSpaceMembers(spaceId).then(() => refresh()));
}

export function closeSpace() {
  set({ ...INITIAL, statusRev: get().statusRev, errorRev: get().errorRev, rev: get().rev + 1 });
  detachLive();
}

export function refresh(): Promise<void> {
  const sid = get().spaceId;
  if (!sid) return Promise.resolve();
  begin();
  const seq = ++refreshSeq;
  return buildSnapshot(sid)
    .then((snap) => {
      if (get().spaceId !== sid) return; // the user has since opened another space
      void seq;
      set((s) => ({ ...snap, rev: s.rev + 1 }));
    })
    .catch((e) => {
      if (get().spaceId === sid) setErrorText(errText(e));
    })
    .finally(end);
}

// live refresh on relevant state (debounced 250 ms) — the web is livelier than the native
const LIVE_TYPES = new Set<string>([
  EventType.RoomMember,
  EventType.RoomPowerLevels,
  ROLE_TYPE,
  MEMBER_ROLES_TYPE,
  EventType.SpaceChild,
  EventType.RoomName,
  EventType.RoomTopic,
  EventType.RoomAvatar,
  EventType.RoomJoinRules,
  EventType.RoomCanonicalAlias,
  EventType.RoomEncryption,
]);
let liveOff: (() => void) | null = null;
let liveTimer = 0;
function attachLive() {
  if (liveOff) return;
  const c = peekClient();
  if (!c) return;
  const onState = (ev: MatrixEvent) => {
    const sid = get().spaceId;
    if (!sid || !LIVE_TYPES.has(ev.getType())) return;
    const rid = ev.getRoomId();
    if (rid !== sid) {
      const space = c.getRoom(sid);
      if (!space || !rid || !childIds(space).includes(rid)) return;
      if (ev.getType() !== EventType.RoomPowerLevels && ev.getType() !== EventType.RoomName && ev.getType() !== EventType.RoomAvatar) return;
    }
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => void refresh(), 250);
  };
  c.on(RoomStateEvent.Events, onState);
  liveOff = () => c.off(RoomStateEvent.Events, onState);
}
function detachLive() {
  liveOff?.();
  liveOff = null;
  window.clearTimeout(liveTimer);
}

/** run_action: Ok(text) → status, Err(text) → lastError; refresh either way. */
function runAction(fut: () => Promise<string>): Promise<void> {
  set({ lastError: "" });
  begin();
  return fut()
    .then((msg) => {
      if (msg) setStatusText(msg);
    })
    .catch((e) => setErrorText(typeof e === "string" ? e : errText(e)))
    .finally(() => {
      end();
      void refresh();
    });
}

function openSpaceOrError(): string | null {
  const sid = get().spaceId;
  if (!sid) {
    setErrorText("No space is open");
    return null;
  }
  return sid;
}

// ---- action context (space.rs Ctx) ---------------------------------------------------------------------

class Ctx {
  constructor(
    readonly client: MatrixClient,
    readonly space: Room,
    readonly me: string,
    readonly st: RolesState,
    readonly my: Perms,
  ) {}

  static async load(spaceId: string): Promise<Ctx> {
    const client = peekClient();
    if (!client) throw "Not signed in";
    if (!isRoomId(spaceId)) throw `Bad space id: ${spaceId}`;
    const space = client.getRoom(spaceId);
    if (!space) throw "That space isn't loaded";
    if (space.getMyMembership() !== "join") throw "You're not a member of that space";
    await ensureMembersLoaded(spaceId).catch(() => undefined);
    const me = client.getUserId() ?? "";
    const st = loadRolesState(spaceId, client);
    const my = effectivePermsWith(space, me, st, spaceId);
    return new Ctx(client, space, me, st, my);
  }

  need(perm: string, what: string) {
    if (!this.my.perms[perm]) throw `You need the "${permissionLabel(perm)}" permission to ${what}`;
  }

  needActive() {
    if (!this.st.active()) throw "Roles aren't set up in this space yet";
  }

  rankOf(mxid: string): number {
    return this.st.active() ? this.st.rankOf(mxid) : powerLevelOf(this.space, mxid);
  }

  mustOutrank(mxid: string) {
    if (this.rankOf(mxid) >= this.my.rank) throw `${this.display(mxid)} is ranked at or above you`;
  }

  display(mxid: string): string {
    if (!isUserId(mxid)) return mxid;
    if (this.space.getMember(mxid)) return memberName(this.space, mxid);
    return localpart(mxid);
  }

  children(): Room[] {
    return childIds(this.space)
      .map((id) => joinedChild(this.client, id))
      .filter((r): r is Room => !!r);
  }

  guardLockout(next: RolesState) {
    const e = lockoutError(this.st, next, this.me);
    if (e) throw e;
  }

  /** §4: write the derived power levels to the space and every joined child where allowed. */
  async reconcile(st: RolesState): Promise<[number, number]> {
    const targets: Array<[Room, boolean]> = [[this.space, true], ...this.children().map((c) => [c, false] as [Room, boolean])];
    let written = 0,
      failed = 0;
    for (const [room, isSpace] of targets) {
      const cur = plContent(room);
      if (!cur) continue;
      const next = derivePowerLevels(cur, st, isSpace);
      if (jsonEqual(next, cur)) continue;
      if (!canWritePowerLevels(room, this.me)) {
        log.warn(`reconcile: no power-level rights in ${room.roomId}`);
        failed++;
        continue;
      }
      try {
        await rl(() => this.client.sendStateEvent(room.roomId, EventType.RoomPowerLevels, next as never, ""));
        written++;
      } catch (e) {
        log.warn(`reconcile ${room.roomId} failed: ${errText(e)}`);
        failed++;
      }
    }
    return [written, failed];
  }
}

function isUserId(s: string): boolean {
  return /^@[^:\s]+:[^\s]+$/.test(s.trim());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));



/** Wait (≤ 4 s) until the local store shows `ok(content)` for a state event we just wrote. */
async function settle(room: Room, type: string, key: string, ok: (v: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 16; i++) {
    const v = room.currentState.getStateEvents(type, key)?.getContent() as Record<string, unknown> | undefined;
    if (v && ok(v)) return;
    await sleep(250);
  }
}

async function settleMembership(room: Room, mxid: string, want: string[]) {
  for (let i = 0; i < 16; i++) {
    const cur = membershipOf(room, mxid);
    if (cur && want.includes(cur)) return;
    if (!cur && want.includes("leave")) return;
    await sleep(250);
  }
}

// ---- actions ---------------------------------------------------------------------------------------------

async function doApplyName(sid: string, nameIn: string): Promise<string> {
  const c = await Ctx.load(sid);
  c.need("manage_space", "rename the space");
  const name = nameIn.trim();
  if (!name) throw "Give the space a name";
  try {
    await c.client.sendStateEvent(sid, EventType.RoomName, { name } as never, "");
  } catch (e) {
    throw `Couldn't rename the space: ${errText(e)}`;
  }
  await settle(c.space, EventType.RoomName, "", (v) => v.name === name);
  return "Name saved";
}

async function doApplyTopic(sid: string, topicIn: string): Promise<string> {
  const c = await Ctx.load(sid);
  c.need("manage_space", "change the topic");
  const topic = topicIn.trim();
  try {
    await c.client.sendStateEvent(sid, EventType.RoomTopic, { topic } as never, "");
  } catch (e) {
    throw `Couldn't change the topic: ${errText(e)}`;
  }
  await settle(c.space, EventType.RoomTopic, "", (v) => (typeof v.topic === "string" ? v.topic : "") === topic);
  return "Topic saved";
}

async function doApplyPhoto(sid: string, file: File | null): Promise<string> {
  const c = await Ctx.load(sid);
  c.need("manage_space", "change the photo");
  const before = c.space.currentState.getStateEvents(EventType.RoomAvatar, "")?.getContent();
  try {
    if (file) {
      const up = await uploadFile(file, { encrypt: false });
      await c.client.sendStateEvent(sid, EventType.RoomAvatar, { url: up.mxc } as never, "");
    } else {
      await c.client.sendStateEvent(sid, EventType.RoomAvatar, {} as never, "");
    }
  } catch (e) {
    throw `Couldn't change the photo: ${errText(e)}`;
  }
  await settle(c.space, EventType.RoomAvatar, "", (v) => !jsonEqual(v, before));
  return file ? "Photo updated" : "Photo removed";
}

async function doApplyJoinRule(sid: string, rule: string): Promise<string> {
  const c = await Ctx.load(sid);
  c.need("manage_space", "change who can join");
  let msg: string;
  if (rule === "public") msg = "Anyone with the link can join now";
  else if (rule === "invite") msg = "Invite only now";
  else throw `Unknown join rule "${rule}"`;
  try {
    await c.client.sendStateEvent(sid, EventType.RoomJoinRules, { join_rule: rule } as never, "");
  } catch (e) {
    throw `Couldn't change who can join: ${errText(e)}`;
  }
  await settle(c.space, EventType.RoomJoinRules, "", (v) => v.join_rule === rule);
  return msg;
}

async function doInvite(sid: string, mxidIn: string): Promise<string> {
  const c = await Ctx.load(sid);
  c.need("invite", "invite people");
  const mxid = mxidIn.trim();
  if (!isUserId(mxid)) throw `${mxidIn} doesn't look like a user id`;
  const cur = membershipOf(c.space, mxid);
  const nm = () => memberName(c.space, mxid);
  if (cur === "join") throw `${nm()} is already a member`;
  if (cur === "invite") throw `${nm()} is already invited`;
  if (cur === "ban") throw `${nm()} is banned — unban them first`;
  try {
    await rl(() => c.client.invite(sid, mxid));
  } catch (e) {
    throw `Couldn't invite ${localpart(mxid)}: ${errText(e)}`;
  }
  await settleMembership(c.space, mxid, ["invite", "join"]);
  return `Invited ${c.display(mxid)}`;
}

type MemberAction = "kick" | "ban" | "unban";

async function doMembership(sid: string, mxidIn: string, reasonIn: string, action: MemberAction): Promise<string> {
  const c = await Ctx.load(sid);
  const [perm, what] = action === "kick" ? ["kick", "remove people"] : action === "ban" ? ["ban", "ban people"] : ["ban", "unban people"];
  c.need(perm, what);
  const mxid = mxidIn.trim();
  if (!isUserId(mxid)) throw `${mxidIn} doesn't look like a user id`;
  if (mxid === c.me) throw "You can't do that to yourself — use Leave instead";
  c.mustOutrank(mxid);
  const name = c.display(mxid);
  const reason = reasonIn.trim() || undefined;

  const cur = membershipOf(c.space, mxid);
  try {
    if (action === "kick") {
      const gone = goneText("space", name, cur); // (leftWords.ts: they may have left while the confirmation was open)
      if (gone) throw gone;
      await rl(() => c.client.kick(sid, mxid, reason)).catch((e) => {
        throw `Couldn't remove ${name}: ${errText(e)}`;
      });
    } else if (action === "ban") {
      if (cur === "ban") throw `${name} is already banned`;
      await rl(() => c.client.ban(sid, mxid, reason)).catch((e) => {
        throw `Couldn't ban ${name}: ${errText(e)}`;
      });
    } else {
      if (cur !== "ban") throw `${name} isn't banned`;
      await rl(() => c.client.unban(sid, mxid)).catch((e) => {
        throw `Couldn't unban ${name}: ${errText(e)}`;
      });
    }
  } catch (e) {
    throw typeof e === "string" ? e : errText(e);
  }

  // every joined child room where we may and it applies — best effort
  let done = 0;
  for (const child of c.children()) {
    await ensureMembersLoaded(child.roomId).catch(() => undefined);
    const myPower = powerLevelOf(child, c.me);
    const allowed =
      action === "kick"
        ? child.currentState.hasSufficientPowerLevelFor("kick", myPower)
        : child.currentState.hasSufficientPowerLevelFor("ban", myPower);
    if (!allowed) continue;
    const m = membershipOf(child, mxid);
    try {
      if (action === "kick") {
        if (m !== "join" && m !== "invite") continue;
        await rl(() => c.client.kick(child.roomId, mxid, reason));
      } else if (action === "ban") {
        if (m === "ban") continue;
        await rl(() => c.client.ban(child.roomId, mxid, reason));
      } else {
        if (m !== "ban") continue;
        await rl(() => c.client.unban(child.roomId, mxid));
      }
      done++;
    } catch (e) {
      log.warn(`${perm} ${mxid} in ${child.roomId} failed: ${errText(e)}`);
    }
  }
  await settleMembership(c.space, mxid, action === "ban" ? ["ban"] : ["leave"]);
  const verb = action === "kick" ? "Removed" : action === "ban" ? "Banned" : "Unbanned";
  const tail = done > 0 ? ` and ${plural(done, "room", "rooms")}` : "";
  return `${verb} ${name} from the space${tail}`;
}

async function writeMemberRoles(c: Ctx, mxid: string, roles: string[]) {
  try {
    await rl(() => c.client.sendStateEvent(c.space.roomId, MEMBER_ROLES_TYPE as never, { roles } as never, stateKeyFor(mxid)));
  } catch (e) {
    throw `Couldn't save roles: ${errText(e)}`;
  }
}

async function writeRole(c: Ctx, id: string, content: Record<string, unknown>) {
  try {
    await rl(() => c.client.sendStateEvent(c.space.roomId, ROLE_TYPE as never, content as never, id));
  } catch (e) {
    throw `Couldn't save the role: ${errText(e)}`;
  }
}

async function doSetMemberRoles(sid: string, mxidIn: string, ids: string[]): Promise<string> {
  const c = await Ctx.load(sid);
  c.needActive();
  c.need("manage_roles", "change someone's roles");
  const mxid = mxidIn.trim();
  if (!isUserId(mxid)) throw `${mxidIn} doesn't look like a user id`;
  const isMe = mxid === c.me;
  if (!isMe) c.mustOutrank(mxid);
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of ids.filter((x) => x !== EVERYONE)) {
    const role = c.st.roles.get(id);
    if (!role) throw "That role doesn't exist any more";
    if (role.rank > c.my.rank) throw `You can't give the "${role.name}" role — it's ranked above you`;
    if (!seen.has(id)) {
      seen.add(id);
      clean.push(id);
    }
  }
  const next = c.st.withMember(mxid, clean);
  c.guardLockout(next);
  await writeMemberRoles(c, mxid, clean);
  const [written, failed] = await c.reconcile(next);
  await settle(c.space, MEMBER_ROLES_TYPE, stateKeyFor(mxid), (v) => jsonEqual(Array.isArray(v.roles) ? v.roles : [], clean));
  const name = isMe ? "you" : c.display(mxid);
  return `Updated roles for ${name}${reconcileTail(written, failed)}`;
}

export interface RoleDraft {
  id: string;
  name: string;
  color: string;
  rank?: number;
  permissions?: string[];
  hoist?: boolean;
}

async function doSaveRole(sid: string, v: RoleDraft): Promise<string> {
  const c = await Ctx.load(sid);
  c.needActive();
  c.need("manage_roles", "edit roles");
  const idIn = (v.id ?? "").trim();
  const creating = idIn === "";
  const id = creating ? newRoleId() : idIn;
  const existing = c.st.roles.get(id) ?? null;
  if (!creating && !existing) throw "That role doesn't exist any more";
  if (existing && existing.rank >= c.my.rank && c.my.rank < 100) throw "You can't edit a role ranked at or above yours";
  const name = (v.name ?? "").trim();
  if (!name) throw "Give the role a name";
  const color = (v.color ?? "").trim();
  const rank =
    id === EVERYONE ? 0 : Math.min(100, Math.max(0, Number.isInteger(v.rank) ? (v.rank as number) : (existing?.rank ?? 0)));
  if (rank > c.my.rank) throw "You can't rank a role above yourself";
  const permissions = v.permissions ? [...new Set(v.permissions.filter(isKnownPermission))].sort(cmpStr) : [...(existing?.permissions ?? [])];
  const hoist = typeof v.hoist === "boolean" ? v.hoist : existing ? existing.hoist : id !== EVERYONE;
  const role: Role = { id, name, color, rank, permissions, hoist };
  const next = c.st.withRole(role);
  c.guardLockout(next);
  await writeRole(c, id, roleToContent(role));
  const [written, failed] = await c.reconcile(next);
  const want = roleToContent(role);
  await settle(c.space, ROLE_TYPE, id, (got) => jsonEqual(got, want));
  return `${creating ? "Created" : "Saved"} the "${name}" role${reconcileTail(written, failed)}`;
}

async function doDeleteRole(sid: string, roleId: string): Promise<string> {
  const c = await Ctx.load(sid);
  c.needActive();
  c.need("manage_roles", "delete roles");
  if (roleId === EVERYONE) throw "The Everyone role can't be deleted";
  const role = c.st.roles.get(roleId);
  if (!role) throw "That role doesn't exist any more";
  if (role.rank >= c.my.rank && c.my.rank < 100) throw "You can't delete a role ranked at or above yours";
  const next = c.st.withoutRole(roleId);
  c.guardLockout(next);
  await writeRole(c, roleId, {});
  const [written, failed] = await c.reconcile(next);
  await settle(c.space, ROLE_TYPE, roleId, (v) => Object.keys(v).length === 0);
  return `Deleted the "${role.name}" role${reconcileTail(written, failed)}`;
}

async function doSetupRoles(sid: string): Promise<string> {
  const c = await Ctx.load(sid);
  if (c.st.active()) return "Roles are already set up";
  if (!canWritePowerLevels(c.space, c.me)) throw "Only an admin of the space can set up roles";
  const users: Array<[string, number]> = c.space.currentState
    .getMembers()
    .filter((m) => m.membership === "join")
    .map((m) => [m.userId, m.powerLevel === Infinity ? 100 : m.powerLevel]);
  const assigned = migrateFromPowerLevels(users);
  const next = new RolesState();
  for (const role of defaultTemplate()) {
    await writeRole(c, role.id, roleToContent(role));
    next.roles.set(role.id, role);
  }
  for (const [mxid, ids] of assigned) {
    await writeMemberRoles(c, mxid, ids);
    next.members.set(mxid, ids);
  }
  const [written, failed] = await c.reconcile(next);
  await settle(c.space, ROLE_TYPE, EVERYONE, (v) => "name" in v);
  const admins = [...assigned.values()].filter((r) => r.includes("admin")).length;
  const mods = [...assigned.values()].filter((r) => r.includes("moderator")).length;
  return `Roles set up: ${plural(admins, "admin", "admins")} and ${plural(mods, "moderator", "moderators")}${reconcileTail(written, failed)}`;
}

async function doSyncRooms(sid: string): Promise<string> {
  const c = await Ctx.load(sid);
  c.needActive();
  c.need("manage_roles", "sync the rooms");
  const [w, f] = await c.reconcile(c.st);
  if (w > 0) await sleep(1200);
  if (w === 0 && f === 0) return "Every room is already in sync";
  if (f === 0) return `Roles synced to ${plural(w, "room", "rooms")}`;
  return `Roles synced to ${plural(w, "room", "rooms")}, ${plural(f, "room", "rooms")} couldn't be synced`;
}

async function doLeave(sid: string): Promise<string> {
  const client = peekClient();
  if (!client) throw "Not signed in";
  if (!sid.startsWith("!")) throw `Bad space id: ${sid}`;
  const space = client.getRoom(sid);
  if (!space) throw "That space isn't loaded";
  const name = roomDisplayName(space);
  try {
    await rl(() => client.leave(sid));
  } catch (e) {
    throw `Couldn't leave ${name}: ${errText(e)}`;
  }
  return `Left ${name}`;
}

async function doSearchUsers(sid: string, q: string): Promise<UserHit[]> {
  const client = peekClient();
  if (!client) return [];
  const space = client.getRoom(sid);
  try {
    const resp = await client.searchUserDirectory({ term: q, limit: 20 });
    return resp.results.map((u) => {
      const m = space ? membershipOf(space, u.user_id) : undefined;
      return {
        mxid: u.user_id,
        name: u.display_name || localpart(u.user_id),
        avatar: u.avatar_url || null,
        alreadyMember: m === "join" || m === "invite",
      };
    });
  } catch (e) {
    log.warn(`user search failed: ${errText(e)}`);
    return [];
  }
}

// ---- public actions (QML spaceCtl.*) -------------------------------------------------------------------

let searchSeq = 0;

export const spaceActions = {
  open: openSpace,
  close: closeSpace,
  refresh,
  /** the Refresh button: re-fetch the member lists too, then rebuild every model */
  hardRefresh: () => {
    const sid = get().spaceId;
    if (!sid) return;
    begin();
    void freshSpaceMembers(sid)
      .then(() => refresh())
      .finally(end);
  },
  applyName: (name: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doApplyName(sid, name));
  },
  applyTopic: (topic: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doApplyTopic(sid, topic));
  },
  applyPhoto: (file: File | null) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doApplyPhoto(sid, file));
  },
  applyJoinRule: (rule: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doApplyJoinRule(sid, rule));
  },
  invite: (mxid: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doInvite(sid, mxid));
  },
  searchUsers: (query: string) => {
    const q = query.trim();
    const seq = ++searchSeq;
    if (!q) {
      set({ userSearch: [], userSearchQuery: "" });
      return;
    }
    const sid = get().spaceId;
    void doSearchUsers(sid, q).then((hits) => {
      if (seq !== searchSeq) return; // a newer query is in flight
      set({ userSearch: hits, userSearchQuery: q });
    });
  },
  clearSearch: () => {
    searchSeq++;
    set({ userSearch: [], userSearchQuery: "" });
  },
  kick: (mxid: string, reason: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doMembership(sid, mxid, reason, "kick"));
  },
  ban: (mxid: string, reason: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doMembership(sid, mxid, reason, "ban"));
  },
  unban: (mxid: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doMembership(sid, mxid, "", "unban"));
  },
  setMemberRoles: (mxid: string, ids: string[]) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doSetMemberRoles(sid, mxid, ids));
  },
  saveRole: (role: RoleDraft) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doSaveRole(sid, role));
  },
  deleteRole: (id: string) => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doDeleteRole(sid, id));
  },
  setupRoles: () => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doSetupRoles(sid));
  },
  syncRooms: () => {
    const sid = openSpaceOrError();
    if (sid) void runAction(() => doSyncRooms(sid));
  },
  leave: (): Promise<boolean> => {
    const sid = openSpaceOrError();
    if (!sid) return Promise.resolve(false);
    set({ lastError: "" });
    begin();
    return doLeave(sid)
      .then((msg) => {
        setStatusText(msg);
        if (get().spaceId === sid) closeSpace();
        return true;
      })
      .catch((e) => {
        setErrorText(typeof e === "string" ? e : errText(e));
        void refresh();
        return false;
      })
      .finally(end);
  },
};

/** kickIn / banIn: the same kick/ban on an explicit space, without opening it (call menu). */
export function kickIn(spaceId: string, mxid: string, reason: string): Promise<void> {
  return runAction(() => doMembership(spaceId, mxid, reason, "kick"));
}
export function banIn(spaceId: string, mxid: string, reason: string): Promise<void> {
  return runAction(() => doMembership(spaceId, mxid, reason, "ban"));
}
