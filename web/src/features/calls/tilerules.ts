// tilerules.ts — pure tile rules shared with the desktop (crates/app/src/call_ctl.rs build_tiles).

/**
 * 12.1.3 (cryptor-not-ready): is a remote video publication drawn as a video tile? A MUTED camera is drawn as the
 * person's avatar, never frozen on its last frame — the SFU's blank frames for a muted track are not played (they
 * don't decrypt). A screen share is always a video tile while published.
 */
export function videoTileShown(screenshare: boolean, muted: boolean): boolean {
  return screenshare || !muted;
}
