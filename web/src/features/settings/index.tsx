// features/settings — the Settings window and everything account-side (settings-account.md, SET-*;
// SETTINGS-WINDOW.md since 2026-09-29: Settings is its own window, not a floating sheet).
//
// Shell contract: `SettingsSheet` (= SettingsHost, always mounted by the shell: the bus entry points — `openSettings`
// ({paneId?}, Ctrl+ , which the shell registers), `openAbout`, `openThemeGallery`, `editCurrentTheme`,
// `closeSettings`). The window itself is `r.windows` "settings" (SettingsWindow.tsx). Everything else plugs in through
// the registry:
//   r.settingsPanes  profile · privacy · security (Devices & security; old id `sessions`) · invites (operators only) ·
//                    audio · calls · appearance · notifications · overlay · about (About & help) — ids =
//                    openSettings(paneId); shortcuts is features/actions'. Rail groups / labels / descriptions:
//                    paneMeta.ts
//   r.appMenu        settings(50) · verify(100) · shortcuts(110) · iconGallery(130) · about(140) ·
//                    signOut(150)   (nav dedupes per order; the update row (90) + updater are the nav's)
//   r.timelineRenderers  theme share cards (THEMES-UI.md §14)
//   r.overlays       the theme editor panel + Pick, the Try bar (THEMES-UI.md §13-§15),
//                    VerifyDeviceDialog host, Report a problem /
//                    Sign out confirm / log-sharing consent / Noise test (the incoming-call desktop
//                    alert is the calls engine's — callwatch.ts, INTEGRATION #8; it honours notify.calls)
//   r.windows        settings (the Settings window) · iconGallery
//   r.onReady        notification engine, quiet push rules, invite-operator probe, log shipping,
//                    ?pane= / ?settings=tour dev hooks
// Bus (additive, CORE-CHANGES.md): openVerifyDialog, openBugReport, openAbout, openShortcuts,
// requestSignOut, openNoiseTest, openWhatsNew.
import type { FeatureModule } from "@/core/registry";
import { bus, openWindow } from "@/core/bus";
import { getFormFactor } from "@/core/device";
import { getCryptoStatus, useVerificationStore } from "@/core/matrix";
import { SettingsWindow } from "./SettingsWindow";
import { PANE_IDS, SETTINGS_WINDOW, openSettingsAt } from "./store";
import { ProfilePane, resetProfileDrafts } from "./panes/ProfilePane";
import { AppearancePane } from "./panes/AppearancePane";
import { AudioPane } from "./panes/AudioPane";
import { CallsPane } from "./panes/CallsPane";
import { NotificationsPane } from "./panes/NotificationsPane";
import { SecurityPane } from "./panes/SecurityPane";
import { AboutPane } from "./panes/AboutPane";
import { PrivacyPane } from "./panes/PrivacyPane";
import { OverlayPane } from "./panes/OverlayPane";
import { InvitesPane } from "./panes/InvitesPane";
import { VerifyDeviceHost, resetVerifyDialog } from "./VerifyDeviceDialog";
import { OverlayBoundary } from "@/ui";
import { SettingsSheets } from "./sheets";
import { IconGallery } from "./IconGallery";
import { startNotifyEngine } from "./notify";
import { ensureQuietRules } from "./quietrules";
import { probeOperator, resetInvites, useInvites } from "./invites";
import { resetProfile } from "./profile";
import { shipPreviousLog, startLogPersistence, wipeLogStore } from "./logs";
import { installThemeSync } from "./themeSync";
import { ThemeEditorHost } from "./themes/editor/ThemeEditor";
import { cancel as closeThemeEditor } from "./themes/editor/editorStore";
import { ThemeShareCard, hasShareMarker } from "./themes/share/ShareCard";
import { TryBar } from "./themes/share/TryBar";

/** The shell mounts `SettingsSheet` (ARCHITECTURE "Shell"): since the window it is the bus host (SettingsHost). */
export { SettingsHost as SettingsSheet } from "./SettingsHost";
export { VerifyDeviceDialog, openVerifyDialog } from "./VerifyDeviceDialog";
export { fetchProfileCard, getExtField, EXT_ACCENT, EXT_BIO, EXT_JOINSOUND, type ProfileCard } from "./profile";
export { notifyDesktop, setAttending, requestNotificationPermission } from "./notify";
export { openSettingsAt, closeSettings } from "./store";
export {
  fmtClock,
  clockMode,
  useClockMode,
  useTheme,
  useNavMode,
  useReduceMotion,
  useRecordOptout,
  recordOptout,
  notifyCallsOn,
  useOverlayPrefs,
  openSettings,
  openVerify,
  openShortcuts,
  openAboutSheet as openAbout,
  openReportDialog as openBugReport,
  openNoiseTest,
  openIconGallery,
  type ClockMode,
} from "./prefs";
export { signOut } from "./sheets";
export { LevelMeter } from "./LevelMeter";
export { SHORTCUT_ROWS, isOnboardingBusy } from "./sheets";
export { playUiSound, previewSound, startRing, stopRing, playCallChime, sndVolume } from "@/core/sounds";

const dev = (() => {
  try {
    return /[?&]dev=1\b/.test(location.search + location.hash);
  } catch {
    return false;
  }
})();

function SettingsOverlays() {
  return (
    <>
      {/* W1: a broken verify sheet closes itself (state reset, toast) — it no longer takes the app down */}
      <OverlayBoundary name="verify" onReset={resetVerifyDialog}>
        <VerifyDeviceHost />
      </OverlayBoundary>
      <SettingsSheets />
      {/* THEMES-UI.md §13-§15: the theme editor panel (+ Pick), the share cards' Try bar */}
      <OverlayBoundary name="theme-editor" onReset={() => closeThemeEditor(true)}>
        <ThemeEditorHost />
      </OverlayBoundary>
      <TryBar />
    </>
  );
}

