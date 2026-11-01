// exec.ts — what each action DOES in Tin Hat Web (ACTIONS.md §14.1; the desktop's map is ActionsHost.qml): one
// handler per placeable web action, each calling the command the app already has — the call engine's toggles, the
// windows, the soundboard, the menus. src/actions/run.ts calls a handler only after presenting the action against the
// live snapshot (unavailable → nothing runs), picking its target when it has none (the palette's stage 2, or the
// host's own picker = the handler with no subject) and asking the table's confirm. So a handler never asks again:
// where the app's own path shows a confirm, the handler calls the step after it (leaveRoom, not the "Leave room?"
// dialog). Context-only actions (a message's, a tile's, the composer's) run through the surface that provides their
// context (Invocation.handler); they have no global handler.
import { bus, openAbout, openBugReport, openShortcuts, openVerify, openWindow, openSettings, requestSignOut, toast } from "@/core/bus";
import { getPref, getPrefRaw, setPref } from "@/core/prefs";
import { UNFOCUSED_SAVER_PREF, unfocusedSaverOn } from "@/core/lowgpu";
import { logout, peekClient } from "@/core/matrix";
import { registries } from "@/core/registry";
import { isRetiredAction } from "@/core/server";
import { registerActionHandler, type Handler, type RunCtx } from "@/actions/run";
import { getActionsSnapshot } from "@/actions/snapshot";
import { recClipRoom } from "@/actions/decisions";
import { actionById, TABLE } from "@/actions/table";
import { useCallStore, flipCamera } from "@/features/calls";
import { useCallUi } from "@/features/callui/store";
import { setUiState } from "@/features/callui/store";
import { openCallDevicesMenu } from "@/features/callui";
import { showAllAndForget, showTile } from "@/features/callui/memory";
import { callBarPinned, setCallBarPinned } from "@/features/callui/chrome";
import {
  openRoomId, openNavDialog, openQuickSwitcher, selectSpace, refreshNav, markRoomRead, markSpaceRead, messageUser,
  toggleSidebar, useUpdate, checkForUpdates, startTour, useNavStore,
} from "@/features/nav";
import { stepRoom } from "@/features/nav/open";
import { leaveRoom, removeRoomPhoto, setNotifyMode } from "@/features/nav/actions";
import { usePresenceStore, turnSharingOn, turnSharingOff, setMyStatus, STATUS_PRESETS } from "@/features/presence";
import { usePushStore, enablePush, disablePush } from "@/features/push";
import { openCalendar, openGameReel, startNew, useCal } from "@/features/calendar";
import { applyReminders } from "@/features/calendar/calendarStore";
import { requestNotifyPermission } from "@/features/calendar/reminders";
import {
  openSoundboard, stopSoundboardSound, openWatchParty, openMemories, setRecordCall, clipMoment,
  openMusicUrlPrompt, pickMusicFile,
} from "@/features/media";
import { toggleSound } from "@/features/media/soundboard/store";
import { leaveParty } from "@/features/media/watchparty/engine";
import { openFloatingChat } from "@/features/chat";
import { toggleEditMode, useEdit } from "@/features/editmode/store";
import { closeDrawer, toggleDrawer } from "@/features/editmode/drawerRun";
import { toggleRightPanel, openRightPanel, setActivity, postStatus, openSpaceSettings } from "@/features/spaces";
import { requestNotificationPermission } from "@/features/settings";
import { closeOverlayWindow, openOverlayWindow } from "@/features/settings/overlay";
import { BUILTINS } from "@/theme/engine";
import { libraryDoc } from "@/ui/themeLibrary";
import { chooseTheme, getThemeState } from "@/ui/themeStore";
import { copyText } from "@/features/nav/actions";
import { currentRoomId } from "./providers";
import { nativeShareOn } from "@/features/native";
import { pressPad } from "@/features/pad/Entry";
import { targetsIn } from "@/features/pad/runtime";

const c = () => useCallStore.getState();
const flip = (key: string, def: string) => setPref(key, getPref(key, def) === "1" ? "0" : "1");
const onOff = (key: string, on: boolean) => setPref(key, on ? "1" : "0");
/** The room an action acts on: its resolved subject, else the room on screen. */
const roomOf = (ctx: RunCtx): string | null => ctx.subject ?? currentRoomId();
const nameOf = (kind: string, id: string | null): string => {
  if (!id) return "";
  const subj = getActionsSnapshot().subjects as Record<string, Record<string, { name?: string }>> | undefined;
  return subj?.[kind]?.[id]?.name ?? peekClient()?.getRoom(id)?.name ?? id;
};
const param = (ctx: RunCtx, k: string): string | undefined => {
  const v = ctx.params[k];
  return typeof v === "string" ? v : undefined;
};
const surface = (id: "appMenu" | "status" | "callHealth" | "gamePopup" | "hiddenStreams" | "roomFilter" | "jumpToLatest", ctx: RunCtx) =>
  bus.emit("openSurface", { id, anchor: ctx.anchor ?? null });
