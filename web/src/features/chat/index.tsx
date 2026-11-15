// features/chat — the room page, the conversation (timeline model + composer), floating chats,
// lightbox, emoji/GIF pickers. Spec: tw-spec/chat.md.
//
// Shell contract (app/Shell.tsx):
//   RoomPage            the whole room page (Main.qml roomPage): RoomHeaderBar (hidden while the call
//                       fills the app), the join-call banner + r.roomBanners, `callSlot`, then the
//                       body row: ConversationView + `rightPanelSlot`. `leftInset` = 46 in corner-nav
//                       mode. Phones: `mobile` + `onBack` (header back chevron → the room list).
//   FloatingChatsLayer  popped-out chats (FloatingChats.qml) — always mounted by the shell.
//   HeaderIsland, TimelineIsland  11.0 (islands C6/C7): the desktop dock host's `header` and `timeline` islands (the
//                       timeline's composer section renders into the `composer` island through `composerHost`).
//
// Other features:
//   ConversationView (reusable host), Lightbox (bus openLightbox), EmojiPicker (reusable popover),
//   jumpTo / focusComposer / stageFiles / openFloatingChat / isRoomAttended / showsRoom / onAttendedRoom; setPinned /
//   canPin (widgets W1).
//   Bus: openFloatingChat {roomId}, jumpToEvent {roomId,eventId}, stageFiles {files}, openThread {roomId, eventId = the
//   thread's root} (threads: the room + its Threads panel on that thread).
//   Registries hosted here: r.roomHeaderActions (native order: game reel 10, calendar 20, memories 30,
//   call 40 [chat], gear 50, info 60 [chat]), r.roomBanners, r.composerActions (emoji/GIF are built in
//   before them, pins after; soundboard = 30 from media), r.messageMenu (appended after Copy link,
//   before Delete), r.timelineRenderers (a match inside a bubble replaces the text: calendar card).
import type { FeatureModule } from "@/core/registry";
import { bus, openRoom } from "@/core/bus";
import { parseHash } from "@/app/router";
import { ThreadsPane } from "./threads/ThreadsPane";
import { ThreadsHeaderButton } from "./threads/HeaderButton";
import { installThreadReceipts } from "./threads/receipts";
import { openThreadPanel } from "./threads/open";
import { THREADS_TAB } from "./threads/state";
import { onSyncOk } from "@/core/matrix";
import { resendAfterReconnect } from "./actions";
import { CallHeaderButton, InfoHeaderButton } from "./RoomPage";
import { Lightbox } from "./Lightbox";
import { LinkConfirm } from "./linkconfirm";
import { closeFloatingChat, getView, mainView, openFloatingChat, restoreChatMemory, useChatStore } from "./store";
import { installVoiceHook, wireVoice } from "./voicenote/wire";
import { BackgroundSheetHost, openBackgroundSheet } from "./ambience/BackgroundSheet";
import { particlesSubmenu } from "./ambience/particlesMenu";
import { AMBIENCE_WORDS } from "./ambience/words";
import { peekClient } from "@/core/matrix";

export type { RoomPageProps } from "./types";
export { RoomPage, RoomHeaderBar, HeaderIsland, TimelineIsland } from "./RoomPage";
export { FloatingChatsLayer } from "./FloatingChats";
export { ConversationView } from "./ConversationView";
export { Lightbox } from "./Lightbox";
export { EmojiPicker } from "./EmojiPicker";
export { openFloatingChat, closeFloatingChat } from "./store";
export { markdownToHtml, textContent } from "./lib/markdown";
export { renderFormatted } from "./lib/html";
// widgets W1 (Pinned): the pin / unpin write and its permission, the same the message menu uses
export { setPinned, canPin } from "./actions";
// widgets W3 (Dice): the room's loaded timeline (the dice history reads the room's dice messages from it)
export { useRoomTimeline } from "./useRoomTimeline";
// widgets W3 (Polls): the gates' sample polls bring their own responses and ends
export { sampleRelations } from "./lib/samples";

/** Scroll the open conversation of `roomId` (main view or its floating chat) to an event + flash. */
export function jumpTo(roomId: string, eventId: string): void {
  const st = useChatStore.getState();
  if (st.mainRoom === roomId) mainView()?.jumpTo(eventId);
  else getView(`float:${roomId}`)?.jumpTo(eventId);
}
export function focusComposer(): void {
  mainView()?.focusComposer();
}
export function stageFiles(files: File[]): void {
  mainView()?.stageFiles(files);
}
/** The main view shows `roomId` (widgets W1: Pinned / Mentions jump in place instead of re-routing). */
export function showsRoom(roomId: string): boolean {
  return useChatStore.getState().mainRoom === roomId;
}
/** Follow the room the main view shows in a focused window (null = none): `cb` now and on every change (widgets W1:
 *  Mentions marks a shown room's mentions seen). Returns the unsubscribe. */
