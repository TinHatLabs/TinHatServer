// reelQol.ts — Game Reel words (QOL A19.1, A19.3). SHARED LOGIC: the desktop's GameReelPanel.qml reelWhyNot and
// MyGamesEditor.qml importCountText, rule for rule; both replay testvectors/reel-qol/vectors.json.

export type WhySnap = { hasResult: boolean; notice: string; respinsLeft: number; myVetoesLeft: number; canSpin: boolean; canVeto: boolean };

/** What a greyed Spin / Re-spin ("spin") or Veto ("veto") says on hover; "" = nothing to say. */
export function reelWhyNot(button: "spin" | "veto", s: WhySnap): string {
  if (button === "spin") {
    if (s.hasResult) return s.respinsLeft <= 0 ? "No re-spins left tonight" : "";
    return s.canSpin ? "" : s.notice;
  }
  if (s.canVeto) return "";
  if (s.myVetoesLeft <= 0) return "You've used your veto for tonight";
  if (s.respinsLeft <= 0) return "No re-spins left tonight — a veto needs one";
  return "";
}

/** The Steam import shows the first IMPORT_SHOWN games it found. */
export const IMPORT_SHOWN = 60;
/** The Steam import line: the real count, and that only the first 60 are shown when there are more. */
export function importCountText(total: number, pending: number): string {
  let t = `${total} game${total === 1 ? "" : "s"} found`;
  if (pending) t += ` (${pending} still being checked)`;
  if (total > IMPORT_SHOWN) t += `, showing the first ${IMPORT_SHOWN}`;
  return t + " — tick the ones you’d play:";
}
