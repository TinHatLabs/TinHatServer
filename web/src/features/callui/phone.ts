// phone.ts — the phone call layout's rules (Mobile.tsx), kept pure so phone.test.ts can check them under node.
// Web only: the desktop app has no phone layout.

export interface Pt {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface View extends Pt, Size {}

/** Gap kept between the minimised call pill and the edges of what's visible / the composer. */
export const PILL_MARGIN = 4;

/** Where the minimised call pill may sit (A37.2): wholly inside `view` (the visual viewport — what the on-screen
 *  keyboard leaves visible) by its MEASURED size, and, when `composerTop` is given (the composer's top edge, same
 *  coordinates), above the composer. If it can't fit, the top-left wins (it stays reachable). */
export function pillClamp(pos: Pt, size: Size, view: View, composerTop?: number | null): Pt {
  const m = PILL_MARGIN;
  const minX = view.x + m;
  const minY = view.y + m;
  const maxX = Math.max(minX, view.x + view.w - size.w - m);
  let maxY = view.y + view.h - size.h - m;
  if (composerTop != null && Number.isFinite(composerTop)) maxY = Math.min(maxY, composerTop - size.h - m);
  maxY = Math.max(minY, maxY);
  return { x: Math.min(maxX, Math.max(minX, pos.x)), y: Math.min(maxY, Math.max(minY, pos.y)) };
}

/** A share / lone / pinned tile's height cap in portrait (the top bar, the call bar and some of the grid below). */
export const PORTRAIT_CELL_MAX = "calc(100dvh - 190px)";
/** The tile scroller's bottom padding (Mobile.module.css .scroller). */
export const SCROLLER_PAD_BOTTOM = 12;

/** Landscape: wider than tall (a phone on its side). */
export function isLandscape(w: number, h: number): boolean {
  return w > h;
}

/** The height cap of a share / lone / pinned tile on the phone stage (A37.4). Portrait keeps the fixed cap; landscape
 *  takes the whole height of the tile area (`scrollerH`, measured) — the fixed cap left a share about 200 px tall on
 *  a 390 px-high phone on its side. Unmeasured yet (0): the portrait cap. */
export function phoneCellMaxHeight(landscape: boolean, scrollerH: number): string {
  if (!landscape || !(scrollerH > 0)) return PORTRAIT_CELL_MAX;
  return `${Math.max(120, Math.floor(scrollerH - SCROLLER_PAD_BOTTOM))}px`;
}

/** Landscape auto-hide (A37.4, a behaviour change kept in its own commit): how long the call's chrome stays after the
 *  last touch. */
export const CHROME_IDLE_MS = 4000;
/** Open popups the call store doesn't track (a tile's menu, a combo sheet): the timer waits while one is open. */
export const OPEN_POPUP_SELECTOR = '[role="menu"], [role="dialog"], [role="listbox"]';

/** The call's own menus / popovers / sheets (the call UI store's fields, and the stage's "more" sheet). */
export interface CallMenus {
  more: string | null;
  optsFace: unknown;
  streamPop: boolean;
  volMenu: unknown;
  menuHeld: number;
  soundboardOpen: boolean;
  ecOpen: boolean;
}
export function callMenuOpen(m: CallMenus): boolean {
  return m.more !== null || !!m.optsFace || m.streamPop || !!m.volMenu || m.menuHeld > 0 || m.soundboardOpen || m.ecOpen;
}

/** Landscape with a share or a camera on the stage: the top bar and the call bar float over the tiles, so the picture
 *  gets the whole height. */
export function phoneOverlay(landscape: boolean, media: boolean): boolean {
  return landscape && media;
}

/** The chrome hides by itself after CHROME_IDLE_MS without a touch only in that case, and never while a menu / sheet /
 *  popover is open. Portrait never auto-hides. */
export function chromeAutoHides(landscape: boolean, media: boolean, menuOpen: boolean): boolean {
  return phoneOverlay(landscape, media) && !menuOpen;
}
