// model.ts — the guest room's pure rules (contract docs/GUESTS.md). SHARED LOGIC: the desktop replays model.test.ts's
// cases (docs/DESKTOP-PENDING-guests.md). Pure: no React, no app imports beyond core/server's pure offer rules.
//
//   parseGuestState / parseWaiting   the room state the server keeps (`dev.tinhat.guests`, `dev.tinhat.guests.waiting`)
//   parseDoc                         GET /api/guests → the doc (link, roles, room)
//   localRole / mergeRole            who may do what (the server's own rule, from the room's power levels + the doc)
//   barPlan / waitingRows            the bar under the Guests room's header and its waiting rows
//   panePlan                         Settings → Guests
//   isGuestsRoom                     is this room THE Guests room (the doc's room; else the alias the server gave it)
//   arrivals                         the "is waiting" notices: new ids only, once per device (dedupe by id)
//   handoffJoinsCall                 the #/guest-session hand-off: into the Guests room's call only when one is on
import { isGuestAccount } from "../../core/server/offer";

export { isGuestAccount };

export const GUESTS_TYPE = "dev.tinhat.guests";
export const WAITING_TYPE = "dev.tinhat.guests.waiting";
/** the server keeps at most this many waiting */
export const MAX_WAITING = 20;
/** a name is at most this many characters (code points), as the server cuts it */
export const NAME_MAX = 32;
/** a knock waits this long; an older entry is never announced */
export const WAIT_MS = 10 * 60_000;
/** turn on / off and new link: a server admin or this power level in the Guests room */
export const MANAGE_LEVEL = 50;
/** how many announced ids a device remembers */
export const SEEN_MAX = 100;
const ID_RE = /^[A-Za-z0-9_-]{8}$/;

// ---- words (docs/GUESTS.md "Words"; the desktop uses exactly these) ---------------------------------------------

export const WORDS = {
  pane: "Guests",
  turnOnLong: "Turn on the guest room",
  turnOn: "Turn on",
  turnOff: "Turn off",
  copy: "Copy guest link",
  newLink: "New link",
  letIn: "Let in",
  turnAway: "Turn away",
  open: "Open the Guests room",
  barOn: "Guest room is on",
  barOffManager: "Guest room is off",
  barOff: "The guest room is off",
  paneOn: "The guest room is on.",
  paneOff: "The guest room is off.",
  paneNever: "The guest room hasn't been turned on yet.",
  paneNeverMember: "The guest room hasn't been turned on yet. A server admin can turn it on here.",
  unavailable: "The guest room isn't available on this server.",
  someone: "A guest",
} as const;

/** Settings → Guests: what the guest room is (two sentences). */
export const EXPLAIN =
  "The guest room lets people without an account join you for a while: they open the guest link in a browser, type a name and wait at the door until someone here lets them in. " +
  "Guests stay in the Guests room (and its call) for at most 12 hours, then their temporary account disappears.";

export const waitingText = (name: string): string => `${name} is waiting`;
export const noticeText = (name: string): string => `${name} is waiting to come in as a guest`;

// ---- the room state ---------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export interface GuestRoomState {
  on: boolean;
  /** when it was last turned on / off (ms); null when not said */
  since: number | null;
}

/** `dev.tinhat.guests` → on/off; null when there is no usable event (no content, or `on` isn't a boolean). */
export function parseGuestState(content: unknown): GuestRoomState | null {
  if (!isObj(content)) return null;
  const on = own(content, "on");
  if (typeof on !== "boolean") return null;
  return { on, since: num(own(content, "since")) };
}

export interface Waiter {
  /** 8 characters [A-Za-z0-9_-] (the server's id; the admit / turn-away key) */
  id: string;
  name: string;
  /** when they knocked (ms); 0 when not said */
  at: number;
}

/** A waiting guest's name as shown: trimmed, at most NAME_MAX code points, "A guest" when empty. */
export function cleanName(v: unknown): string {
  const s = typeof v === "string" ? [...v.trim()].slice(0, NAME_MAX).join("").trim() : "";
  return s || WORDS.someone;
}

/** `dev.tinhat.guests.waiting` (or the doc's `waiting` array) → who waits, in the server's order: valid ids only, the
 *  first of a repeated id, at most MAX_WAITING. Anything malformed → []. */
export function parseWaiting(content: unknown): Waiter[] {
  const list = Array.isArray(content) ? content : isObj(content) ? own(content, "waiting") : null;
  if (!Array.isArray(list)) return [];
  const out: Waiter[] = [];
  const seen = new Set<string>();
  for (const w of list) {
    if (out.length >= MAX_WAITING) break;
    if (!isObj(w)) continue;
    const id = own(w, "id");
    if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanName(own(w, "name")), at: num(own(w, "at")) ?? 0 });
  }
  return out;
}

// ---- the doc (GET /api/guests) ------------------------------------------------------------------------------------

