// art.ts — the games' ART colours: the felt, the card faces, the chips, the reel windows. These are game art (content,
// like the ambience scenes), not UI chrome: they come from the shared testvectors/games/ui.json `art` (byte-identical
// in the desktop), never from a theme. Everything around the art (text,
// panels, buttons, rings) uses the theme's variables, so both themes keep their own look.
import type { CSSProperties } from "react";
import uiJson from "../../../testvectors/games/ui.json" with { type: "json" };

const { about: _about, ...art } = uiJson.art;
void _about;
/** The art palette, from the shared testvectors/games/ui.json `art` (byte-identical in the desktop). */
export const ART: Readonly<Record<string, string>> = art;

/** The art colours as custom properties on a game root (`--g-felt-centre` …), so CSS modules read them. */
export function artVars(): CSSProperties {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(ART)) o[`--g-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`] = v;
  return o as CSSProperties;
}
