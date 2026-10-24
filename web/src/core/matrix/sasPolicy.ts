// sasPolicy.ts — the pure rules of emoji (SAS) verification that Tin Hat Web and the desktop app share
// (desktop: crates/app/src/sas_policy.rs). No imports, no DOM: node runs sasPolicy.test.ts on it directly,
// and the desktop mirrors the same test vectors. Change a rule or a sentence here → change it there too.
//
//   sasStartPolicy(theirMethods)  S1: may the REQUESTER start the SAS the moment the other side is ready?
//   sasCancelText(code)           S6: the sentence the dialog shows for a cancelled flow (by cancel code)
//   sasWaitNote(peer)             S2: the note while we wait for a QR-capable peer to choose emoji
//   SAS_START_BUTTON / SAS_VERIFIER_DONE_NOTE / SAS_INCOMING_TITLE  S2 / S7 strings
//
// Why S1 exists (a field case, docs/VERIFY-SAS.md): Element Classic (iOS 1.11.39) shows a
// "Scan QR code" chooser after it sends its ready, and that screen never looks for a SAS that already
// exists. Our immediate start landed before the chooser listened; the user then tapped "Can't scan?", Classic
// started a second SAS on the transitioned request and the Rust SDK cancelled both. A peer that offers QR
// lets its user choose, so we wait for it (or for our user's "Start emoji comparison").

export type SasStart = "start" | "wait" | "no-sas";

export const SAS_V1 = "m.sas.v1";
export const QR_SHOW_V1 = "m.qr_code.show.v1";
export const QR_SCAN_V1 = "m.qr_code.scan.v1";
export const RECIPROCATE_V1 = "m.reciprocate.v1";
/** The method names the SDK can report for the other side (anything else is ignored). */
export const KNOWN_METHODS: readonly string[] = [SAS_V1, QR_SHOW_V1, QR_SCAN_V1, RECIPROCATE_V1];

/**
 * S1 — requester only. No m.sas.v1 → "no-sas"; m.sas.v1 plus a QR show/scan method → "wait" (the peer's
 * user picks the method); otherwise "start". m.reciprocate.v1 alone is NOT QR: desktops ≤ 10.6.0 send
 * [m.sas.v1, m.reciprocate.v1] (the SDK default without the qrcode feature). Order-independent; unknown
 * extra methods are ignored.
 */
export function sasStartPolicy(theirMethods: readonly string[]): SasStart {
  if (!theirMethods.includes(SAS_V1)) return "no-sas";
  if (theirMethods.includes(QR_SHOW_V1) || theirMethods.includes(QR_SCAN_V1)) return "wait";
  return "start";
}

/** S6 — the dialog's note for a cancelled flow, by the m.key.verification.cancel code (no raw prefix). */
export function sasCancelText(code?: string | null): string {
  const c = code?.trim() ?? ""; // blank = no code (desktop cancel_note trims the same way)
  switch (c) {
    case "m.user":
      return "The verification was cancelled.";
    case "m.timeout":
      return "It took too long, so the check timed out. Try again.";
    case "m.unexpected_message":
    case "m.unknown_transaction":
      return "The other device started its own comparison over this one, so both stopped. Try again, and on the other device wait for the emoji instead of starting.";
    case "m.key_mismatch":
    case "m.mismatched_sas":
    case "m.mismatched_commitment":
      return "The emoji didn't match, so nothing was trusted.";
    case "m.accepted":
      return "Another of your devices answered first.";
    case "m.user_mismatch":
    case "m.invalid_message":
    case "m.unknown_method":
      return "The other device sent something this app can't use. Try again, or use your Security Key.";
    default:
      return c ? `The verification was cancelled (${c}).` : "The verification was cancelled.";
  }
}

/** S2 — the waiting note once a QR-capable peer is ready (we do not start on our own). */
export function sasWaitNote(peer: string): string {
  return `${peer} is ready. On it, choose "Verify by emoji" — in the old Element app, tap "Can't scan?". Or start from here.`;
}

/**
 * S3 — the automatic start (policy "start") waits this long for the rest of the sync batch before its guard re-check
 * (desktop: sas_policy::AUTO_START_SETTLE_MS). The manual start does not wait.
 */
export const SAS_AUTO_START_SETTLE_MS = 300;

/** S2 — the highlighted full-width button under that note (manual start through the start guard). */
export const SAS_START_BUTTON = "Start emoji comparison";
/** S7 — the verifier's done note (the requester's stays "This device is verified — decrypting…"). */
export const SAS_VERIFIER_DONE_NOTE = "Verified. Your other device can read your messages now.";
/** S7 — the dialog title through the whole incoming flow (waiting → emoji → confirming → done/cancelled). */
export const SAS_INCOMING_TITLE = "Verify the other device";
/** The no-sas outcome (unchanged wording, bridge.rs drive_verification Ok(None)). */
export const SAS_NO_SAS_NOTE = "The other device did not offer emoji verification.";

// ---- F1 — the first device of a brand-new account (docs/VERIFY-SAS.md "First device", 2026-09-29) ----------------
// Desktop mirror: sas_policy.rs first_device_setup / FIRST_DEVICE_*.

/**
 * F1 — does this sign-in set up the account's encryption itself? Only an account that has never had any: no
 * cross-signing identity on the server AND no key backup there. Never a guest. Every other device is verified against
 * one that already holds the keys (emoji), or with the Security Key.
 */
export function firstDeviceSetup(o: { guest: boolean; hasCrossSigning: boolean; backupOnServer: boolean }): boolean {
  return !o.guest && !o.hasCrossSigning && !o.backupOnServer;
}
/** F1 — how long the verify banner / sign-in prompt wait for the first-device check before showing anyway. */
export const FIRST_DEVICE_MAX_WAIT_MS = 30000;
/** F2 — the dialog title while the new Security Key is on screen. */
export const FIRST_DEVICE_TITLE = "Your Security Key";
/** F2 — the note above the new Security Key. */
export const FIRST_DEVICE_NOTE =
  "Encryption is set up and this device is verified — your other devices verify against it. Save this Security Key somewhere safe: it's shown once, and it's the only way back into your encrypted messages if you ever lose every signed-in device.";
