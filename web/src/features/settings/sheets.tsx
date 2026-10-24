// sheets.tsx — the dialogs this area owns: Report a problem (BugReportDialog), Sign out (backup-aware confirm), the
// first-run log-sharing consent and the Noise-cancellation test sheet. All hosted by <SettingsOverlays/> (r.overlays);
// they open over the Settings window (dialogs sit above in-app windows), so Settings stays where it was underneath.
import { useEffect, useRef, useState } from "react";
import { bus, toast, useBus } from "@/core/bus";
import { getCryptoStatus, getSession, logout, useCryptoStatus, useSession } from "@/core/matrix";
import { usePref, setPref } from "@/core/prefs";
import { BasicButton, ConfirmDialog, Dialog, OverlaySheet, PromptDialog, Switch, cx, useIsMobile } from "@/ui";
import { LOGSHIP_ENABLED, applyLogship, logshipState, submitBugReport } from "./logs";
import { EngineLevelMeter } from "./LevelMeter";
import { applyNs, startMicMonitor, stopMicMonitor, useMicDsp, useMicRunning } from "./callbridge";
import { SheetHeader } from "./SheetHeader";
import { useVerifyUi } from "./VerifyDeviceDialog";
import s from "./dialogs.module.css";

// ---- version / updates (§5: version.json written by the deploy script, D16) ---------------------
// ONE updater: the nav's (`@/features/nav` update.ts — ☰ row, update banner, What's-new sheet, polls
// every 30 min + on focus). About only reads its store and triggers a check, so the three surfaces can
// never disagree. The deploy sets VITE_BUILD_HASH (= version.json `build`, tools twdeploy).

export function buildHash(): string {
  return (import.meta.env.VITE_BUILD_HASH as string | undefined) || "dev";
}

// ---- About: since 2026-09-29 the Settings window's About & help pane (panes/AboutPane.tsx); bus `openAbout` opens it
// (SettingsHost). --------------------------------------------------------------------------------------------------

// "What's new" is the nav's sheet (INTEGRATION #3: nav answers bus `openWhatsNew` + the update banner).

// ---- Keyboard shortcuts (§2.18 + D13 notes) ----------------------------------------------------

export const SHORTCUT_ROWS: Array<[string, string]> = [
  ["Ctrl+K", "Jump to any room"],
  ["Ctrl+,", "Settings"],
  ["Alt+↑ / Alt+↓", "Previous / next room  (+Shift: unread only)"],
  ["Ctrl+Shift+M", "Mute / unmute your mic"],
  ["Ctrl+Shift+D", "Deafen / undeafen"],
  ["Ctrl (hold)", "Push to talk, when enabled"],
  ["Esc / F11", 'Leave / toggle "fill the app" in a call'],
  ["Ctrl+Shift+S", "Soundboard"],
  ["Ctrl+Shift+E", "Calendar"],
  ["PgUp / PgDn / Home / End", "Scroll the conversation"],
  ["Esc", "Cancel a reply or edit; jump to the newest message"],
  ["Ctrl+V", "Paste an image or file into the composer"],
  ["↑ (empty composer)", "Edit your last message"],
];

// The Keyboard shortcuts dialog itself is hosted by the nav (INTEGRATION #1: exactly one dialog opens
// on bus `openShortcuts`); SHORTCUT_ROWS above stays exported for reference/tests.

// ---- Report a problem --------------------------------------------------------------------------

let keepNote = false;
let keptText = "";

