// pushHint.ts — why a phone app offers no notifications switch (`tinhatNative.info.push`, docs/NATIVE-APPS.md).
// The Android app sends `info.push = "no-play-services"` on a phone without Google Play services (GrapheneOS without
// sandboxed Play, de-Googled ROMs, Huawei): it has no way to receive pushes there yet (FCM needs Play services), so it
// leaves out the "notifications" cap. Settings → Notifications then says so instead of the generic "comes with the
// app's push update" line. A hint only: an unknown or malformed value is ignored (the generic line stays), and with
// the "notifications" cap the app's own switch decides (the hint is not read).
import { nativeInfo } from "./bridge";

export type PushHint = "no-play-services";

/** The app's push hint, validated; null outside the apps, for anything unknown, or when the read throws. */
export function nativePushHint(): PushHint | null {
  if (!nativeInfo()) return null; // not inside a (well-formed) Tin Hat app
  try {
    const n = (globalThis as { tinhatNative?: { info?: { push?: unknown } } }).tinhatNative;
    const v = n?.info?.push;
    return v === "no-play-services" ? v : null;
  } catch {
    return null; // a throwing getter
  }
}

/** Settings → Notifications' line for a phone app without the "notifications" cap. */
export function phoneNoSwitchLine(hint: PushHint | null): string {
  if (hint === "no-play-services")
    return "This phone doesn't have Google Play services, which Tin Hat uses to deliver notifications, so it can't notify you here when Tin Hat is closed. Sounds still play while Tin Hat is open.";
  return "Phone notifications come with the app's push update. Sounds still play while Tin Hat is open.";
}
