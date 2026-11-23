// cardsFace.ts — where my hole cards are face up (GAMES-V1.1-ADDENDUM §1.4, B1 + B2), and when this page tells the
// play server it is a Pad. Pure: no React, no app imports. cardsFace + showHereNext = testvectors/games/table-ui-v1.json
// (`cards_face`, `show_here_next`; byte-identical in the desktop, which is never a Pad: on_pad false there).
//
// B2 (reported 11-20, "cards stayed hidden sometimes"), the web half of the class: the page used to claim `pad` from its
// FORM FACTOR (any phone layout, and any desktop browser window under 700 px), once per connection, for the socket's
// whole life. So a narrow window, a phone in its own call, or a Pad that was locked / backgrounded / back on its list
// kept a `pad` in `you.screens`, and the computer kept the cards face down; a window that was narrow when it connected
// and was widened later even hid ITS OWN cards. Now `pad` = padClaim: "a Pad screen on this page shows a table right
// now, and the page is visible" (re-sent on a fresh socket whenever it changes: net.ts setPad), and a screen hides by
// `pad` only when it is not that Pad itself, with "Show here" as the way out (cardsFace).

export type CardsFace = "none" | "up" | "down" | "peek";

export interface CardsFaceIn {
  /** `you.cards` has cards */
  hasCards: boolean;
  /** this screen shares its screen */
  sharing: boolean;
  /** this table is drawn ON the Pad screen */
  onPad: boolean;
  /** the person tapped "Show here" on this screen (showHereNext keeps it) */
  here: boolean;
  /** `you.screens` of the view on screen */
  screens: readonly string[];
}

/** §1.4 cardsFace: none (nothing to draw) · down (sharing) · up · peek (face down, hold to peek + Show here). */
export function cardsFace(i: CardsFaceIn): CardsFace {
  if (!i.hasCards) return "none";
  if (i.sharing) return "down";
  if (i.onPad) return "up";
  if (i.here) return "up";
  if (i.screens.includes("pad")) return "peek";
  return "up";
}

export interface ShowHereIn {
  here: boolean;
  prevScreens: readonly string[];
  screens: readonly string[];
  tableClosed?: boolean;
}

/** "Show here" after a new view: it holds until the table closes or a Pad attaches AGAIN (no pad → pad). */
export function showHereNext(i: ShowHereIn): boolean {
  if (!i.here || i.tableClosed) return false;
  return !(!i.prevScreens.includes("pad") && i.screens.includes("pad"));
}

export interface PadClaimIn {
  /** Pad screens of this page that show a table now */
  padTables: number;
  /** document.visibilityState === "visible" */
  visible: boolean;
}

/** Whether this page's play socket says `pad: true` (web only: the desktop never claims it). */
export function padClaim(i: PadClaimIn): boolean {
  return i.padTables > 0 && i.visible;
}
