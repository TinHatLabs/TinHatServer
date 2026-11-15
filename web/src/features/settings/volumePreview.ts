// Settings > Notifications > Sound volume (QOL sweep D07.1): the slider was silent, so nobody could hear how loud 60 %
// is without leaving the row for a Preview button. Letting go of it (or a keyboard step) now plays the notification
// sound in use at the new level, or the message sound when the notification sound is Off. Keyboard steps fire a
// release each; a burst plays once, VOLUME_PREVIEW_DEBOUNCE_MS after the last; moving again cancels a waiting one. The rule is shared with the desktop
// (crates/app/qml/VolumePreview.qml) through testvectors/volume-preview/vectors.json, byte-identical in both repos.

export const VOLUME_PREVIEW_DEBOUNCE_MS = 250;

/** The sound file the volume preview plays, from the prefs `snd.notify` and `snd.notify.variant`. */
export function volumePreviewFile(notify: string, variant: string): string {
  if (notify === "0") return "receive";
  return variant === "2" || variant === "3" || variant === "4" ? `notify-${variant}` : "notify";
}

/** A debounced player: call `release()` on every slider release; `play` runs once, `ms` after the last call. */
export function volumePreviewDebouncer(play: () => void, ms: number = VOLUME_PREVIEW_DEBOUNCE_MS, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return {
    release(): void {
      if (t !== null) timers.clear(t);
      t = timers.set(() => {
        t = null;
        play();
      }, ms);
    },
    cancel(): void {
      if (t !== null) timers.clear(t);
      t = null;
    },
  };
}
