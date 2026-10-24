// themeNames.ts — how the colour catalogue (src/theme/tokens.json: roles + element tokens) becomes CSS.
// Pure functions, no DOM and no imports: the runtime (themes.ts) and the node tools (tools/modular/*) share them,
// so the generated tokens.css block, the typed map in themeVars.gen.ts and applyTheme() can never disagree.

/**
 * The CSS custom property of a role or token: `--th-<id>`, dots → dashes, lowerCamel → kebab.
 *   "composer.border.focus" → "--th-composer-border-focus"   "text.onAccent" → "--th-text-on-accent"
 * (tools/modular/gen-theme-vars.mjs checks that no two ids share a name and that no other `--th-*` name in the
 * app means something else.)
 */
export function varName(id: string): string {
  let out = "--th-";
  for (let i = 0; i < id.length; i++) {
    const c = id[i];
    if (c === ".") out += "-";
    else if (c >= "A" && c <= "Z") out += "-" + c.toLowerCase();
    else out += c;
  }
  return out;
}

/** `var(--th-<id>)` for a CSS value (inline styles, SVG attributes). */
export function varRef(id: string): string {
  return `var(${varName(id)})`;
}

function channels(canonical: string): [number, number, number] {
  return [parseInt(canonical.slice(1, 3), 16), parseInt(canonical.slice(3, 5), 16), parseInt(canonical.slice(5, 7), 16)];
}

/**
 * An engine colour in canonical form (ENGINE.md §1: "#rrggbb" or "#rrggbb/A", A ≤ 4 decimals) as a CSS colour:
 * "#rrggbb" stays, "#rrggbb/A" → "rgba(r, g, b, A)" with the engine's exact alpha text (so `alpha(x, 0.35)` paints
 * exactly what `rgba(var(--th-x-rgb), 0.35)` painted).
 *
 * `floatAlpha` spells a translucent colour in the modern syntax "rgb(r g b / A)" instead. Chromium keeps the alpha of
 * the legacy comma syntax (and of #rrggbbaa) in 8 bits (0.14 → 36/255) but of the modern syntax, color-mix() and
 * relative colours as a float; the two blend differently where a tile is one solid colour (large translucent areas).
 * The tokens whose pre-token web sites painted a float alpha (color-mix(… p%, transparent)) keep it this way:
 * themeVars.gen.ts FLOAT_ALPHA_IDS (tools/modular/lib.mjs FLOAT_ALPHA). Opaque colours are the same either way.
 */
export function cssColour(canonical: string, floatAlpha = false): string {
  const slash = canonical.indexOf("/");
  if (slash < 0) return canonical;
  const [r, g, b] = channels(canonical);
  const a = canonical.slice(slash + 1);
  return floatAlpha ? `rgb(${r} ${g} ${b} / ${a})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}