export interface GuestsDoc {
  /** the server can run the guest room at all */
  available: boolean;
  /** the Guests room; null before the first "Turn on" */
  room: string | null;
  alias: string;
  on: boolean;
  since: number;
  /** the guest link — only for members who aren't guests, and managers */
  link: string | null;
  waiting: Waiter[];
  canManage: boolean;
  canAdmit: boolean;
  member: boolean;
}

/** The API's answer → a doc; null when it isn't an object. Unknown / odd fields read as "no". */
export function parseDoc(v: unknown): GuestsDoc | null {
  if (!isObj(v)) return null;
  const room = own(v, "room");
  const alias = own(v, "alias");
  const link = own(v, "link");
  return {
    available: own(v, "available") === true,
    room: typeof room === "string" && /^![^:\s]+(?::\S+)?$/.test(room) ? room : null, // v12 ids have no ":server"
    alias: typeof alias === "string" ? alias : "",
    on: own(v, "on") === true,
    since: num(own(v, "since")) ?? 0,
    link: typeof link === "string" && /^https?:\/\/\S+$/.test(link) ? link : null,
    waiting: parseWaiting(own(v, "waiting")),
    canManage: own(v, "canManage") === true,
    canAdmit: own(v, "canAdmit") === true,
    member: own(v, "member") === true,
  };
}

// ---- who may do what ----------------------------------------------------------------------------------------------

export interface GuestRole {
  /** joined to the Guests room */
  member: boolean;
  /** a temporary guest account */
  guest: boolean;
  /** see the state, copy the link, let in / turn away */
  canAdmit: boolean;
  /** turn on / off, new link */
  canManage: boolean;
}

const intOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isInteger(v) ? v : d);

/**
 * The role this device can tell by itself (the server's own rule, docs/GUESTS.md "Who may do what"): admit = joined, not
 * a guest, power level ≥ the room's `invite` level (0 when unset); manage = joined, not a guest, power level ≥ 50. A
 * server admin who isn't a member only shows through the doc (mergeRole).
 */
export function localRole(o: { userId: string; membership: string | null | undefined; powerLevels: unknown }): GuestRole {
  const guest = isGuestAccount(o.userId);
  const member = o.membership === "join";
  const pl = isObj(o.powerLevels) ? o.powerLevels : {};
  const users = isObj(own(pl, "users")) ? (own(pl, "users") as Record<string, unknown>) : {};
  const mine = intOr(own(users, o.userId), intOr(own(pl, "users_default"), 0));
  const invite = intOr(own(pl, "invite"), 0);
  return { member, guest, canAdmit: !guest && member && mine >= invite, canManage: !guest && member && mine >= MANAGE_LEVEL };
}

/** This device's view + the server's answer (either may say yes: sync is fresher about membership, the doc knows server
 *  admins). A guest account never gets a right, whatever the doc says. */
export function mergeRole(local: GuestRole, doc: Pick<GuestsDoc, "member" | "canAdmit" | "canManage"> | null): GuestRole {
  const guest = local.guest;
  return {
    member: local.member || !!doc?.member,
    guest,
    canAdmit: !guest && (local.canAdmit || !!doc?.canAdmit),
    canManage: !guest && (local.canManage || !!doc?.canManage),
  };
}

/** May see the state and the link (docs/GUESTS.md: any member who isn't a guest; and managers). */
export const seesGuestRoom = (r: GuestRole): boolean => !r.guest && (r.canAdmit || r.canManage);

// ---- the bar under the Guests room's header -----------------------------------------------------------------------

export type BarButton = "copy" | "newLink" | "turnOff" | "turnOn";

export interface BarPlan {
  text: string;
  buttons: BarButton[];
}

/**
 * The bar (docs/GUESTS.md "The apps" 2): on — "Guest room is on · [Copy guest link] [New link] [Turn off]" (New link /
 * Turn off for managers only); off — "Guest room is off · [Turn on]" (managers) or "The guest room is off" (others).
 * Guests (and anyone who may not see the state) get no bar at all.
 */
export function barPlan(on: boolean, role: GuestRole): BarPlan | null {
  if (!seesGuestRoom(role)) return null;
  if (on) return { text: WORDS.barOn, buttons: role.canManage ? ["copy", "newLink", "turnOff"] : ["copy"] };
  return role.canManage ? { text: WORDS.barOffManager, buttons: ["turnOn"] } : { text: WORDS.barOff, buttons: [] };
}

export const BAR_LABEL: Readonly<Record<BarButton, string>> = { copy: WORDS.copy, newLink: WORDS.newLink, turnOff: WORDS.turnOff, turnOn: WORDS.turnOn };

/** The rows under the bar: everyone waiting, while the room is on, for those who may let them in. */
export function waitingRows(on: boolean, role: GuestRole, waiting: readonly Waiter[]): Waiter[] {
  return on && !role.guest && role.canAdmit ? [...waiting] : [];
}

// ---- Settings → Guests ----------------------------------------------------------------------------------------------

export type PaneButton = "turnOn" | "turnOff" | "copy" | "newLink" | "open";

