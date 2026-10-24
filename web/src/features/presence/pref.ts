// pref.ts — REACH §2.2 + A2.2 + A4.1: the three account-data keys behind presence (they follow the
// account to every device).
//
//   dev.tinhat.presence         {"share": bool, "v": 1}     consent — written ONLY by an explicit user action
//                                                            (the switch, "Turn on" on the one-time card, or
//                                                            "Turn on" in the status picker's confirm); never by
//                                                            an automatic path, never from a cached copy
//   dev.tinhat.presence_asked   {"asked": true}             the one-time question was answered
//   dev.tinhat.presence_status  {id, text, emoji, color, until, v: 1} | {}   the custom status (A4)
import type { MatrixClient } from "matrix-js-sdk";
import { peekClient } from "@/core/matrix";
import { liveStatus, statusContent, type CustomStatus } from "./status";
import { ASKED_TYPE, PREF_TYPE, askedContent, parseAsked, parseShare, prefContent } from "./model";

export const PRESENCE_TYPE = PREF_TYPE;
export const PRESENCE_ASKED_TYPE = ASKED_TYPE;
export const PRESENCE_STATUS_TYPE = "dev.tinhat.presence_status";

type Content = Record<string, unknown>;
const content = (c: MatrixClient | null, type: string): Content | undefined =>
  (c?.getAccountData(type as never)?.getContent() as Content | undefined) ?? undefined;

/** share === true (absent / anything else = not sharing). */
export function readShare(c = peekClient()): boolean {
  return parseShare(content(c, PRESENCE_TYPE));
}

/** The one-time question was answered (A2.2 key; the pre-amendment `asked` inside the share object counts too). */
export function readAsked(c = peekClient()): boolean {
  return parseAsked(content(c, PRESENCE_ASKED_TYPE)) || parseAsked(content(c, PRESENCE_TYPE));
}

/** The raw custom status object (may be expired or `{}`). */
export function readStatusRaw(c = peekClient()): Content | null {
  const v = content(c, PRESENCE_STATUS_TYPE);
  return v && Object.keys(v).length ? v : null;
}

/** The custom status if it shows now. */
export function readStatus(now = Date.now(), c = peekClient()): CustomStatus | null {
  return liveStatus(readStatusRaw(c), now);
}

function client(): MatrixClient {
  const c = peekClient();
  if (!c) throw new Error("not signed in");
  return c;
}

/** The consent switch. Call ONLY from an explicit user action. Always writes the whole object — as an
 *  unconditional PUT that returns at the server's answer (web review #1): the SDK's setAccountData() waits
 *  for the /sync echo (a stalled sync would hold the off switch) and skips writes equal to its cached copy.
 *  `c` = the session that started it (runtime.ts keeps the value until the echo arrives). */
export async function writeShareRaw(c: MatrixClient, share: boolean): Promise<void> {
  await c.setAccountDataRaw(PRESENCE_TYPE as never, prefContent(share) as never);
}

/** The one-time question answered — also written by every explicit choice of the switch (parity item f). */
export async function writeAskedRaw(c: MatrixClient): Promise<void> {
  await c.setAccountDataRaw(PRESENCE_ASKED_TYPE as never, askedContent() as never);
}

/** A status (the picker), or `{}` (Clear status / the clean-up of an expired one). */
export async function writeStatus(s: CustomStatus | null): Promise<void> {
  await client().setAccountData(PRESENCE_STATUS_TYPE as never, statusContent(s) as never);
}
