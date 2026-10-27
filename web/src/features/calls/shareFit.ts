// shareFit.ts — the screen-share published size: one rule with the desktop (crates/streamer lk_publish::fit_even),
// checked against the shared vectors in testvectors/share-fit/vectors.json (byte-identical in both repos).
//
// The preset's SHORT side is its line count ("1080p" = 1080 lines): the source's short side is scaled to it and the
// long side follows the source's aspect, so a 21:9 5120x2160 publishes 2560x1072 at 1080p, a 16:9 screen 1920x1072,
// a portrait 1080x1920 screen 1072x1920. The old rule fitted the source into the 16:9 box itself, so on any wider
// screen the width bound first (1080p on 21:9 came out 1920x800). Never upscaled; the long side at most 4096
// (H.264's limit); each side rounded to the nearest pixel, then down to a multiple of 16 (H.264 needs it). An unknown
// source gets the box. (In a browser the capturer keeps the aspect inside that envelope, so it may send a few pixels
// fewer than this on one side: docs/WEB-EXCEPTIONS.md.)

export const SHARE_MAX_DIM = 4096;

const align16 = (x: number) => Math.floor(x / 16) * 16;

export function shareFit(sw: number, sh: number, boxW: number, boxH: number): { w: number; h: number } {
  if (!(sw > 0) || !(sh > 0)) return { w: Math.max(16, align16(boxW)), h: Math.max(16, align16(boxH)) };
  const lines = Math.min(boxW, boxH);
  const scale = Math.min(lines / Math.min(sw, sh), SHARE_MAX_DIM / Math.max(sw, sh), 1);
  return { w: Math.max(16, align16(Math.round(sw * scale))), h: Math.max(16, align16(Math.round(sh * scale))) };
}
