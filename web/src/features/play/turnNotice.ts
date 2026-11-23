// turnNotice.ts — B10 / B4 "your turn" notices (GAMES-V1.1-ADDENDUM §8.3): opt-in (TURN_NOTIFY_DEFAULT = false until
// answered), one notice when my turn begins while the table isn't on screen and focused, a second at
// TURN_NOTIFY_LAST_S seconds left if I still haven't acted, withdrawn as soon as I act or the turn passes. The words
// never carry cards, odds or amounts. Pure rule here; the watcher is in TurnWatch.tsx.

export const TURN_NOTIFY_DEFAULT = false;
export const TURN_NOTIFY_LAST_S = 10;
/** the pref: "" = not asked yet, "1" = yes, "0" = no */
export const TURN_NOTIFY_PREF = "games.turn-notify";

export interface TurnIn {
  /** whose turn (seat), null = nobody's */
  toAct: number | null;
  /** my seat, null = not seated */
  mine: number | null;
  /** `${hand.n}:${to_act.turn}`: one per turn */
  turnKey: string;
  /** seconds left on the turn */
  left: number;
  /** the table is on screen AND the window is focused (Table stage, tab visible) */
  watching: boolean;
  /** what was already sent for this turn key: "" | "first" | "last" */
  sent: { key: string; what: "" | "first" | "last" };
}
export type TurnOut = { post: "first" | "last" | null; withdraw: boolean };

/** What to do now. */
export function turnNotice(i: TurnIn): TurnOut {
  const myTurn = i.mine !== null && i.toAct === i.mine;
  const sameTurn = i.sent.key === i.turnKey;
  // not my turn any more (acted, passed, hand over): withdraw whatever this turn showed
  if (!myTurn) return { post: null, withdraw: i.sent.what !== "" };
  // looking at it: nothing new (and what was shown goes)
  if (i.watching) return { post: null, withdraw: sameTurn && i.sent.what !== "" };
  if (!sameTurn || i.sent.what === "") return { post: i.left <= TURN_NOTIFY_LAST_S ? "last" : "first", withdraw: false };
  if (i.sent.what === "first" && i.left <= TURN_NOTIFY_LAST_S) return { post: "last", withdraw: false };
  return { post: null, withdraw: false };
}