export function onAttendedRoom(cb: (roomId: string | null) => void): () => void {
  let last: string | null | undefined;
  const fire = () => {
    const st = useChatStore.getState();
    const r = st.mainAttending ? st.mainRoom : null;
    if (r === last) return;
    last = r;
    cb(r);
  };
  fire();
  return useChatStore.subscribe(fire);
}
/** CHAT-128: the room is on screen in a focused window (notifications for it are suppressed). */
export function isRoomAttended(roomId: string): boolean {
  const st = useChatStore.getState();
  return st.mainRoom === roomId && st.mainAttending;
}

export const feature: FeatureModule = {
  id: "chat",
  setup(r) {
    r.roomHeaderActions.add({ id: "chat-call", order: 40, component: CallHeaderButton });
    // after callui's call (70) + gear (80): native order reel · calendar · memories · call · gear · info
    r.roomHeaderActions.add({ id: "chat-info", order: 90, component: InfoHeaderButton });
    // threads (docs/THREADS.md): the header's Threads button (before info) and the right panel's Threads tab
    r.roomHeaderActions.add({ id: "chat-threads", order: 85, component: ThreadsHeaderButton });
    r.rightPanelTabs.add({ id: THREADS_TAB, order: 10, title: "Threads", icon: "dialog-messages-symbolic", component: ThreadsPane });
    installThreadReceipts();
    r.overlays.add({ id: "chat-lightbox", order: 50, component: Lightbox });
    r.overlays.add({ id: "chat-link-confirm", order: 51, component: LinkConfirm });
    // the room's shared background (docs/AMBIENCE.md): everyone in the room can look, moderators change it
    r.overlays.add({ id: "chat-background", order: 52, component: BackgroundSheetHost });
    r.roomMenu.add({
      id: "chat.background",
      order: 85,
      label: AMBIENCE_WORDS.menu,
      icon: "insert-image-symbolic",
      visible: (c) => peekClient()?.getRoom(c.roomId)?.getMyMembership() === "join",
      run: (c) => openBackgroundSheet(c.roomId),
    });
    // the ☰ app menu's Particles ▸ (round 4, P-A7), right after Theme (60): the room's effect + the two personal switches
    r.appMenu.add({ id: "chat.particles", order: 65, label: AMBIENCE_WORDS.particles, icon: "video-display-brightness-symbolic", submenu: () => particlesSubmenu(), run: () => {} });
    r.onReady.add({ id: "chat-drafts", order: 0, run: () => restoreChatMemory() });
    bus.on("openFloatingChat", ({ roomId }) => openFloatingChat(roomId));
    bus.on("jumpToEvent", ({ roomId, eventId }) => jumpTo(roomId, eventId));
    // threads: open the room (when it isn't the one shown) and its thread in the Threads panel (a notification's click)
    bus.on("openThread", ({ roomId, eventId, focus }) => {
      // the address already names the room (a #/room/…?thread= deep link mounting it): no second navigation
      const r = parseHash(location.hash);
      const routed = r.name === "room" && r.target === roomId;
      if (useChatStore.getState().mainRoom !== roomId && !routed) openRoom(roomId);
      openThreadPanel(roomId, eventId, null, focus ?? "");
    });
    bus.on("stageFiles", ({ files }) => stageFiles(files));
    wireVoice(); // voice notes (docs/VOICE-NOTES.md): the draft store ↔ recorder, upload, send, call join, sign-out
    // L1 D08.2: every good sync (the first after an outage included): what failed for lack of connection sends itself
    // again (actions.ts resendAfterReconnect; a few times at most, lib/resend.ts MAX_AUTO_TRIES)
    onSyncOk(() => void resendAfterReconnect());
    // dev/QA hooks (tools/chat-shots.mjs)
    const w = window as unknown as Record<string, unknown>;
    if (import.meta.env.DEV || w.__TW_DEBUG__) {
      w.__tw_stage = (files: File[]) => stageFiles(files);
      w.__tw_openFloating = (id: string) => openFloatingChat(id);
      w.__tw_closeFloating = (id: string) => closeFloatingChat(id);
      installVoiceHook(); // window.__twVoice (voicenote/wire.ts)
    }
  },
};