const SHARE_PRESETS: Record<string, [number, number, number, number]> = {
  smooth: [1920, 1080, 60, 8000],
  sharp: [2560, 1440, 30, 12000],
  max: [3840, 2160, 60, 24000],
};

/** id → handler (every placeable action whose apps include "web"; actions.test.ts checks the coverage). */
export const HANDLERS: Record<string, Handler> = {
  // ---- app ----
  "app.about": () => openAbout(),
  "app.bugReport": () => openBugReport(),
  "app.gifAutoplay.toggle": () => setPref("gif-autoplay", getPref("gif-autoplay", "1") !== "0" ? "0" : "1"),
  "app.iconGallery": () => openWindow("iconGallery"),
  // unavailable on the web (when: not platform.web) — never runs
  "app.logship.toggle": () => {},
  "app.menu.open": (ctx) => surface("appMenu", ctx),
  "app.notifications.toggle": () => {
    const on = getPref("desktop-notifications", "1") === "0";
    onOff("desktop-notifications", on);
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") void requestNotificationPermission();
  },
  "app.recordOptOut.toggle": () => flip("record-optout", "0"),
  "app.reduceMotion.toggle": () => setPref("reduce-motion", !(getPref("reduce-motion", false) === true || getPref("reduce-motion", "") === "1")),
  "app.rooms.refresh": () => refreshNav(),
  "app.settings.open": (ctx) => openSettings(param(ctx, "pane")),
  "app.shortcuts.open": () => openShortcuts(),
  "app.sidebar.toggle": () => toggleSidebar(),
  // the table asked "Sign out?" (with the no-backup variant) — sign out now
  "app.signOut": () => void logout({ status: "Signed out" }),
  "app.theme.set": (ctx) => {
    const id = ctx.subject;
    if (!id) return;
    const doc = BUILTINS[id] ?? libraryDoc(id) ?? getThemeState().myThemes.find((m) => m.id === id)?.doc;
    if (doc) chooseTheme(doc);
    else toast(`The theme "${id}" is not here any more`, { kind: "error" });
  },
  "app.tour.start": () => startTour(true),
  "app.update": () => (useUpdate.getState().available ? location.reload() : void checkForUpdates(true)),
  "app.verify": () => openVerify(),
  // ---- calendar ----
  "calendar.event.new": () => {
    openCalendar();
    startNew(useCal.getState().selectedDay);
  },
  "calendar.open": (ctx) => openCalendar(ctx.subject ? { containerId: ctx.subject } : {}),
  "calendar.reminders.toggle": () => {
    const on = !useCal.getState().remindersOn;
    applyReminders(on);
    if (on) void requestNotifyPermission();
  },
  // ---- calls ----
  "call.afk.toggle": () => c().setAfk(!c().localAfk),
  "call.agc.toggle": () => c().applyMicAgc(!c().micAgc),
  "call.audioShare.source": (ctx) => {
    if (ctx.subject) c().startMusicSource(ctx.subject);
  },
  "call.audioShare.toggle": () => {
    const saved = getPref("music-source", "");
    if (c().musicPlaying) c().stopMusic();
    else if (saved) c().startMusicSource(saved);
    else useCallUi.getState().set({ streamPop: true, optsFace: null });
  },
  "call.camera.flip": () => void flipCamera(),
  "call.camera.set": (ctx) => c().setCamera(ctx.subject ?? ""),
  "call.camera.toggle": () => c().toggleCamera(),
  // product decision (1), decisions.ts REC_CLIP_ROOM: the call's room (also while another room is on screen)
  "call.clip": () => {
    const room = recClipRoom(c().callRoomId, currentRoomId());
    if (room) void clipMoment(room);
  },
  "call.collapse.toggle": () => flip("ui-call-collapsed", "0"),
  "call.corner.leave": () => c().leaveCorner(),
  "call.deafen.toggle": () => c().applyDeafen(!c().deafened),
  "call.devices.open": (ctx) => openCallDevicesMenu(ctx.anchor ?? null, (ctx.context?.room as string | undefined) ?? c().callRoomId ?? currentRoomId() ?? undefined),
  "call.echoCancel.toggle": () => c().applyMicAec(!c().micAec),
  // the web has no speaker-output picker of its own (WEB-EXCEPTIONS): Settings → Audio is the nearest
  "call.echoOutputs.open": () => openSettings("audio"),
  "call.fill.toggle": () => setUiState({ maximized: !c().maximized }),
  "call.gameChat.toggle": () => c().applyGameChat(!c().gameChat),
  "call.health.open": (ctx) => surface("callHealth", ctx),
  "call.hidden.show": (ctx) => {
    const id = (ctx.context?.tile as string | undefined) ?? ctx.subject;
    const t = id ? c().tiles.find((x) => x.id === id) : undefined;
    if (!t) return surface("hiddenStreams", ctx);
    if (t.recordingOnly && !t.tunedIn) c().setTileTunedIn(t.id, true);
    else showTile(t);
  },
  "call.hidden.showAll": () => showAllAndForget(),
  "call.input.set": (ctx) => c().setInput(ctx.subject ?? ""),
  "call.join": (ctx) => {
    const room = roomOf(ctx);
    if (room) c().switchCall(room);
  },
  // 12.0.2 Pad (docs/PAD.md): the Pad button beside Join (features/pad Entry.tsx pressPad) for the target room's call
  "call.pad.open": (ctx) => {
    const room = roomOf(ctx);
    if (room) pressPad(room, targetsIn(room));
  },
  // 11.0.2: "Keep call buttons visible" — the bar's pin and Settings → Calls do the same (callui/chrome.ts)
  "call.bar.pin.toggle": () => setCallBarPinned(!callBarPinned()),
  "call.layout.animate.toggle": () => {
    const u = useCallUi.getState();
    u.set({ animate: !u.animate });
  },
  "call.layout.set": (ctx) => {
    const v = param(ctx, "value");
    if (v) setPref("call-layout", v);
  },
  "call.leave": () => c().leaveCall(),
  "call.mic.toggle": () => {
    const s = c();
    if (s.serverMuted) toast(`${s.serverMutedBy || "A moderator"} muted your mic for everyone — ask them to unmute you`, { timeoutMs: 3000 });
    else s.toggleMic();
  },
  "call.micCheck": (ctx) => useCallUi.getState().set({ optsFace: "mic", optsAnchor: ctx.anchor ?? null, streamPop: false }),
  "call.music.file": () => pickMusicFile(),
  "call.music.url": () => openMusicUrlPrompt(),
  "call.noiseSuppression.set": (ctx) => {
    const v = param(ctx, "value");
    if (v === "off" || v === "standard" || v === "strong") c().applyMicNsMode(v);
  },
  "call.noiseTest.open": () => bus.emit("openNoiseTest", {}),
  "call.options.open": (ctx) => {
    const v = param(ctx, "value");
    if (v === "mic" || v === "speaker" || v === "camera") useCallUi.getState().set({ optsFace: v, optsAnchor: ctx.anchor ?? null, streamPop: false });
  },
  "call.output.set": (ctx) => c().setOutput(ctx.subject ?? ""),
  "call.overlay.toggle": () => {
    const on = getPref("overlay-enabled", "0") !== "1";
    onOff("overlay-enabled", on);
    if (on) void openOverlayWindow();
    else closeOverlayWindow();
  },
  "call.pin.clear": () => useCallUi.getState().set({ pinned: null }),
  // a hold action: the button's press and release (ActionButton) — never from the palette
  "call.pushToTalk.hold": (ctx) => c().pttHold(ctx.hold !== "up"),
  "call.pushToTalk.toggle": () => c().applyPushToTalk(!c().pushToTalk),
  "call.screenShare.toggle": () => (c().sharing ? c().stopScreen() : nativeShareOn() ? c().shareScreen() : useCallUi.getState().set({ streamPop: true, optsFace: null })),
  "call.share.panel": () => {
    const u = useCallUi.getState();
    u.set({ streamPop: !u.streamPop, optsFace: null });
  },
  "call.share.recordingOnly.toggle": () => c().applyShareRecordingOnly(!c().shareRecOnly),
  "call.shareQuality.set": (ctx) => {
    const p = SHARE_PRESETS[param(ctx, "value") ?? ""];
    if (p) c().applyShareQuality(...p);
  },
  "call.testConnection": () => c().runConnectionTest(),
  // 10.8.1: the app-wide option (Settings → Appearance → Performance), default OFF — the shared rule, never a default of on
  "call.unfocusedSaver.toggle": () => setPref(UNFOCUSED_SAVER_PREF, unfocusedSaverOn(getPrefRaw(UNFOCUSED_SAVER_PREF)) ? "0" : "1"),
  // ---- navigation ----
  "conversation.jumpToLatest": (ctx) => surface("jumpToLatest", ctx),
  // 11.0 edit mode (EDITMODE-UI.md §1): open it (the phone form: the phone editor), or Done while it is open
  "layout.edit": () => toggleEditMode(),
  // a drawer's button (feat/editmode-buttons-drawers, EDITMODE-UI §7.3): its island in a drawer under it, or closed
  // — nothing while edit mode is open (it shows every island where it is; no drawers there)
  "layout.drawer.toggle": (ctx) => {
    if (useEdit.getState().session) return;
    if (ctx.subject) toggleDrawer(ctx.subject, ctx.anchor);
    else closeDrawer();
  },
  "nav.quickSwitcher.open": () => openQuickSwitcher(),
  "nav.room.next": () => stepRoom(1, false),
  "nav.room.previous": () => stepRoom(-1, false),
  "nav.room.open": (ctx) => {
    if (ctx.subject) openRoomId(ctx.subject);
  },
  "nav.roomList.filter": (ctx) => surface("roomFilter", ctx),
  "nav.space.select": (ctx) => {
    const key = param(ctx, "rail") ?? ctx.subject;
    if (key) selectSpace(key);
  },
  "nav.unread.next": () => stepRoom(1, true),
  "nav.unread.previous": () => stepRoom(-1, true),
  // ---- rooms ----
  "dm.new": () => openNavDialog({ kind: "newChat" }),
  "person.message": (ctx) => {
    if (ctx.subject) void messageUser(ctx.subject);
  },
  "room.create": () => bus.emit("openNavDialog", { kind: "newRoom" }),
  "room.favourite.toggle": (ctx) => {
    const room = roomOf(ctx);
    if (room) registries.roomMenu.get("nav.favourite")?.run({ roomId: room });
  },
  "room.info.edit": () => openRightPanel("info"),
  "room.info.toggle": () => toggleRightPanel(),
  "room.invite": (ctx) => {
    const room = roomOf(ctx);
    if (room) openNavDialog({ kind: "invite", roomId: room, name: nameOf("room", room) });
  },
  "room.inviteLink.copy": (ctx) => {
    const room = roomOf(ctx);
    if (room) registries.roomMenu.get("nav.copyInvite")?.run({ roomId: room });
  },
  // the table asked "Leave room?" for a joined room (an invite is declined without asking)
  "room.leave": async (ctx) => {
    const room = roomOf(ctx);
    if (!room) return;
    const wasOpen = room === currentRoomId();
    if ((await leaveRoom(room)) && wasOpen) location.hash = "#/home";
  },
  "room.markRead": (ctx) => {
    const room = roomOf(ctx);
    if (room) void markRoomRead(room);
  },
  "room.members.show": () => openRightPanel("members"),
  "room.notifications.set": (ctx) => {
    const room = roomOf(ctx);
    const v = param(ctx, "value");
    if (!room || (v !== "all" && v !== "mentions" && v !== "mute")) return;
    const row = useNavStore.getState().globalRooms.find((r) => r.id === room);
    void setNotifyMode(room, v, row?.notifyMode ?? "mentions");
  },
  "room.photo.change": (ctx) => {
    const room = roomOf(ctx);
    if (room) registries.roomMenu.get("nav.changePhoto")?.run({ roomId: room });
  },
  // the table asked "Remove the room photo?" (11.0: this had no confirm)
  "room.photo.remove": (ctx) => {
    const room = roomOf(ctx);
    if (room) void removeRoomPhoto(room);
  },
  "room.popOut": (ctx) => {
    const room = roomOf(ctx);
    if (room) openFloatingChat(room);
  },
  // the table asked "Record calls here?" when turning it on — no second confirm
  "room.recording.toggle": (ctx) => {
    const room = roomOf(ctx);
    if (!room) return;
    const snap = getActionsSnapshot().subjects as Record<string, Record<string, { values?: Record<string, unknown> }>>;
    const on = snap?.room?.[room]?.values?.["room.recordOn"] === true;
    void setRecordCall(room, !on);
  },
  "room.refresh": (ctx) => {
    const room = roomOf(ctx);
    if (!room) return;
    void peekClient()?.getRoom(room)?.loadMembersIfNeeded();
    toast("Refreshing this room…", { timeoutMs: 2000 });
  },
  "room.status.clear": (ctx) => {
    const room = roomOf(ctx);
    if (room) void postStatus(room, "", 0);
  },
  "room.status.post": (ctx) => {
    const room = roomOf(ctx);
    const text = param(ctx, "text");
    if (room && text) void postStatus(room, text, 30);
    else openRightPanel("members");
  },
  "space.create": () => bus.emit("openNavDialog", { kind: "newSpace" }),
  "space.invite": (ctx) => {
    if (ctx.subject) openNavDialog({ kind: "invite", roomId: ctx.subject, name: nameOf("space", ctx.subject) });
  },
  "space.joinOrCreate": () => openNavDialog({ kind: "joinSpace" }),
  // the table asked "Leave space?"
  "space.leave": (ctx) => {
    if (ctx.subject) void leaveRoom(ctx.subject);
  },
  "space.link.copy": (ctx) => {
    if (ctx.subject) registries.spaceMenu.get("nav.copySpaceLink")?.run({ spaceId: ctx.subject, label: nameOf("space", ctx.subject) });
  },
  "space.markAllRead": (ctx) => {
    if (ctx.subject) void markSpaceRead(ctx.subject, nameOf("space", ctx.subject));
  },
  "space.settings.open": (ctx) => {
    if (ctx.subject) openSpaceSettings(ctx.subject, param(ctx, "tab"));
  },
  // ---- fun ----
  "memories.open": (ctx) => {
    const room = roomOf(ctx);
    if (room) openMemories(room);
  },
  "reel.open": () => openGameReel(),
  "room.activity.clear": (ctx) => {
    const room = roomOf(ctx);
    if (room) void setActivity(room, "");
  },
  "room.activity.open": (ctx) => surface("gamePopup", ctx),
  "room.activity.set": (ctx) => {
    const room = roomOf(ctx);
    if (!room) return;
    const game = param(ctx, "game");
    if (game) void setActivity(room, game);
    else openNavDialog({ kind: "nowPlaying", roomId: room, name: nameOf("room", room) });
  },
  "sound.play": (ctx) => {
    if (ctx.subject) toggleSound(ctx.subject, nameOf("sound", ctx.subject), "");
  },
  "sound.stop": () => {
    stopSoundboardSound();
    c().stopSound();
  },
  "soundboard.open": () => openSoundboard(),
  "watchParty.leave": () => leaveParty(),
  "watchParty.open": (ctx) => {
    const room = roomOf(ctx);
    if (room) openWatchParty(room);
  },
  // ---- you ----
  "presence.sharing.toggle": () => void (usePresenceStore.getState().share ? turnSharingOff() : turnSharingOn()),
  "push.enable": () => void (usePushStore.getState().phase === "on" ? disablePush() : enablePush()),
  "status.clear": () => void setMyStatus(null),
  "status.open": (ctx) => surface("status", ctx),
  // the table asked "Show your status to friends?" when sharing is off: turn it on, then set the status
  "status.set": async (ctx) => {
    const id = param(ctx, "status");
    if (!id) return;
    if (!usePresenceStore.getState().share) await turnSharingOn();
    if (id === "custom") {
      const text = param(ctx, "text");
      if (!text) return surface("status", ctx);
      await setMyStatus({ id: "custom", text, emoji: param(ctx, "emoji") ?? "", color: param(ctx, "colour") ?? "", until: 0 } as never);
      return;
    }
    const p = STATUS_PRESETS.find((x) => x.id === id);
    if (p) await setMyStatus({ id: p.id, text: p.text, emoji: p.emoji, color: p.color, until: Date.now() + 4 * 3600e3 } as never);
  },
};

/** The web actions that have no global handler on purpose: context-only ones (their surface runs them), pending ones. */
export function exempt(id: string): boolean {
  const a = actionById(id);
  // a retired action (core/server offer.ts: the per-room guest link, replaced by the guest room) is never offered
  return !a || !!a.contexts || a.pending !== undefined || isRetiredAction(id);
}

/** Register every handler (the feature's setup). */
export function installHandlers(): void {
  for (const [id, fn] of Object.entries(HANDLERS)) registerActionHandler(id, fn);
}

/** For the coverage test: the placeable web actions without a handler (must be none). */
export function missingHandlers(): string[] {
  return TABLE.actions.filter((a) => a.apps.includes("web") && !exempt(a.id) && !HANDLERS[a.id]).map((a) => a.id);
}

export { requestSignOut };
