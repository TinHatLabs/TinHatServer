// 12.1.6: Watch (join from the Pad to watch, without a microphone) is OFF until 12.1.7 — the assembly-042 release review
// found rejoin paths that could still capture a watching device's microphone (share claude/tinhat-pad/WATCH-1217.md).
// engine.watchCall refuses, the Pad hides its Watch strip, the reload rejoin ignores `watching`. Flip back in 12.1.7.
export const WATCH_AVAILABLE = false;
export const WATCH_OFF_NOTE = "Watching from here isn't available yet — it comes in a later update";
