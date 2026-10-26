// ThisDevice.tsx — REACH §3.2 + A2.10/A2.12: Settings → Notifications → "This device" (web only — the desktop
// app notifies natively while it runs; docs/WEB-EXCEPTIONS.md).
//
//   unsupported      one line saying why — the iPhone/iPad "add to Home Screen" guidance comes FIRST
//   switch           "Notifications when Tin Hat is closed" (the permission prompt runs inside the tap)
//   sub-switch       "Only when I'm away from my computer" (quietWhileActive, default on) + its consent caption
//   test             "Send a test notification"
//   status line      On / Checking… / Blocked / Setting up… / Turning off… / "Turn on again" when the start-up check
//                    couldn't repair it / "Try again" when turning off didn't finish (never "off" before that's
//                    confirmed — web review #5)
import { Button, HintLabel, SectionLabel, Separator, Switch, cx } from "@/ui";
import { inTinHatApp } from "@/features/native";
import { disablePush, enablePush, sendTest, setQuiet, usePushStore } from "./client";
import s from "./push.module.css";

export const ON_LINE = "On — DMs, mentions and invites reach this device while Tin Hat is closed.";
export const BLOCKED_LINE = "Blocked in the browser (or iOS) settings for Tin Hat.";
export const STUCK_LINE = "Turning off didn't finish — notifications may still arrive on this device.";
export const QUIET_CAPTION = "Your computer tells the Tin Hat server when you're using it, only to keep this phone quiet. Nobody else sees it.";

export function ThisDeviceSection() {
  const st = usePushStore();
  const sup = st.support;
  const denied = st.permission === "denied";
  const on = st.phase === "on";
  const busy = st.phase === "turning-on" || st.phase === "turning-off";
  const checked = (on || st.phase === "turning-on" || st.phase === "checking") && !denied;
  if (inTinHatApp()) return null; // a Tin Hat app: no Web Push, no "Add to Home Screen" (features/native)
  return (
    <>
      <SectionLabel>This device</SectionLabel>
      {!sup.ok ? (
        <HintLabel className={s.why} data-push-support={sup.kind}>
          {sup.text}
        </HintLabel>
      ) : (
        <div className={s.block} data-push-phase={st.phase}>
          <Switch
            text="Notifications when Tin Hat is closed"
            checked={checked}
            disabled={busy || denied}
            // enablePush() calls Notification.requestPermission() synchronously — this handler IS the tap (iOS)
            onToggled={(v) => (v ? enablePush() : void disablePush())}
          />
          {on && (
            <div className={s.indent}>
              <Switch text="Only when I'm away from my computer" checked={st.quiet} onToggled={(v) => void setQuiet(v)} />
              <HintLabel>{QUIET_CAPTION}</HintLabel>
              <div className={s.row}>
                <Button text="Send a test notification" icon="notifications" onClick={() => void sendTest()} />
                {st.note && <span className={s.note}>{st.note}</span>}
              </div>
            </div>
          )}
          <div className={cx(s.status, denied && s.bad)} data-push-status="">
            {denied
              ? BLOCKED_LINE
              : st.phase === "turning-on"
                ? "Setting up…"
                : st.phase === "turning-off"
                  ? "Turning off…"
                  : on
                    ? ON_LINE
                    : st.phase === "checking"
                      ? "Checking…"
                      : st.phase === "repair"
                        ? "Notifications stopped reaching this device."
                        : st.phase === "stuck"
                          ? STUCK_LINE
                          : "Off — this device only notifies while Tin Hat is open."}
          </div>
          {st.phase === "repair" && !denied && <Button highlighted text="Turn on again" onClick={() => enablePush()} className={s.again} />}
          {st.phase === "stuck" && <Button highlighted text="Try again" onClick={() => void disablePush()} className={s.again} />}
          {st.error && <HintLabel className={s.err}>{st.error}</HintLabel>}
          {on && <HintLabel>Encrypted chats arrive as “New message” — the server can't read them. Open Tin Hat for the text.</HintLabel>}
        </div>
      )}
      <Separator />
    </>
  );
}
