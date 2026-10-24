// intents.ts — the one entry point every "Space settings" affordance lands on (Main.qml
// openSpaceSettings, SPC-08/09): a target that isn't a space id toasts "Pick a space first — this
// room isn't in one" (3 s) and nothing opens; else the window opens (or is raised) on `tab`.
import { bus, openWindow, toast } from "@/core/bus";

export type SpaceTab = "overview" | "members" | "roles" | "rooms";
export const SPACE_SETTINGS_WINDOW = "spacesettings";

export function normalizeTab(tab: string | undefined | null): SpaceTab {
  return tab === "members" || tab === "roles" || tab === "rooms" ? tab : "overview";
}

/** Open (or raise + switch tab) the Space settings window for `spaceId`. */
export function openSpaceSettingsIntent(spaceId: string, tab?: string) {
  const id = String(spaceId || "");
  if (!id.startsWith("!")) {
    toast("Pick a space first — this room isn't in one", { timeoutMs: 3000 });
    return;
  }
  // a fresh `nonce` makes a re-open with the same tab still switch/raise (SSW:97-105)
  openWindow(SPACE_SETTINGS_WINDOW, { spaceId: id, tab: normalizeTab(tab), nonce: Date.now() });
}

/** bus: openSpaceSettings {spaceId, tab} → the window (registered in feature.setup). */
export function installSpaceSettingsBus(): () => void {
  return bus.on("openSpaceSettings", ({ spaceId, tab }) => openSpaceSettingsIntent(spaceId, tab));
}
