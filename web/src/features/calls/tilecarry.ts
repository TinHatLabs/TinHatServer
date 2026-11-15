// tilecarry.ts — pin and full screen follow a blip (D02.3, 2026-11-13; shared vectors testvectors/tilecarry.json = the
// desktop's tilecarry.rs). When the pinned or full-screen tile leaves the call, the UI holds {participant, kind, until} for
// the leave-chime grace; a tile of the same participant (device included) and kind arriving in that time is pinned / kept
// full screen again, so a sharer's blip no longer drops the viewer's pin and full screen.
import { PAD_LEAVE_GRACE_MS } from "./persontiles";

export const CARRY_GRACE_MS = PAD_LEAVE_GRACE_MS;

export interface Held {
  participant: string;
  kind: string;
  until: number;
}
interface TileLike {
  id: string;
  participant?: string;
  kind?: string;
}

/** Hold a tile that just left (null for none). */
export function holdOf(t: TileLike | undefined | null, now: number): Held | null {
  if (!t || !t.participant) return null;
  return { participant: t.participant, kind: t.kind || "video", until: now + CARRY_GRACE_MS };
}

/** The tile to carry the pin / full screen to, or null. */
export function carryTarget(held: Held | null, tiles: readonly TileLike[], now: number): string | null {
  if (!held || !held.participant || now >= held.until) return null;
  const t = tiles.find((x) => x.participant === held.participant && (x.kind || "video") === held.kind);
  return t ? t.id : null;
}
