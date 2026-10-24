// providers.ts — the actions snapshot from Tin Hat Web's real state (ACTIONS.md §4.3, §14.2; the desktop builds the
// same in ActionsHost.qml). Each provider reads one store and subscribes to it; src/actions/snapshot.ts merges them and
// rebuilds only after a change, so a button re-evaluates only when something it could show changed.
//
// What is here: the global values (calls, the call UI, prefs, presence, push, update, calendar, soundboard, session,
// the window), the rooms you joined (basic values for all, the full set for the room on screen and the call's room —
// permissions, pins, recording, now playing), the spaces, your own person, the themes (built-ins, the
// library once loaded, your own), the sounds (favourites, recent, the open room's), the devices and audio sources,
// `current` (the room on screen, the active rail space). Values the web cannot know stay absent (their rules are false).
// Hook-only sources (the crypto status, the route) are bridged by ActionsStateBridge (index.tsx).
import type { JObj, Json } from "@/layout/json";
import { registerSnapshotProvider, snapshotChanged, type SnapshotPart, type SubjectEntry } from "@/actions/snapshot";
import { RoomStateEvent } from "matrix-js-sdk";
import { getPref, getPrefRaw, onPrefChange } from "@/core/prefs";
import { UNFOCUSED_SAVER_PREF, unfocusedSaverOn } from "@/core/lowgpu";
import { getFormFactor, onFormFactorChange } from "@/core/device";
import { canSendState, getCryptoStatus, getState, getStateAll, peekClient, onClientChanged, recordEnabled, useSessionStore } from "@/core/matrix";
import { isRecorder } from "@/core/server";
import { useCallStore, roomCall } from "@/features/calls";
import { useCallUi } from "@/features/callui/store";
import { callBarPinned } from "@/features/callui/chrome";
import { useNavStore, getNavMode, useUpdate, type RoomRow } from "@/features/nav";
import { usePresenceStore } from "@/features/presence";
import { usePushStore } from "@/features/push";
import { useCal } from "@/features/calendar";
import { useGames } from "@/features/calendar/gamesStore";
import { useSoundboard, useWatchParty, isSoundboardOpen, onSoundboardOpenChange } from "@/features/media";
import { PERSONAL_TYPE, ROOM_TYPE, readSound } from "@/features/media/soundboard/data";
import { useChatStore } from "@/features/chat/store";
import { useRightPanelStore } from "@/features/spaces/panelState";
import { overlayAvailable } from "@/features/settings/overlay";
import { BUILTINS } from "@/theme/engine";
import { libraryNow, loadLibrary } from "@/ui/themeLibrary";
import { currentTheme, subscribeTheme } from "@/ui/themes";
import { getThemeState, subscribeThemeState } from "@/ui/themeStore";

const PREFS = [
  "music-source", "call-layout", "call-unfocused-saver", "desktop-notifications", "gif-autoplay", "logship",
  "overlay-enabled", "record-optout", "reduce-motion", "ui-call-collapsed", "call-tileview", "nav_mode", "call-input",
  "call-output", "call-camera", "ui-call-bar-pinned",
];
const bool = (v: unknown) => v === true;

/** The room on screen (the chat's main view; null on the home page). */
export function currentRoomId(): string | null {
  return useChatStore.getState().mainRoom ?? null;
}

function rowsById(): Map<string, RoomRow> {
  const st = useNavStore.getState();
  const m = new Map<string, RoomRow>();
  for (const r of st.globalRooms) m.set(r.id, r);
  for (const r of st.rooms) if (!m.has(r.id)) m.set(r.id, r);
  return m;
}

function roomValues(id: string, row: RoomRow | undefined, full: boolean): Record<string, Json> {
  const c = useCallStore.getState();
  const room = peekClient()?.getRoom(id);
  const membership = room?.getMyMembership() ?? row?.membership ?? "";
  const v: Record<string, Json> = {
    "room.joined": membership === "join",
    "room.invited": membership === "invite",
    "room.current": id === currentRoomId(),
    "room.isDm": row?.dm === true,
    "room.favourite": row?.favourite === true,
    "room.hasUnread": (row?.unread ?? 0) > 0,
    "room.callLive": roomCall(id).active === true,
    "room.inCall": c.inCall && c.callRoomId === id,
    "room.inSpace": useNavStore.getState().roomSpace?.has(id) === true,
    "room.hasActivity": !!row?.activity,
    "room.hasJoinCode": !!row?.activity?.code,
  };
  if (row?.notifyMode) v["room.notifyMode"] = row.notifyMode;
  if (row?.activity?.game) v["room.activity"] = row.activity.game;
  const me = useSessionStore.getState().userId ?? "";
  if (row) v["room.myStatus"] = row.statuses.some((s) => s.userId === me);
  if (full && membership === "join") {
    v["room.canChangeAvatar"] = canSendState(id, "m.room.avatar");
    v["room.canChangeName"] = canSendState(id, "m.room.name");
    v["room.canChangeTopic"] = canSendState(id, "m.room.topic");
    v["room.recordOn"] = !!recordEnabled(id);
    const pinned = (getState(id, "m.room.pinned_events") as { pinned?: unknown[] } | undefined)?.pinned ?? [];
    v["room.hasPinned"] = pinned.length > 0;
    v["room.pinnedCount"] = String(pinned.length);
  }
  return v;
}

