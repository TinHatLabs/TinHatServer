// prefs.ts — Pad's one setting: Settings → Calls → Pad "Let my other verified devices control my calls here" (default
// on). Off = no `pad1` cap in this device's call membership and every command refused with `off` (docs/PAD.md).
// The desktop keeps the same key (~/.config/tinhat/pad-allow).
import { getPref } from "@/core/prefs";

export const PAD_PREF = "pad-allow";

/** This device lets my other verified devices control its calls. */
export function padAllowed(): boolean {
  return getPref(PAD_PREF, true) !== false;
}
