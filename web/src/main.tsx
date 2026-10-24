// main.tsx — bootstrap. The theme is applied before the first React render (no flash of the
// wrong palette), features register their contributions, then the App mounts over the static
// "Starting up" card index.html painted before any script ran.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getPref } from "@/core/prefs";
import { loadFeatures } from "@/core/registry";
import { AppErrorBoundary, applyReducedMotion, installMotion, loadIconIndex, showFatalCard } from "@/ui";
import { bootTheme } from "@/ui/themeStore";
import { createLogger } from "@/core/log";
import { App } from "@/app/App";
import { initFontSet } from "@/ui/fontset";

// the theme store (THEMES-SYNC.md §8): the device override → the account's choice → the device's own theme, painted
// before the first render, then kept current (other tabs, the account-data sync)
bootTheme();
applyReducedMotion(getPref("reduce-motion", false));
// GPU.md §1: the window state (<html data-win>), the motion switch (<html data-animate>) and the caret rule — before
// the first render, so nothing animates on a page that opens unfocused or with Reduce motion on
installMotion();
initFontSet();
const log = createLogger("app");
void loadIconIndex().catch(() => {});
loadFeatures();

// W1 (docs/VERIFY-SAS.md): a render exception must never leave the bare OLED page. The app boundary shows a
// recoverable card; anything that still escapes (the boundary itself failing) gets the plain-DOM card.
createRoot(document.getElementById("root")!, {
  onUncaughtError(error, info) {
    log.error("uncaught render error — showing the recovery card", error, info.componentStack?.split("\n").slice(0, 6).join("\n"));
    showFatalCard(error);
  },
  onCaughtError(error, info) {
    log.error("render error caught by a boundary", error, info.componentStack?.split("\n").slice(0, 6).join("\n"));
  },
}).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