function devHooks() {
  const q = new URLSearchParams(location.search || location.hash.split("?")[1] || "");
  const pane = q.get("pane");
  if (pane !== null) {
    const n = Number(pane);
    const id = Number.isInteger(n) ? PANE_IDS[n] : pane;
    setTimeout(() => openSettingsAt(id), 3500);
  }
  if (q.get("settings") === "tour") {
    let i = 0;
    openSettingsAt(PANE_IDS[0]);
    const t = setInterval(() => {
      i = (i + 1) % PANE_IDS.length;
      openSettingsAt(PANE_IDS[i]);
    }, 4000);
    bus.once("loggedOut", () => clearInterval(t));
  }
  if (q.get("icongallery") === "1") openWindow("iconGallery");
}

export const feature: FeatureModule = {
  id: "settings",
  setup(r) {
    // test hook (dev builds / webshot): emit bus events from Playwright steps
    if (import.meta.env.DEV || (window as unknown as { __TW_DEBUG__?: boolean }).__TW_DEBUG__) {
      (window as unknown as { __twBus?: typeof bus }).__twBus = bus;
      // QA: pin a verification state for screenshots (no crypto happens)
      (window as unknown as { __twVerify?: unknown }).__twVerify = (p: Record<string, unknown>) => useVerificationStore.setState(p as never);
    }
    // THEMES-SYNC.md: the account-data side of the theme store (dev.tinhat.theme / dev.tinhat.themes)
    installThemeSync();
    // SETTINGS-WINDOW.md §3: rail order = these orders (shortcuts, features/actions', sits at 85); groups, labels and
    // descriptions come from paneMeta.ts
    const panes = [
      { id: "profile", title: "Profile", icon: "user-symbolic", component: ProfilePane, order: 0 },
      { id: "privacy", title: "Privacy", icon: "view-private-symbolic", component: PrivacyPane, order: 10 },
      { id: "security", title: "Devices & security", icon: "security-high-symbolic", component: SecurityPane, order: 20 },
      { id: "audio", title: "Audio", icon: "audio-volume-high-symbolic", component: AudioPane, order: 40 },
      { id: "calls", title: "Calls & video", icon: "call-start-symbolic", component: CallsPane, order: 50 },
      { id: "appearance", title: "Appearance", icon: "contrast-symbolic", component: AppearancePane, order: 60 },
      { id: "notifications", title: "Notifications", icon: "notifications", component: NotificationsPane, order: 70 },
      // not on a phone: an always-on-top window over a game is a computer thing (iPhone/iPad sweep, 2026-10-25)
      { id: "overlay", title: "Overlay", icon: "window-pin-symbolic", component: OverlayPane, order: 90, visible: () => getFormFactor() !== "mobile" },
      { id: "about", title: "About & help", icon: "help-about-symbolic", component: AboutPane, order: 100 },
    ];
    panes.forEach((p) => r.settingsPanes.add(p));
    r.settingsPanes.add({
      id: "invites",
      title: "Invites",
      icon: "contact-new-symbolic",
      order: 30,
      component: InvitesPane,
      visible: () => useInvites.getState().operator,
    });

    // the Settings window (SETTINGS-WINDOW.md §2): 1000×720, min 760×540, one instance; phones draw their own header
    // (pane list → pane → back)
    r.windows.add({
      id: SETTINGS_WINDOW,
      order: 40,
      title: "Settings",
      component: SettingsWindow,
      defaultSize: { width: 1000, height: 720 },
      minSize: { width: 760, height: 540 },
      singleton: true,
      phoneHeader: false,
    });

    r.appMenu.add({ id: "settings", order: 50, label: "Settings…", icon: "settings-configure", run: () => bus.emit("openSettings", {}) });
    r.appMenu.add({
      id: "iconGallery",
      order: 130,
      label: "Icon gallery",
      icon: "preferences-desktop-color",
      visible: () => dev,
      run: () => openWindow("iconGallery"),
    });
    r.appMenu.add({ id: "about", order: 140, label: "About Tin Hat", icon: "help-about-symbolic", run: () => bus.emit("openAbout", {}) });
    r.appMenu.add({ id: "signOut", order: 150, label: "Sign out", icon: "system-log-out-symbolic", run: () => bus.emit("requestSignOut", {}) });

    r.windows.add({
      id: "iconGallery",
      order: 0,
      title: "Icon gallery — Tin Hat",
      icon: "preferences-desktop-color",
      component: IconGallery,
      defaultSize: { width: 1000, height: 720 },
      minSize: { width: 640, height: 420 },
    });

    r.overlays.add({ id: "settings-overlays", order: 50, component: SettingsOverlays });
    // THEMES-UI.md §14: a theme shared in a room arrives as a card (Try / Keep); other apps show its body line
    r.timelineRenderers.add({ id: "theme-share-card", order: 12, eventTypes: ["m.room.message"], match: hasShareMarker, component: ThemeShareCard });

    r.onReady.add({ id: "settings-notify", order: 10, run: () => startNotifyEngine() });
    r.onReady.add({ id: "settings-quietrules", order: 20, run: () => void ensureQuietRules() });
    r.onReady.add({ id: "settings-invites", order: 30, run: () => void probeOperator() });
    r.onReady.add({
      id: "settings-logs",
      order: 40,
      run: async () => {
        await startLogPersistence();
        void shipPreviousLog();
      },
    });
    r.onReady.add({ id: "settings-dev", order: 60, run: () => devHooks() });

    bus.on("loggedOut", () => {
      resetProfile();
      resetProfileDrafts();
      resetInvites();
      wipeLogStore();
    });
  },
};
