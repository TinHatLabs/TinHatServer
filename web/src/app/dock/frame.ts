// frame.ts — an island's frame from its solver rect (ISLANDS-ARCH §2.4, §3.4; the desktop's Island.qml): absolute,
// integer px, z from the solver, hidden (`visibility: hidden`, the island stays mounted) while the solver says so or the
// rect is empty; the island look — the fill (island.bg.<ref>) under the content, the 1 px frame (island.border) above
// it, the theme's corner radius — and the content inset ceil(0.293 × radius), so square content never pokes out of a
// rounded corner (the header's gradient rounds itself: inset 0). Pure.
export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  visible: boolean;
}
export function frameRect(r: { x: number; y: number; w: number; h: number; z?: number; vis?: boolean } | undefined): FrameRect {
  if (!r) return { left: 0, top: 0, width: 0, height: 0, zIndex: 0, visible: false };
  return { left: r.x, top: r.y, width: r.w, height: r.h, zIndex: r.z ?? 0, visible: r.vis !== false && r.w > 0 && r.h > 0 };
}

/** The content inset of a frame with corner radius `radius` (px): ceil(0.293 × r) — 4 at the default 12. The
 *  desktop's Island.qml computes the same (Math.ceil(0.293 * radius)). */
export function contentInset(radius: number): number {
  return Math.max(0, Math.ceil(0.293 * (Number(radius) || 0)));
}

/** The content box inside a frame: the rect minus `inset` on each side, never negative. */
export function contentBox(w: number, h: number, inset: number): { w: number; h: number } {
  return { w: Math.max(0, w - 2 * inset), h: Math.max(0, h - 2 * inset) };
}

/** What a "dom" island reports (px, the inset included): its natural height = the content box's height + 2 × inset; with
 *  `minIsNatural` that is also its minimum (content.minH, LAYOUT.md §7.4) — 10.8: the composer, whose reply bar and
 *  several lines were squeezed to the registry's 48 px under a call. The desktop's DockHost.measure() does the same
 *  (Island.minIsNatural). */
export function domMeasured(contentH: number, inset: number, minIsNatural = false): { h: number; minH?: number } {
  const h = Math.max(0, Number(contentH) || 0) + 2 * Math.max(0, inset);
  return minIsNatural ? { h, minH: h } : { h };
}

/** z bands of the host (ISLANDS-ARCH §2.5): docked 0 · overlaid panel 2 · floats 10-19 · drawer panels 20. */
export const inDrawerBand = (z: number): boolean => z >= 20 && z < 30;

/** What a frame paints, bottom to top (the desktop's Island.qml): the fill, the content, 11.0 edit mode's placeholder of
 *  absent content (EDITMODE-UI §2, §20) and the frame line — one piece at the island's z, so an island above it (a
 *  float) covers all four. IslandFrame renders its parts in this order. */
export const FRAME_LAYERS = ["fill", "content", "placeholder", "line"] as const;
export type FrameLayer = (typeof FRAME_LAYERS)[number];

/** Each island's fill (the element fill its content painted before islands; OLED and Goose keep their colours). */
export const ISLAND_BG: Readonly<Record<string, string>> = {
  nav: "var(--th-island-bg-nav)",
  dms: "var(--th-island-bg-dms)",
  spaces: "var(--th-island-bg-spaces)",
  rooms: "var(--th-island-bg-rooms)",
  widgets: "var(--th-island-bg-widgets)",
  account: "var(--th-island-bg-account)",
  header: "var(--th-island-bg-header)",
  call: "var(--th-island-bg-call)",
  timeline: "var(--th-island-bg-timeline)",
  composer: "var(--th-island-bg-composer)",
  panel: "var(--th-island-bg-panel)",
  buttons: "var(--th-island-bg-buttons)",
};
export const islandBg = (ref: string): string => ISLAND_BG[ref.split(":")[0]] ?? "transparent";
