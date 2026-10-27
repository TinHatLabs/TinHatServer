// features/native — Tin Hat Web inside the Tin Hat iOS / Android apps (`window.tinhatNative`, bridge v2;
// docs/NATIVE-APPS.md). App-only: without the object every export answers "no" / renders its children unchanged, so
// browsers and the desktop app behave exactly as before. Gate on `caps`, never on the platform; the one exception is
// the iOS keyboard path (tokens.css / App.tsx / core/device.ts read <html data-tinhat-ios-app> directly).
//
//   inTinHatApp()                 the page runs in a Tin Hat app (hides web push + "Add to Home Screen")
//   hasNativeCap(cap)             "calls" | "servers" | "haptics" | "notifications"
//   nativeNotifications           "notifications": state / enable / disable (+ optional openSettings) of THIS phone's
//                                 notifications (Settings → Notifications → "Notifications on this phone")
//   chooseServer()                "Switch server" (sign-in screen, Settings → About & help)
//   joinNatively(roomId)          the engine's joinCall / switchCall ask this first (true = the app took the call)
//   joinCallNativelyOrHere(r, f)  the same as a wrapper around any other join
//   nativeCall() / useNativeCall() / onNativeCall(cb) / nativeCallIn(roomId) / nativeDeviceId()
//   <OnThisPhone roomId>          "You're in this call on this phone" · Open · Leave around a room's Join entry point
//   pageOwnsMembership(...)       the page sweeps / corrects only its OWN device's call membership
//   installWebCallBridge(...)     an app without "calls" (Android) follows the WEB's call: webCall reports + commands
//   (on "loggedOut" by the person) tinhatNative.signedOut({userId}): the app signs its native device out too
//   installTrustBridge()          "trust": cross-sign the device the app set up (pending → check → sign → result;
//                                 trust.ts + trustGlue.ts, docs/TRUST.md); trustLookupFor() = the Devices "Trust…" sheet
import { bus } from "@/core/bus";
import { getSession, peekClient } from "@/core/matrix";
import { nativeSignedOut } from "./bridge";
import { installTrustBridge } from "./trustGlue";
import { joinNatively as joinNativelyWith, joinNativelyOrHere, type JoinWho } from "./joinCall";

export { inTinHatApp, hasNativeCap, chooseServer, nativeInfo, type NativeCap, type NativeInfo } from "./bridge";
export { nativeNotifications, phoneNotifyText, NOTIFY_CHANGE_MS, NOTIFY_READ_MS, type PhoneNotifyAnswer, type PhoneNotifyState } from "./bridge";
export { nativeCall, nativeCallIn, nativeDeviceId, onNativeCall, type NativeCall, type NativeCallPhase } from "./callState";
export { deviceStateKey, pageOwnsMembership } from "./membership";
export { OnThisPhone, useNativeCall } from "./OnThisPhone";
export { installWebCallBridge, type WebCallSnapshot } from "./webCall";
export { trustLookupFor } from "./trustGlue";
export { DEVICES_FALLBACK, fallbackOffersTrust, fingerprintText, isNativePhoneDevice, trustDevice, trustDoneText, trustResultText, TRUST_WORDS, WAIT_MS, type TrustResult } from "./trust";

// A sign-out the person chose ends the phone's native device of that account too (its calls and notifications);
// a dead token or another device ending this session doesn't (that account may still be signed in natively).
bus.on("loggedOut", (e) => {
  if (e.byUser && e.userId) nativeSignedOut(e.userId);
});

// The app names the device it set up on this phone; the page signs exactly that one (docs/TRUST.md).
installTrustBridge();

/** Who joins: the page's signed-in account and the room's name (for the app's call screen). */
function who(roomId: string): JoinWho {
  return { roomName: peekClient()?.getRoom(roomId)?.name ?? "", userId: getSession().userId ?? "" };
}

/** True = the app took this join natively; the page must not join with its own engine. False outside the apps. */
export function joinNatively(roomId: string): boolean {
  return joinNativelyWith(roomId, who);
}

/** Join natively or here (`here` = the page's own join, unchanged). */
export function joinCallNativelyOrHere(roomId: string, here: (roomId: string) => void): void {
  joinNativelyOrHere(roomId, here, who);
}
