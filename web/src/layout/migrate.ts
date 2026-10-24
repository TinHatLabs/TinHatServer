// migrate.ts — LAYOUT.md §6.3: 10.6's device prefs → the view state, and the exact seam conversion (decision 9).
import type { JObj, Json } from "./json";
import { fdiv, get, isInt, isObj, mk, obj } from "./json";

/** Math.round for x ≥ 0, spelled out so the Rust port gives the same integer. */
export function jsRound(x: number): number {
  const f = Math.floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

/**
 * The seam conversion: T = max(120 + chromeH, fdiv(fm · H, 1000)); p1 = fdiv(1000 · T, L); of p1 and p1 + 1 (each
 * clamped to 200..850) the per mille whose height fdiv(pm · L, 1000) is nearest to T, ties to the smaller. L ≤ 0 → null
 * (the conversion waits).
 */
export function seamPm(fm: number, H: number, L: number, chromeH: number): number | null {
  if (!(L > 0)) return null;
  const T = Math.max(120 + chromeH, fdiv(fm * H, 1000));
  const p1 = fdiv(1000 * T, L);
  const cands = [p1, p1 + 1].map((p) => (p < 200 ? 200 : p > 850 ? 850 : p));
  let best = cands[0];
  for (const p of cands) {
    const d = Math.abs(fdiv(p * L, 1000) - T);
    const db = Math.abs(fdiv(best * L, 1000) - T);
    if (d < db || (d === db && p < best)) best = p;
  }
  return best;
}

/**
 * migrate(prefs, H, L, chromeH) → the device's view state: `nav_mode` "corner" → forceCollapse ["navcol"];
 * `call-pane-frac` (a number) → legacyCallPaneFm = round(f · 1000) clamped to 200..850; then, when H and L are
 * integers with L > 0 (the first normal solve with the call docked in a col), the seam conversion → sizes.call.pm
 * and legacyCallPaneFm is removed.
 */
export function migrate(prefs: Json | undefined, H: Json | undefined, L: Json | undefined, chromeH: Json | undefined): JObj {
  const p = isObj(prefs) ? prefs : obj();
  const view = obj();
  if (get(p, "nav_mode") === "corner") view["forceCollapse"] = ["navcol"];
  const f = get(p, "call-pane-frac");
  let fm: number | null = null;
  if (typeof f === "number" && Number.isFinite(f) && f >= 0) {
    const r = jsRound(f * 1000);
    fm = r < 200 ? 200 : r > 850 ? 850 : r;
  }
  if (fm !== null) {
    const px = (v: Json | undefined) => (isInt(v) ? (v < 0 ? 0 : v > 16384 ? 16384 : v) : null); // host bounds
    const ch = px(chromeH) ?? 0;
    const h = px(H);
    const l = px(L);
    const pm = h !== null && l !== null ? seamPm(fm, h, l, ch) : null;
    if (pm !== null) view["sizes"] = mk([["call", mk([["pm", pm]])]]);
    else view["legacyCallPaneFm"] = fm;
  }
  return view;
}
