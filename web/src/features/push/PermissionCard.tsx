// PermissionCard.tsx — REACH A5.4: the one-time "Get notified about DMs and mentions?" question, while the browser
// has never been asked (Notification.permission === "default") and in-page notifications are on. The calm first run
// asks it on the room page after this device's first message (features/selfhost/asks.tsx) with the helpers below.
// [Turn on] is the click the browser needs for requestPermission — on an iPhone Home Screen app it runs the §3.2 push
// setup instead (that asks inside the same tap). [Not now] → not again for 30 days (a device pref).
import { useSession } from "@/core/matrix";
import { getPref, setPref, usePref } from "@/core/prefs";
import { enablePush, envNow, usePushStore } from "./client";
import { isInstalled, isIos } from "./wire";
import { inPhoneApp } from "@/features/native";

const SNOOZE_PREF = "notify.ask-until";
const SNOOZE_MS = 30 * 24 * 3_600_000;
export const PERMISSION_QUESTION = "Get notified about DMs and mentions?";

/** Should the card show now? */
export function useNotifyCardVisible(): boolean {
  const session = useSession();
  const perm = usePushStore((st) => st.permission);
  const desk = usePref("desktop-notifications", "1");
  const until = Number(usePref(SNOOZE_PREF, "0")) || 0;
  // (never inside a Tin Hat phone app: its web view has no Web Push or Notification; the apps notify natively —
  // features/native. The Mac app has Notification (to Notification Center): it asks, like a desktop browser)
  return session.state === "ready" && session.liveSyncDone && perm === "default" && desk !== "0" && until <= Date.now() && !inPhoneApp();
}

/** [Turn on] — call it INSIDE the click (iOS asks only within the tap): the browser's question, or on an iPhone Home
 *  Screen app the §3.2 push setup (which asks within the same tap). Resolves once the browser answered; null when the
 *  push setup took over. */
export function askNotificationPermission(): Promise<void> | null {
  const env = envNow();
  if (isIos(env) && isInstalled(env) && env.pushManager) {
    enablePush(); // asks for permission synchronously inside this tap, then subscribes (§3.2)
    return null;
  }
  let asked: Promise<NotificationPermission>;
  try {
    asked = Notification.requestPermission(); // synchronously in the click
  } catch {
    asked = new Promise((res) => void Notification.requestPermission(res));
  }
  return asked
    .catch(() => Notification.permission)
    .then((p) => {
      usePushStore.setState({ permission: p });
    });
}

/** [Not now] — not again for 30 days. */
export function snoozeNotifyAsk(): void {
  setPref(SNOOZE_PREF, String(Date.now() + SNOOZE_MS));
}

export function snoozedUntil(): number {
  return Number(getPref(SNOOZE_PREF, "0")) || 0;
}
