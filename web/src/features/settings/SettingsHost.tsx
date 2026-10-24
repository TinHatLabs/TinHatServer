// SettingsHost.tsx — the always-mounted half of Settings (the shell mounts it as `SettingsSheet`, ARCHITECTURE "Shell"):
// the bus entry points. The window itself is the registered in-app window "settings" (SettingsWindow.tsx), rendered by
// the WindowHost; this component only opens / raises / closes it.
//   openSettings { paneId? }   → the window on that pane (old key `sessions` = Devices & security)
//   openAbout                  → the window on About & help (the About sheet is gone, SETTINGS-WINDOW.md §5)
//   openThemeGallery           → Appearance with the theme gallery (THEMES-UI §12)
//   editCurrentTheme           → Appearance's Customize… (THEMES-UI §12 amendment)
//   closeSettings / loggedOut  → closed
import { useBus } from "@/core/bus";
import { useSession } from "@/core/matrix";
import { closeSettings, openSettingsAt, openThemeGallery } from "./store";
import { editCurrentTheme } from "./panes/AppearancePane";

export function SettingsHost() {
  const session = useSession();
  const signedIn = session.state === "ready" || session.state === "syncing";

  useBus("openSettings", ({ paneId }) => {
    if (signedIn) openSettingsAt(paneId);
  });
  useBus("openAbout", () => {
    if (signedIn) openSettingsAt("about");
  });
  // the ☰ Theme menu's "More themes…" (THEMES-UI §12)
  useBus("openThemeGallery", () => {
    if (signedIn) openThemeGallery();
  });
  // the ☰ Theme menu's "Edit current theme…" (THEMES-UI §12 amendment 2026-09-28): Appearance's Customize…
  useBus("editCurrentTheme", () => {
    if (signedIn) editCurrentTheme();
  });
  useBus("closeSettings", () => closeSettings());
  useBus("loggedOut", () => closeSettings());
  return null;
}
