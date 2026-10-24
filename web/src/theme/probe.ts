// probe.ts — the Pick tool's probe colours (THEMES-UI.md §14). To find which named colours paint the element under
// the pointer, an app swaps in a PROBE THEME — every role and element token a different colour that encodes its index —
// reads the element's colour properties, and swaps the real theme back, all inside one synchronous step (no frame is
// drawn in between: the web recomputes styles without painting inside a task; the desktop's bindings update at once
// and the scene graph only syncs after the GUI thread returns to its loop). A colour read in the probe pass decodes
// back to the id that painted it; alpha is ignored (alpha(token, n) keeps the token's rgb), anything computed from a
// token with other maths does not decode (and is reported as not named). The same codec in both apps
// (crates/theme/src/probe.rs), pinned by testvectors/editor/probe-*.json.
import type { TokensSpec } from "./engine";
import { cmpCodePoint } from "./canon";
import { ROLE_IDS } from "./roles";

/** At most this many ids (the codec's 12-bit index). */
export const PROBE_MAX = 4095;

/** The ids the probe paints, in index order: every role (sorted), then every token of the spec (sorted). */
export function probeIds(spec: TokensSpec): string[] {
  const tokens = spec.tokens.map((t) => t.id).sort(cmpCodePoint);
  const ids = [...ROLE_IDS, ...tokens];
  if (ids.length > PROBE_MAX) throw new Error("probe: too many ids");
  return ids;
}

const HEX = "0123456789abcdef";
const hex2 = (v: number) => HEX[v >> 4] + HEX[v & 15];

/** The probe colour of index i (0-based): j = i + 1; r = j >> 4; g = (j & 15) << 4 | (7j + 3) & 15; b = (151j + 89) & 255. */
export function probeRgb(i: number): [number, number, number] {
  const j = i + 1;
  return [j >> 4, ((j & 15) << 4) | ((j * 7 + 3) & 15), (j * 151 + 89) & 255];
}
export function probeColour(i: number): string {
  const [r, g, b] = probeRgb(i);
  return "#" + hex2(r) + hex2(g) + hex2(b);
}

/** The index a colour decodes to (0 ≤ index < count), or -1 when it is not a probe colour of this set. */
export function probeIndex(r: number, g: number, b: number, count: number): number {
  const j = (r << 4) | (g >> 4);
  if (j < 1 || j > count) return -1;
  if ((g & 15) !== ((j * 7 + 3) & 15)) return -1;
  if (b !== ((j * 151 + 89) & 255)) return -1;
  return j - 1;
}

/** id → probe colour for every probe id (what the app paints during the probe pass). */
export function probeColours(spec: TokensSpec): Record<string, string> {
  const out: Record<string, string> = {};
  probeIds(spec).forEach((id, i) => {
    out[id] = probeColour(i);
  });
  return out;
}

/** What a picked colour property is (the Pick list's badge). */
export type PickKind = "text" | "fill" | "border" | "icon" | "shadow" | "other";
export interface PickHit {
  id: string;
  kind: PickKind;
}
/** One element under the pointer (nearest first) and the named colours it paints. */
export interface PickLayer {
  element: string;
  hits: PickHit[];
}

/** The Pick list (§14.3): the ids of the layers in order, each id once (its first kind), at most `max` layers. */
export function pickList(layers: readonly PickLayer[], max = 8): PickHit[] {
  const seen = new Set<string>();
  const out: PickHit[] = [];
  for (const l of layers.slice(0, max)) {
    for (const h of l.hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h);
    }
  }
  return out;
}
