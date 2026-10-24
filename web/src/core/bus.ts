// bus.ts — typed app-wide pub/sub for cross-feature intents (no imports between features).
//
//   import { bus, openRoom, useBus } from "@/core/bus";
//   openRoom("!abc:example.com");                       // convenience emitters
//   bus.emit("toast", { message: "Copied" });
//   useBus("openRoom", ({ roomId }) => ...);            // React subscription (auto-unsubscribes)
//   const off = bus.on("startCall", handler);           // plain subscription
//
// ADDITIVE ONLY: add new events to BusEvents (+ an emitter helper if handy); never change or
// remove an existing payload shape — other feature folders depend on them.
import { useEffect, useRef } from "react";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface BusEvents {
  /** Show a room (nav/shell). `eventId` = jump to that event (permalink / search hit). */
  openRoom: { roomId: string; eventId?: string; highlight?: boolean };
  /** Open an in-app window registered in `r.windows` (Calendar, Memories, Watch Party, …). */
  openWindow: { id: string; props?: Record<string, unknown> };
  closeWindow: { id: string };
  /** Open the Settings sheet, optionally at a pane id from `r.settingsPanes`. */
  openSettings: { paneId?: string };
  closeSettings: Record<string, never>;
  /** Profile flyout for a user (spaces agent owns the flyout). `anchor` = the clicked rect. */
  openUserProfile: { userId: string; roomId?: string; anchor?: { x: number; y: number; width: number; height: number } };
  /** Start / join the call in a room (calls agent). */
  startCall: { roomId: string; video?: boolean };
  /** Call UI (callui): the "Call & device settings" menu at an anchor (room header gear). */
  openCallDevicesMenu: { anchor?: HTMLElement | { x: number; y: number; width: number; height: number } | null; roomId?: string };
  /** Call UI (callui): pop a call tile out into its own window (needs a user gesture for Document PiP). */
  openPip: { tileId: string };
  /** Transient notice (Toast host in the shell). */
  toast: { message: string; kind?: "info" | "success" | "error"; timeoutMs?: number; action?: ToastAction };
  /** Lightbox over images/videos (chat agent). */
  openLightbox: { roomId?: string; eventId?: string; items?: Array<{ src: string; mimetype?: string; name?: string }>; index?: number };
  /** Reply/thread focus on an event (chat agent). Tin Hat has no thread view: this focuses the event. */
  openThread: { roomId: string; eventId: string };
  /** Right panel (room info / members …) toggles — spaces agent. */
  openRightPanel: { roomId: string; tab?: string };
  closeRightPanel: Record<string, never>;
  /** Space settings window for a space (spaces agent). */
  openSpaceSettings: { spaceId: string; tab?: string };
  /** Quick switcher (Ctrl+K). */
  openQuickSwitcher: Record<string, never>;
  /** Device-verification dialog (settings agent), e.g. from the header banner. */
  openVerifyDialog: { mode?: "choose" | "sas" | "key" | "recovery" };
  /** Pop a room out into a floating chat (chat agent; nav's room menu "Pop out chat"). */
  openFloatingChat: { roomId: string };
  /** Scroll the room's open conversation to an event and flash it (chat agent). */
  jumpToEvent: { roomId: string; eventId: string };
  /** Stage files in the open room's composer (window-level drop, share targets). */
  stageFiles: { files: File[]; roomId?: string };
  // ---- ADDITIVE (nav, see features/nav/CORE-CHANGES.md) ----
  /** Bug-report dialog (settings agent hosts BugReportDialog; keeps an unsent note). */
  openBugReport: Record<string, never>;
  /** About sheet / keyboard-shortcuts dialog / tour (nav hosts shortcuts + tour; About → settings SET-102). */
  openAbout: Record<string, never>;
  openShortcuts: Record<string, never>;
  openTour: Record<string, never>;
  /** Calendar window for a container (space or room) — calendar agent. */
  openCalendar: { containerId?: string; eventId?: string };
  /** Game Reel window — calendar agent. */
  openGameReel: { sessionId?: string };
  /** Per-person call volume menu for a participant (calls/callui ParticipantVolumeMenu). */
  openParticipantMenu: { userId: string; roomId: string; anchor: { x: number; y: number; width: number; height: number } };
  /** Nav dialogs other features may open (New chat prefilled, invite to a room …). */
  openNavDialog: { kind: "newChat" | "newRoom" | "newSpace" | "invite" | "joinSpace"; roomId?: string; mxid?: string };
  /** Session lifecycle notifications (core emits). */
  sessionReady: { userId: string; deviceId: string };
  loggedOut: { status?: string };
  // ---- settings feature (additive, features/settings/CORE-CHANGES.md) ----
  /** Sign out, with the backup-aware "Sign out?" confirm (☰ "Sign out"). */
  requestSignOut: Record<string, never>;
  /** Noise-cancellation before/after sheet (Settings → Audio, call gear). */
  openNoiseTest: Record<string, never>;
  /** "What's new in v<ver>" sheet (update banner). */
  openWhatsNew: { version?: string; notes?: string };
  // ---- ADDITIVE (11.0 buttons, src/actions/CORE-CHANGES.md) ----
  /** Open a surface that lives in a component's own state, for an action run from a button or the Ctrl+K palette
   *  (src/features/actions/exec.ts): the ☰ app menu, Your status, stream health, the game popover, the hidden streams,
   *  the room filter, the newest message. `anchor` = the button that ran it (null from the palette or a key). */
  openSurface: {
    id: "appMenu" | "status" | "callHealth" | "gamePopup" | "hiddenStreams" | "roomFilter" | "jumpToLatest";
    anchor?: HTMLElement | null;
  };
  // ---- ☰ Theme menu (additive, THEMES-UI.md §12; features/nav/CORE-CHANGES.md) ----
  /** Settings → Appearance at the theme gallery ("Themes", THEMES-UI §4), opened fresh — the ☰ Theme menu's "More themes…". */
  openThemeGallery: Record<string, never>;
  /** The theme editor on the theme on screen (Appearance's Customize…: one of My themes → Edit…, any other → New theme
   *  from this, THEMES-UI §13.1) — the ☰ Theme menu's "Edit current theme…" (§12 amendment 2026-09-28). */
  editCurrentTheme: Record<string, never>;
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

class Bus {
  private handlers = new Map<keyof BusEvents, Set<Handler<keyof BusEvents>>>();

  on<K extends keyof BusEvents>(name: K, h: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(h as Handler<keyof BusEvents>);
    return () => {
      set!.delete(h as Handler<keyof BusEvents>);
    };
  }

  once<K extends keyof BusEvents>(name: K, h: Handler<K>): () => void {
    const off = this.on(name, (p) => {
      off();
      h(p);
    });
    return off;
  }

  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    for (const h of [...set]) {
      try {
        (h as Handler<K>)(payload);
      } catch (e) {
        console.error(`[bus] handler for ${String(name)} threw`, e);
      }
    }
  }

  /** How many handlers listen for `name` (lets a caller fall back when nobody hosts a surface). */
  listenerCount(name: keyof BusEvents): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

export const bus = new Bus();

/** React: subscribe for the component's lifetime. The latest `handler` is always called. */
export function useBus<K extends keyof BusEvents>(name: K, handler: Handler<K>): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => bus.on(name, (p) => ref.current(p)), [name]);
}

