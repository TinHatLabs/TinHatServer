// webCall.ts — an app that FOLLOWS the web's own call (Android today: caps has no "calls", so the page joins with its
// own device; the app runs its "In a call" service and notification controls around it). Pure (imports only ./bridge):
// the unit tests run it in Node. Inactive in browsers, the desktop app and in an app with "calls" (iOS: the app owns
// the call there, so the page never reports one and takes no commands).
//   page → app  tinhatNative.webCall({state: "connecting"|"in-call"|"left", roomId, roomName, muted, camera}) on every
//               REAL change of the page's own call (deduplicated; coalesced over 250 ms so the auto-rejoin's
//               "dropped → joining again" in one tick isn't reported as a leave)
//   app → page  window "tinhatnative:command", detail.cmd = "toggleMute" | "leave" → the call UI's own Mute / Leave,
//               only while the page is in (or joining) a call; anything else is ignored
import { nativeCalls, roomIdOk, webCallCommandsOn, webCallReportsOn, type WebCallReport } from "./bridge";

export const WEB_CALL_COMMAND_EVENT = "tinhatnative:command";
export const WEB_CALL_REPORT_DELAY_MS = 250;

/** The page's own call as the reporter needs it (calls store: inCall / connecting / reconnecting / callRoomId /
 *  micMuted / cameraOn). */
export interface WebCallSnapshot {
  inCall: boolean;
  connecting: boolean;
  reconnecting: boolean;
  roomId: string;
  muted: boolean;
  camera: boolean;
}

export function webCallState(s: WebCallSnapshot): WebCallReport["state"] {
  if (s.inCall) return "in-call";
  if (s.connecting || s.reconnecting) return "connecting"; // (an auto-rejoin after a drop is still the call)
  return "left";
}

const keyOf = (s: WebCallSnapshot) => {
  const st = webCallState(s);
  return st === "left" ? "left" : `${st}|${s.roomId}|${s.muted ? 1 : 0}|${s.camera ? 1 : 0}`;
};

export interface Timers {
  set(f: () => void, ms: number): unknown;
  clear(t: unknown): void;
}
const realTimers: Timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/** Deduplicating, coalescing reporter: `update(snapshot)` on every store change; `send` runs only for a real change.
 *  Nothing is sent before the first call ("left" with nothing to end is not news). */
export function createWebCallReporter(send: (r: WebCallReport) => void, roomName: (roomId: string) => string, timers: Timers = realTimers, delayMs = WEB_CALL_REPORT_DELAY_MS) {
  let sentKey = "left"; // what the app was told last (it starts knowing of no call)
  let lastRoom = "";
  let pending: WebCallSnapshot | null = null;
  let timer: unknown = null;
  const flush = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    const s = pending;
    pending = null;
    if (!s) return;
    const key = keyOf(s);
    if (key === sentKey) return;
    const state = webCallState(s);
    if (state !== "left" && !roomIdOk(s.roomId)) return; // no room to name: wait for one
    const roomId = state === "left" ? lastRoom : s.roomId;
    sentKey = key;
    if (state !== "left") lastRoom = s.roomId;
    let name = "";
    try {
      name = roomId ? roomName(roomId) : "";
    } catch {
      name = "";
    }
    send({ state, roomId, roomName: typeof name === "string" ? name : "", muted: state !== "left" && s.muted, camera: state !== "left" && s.camera });
  };
  return {
    update(s: WebCallSnapshot): void {
      // most store changes (levels, tiles) change nothing reported: no timer for those
      if (timer === null && keyOf(s) === sentKey) return;
      pending = s;
      if (timer === null) timer = timers.set(flush, delayMs);
    },
    flush,
  };
}

export type WebCallCommand = "toggleMute" | "leave";

/** Untrusted detail → a known command or null. */
export function parseWebCallCommand(detail: unknown): WebCallCommand | null {
  if (!detail || typeof detail !== "object") return null;
  try {
    const c = (detail as { cmd?: unknown }).cmd;
    return c === "toggleMute" || c === "leave" ? c : null;
  } catch {
    return null;
  }
}

export interface WebCallActions {
  /** the page itself is in (or joining) a call */
  inCall(): boolean;
  /** the call UI's Mute button (a server mute keeps the mic off and says so) */
  toggleMute(): void;
  /** the call UI's Leave */
  leave(): void;
}

/** Run an app command on the page's own call. True when it acted. */
export function runWebCallCommand(detail: unknown, a: WebCallActions): boolean {
  const cmd = parseWebCallCommand(detail);
  if (!cmd || !webCallCommandsOn() || !a.inCall()) return false;
  if (cmd === "toggleMute") a.toggleMute();
  else a.leave();
  return true;
}

/** Wire both directions (calls/index.tsx, once). A no-op (nothing subscribed or listened to) unless the page runs in
 *  an app that follows the web's call. Returns the undo (tests). */
export function installWebCallBridge(o: { subscribe(cb: () => void): () => void; snapshot(): WebCallSnapshot; roomName(roomId: string): string; actions: WebCallActions; timers?: Timers }): () => void {
  const offs: Array<() => void> = [];
  if (webCallReportsOn()) {
    const rep = createWebCallReporter((r) => void nativeCalls.webCall(r), o.roomName, o.timers);
    offs.push(o.subscribe(() => rep.update(o.snapshot())));
    rep.update(o.snapshot());
  }
  if (webCallCommandsOn()) {
    const w = globalThis as { addEventListener?: (t: string, f: (e: Event) => void) => void; removeEventListener?: (t: string, f: (e: Event) => void) => void };
    const on = (e: Event) => void runWebCallCommand((e as CustomEvent).detail, o.actions);
    w.addEventListener?.(WEB_CALL_COMMAND_EVENT, on);
    offs.push(() => w.removeEventListener?.(WEB_CALL_COMMAND_EVENT, on));
  }
  return () => offs.forEach((f) => f());
}
