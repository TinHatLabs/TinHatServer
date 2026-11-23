// seatPresence.ts — B4 (GAMES-V1.1-ADDENDUM §1.1): a seated player's seat avatar IS their call presence: the call's
// speaking ring and the muted-mic glyph, for people in MY call of the table's room. Pure (the call's state in, the
// person's out); the hook lives in HoldemTable's Seat. Same participant rule as the voice HUD (calls/identity mxidOf:
// "@a:h" never speaks for "@a:h:8448:DEV").
import { mxidOf } from "../calls/identity";

export interface CallSnap {
  speakers: { me: string; active: string[] };
  micMuted: boolean;
  tiles: readonly { participant: string; kind: string; muted?: boolean; companionOf?: string }[];
}
export interface Presence {
  inCall: boolean;
  speaking: boolean;
  muted: boolean;
}
const NONE: Presence = { inCall: false, speaking: false, muted: false };

/** `me` = my own mxid. A person with no tile in the call is not in it (no ring, no glyph). */
export function presenceOf(c: CallSnap, mxid: string, me: string): Presence {
  if (!mxid) return NONE;
  if (mxid === me) {
    const id = c.speakers.me;
    return { inCall: true, speaking: !c.micMuted && !!id && c.speakers.active.some((a) => a === id), muted: c.micMuted };
  }
  const own = c.tiles.filter((t) => !t.companionOf && t.kind !== "screenshare" && mxidOf(t.participant) === mxid);
  if (!own.length) return NONE;
  const muted = own.every((t) => !!t.muted);
  const speaking = !muted && c.speakers.active.some((a) => mxidOf(a) === mxid);
  return { inCall: true, speaking, muted };
}
