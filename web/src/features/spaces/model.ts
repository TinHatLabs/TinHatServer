// model.ts — byte-faithful port of the native `roles_model.rs` (RBAC pure model, docs/RBAC.md §2–§4)
// plus the small pure helpers of `roles.rs` / `space.rs` (badges, permalink, plurals).
//
// NO imports: this file is also loaded by `node model.test.ts` (Node type stripping) to run the
// native unit tests 1:1. Everything is plain JSON in, plain JSON out.
//
// Wire truth (must match the desktop app byte for byte where it matters):
//   dev.tinhat.role          state_key = role id, content {color,hoist,name,permissions[],rank}
//   dev.tinhat.member_roles  state_key = mxid WITHOUT '@', content {roles:[ids]}
//   m.room.power_levels       derived by derivePowerLevels() — written to the space + children.
// Rust semantics that matter and are reproduced here:
//   * `Value::as_i64` → only integer JSON numbers count (floats / strings fall back to defaults);
//   * BTreeMap / BTreeSet order = byte order of the UTF-8 strings (cmpStr below);
//   * serde_json::Value equality = deep equality with key order ignored (jsonEqual below).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export const ROLE_TYPE = "dev.tinhat.role";
export const MEMBER_ROLES_TYPE = "dev.tinhat.member_roles";
export const CALL_MOD_TYPE = "dev.tinhat.call.moderation";
export const EVERYONE = "everyone";

export type Enforcement = "matrix" | "server" | "client";

export interface PermDef {
  key: string;
  label: string;
  group: string;
  description: string;
  enforcement: Enforcement;
}

/** The v1 catalogue — exactly the table in RBAC §2, in that order. Keys are stable: never rename. */
export const PERMISSIONS: readonly PermDef[] = [
  { key: "manage_space", label: "Manage space", group: "Space", description: "Change the name, topic, photo, who can join and the space link", enforcement: "matrix" },
  { key: "manage_roles", label: "Manage roles", group: "Space", description: "Create and edit roles and give them to people", enforcement: "matrix" },
  { key: "manage_rooms", label: "Manage rooms", group: "Space", description: "Create rooms in the space and add or remove rooms from it", enforcement: "matrix" },
  { key: "invite", label: "Invite people", group: "People", description: "Invite people to the space and its rooms", enforcement: "matrix" },
  { key: "kick", label: "Remove people", group: "People", description: "Remove someone from the space and its rooms", enforcement: "matrix" },
  { key: "ban", label: "Ban people", group: "People", description: "Ban and unban people", enforcement: "matrix" },
  { key: "manage_messages", label: "Manage messages", group: "Chat", description: "Delete anyone's messages", enforcement: "matrix" },
  { key: "pin_messages", label: "Pin messages", group: "Chat", description: "Pin and unpin messages", enforcement: "matrix" },
  { key: "mention_everyone", label: "Mention everyone", group: "Chat", description: "Use @room to notify everyone", enforcement: "matrix" },
  { key: "moderate_calls", label: "Moderate calls", group: "Calls", description: "Mute someone's mic for everyone, disconnect them from a call", enforcement: "server" },
  { key: "share_screen", label: "Share screen", group: "Calls", description: "Share a screen or window in calls", enforcement: "client" },
  { key: "use_soundboard", label: "Use the soundboard", group: "Calls", description: "Play sounds in calls", enforcement: "client" },
  { key: "manage_soundboard", label: "Manage the soundboard", group: "Calls", description: "Add and remove the space's shared sounds", enforcement: "matrix" },
  { key: "record_calls", label: "Record calls", group: "Calls", description: "Start and stop Memories recording", enforcement: "matrix" },
  { key: "manage_calendar", label: "Manage the calendar", group: "Squad", description: "Edit or cancel anyone's events", enforcement: "client" },
  { key: "manage_games", label: "Manage game nights", group: "Squad", description: "Change game-night rules, credits and the reel", enforcement: "matrix" },
  { key: "manage_watchparty", label: "Run Media Parties", group: "Squad", description: "Take over control of any Media Party", enforcement: "client" },
  // 11.1 (the Game servers widget, docs/GAMESERVERS.md): the Tin Hat server (its game-servers API) reads the roles
  // itself on every power request; no Matrix mapping. Appended: keys and indices above never move.
  { key: "manage_game_servers", label: "Manage game servers", group: "Squad", description: "Start, stop and restart the game servers", enforcement: "server" },
  // widgets W1 (the Sticky note widget, WIDGETS.md §14): the space's `dev.tinhat.note` state. Appended: keys and indices
  // above never move (the Roles editors group by `group`, so it lists under Space).
  { key: "edit_space_note", label: "Edit the space note", group: "Space", description: "Write and change the note on the space's Sticky note widget", enforcement: "matrix" },
];

