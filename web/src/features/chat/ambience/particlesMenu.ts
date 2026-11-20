// particlesMenu.ts — the ☰ app menu's "Particles" submenu (round 4, P-A7; the desktop's Main.qml particlesMenu): the
// current room's effect (the Chat background sheet's own write: core.particlesPick), "Chat background…", then the two
// personal switches of Settings → Appearance → Performance (the SAME stored prefs) and "Effects settings…". The rows
// themselves come from the shared core.particlesMenu (testvectors/ambience/vectors.json particles_menu).
// Phones (12.1.17): the ☰ menu lives on the room list, where no room is open, so the rows are about the last room you
// opened (particlesRoom.ts), under its name.
import { toast } from "@/core/bus";
import { peekClient } from "@/core/matrix";
import { getPref, getPrefRaw, setPref } from "@/core/prefs";
import { UNFOCUSED_SAVER_PREF, unfocusedSaverOn } from "@/core/lowgpu";
import type { MenuSubItem } from "@/core/registry";
import { getCurrentRoom } from "@/features/nav/open";
import { jumpToSetting, openSettingsAt } from "@/features/settings/store";
import { BACKGROUND_STATE, PREF_BACKGROUNDS, PREF_DEFAULTS, PREF_EFFECTS, PREF_PAUSE_UNFOCUSED, parseBackground, particlesMenu, particlesWrite, prefOn, type Effect, type ParticlesMenuIn } from "./core";
import { openBackgroundSheet } from "./BackgroundSheet";
import { canSetBackground, setRoomBackground } from "./room";
import { AMBIENCE_WORDS as AW } from "./words";
import { particlesLabel } from "./particlesWords";
import { particlesRoomFor } from "./particlesRoom";

/** "Effects settings…": Settings → Appearance at the Performance section (both apps: the section's indexed row). */
export const PERFORMANCE_ROW = "appearance.gpu-saver";

/** The room the rows are about: the open room; on a phone (no room is open on the list) the last room opened. */
export function particlesRoomId(): string {
  const phone = typeof document !== "undefined" && document.documentElement.dataset.ff === "mobile";
  return particlesRoomFor(getCurrentRoom(), String(getPref("last-room", "")), phone);
}

/** The menu's inputs, read now (the menu builds its rows when it opens). */
export function particlesMenuInput(): ParticlesMenuIn {
  const c = peekClient();
  const roomId = particlesRoomId();
  const room = roomId ? c?.getRoom(roomId) : null;
  const joined = !!room && room.getMyMembership() === "join";
  const ev = joined ? room!.currentState.getStateEvents(BACKGROUND_STATE, "") : null;
  return {
    room: joined,
    bg: parseBackground(ev ? ev.getContent() : null, ev?.getSender() ?? ""),
    canChange: joined && canSetBackground(roomId),
    me: c?.getUserId() ?? "",
    backgrounds: prefOn(getPrefRaw(PREF_BACKGROUNDS), PREF_DEFAULTS[PREF_BACKGROUNDS]),
    effects: prefOn(getPrefRaw(PREF_EFFECTS), PREF_DEFAULTS[PREF_EFFECTS]),
    pauseUnfocused: prefOn(getPrefRaw(PREF_PAUSE_UNFOCUSED), PREF_DEFAULTS[PREF_PAUSE_UNFOCUSED]),
    saver: unfocusedSaverOn(getPrefRaw(UNFOCUSED_SAVER_PREF)),
  };
}

export function particlesSubmenu(input: ParticlesMenuIn = particlesMenuInput()): MenuSubItem[] {
  const roomId = particlesRoomId();
  // a room that isn't on screen (the phone's room list): its name heads its rows, so it's clear whose effect this is
  const heading = input.room && roomId && roomId !== getCurrentRoom() ? (peekClient()?.getRoom(roomId)?.name ?? "") : "";
  return particlesMenu(input).map((r, i) => ({
    id: r.id,
    label: particlesLabel(r.id),
    ...(heading && i === 0 ? { section: heading } : {}),
    ...(r.id.startsWith("note:") ? { note: true } : {}),
    ...(r.checked !== null ? { checked: r.checked } : {}),
    enabled: r.enabled,
    separatorBefore: r.sep,
    run: () => {
      if (!r.enabled) return;
      if (r.id.startsWith("effect:")) {
        // the room as it is NOW (someone may have changed its background, or my power, while the menu was open); the
        // one write of this menu, and only what particlesWrite allows (null = nothing is sent)
        if (particlesRoomId() !== roomId) return;
        const content = particlesWrite(particlesMenuInput(), r.id.slice(7) as Effect);
        if (content) void setRoomBackground(roomId, content).catch(() => toast(AW.setFailed));
      } else if (r.id === "background") openBackgroundSheet(roomId);
      else if (r.id === "effects") setPref(PREF_EFFECTS, r.checked ? "0" : "1");
      else if (r.id === "pause") setPref(PREF_PAUSE_UNFOCUSED, r.checked ? "0" : "1");
      else if (r.id === "settings") {
        openSettingsAt("appearance");
        jumpToSetting(PERFORMANCE_ROW, "appearance");
      }
    },
  }));
}
