// rejoinRule.ts — auto-rejoin after a terminal drop (P14, 2026-11-13; shared vectors testvectors/rejoin.json = the desktop's
// rejoin_rule.rs). A healthy call (45 s+) always heals itself with a fresh join. Since P14 so does a young call whose join
// had completed (the call server said Connected). 5-7 (launch-gate 2026-11-14): ONE automatic rejoin per run of drops — a
// second drop shows "Connection lost" with Try again, no loop. A join that never completed is a JOIN problem and parks on
// the Rejoin banner as before.
export const MAX_AUTO_REJOINS = 1;

/** `attempts` = auto-rejoins already made in this run of drops (before the healthy reset). */
export function autoRejoin(recoverable: boolean, hungUp: boolean, healthy: boolean, completed: boolean, attempts: number): boolean {
  const a = healthy ? 0 : attempts;
  return recoverable && !hungUp && a < MAX_AUTO_REJOINS && (healthy || completed);
}
