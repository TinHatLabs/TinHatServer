// micMode.ts — the mic-mode invariant (4-9, launch-gate 2026-11-14; shared vectors testvectors/mic-mode.json = the
// desktop's mic_mode.rs): after ANY mic-mode change the mic ends MUTED unless the person explicitly unmuted it. Turning
// push to talk OFF while holding its key used to leave the mic open (applyPushToTalk didn't re-mute, and pttHold returned
// early once push to talk was off); leaving a call during a hold kept the hold for the next call.

/** The push-to-talk setting changed (either way, also from its call-bar button): a hold ends and the mic is muted. */
export function pttToggled(_on: boolean): { speaking: boolean; muted: boolean } {
  return { speaking: false, muted: true };
}

/** Leaving the call ends a hold; in push to talk the mic is muted (out of it the mute button's state stays). */
export function leaveHold(ptt: boolean, muted: boolean): { speaking: boolean; muted: boolean } {
  return { speaking: false, muted: ptt || muted };
}
