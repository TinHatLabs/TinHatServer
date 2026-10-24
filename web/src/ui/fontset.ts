// Font set — which desktop the type sizes copy.
//
// The native app takes its fonts from the platform. On a KDE Plasma desktop (the defaults: Noto Sans 10 pt,
// smallest readable 8 pt) body text is 13.33 px and Kirigami.Theme.smallFont 10.67 px. On the reference rig
// (Qt Basic style, no KDE platform theme — the same situation as the Windows builds) the default font is
// 9 pt = 12 px and smallFont renders at 16 px (a Kirigami basic-theme quirk: "small" is bigger than body).
//
//   "plasma"  default everywhere except Windows — what the group sees on their desktops
//   "rig"     Windows, and 1:1 screenshot comparisons against tools/native-shot.sh (?fontset=rig)
//
// Pref `fontset` = auto | plasma | rig; URL `?fontset=` wins (for gates). Tokens live in tokens.css.
import { getPref, onPrefChange } from "@/core/prefs";

export type FontSet = "plasma" | "rig";

function urlOverride(): FontSet | null {
  try {
    const q = new URLSearchParams(location.search).get("fontset");
    return q === "plasma" || q === "rig" ? q : null;
  } catch {
    return null;
  }
}

function isWindows(): boolean {
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return (uad?.platform ?? navigator.userAgent).toLowerCase().includes("win");
}

export function resolveFontSet(): FontSet {
  const u = urlOverride();
  if (u) return u;
  const p = String(getPref("fontset", "auto"));
  if (p === "plasma" || p === "rig") return p;
  return isWindows() ? "rig" : "plasma";
}

export function applyFontSet(): void {
  document.documentElement.dataset.fontset = resolveFontSet();
}

let wired = false;
export function initFontSet(): void {
  applyFontSet();
  if (wired) return;
  wired = true;
  onPrefChange("fontset", applyFontSet);
}