export type PermKey = (typeof PERMISSIONS)[number]["key"];

/** Top-level `m.room.power_levels` keys a permission maps to (§2 "Matrix mapping"). */
export const TOP_LEVEL_MAP: ReadonlyArray<readonly [string, string]> = [
  ["invite", "invite"],
  ["kick", "kick"],
  ["ban", "ban"],
  ["manage_messages", "redact"],
];

/** `events[<type>]` entries a permission maps to. m.space.child only in the space, m.space.parent only in children. */
export const EVENT_MAP: ReadonlyArray<readonly [string, string]> = [
  ["manage_space", "m.room.name"],
  ["manage_space", "m.room.topic"],
  ["manage_space", "m.room.avatar"],
  ["manage_space", "m.room.join_rules"],
  ["manage_space", "m.room.canonical_alias"],
  ["manage_roles", "m.room.power_levels"],
  ["manage_roles", ROLE_TYPE],
  ["manage_roles", MEMBER_ROLES_TYPE],
  ["manage_rooms", "m.space.child"],
  ["manage_rooms", "m.space.parent"],
  ["pin_messages", "m.room.pinned_events"],
  ["moderate_calls", CALL_MOD_TYPE],
  ["manage_soundboard", "dev.tinhat.soundboard"],
  ["record_calls", "dev.tinhat.record"],
  ["manage_games", "dev.tinhat.games.settings"],
  ["manage_games", "dev.tinhat.games.adjust"],
  ["edit_space_note", "dev.tinhat.note"],
];

/** Every `events[<type>]` entry the reconciler owns (ensureWritable must skip these when roles are active). */
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

// ---- Rust semantics helpers ---------------------------------------------------------------------

/** Rust `str::cmp` (UTF-8 byte order == code point order). JS `<` compares UTF-16 units. */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Rust `to_lowercase` for sort keys (close enough: full Unicode lower-casing). */
const lower = (s: string) => s.toLowerCase();

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** serde_json `Value::as_i64`: integral numbers in the i64 range only. */
export function asI64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? v : undefined;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** serde_json Value equality: deep, object key order ignored, arrays ordered. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !jsonEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Deep copy of a JSON value. */
export function jsonClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Canonical JSON text (sorted keys) — serde_json's default map order, for stable comparisons/logs. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObject(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort(cmpStr);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const sortedSet = (keys: Iterable<string>): string[] => [...new Set(keys)].sort(cmpStr);

// ---- catalogue ---------------------------------------------------------------------------------

export function allPermissionKeys(): string[] {
  return sortedSet(PERMISSIONS.map((p) => p.key));
}

export function isKnownPermission(key: string): boolean {
  return PERMISSIONS.some((p) => p.key === key);
}

export function permissionLabel(key: string): string {
  return PERMISSIONS.find((p) => p.key === key)?.label ?? key;
}

// ---- Role --------------------------------------------------------------------------------------

export interface Role {
  id: string;
  name: string;
  color: string;
  rank: number;
  /** BTreeSet: sorted, unique */
  permissions: string[];
  hoist: boolean;
}

/** The `dev.tinhat.role` event content (serde_json key order: sorted). */
export function roleToContent(r: Role): JsonObject {
  return { color: r.color, hoist: r.hoist, name: r.name, permissions: sortedSet(r.permissions), rank: r.rank };
}

/** Parse one role event. null for a deleted role (empty content) or garbage. */
export function roleFromContent(id: string, content: unknown): Role | null {
  if (!isObject(content)) return null;
  if (Object.keys(content).length === 0) return null;
  const rawName = typeof content.name === "string" ? content.name.trim() : "";
  const name = rawName !== "" ? rawName : id;
  const color = typeof content.color === "string" ? content.color.trim() : "";
  const rank = id === EVERYONE ? 0 : clamp(asI64(content.rank) ?? 0, 0, 100);
  const permissions = Array.isArray(content.permissions) ? sortedSet(content.permissions.filter((p): p is string => typeof p === "string")) : [];
  const hoist = typeof content.hoist === "boolean" ? content.hoist : false;
  return { id, name, color, rank, permissions, hoist };
}

// ---- RolesState --------------------------------------------------------------------------------

export class RolesState {
  /** role id → role (iterate with sortedIds() for BTreeMap order) */
  readonly roles: Map<string, Role>;
  /** full mxid (with '@') → assigned role ids (as stored) */
  readonly members: Map<string, string[]>;

