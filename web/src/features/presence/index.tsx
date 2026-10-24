// features/presence — REACH §2 + A1–A4: opt-in presence (Online / Away / In a call) and the custom status.
// Off by default; the consent is the account data dev.tinhat.presence, written only by a person.
// A7 (2026-09-28): the time zone for Friends' clocks is separate and opt-OUT (tz.ts, dev.tinhat.presence_tz).
//
//   runtime.ts   store, sender (PUT beats), reader (GET map), off switch (DELETE until 204), user actions
//   machine.ts   the timer-driven senders (presence §2.4/A2.13, activity §3.4/A2.12) — pure, unit-tested
//   model.ts     the pure rules mirrored by the desktop's presence_model.rs (same test names)
//   status.ts    presets, palette, statusView (A4.5, same test names as the desktop)
//   ui.tsx       usePresence, the dot, the chip, the profile line
//   controls.tsx Settings → Privacy "Your status" + "Time zone", the footer popover + picker, the one-time card
//   tz.ts        A7: the time zone's account data (first-run write, automatic zone, the switch, the picker)
//
// Other features read it through this index: nav (strip + DM rows + footer), spaces (member list,
// profile cards), settings (Privacy pane), push (activity pings reuse the input/visibility wiring).
import type { FeatureModule } from "@/core/registry";
import { installPresence, presenceDebug, presenceSimulateIdle, readNow, setMyStatus, turnSharingOff, turnSharingOn, usePresenceStore } from "./runtime";
import { installTz, pickTz, setTzShare, tzCheck, useTzStore } from "./tz";

export { usePresence, useMyPresence, avatarDot, PresenceDot, StatusChip, PresenceLine, presenceLabel, viewOf, hexA, CALL_GLYPH } from "./ui";
export { YourStatusSection, StatusPopover, MyStatusLine, ShareSwitch, SeenAsLine, TimeZoneSection, useStatusQuestionVisible, QUESTION as STATUS_QUESTION } from "./controls";
export { usePresenceStore, readNow, turnSharingOn, turnSharingOff, setMyStatus, wantZones, answerQuestion, type PresenceRow } from "./runtime";
export { useTzStore, setTzShare, pickTz, deviceZone } from "./tz";
export { statusView, stateWord, STATUS_PRESETS, STATUS_PALETTE, PRESENCE_ONLINE, PRESENCE_AWAY, PRESENCE_INCALL, type PresenceState, type CustomStatus } from "./status";

export const feature: FeatureModule = {
  id: "presence",
  setup() {
    installPresence();
    installTz();
    if (import.meta.env.DEV || (window as unknown as { __TW_DEBUG__?: boolean }).__TW_DEBUG__)
      (window as unknown as { __twPresence?: unknown }).__twPresence = { presenceDebug, presenceSimulateIdle, usePresenceStore, readNow, turnSharingOn, turnSharingOff, setMyStatus, useTzStore, setTzShare, pickTz, tzCheck };
  },
};
