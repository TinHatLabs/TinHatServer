// Notifications pane — SETTINGS-WINDOW.md §5 (Main.qml Notifications + §5 Web Notifications API). Card Desktop
// notifications (2 switches, what notifies you as the section's hint, the browser's permission as a note), card Sounds
// (switches, Notification sound + Preview, Ring + Preview, Sound volume). Web only, first: "This device" — push while
// Tin Hat is closed (REACH §3.2, features/push's store; docs/WEB-EXCEPTIONS.md).
// Notification sound / Ring: one combo each with "Off" first (was a check box + a combo) — the same prefs
// (`snd.notify` / `snd.ring` 0|1 + `snd.notify.variant` / `snd.ring.variant`), STATUS.md D-SW5.
import { useCallback, useEffect, useRef, useState } from "react";
import { getSession } from "@/core/matrix";
import { setPref, usePref } from "@/core/prefs";
import { useServerFeature } from "@/core/server";
import { previewSound } from "@/core/sounds";
import { Button, Slider, ToolButton } from "@/ui";
import { disablePush, enablePush, sendTest, setQuiet, usePushStore } from "@/features/push";
import { BLOCKED_LINE, ON_LINE, QUIET_CAPTION, STUCK_LINE } from "@/features/push/ThisDevice";
import { hasNativeCap, inTinHatApp, nativeNotifications, NOTIFY_CHANGE_MS, NOTIFY_READ_MS, phoneNotifyText, type PhoneNotifyAnswer } from "@/features/native";
import { notificationPermission, requestNotificationPermission, useNotificationPermission } from "../notify";
import { ComboRow, Hint, NoteRow, Row, Section, SwitchRow } from "../rows";
import p from "./panes.module.css";

const NOTIFY_SOUNDS = ["Off", "Sound 1 (default, 1 s)", "Sound 2 (3 s)", "Sound 3 (1.5 s)", "Sound 4 (1 s)"];
const RING_SOUNDS = ["Off", "Ring 1 (default, 8 s)", "Ring 2 (15 s)"];

function on(v: string | boolean): boolean {
  return v !== "0" && v !== false;
}