  constructor(roles?: Map<string, Role>, members?: Map<string, string[]>) {
    this.roles = roles ?? new Map();
    this.members = members ?? new Map();
  }

  /** Build from raw state: roles = [state_key = role id, content], members = [state_key = mxid minus '@', content]. */
  static fromState(roles: ReadonlyArray<readonly [string, unknown]>, members: ReadonlyArray<readonly [string, unknown]>): RolesState {
    const st = new RolesState();
    for (const [id, content] of roles) {
      const r = roleFromContent(id, content);
      if (r) st.roles.set(id, r);
    }
    for (const [key, content] of members) {
      if (key === "") continue;
      const mxid = mxidFromStateKey(key);
      const raw = isObject(content) && Array.isArray(content.roles) ? content.roles : [];
      st.members.set(
        mxid,
        raw.filter((x): x is string => typeof x === "string"),
      );
    }
    return st;
  }

  clone(): RolesState {
    return new RolesState(new Map(this.roles), new Map(this.members));
  }

  /** Roles are active in a space iff the `everyone` role exists (§3). */
  active(): boolean {
    return this.roles.has(EVERYONE);
  }

  /** 10.4 space tags: the member's highest CUSTOM role (never admin / moderator / everyone). */
  tagRoleOf(mxid: string): Role | null {
    return this.rolesOf(mxid).find((r) => !isBuiltin(r.id)) ?? null;
  }

  /** Max rank of the member's assigned roles, 0 with none. */
  rankOf(mxid: string): number {
    return this.rolesOf(mxid)[0]?.rank ?? 0;
  }

  /** Union of the member's roles' permissions plus `everyone` (sorted). */
  permsOf(mxid: string): string[] {
    const out = new Set<string>();
    const e = this.roles.get(EVERYONE);
    if (e) for (const p of e.permissions) out.add(p);
    for (const r of this.rolesOf(mxid)) for (const p of r.permissions) out.add(p);
    return sortedSet(out);
  }

  has(mxid: string, perm: string): boolean {
    return this.permsOf(mxid).includes(perm);
  }

  /** The member's assigned roles that exist, rank desc (ties by id), deduplicated. */
  rolesOf(mxid: string): Role[] {
    const ids = this.members.get(mxid) ?? [];
    const out = ids.map((id) => this.roles.get(id)).filter((r): r is Role => !!r);
    out.sort((a, b) => b.rank - a.rank || cmpStr(a.id, b.id));
    // Vec::dedup_by — consecutive duplicates (sorted, so all duplicates)
    return out.filter((r, i) => i === 0 || out[i - 1].id !== r.id);
  }

  /** Every role, rank desc, `everyone` last (ties by lower-cased name, then id). */
  sortedRoles(): Role[] {
    const out = [...this.roles.values()];
    out.sort((a, b) => {
      const ae = a.id === EVERYONE ? 1 : 0;
      const be = b.id === EVERYONE ? 1 : 0;
      return ae - be || b.rank - a.rank || cmpStr(lower(a.name), lower(b.name)) || cmpStr(a.id, b.id);
    });
    return out;
  }

  /** Lowest rank that holds `perm`, or 100 when no role does (§4 rule 3). */
  threshold(perm: string): number {
    let min: number | undefined;
    for (const r of this.roles.values()) {
      if (r.permissions.includes(perm)) min = min === undefined ? r.rank : Math.min(min, r.rank);
    }
    return min ?? 100;
  }

  /** Members (with a record) whose rank is `rank` or more — BTreeMap key order. */
  membersAtOrAbove(rank: number): string[] {
    return [...this.members.keys()].sort(cmpStr).filter((m) => this.rankOf(m) >= rank);
  }

  withRole(role: Role): RolesState {
    const st = this.clone();
    st.roles.set(role.id, role);
    return st;
  }

  withoutRole(id: string): RolesState {
    const st = this.clone();
    st.roles.delete(id);
    return st;
  }

  withMember(mxid: string, roles: string[]): RolesState {
    const st = this.clone();
    st.members.set(mxid, [...roles]);
    return st;
  }

  /** Stable text form (for equality between snapshots). */
  signature(): string {
    const roles = [...this.roles.keys()].sort(cmpStr).map((id) => [id, roleToContent(this.roles.get(id)!)]);
    const members = [...this.members.keys()].sort(cmpStr).map((m) => [m, this.members.get(m)!]);
    return canonicalJson({ roles, members } as unknown as Json);
  }
}

// ---- state keys --------------------------------------------------------------------------------

/** Per-member state keys are the mxid WITHOUT its leading '@'. */
export function stateKeyFor(mxid: string): string {
  return mxid.startsWith("@") ? mxid.slice(1) : mxid;
}

