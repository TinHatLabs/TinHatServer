// endedText.ts — what a session's end says (A27.1/A27.2, Sunday QoL). A guest (a temporary account the guest room
// made, core/server/offer isGuestAccount) has no password to sign in again with and no key backup to lose, so the
// member's words ("session expired… sign in again", the key-backup warning) are wrong for them. Web only: the desktop
// has no guest sessions (guests come in through a browser, docs/GUESTS.md) — docs/WEB-EXCEPTIONS.md.
import { isGuestAccount } from "../server/offer";

/** The sign-in page's line after the server ended this session (dead token, ended elsewhere, deactivated). */
export function sessionEndedText(userId: string | null | undefined): string {
  return isGuestAccount(userId)
    ? "Your guest visit has ended. To come back, ask whoever invited you for a new guest link."
    : "You were signed out: this session expired or was ended from another device. Sign in again.";
}

/** The sign-out confirm for a guest (null = a member: the usual key-backup words). */
export function guestLeaveConfirm(userId: string | null | undefined): { title: string; message: string; confirm: string } | null {
  if (!isGuestAccount(userId)) return null;
  return {
    title: "Leave?",
    message: "Your guest visit ends here. To come back, ask whoever invited you for a new guest link.",
    confirm: "Leave",
  };
}
