// screenShare.ts — the page's Share button inside a Tin Hat app that shares the screen for it (caps "screenshare":
// Android, whose WebView has no getDisplayMedia; SCREEN-SHARE.md §7, BRIDGE.md "Screen share"). Pure (imports only
// ./bridge): the unit tests run it in Node with a fake app. Inactive in browsers, the desktop app and an app that owns
// the call itself ("calls": the page is never in a call there).
//   page → app  tinhatNative.screenShare.start({roomId, deviceId}) — the app's native device joins the page's call as a
//               share-only companion of `deviceId` (the page's own call device) — and screenShare.stop()
//   app → page  window "tinhatnative:screenshare", detail {state: "sharing"|"denied"|"failed"|"stopped", roomId}
// The page never calls getDisplayMedia while this is on. Its "sharing" flag follows the app's answers and events only
// for the room the page is in a call in; the person's Stop is the call bar's own.
import { hasNativeCap, nativeScreenShare, parseShareAnswer, parseShareEvent, roomIdOk, webCallCommandsOn, type ShareAnswer } from "./bridge";

export const SCREEN_SHARE_EVENT = "tinhatnative:screenshare";

/** The app shares the screen for the page: an app that follows the web's call (no "calls") with "screenshare". */
export function nativeShareOn(): boolean {
  return webCallCommandsOn() && hasNativeCap("screenshare");
}

/** The words for an app's share state (the call's status line → a short toast). */
export function shareWords(a: ShareAnswer): string {
  switch (a.state) {
    case "sharing":
      return "You're sharing your screen";
    case "denied":
      return "Screen share cancelled";
    case "failed":
      return a.error ? `Share failed: ${a.error}` : "Share failed";
    default:
      return "Screen share ended";
  }
}

/** What the controller needs from the call (calls/index.tsx): the room the page is in a call in ("" = none), the
 *  call store's sharing flag, its status line. */
export interface ShareSink {
  callRoom(): string;
  setSharing(on: boolean): void;
  status(text: string): void;
}

/** The app's two functions (the real bridge, or a fake in the tests). */
export interface ShareApp {
  start(roomId: string, deviceId: string): Promise<ShareAnswer | null>;
  stop(): Promise<ShareAnswer | null>;
}
const realApp: ShareApp = { start: (r, d) => nativeScreenShare.start(r, d), stop: () => nativeScreenShare.stop() };

export function createNativeShare(sink: ShareSink, app: ShareApp = realApp) {
  let op = 0; // bumped by every start and stop: an older start's answer / stop's acknowledgment stands down
  const ended = new Map<string, number>(); // per room, bumped by every "stopped" event: a start's late "sharing"
  //                                          answer predating one for ITS room is stale
  let sharingRoom = ""; // the room the app said it shares into ("" = not sharing)
  let pendingRoom = ""; // the room a start is still waiting for the app in
  const show = (roomId: string, a: ShareAnswer) => {
    if (a.state === "sharing") {
      if (sharingRoom === roomId) return; // (the answer and the event both say so)
      sharingRoom = roomId;
      sink.setSharing(true);
      sink.status(shareWords(a));
      return;
    }
    const was = sharingRoom === roomId;
    if (was) sharingRoom = "";
    if (sink.callRoom() !== roomId) return; // after a leave: the call store has already dropped it, nothing to say
    if (was || a.state !== "stopped") {
      sink.setSharing(false);
      sink.status(shareWords(a));
    }
  };
  return {
    /** The Share button (no picker: the app shows its own consent). */
    async start(roomId: string, deviceId: string): Promise<void> {
      if (!roomIdOk(roomId) || sink.callRoom() !== roomId) return;
      const my = ++op;
      const endedAt = ended.get(roomId) ?? 0;
      pendingRoom = roomId;
      sink.status("Preparing screen share…");
      const a = await app.start(roomId, deviceId);
      if (my !== op) return; // a Stop (or a newer start) came while the app asked: the events tell the rest
      pendingRoom = "";
      if (!a) {
        if (sharingRoom !== roomId) sink.status("Share failed: Tin Hat didn't answer");
        return;
      }
      if (a.state === "sharing") {
        if ((ended.get(roomId) ?? 0) !== endedAt) return; // the app reported this room's share stopped meanwhile: stale
        if (sink.callRoom() !== roomId) {
          void app.stop(); // OUR start came up after the page left that call: end it (no newer start: op checked)
          return;
        }
      }
      show(roomId, a);
    },
    /** The call bar's Stop. The flag drops only once the app confirms ("stopped" answer or event): a failed stop
     *  must not hide a capture that's still running. */
    async stop(): Promise<void> {
      const my = ++op;
      const roomId = sharingRoom || pendingRoom; // (a Stop during a start covers the share that start may bring up)
      pendingRoom = "";
      const a = await app.stop();
      if (my !== op) return; // a newer start / stop since: this acknowledgment isn't about the current share
      if (a?.state === "stopped") {
        if (roomId && sharingRoom === roomId) show(roomId, a);
        return;
      }
      if (roomId && sharingRoom === roomId && sink.callRoom() === roomId) sink.status("Couldn't stop sharing: Tin Hat didn't answer. Use Stop in the notification.");
    },
    /** A "tinhatnative:screenshare" event (unchecked detail). True when it changed the page. Never asks the app for
     *  anything: stop() has no room, so a stray event must not end a share somewhere else. */
    onEvent(detail: unknown): boolean {
      const e = parseShareEvent(detail);
      if (!e) return false;
      const before = sharingRoom;
      if (e.state === "stopped") ended.set(e.roomId, (ended.get(e.roomId) ?? 0) + 1);
      else if (sink.callRoom() !== e.roomId) return false; // a share into a call the page isn't in: not ours to show
      show(e.roomId, { state: e.state, error: "" });
      return before !== sharingRoom;
    },
    /** (tests) the room the page shows a share for */
    sharingRoom: () => sharingRoom,
  };
}
export type NativeShare = ReturnType<typeof createNativeShare>;

let installed: NativeShare | null = null;

/** Wire the event (calls/index.tsx, once). A no-op unless the app shares for the page. Returns the undo (tests). */
export function installScreenShareBridge(sink: ShareSink, app?: ShareApp): () => void {
  if (!nativeShareOn()) return () => undefined;
  const ctl = createNativeShare(sink, app);
  installed = ctl;
  const w = globalThis as { addEventListener?: (t: string, f: (e: Event) => void) => void; removeEventListener?: (t: string, f: (e: Event) => void) => void };
  const on = (e: Event) => void ctl.onEvent((e as CustomEvent).detail);
  w.addEventListener?.(SCREEN_SHARE_EVENT, on);
  return () => {
    w.removeEventListener?.(SCREEN_SHARE_EVENT, on);
    if (installed === ctl) installed = null;
  };
}

/** The engine's shareScreen / stopScreen ask this first: true = the app handles the share, the page must not capture. */
export function nativeShareStart(roomId: string, deviceId: string): boolean {
  if (!installed || !nativeShareOn()) return false;
  void installed.start(roomId, deviceId);
  return true;
}
export function nativeShareStop(): boolean {
  if (!installed || !nativeShareOn()) return false;
  void installed.stop();
  return true;
}
