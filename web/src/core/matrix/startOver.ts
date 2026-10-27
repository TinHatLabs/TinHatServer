// startOver.ts — "Lost your Security Key? Start over" (2026-10-25): the words and the reading of the password check,
// pure (startOver.test.ts). The steps are crypto.ts startOver(); the desktop's twin is start_over.rs — same order,
// same sentences. For someone with no Security Key and no other signed-in device: before this they could sign in but
// never unlock or verify anything again, and nobody could help (keys never leave people's devices).
//
// The password is checked FIRST, with a request that changes nothing (deleting an empty list of devices asks for it and
// deletes nothing): a wrong one, or a server that wants more than a password, stops there with nothing changed. The
// SDK's reset (resetEncryption) deletes the old backup and secret storage before it publishes the new identity, so
// after the check anything that stops it says "Starting over didn't finish" — running it again completes it from
// wherever it stopped. (Publishing a new identity first doesn't work on the web: it tries to save it into the OLD
// secret storage, whose key is the one that's lost. The desktop's SDK can, and does — same check, same words.)

export const START_OVER = {
  link: "Lost your Security Key? Start over",
  back: "Never mind, I'll keep looking",
  title: "Start over with a new Security Key",
  hint:
    "Only for when no other device is signed in and your Security Key is gone. Messages from before stay locked, " +
    "unless a device that still has them signs in again. People who verified you will see that your security changed, " +
    "and may verify you again.",
  placeholder: "Account password",
  button: "Start over",
  empty: "Enter your account password to continue.",
  working: "Starting over — this takes a few seconds…",
  done:
    "You've started over. This is your new Security Key: save it somewhere safe — it is shown once and can't be " +
    "retrieved later. Messages from before stay locked unless a device that still has them signs in again.",
} as const;

/** The second way out, the Security Key (the chooser's own words; repeated on the screens below). */
export const USE_KEY = "No other device? Use your Security Key";

/**
 * Which verification screens carry the way out ("No other device? Use your Security Key", then "Lost your Security
 * Key? Start over"), fix/recovery-escape-phone 2026-10-26. A friend on a phone saw only "Use another device": Start over
 * sat inside the Security Key panel (behind a button that asks for the very key they didn't have), and once they had
 * tried another device the waiting and cancelled screens offered only Cancel / Try again, after a reopen too.
 * - the first screen (state ""), waiting for my other device (I asked) and cancelled: while this device is not verified
 *   (on the first screen right under the Security Key option, no other tap needed). A verified device keeps it where
 *   12.0.1 put it, inside the Security Key panel: one tap further from an accidental reset (Astra review 2026-10-26)
 * - never while another device's request is being answered (someone is there) or emoji are on screen.
 * The desktop's VerifyDeviceDialog.qml follows the same rule (docs/DESKTOP-PENDING-recovery-escape.md).
 */
export function offersStartOver(s: { sasState: string; sasIncoming: boolean; thisDeviceVerified: boolean }): boolean {
  if (s.thisDeviceVerified) return false;
  if (s.sasState === "") return true;
  if (s.sasState === "waiting") return !s.sasIncoming;
  return s.sasState === "cancelled";
}

/** Why it stopped. Everything but `after` means nothing was changed. */
export type StartOverStop =
  | { kind: "wrong" }
  | { kind: "no-password" }
  | { kind: "busy" }
  | { kind: "before"; error: string }
  | { kind: "after"; error: string };

export function stopNote(s: StartOverStop): string {
  switch (s.kind) {
    case "wrong":
      return "That's not your account password. Nothing was changed.";
    case "no-password":
      return "Your server asks for more than your password here, so Tin Hat can't start over. Nothing was changed.";
    case "busy":
      return "Already starting over — one moment.";
    case "before":
      return `Couldn't start over: ${s.error}. Nothing was changed.`;
    case "after":
      return `Starting over didn't finish: ${s.error}. Press Start over again to finish it.`;
  }
}

interface UiaError {
  httpStatus?: number;
  message?: string;
  errcode?: string;
  data?: { session?: string; errcode?: string; flows?: Array<{ stages?: string[] }> };
}

const msg = (e: unknown) => (e as { message?: string })?.message || String(e);

/** The check's request went through without the server asking for the password (the desktop says the same). */
export const NOT_ASKED = "your server didn't ask for your password, so Tin Hat can't confirm it's you";

/** A flow the password alone completes ("password, then something else" is not one). */
export function passwordAlone(flows: Array<{ stages?: string[] }> | undefined): boolean {
  return !!flows?.some((f) => f.stages?.length === 1 && f.stages[0] === "m.login.password");
}

/** The server turned the password down: a user-interactive auth answer (401) whose error is M_FORBIDDEN. Anything else
 *  — a network error, another code, a second stage asked for — is not blamed on the password. */
export function passwordRejected(e: unknown): boolean {
  const err = e as UiaError;
  return err?.httpStatus === 401 && (err.errcode ?? err.data?.errcode) === "M_FORBIDDEN";
}

/** The first try (no auth): a 401 with flows = ask again with the password (its session), if the password alone does. */
export function afterFirstTry(e: unknown): { ask: string | undefined } | StartOverStop {
  const err = e as UiaError;
  if (err?.httpStatus !== 401 || !err.data?.flows) return { kind: "before", error: msg(e) };
  if (!passwordAlone(err.data.flows)) return { kind: "no-password" };
  return { ask: err.data.session };
}

/** The second try (with the password) failed. */
export function afterSecondTry(e: unknown): StartOverStop {
  if (passwordRejected(e)) return { kind: "wrong" };
  const err = e as UiaError;
  if (err?.httpStatus === 401 && err.data?.flows) return { kind: "no-password" }; // more steps asked for
  return { kind: "before", error: msg(e) };
}
