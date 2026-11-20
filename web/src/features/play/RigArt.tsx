// RigArt.tsx — The Rig's six reel symbols as small SVGs (ring order Hat, Saucer, Dish, Eye, Moon, Lizard). Drawn, not
// emoji, so every platform shows the same picture (the desktop draws the same paths from testvectors/games/ui.json).
import uiJson from "../../../testvectors/games/ui.json" with { type: "json" };
import type { RigSymbol } from "./wire";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** The symbols' colours, from the shared testvectors/games/ui.json `symbol_colours`. */
export const SYMBOL_COLOUR: Readonly<Record<RigSymbol, string>> = uiJson.symbol_colours as Record<RigSymbol, string>;

export function RigSymbolArt({ sym, size = 48 }: { sym: RigSymbol; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={sym} style={{ color: SYMBOL_COLOUR[sym] }}>
      {sym === "hat" && (
        <g {...STROKE}>
          <path d="M24 7 L37 33 H11 Z" fill="currentColor" fillOpacity="0.18" />
          <path d="M6 35 Q24 41 42 35" />
          <path d="M18 22 L24 12 L30 22" opacity="0.6" />
        </g>
      )}
      {sym === "saucer" && (
        <g {...STROKE}>
          <ellipse cx="24" cy="27" rx="18" ry="6.5" fill="currentColor" fillOpacity="0.18" />
          <path d="M14 24 Q16 13 24 13 Q32 13 34 24" />
          <path d="M17 38 L14 43 M24 38 V44 M31 38 L34 43" opacity="0.6" />
        </g>
      )}
      {sym === "dish" && (
        <g {...STROKE}>
          <path d="M9 14 Q14 34 34 33 Z" fill="currentColor" fillOpacity="0.18" />
          <path d="M21 24 L33 12" />
          <circle cx="34.5" cy="11" r="2.5" fill="currentColor" />
          <path d="M22 33 L18 42 H32 L28 34" />
        </g>
      )}
      {sym === "eye" && (
        <g {...STROKE}>
          <path d="M5 24 Q24 6 43 24 Q24 42 5 24 Z" fill="currentColor" fillOpacity="0.14" />
          <circle cx="24" cy="24" r="7" />
          <circle cx="24" cy="24" r="2.8" fill="currentColor" />
        </g>
      )}
      {sym === "moon" && (
        <g {...STROKE}>
          <path d="M31 8 A16 16 0 1 0 40 33 A13 13 0 1 1 31 8 Z" fill="currentColor" fillOpacity="0.22" />
          <circle cx="20" cy="22" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="24" cy="31" r="1.2" fill="currentColor" stroke="none" />
        </g>
      )}
      {sym === "lizard" && (
        <g {...STROKE}>
          <path d="M10 30 Q16 20 26 22 Q34 23 38 15" />
          <ellipse cx="25" cy="23.5" rx="8" ry="4.5" fill="currentColor" fillOpacity="0.2" />
          <circle cx="39.5" cy="13.5" r="3" fill="currentColor" fillOpacity="0.3" />
          <path d="M20 26 L17 32 M28 27 L31 32 M21 21 L18 16 M29 21 L32 17 M10 30 Q6 34 8 39" />
        </g>
      )}
    </svg>
  );
}
