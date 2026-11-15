// linkLab.ts — the LINK-REACHABLE URL modes that write something or silence a prompt (fix1216/weblinkfence,
// launch-gate 19:13). Anyone can paste a link with these into a chat and the person who clicks it runs them in their
// own signed-in session, so they exist ONLY in a lab build:
//   noverify           the "Verify this device" sheet does not open by itself after sign-in (implies noconsent)
//   noconsent          the first-run log-sharing consent is skipped (dormant while LOGSHIP_ENABLED is false)
//   fakewrite=1        (search part, with fakecall=1) member-menu actions on the fake call's tiles run for real
//   navmode=<m>|dock=  (with gate=1) writes the device pref nav_mode (persistent | corner) before the first render
//   gamebg art=<url>   (#/__gallery/gamebg) the gallery draws (and so fetches) the named art
// Compiled ONLY into a lab build: each read site reaches this module through the build-time constant __TW_LAB__
// (vite.config.ts: true for `vite dev` and `TW_LAB_BUILD=1 vite build`, false for every production build), so a
// production bundle has none of this code (the same pattern as app/galleryLab.ts). tools/release-hooks-check.mjs scans
// the production bundle for LINK_LAB_MARK and the parameter names, and checks the behaviour against the lab bundle.
import { setPref } from "../core/prefs";

/** Present in the bundle only when this module is (the release scan looks for it); set on <html> when a switch acts. */
export const LINK_LAB_MARK = "twLinkLab";
function mark(k: string): void {
  const d = document.documentElement.dataset;
  const now = new Set((d[LINK_LAB_MARK] ?? "").split(",").filter(Boolean));
  now.add(k);
  d[LINK_LAB_MARK] = [...now].join(",");
}
function url(): string {
  try {
    return location.search + location.hash;
  } catch {
    return "";
  }
}

/** ?noverify: the verify sheet does not open by itself (the first device's new key is still shown). */
export function noVerify(): boolean {
  if (!/[?&]noverify\b/.test(url())) return false;
  mark("noverify");
  return true;
}

/** ?noconsent (or ?noverify): the first-run log-sharing consent is not asked. */
export function noConsent(): boolean {
  if (!/[?&](noconsent|noverify)\b/.test(url())) return false;
  mark("noconsent");
  return true;
}

/** ?fakewrite=1 (search part): the fake call's write guard is lifted (callui-interact.mjs). */
export function fakeWrite(): boolean {
  let s = "";
  try {
    s = location.search;
  } catch {
    /* no location */
  }
  if (!/[?&]fakewrite=1/.test(s)) return false;
  mark("fakewrite");
  return true;
}

/** gate=1 &navmode=persistent|corner, or &dock=<any> (= corner): the nav mode pref, before the first render. */
export function navMode(p: URLSearchParams): void {
  const mode = p.get("navmode") ?? (p.get("dock") ? "corner" : null);
  if (mode !== "corner" && mode !== "persistent") return;
  mark("navmode");
  setPref("nav_mode", mode);
}

/** #/__gallery/gamebg?art=<url>: the art the gallery draws (null = none). */
export function gamebgArt(q: URLSearchParams): string | null {
  const a = q.get("art");
  if (a) mark("gallery-art");
  return a;
}
