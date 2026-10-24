// dispatch.ts — ONE Back / Escape path for the window (ISLANDS-ARCH §2.8; the desktop's twin is the window event
// filter in video_bridge.cpp + Main.qml tinhatBack / tinhatEscapeLayout).
//
// Back (Alt+Left, the browser Back key, the mouse Back button — capture phase, before anything else): an open popup
// closes (the popup stack's topmost, as Escape would close it) and that is the whole Back — a modal never has the
// layout changed underneath it; else the right panel closes if it overlays the conversation; else an open, unpinned
// nav drawer closes. Nothing to close = not ours: the browser's history Back runs (the previous room). The desktop
// opens the collapsed nav's drawer there instead (it has no history) — docs/WEB-EXCEPTIONS.md.
// Escape (bubble phase, after popups, the composer and "fill the app" had theirs — each calls preventDefault): the
// overlaid panel closes, then an open unpinned drawer (§2.8 steps 6-7).
import { useEffect } from "react";
import { closeTopPopup } from "@/ui";
import { closeDrawer, useDrawerStore } from "@/features/nav";
import { closeRightPanel, rightPanelIsOverlay, useRightPanelStore } from "@/features/spaces";

function closeLayoutLayer(drawerActive: boolean): boolean {
  if (rightPanelIsOverlay() && useRightPanelStore.getState().open) {
    closeRightPanel();
    return true;
  }
  const d = useDrawerStore.getState();
  if (drawerActive && d.opened && !d.pinned) {
    closeDrawer();
    return true;
  }
  return false;
}

/** Install the window's Back / Escape dispatch (the desktop shell only; phones keep their stack). */
export function useBackDispatch(drawerActive: boolean) {
  useEffect(() => {
    const back = () => closeTopPopup() || closeLayoutLayer(drawerActive);
    const onKey = (e: KeyboardEvent) => {
      const isBack = (e.key === "ArrowLeft" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === "BrowserBack";
      if (!isBack || e.defaultPrevented) return;
      if (back()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 || e.defaultPrevented) return;
      if (back()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (closeLayoutLayer(drawerActive)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mouseup", onMouse, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mouseup", onMouse, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, [drawerActive]);
}
