// joinCall.ts — THE "join natively or here" rule (bridge 2). Inside an app whose `info.caps` has "calls" the phone's
// native device does the call: the page hands Join / Start a call to `tinhatNative.joinCall({roomId, roomName, userId})`
// and never joins with its own engine. Anywhere else (browsers, the desktop app, Android without "calls") today's join
// runs unchanged. The engine's joinCall / switchCall call joinNatively() first, so every entry point (banners, the
// header button, the incoming card, the palette, shortcuts, widgets, the guest hand-off) follows it. Pure (imports only
// ./bridge and ./callState): the unit tests run it in Node.
import { hasNativeCap, nativeCalls, nativeOwnsCalls, roomIdOk, userIdOk } from "./bridge";
import { nativeCall } from "./callState";

export interface JoinWho {
  roomName: string;
  /** the page's signed-in account (`@user:server`) */
  userId: string;
}

/**
 * True = the app took this join (the caller must NOT run the page's own join). A Join for the room the native call is
 * already in opens the native call screen instead of joining again.
 */
export function joinNatively(roomId: string, who: (roomId: string) => JoinWho): boolean {
  if (!nativeOwnsCalls()) return false;
  // from here on the page never joins with its own device, even when there is nothing valid to hand over — and not when
  // the app claims the calls but can't take them (a broken / old app): blocking beats a second, web-device call
  if (!hasNativeCap("calls")) {
    console.warn("[native] the app claims calls but can't take this join; not joining with the web's device either");
    return true;
  }
  if (!roomIdOk(roomId)) return true;
  const cur = nativeCall();
  if (cur && cur.roomId === roomId && cur.state !== "leaving") {
    nativeCalls.show();
    return true;
  }
  let w: JoinWho | null = null;
  try {
    w = who(roomId);
  } catch {
    w = null;
  }
  if (!w || !userIdOk(w.userId)) return true; // not signed in: there is no account to join as
  nativeCalls.join({ roomId, roomName: typeof w.roomName === "string" ? w.roomName : "", userId: w.userId });
  return true;
}

/** Join natively or here: `here(roomId)` (the page's own join) runs only when the app doesn't take the call. */
export function joinNativelyOrHere(roomId: string, here: (roomId: string) => void, who: (roomId: string) => JoinWho): void {
  if (!joinNatively(roomId, who)) here(roomId);
}