export interface PanePlan {
  state: "unavailable" | "never" | "on" | "off";
  text: string;
  buttons: PaneButton[];
  /** show the guest link as text (to copy by hand when the clipboard refuses) */
  showLink: boolean;
}

export const PANE_LABEL: Readonly<Record<PaneButton, string>> = { turnOn: WORDS.turnOnLong, turnOff: WORDS.turnOff, copy: WORDS.copy, newLink: WORDS.newLink, open: WORDS.open };

/**
 * Settings → Guests (docs/GUESTS.md "The apps" 1): the state, and — managers: Turn on the guest room / Turn off · Copy
 * guest link · New link · Open the Guests room; members: Copy guest link (while on) · Open the Guests room; everyone
 * else who isn't a guest: Open the Guests room once it exists (its join rule is public — opening it joins it).
 */
export function panePlan(doc: GuestsDoc, role: GuestRole): PanePlan {
  if (!doc.available) return { state: "unavailable", text: WORDS.unavailable, buttons: [], showLink: false };
  if (role.guest) return { state: doc.room ? (doc.on ? "on" : "off") : "never", text: doc.on ? WORDS.paneOn : WORDS.paneOff, buttons: [], showLink: false };
  if (!doc.room) return { state: "never", text: role.canManage ? WORDS.paneNever : WORDS.paneNeverMember, buttons: role.canManage ? ["turnOn"] : [], showLink: false };
  const sees = seesGuestRoom(role);
  if (doc.on) {
    const buttons: PaneButton[] = role.canManage ? ["copy", "newLink", "turnOff", "open"] : sees ? ["copy", "open"] : ["open"];
    return { state: "on", text: WORDS.paneOn, buttons, showLink: sees && !!doc.link };
  }
  return { state: "off", text: WORDS.paneOff, buttons: role.canManage ? ["turnOn", "open"] : ["open"], showLink: false };
}

// ---- which room is the Guests room ------------------------------------------------------------------------------

/**
 * THE Guests room: the doc's `room` once the server answered; before that, a room carrying `dev.tinhat.guests` whose
 * canonical alias is `#guests:<server>` (only the server's system account can set it there — power level 100). A room
 * where someone else wrote the state event is never one.
 */
export function isGuestsRoom(o: { roomId: string; docRoom: string | null | undefined; hasGuestState: boolean; canonicalAlias: string | null | undefined; server: string }): boolean {
  if (o.docRoom) return o.roomId === o.docRoom;
  return o.hasGuestState && !!o.server && o.canonicalAlias === `#guests:${o.server}`;
}

// ---- noticing (the "is waiting" notification) ---------------------------------------------------------------------

export interface ArrivalsInput {
  /** ids this device already announced (oldest first) */
  seen: readonly string[];
  waiting: readonly Waiter[];
  now: number;
  /** this user may let people in: a member of the Guests room who isn't a guest, and the server offers the guest room */
  eligible: boolean;
}

/**
 * Who to announce now: each id once per device (dedupe by id — a reload, a re-sync or the state event arriving again
 * never repeats it), only while eligible (an id seen while not eligible is announced once eligible, if it still waits),
 * never an entry older than WAIT_MS (its knock is over). `seen` keeps the newest SEEN_MAX ids.
 */
export function arrivals(i: ArrivalsInput): { notify: Waiter[]; seen: string[] } {
  if (!i.eligible) return { notify: [], seen: [...i.seen] };
  const known = new Set(i.seen);
  const notify: Waiter[] = [];
  const seen = [...i.seen];
  for (const w of i.waiting) {
    if (known.has(w.id)) continue;
    known.add(w.id);
    seen.push(w.id);
    const stale = w.at > 0 && i.now - w.at >= WAIT_MS;
    if (!stale) notify.push(w);
  }
  return { notify, seen: seen.slice(-SEEN_MAX) };
}

/** The ids that left the list (let in or turned away — by anyone): their notice closes. */
export function departures(before: readonly string[], waiting: readonly Waiter[]): string[] {
  const now = new Set(waiting.map((w) => w.id));
  return before.filter((id) => !now.has(id));
}

// ---- a guest's own name ------------------------------------------------------------------------------------------

/** The name the account footer shows: everyone's localpart (as the desktop), except a temporary guest account's — its
 *  localpart is a random id ("guest-9b230bc…"), so the display name the server registered ("Cousin Jo (guest)") is
 *  shown, the localpart only when there is none. */
export function accountName(userId: string, displayName: string | null | undefined): string {
  const local = userId.replace(/^@/, "").split(":")[0] ?? userId;
  const name = typeof displayName === "string" ? displayName.trim() : "";
  return isGuestAccount(userId) && name ? name : local;
}

// ---- the hand-off ---------------------------------------------------------------------------------------------------

/** A guest landing from `#/guest-session`: in the Guests room they join its call only when one is on (else they sit in
 *  the room, the call button ready); any other room (the old per-room links) joins its call as before. */
export function handoffJoinsCall(o: { guestsRoom: boolean; callLive: boolean }): boolean {
  return !o.guestsRoom || o.callLive;
}
