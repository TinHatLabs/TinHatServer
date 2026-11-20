// textSize.ts — P22 (12.1.17), the web's glue for the personal text size + density (the shared rules, steps, words and
// the migration are src/theme/personal.ts; the desktop does the same in theme_ctl.rs + Th.qml):
//  * personalNow(): the person's size + density from the prefs `text-size` / `density` (the same keys and values as
//    the desktop's `ui-text-size` / `ui-density` files);
//  * phones follow the phone's own text size where the browser tells us: iOS / iPadOS Dynamic Type through the
//    `-apple-system-body` font (Safari and the Tin Hat iPhone app's WKWebView; 17 px = the default "Large" = 100 %),
//    snapped to the nearest step. ONE rule decides it for the page and for Settings (osFollowEligible): the phone
//    layout on a touch screen whose browser exposes the size (a Mac's Safari exposes it too, so a desktop in the phone
//    layout with a mouse never qualifies). Web-only pref `text-size-os`: "1" follow, "0" don't; absent = follow only
//    while the person has no size of their own (a size the migration kept, or one they picked, always wins).
//    Android and desktop browsers expose no OS text size to a page (docs/WEB-EXCEPTIONS.md "Text size + density");
//  * applyPersonal(): the CSS variables tokens.css and the lists read: --th-text-scale (every type size × it),
//    --th-row-room (a room row, personal.ts row(40)), --th-gap-group (the space above a new sender in the chat, gap(4)),
//    and <html data-density>. An empty value removes the inline declaration, so 100 % / Cozy is exactly the old page.
// The phone's size is measured outside React (at boot and when the tab comes back to the front) and cached; render
// code reads the cache (useOsTextPercent), so no component touches the DOM while it renders.
// Relative imports only: themes.ts imports this file and node unit tests load themes.ts.
import { useSyncExternalStore } from "react";
import { getPrefRaw, setPrefRaw } from "../core/prefs";
import { isMobileNow, onFormFactorAttrs } from "./formFactor";
import {
  PREF_DENSITY, PREF_MIGRATED, PREF_TEXT_SIZE, effectiveDensity, gap, migrate, parseTextSize, readPersonal, row, snapTextSize,
  type Personal,
} from "../theme/personal";

// P22 round 2: the density of the layout form this device renders (LAYOUT.md form field; the Handheld preset = touch),
// supplied by src/actions/layoutDensity.ts (installed in main.tsx; this file stays free of the layout store so node unit
// tests can load it). While a layout names one it is drawn instead of the person's; Settings says so.
let layoutDensitySource: () => unknown = () => null;
export function setLayoutDensitySource(fn: () => unknown): void {
  layoutDensitySource = fn;
}

/** Web only: follow the phone's text size ("1"), don't ("0"); absent = follow while the person has no size of their own. */
export const PREF_FOLLOW_OS = "text-size-os";

/** The default "Large" Dynamic Type body size on iOS / iPadOS, in CSS px. */
const IOS_BODY_PX = 17;

let osCache: number | null | undefined; // undefined = not measured yet
const osListeners = new Set<() => void>();

/** Measure the phone's own text size in per cent (iOS / iPadOS Dynamic Type), or null where the browser hides it. */
function measureOs(): number | null {
  if (typeof document === "undefined" || typeof CSS === "undefined" || typeof CSS.supports !== "function") return null;
  if (!CSS.supports("font", "-apple-system-body")) return null;
  const host = document.body ?? document.documentElement;
  const el = document.createElement("span");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;font:-apple-system-body";
  el.textContent = "x";
  host.appendChild(el);
  const px = parseFloat(getComputedStyle(el).fontSize);
  el.remove();
  return Number.isFinite(px) && px > 0 ? Math.round((px * 100) / IOS_BODY_PX) : null;
}

/** Measure again (boot, the tab back in front); tells the subscribers when it changed. Never called while rendering. */
export function refreshOsTextPercent(): void {
  const v = measureOs();
  if (v === osCache) return;
  osCache = v;
  for (const l of osListeners) l();
}

/** The last measured phone text size (null = not exposed, or not measured yet). */
export function osTextPercent(): number | null {
  return osCache ?? null;
}

/** React: the last measured phone text size (re-renders when a new measurement differs). */
export function useOsTextPercent(): number | null {
  return useSyncExternalStore(
    (cb) => {
      osListeners.add(cb);
      return () => osListeners.delete(cb);
    },
    osTextPercent,
    () => null,
  );
}

const touchScreen = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** May this page follow the phone's text size at all? (the phone layout, a touch screen, a measured size) */
export function osFollowEligible(os: number | null = osTextPercent()): boolean {
  return os !== null && isMobileNow() && touchScreen();
}

/** Does the page follow the phone's text size now? (the one rule Settings shows and the page draws) */
export function followsOs(followPref: string | null = getPrefRaw(PREF_FOLLOW_OS), sizePref: string | null = getPrefRaw(PREF_TEXT_SIZE), os: number | null = osTextPercent()): boolean {
  if (!osFollowEligible(os)) return false;
  if (followPref === "1") return true;
  if (followPref === "0") return false;
  return parseTextSize(sizePref) === null;
}

/** The person's size and the density as this page draws them (the layout's density, else the person's). */
export function personalNow(): Personal {
  const p = readPersonal(getPrefRaw(PREF_TEXT_SIZE), getPrefRaw(PREF_DENSITY));
  p.density = effectiveDensity(p.density, layoutDensitySource());
  const os = osTextPercent();
  if (os !== null && followsOs()) p.size = snapTextSize(os);
  return p;
}

/** Put the person's size + density on the page (themes.ts paint() and every change of the prefs call it). */
export function applyPersonal(): Personal {
  if (osCache === undefined) refreshOsTextPercent();
  const p = personalNow();
  if (typeof document === "undefined") return p;
  const root = document.documentElement;
  root.style.setProperty("--th-text-scale", p.size !== 100 ? String(p.size / 100) : "");
  const r = row(40, p.size, p.density);
  root.style.setProperty("--th-row-room", r !== 40 ? `${r}px` : "");
  const g = gap(4, p.density);
  root.style.setProperty("--th-gap-group", g !== 4 ? `${g}px` : "");
  if (p.density !== "normal") root.dataset.density = p.density;
  else delete root.dataset.density;
  return p;
}

/** 12.1.18 review #4: whether the page may follow the phone's text size depends on the phone layout (data-ff) and the
 *  touch mark (data-touch), which the shell sets on <html> in an effect AFTER the first applyPersonal (main.tsx). Re-apply
 *  on every change of those marks, so "Match my phone" (the default with no size of one's own) is drawn on the first load
 *  and the sign-in screen too, not only after a pref change or the tab coming back. Returns the unsubscribe. */
export function reapplyOnFormFactor(): () => void {
  return onFormFactorAttrs(() => {
    applyPersonal();
  });
}

/** The one-time move of the active theme's old size / density into the prefs (personal.ts migrate). */
export function migratePersonal(activeThemeDoc: unknown): void {
  const writes = migrate(getPrefRaw(PREF_MIGRATED), getPrefRaw(PREF_TEXT_SIZE), getPrefRaw(PREF_DENSITY), activeThemeDoc);
  for (const [k, v] of writes) setPrefRaw(k, v);
}
