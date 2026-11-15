// clipjump.ts — A18.3 (2026-11-13; the desktop's MemoriesWindow clipSeekOf): a clip is pressed just AFTER the moment, so
// jumping to it starts CLIP_LEAD_IN_S earlier (never before the recording's start). The chip and the mark still show the
// time of the press.
export const CLIP_LEAD_IN_S = 5;
export function clipSeekOf(off: number): number {
  return Math.max(0, off - CLIP_LEAD_IN_S);
}
