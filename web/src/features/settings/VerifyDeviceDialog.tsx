// VerifyDeviceDialog.tsx — VerifyDeviceDialog.qml over core's verification store (bridge.rs SAS /
// Security Key / Set up recovery). Basic Dialog, width min(26gu, winW − 2gu), bold 12 px title,
// full-width 40 px Basic buttons; `highlighted` ones render the Breeze intent (D2: visible accent
// text on the bg fill), the busy spinner is drawn visibly in textDim (Q6 fix).
//
// Host behaviour (Main.qml:4457-4546): auto-opens once after sign-in while unverified (not with
// ?noverify / --tinhat-noverify), opens itself for an incoming self-verification request, closes
// itself when this device BECOMES verified (edge-triggered like onMVerifiedChanged — an already verified
// device that is asked to vouch keeps the sheet; toast "This device is verified." when the SAS path armed
// it), toasts "Emoji matched — finishing up…" ONLY on `done` (native braces bug not copied), and
// hands back to Settings when opened from there (SET-10).
//
// Emoji verification (docs/VERIFY-SAS.md): a QR-capable peer (Element Classic / Element Web) is not raced —
// the note asks its user to pick emoji and "Start emoji comparison" starts from here (S2); the title stays
// "Verify the other device" through the whole incoming flow (S7). Phones (S9): the one-line states are
// centred in the full-screen sheet with a 64 px status glyph, 16 px note and 48 px buttons, so no state is
// a black screen with one line on OLED; the desktop-browser dialog stays the native one.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  acceptDeviceVerification,
  cancelDeviceVerification,
  confirmSasMatch,
  FIRST_DEVICE_TITLE,
  resetVerification,
  restoreFromSecurityKey,
  SAS_INCOMING_TITLE,
  SAS_START_BUTTON,
  setUpRecovery,
  startDeviceVerification,
  startOver,
  startSasComparison,
  useCryptoStatus,
  useSession,
  useVerification,
} from "@/core/matrix";
import { bus, toast, useBus } from "@/core/bus";
import { isGuestAccount } from "@/core/server";
import { keyFirst } from "@/core/matrix/moved";
import { START_OVER } from "@/core/matrix/startOver";
import { FirstKeyDialog } from "@/features/selfhost/FirstKeyDialog";
import { BasicButton, BasicCheckBox, BasicTextField, BusyIndicator, Button, Dialog, Icon, TextArea, cx, useIsMobile } from "@/ui";
import s from "./dialogs.module.css";

interface VerifyUi {
  open: boolean;
  keyPathOpen: boolean;
  busy: boolean;
  status: string;
  armed: boolean;
}

/** The Security Key is masked by CSS where the browser can (Safari, Chromium): a second type="password" field next to
 *  the account password made iOS treat the dialog as a change-password form (iPhone/iPad sweep, 2026-10-25). Elsewhere
 *  it stays a password field, masked as on the desktop. */
const MASK_BY_CSS = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-text-security", "disc");
export const useVerifyUi = create<VerifyUi>()(() => ({ open: false, keyPathOpen: false, busy: false, status: "", armed: false }));
const vset = (p: Partial<VerifyUi>) => useVerifyUi.setState(p);

export function openVerifyDialog(): void {
  vset({ open: true });
}

/** W1: the dialog threw while rendering — drop the flow's state and close it (the boundary toasts). */
export function resetVerifyDialog(): void {
  resetVerification();
  vset({ open: false, keyPathOpen: false, busy: false, status: "", armed: false });
}

/** Devices & security → "Set up key backup": open the dialog (over the Settings window), run recovery. */
export function runSetUpBackup(password: string): void {
  vset({ open: true, armed: true });
  void setUpRecovery(password);
}

const noVerify = (() => {
  try {
    return /[?&]noverify\b/.test(location.search + location.hash);
  } catch {
    return false;
  }
})();

// SET-81's "once" is per signed-in device and module-level, so a remount of the host (the W1 overlay boundary
// brings it back after a render error; a shell switch) does not auto-open the sheet again.
let autoOpenedFor = "";

