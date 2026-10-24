// firstrun.ts — the calm first run (selfhost/firstrun item 2). SHARED LOGIC + WORDING: the desktop's selfhost build
// uses these strings and rules and replays firstrun.test.ts (docs/DESKTOP-PENDING-selfhost-firstrun.md §2).
// Pure: no React, no app imports — the unit test runs it in plain Node.
//
// The old first sign-in was four interruptions in a row (Security Key → notifications → "let friends see when you're
// online?" → a 7-page tour). The calm one (self-hosted builds; the hub build keeps its first run):
//   1. the Security Key step, in plain words, with Copy ("Copied"), Download (.txt) and Done — no hidden checkbox;
//      Done without a copy or a download asks once ("Close without saving your key?");
//   2. straight into the app: the footer slot offers the tour ("Take the tour" / "No thanks") until it is answered or
//      the person starts chatting — it never opens by itself;
//   3. notifications are asked after this device sent its first message (a banner on the room page);
//   4. online status is asked on the first visit to Settings (a banner at the top of the window).

// ---- 1. the Security Key step -------------------------------------------------------------------------------------

export const KEY_TITLE = "Save your Security Key";
export const KEY_LEAD = "It's the only way to read your messages if you sign in on a new device. You'll see it only this once.";
export const KEY_HINT = "Keep it in a password manager, or keep the downloaded file somewhere safe.";
export const KEY_COPY = "Copy";
export const KEY_COPIED = "Copied";
export const KEY_COPY_FAILED = "Couldn't copy — select the key and copy it yourself";
export const KEY_DOWNLOAD = "Download";
export const KEY_DONE = "Done";
export const KEY_SKIP_TITLE = "Close without saving your key?";
export const KEY_SKIP_TEXT = "You won't see it again. Without it, you can't read your messages if you sign in on a new device.";
export const KEY_SKIP_CONFIRM = "Close anyway";
export const KEY_SKIP_BACK = "Go back";
/** how long "Copied" stays on the button */
export const COPIED_MS = 2000;
export const KEY_FILE_NAME = "tinhat-security-key.txt";

/**
 * The key's groups for display: the encoded key is groups of 4 separated by spaces ("EsTx 1a2B …"); a key without
 * spaces is cut into fours. The display never breaks a line inside a group.
 */
export function keyGroups(key: string): string[] {
  const t = key.trim();
  if (!t) return [];
  if (/\s/.test(t)) return t.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < t.length; i += 4) out.push(t.slice(i, i + 4));
  return out;
}

/** `YYYY-MM-DD` of a time in local time (the file's "Saved" line). */
export function localDate(ms: number, tzOffsetMin = new Date(ms).getTimezoneOffset()): string {
  const d = new Date(ms - tzOffsetMin * 60_000);
  return d.toISOString().slice(0, 10);
}

/** The downloaded file: what it is, whose it is, the key on one line, and two lines on keeping it safe. CRLF-free. */
export function keyFileText(o: { key: string; userId: string; date: string }): string {
  return [
    "Tin Hat Security Key",
    "",
    `Account: ${o.userId}`,
    `Saved: ${o.date}`,
    "",
    keyGroups(o.key).join(" "),
    "",
    "This key unlocks your encrypted messages when you sign in on a new device.",
    "Keep it private: with it and your password, anyone could read your messages.",
    "",
  ].join("\n");
}

/** May the step close without asking? Only after the key was copied or downloaded. */
export function keySaved(o: { copied: boolean; downloaded: boolean }): boolean {
  return o.copied || o.downloaded;
}

// ---- 2.–4. asking later, in context ------------------------------------------------------------------------------

export const TOUR_OFFER = "New here? Take a 1-minute tour.";
export const TOUR_OFFER_YES = "Take the tour";
export const TOUR_OFFER_NO = "No thanks";

export interface AskInputs {
  /** the tour was taken or turned down (pref tour_seen) */
  tourSeen: boolean;
  /** this device has sent a message (pref firstrun.sent) */
  sentFirst: boolean;
  /** a modal is up (the Security Key step, the verify dialog): nothing else asks */
  modalOpen: boolean;
  /** the notifications question may be asked (never asked in this browser, not snoozed, notifications on) */
  notifyAskable: boolean;
  /** the online-status question may be asked (presence: known, not answered, not sharing, not in a call) */
  statusAskable: boolean;
}

export interface AskPlan {
  /** the footer slot's "Take a 1-minute tour" card */
  tourOffer: boolean;
  /** the room page's notifications banner */
  notifyBanner: boolean;
  /** the Settings window's online-status banner */
  statusBanner: boolean;
}

/** Which question shows where, right now (one in the footer, one per room page, one in Settings). */
export function askPlan(i: AskInputs): AskPlan {
  return {
    tourOffer: !i.tourSeen && !i.sentFirst && !i.modalOpen,
    notifyBanner: i.sentFirst && i.notifyAskable && !i.modalOpen,
    statusBanner: i.statusAskable,
  };
}