export function mxidFromStateKey(key: string): string {
  return key.startsWith("@") ? key : `@${key}`;
}

// ---- template / migration ----------------------------------------------------------------------

/** The three roles "Set up roles" creates (§2 "Default roles"). */
export function defaultTemplate(): Role[] {
  return [
    { id: "admin", name: "Admin", color: "#e8b923", rank: 100, permissions: allPermissionKeys(), hoist: true },
    {
      id: "moderator",
      name: "Moderator",
      color: "#4da3ff",
      rank: 50,
      permissions: sortedSet([
        "invite",
        "kick",
        "ban",
        "manage_space",
        "manage_rooms",
        "manage_messages",
        "pin_messages",
        "mention_everyone",
        "moderate_calls",
        "share_screen",
        "use_soundboard",
        "manage_soundboard",
        "record_calls",
        "manage_calendar",
        "manage_games",
        "manage_watchparty",
        "edit_space_note",
      ]),
      hoist: true,
    },
    // widgets W1: the space's note is the friend group's (2026-09-28: everyone may edit it)
    { id: EVERYONE, name: "Everyone", color: "#8a8f98", rank: 0, permissions: sortedSet(["invite", "share_screen", "use_soundboard", "record_calls", "edit_space_note"]), hoist: false },
  ];
}

/** ≥ 100 → admin, ≥ 50 → moderator, else no record. Keys are full mxids (BTreeMap order). */
export function migrateFromPowerLevels(users: ReadonlyArray<readonly [string, number]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [mxid, level] of users) {
    if (level >= 100) out.set(mxid, ["admin"]);
    else if (level >= 50) out.set(mxid, ["moderator"]);
  }
  return new Map([...out.entries()].sort((a, b) => cmpStr(a[0], b[0])));
}

// ---- power levels ------------------------------------------------------------------------------

function plI64(pl: unknown, key: string, def: number): number {
  return (isObject(pl) ? asI64(pl[key]) : undefined) ?? def;
}

function plEvent(pl: unknown, eventType: string, def: number): number {
  const ev = isObject(pl) ? pl.events : undefined;
  return (isObject(ev) ? asI64(ev[eventType]) : undefined) ?? def;
}

/**
 * §4: the power-level content that enforces `st`. Starts from a deep copy of `current`, never drops
 * keys it does not understand, deterministic — callers compare (jsonEqual) and skip equal writes.
 */
export function derivePowerLevels(current: unknown, st: RolesState, isSpace: boolean): JsonObject {
  const out: JsonObject = isObject(current) ? jsonClone(current) : {};
  const usersDefault = plI64(out, "users_default", 0);

  // Rule 2: managed members get users[mxid] = rank; unmanaged mxids are left alone.
  if (st.members.size > 0) {
    if (!isObject(out.users)) out.users = {};
    const users = out.users as JsonObject;
    for (const mxid of [...st.members.keys()].sort(cmpStr)) {
      const rank = st.rankOf(mxid);
      // No roles (rank 0) = the room's baseline whatever users_default is.
      if (rank === 0 || rank === usersDefault) delete users[mxid];
      else users[mxid] = rank;
    }
  }

  // Rule 3: thresholds.
  for (const [perm, key] of TOP_LEVEL_MAP) out[key] = st.threshold(perm);
  if (!isObject(out.notifications)) out.notifications = {};
  (out.notifications as JsonObject).room = st.threshold("mention_everyone");
  if (!isObject(out.events)) out.events = {};
  const events = out.events as JsonObject;
  for (const [perm, eventType] of EVENT_MAP) {
    if (eventType === "m.space.child" && !isSpace) continue;
    if (eventType === "m.space.parent" && isSpace) continue;
    events[eventType] = st.threshold(perm);
  }
  return out;
}

/** The template roles: never a name tag. */
export function isBuiltin(id: string): boolean {
  return id === "admin" || id === "moderator" || id === EVERYONE;
}

/** `"r-" + 8 lower-case hex` for a new custom role. */
export function newRoleId(): string {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return `r-${a[0].toString(16).padStart(8, "0")}`;
}

/**
 * Effective permissions when roles are NOT active, derived from the room's power levels. Client-
 * enforced permissions are true for everyone (there is nothing to derive them from). Sorted.
 */
