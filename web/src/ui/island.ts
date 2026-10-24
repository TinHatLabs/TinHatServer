// island.ts — the island a piece of content lives in (ISLANDS-ARCH §2.4; the desktop's Island.qml properties): the
// dock host's IslandFrame provides it, features read it with useIsland(). null outside the dock host (phones,
// floating chats, the gallery): the content then lays itself out as before.
//
//   w, h      the content box — the solver's rect minus the frame's inset on each side, never negative
//   z         the solver's z: 0 docked, 2 overlaid (the right panel below 844 px), 20 in a drawer panel
//   visible   placed and shown (a closed drawer's islands, an absent island: false)
//   report()  the natural size of content whose DOM height is not its natural height — the call (its grid fits the
//             island) and the widget stack (natural = every widget open, minH = every widget folded); `w` = a natural
//             width (11.0: your own button islands — a floating one is as wide as its buttons). Content-box px; the
//             frame adds its inset. `empty` = nothing to show (the island leaves the layout).
import { createContext, useContext } from "react";

export interface IslandReport {
  w?: number;
  h?: number;
  minH?: number;
  empty?: boolean;
}

export interface IslandCtx {
  ref: string;
  w: number;
  h: number;
  z: number;
  visible: boolean;
  /** the frame's content inset (px) */
  inset: number;
  report: (r: IslandReport) => void;
}

export const IslandContext = createContext<IslandCtx | null>(null);

/** The island this content is rendered in, or null outside the dock host. */
export function useIsland(): IslandCtx | null {
  return useContext(IslandContext);
}
