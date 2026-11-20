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
import { bus, openRoom, openThread } from "@/core/bus";
import { threadOf } from "@/features/chat/threads/core";
import { THREADS_TAB, useThreadsPanel } from "@/features/chat/threads/state";
import { useRightPanelStore } from "@/features/spaces/panelState";
import { useChatStore } from "@/features/chat/store";
import { createLogger } from "@/core/log";
import { parseHash } from "@/app/router";
import { planScan, pushCovers, type Mode, type RoomRule, type RoomSeen } from "./notifyrules";
import { webActions } from "@/features/push/notifactions";
import { noteIcon } from "./noteicon";
import { toastNote } from "./toastpreview";
import { forgetPosts, isNewestPost, pickNotified, postTicket, type Notified } from "./notifypick";
import { chatMsgOf, countsWithoutQuiet, highlightWithoutQuiet, roomChatIndex, totalWithoutQuiet } from "@/features/media/memories/chatHide";
import { quietInChat } from "@/features/media/memories/photos";

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
  /** docs/NOTIF-ACTIONS.md: the event the note shows → Reply / Mark as read buttons */
  event?: string;
  /** threads: the thread that event is in — Reply and the click open it */
  thread?: string;
}

/** Post one browser notification. Returns false when the browser can't / won't. REACH §3.2: through the push
 *  worker's registration when there is one (Android Chrome refuses `new Notification`; an installed iOS web
 *  app has only that path) — core/notes.ts picks. Sounds stay ours (snd.*): silent. */
