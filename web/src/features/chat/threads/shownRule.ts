// threads/shownRule.ts — the pure rule of shown.ts (Node unit test: shown.test.ts). No app imports.

/** The timelines on screen: none when the room isn't; the main timeline unless the Threads panel covers it (an overlay
 *  sheet); plus the thread the panel shows. */
export function shownTimelinesRule(o: { roomOnScreen: boolean; panelHere: boolean; open: string | null; covers: boolean }): string[] {
  if (!o.roomOnScreen) return [];
  const t = o.panelHere && o.open ? [o.open] : [];
  return o.panelHere && o.covers ? t : ["", ...t];
}
