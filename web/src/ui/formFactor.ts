// formFactor.ts — what the primitives need to know about the device, without importing core:
// the shell owns detection (@/core/device useFormFactor) and mirrors it onto <html> as
// data-ff="mobile|desktop" and data-touch; primitives read those attributes here (menus become
// bottom sheets, AppWindows full-screen sheets, tooltips are dropped on touch).
import { useSyncExternalStore } from "react";

type FF = "desktop" | "mobile";

function read(): { ff: FF; touch: boolean } {
  if (typeof document === "undefined") return { ff: "desktop", touch: false };
  const d = document.documentElement.dataset;
  return { ff: d.ff === "mobile" ? "mobile" : "desktop", touch: d.touch !== undefined };
}

let cur = read();
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      const n = read();
      if (n.ff !== cur.ff || n.touch !== cur.touch) {
        cur = n;
        for (const l of listeners) l();
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ff", "data-touch"] });
  }
  return () => listeners.delete(cb);
}

/** Set by the shell (from @/core/device). */
export function setFormFactorAttrs(ff: FF, touch: boolean): void {
  const d = document.documentElement.dataset;
  d.ff = ff;
  if (touch) d.touch = "";
  else delete d.touch;
  cur = read();
  for (const l of listeners) l();
}

// Snapshots read the attributes live (cheap) — a cached value would go stale when the shell sets
// them before the first subscriber (and so the observer) exists.
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => read().ff === "mobile", () => false);
}

export function useIsTouch(): boolean {
  return useSyncExternalStore(subscribe, () => read().touch, () => false);
}

export function isMobileNow(): boolean {
  return read().ff === "mobile";
}
