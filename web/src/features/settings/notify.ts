// notify.ts — the desktop-notification decision engine (native notify.rs:393-700) on the Web
// Notifications API + @/core/sounds, and the incoming-call alert (bridge.rs:1150-1157).
//
//   startNotifyEngine()            once per session (r.onReady); stops itself on sign-out
//   setAttending(token, roomId)    a view that shows a room (main view is derived from the route;
//                                  floating chats / other readers register themselves)
//   notifyDesktop({...})           post one notification (permission-aware, never throws)
//   requestNotificationPermission(), useNotificationPermission()
//
// Decision (per sync): mode = explicit per-room push rule (room rule with notify → all, room rule
// without → mentions, override matching the room without notify → mute) else DM → all, group →
// mentions; trigger = notification_count (all) / highlight_count (mentions); the first scan and
// every mode change seed silently; fire only on a rise, never for muted or attended rooms, 5 s per
// room debounce, global cap 8 per rolling 10 s; vanished rooms are pruned; a room that appears after
// the baseline counts from 0 (its first message notifies — notifyrules.ts). The notify sound plays
// once per batch even with toasts off.
// Web review #7/#20: a post that waits for an avatar is dropped if the engine stopped, the account changed,
// notifications were switched off or the room was read meanwhile; avatar object URLs are bounded and revoked,
// room listeners leave with their rooms.
import { useSyncExternalStore } from "react";
import { ClientEvent, NotificationCountType, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { fetchMedia, getSession, peekClient } from "@/core/matrix";
import { closeNotes, noteRegistration, pushCoversNow, showNote } from "@/core/notes";
import { onPageResume } from "@/core/lifecycle";
import { getPref } from "@/core/prefs";
import { playUiSound } from "@/core/sounds";
import { bus, openRoom } from "@/core/bus";
import { createLogger } from "@/core/log";
import { parseHash } from "@/app/router";
import { pushCovers, stepRoom, type Mode, type RoomRule, type RoomSeen } from "./notifyrules";

const log = createLogger("notify");

// ---- permission ------------------------------------------------------------------------------

export type Perm = NotificationPermission | "unsupported";
const permListeners = new Set<() => void>();

export function notificationPermission(): Perm {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function requestNotificationPermission(): Promise<Perm> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    await Notification.requestPermission();
  } catch {
    /* old Safari callback form */
  }
  permListeners.forEach((l) => l());
  return Notification.permission;
}

export function useNotificationPermission(): Perm {
  return useSyncExternalStore(
    (cb) => {
      permListeners.add(cb);
      const t = setInterval(cb, 2000); // the user can flip it in the browser UI
      return () => {
        permListeners.delete(cb);
        clearInterval(t);
      };
    },
    notificationPermission,
  );
}

// ---- posting ---------------------------------------------------------------------------------

export interface DesktopNote {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  /** auto-close after this many ms (native expiry) */
  timeoutMs?: number;
  requireInteraction?: boolean;
  /** the room it is about: a click opens it (the push worker's path passes it on as tinhat-open-room) */
  room?: string;
  onClick?: () => void;
  /** a message the gateway also pushes: left to the push while the page is hidden (A5.4) */
  pushCovered?: boolean;
}

/** Post one browser notification. Returns false when the browser can't / won't. REACH §3.2: through the push
 *  worker's registration when there is one (Android Chrome refuses `new Notification`; an installed iOS web
 *  app has only that path) — core/notes.ts picks. Sounds stay ours (snd.*): silent. */
export function notifyDesktop(n: DesktopNote): boolean {
  if (notificationPermission() !== "granted") return false;
  const ok = showNote({ title: n.title, body: n.body, icon: n.icon, tag: n.tag, silent: true, requireInteraction: n.requireInteraction, timeoutMs: n.timeoutMs, room: n.room, onClick: n.onClick, pushCovered: n.pushCovered });
  if (!ok) log.debug("Notification failed");
  return ok;
}

// ---- attended rooms --------------------------------------------------------------------------

const attending = new Map<string, string>();

/** Register (or clear with null) a view that shows `roomId` to the user (floating chat etc.). */
export function setAttending(token: string, roomId: string | null): void {
  if (roomId) attending.set(token, roomId);
  else attending.delete(token);
}

/** The rooms on screen right now (the window visible and focused): the route's room + registered readers. */
function attendedRooms(): Set<string> {
  const out = new Set<string>();
  if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) {
    const r = parseHash(location.hash);
    if (r.name === "room" && r.target) out.add(r.target);
    for (const v of attending.values()) out.add(v);
  }
  return out;
}

