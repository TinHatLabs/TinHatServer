// store.ts — the Settings window's state (SETTINGS-WINDOW.md §2; the desktop's SettingsWindow props + SettingsController
// getters). Since 2026-09-29 Settings is a registered in-app window (r.windows id "settings", WindowHost/AppWindow — a
// browser can't open an OS window, docs/WEB-EXCEPTIONS.md), not a floating sheet: `open` mirrors the window being
// mounted (the window's own ✕ / Esc / Back close it too), openSettingsAt / closeSettings drive it through the bus.
import { create } from "zustand";
import { bus } from "@/core/bus";
import { endThemeSession } from "@/ui/themeStore";

/** The panes in rail order (SETTINGS-WINDOW.md §3). Keys are the public ids of `openSettings({ paneId })`. */
export type PaneId =
  | "profile"
  | "privacy"
  | "security"
  | "invites"
  | "guests"
  | "audio"
  | "calls"
  | "appearance"
  | "notifications"
  | "shortcuts"
  | "overlay"
  | "about";

/** (dev `?pane=N` indexes this list — new panes go at the end; the rail's order is paneMeta.ts PANE_META) */
export const PANE_IDS: PaneId[] = ["profile", "privacy", "security", "invites", "audio", "calls", "appearance", "notifications", "shortcuts", "overlay", "about", "guests"];

/** Old keys still accepted by openSettings (§3: `sessions` → `security`). */
export const PANE_ALIASES: Record<string, PaneId> = { sessions: "security" };

export const SETTINGS_WINDOW = "settings";

/** A pane key (or an old alias) → the pane; anything else → null. */
export function normalizePane(key: string | undefined | null): PaneId | null {
  if (!key) return null;
  if ((PANE_IDS as string[]).includes(key)) return key as PaneId;
  return PANE_ALIASES[key] ?? null;
}

export interface SettingsUi {
  open: boolean;
  pane: PaneId;
  /** phones: a pane is pushed over the pane list */
  mobilePane: boolean;
  /** the last `settings.status` line (shown 4 s) */
  status: string;
  statusSeq: number;
  /** a page inside the pane (Appearance → "Themes", THEMES-UI.md §4); null = the pane itself */
  subPage: "themes" | null;
  /** the search field's text ("" = the panes, anything else = the results) */
  query: string;
  /** the row a search result (or a deep link) jumped to: scrolled into view and flashed (§4); seq re-triggers */
  flash: { id: string; seq: number } | null;
  /** Profile's unsaved-changes bar is up: the status line shows inside it instead of the strip */
  saveBar: boolean;
  /** bumps on every open / raise so the window re-focuses its rail */
  openSeq: number;
}

export const useSettingsUi = create<SettingsUi>()(() => ({
  open: false,
  pane: "profile",
  mobilePane: false,
  status: "",
  statusSeq: 0,
  subPage: null,
  query: "",
  flash: null,
  saveBar: false,
  openSeq: 0,
}));

// Undo and an unanswered sound-pack offer of the theme screens end when the window opens or closes (THEMES-UI.md §3.2:
// Undo is for an apply made while Settings is open; §10.6) — the desktop's AppearancePane onOpened / onClosed.
useSettingsUi.subscribe((s, prev) => {
  if (prev.open !== s.open) endThemeSession();
});

let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** settings.status — shown for 4 s in the strip at the bottom of the content (SET-07). */
export function setStatus(msg: string): void {
  clearTimeout(statusTimer);
  useSettingsUi.setState((s) => ({ status: msg, statusSeq: s.statusSeq + 1 }));
  if (msg) statusTimer = setTimeout(() => useSettingsUi.setState({ status: "" }), 4000);
}

export function isErrorStatus(msg: string): boolean {
  return /fail|couldn|error|denied/i.test(msg);
}

/** openAt(pane): switch when open, else open on it; raises the window either way. No / unknown pane = the pane shown
 *  last (phones: the pane list). */
export function openSettingsAt(pane?: string): void {
  const p = normalizePane(pane);
  useSettingsUi.setState((s) => ({
    open: true,
    pane: p ?? s.pane,
    mobilePane: p ? true : s.open ? s.mobilePane : false,
    subPage: null,
    query: "",
    flash: null,
    openSeq: s.openSeq + 1,
  }));
  bus.emit("openWindow", { id: SETTINGS_WINDOW });
}

/** Jump to one row: its pane, the search cleared, the row scrolled into view (centre) and flashed (§4). */
export function jumpToSetting(id: string, pane: PaneId): void {
  useSettingsUi.setState((s) => ({
    pane,
    mobilePane: true,
    subPage: null,
    query: "",
    flash: { id, seq: (s.flash?.seq ?? 0) + 1 },
  }));
}

/** The ☰ Theme menu's "More themes…" (THEMES-UI §12): Settings → Appearance with the theme gallery open (§4) — a fresh
 *  gallery (no search, All, at the top: the page mounts anew). Phones: the Appearance pane pushed, the gallery on it. */
export function openThemeGallery(): void {
  useSettingsUi.setState((s) => ({ open: true, pane: "appearance", mobilePane: true, subPage: "themes", query: "", flash: null, openSeq: s.openSeq + 1 }));
  bus.emit("openWindow", { id: SETTINGS_WINDOW });
}

export function closeSettings(): void {
  useSettingsUi.setState({ open: false, mobilePane: false, subPage: null, query: "", saveBar: false, flash: null });
  bus.emit("closeWindow", { id: SETTINGS_WINDOW }); // a no-op when it isn't open
}

/** The window unmounted (its own ✕, Esc, Back, or closeSettings): the state follows. Only `open` (+ the save bar):
 *  a remount (React StrictMode in dev, a WindowHost re-render) must find the pane / pushed pane / search it had; the
 *  next openSettingsAt sets those anyway. */
export function settingsWindowClosed(): void {
  useSettingsUi.setState({ open: false, saveBar: false });
}
