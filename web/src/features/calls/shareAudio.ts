// shareAudio.ts — what the share picker says about sound (A06.2 / A06.3, 12.1.16). The browser shares sound only where it
// can (Chromium on a computer: a tab's sound, or all system sound on Windows / ChromeOS; docs/WEB-EXCEPTIONS.md), so the
// "Everything" choice and the "tick Share audio" hint show only there; elsewhere one plain line says so. The preview's
// caption says what is really being sent (the published sound), not what was picked: a share whose picker had
// "Share audio" unticked sends none, and the call status says that too.

export const SHARE_AUDIO_WORDS = {
  tabAudio: "tab/system audio",
  noAudio: "no audio",
  hintCan: "Your browser shares a tab's sound (or, on Windows and ChromeOS, all system sound) — tick \"Share audio\" in its picker. Per-app audio needs the desktop app.",
  hintCant: "This browser can't share sound. Chrome or Edge on a computer can, and the desktop app can share one app's sound.",
  noSoundStatus: "Sharing screen — no sound: \"Share audio\" wasn't ticked in the browser's picker",
} as const;

/** The Audio section: is the "Everything" pill offered, which hint shows, and which pick counts. */
export function shareAudioChoices(supported: boolean, picked: "none" | "browser"): { everything: boolean; hint: string; audio: "none" | "browser" } {
  return supported
    ? { everything: true, hint: SHARE_AUDIO_WORDS.hintCan, audio: picked }
    : { everything: false, hint: SHARE_AUDIO_WORDS.hintCant, audio: "none" };
}

/** The preview caption's sound part: what is published right now (desktop: StreamPopover.qml audioSummary). */
export function previewAudioCaption(musicPlaying: boolean, musicSourceName: string): string {
  if (!musicPlaying) return SHARE_AUDIO_WORDS.noAudio;
  return musicSourceName || SHARE_AUDIO_WORDS.tabAudio;
}

/** The call status once a screen share is live: says so when sound was asked for and the browser gave none. */
export function shareStartStatus(requested: "none" | "browser" | "device" | undefined, gotAudio: boolean): string {
  return requested === "browser" && !gotAudio ? SHARE_AUDIO_WORDS.noSoundStatus : "Sharing screen";
}