function isAttended(roomId: string): boolean {
  return attendedRooms().has(roomId);
}

// ---- modes -----------------------------------------------------------------------------------

interface PushRule {
  rule_id: string;
  enabled?: boolean;
  actions?: unknown[];
  conditions?: Array<{ kind: string; key?: string; pattern?: string }>;
}

function hasNotify(actions: unknown[] | undefined): boolean {
  return (actions ?? []).some((a) => a === "notify");
}

export function roomMode(c: MatrixClient, roomId: string, isDm: boolean): Mode {
  const g = (c.getAccountData("m.push_rules" as never)?.getContent()?.global ?? {}) as Record<string, PushRule[]>;
  for (const r of g.override ?? []) {
    if (r.enabled === false) continue;
    const matches = r.rule_id === roomId || (r.conditions ?? []).some((k) => k.kind === "event_match" && k.key === "room_id" && k.pattern === roomId);
    if (matches && !hasNotify(r.actions)) return "mute";
  }
  for (const r of g.room ?? []) {
    if (r.enabled === false || r.rule_id !== roomId) continue;
    return hasNotify(r.actions) ? "all" : "mentions";
  }
  return isDm ? "all" : "mentions";
}

/** The room's own rule as the push sees it (notifyrules RoomRule): a room rule that notifies with a sound = "sound". */
function roomRuleOf(c: MatrixClient, roomId: string): RoomRule {
  const g = (c.getAccountData("m.push_rules" as never)?.getContent()?.global ?? {}) as Record<string, PushRule[]>;
  const r = (g.room ?? []).find((x) => x.enabled !== false && x.rule_id === roomId);
  if (!r) return "none";
  const sound = (r.actions ?? []).some((a) => !!a && typeof a === "object" && (a as { set_tweak?: unknown }).set_tweak === "sound");
  return hasNotify(r.actions) && sound ? "sound" : "quiet";
}

/** Will the web push bring this room's alert (notifyrules pushCovers)? Only asked while pushCoversNow(). */
function pushWillCover(c: MatrixClient, room: Room, isDm: boolean, highlightRose: boolean): boolean {
  return pushCovers({
    encrypted: room.hasEncryptionStateEvent(),
    mode: roomMode(c, room.roomId, isDm),
    rule: roomRuleOf(c, room.roomId),
    members: room.getJoinedMemberCount(),
    highlightRose,
  });
}

function directIds(c: MatrixClient): Set<string> {
  const m = (c.getAccountData("m.direct" as never)?.getContent() ?? {}) as Record<string, string[]>;
  const out = new Set<string>();
  for (const ids of Object.values(m)) for (const id of ids ?? []) out.add(id);
  return out;
}

// ---- toast content ---------------------------------------------------------------------------

function latestBody(room: Room): { sender: string; text: string } | null {
  const evs = room.getLiveTimeline().getEvents();
  for (let i = evs.length - 1; i >= 0 && i >= evs.length - 30; i--) {
    const ev: MatrixEvent = evs[i];
    const t = ev.getType();
    if (t !== "m.room.message" && t !== "m.sticker" && t !== "m.room.encrypted") continue;
    const body = ev.getContent()?.body;
    if (typeof body === "string" && body.trim()) return { sender: ev.getSender() ?? "", text: body.trim() };
  }
  return null;
}

export function toastBody(room: Room, isDm: boolean, rise: number): { body: string; sender: string } {
  const last = latestBody(room);
  let body = "";
  let sender = "";
  if (last) {
    sender = last.sender;
    let text = last.text.replace(/\s+/g, " ");
    if ([...text].length > 160) text = [...text].slice(0, 160).join("") + "…";
    if (!isDm) {
      const m = room.getMember(last.sender);
      const name = m?.rawDisplayName || last.sender.replace(/^@/, "").split(":")[0];
      text = `${name}: ${text}`;
    }
    body = rise > 1 ? `${text} (+${rise - 1} more)` : text;
  } else {
    body = rise > 1 ? `${rise} new messages` : "New message";
  }
  return { body, sender };
}

// Avatars as object URLs for the classic `new Notification` path only (the worker path can't use a page blob: URL —
// core/notes.ts drops it — so nothing is fetched for it). Bounded, revoked on eviction and on teardown (web review #20).
const AVATARS_MAX = 24;
const avatarCache = new Map<string, string>();

function dropAvatars(): void {
  for (const url of avatarCache.values()) URL.revokeObjectURL(url);
  avatarCache.clear();
}

