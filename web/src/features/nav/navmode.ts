// navmode.ts — nav mode state (qml/Main.qml:718-740 setNavMode / toggleSidebar): "persistent"
// (the 360 px sidebar, default) or "corner" (the hover dock). Persisted per install in the pref
// `nav_mode` (native data-dir file of the same name); the shell reads the same pref.
import { getPref, setPref, usePref } from "@/core/prefs";

export type NavMode = "persistent" | "corner";

export function getNavMode(): NavMode {
  return getPref("nav_mode", "persistent") === "corner" ? "corner" : "persistent";
}

/** setNavMode(m) ignores anything else, stores, persists (the shell re-lays out on the pref). */
export function setNavMode(m: string): void {
  if (m !== "persistent" && m !== "corner") return;
  setPref("nav_mode", m);
}

export function toggleSidebar(): void {
  setNavMode(getNavMode() === "corner" ? "persistent" : "corner");
}

export function useNavMode(): NavMode {
  return usePref("nav_mode", "persistent") === "corner" ? "corner" : "persistent";
}
