// windowGeo.ts — where an app window may sit (pure: the viewport comes from `window`, touch is passed in), so
// AppWindow and its test share one rule (ui/geo.test.ts).

export interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The title bar's height: with a mouse at least that much of a window stays on screen. */
export const TITLE_H = 30;

export function clampGeo(g: Geo, min: { width: number; height: number }, touch: boolean): Geo {
  const vw = window.innerWidth, vh = window.innerHeight;
  // never bigger than the screen, whatever the window's minimum: Space settings (880 wide) on an upright iPad
  // (834) put its Close button out of reach (iPhone/iPad sweep, 2026-10-25)
  const w = Math.min(vw, Math.max(min.width, g.w));
  const h = Math.min(vh, Math.max(min.height, g.h));
  // with a mouse, at least the title bar stays reachable (drag it back); on touch the whole window stays on screen
  // (a position saved in landscape comes back inside the portrait screen)
  const x = touch ? Math.min(Math.max(g.x, 0), vw - w) : Math.min(Math.max(g.x, -w + 80), vw - 80);
  const y = touch ? Math.min(Math.max(g.y, 0), vh - h) : Math.min(Math.max(g.y, 0), vh - TITLE_H);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
