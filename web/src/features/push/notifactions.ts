// notifactions.ts — Reply and Mark as read on a message notification (docs/NOTIF-ACTIONS.md), the pure rules. The
// desktop runs the same rules (crates/app/src/notif_actions.rs) against the same vectors
// (testvectors/notifactions.json, byte-identical in both repos; this repo owns them).
//
//   offer        what a message notification carries ("default" = the click, then "reply" / "inline-reply", "read")
//   outcome      an invoked key → what the app does
//   replyContent / readMarkers / failedBody   what is sent / shown
//
// Browsers have no inline text field, so the web always offers "reply" (open the room, composer focused); the
// inline branch is here for the shared vectors.
import { type MarkersBody, markersBody } from "../../core/matrix/receiptRule";

/** Trimmed from both ends of a reply (after CRLF / lone CR became LF): String.prototype.trim's set plus U+0085. */
export const WHITESPACE: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const WS = new Set(WHITESPACE);

export const WORDS = {
  reply: "Reply",
  markRead: "Mark as read",
  send: "Send",
  placeholder: "Message",
  failedTitle: "Your reply wasn't sent",
} as const;
const FAILED_TEXT_MAX = 120;

/** The typed text as it is sent: CRLF and lone CR → LF, then trimmed (see WHITESPACE). */
export function normalise(text: string): string {
  const cps = [...text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")];
  let a = 0;
  let b = cps.length;
  while (a < b && WS.has(cps[a]!.codePointAt(0)!)) a++;
  while (b > a && WS.has(cps[b - 1]!.codePointAt(0)!)) b--;
  return cps.slice(a, b).join("");
}

export type ReplyContent = { msgtype: "m.text"; body: string; "m.mentions": Record<string, never> };

/** The m.room.message content a reply sends: plain body, no formatting, no relation, empty intentional mentions. */
export function replyContent(text: string): ReplyContent | null {
  const body = normalise(text);
  return body ? { msgtype: "m.text", body, "m.mentions": {} } : null;
}

const utf8 = new TextEncoder();
/** '$' + 1..254 more UTF-8 bytes, no control or white-space characters. */
export function eventOk(e: unknown): e is string {
  if (typeof e !== "string" || !e.startsWith("$")) return false;
  const n = utf8.encode(e).length;
  if (n < 2 || n > 255) return false;
  for (const ch of e) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || WS.has(c) || /\s/u.test(ch)) return false;
  }
  return true;
}

export type ReadMarkers = MarkersBody;

/** The POST /rooms/{room}/read_markers body for Mark as read (null = no Mark as read: no newest-event fallback).
 *  publicOk = receiptRule's publicReceiptOk for the room (THE RULE there: a public m.read only in a room of my own
 *  server, isManaged; anywhere else, a missing create event included, m.read.private). Fail-private on purpose: rooms
 *  on connected Tin Hat servers get the private receipt too until open-network slice 1 narrows it with its connected
 *  list. */
export function readMarkers(event: unknown, publicOk: boolean): ReadMarkers | null {
  return eventOk(event) ? markersBody(event, publicOk) : null;
}

export interface OfferCtx {
  actionsCap: boolean;
  inlineField: boolean;
  trusted: boolean;
  event: string;
}

export type ActionKey = "default" | "reply" | "inline-reply" | "read";

export function offer(c: OfferCtx): ActionKey[] {
  if (!c.actionsCap) return ["default"];
  const out: ActionKey[] = ["default", c.inlineField && c.trusted ? "inline-reply" : "reply"];
  if (eventOk(c.event)) out.push("read");
  return out;
}

export type Outcome =
  | { do: "open" }
  | { do: "compose" }
  | { do: "send"; content: ReplyContent; thenRead?: ReadMarkers }
  | { do: "read"; markers: ReadMarkers }
  | { do: "failed"; note: string }
  | { do: "none" };

/** An invoked key → what the app does. trustedNow = this device's trust checked now (unknown = false); publicOk = may
 *  the room get a public receipt (see readMarkers; unknown = false). */
export function outcome(key: string, text: string, event: string, trustedNow: boolean, publicOk: boolean): Outcome {
  switch (key) {
    case "default":
      return { do: "open" };
    case "reply":
      return { do: "compose" };
    case "inline-reply": {
      const content = replyContent(text);
      if (!content) return { do: "compose" };
      if (!trustedNow) return { do: "failed", note: failedBody(text) };
      const m = readMarkers(event, publicOk);
      return m ? { do: "send", content, thenRead: m } : { do: "send", content };
    }
    case "read": {
      const m = readMarkers(event, publicOk);
      return m ? { do: "read", markers: m } : { do: "none" };
    }
    default:
      return { do: "none" };
  }
}

/** The failure note's body (the iOS words): the first 120 characters of what was typed. */
export function failedBody(text: string): string {
  return `Open Tin Hat to send it: “${[...normalise(text)].slice(0, FAILED_TEXT_MAX).join("")}”`;
}

/** The browser notification `actions` for a message notification (the worker and the page use the same list).
 *  "default" is the click itself, never a button. */
export function webActions(event: string): Array<{ action: string; title: string }> {
  return offer({ actionsCap: true, inlineField: false, trusted: false, event })
    .filter((k) => k !== "default")
    .map((k) => ({ action: k, title: k === "read" ? WORDS.markRead : WORDS.reply }));
}