/** The call provider: every call.* value, the call UI's, and the call-shaped ui.* values. */
function callPart(): SnapshotPart {
  const c = useCallStore.getState();
  const u = useCallUi.getState();
  const sb = useSoundboard.getState();
  const phone = getFormFactor() === "mobile";
  const hidden = c.tiles.some(
    (t) =>
      t.id !== "vid_selfshare" &&
      !isRecorder(t.participant) &&
      (u.sessionHidden.includes(t.id) || (([r, tu]: [boolean, boolean]) => r && !tu)((c.recOnlyFlags?.[t.id] as [boolean, boolean] | undefined) ?? [!!t.recordingOnly, !!t.tunedIn])),
  );
  const values: Record<string, Json | undefined> = {
    "call.in": c.inCall,
    "call.connecting": c.connecting || c.reconnecting,
    "call.hangingUp": c.hangingUp === true,
    "call.aside": c.corner?.active === true,
    "call.micMuted": c.micMuted,
    "call.deafened": c.deafened,
    "call.cameraOn": c.cameraOn,
    "call.sharing": c.sharing,
    "call.shareRecOnly": c.shareRecOnly,
    "call.musicPlaying": c.musicPlaying,
    "call.gameChat": c.gameChat,
    "call.afk": c.localAfk,
    "call.recActive": c.recActive,
    "call.soundPlaying": c.soundPlaying || sb.playingUrl !== "",
    "call.soundName": sb.playingName || undefined,
    "call.hiddenTiles": hidden,
    "call.pinned": u.pinned !== null,
    "call.hasSavedAudioSource": getPref("music-source", "") !== "",
    "prefs.agc": c.micAgc,
    "prefs.echoCancel": c.micAec,
    "prefs.nsMode": c.micNsMode,
    "prefs.pushToTalk": c.pushToTalk,
    "prefs.callAnimate": u.animate,
    "ui.callMaximized": c.maximized,
    "ui.callCollapsed": getPref("ui-call-collapsed", "0") === "1" && !c.maximized,
    "ui.callShown": c.shown && currentRoomId() !== null && !(phone && u.mobileMin),
    "ui.soundboardOpen": isSoundboardOpen() || sb.playingUrl !== "",
  };
  const q = String(c.shareQuality ?? "").split(" ");
  const qk = `${q[0]}x${q[1]}@${q[2]}`;
  values["prefs.shareQuality"] = qk === "1920x1080@60" ? "smooth" : qk === "2560x1440@30" ? "sharp" : qk === "3840x2160@60" ? "max" : "custom";
  // devices and audio sources (device-local subjects; the palette lists them per picker)
  const device: Record<string, SubjectEntry> = {};
  const audioSource: Record<string, SubjectEntry> = {};
  for (const d of [...c.inputs, ...c.outputs, ...c.cameras]) device[d.id] = { name: d.name, values: {} };
  for (const s of c.audioSources ?? []) audioSource[s.id] = { name: s.name || s.id, values: {} };
  return {
    values,
    subjects: { device, audioSource },
    lists: {
      inputs: c.inputs.map((d) => d.id),
      outputs: c.outputs.map((d) => d.id),
      cameras: c.cameras.map((d) => d.id),
      audioSources: (c.audioSources ?? []).map((s) => s.id),
    },
  };
}

