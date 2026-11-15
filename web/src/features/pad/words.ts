// words.ts — the Pad's words that depend on where Tin Hat Web runs (12.1.16 QOL A21.1, A21.3, D06.6): the phone
// layout says "This phone", every other layout (a desktop browser) says "This computer", like the desktop app
// (PadWindow.qml). The shared words are testvectors/pad-words/vectors.json (byte-identical in the desktop repo:
// scripts/pad-words-test.qml); words.test.ts holds this file to them.
import { whyText } from "../calls/pad/rules"; // relative: the node unit tests have no "@/" alias

export type PadPlace = "phone" | "computer";

/** Where this web app runs, in the Pad's words: the phone layout is a phone, anything else a computer. */
export function padPlace(mobile: boolean): PadPlace {
  return mobile ? "phone" : "computer";
}

/** The button next to "Leave your call on this … first." that leaves the call this device is in (both apps). */
export const LEAVE_THAT_CALL = "Leave that call";

export function thisDevice(p: PadPlace): string {
  return p === "phone" ? "This phone" : "This computer";
}
export function leaveFirst(p: PadPlace): string {
  return `Leave your call on this ${p} first.`;
}
export function watchJoinNote(p: PadPlace): string {
  return `Joins on this ${p} to watch — muted, sound off. Everyone sees you joined.`;
}
export function watchOnThis(p: PadPlace): string {
  return `Watch on this ${p}`;
}
/** This phone / This computer's Watch · Mic · Camera note before a mode is picked (web only: the desktop has no
 *  Mic / Camera modes). */
export function modesJoinNote(p: PadPlace, device: string): string {
  return p === "phone"
    ? `Joins on this phone — everyone sees it's your phone (Pad). Mute, deafen and Leave above stay ${device}'s.`
    : `Joins on this computer — everyone sees it's your Pad. Mute, deafen and Leave above stay ${device}'s.`;
}

/** The visible line under "On <device>" for a mic button the Pad can't press (a touch screen has no tooltip):
 *  push to talk, or muted for everyone by a moderator. "" = none. */
export function myRowNote(mic: string, device: string): string {
  if (mic === "ptt") return whyText("ptt", device, "mic");
  if (mic === "server") return whyText("server-muted", device, "mic");
  return "";
}
