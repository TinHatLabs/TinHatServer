// tileGestures.ts — P9 (12.1.16): double-click (double-tap) a call tile, and the tile menu's view rows. A share tile
// (someone else's, not the demo call) goes full screen, and back; any other tile resets its zoom and pan. Pin and Full
// screen are also rows of the tile's menu (right-click, long-press, ⋯), so small tiles have them too. The desktop's
// AppCore.qml tileWords / tileDoubleAction / tileViewItems; both run testvectors/tile-gestures/vectors.json
// (byte-identical in both repos).

export const TILE_WORDS = {
  pin: "Pin as the main view",
  unpin: "Unpin",
  fullscreen: "Full screen",
  leaveFullscreen: "Leave full screen",
  layoutPinHint: "Pin: right-click a tile, or its ⋯ menu",
} as const;

export interface TileFacts {
  share: boolean;
  self: boolean;
  fake: boolean;
  pinned?: boolean;
  fullscreen?: boolean;
}
export type TileViewRow = "pin" | "unpin" | "fullscreen" | "leaveFullscreen";

export function tileDoubleAction(t: TileFacts): "fullscreen" | "reset" | "none" {
  if (t.self) return "none";
  return t.share && !t.fake ? "fullscreen" : "reset";
}

export function tileViewItems(t: TileFacts): [TileViewRow, string][] {
  if (t.self) return [];
  const out: [TileViewRow, string][] = [t.pinned ? ["unpin", TILE_WORDS.unpin] : ["pin", TILE_WORDS.pin]];
  if (t.share && !t.fake) out.push(t.fullscreen ? ["leaveFullscreen", TILE_WORDS.leaveFullscreen] : ["fullscreen", TILE_WORDS.fullscreen]);
  return out;
}
