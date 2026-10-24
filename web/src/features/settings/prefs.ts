// prefs.ts — readers for the device prefs this area owns (settings-account.md §3.15 / §7 "Exposes"),
// plus the message-time formatter the Clock setting drives (Main.qml:678-685 fmtClock).
import { getPref, usePref } from "@/core/prefs";
import { bus } from "@/core/bus";
import { useTheme as useThemeId } from "@/ui";
import { openSettingsAt } from "./store";

export type ClockMode = "system" | "12" | "24";

export function clockMode(): ClockMode {
  const v = String(getPref("clock", "system"));
  return v === "12" || v === "24" ? v : "system";
}
export function useClockMode(): ClockMode {
  const v = String(usePref("clock", "system"));
  return v === "12" || v === "24" ? v : "system";
}

const sysFmt = typeof Intl !== "undefined" ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }) : null;

/** fmtClock(ms): "12" → h:mm AP ("3:07 PM"), "24" → HH:mm ("15:07"), "system" → the locale's short time. */
export function fmtClock(ms: number, mode: ClockMode = clockMode()): string {
  const d = new Date(ms);
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (mode === "24") return `${String(h).padStart(2, "0")}:${mm}`;
  if (mode === "12") return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
  return sysFmt ? sysFmt.format(d) : `${h}:${mm}`;
}

/** The shown theme's id (any theme since step 1b: ui/themeStore.ts decides, ui/themes.ts paints). */
export const useTheme = (): string => useThemeId();
export const useNavMode = () => (String(usePref("nav_mode", "persistent")) === "corner" ? "corner" : "persistent");
export const useReduceMotion = () => String(usePref("reduce-motion", "0")) === "1";
export const useRecordOptout = () => String(usePref("record-optout", "0")) === "1";
export const recordOptout = () => String(getPref("record-optout", "0")) === "1";
export const notifyCallsOn = () => String(getPref("notify.calls", "1")) !== "0";
export function useOverlayPrefs() {
  return {
    enabled: String(usePref("overlay-enabled", "0")) === "1",
    mode: String(usePref("overlay-mode", "speaking")) === "always" ? "always" : "speaking",
    corner: String(usePref("overlay-corner", "tl")),
    hideWhileSharing: String(usePref("overlay-hide-share", "0")) === "1",
  } as const;
}

// ---- openers (other features import these, or emit the bus events directly) --------------------
export const openSettings = (paneId?: string) => openSettingsAt(paneId);
export const openVerify = () => bus.emit("openVerifyDialog", {});
export const openShortcuts = () => bus.emit("openShortcuts", {});
export const openAboutSheet = () => bus.emit("openAbout", {});
export const openReportDialog = () => bus.emit("openBugReport", {});
export const openNoiseTest = () => bus.emit("openNoiseTest", {});
export const openIconGallery = () => bus.emit("openWindow", { id: "iconGallery" });
