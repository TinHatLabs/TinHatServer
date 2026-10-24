// paneMeta.ts — the Settings window's rail: groups, pane order, labels, icons and the one-line descriptions shown under
// each pane's title (SETTINGS-WINDOW.md §3 — the same table as the desktop's SettingsWindow.qml). The components come
// from the registry (r.settingsPanes); a contributed pane this table doesn't know goes to the end of APP.
import type { PaneId } from "./store";

export interface PaneMeta {
  key: PaneId;
  label: string;
  icon: string;
  description: string;
  group: GroupId;
}

export type GroupId = "account" | "voice" | "app" | "tinhat";

export const GROUPS: ReadonlyArray<{ id: GroupId; label: string }> = [
  { id: "account", label: "Account" },
  { id: "voice", label: "Voice & video" },
  { id: "app", label: "App" },
  { id: "tinhat", label: "Tin Hat" },
];

export const PANE_META: ReadonlyArray<PaneMeta> = [
  { key: "profile", group: "account", label: "Profile", icon: "user-symbolic", description: "Your name, photo, colour and join sound" },
  { key: "privacy", group: "account", label: "Privacy", icon: "view-private-symbolic", description: "Your status, time zone, recordings and logs" },
  { key: "security", group: "account", label: "Devices & security", icon: "security-high-symbolic", description: "Where you're signed in, verification and key backup" },
  { key: "invites", group: "account", label: "Invites", icon: "contact-new-symbolic", description: "Invite codes for new accounts" },
  // the guest room (docs/GUESTS.md; features/guests registers it in self-hosted builds only)
  { key: "guests", group: "account", label: "Guests", icon: "system-users-symbolic", description: "Let people in for a while without an account" },
  { key: "audio", group: "voice", label: "Audio", icon: "audio-volume-high-symbolic", description: "Microphone, speaker, echo and noise" },
  { key: "calls", group: "voice", label: "Calls & video", icon: "call-start-symbolic", description: "Push to talk, camera, screen share and connection" },
  { key: "appearance", group: "app", label: "Appearance", icon: "contrast-symbolic", description: "Theme, sounds, navigation and motion" },
  { key: "notifications", group: "app", label: "Notifications", icon: "notifications", description: "Desktop alerts and sounds" },
  { key: "shortcuts", group: "app", label: "Shortcuts", icon: "input-keyboard-symbolic", description: "Give any action a key" },
  { key: "overlay", group: "app", label: "Overlay", icon: "window-pin-symbolic", description: "See who's talking over fullscreen games" },
  { key: "about", group: "tinhat", label: "About & help", icon: "help-about-symbolic", description: "Version, updates, help and sign out" },
];

export const paneMeta = (key: string): PaneMeta | undefined => PANE_META.find((p) => p.key === key);