/** Rooms, spaces, you, `current`, the window and session values. */
function navPart(): SnapshotPart {
  const st = useNavStore.getState();
  const rows = rowsById();
  const cur = currentRoomId();
  const callRoom = useCallStore.getState().callRoomId || null;
  const room: Record<string, SubjectEntry> = {};
  for (const [id, r] of rows) {
    if (r.isSpace) continue;
    const full = id === cur || id === callRoom;
    room[id] = { name: r.name, ...(r.alias ? { alias: r.alias } : {}), values: roomValues(id, r, full) };
  }
  for (const id of [cur, callRoom]) {
    if (id && !room[id]) room[id] = { name: peekClient()?.getRoom(id)?.name ?? id, values: roomValues(id, undefined, true) };
  }
  const space: Record<string, SubjectEntry> = {};
  for (const s of st.spaces) {
    if (s.kind !== "space") continue;
    space[s.key] = { name: s.label, values: { "space.joined": s.membership === "join", "space.invited": s.membership === "invite" } };
  }
  const me = useSessionStore.getState().userId;
  const person: Record<string, SubjectEntry> = me ? { [me]: { values: { "person.me": true } } } : {};
  const ses = useSessionStore.getState();
  const cs = getCryptoStatus();
  const u = useUpdate.getState();
  const panel = useRightPanelStore.getState();
  const values: Record<string, Json | undefined> = {
    "session.busy": ses.state !== "ready",
    "ui.roomOpen": cur !== null,
    "ui.phone": getFormFactor() === "mobile",
    "ui.navCorner": getNavMode() === "corner",
    "ui.rightPanelOpen": panel.open,
    "ui.rightPanelTab": !panel.open ? "none" : panel.tab === 0 ? "info" : "members",
    "crypto.unverified": !cs.loading && cs.cryptoReady && !cs.thisDeviceVerified,
    "crypto.backup": cs.backupEnabled === true,
    "update.state": u.checking ? "checking" : u.available ? "available" : "none",
    "app.dev": /[?&]dev=1\b/.test(location.search + location.hash),
    "app.portable": false,
    "platform.windows": false,
    "platform.screenCapture": typeof navigator.mediaDevices?.getDisplayMedia === "function",
    "gif.available": true,
    "overlay.available": overlayAvailable(),
  };
  return {
    values,
    subjects: { room, space, person },
    current: { room: cur, activeSpace: st.activeKey?.startsWith("!") ? st.activeKey : null },
    lists: { room: st.globalRooms.filter((r) => !r.isSpace).map((r) => r.id), space: st.spaces.filter((s) => s.kind === "space").map((s) => s.key) },
  };
}

function prefsPart(): SnapshotPart {
  const tv = getPref("call-tileview", {} as Record<string, unknown>) as Record<string, { mode?: string } | undefined>;
  return {
    values: {
      "prefs.callLayout": getPref("call-layout", "auto"),
      // 10.8.1: Settings → Appearance → Performance, default OFF (the shared rule; absent = off)
      "prefs.callUnfocusedSaver": unfocusedSaverOn(getPrefRaw(UNFOCUSED_SAVER_PREF)),
      // 11.0.2: "Keep call buttons visible" (callui/chrome.ts; only "1" is on, default off)
      "prefs.callBarPinned": callBarPinned(),
      "prefs.desktopNotifications": getPref("desktop-notifications", "1") !== "0",
      "prefs.gifAutoplay": getPref("gif-autoplay", "1") !== "0",
      "prefs.logship": getPref("logship", "") === "1",
      "prefs.overlay": getPref("overlay-enabled", "0") === "1",
      "prefs.recordOptOut": getPref("record-optout", "0") === "1",
      "prefs.reduceMotion": bool(getPref("reduce-motion", false)) || getPref("reduce-motion", "") === "1",
      "ui.selfPip": tv?._self?.mode !== "grid",
    },
  };
}

function presencePart(): SnapshotPart {
  const p = usePresenceStore.getState();
  const push = usePushStore.getState();
  return {
    values: {
      "presence.known": p.known,
      "presence.sharing": p.share && !p.turningOff,
      "presence.busy": p.busy,
      "presence.hasStatus": p.status !== null,
      "push.available": push.support?.ok === true,
      "push.enabled": push.phase === "on",
    },
  };
}

function wpHost(): { in: boolean; host: string; me: string } {
  const st = useWatchParty.getState();
  return { in: st.inParty === true, host: st.party.hostId || "", me: peekClient()?.getUserId() ?? "" };
}
function wpCanControl(): boolean {
  const h = wpHost();
  return h.in && (!h.host || h.host === h.me);
}
function wpIsHost(): boolean {
  const h = wpHost();
  return h.in && !!h.host && h.host === h.me;
}

