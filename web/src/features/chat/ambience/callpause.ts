// callpause.ts — while you're in a call (or joining one) the particles stop and are dropped, in both apps (the
// desktop's ambience_ctl.rs call_pause, same rule, same cases). The call's video already keeps the window drawing, and
// particles on top of it cost an Intel iGPU about 1.5 points of render time in a call with a screen share; even frozen
// ones were still drawn with every video frame. Off stays off; after the call the scene starts fresh.
import type { EffectsState } from "./core";

export function callPause(s: EffectsState, inCall: boolean): EffectsState {
  return inCall ? "off" : s;
}