async function avatarFor(c: MatrixClient, room: Room, userId: string, gen: number): Promise<string | undefined> {
  if (noteRegistration()) return undefined;
  const mxc = room.getMember(userId)?.getMxcAvatarUrl() ?? c.getUser(userId)?.avatarUrl;
  if (!mxc) return undefined;
  const hit = avatarCache.get(mxc);
  if (hit) {
    avatarCache.delete(mxc); // most recently used last
    avatarCache.set(mxc, hit);
    return hit;
  }
  try {
    const blob = await fetchMedia(mxc, { width: 96, height: 96, method: "crop" });
    if (gen !== engineGen) return undefined; // the engine stopped meanwhile: nothing new for a gone session
    const url = URL.createObjectURL(blob);
    avatarCache.set(mxc, url);
    while (avatarCache.size > AVATARS_MAX) {
      const [k, old] = avatarCache.entries().next().value!;
      avatarCache.delete(k);
      URL.revokeObjectURL(old);
    }
    return url;
  } catch {
    return undefined;
  }
}

// ---- the scan --------------------------------------------------------------------------------

let running: { client: MatrixClient; off: () => void } | null = null;
/** Bumps when the engine stops or restarts: a post still waiting for its avatar is dropped (web review #7). */
let engineGen = 0;
const seen = new Map<string, RoomSeen>();
/** Each room's highlight count at the last scan (pushCovers: did this rise bring a mention the push sees?). */
const seenHighlights = new Map<string, number>();
let seeded = false;
let fireLog: number[] = [];

function countFor(c: MatrixClient, room: Room, dms: Set<string>): number {
  const mode = roomMode(c, room.roomId, dms.has(room.roomId));
  if (mode === "mute") return 0;
  return mode === "mentions" ? room.getUnreadNotificationCount(NotificationCountType.Highlight) : room.getUnreadNotificationCount(NotificationCountType.Total);
}

/** A5.4: the baseline comes from the first NETWORK sync (never the IndexedDB cache) and is taken again after a
 *  resume from suspension — until then every scan seeds silently (no replay of old messages). */
function baselineReady(): boolean {
  return getSession().liveSyncDone;
}

export function scanOnce(c: MatrixClient, now = Date.now()): string[] {
  const dms = directIds(c);
  const fired: Array<{ room: Room; rise: number; isDm: boolean; highlightRose: boolean }> = [];
  const present = new Set<string>();
  const read: string[] = [];
  if (!baselineReady()) seeded = false;
  const onScreen = attendedRooms();
  for (const room of c.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    const id = room.roomId;
    present.add(id);
    const isDm = dms.has(id);
    const mode = roomMode(c, id, isDm);
    const count =
      mode === "mentions" ? room.getUnreadNotificationCount(NotificationCountType.Highlight) : room.getUnreadNotificationCount(NotificationCountType.Total);
    const prev = seen.get(id);
    const highlights = room.getUnreadNotificationCount(NotificationCountType.Highlight);
    const highlightRose = highlights > (seenHighlights.get(id) ?? 0);
    if (prev && prev.count > 0 && count === 0) read.push(id); // A5.4: read → its notification goes
    const { next, rise } = stepRoom(prev, { count, mode, attended: onScreen.has(id) }, seeded, now);
    if (rise > 0) {
      fireLog = fireLog.filter((t) => now - t < 10000);
      if (fireLog.length < 8) {
        fireLog.push(now);
        next.lastFire = now;
        delete next.fresh;
        fired.push({ room, rise, isDm, highlightRose });
      }
    }
    seen.set(id, next);
    seenHighlights.set(id, highlights);
  }
  for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
  for (const id of [...seenHighlights.keys()]) if (!present.has(id)) seenHighlights.delete(id);
  seeded = baselineReady();
  for (const id of read) void closeNotes(`room:${id}`);
  if (fired.length === 0) return [];
  // A5.4: with push on for this device a hidden page leaves messages to the push (one alert, one sound) — except
  // what the push won't bring (2026-10-23: a mention in an encrypted group room; notifyrules pushCovers)
  const own = pushCoversNow() ? fired.filter((f) => !pushWillCover(c, f.room, f.isDm, f.highlightRose)) : fired;
  if (own.length === 0) return fired.map((f) => f.room.roomId);
  playUiSound("notify");
  if (getPref("desktop-notifications", "1") !== "0") {
    const gen = engineGen;
    const user = getSession().userId ?? "";
    for (const f of own) {
      const { body, sender } = toastBody(f.room, f.isDm, f.rise);
      const roomId = f.room.roomId;
      const title = f.room.name || "Tin Hat";
      // A5.4: no timed close — a room's notification stays until the room is read
      void (sender ? avatarFor(c, f.room, sender, gen) : Promise.resolve(undefined)).then((icon) => {
        // web review #7: still the same engine + account, still wanted, the room still unread and not on screen
        if (gen !== engineGen || running?.client !== c || (getSession().userId ?? "") !== user) return;
        if (getPref("desktop-notifications", "1") === "0") return;
        const room = c.getRoom(roomId);
        if (!room || room.getMyMembership() !== "join" || countFor(c, room, directIds(c)) === 0 || isAttended(roomId)) return;
        const covered = pushWillCover(c, room, f.isDm, f.highlightRose);
        if (covered && pushCoversNow()) return;
        notifyDesktop({ title, body, icon, tag: `room:${roomId}`, room: roomId, pushCovered: covered });
      });
    }
  }
  return fired.map((f) => f.room.roomId);
}