// ---- convenience emitters --------------------------------------------------------------------
export const openRoom = (roomId: string, opts: { eventId?: string; highlight?: boolean } = {}) =>
  bus.emit("openRoom", { roomId, ...opts });
export const openWindow = (id: string, props?: Record<string, unknown>) => bus.emit("openWindow", { id, props });
export const closeWindow = (id: string) => bus.emit("closeWindow", { id });
export const openSettings = (paneId?: string) => bus.emit("openSettings", { paneId });
export const openUserProfile = (userId: string, roomId?: string, anchor?: BusEvents["openUserProfile"]["anchor"]) =>
  bus.emit("openUserProfile", { userId, roomId, anchor });
export const startCall = (roomId: string, video?: boolean) => bus.emit("startCall", { roomId, video });
export const toast = (message: string, opts: Omit<BusEvents["toast"], "message"> = {}) => bus.emit("toast", { message, ...opts });
export const openLightbox = (p: BusEvents["openLightbox"]) => bus.emit("openLightbox", p);
export const openThread = (roomId: string, eventId: string) => bus.emit("openThread", { roomId, eventId });
export const openFloatingChat = (roomId: string) => bus.emit("openFloatingChat", { roomId });
export const jumpToEvent = (roomId: string, eventId: string) => bus.emit("jumpToEvent", { roomId, eventId });
export const openVerify = () => bus.emit("openVerifyDialog", {});
export const openBugReport = () => bus.emit("openBugReport", {});
export const openAbout = () => bus.emit("openAbout", {});
export const openShortcuts = () => bus.emit("openShortcuts", {});
export const requestSignOut = () => bus.emit("requestSignOut", {});