function calendarPart(): SnapshotPart {
  const cal = useCal.getState();
  return {
    values: {
      "calendar.hasContainer": cal.containerId !== "",
      "calendar.reminders": cal.remindersOn,
      "ui.calendarOpen": cal.windowOpen,
      "ui.reelOpen": useGames.getState().windowOpen,
      "watchParty.in": useWatchParty.getState().inParty === true,
      // 11.4 (Media Party): with a host set only the host drives; no host = open floor
      "watchParty.canControl": wpCanControl(),
      "watchParty.isHost": wpIsHost(),
    },
  };
}

/** The themes a button or the palette may name: the built-ins, the library (once loaded), your own. */
function themePart(): SnapshotPart {
  const theme: Record<string, SubjectEntry> = {};
  const order: string[] = [];
  const add = (id: string, name: string) => {
    if (theme[id]) return;
    theme[id] = { name, values: {} };
    order.push(id);
  };
  for (const [id, doc] of Object.entries(BUILTINS)) add(id, (doc as { name?: string }).name ?? id);
  for (const m of getThemeState().myThemes) add(m.id, (m.doc as { name?: string }).name ?? m.id);
  const lib = libraryNow();
  if (lib) for (const e of lib.all) add(e.id, e.name);
  return { values: { "prefs.theme": currentTheme() as string }, subjects: { theme }, lists: { theme: order } };
}

/** The sounds a button or the palette may name: your favourites, the recent ones, the open room's. */
function soundPart(): SnapshotPart {
  const sb = useSoundboard.getState();
  const sound: Record<string, SubjectEntry> = {};
  const order: string[] = [];
  const add = (url: string, name: string) => {
    if (!url || sound[url]) return;
    sound[url] = { name, values: { "sound.playing": sb.playingUrl === url } };
    order.push(url);
  };
  const client = peekClient();
  const personal = (client?.getAccountData(PERSONAL_TYPE as never)?.getContent() as { sounds?: unknown[] } | undefined)?.sounds ?? [];
  for (const raw of personal) {
    const s = readSound(raw);
    if (s) add(s.sourceUrl, s.name);
  }
  for (const r of sb.recent ?? []) add(r.url, r.name);
  const cur = currentRoomId();
  if (cur) for (const t of getStateAll(cur, ROOM_TYPE)) {
    const s = readSound(t.content);
    if (s) add(s.sourceUrl, s.name);
  }
  return { subjects: { sound }, lists: { sound: order } };
}

/** Room state events (power levels, pins, recording) — the nav store does not rebuild on them. Follows
 *  the client across sign-in / sign-out. */
function onRoomState(cb: () => void): () => void {
  let cur: ReturnType<typeof peekClient> = null;
  const attach = () => {
    cur?.off(RoomStateEvent.Events, cb);
    cur = peekClient();
    cur?.on(RoomStateEvent.Events, cb);
    cb();
  };
  attach();
  const off = onClientChanged(attach);
  return () => {
    off();
    cur?.off(RoomStateEvent.Events, cb);
  };
}

/** Install every provider (once, from the feature's setup). */
export function installProviders(): void {
  const both = (subs: ((cb: () => void) => () => void)[]) => (changed: () => void) => {
    const offs = subs.map((s) => s(changed));
    return () => offs.forEach((o) => o());
  };
  const prefSubs = PREFS.map((k) => (cb: () => void) => onPrefChange(k, cb));
  registerSnapshotProvider("calls", callPart, both([useCallStore.subscribe, useCallUi.subscribe, useSoundboard.subscribe, onFormFactorChange, onSoundboardOpenChange as never, ...prefSubs]));
  registerSnapshotProvider("nav", navPart, both([useNavStore.subscribe, useChatStore.subscribe, useCallStore.subscribe, useSessionStore.subscribe, useUpdate.subscribe, useRightPanelStore.subscribe, onFormFactorChange, onRoomState, ...prefSubs]));
  registerSnapshotProvider("prefs", prefsPart, both(prefSubs));
  registerSnapshotProvider("presence", presencePart, both([usePresenceStore.subscribe, usePushStore.subscribe]));
  registerSnapshotProvider("calendar", calendarPart, both([useCal.subscribe, useGames.subscribe, useWatchParty.subscribe]));
  registerSnapshotProvider("themes", themePart, both([subscribeTheme, subscribeThemeState]));
  registerSnapshotProvider("sounds", soundPart, both([useSoundboard.subscribe, useChatStore.subscribe, onRoomState]));
  // the library is fetched once; the themes provider re-reads it when it lands
  void loadLibrary().then(() => snapshotChanged()).catch(() => {});
}

export type { JObj };