export function NotificationsPane() {
  const desk = usePref("desktop-notifications", "1");
  const calls = usePref("notify.calls", "1");
  const recv = usePref("snd.receive", "1");
  const send = usePref("snd.send", "1");
  const chime = usePref("snd.callchime", "1");
  const notify = usePref("snd.notify", "1");
  const ring = usePref("snd.ring", "1");
  const nv = usePref("snd.notify.variant", "");
  const rv = usePref("snd.ring.variant", "");
  const volRaw = usePref("snd.volume", "70");
  const vol = Number.isNaN(parseInt(String(volRaw), 10)) ? 70 : Math.max(0, Math.min(100, parseInt(String(volRaw), 10)));
  const [volLive, setVolLive] = useState<number | null>(null);
  const perm = useNotificationPermission();
  // variant index 0..3 / 0..1 (the old combos'), then +1 for the "Off" row
  const notifyVar = nv === "2" ? 1 : nv === "3" ? 2 : nv === "4" ? 3 : 0;
  const ringVar = rv === "2" ? 1 : 0;
  const notifyFile = (i: number) => "notify" + (i === 0 ? "" : `-${i + 1}`);
  const ringFile = (i: number) => "ring" + (i === 0 ? "" : "-2");
  const blocked = (on(desk) || on(calls)) && perm === "denied";
  // A5.4: never asked yet — say so, with the click the browser needs (not only when it was denied)
  const notAsked = (on(desk) || on(calls)) && perm === "default";

  const toggle = (key: string) => (v: boolean) => {
    setPref(key, v ? "1" : "0");
    if (v && (key === "desktop-notifications" || key === "notify.calls") && notificationPermission() === "default") void requestNotificationPermission();
  };

  return (
    <>
      <ThisDevice />
      {inTinHatApp() ? (
        // the apps' web views have no Notification API: the pop-up switches would do nothing (docs/NATIVE-APPS.md);
        // an app with "notifications" gets its own switch for THIS phone instead
        hasNativeCap("notifications") ? (
          <PhoneNotificationsSection />
        ) : (
          <Section title="Notifications">
            <NoteRow>Phone notifications come with the app's push update. Sounds still play while Tin Hat is open.</NoteRow>
          </Section>
        )
      ) : (
      <Section
        title="Desktop notifications"
        hint="You're notified for DMs, @mentions, replies to you, new invites and rooms set to All messages. Change a room: right-click it (long-press on phones) → Notifications."
      >
        <SwitchRow
          id="notifications.notify-mentions"
          label="Mentions and DMs"
          description="Pop-ups for the messages above while Tin Hat is open."
          checked={on(desk)}
          onToggled={toggle("desktop-notifications")}
        />
        <SwitchRow
          id="notifications.notify-calls"
          label="When someone starts a call"
          description="Calls ring in every room you haven't muted."
          checked={on(calls)}
          onToggled={toggle("notify.calls")}
        />
        {blocked && <NoteRow tone="danger">Your browser is blocking notifications for this site — allow them in its site settings.</NoteRow>}
        {notAsked && (
          <Row label="Not allowed yet" description="Your browser asks once — allow Tin Hat to show notifications." attrs={{ "data-notify-allow": "" }} control={<Button highlighted text="Allow" onClick={() => void requestNotificationPermission()} />} />
        )}
        {perm === "unsupported" && <NoteRow>This browser can't show desktop notifications; sounds still play.</NoteRow>}
      </Section>
      )}

      <Section title="Sounds">
        <SwitchRow id="notifications.sound-open-room" label="Sound for messages in the open room" description="When a message arrives in the room you're looking at." checked={on(recv)} onToggled={toggle("snd.receive")} />
        <SwitchRow id="notifications.sound-send" label="Sound when you send" checked={on(send)} onToggled={toggle("snd.send")} />
        <SwitchRow
          id="notifications.sound-join-leave"
          label="Join and leave chime"
          description="Uses the sound pack chosen in Appearance, at the volume below."
          checked={on(chime)}
          onToggled={toggle("snd.callchime")}
        />
        <ComboRow
          id="notifications.notification-sound"
          label="Notification sound"
          model={NOTIFY_SOUNDS}
          currentIndex={on(notify) ? notifyVar + 1 : 0}
          onActivated={(i) => {
            if (i === 0) {
              setPref("snd.notify", "0");
              return;
            }
            setPref("snd.notify", "1");
            setPref("snd.notify.variant", i === 1 ? "" : String(i));
            previewSound(notifyFile(i - 1));
          }}
          after={<ToolButton iconName="media-playback-start-symbolic" tip="Preview" disabled={!on(notify)} onClick={() => previewSound(notifyFile(notifyVar))} />}
        />
        <ComboRow
          id="notifications.ringtone"
          label="Ring for incoming calls"
          model={RING_SOUNDS}
          currentIndex={on(ring) ? ringVar + 1 : 0}
          onActivated={(i) => {
            if (i === 0) {
              setPref("snd.ring", "0");
              return;
            }
            setPref("snd.ring", "1");
            setPref("snd.ring.variant", i === 1 ? "" : "2");
            previewSound(ringFile(i - 1));
          }}
          after={<ToolButton iconName="media-playback-start-symbolic" tip="Preview" disabled={!on(ring)} onClick={() => previewSound(ringFile(ringVar))} />}
        />
        <Row
          id="notifications.sound-volume"
          label="Sound volume"
          description="Every Tin Hat sound: chimes, notifications and the ring."
          control={
            <div className={p.sliderCtl}>
              <Slider
                className={p.fill}
                aria-label="Sound volume"
                from={0}
                to={100}
                stepSize={5}
                value={volLive ?? vol}
                onMoved={(v) => {
                  setVolLive(v);
                  setPref("snd.volume", String(Math.round(v)));
                }}
                onRelease={() => setVolLive(null)}
              />
              <span className={p.pct}>{Math.round(volLive ?? vol)}%</span>
            </div>
          }
        />
      </Section>
    </>
  );
}

/** Web only (REACH §3.2 + A2.10/A2.12): push to this device while Tin Hat is closed — features/push's store. */
function ThisDevice() {
  const st = usePushStore();
  const pushOn = useServerFeature("push"); // docs/SELFHOST.md: no web push on this server → no section
  const sup = st.support;
  // a Tin Hat app's web view has no Web Push (and no "Add to Home Screen"): the apps notify natively — features/native
  if (!pushOn || inTinHatApp()) return null;
  const denied = st.permission === "denied";
  const isOn = st.phase === "on";
  const busy = st.phase === "turning-on" || st.phase === "turning-off";
  const checked = (isOn || st.phase === "turning-on" || st.phase === "checking") && !denied;
  const statusLine = denied
    ? BLOCKED_LINE
    : st.phase === "turning-on"
      ? "Setting up…"
      : st.phase === "turning-off"
        ? "Turning off…"
        : isOn
          ? ON_LINE
          : st.phase === "checking"
            ? "Checking…"
            : st.phase === "repair"
              ? "Notifications stopped reaching this device."
              : st.phase === "stuck"
                ? STUCK_LINE
                : "Off — this device only notifies while Tin Hat is open.";
  return (
    <Section title="This device">
      {!sup.ok ? (
        <NoteRow>
          <span data-push-support={sup.kind}>{sup.text}</span>
        </NoteRow>
      ) : (
        <>
          <SwitchRow
            label="Notifications when Tin Hat is closed"
            description={<span data-push-status="">{statusLine}</span>}
            checked={checked}
            disabled={busy || denied}
            switchAttrs={{ "data-push-phase": st.phase }}
            // enablePush() calls Notification.requestPermission() synchronously — this handler IS the tap (iOS)
            onToggled={(v) => (v ? enablePush() : void disablePush())}
          >
            {st.phase === "repair" && !denied && (
              <div>
                <Button highlighted text="Turn on again" onClick={() => enablePush()} />
              </div>
            )}
            {st.phase === "stuck" && (
              <div>
                <Button highlighted text="Try again" onClick={() => void disablePush()} />
              </div>
            )}
            {st.error && <Hint tone="danger">{st.error}</Hint>}
          </SwitchRow>
          {isOn && <SwitchRow label="Only when I'm away from my computer" description={QUIET_CAPTION} checked={st.quiet} onToggled={(v) => void setQuiet(v)} />}
          {isOn && (
            <Row
              label="Send a test notification"
              description="Encrypted chats arrive as “New message” — the server can't read them. Open Tin Hat for the text."
              control={<Button text="Send test" icon="notifications" onClick={() => void sendTest()} />}
            >
              {st.note && <Hint>{st.note}</Hint>}
            </Row>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * "Notifications on this phone" — inside a Tin Hat app with "notifications" (docs/NATIVE-APPS.md): the app's native
 * device owns the pusher, the page shows one switch. The state is read again whenever the page comes back to the
 * front (the person may have changed it in the phone's settings meanwhile). docs/WEB-EXCEPTIONS.md (phone-only).
 */
function PhoneNotificationsSection() {
  const userId = getSession().userId ?? "";
  // undefined = checking; null = the app didn't answer
  const [ans, setAns] = useState<PhoneNotifyAnswer | null | undefined>(undefined);
  const [busy, setBusy] = useState<"" | "on" | "off">("");
  const [error, setError] = useState("");
  // A generation per request: an answer counts only if nothing newer started since it was asked (a turn on/off, a
  // newer read, another account, leaving the pane), so a slow or late answer never overwrites a newer one.
  const gen = useRef(0);
  const changing = useRef(false);
  const refresh = useCallback(async () => {
    const g = ++gen.current;
    const a = await nativeNotifications.ask("state", userId, NOTIFY_READ_MS);
    if (g === gen.current) setAns(a);
  }, [userId]);
  useEffect(() => {
    setAns(undefined);
    setBusy("");
    setError("");
    changing.current = false;
    void refresh();
    const back = () => {
      if (document.visibilityState === "visible" && !changing.current) void refresh();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      gen.current++; // another account or the pane closing: drop whatever is still on its way
    };
  }, [refresh]);
  const toggle = async (v: boolean) => {
    const g = ++gen.current; // also invalidates any read still on its way
    changing.current = true;
    setBusy(v ? "on" : "off");
    setError("");
    // the app may show its setup sheet and the phone's prompt first: a long deadline, then "unknown"
    const a = await nativeNotifications.ask(v ? "enable" : "disable", userId, NOTIFY_CHANGE_MS);
    if (g !== gen.current) return;
    changing.current = false;
    setBusy("");
    if (!a) {
      setError("Tin Hat didn't answer. Try again.");
      void refresh();
      return;
    }
    setAns(a);
    if (a.error && a.error !== "cancelled") setError(a.error);
  };
  const state = ans?.state;
  const text = state ? phoneNotifyText(state) : null;
  return (
    <Section title="Notifications" hint="Sounds still play while Tin Hat is open.">
      {ans === undefined ? (
        <NoteRow>Checking…</NoteRow>
      ) : ans === null ? (
        <NoteRow tone="warning">Couldn't read this phone's notification setting.</NoteRow>
      ) : state === "unavailable" ? (
        <NoteRow>{text?.line}</NoteRow>
      ) : (
        <>
          <SwitchRow
            id="notifications.phone"
            label="Notifications on this phone"
            description={text?.description}
            checked={busy === "on" || (state === "on" && busy !== "off")}
            disabled={busy !== "" || state === "denied"}
            onToggled={(v) => void toggle(v)}
            switchAttrs={{ "data-phone-notify": state }}
          />
          {busy === "on" && <NoteRow>Turning on…</NoteRow>}
          {busy === "off" && <NoteRow>Turning off…</NoteRow>}
          {!busy && state === "on" && <NoteRow tone="ok">{text?.line}</NoteRow>}
          {!busy && state === "denied" &&
            (nativeNotifications.canOpenSettings() ? (
              <Row label={text?.line} control={<Button text="Open settings" onClick={() => nativeNotifications.openSettings()} />} />
            ) : (
              <NoteRow tone="warning">{text?.line}</NoteRow>
            ))}
          {error && <NoteRow tone="danger">{error}</NoteRow>}
        </>
      )}
    </Section>
  );
}
