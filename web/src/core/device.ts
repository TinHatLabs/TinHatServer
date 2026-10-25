// device.ts — form factor detection (ARCHITECTURE.md "Scope rule + mobile").
//
//   const ff = useFormFactor();        // "desktop" | "mobile"  (reactive)
//   const touch = useIsTouch();        // coarse pointer / touch screen
//   getFormFactor(), isTouch           // non-React reads
//
// Mobile when (coarse pointer OR navigator.userAgentData.mobile) AND the SHORT screen side < 820 px,
// OR the viewport is narrower than 700 px. Overrides, strongest first:
//   ?ff=mobile|desktop in the URL (before or after the #hash — tests use it)
//   pref "formFactor" = auto|desktop|mobile (Settings → Appearance → Layout)
// Tablets (coarse pointer, short side ≥ 820 px) stay "desktop" with isTouch = true.
// The shell mirrors the result onto <html data-ff data-touch> (ui/formFactor.ts reads that).
import { useSyncExternalStore } from "react";
import { getPref, onPrefChange } from "@/core/prefs";

export type FormFactor = "desktop" | "mobile";

function mq(q: string): boolean {
  try {
    return typeof matchMedia !== "undefined" && matchMedia(q).matches;
  } catch {
    return false;
  }
}

function detectTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  return mq("(pointer: coarse)") || (navigator.maxTouchPoints ?? 0) > 0;
}

/** URL override: ?ff=mobile|desktop in location.search or in the hash's query part. */
function urlOverride(): FormFactor | null {
  if (typeof location === "undefined") return null;
  const fromSearch = new URLSearchParams(location.search).get("ff");
  const hq = location.hash.indexOf("?");
  const fromHash = hq >= 0 ? new URLSearchParams(location.hash.slice(hq + 1)).get("ff") : null;
  const v = fromSearch ?? fromHash;
  return v === "mobile" || v === "desktop" ? v : null;
}

function prefOverride(): FormFactor | null {
  const v = getPref("formFactor", "auto");
  return v === "mobile" || v === "desktop" ? v : null;
}

/** The automatic decision (no overrides). */
export function autoFormFactor(): FormFactor {
  if (typeof window === "undefined") return "desktop";
  const coarse = mq("(pointer: coarse)");
  const short = Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight);
  const uaMobile = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true;
  // uaMobile counts only with a phone-sized screen too: Chromium reports userAgentData.mobile for
  // emulated / some real tablets (Playwright "iPad Pro 11": 834 px short side) — tablets keep the
  // desktop layout with touch adaptations (ARCHITECTURE "Form factor"; INTEGRATION #6)
  if (((coarse || uaMobile) && short < 820) || window.innerWidth < 700) return "mobile";
  return "desktop";
}

export function getFormFactor(): FormFactor {
  return urlOverride() ?? prefOverride() ?? autoFormFactor();
}

/** Touch-capable device (evaluated at load; see useIsTouch for the live value). */
export const isTouch: boolean = detectTouch();

let ff: FormFactor = getFormFactor();
let touch = isTouch;
const listeners = new Set<() => void>();
let wired = false;

function update() {
  const nf = getFormFactor();
  const nt = detectTouch();
  if (nf === ff && nt === touch) return;
  ff = nf;
  touch = nt;
  for (const l of listeners) l();
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.addEventListener("hashchange", update);
  window.addEventListener("popstate", update);
  try {
    matchMedia("(pointer: coarse)").addEventListener("change", update);
  } catch {
    /* old browsers */
  }
  onPrefChange("formFactor", update);
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useFormFactor(): FormFactor {
  return useSyncExternalStore(
    subscribe,
    () => ff,
    () => "desktop" as FormFactor,
  );
}

export function useIsTouch(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => touch,
    () => false,
  );
}

/** How much of the page the on-screen keyboard covers, in px (App mirrors it into --th-vv-bottom). Browsers keep the
 *  layout viewport and shrink the visual one: the covered part is below the visual viewport. An iPhone/iPad Home
 *  Screen app (<html data-ios-pwa>) shrinks both and pans the screen-tall body instead (tokens.css): the covered
 *  part is the body's height minus what is visible. A pinch-zoom is not a keyboard there. */
export function keyboardInset(vv: VisualViewport): number {
  if (document.documentElement.hasAttribute("data-ios-pwa")) {
    return vv.scale > 1.01 ? 0 : Math.max(0, Math.round(document.body.offsetHeight - vv.height));
  }
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

/** Non-React subscription (fires when the form factor or touch capability changes). */
export function onFormFactorChange(cb: () => void): () => void {
  return subscribe(cb);
}