function BugReportDialog() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const mobile = useIsMobile();
  useBus("openBugReport", () => {
    setNote(keepNote ? keptText : "");
    setOpen(true);
  });
  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 0);
  }, [open]);
  const send = () => {
    const text = note;
    if (!text.trim()) return;
    setOpen(false);
    toast("Sending report…");
    submitBugReport(text)
      .then((msg) => {
        keepNote = false;
        keptText = "";
        toast(msg, { timeoutMs: 6000 });
      })
      .catch((e) => {
        keepNote = true;
        keptText = text;
        toast(`Report failed: ${(e as Error)?.message ?? e}`, { timeoutMs: 6000, kind: "error" });
      });
  };
  return (
    <Dialog
      open={open}
      onClose={() => {
        keptText = note;
        setOpen(false);
      }}
      title="Report a problem"
      width={mobile ? "100%" : "min(520px, calc(100vw - 36px))"}
      className={cx(s.bugDialog, mobile && s.mobileDialog)}
      buttons={[
        { text: "Send report", role: "accept", disabled: !note.trim(), onClick: send },
        { text: "Cancel", role: "reject", onClick: () => setOpen(false) },
      ]}
    >
      <div className={s.col4}>
        <span className={s.text}>
          {LOGSHIP_ENABLED
            ? "Describe what happened. Your note plus the current session's log (scrubbed of IPs and tokens) goes straight to the problem repo — no restart needed."
            : "Describe what happened. Your note goes straight to the problem repo. (The browser version can't attach its session log yet.)"}
        </span>
        <textarea
          ref={ref}
          className={s.bugNote}
          aria-label="What happened"
          placeholder="What were you doing? What did you expect? What happened instead?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

// ---- Sign out (SET-100) ------------------------------------------------------------------------

function SignOutConfirm() {
  const [open, setOpen] = useState(false);
  const st = useCryptoStatus();
  const { userId = "" } = useSession();
  useBus("requestSignOut", () => setOpen(true));
  const ready = st.backupEnabled;
  const mobile = useIsMobile();
  return (
    <ConfirmDialog
      open={open}
      className={mobile ? s.bottomSheet : undefined}
      onClose={() => setOpen(false)}
      dialogTitle="Sign out?"
      message={
        ready
          ? `Sign out of ${userId}? Your encryption keys are backed up on the server, so your encrypted messages will still be readable when you sign back in.`
          : `Sign out of ${userId}? This account has no key backup. Signing out deletes this device's encryption keys, so the encrypted messages you can read now will become unreadable — here and on any new device. To keep them, set up key backup first (Settings → Devices & security).`
      }
      confirmText={ready ? "Sign out" : "Sign out anyway"}
      destructive
      onConfirmed={() => void logout({ status: "Signed out" })}
    />
  );
}

// ---- first-run log-sharing consent (SET-69) ----------------------------------------------------

const noConsent = (() => {
  try {
    return /[?&](noconsent|noverify)\b/.test(location.search + location.hash);
  } catch {
    return false;
  }
})();

let consentOpen = false;

/** SET-110: the first-run tour (nav) waits while the verify dialog or the log-sharing consent is up
 *  — or while the consent is still due (never asked yet, shown 1.2 s after sign-in), or while a new account's first
 *  device is still setting up its encryption (F1: its Security Key dialog comes next). */
export function isOnboardingBusy(): boolean {
  return useVerifyUi.getState().open || consentOpen || getCryptoStatus().firstDevicePending || (LOGSHIP_ENABLED && !noConsent && logshipState() === -1);
}

function LogshipConsent() {
  const [open, setOpenRaw] = useState(false);
  const setOpen = (v: boolean) => {
    consentOpen = v;
    setOpenRaw(v);
  };
  const session = useSession();
  const verifyOpen = useVerifyUi((v) => v.open);
  const firstPending = useCryptoStatus().firstDevicePending;
  const asked = useRef(false);
  const mobile = useIsMobile();
  const ready = session.state === "ready";
  useBus("loggedOut", () => (asked.current = false));
  useEffect(() => {
    if (!LOGSHIP_ENABLED || !ready || asked.current || noConsent || logshipState() !== -1) return;
    const t = setTimeout(() => {
      // never over another popup: wait for the verify dialog (F1: and for a new account's Security Key)
      if (useVerifyUi.getState().open || getCryptoStatus().firstDevicePending) return;
      asked.current = true;
      setOpen(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [ready, verifyOpen, firstPending]);
  return (
    <ConfirmDialog
      open={open}
      className={mobile ? s.bottomSheet : undefined}
      onClose={() => setOpen(false)}
      dialogTitle="Help improve Tin Hat?"
      message="When something breaks, this app can automatically send its debug log to your server's owner so the problem can be fixed. Tokens, encryption keys, and IP addresses are stripped out first, and your messages are never logged. It's on by default — you can turn it off now or any time in Settings → Privacy."
      confirmText="Keep it on"
      cancelText="Turn it off"
      onConfirmed={() => applyLogship(true)}
      onCancelled={() => applyLogship(false)}
    />
  );
}

// ---- Noise-cancellation test (SET-38) ------------------------------------------------------------

function NoiseTestSheet() {
  const [open, setOpen] = useState(false);
  const dsp = useMicDsp();
  const micRunning = useMicRunning();
  useBus("openNoiseTest", () => setOpen(true));
  useEffect(() => {
    if (!open) return;
    startMicMonitor();
    return () => stopMicMonitor();
  }, [open]);
  if (!open) return null;
  const strong = dsp.ns === "strong" && dsp.ncAvailable;
  const close = () => setOpen(false);
  return (
    <OverlaySheet open onClose={close} header={<SheetHeader text="Noise cancellation" />} preferredWidth={468}>
      <div className={s.col8}>
        <span className={s.dim} style={{ maxWidth: 468 }}>
          Talk into your mic. Left is your raw input; right is after RNNoise. Toggle it below — steady background noise should shrink on the right.
        </span>
        <Switch
          text={dsp.ncAvailable ? "Strong suppression (RNNoise) enabled" : "Strong suppression (RNNoise) — not available in this browser"}
          disabled={!dsp.ncAvailable}
          style={dsp.ncAvailable ? undefined : { opacity: 0.5 }}
          checked={strong}
          onToggled={(on) => applyNs(on ? "strong" : "standard")}
        />
        {!dsp.ncAvailable && (
          <span className={cx(s.text, s.neg)}>RNNoise couldn't load in this browser, so strong noise cancellation can't run here. Standard suppression still works.</span>
        )}
        {!micRunning && <span className={s.dim}>Live meter unavailable — the microphone couldn't be opened (check the browser's permission for this site).</span>}
        {micRunning && (
          <div className={s.meters}>
            <div className={s.meterCol}>
              <span className={s.bold}>Before (raw)</span>
              <EngineLevelMeter which="pre" color="var(--th-settings-meter-raw-fill)" />
            </div>
            <div className={s.meterCol}>
              <span className={s.bold}>{strong ? "After (cancelled)" : "After (off — same as raw)"}</span>
              <EngineLevelMeter which="mic" />
            </div>
          </div>
        )}
      </div>
    </OverlaySheet>
  );
}

// ---- host ----------------------------------------------------------------------------------------

export function SettingsSheets() {
  const session = useSession();
  const signedIn = session.state === "ready" || session.state === "syncing";
  // pref read so prefs stay in sync across tabs (theme etc. handled by the app)
  usePref("logship", "");
  if (!signedIn) return null;
  return (
    <>
      <BugReportDialog />
      <SignOutConfirm />
      <LogshipConsent />
      <NoiseTestSheet />
    </>
  );
}

// convenience for other modules (no React import)
export const openAbout = () => bus.emit("openAbout", {});
export const openBugReport = () => bus.emit("openBugReport", {});
export const signOut = () => bus.emit("requestSignOut", {});
void setPref;
void getSession;