/** A5.4: the page is visible again — close the notifications (ours and the push's) of every room that has
 *  been read meanwhile, and of invites that are no longer pending. */
export async function closeReadNotes(c: MatrixClient): Promise<void> {
  const reg = noteRegistration();
  if (!reg) return;
  const dms = directIds(c);
  try {
    for (const n of await reg.getNotifications()) {
      const m = /^(room|invite):(!.+)$/.exec(n.tag);
      if (!m) continue;
      const room = c.getRoom(m[2]!);
      // an invite (our invite:<id> tag, or a pushed invite — the worker's data.kind): kept while it is pending
      const kind = (n.data as { kind?: unknown } | null)?.kind;
      if (m[1] === "invite" || kind === "invite") {
        if (!room || room.getMyMembership() !== "invite") n.close();
        continue;
      }
      if (!room || room.getMyMembership() !== "join") {
        n.close();
        continue;
      }
      const mode = roomMode(c, room.roomId, dms.has(room.roomId));
      const count = mode === "mute" ? 0 : mode === "mentions" ? room.getUnreadNotificationCount(NotificationCountType.Highlight) : room.getUnreadNotificationCount(NotificationCountType.Total);
      if (!count) n.close();
    }
  } catch {
    /* ignore */
  }
}

export function startNotifyEngine(): void {
  const c = peekClient();
  if (!c || running?.client === c) return;
  stopNotifyEngine();
  seen.clear();
  seenHighlights.clear();
  seeded = false;
  fireLog = [];
  const scan = () => {
    try {
      scanOnce(c);
    } catch (e) {
      log.warn("scan failed", e);
    }
  };
  const onSync = (state: string) => {
    if (state === "PREPARED" || state === "SYNCING") scan();
  };
  // A5.4 (S1): encrypted rooms count after decryption, which lands after the Sync event — rescan on the
  // room's own unread change too, debounced 250 ms
  let t = 0;
  const soon = () => {
    window.clearTimeout(t);
    t = window.setTimeout(scan, 250);
  };
  const bound = new Set<Room>();
  const bind = () => {
    const now = new Set(c.getRooms());
    for (const r of now)
      if (!bound.has(r)) {
        r.on(RoomEvent.UnreadNotifications, soon);
        bound.add(r);
      }
    // rooms that left the store take their listener with them (web review #20)
    for (const r of bound)
      if (!now.has(r)) {
        r.off(RoomEvent.UnreadNotifications, soon);
        bound.delete(r);
      }
  };
  bind();
  const onRoom = () => bind();
  // after a suspension the counts may have moved while nothing ran: take the baseline again
  const offResume = onPageResume((info) => {
    if (info.suspended) seeded = false;
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") void closeReadNotes(c);
  };
  document.addEventListener("visibilitychange", onVisible);
  c.on(ClientEvent.Sync, onSync);
  c.on(ClientEvent.Room, onRoom);
  c.on(ClientEvent.DeleteRoom, onRoom);
  running = {
    client: c,
    off: () => {
      c.off(ClientEvent.Sync, onSync);
      c.off(ClientEvent.Room, onRoom);
      c.off(ClientEvent.DeleteRoom, onRoom);
      for (const r of bound) r.off(RoomEvent.UnreadNotifications, soon);
      bound.clear();
      window.clearTimeout(t);
      offResume();
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
  scan(); // seed
  log.info("notification engine on");
}

export function stopNotifyEngine(): void {
  engineGen++; // a post still waiting for its avatar is dropped
  running?.off();
  running = null;
  dropAvatars();
}

bus.on("loggedOut", () => stopNotifyEngine());

// ---- incoming calls (SET-58) -----------------------------------------------------------------

// The incoming-call desktop alert (SET-58) is posted by the calls engine (callwatch.ts, tag
// `incoming-call:<roomId>`, INTEGRATION #8); it reads the same `notify.calls` pref this pane writes.