export function permsFromPowerLevels(myLevel: number, pl: unknown): string[] {
  const stateDefault = plI64(pl, "state_default", 50);
  const notif = isObject(pl) && isObject(pl.notifications) ? asI64(pl.notifications.room) : undefined;
  const notifRoom = notif ?? 50;
  const out = new Set<string>();
  const grant = (key: string, needed: number) => {
    if (myLevel >= needed) out.add(key);
  };
  grant("kick", plI64(pl, "kick", 50));
  grant("ban", plI64(pl, "ban", 50));
  grant("invite", plI64(pl, "invite", 0));
  grant("manage_messages", plI64(pl, "redact", 50));
  grant("mention_everyone", notifRoom);
  grant("pin_messages", plEvent(pl, "m.room.pinned_events", stateDefault));
  grant("moderate_calls", plEvent(pl, CALL_MOD_TYPE, 50));
  grant("manage_space", plEvent(pl, "m.room.name", stateDefault));
  grant("manage_roles", plEvent(pl, "m.room.power_levels", stateDefault));
  grant("manage_rooms", plEvent(pl, "m.space.child", stateDefault));
  grant("manage_soundboard", plEvent(pl, "dev.tinhat.soundboard", stateDefault));
  grant("record_calls", plEvent(pl, "dev.tinhat.record", stateDefault));
  grant("manage_games", plEvent(pl, "dev.tinhat.games.settings", stateDefault));
  // no Matrix mapping: a space without roles gives it to its owner rank (what the Tin Hat server checks too)
  grant("manage_game_servers", 100);
  grant("edit_space_note", plEvent(pl, "dev.tinhat.note", stateDefault));
  for (const p of PERMISSIONS) if (p.enforcement === "client") out.add(p.key);
  return sortedSet(out);
}

/** `{"<key>": bool, …}` for every catalogue key (catalogue order). */
export function permsJson(perms: Iterable<string>): Record<string, boolean> {
  const set = new Set(perms);
  const m: Record<string, boolean> = {};
  for (const p of PERMISSIONS) m[p.key] = set.has(p.key);
  return m;
}

// ---- roles.rs badges ---------------------------------------------------------------------------

/** The legacy power-level label (Admin | Mod | Member). */
export function plLabel(power: number): "Admin" | "Mod" | "Member" {
  return power >= 100 ? "Admin" : power >= 50 ? "Mod" : "Member";
}

/** Name + colour of the member's highest CUSTOM role, ["", ""] when none (or roles inactive). */
export function tagBadgeFrom(st: RolesState, mxid: string): [string, string] {
  if (st.active()) {
    const r = st.tagRoleOf(mxid);
    if (r) return [r.name, r.color];
  }
  return ["", ""];
}

/** Top assigned role when roles are active, else the power-level label with colour "". */
export function roleBadgeFrom(st: RolesState, mxid: string, power: number): [string, string] {
  if (st.active()) {
    const top = st.rolesOf(mxid)[0];
    if (top) return [top.name, top.color];
  }
  return [plLabel(power), ""];
}

// ---- space.rs helpers --------------------------------------------------------------------------

/** encodeURIComponent exactly as space.rs::encode_component (= JS encodeURIComponent). */
export function encodeComponent(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.!~*'()]/.test(c) && b < 128) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** matrix.to permalink: the alias when published, else the id with a `via` hint. */
export function permalink(roomId: string, alias: string): string {
  if (alias) return `https://matrix.to/#/${encodeComponent(alias)}`;
  // a room id always carries its server; a malformed one gets no via hint
  const i = roomId.lastIndexOf(":");
  const server = i >= 0 ? roomId.slice(i + 1) : "";
  return `https://matrix.to/#/${encodeComponent(roomId)}${server ? `?via=${server}` : ""}`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export function reconcileTail(written: number, failed: number): string {
  let s = "";
  if (written > 0) s += ` — synced to ${plural(written, "room", "rooms")}`;
  if (failed > 0) s += ` (${plural(failed, "room", "rooms")} couldn't be synced)`;
  return s;
}

export const LOCKOUT = "That would lock you out of managing roles.";

/**
 * The lock-out guards (space.rs guard_lockout): the acting user keeps manage_roles, and nobody
 * demotes the last rank-100 member. Returns the error text or "".
 */
export function lockoutError(cur: RolesState, next: RolesState, me: string): string {
  if (!next.has(me, "manage_roles")) return LOCKOUT;
  if (cur.membersAtOrAbove(100).length > 0 && next.membersAtOrAbove(100).length === 0) return LOCKOUT;
  return "";
}

/** Is `c` a usable colour for a badge / name (#rgb, #rrggbb, #aarrggbb or a CSS colour word)? */
export function validColor(c: string | null | undefined): boolean {
  if (!c) return false;
  const t = c.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) return true;
  return /^[a-z]{3,20}$/i.test(t);
}