export function notifyDesktop(n: DesktopNote): boolean {
  if (notificationPermission() !== "granted") return false;
  const actions = n.room && n.event !== undefined ? webActions(n.event) : undefined;
  const ok = showNote({ title: n.title, body: n.body, icon: n.icon, tag: n.tag, silent: true, requireInteraction: n.requireInteraction, timeoutMs: n.timeoutMs, room: n.room, onClick: n.onClick, pushCovered: n.pushCovered, actions, event: n.event, thread: n.thread });
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

/** threads (desktop review #5/#6): the thread of the room's newest event that NOTIFIED under the push rules ("" =
 *  main) — not of its latest event (a main message after a thread mention must not hide the mention). */
function notifyingThread(room: Room): string {
  const c = peekClient();
  const evs = room.getLiveTimeline().getEvents();
  for (let i = evs.length - 1; i >= 0 && i >= evs.length - 30; i--) {
    const ev = evs[i];
    if (ev.getSender() === c?.getUserId()) continue;
    if (!c?.getPushActionsForEvent(ev)?.notify) continue;
    return threadOf(ev.getWireContent() ?? ev.getContent());
  }
  return "";
}

/** threads (review #15): a room on screen still notifies for a reply in a thread that isn't the one open in its
 *  Threads panel (thread replies don't show in the main timeline). */
function threadNewsHidden(room: Room): boolean {
  const t = notifyingThread(room);
  if (!t) return false;
  const panel = useRightPanelStore.getState();
  // the right panel belongs to the main view's room (round 2 #11: another room's open thread doesn't count)
  const panelHere = panel.open && panel.tab === THREADS_TAB && useChatStore.getState().mainRoom === room.roomId;
  const shown = panelHere ? (useThreadsPanel.getState().open[room.roomId] ?? null) : null;
  return shown !== t;
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

function latestBody(room: Room): Notified | null {
  // threads (round 2 #10): the text is the newest NOTIFYING message's when there is one (the click opens its thread);
  // 6-9: a blank one keeps its event, sender and thread (notifypick.ts)
  const c = peekClient();
  const me = c?.getUserId();
  // 12.1.17: a quiet Memories photo is never what a notification is about (memories/chatHide.ts)
  const idx = roomChatIndex(room);
  return pickNotified(room.getLiveTimeline().getEvents(), (e) => e.getSender() !== me && !quietInChat(idx, chatMsgOf(e as MatrixEvent)) && !!c?.getPushActionsForEvent(e as MatrixEvent)?.notify);
}

export function toastBody(room: Room, isDm: boolean, rise: number): { body: string; sender: string; eventId: string; thread: string } {
  const last = latestBody(room);
  let body = "";
  let sender = "";
  let eventId = "";
  let thread = "";
  // the whole line is toastNote (toastpreview.ts = the desktop's toast_note, shared vectors toast-preview.json `notes`):
  // the shared preview rule cuts the text, threads add their wording ("Ana (in thread): …" / "In thread: …"), and an
  // uncached sender is named by the id's localpart (1-10)
  const text = last ? toastNote(isDm ? null : room.getMember(last.sender)?.rawDisplayName, last.sender, isDm, last.thread !== "", last.text) : null;
  if (last) {
    // 6-9: Mark as read and Reply target the notified event even when it shows the generic wording (as on the desktop)
    eventId = last.eventId;
    thread = last.thread;
  }
  if (last && text) {
    sender = last.sender; // the picture goes with a preview (as on the desktop)
    body = rise > 1 ? `${text} (+${rise - 1} more)` : text;
  } else {
    body = rise > 1 ? `${rise} new messages` : "New message";
  }
  return { body, sender, eventId, thread };
}

// The sender's picture (Messages-style): a small data: URL on the worker path (the notification service can't read a
// page blob: URL — core/notes.ts drops those), an object URL on the classic `new Notification` path (noteicon.ts).
// Bounded; object URLs revoked on eviction and on teardown (web review #20).
const AVATARS_MAX = 24;
const avatarCache = new Map<string, string>();

function release(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function dropAvatars(): void {
  for (const url of avatarCache.values()) release(url);
  avatarCache.clear();
}

async function avatarFor(c: MatrixClient, room: Room, userId: string, gen: number): Promise<string | undefined> {
  const worker = !!noteRegistration();
  const mxc = room.getMember(userId)?.getMxcAvatarUrl() ?? c.getUser(userId)?.avatarUrl;
  if (!mxc) return undefined;
  const key = `${worker ? "d" : "b"}|${mxc}`;
  const hit = avatarCache.get(key);
  if (hit) {
    avatarCache.delete(key); // most recently used last
    avatarCache.set(key, hit);
    return hit;
  }
  try {
    const blob = await fetchMedia(mxc, { width: 96, height: 96, method: "crop" });
    if (gen !== engineGen) return undefined; // the engine stopped meanwhile: nothing new for a gone session
    const url = await noteIcon(blob, worker);
    if (!url) return undefined; // not an image, or too big for a data: URL: the app icon
    if (gen !== engineGen) {
      release(url);
      return undefined;
    }
    avatarCache.set(key, url);
    while (avatarCache.size > AVATARS_MAX) {
      const [k, old] = avatarCache.entries().next().value!;
      avatarCache.delete(k);
      release(old);
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
/** Each room's count as last OBSERVED (a held rise keeps `seen` at the alerted level; read detection needs this). */
const seenCounts = new Map<string, number>();
let seeded = false;
const fireLog: number[] = [];

function countFor(c: MatrixClient, room: Room, dms: Set<string>): number {
  const mode = roomMode(c, room.roomId, dms.has(room.roomId));
  if (mode === "mute") return 0;
  return mode === "mentions" ? highlightWithoutQuiet(c, room) : totalWithoutQuiet(c, room);
}

/** A5.4: the baseline comes from the first NETWORK sync (never the IndexedDB cache) and is taken again after a
 *  resume from suspension — until then every scan seeds silently (no replay of old messages). */
function baselineReady(): boolean {
  return getSession().liveSyncDone;
}

/** A03.0: when a rise held back by the 5 s room gap (or the cap) may fire — the engine re-scans then (null = none). */
let lastWakeAt: number | null = null;

export function scanOnce(c: MatrixClient, now = Date.now()): string[] {
  const dms = directIds(c);
  const fired: Array<{ room: Room; rise: number; isDm: boolean; highlightRose: boolean }> = [];
  const present = new Set<string>();
  const read: string[] = [];
  if (!baselineReady()) seeded = false;
  const onScreen = attendedRooms();
  const obs: Array<{ id: string; count: number; mode: Mode; attended: boolean }> = [];
  const extra = new Map<string, { room: Room; isDm: boolean; highlightRose: boolean; highlights: number }>();
  for (const room of c.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    const id = room.roomId;
    present.add(id);
    const isDm = dms.has(id);
    const mode = roomMode(c, id, isDm);
    // 12.1.17 round 2 (review #1 + launch-gate's gate row): rises, the badge and "the room was read" all use the badge's
    // count (shared vectors `counts`: only UNCOUNTED photos come off — never a thread's). The SDK's count can't say whether
    // a thread photo was read by its thread's receipt, so taking a SILENCED thread photo off as well could swallow the
    // alert of a real message after it (a read thread photo + a new message = count 1 and an alert, on both apps).
    // Silenced photos never become a notification's text (latestBody). Known limit: a thread photo that arrives already
    // listed (a catch-up) can still raise a rise here; the desktop's tally (per event) silences it.
    const badge = countsWithoutQuiet(c, room);
    const rising = mode === "mentions" ? badge.highlight : badge.total;
    const count = rising;
    const prev = seen.get(id);
    const highlights = badge.highlight;
    const highlightRose = highlights > (seenHighlights.get(id) ?? 0);
    if ((seenCounts.get(id) ?? prev?.count ?? 0) > 0 && count === 0) read.push(id); // A5.4: read → its notification goes
    seenCounts.set(id, count);
    obs.push({ id, count: rising, mode, attended: onScreen.has(id) && !threadNewsHidden(room) }); // threads: news in a hidden thread still notifies
    extra.set(id, { room, isDm, highlightRose, highlights });
  }
  const plan = planScan(seen, obs, seeded, now, fireLog);
  lastWakeAt = plan.wakeAt;
  // a HELD rise keeps its highlight baseline too: its trailing alert still knows a mention came with it (pushCovers)
  // (a held room keeps the lower of its baseline and now: a mention read meanwhile still lowers it)
  for (const o of obs) {
    const h = extra.get(o.id)!.highlights;
    const held = (seen.get(o.id)?.count ?? o.count) < o.count;
    seenHighlights.set(o.id, held ? Math.min(seenHighlights.get(o.id) ?? h, h) : h);
  }
  for (const f of plan.fires) {
    const x = extra.get(f.id)!;
    fired.push({ room: x.room, rise: f.rise, isDm: x.isDm, highlightRose: x.highlightRose });
  }
  for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
  for (const id of [...seenHighlights.keys()]) if (!present.has(id)) seenHighlights.delete(id);
  for (const id of [...seenCounts.keys()]) if (!present.has(id)) seenCounts.delete(id);
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
      const { body, sender, eventId } = toastBody(f.room, f.isDm, f.rise);
      const thread = notifyingThread(f.room); // a click opens the thread of what notified
      const roomId = f.room.roomId;
      const title = f.room.name || "Tin Hat";
      const ticket = postTicket(roomId); // 6-3: taken now, before the picture wait
      // A5.4: no timed close — a room's notification stays until the room is read
      void (sender ? avatarFor(c, f.room, sender, gen) : Promise.resolve(undefined)).then((icon) => {
        if (!isNewestPost(roomId, ticket)) return; // 6-3: a newer post of this room was planned meanwhile
        // web review #7: still the same engine + account, still wanted, the room still unread and not on screen
        if (gen !== engineGen || running?.client !== c || (getSession().userId ?? "") !== user) return;
        if (getPref("desktop-notifications", "1") === "0") return;
        const room = c.getRoom(roomId);
        if (!room || room.getMyMembership() !== "join" || countFor(c, room, directIds(c)) === 0 || (isAttended(roomId) && !threadNewsHidden(room))) return;
        const covered = pushWillCover(c, room, f.isDm, f.highlightRose);
        if (covered && pushCoversNow()) return;
        // threads: a thread reply's notification opens its thread too (the room opens first, as before)
        notifyDesktop({ title, body, icon, tag: `room:${roomId}`, room: roomId, pushCovered: covered, event: eventId, thread, onClick: thread ? () => openThread(roomId, thread) : undefined });
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
      const count = mode === "mute" ? 0 : mode === "mentions" ? highlightWithoutQuiet(c, room) : totalWithoutQuiet(c, room);
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
  seenCounts.clear();
  seeded = false;
  fireLog.length = 0;
  lastWakeAt = null;
  // A03.0: a follow-up inside a room's 5 s gap is held, not dropped — one timer re-scans when the gap (or the cap
  // window) ends, so it gets its trailing alert even when nothing else happens meanwhile
  let wakeTimer = 0;
  const scan = () => {
    try {
      const fired = scanOnce(c);
      if (fired.length) log.debug(`fired ${fired.join(",")}`); // the gates read this (debug: dev builds / #twdebug only)
    } catch (e) {
      log.warn("scan failed", e);
    }
    window.clearTimeout(wakeTimer);
    if (lastWakeAt !== null) wakeTimer = window.setTimeout(scan, Math.max(0, lastWakeAt - Date.now()) + 50);
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
      window.clearTimeout(wakeTimer);
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
  forgetPosts();
}

bus.on("loggedOut", () => stopNotifyEngine());

// ---- incoming calls (SET-58) -----------------------------------------------------------------

// The incoming-call desktop alert (SET-58) is posted by the calls engine (callwatch.ts, tag
// `incoming-call:<roomId>`, INTEGRATION #8); it reads the same `notify.calls` pref this pane writes.
