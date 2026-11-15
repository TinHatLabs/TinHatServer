// resend.ts — D08.2 (L1): which failed messages send themselves again when the connection comes back (the session's
// syncDown goes true -> false). The same rule as the desktop's room.rs resendable / resend_after_reconnect, through the
// shared vectors testvectors/resend-after-reconnect/vectors.json (byte-identical in both repos): a message that failed
// for lack of connection (failClass "network") is sent again by itself, oldest first, with the same transaction id; one
// the server refused keeps Retry / Delete; a voice note never (its draft owns the retry, docs/VOICE-NOTES.md).

/** What a network-failed message says while it waits (model.ts failReason; desktop friendly_send_error). */
export const NETWORK_WAIT_TEXT = "No connection — it will send when you're back online";

/** How many times a message resends by itself (Retry is always there). */
export const MAX_AUTO_TRIES = 5;

export function resendable(cls: string, voice: boolean, tries = 0): boolean {
  return cls === "network" && !voice && tries < MAX_AUTO_TRIES;
}
