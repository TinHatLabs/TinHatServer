// galleryLab.ts — the ambience gallery's LAB switches (#/__gallery/ambience):
//   force=1  the particles on a software rasteriser too (the worst-case measurements)
//   run=1    keep the effect running when the window isn't focused (writes "Pause effects…" off in this profile)
//   title=1  the effect state and the WebGL renderer in the window title (the real-GPU measurements read it)
// Compiled ONLY into a lab build: GalleryAmbience.tsx reaches this module through the build-time constant __TW_LAB__
// (vite.config.ts: true for `vite dev` and `TW_LAB_BUILD=1 vite build`, false for every production build), so a
// production bundle has none of this code; a link can never write a viewer's saved preference or put the GPU's name in
// a window title. tools/release-hooks-check.mjs scans the production bundle for LAB_MARK and checks the behaviour.
import { useEffect } from "react";

/** Present in the bundle only when this module is (the release scan looks for it); set on <html> when a switch acts. */
export const LAB_MARK = "twGalleryLab";
function mark(k: string): void {
  const d = document.documentElement.dataset;
  const now = new Set((d[LAB_MARK] ?? "").split(",").filter(Boolean));
  now.add(k);
  d[LAB_MARK] = [...now].join(",");
}

export function labForce(q: URLSearchParams): boolean {
  if (q.get("force") !== "1") return false;
  mark("force");
  return true;
}

export function labRun(q: URLSearchParams): void {
  if (q.get("run") !== "1") return;
  mark("run");
  localStorage.setItem("tinhat.pref.chat-effects-pause-unfocused", "0");
}

export function useLabTitle(q: URLSearchParams): void {
  useEffect(() => {
    if (q.get("title") !== "1") return;
    mark("title");
    let renderer = "";
    try {
      const c = document.createElement("canvas").getContext("webgl2");
      const d = c?.getExtension("WEBGL_debug_renderer_info");
      renderer = c ? String(c.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : c.RENDERER)) : "no webgl2";
    } catch {
      renderer = "?";
    }
    const t = window.setInterval(() => {
      document.title = `ambience ${document.querySelector("[data-ambience]")?.getAttribute("data-ambience-state") ?? "none"} | ${renderer}`;
    }, 1000);
    return () => window.clearInterval(t);
  }, []);
}
