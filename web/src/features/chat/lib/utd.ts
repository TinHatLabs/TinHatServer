// utd.ts — the words for a message this device can't read (selfhost/firstrun item 3). SHARED LOGIC + WORDING: the
// desktop maps matrix-sdk's own unable-to-decrypt reason onto the same causes and shows the same sentences
// (docs/DESKTOP-PENDING-selfhost-firstrun.md §3; utd.test.ts holds the cases both replay).
// Pure: no React, no app imports.
//
// The old line said "Can't read this message — it was sent before this device had its key" for every such message,
// which hints that verifying would help — wrong when the message is older than the person's first sign-in (the
// round-4/5 blind tests: a friend wrote in General before the owner had ever opened Tin Hat; no device of theirs
// existed, so nobody can ever unlock it). The cause comes from the SDK's decryption failure code:
//
//   HISTORICAL_MESSAGE_{NO_KEY_BACKUP, BACKUP_UNCONFIGURED, WORKING_BACKUP}  sent before THIS device existed:
//       on the account's first device (F1 set up its encryption with no other device around)  → beforeFirstSignIn
//       a backup exists but this unverified device can't open it (BACKUP_UNCONFIGURED)       → beforeThisDeviceVerify
//       otherwise                                                                           → beforeThisDevice
//   HISTORICAL_MESSAGE_USER_NOT_JOINED                                                       → beforeJoined
//   MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE                                                → withheldUnverified
//   MEGOLM_KEY_WITHHELD                                                                      → withheld
//   anything else (the key may still arrive: unknown session / index, unknown, not yet tried) → waiting

export type UtdCause = "beforeFirstSignIn" | "beforeThisDevice" | "beforeThisDeviceVerify" | "beforeJoined" | "withheldUnverified" | "withheld" | "waiting";

export const UTD_TEXT: Readonly<Record<UtdCause, string>> = {
  beforeFirstSignIn: "Sent before you first signed in, so it can't be unlocked.",
  beforeThisDevice: "Sent before you signed in on this device. Messages from before your first sign-in can't be unlocked.",
  beforeThisDeviceVerify: "Sent before you signed in on this device. Verify this device to unlock it.",
  beforeJoined: "Sent while you weren't in this room, so it can't be unlocked.",
  withheldUnverified: "The sender only shares keys with verified devices. Verify this device to read what they send next.",
  withheld: "The sender's app didn't share the key to this message.",
  waiting: "Can't read this message yet — its key hasn't reached this device.",
};

const BEFORE_THIS_DEVICE = new Set(["HISTORICAL_MESSAGE_NO_KEY_BACKUP", "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED", "HISTORICAL_MESSAGE_WORKING_BACKUP"]);

export interface UtdInput {
  /** the SDK's decryption failure code (matrix-js-sdk DecryptionFailureCode), null when not known yet */
  code: string | null;
  /** this device is the account's first device: it set up the encryption while no other device existed */
  firstDevice: boolean;
  /** this device is verified (holds the cross-signing keys) */
  verified: boolean;
}

export function utdCause(i: UtdInput): UtdCause {
  const code = i.code ?? "";
  if (BEFORE_THIS_DEVICE.has(code)) {
    if (i.firstDevice) return "beforeFirstSignIn";
    if (code === "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED" && !i.verified) return "beforeThisDeviceVerify";
    return "beforeThisDevice";
  }
  if (code === "HISTORICAL_MESSAGE_USER_NOT_JOINED") return "beforeJoined";
  if (code === "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE") return "withheldUnverified";
  if (code === "MEGOLM_KEY_WITHHELD") return "withheld";
  return "waiting";
}

export function utdText(i: UtdInput): string {
  return UTD_TEXT[utdCause(i)];
}

// ---- which of them are rows (2026-10-23: rooms are encrypted by default) -------------------------------------------
// An event this device can't read still shows its relation: `m.relates_to` stays OUTSIDE the ciphertext. So:
//   deleted (redacted)                          → "deleted": a deleted message (nothing is left to unlock)
//   relation m.replace / m.reference / m.annotation → "hidden": an edit, a poll vote or end (or an in-room
//                                                  verification step), a reaction — never a bubble of its own
//   anything else                               → "row": a locked bubble with the cause's sentence
// The desktop's utd.rs utd_row replays utd.test.ts's table.

export type UtdRow = "row" | "deleted" | "hidden";
export const UTD_HIDDEN_RELATIONS: readonly string[] = ["m.replace", "m.reference", "m.annotation"];

export function utdRow(i: { redacted: boolean; relType: string | null }): UtdRow {
  if (i.redacted) return "deleted";
  if (i.relType !== null && UTD_HIDDEN_RELATIONS.includes(i.relType)) return "hidden";
  return "row";
}