export function VerifyDeviceHost() {
  const ui = useVerifyUi();
  const v = useVerification();
  const st = useCryptoStatus();
  const session = useSession();
  const prevState = useRef(v.sasState);
  // null until the first computed status: loading → verified is not a "became verified" edge
  const prevVerified = useRef<boolean | null>(st.loading ? null : st.thisDeviceVerified);
  const signedIn = session.state === "ready" || session.state === "syncing";

  useBus("openVerifyDialog", () => vset({ open: true }));
  useBus("loggedOut", () => {
    autoOpenedFor = "";
    vset({ open: false, keyPathOpen: false, busy: false, status: "", armed: false });
    resetVerification();
  });

  // SET-81 auto-open once after sign-in when unverified — F1: after the first-device check, so a brand-new account's
  // first device (which verifies itself) never sees "use another device"
  useEffect(() => {
    const who = `${session.userId ?? ""}|${session.deviceId ?? ""}`;
    // a temporary guest account (docs/GUESTS.md) is never asked to verify
    if (!signedIn || autoOpenedFor === who || noVerify || isGuestAccount(session.userId) || st.loading || !st.cryptoReady || st.firstDevicePending) return;
    autoOpenedFor = who;
    if (!st.thisDeviceVerified) vset({ open: true });
  }, [signedIn, session.userId, session.deviceId, st.loading, st.cryptoReady, st.thisDeviceVerified, st.firstDevicePending]);

  // F2 the first device's new Security Key opens the dialog (?noverify too: the key is shown once, never skipped)
  useEffect(() => {
    // (12.0.1: and any other new key — Start over's, Set up recovery's — if the dialog was closed meanwhile)
    if ((v.firstDevice || !!v.recoveryKey) && v.sasState === "recovery-done" && !ui.open) vset({ open: true });
  }, [v.firstDevice, v.recoveryKey, v.sasState, ui.open]);

  // SET-88 incoming self-verification opens the dialog
  useEffect(() => {
    if (v.sasIncoming && v.sasState === "waiting" && !ui.open) vset({ open: true });
  }, [v.sasIncoming, v.sasState, ui.open]);

  // SET-89 toast only on done
  useEffect(() => {
    if (v.sasState !== prevState.current) {
      if (v.sasState === "done") {
        toast("Emoji matched — finishing up…", { timeoutMs: 3000 });
        vset({ armed: true });
      }
      if (v.sasState === "waiting" || v.sasState === "emoji") vset({ armed: true });
      prevState.current = v.sasState;
    }
  }, [v.sasState]);

  // auto-close once this device BECOMES verified (Main.qml onMVerifiedChanged — an edge, not a level: on a
  // device that was verified all along, an incoming request's sheet used to close and reopen itself in a
  // loop), not while the one-time recovery key is on screen
  useEffect(() => {
    const was = prevVerified.current;
    prevVerified.current = st.loading ? null : st.thisDeviceVerified;
    if (was !== false || !st.thisDeviceVerified || !ui.open) return;
    if (v.sasState === "recovery-done" || v.sasState === "recovery-working") return;
    if (v.sasIncoming && v.sasState !== "") return; // another device's request is on screen: keep it
    const armed = ui.armed;
    close(false);
    if (armed) toast("This device is verified.", { timeoutMs: 4000 });
  }, [st.loading, st.thisDeviceVerified]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = (cancel = true) => {
    const live = v.sasState === "waiting" || v.sasState === "emoji" || v.sasState === "confirming";
    if (cancel && live) void cancelDeviceVerification(); // sends the cancel; its note would only be seen on a reopen
    // closing ends the flow on screen too: a reopen starts at the chooser, not at a stale "cancelled" (whose
    // incoming title would now say "Verify the other device")
    if ((cancel && live) || v.sasState === "cancelled" || v.sasState === "done" || v.sasState.startsWith("recovery")) resetVerification();
    vset({ open: false, keyPathOpen: false, status: "", busy: false, armed: false });
  };

  if (!signedIn) return null;
  // selfhost/firstrun item 2: the calm first run shows the first device's new Security Key as its own step (plain
  // words, Copy / Download / Done, no checkbox — features/selfhost/FirstKeyDialog.tsx); closing it goes straight in
  if (v.firstDevice && v.sasState === "recovery-done" && v.recoveryKey)
    return <FirstKeyDialog open={ui.open} recoveryKey={v.recoveryKey} onClose={() => close(false)} />;
  return <VerifyDeviceDialog open={ui.open} onClose={() => close(true)} />;
}

/** S9 hold: how long the sheet/dialog action buttons stay disabled after the layout changed under the finger (desktop: HOLD_MS in VerifyDeviceDialog.qml). */
const SHEET_HOLD_MS = 1000;

export function VerifyDeviceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useSession().userId ?? "";
  const ui = useVerifyUi();
  const v = useVerification();
  // no identity to verify against (a moved server, core/matrix/moved.ts): the Security Key first, no "another device"
  const keyOnly = keyFirst(useCryptoStatus());
  const mobile = useIsMobile();
  const [key, setKey] = useState("");
  const [pw, setPw] = useState("");
  const [saved, setSaved] = useState(false);
  // 12.0.1: "Lost your Security Key? Start over" (crypto.ts startOver)
  const [soOpen, setSoOpen] = useState(false);
  const [soPw, setSoPw] = useState("");
  useEffect(() => {
    if (!open) {
      setKey("");
      setPw("");
      setSoPw("");
      setSoOpen(false);
      setSaved(false);
    }
  }, [open]);

  const verifyKey = async () => {
    if (ui.busy || !key.trim()) return;
    vset({ busy: true, status: "Verifying…", armed: true });
    try {
      await restoreFromSecurityKey(key);
      vset({ busy: false, status: "Verified — decrypting…" });
    } catch (e) {
      vset({ busy: false, status: (e as Error)?.message ?? String(e) });
    }
  };
  const bootstrap = () => {
    if (!pw) return;
    const p = pw;
    setPw("");
    vset({ armed: true });
    void setUpRecovery(p);
  };

  const st = v.sasState;
  // S9 hold (phones): the centred sheet puts the NEXT state's buttons where the finger just was — "Accept" and "Start
  // emoji comparison" sit exactly where "They match" / "They don't match" appear a few hundred ms later, and Cancel
  // slides under the Start button when it hides (adversarial review 2026-09-25: on an iPhone SE a second tap on Accept
  // confirmed emoji nobody had looked at; on an iPhone 15 it sent "They don't match"). Like Firefox's
  // security.dialog_enable_delay, the sheet's action buttons stay disabled for SHEET_HOLD_MS after the state (or the
  // Start button) changes. Every form factor (parity, adversarial review 2026-09-25): the NATIVE desktop dialog has the
  // same overlap (a double click on "Start emoji comparison" 90-250 ms apart confirmed unseen emoji 3/3 in the real
  // app), so the desktop app holds its buttons the same way and the desktop-browser dialog follows the native one.
  // (+ the emoji themselves: new emoji under the finger are a new layout too — desktop holdKey is the same)
  const holdKey = `${st}|${v.sasCanStart ? 1 : 0}|${v.sasIncoming ? 1 : 0}|${v.sasEmoji.map((x) => x.e).join("")}`;
  const [held, setHeld] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    setHeld(true); // before the first paint of the new layout
    const t = window.setTimeout(() => setHeld(false), SHEET_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [holdKey, open]);
  const hold = held;
  // S7: the verifier's title holds through waiting → emoji → confirming → done / cancelled
  const title = v.firstDevice && st === "recovery-done" ? FIRST_DEVICE_TITLE : v.sasIncoming && st !== "" && !st.startsWith("recovery") ? SAS_INCOMING_TITLE : "Verify this device";
  const hideClose = st === "recovery-done" && !saved;
  // S9 (phones): the one-line states sit in the middle of the full-screen sheet behind a 64 px glyph
  const centered = mobile && (st === "waiting" || st === "confirming" || st === "done" || st === "cancelled" || st === "recovery-working");
  const spinner = mobile ? (
    <BusyIndicator size={64} color="var(--th-verify-status-busy-icon)" className={s.spinner} />
  ) : (
    <BusyIndicator size={48} color="var(--th-loader-spinner-fg)" className={s.spinner} />
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={mobile ? "100%" : "min(468px, calc(100vw - 36px))"}
      className={cx(mobile && s.mobileDialog, mobile && s.verifySheet)}
      bodyClassName={cx(mobile && s.mobileBody)}
      standardButtons={hideClose ? [] : ["close"]}
      closeOnOutside={false}
    >
      <div className={cx(s.col8, centered && s.mCenter)} data-verify-state={st || "idle"}>
        {st === "" && keyOnly && (
          <div className={s.col4}>
            <span className={s.text}>Unlock your encrypted messages on this device with your Security Key.</span>
            <span className={s.dim}>
              It&apos;s the key you saved when you first signed in. If your server moved to a new address, this brings your
              messages back and makes this device your new verified one.
            </span>
          </div>
        )}
        {st === "" && !keyOnly && (
          <div className={s.col4}>
            <span className={s.text}>
              Verifying proves this really is you, so encrypted messages can be read here and others stop seeing warnings about you.
            </span>
            <BasicButton className={cx(s.full, s.hl)} highlighted text="Use another device" disabled={ui.busy} onClick={() => void startDeviceVerification()} />
            <span className={s.dim}>Compare seven emoji with a device you're already signed in to. Nothing to type.</span>
            <BasicButton
              className={s.full}
              flat
              text={ui.keyPathOpen ? "Hide the Security Key option" : "No other device? Use your Security Key"}
              onClick={() => vset({ keyPathOpen: !ui.keyPathOpen })}
            />
          </div>
        )}
        {st === "" && (ui.keyPathOpen || keyOnly) && (
          <div className={s.col4}>
            {!keyOnly && <span className={s.dim}>It's the Security Key you saved when you first set up encryption (Tin Hat shows it only once, so look where you keep it: a password manager, a note, a printout).</span>}
            <BasicTextField
              className={cx(s.full, MASK_BY_CSS && s.masked)}
              type={MASK_BY_CSS ? "text" : "password"}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Security Key"
              placeholder="Security Key (e.g. EsTx …)"
              value={key}
              disabled={ui.busy}
              onChange={(e) => setKey(e.target.value)}
              onAccepted={() => void verifyKey()}
            />
            <BasicButton
              className={cx(s.full, keyOnly && s.hl)}
              highlighted={keyOnly}
              text={ui.busy ? (keyOnly ? "Unlocking…" : "Verifying…") : keyOnly ? "Unlock with Security Key" : "Verify with Security Key"}
              disabled={ui.busy || !key}
              onClick={() => void verifyKey()}
            />
            {ui.status && <span className={cx(s.text, !ui.busy && !/^Verified/.test(ui.status) && s.neg)}>{ui.status}</span>}
            {/* 12.0.1: no Security Key and no other signed-in device — the way out (crypto.ts startOver; the desktop's
                VerifyDeviceDialog.qml has the same panel and words). Before this such an account was stuck for good. */}
            <BasicButton className={s.full} flat text={soOpen ? START_OVER.back : START_OVER.link} disabled={ui.busy} onClick={() => setSoOpen(!soOpen)} />
            {soOpen && (
              <form className={s.col4} data-start-over onSubmit={(e) => e.preventDefault()}>
                <span className={s.text}>
                  <b>{START_OVER.title}</b>
                </span>
                <span className={s.dim}>{START_OVER.hint}</span>
                {/* whose password this is: without a username field iOS read the form as "change password" and offered
                    to make up a new one (and save it over the real one): iPhone/iPad sweep 2026-10-25 */}
                <input className="th-sr-only" type="text" name="username" autoComplete="username" value={me} readOnly tabIndex={-1} aria-hidden="true" />
                <BasicTextField
                  className={s.full}
                  type="password"
                  autoComplete="current-password"
                  aria-label={START_OVER.placeholder}
                  placeholder={START_OVER.placeholder}
                  value={soPw}
                  disabled={ui.busy}
                  onChange={(e) => setSoPw(e.target.value)}
                  onAccepted={() => soPw && void startOver(soPw)}
                />
                <BasicButton className={s.full} text={START_OVER.button} disabled={ui.busy || !soPw} onClick={() => void startOver(soPw)} />
                {v.startOverNote && (
                  <span className={cx(s.text, s.neg)} data-start-over-note>
                    {v.startOverNote}
                  </span>
                )}
              </form>
            )}
          </div>
        )}
        {(st === "waiting" || st === "confirming") && (
          <div className={s.col8}>
            {spinner}
            <span className={cx(s.text, s.center, s.note)} data-verify-note>{v.sasNote}</span>
            {v.sasIncoming && st === "waiting" && <BasicButton className={cx(s.full, s.hl)} highlighted text="Accept" disabled={hold} onClick={() => void acceptDeviceVerification()} />}
            {!v.sasIncoming && st === "waiting" && v.sasCanStart && (
              <BasicButton className={cx(s.full, s.hl)} highlighted text={SAS_START_BUTTON} disabled={hold} onClick={() => void startSasComparison()} />
            )}
            <BasicButton className={s.full} flat text="Cancel" disabled={hold} onClick={() => void cancelDeviceVerification()} />
          </div>
        )}
        {st === "emoji" && (
          <div className={s.col8}>
            <span className={s.text}>{v.sasPeer ? `Confirm these emoji appear in the same order on ${v.sasPeer}.` : v.sasNote}</span>
            <div className={s.emojiGrid}>
              {v.sasEmoji.map((x, i) => (
                <div key={i} className={s.emojiCell} data-sas-emoji={`${x.e}${x.name}`}>
                  <span className={s.emoji}>{x.e}</span>
                  <span className={s.dim}>{x.name}</span>
                </div>
              ))}
            </div>
            <BasicButton className={cx(s.full, s.hl)} highlighted text="They match" disabled={hold} onClick={() => void confirmSasMatch()} />
            <BasicButton className={s.full} flat text="They don't match" disabled={hold} onClick={() => void cancelDeviceVerification({ mismatch: true })} />
          </div>
        )}
        {(st === "done" || st === "cancelled") && (
          <div className={cx(s.col4, mobile && s.mStack)}>
            {mobile && (
              <Icon
                className={s.spinner}
                name={st === "done" ? "checkmark-symbolic" : "window-close-symbolic"}
                size={64}
                color={st === "done" ? "var(--th-verify-status-done-icon)" : "var(--th-verify-status-cancelled-icon)"}
                staticOnly
              />
            )}
            <span className={cx(s.text, st === "done" ? s.pos : s.neg, s.note, mobile && s.center)} data-verify-note>{v.sasNote}</span>
            {st === "cancelled" && <BasicButton className={s.full} text="Try again" disabled={hold} onClick={() => void startDeviceVerification()} />}
            {st === "cancelled" && v.sasCanBootstrap && (
              <>
                <span className={s.dim}>Setting this up needs your account password — the server asks for it before it will trust new keys.</span>
                <BasicTextField
                  className={s.full}
                  type="password"
                  autoComplete="current-password"
                  aria-label="Account password"
                  placeholder="Account password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  onAccepted={bootstrap}
                />
                <BasicButton className={cx(s.full, s.hl)} highlighted disabled={!pw} text="Set up encryption on this device" onClick={bootstrap} />
              </>
            )}
          </div>
        )}
        {st === "recovery-working" && (
          <div className={s.col8}>
            {spinner}
            <span className={cx(s.text, s.center, s.note)} data-verify-note>{v.sasNote}</span>
          </div>
        )}
        {st === "recovery-done" && (
          <div className={s.col4}>
            <span className={cx(s.text, s.pos)}>{v.sasNote}</span>
            {v.recoveryKey && <TextArea className={s.keyArea} readOnly value={v.recoveryKey} aria-label="Recovery key" onFocus={(e) => e.currentTarget.select()} />}
            {v.recoveryKey && (
              <div>
                <Button
                  text="Copy key"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(v.recoveryKey)
                      .then(() => toast("Recovery key copied — paste it somewhere safe"))
                      .catch(() => toast("Couldn't copy — select the key and copy it by hand"));
                  }}
                />
              </div>
            )}
            <BasicCheckBox text="I've saved this key somewhere safe" checked={saved} onToggled={setSaved} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// Used by the shell banner / app menu without importing this module's React parts.
export function requestVerify(): void {
  bus.emit("openVerifyDialog", {});
}
