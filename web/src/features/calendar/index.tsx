// features/calendar — the space calendar + the Game Reel (Tin Hat 10.5.0 CalendarWindow,
// CalendarCard, GameReelWindow/Panel, TierList, MyGamesEditor, GameNightAdmin, ReelButton,
// ReelCover; calendar.rs, games.rs, games_model.rs). Spec: tw-spec/calendar-games.md (CAL-*).
//
// Contributions (registry only — the shell never imports this folder):
//   r.windows            "calendar" (1140×780, min 900×600) · "gameReel" (980×760, min 640×480)
//   r.roomHeaderActions  next-up chip (5) · Game Reel button (10) · Calendar button (20)
//   r.timelineRenderers  CalendarCard for m.room.message carrying `dev.tinhat.calendar`
//   r.appMenu            "What do we play tonight?" (40)
//   r.spaceMenu          "Open the space calendar" (50) — hosted by nav (its fallback row yields to ours)
//   r.shortcuts          Ctrl+Shift+E — Calendar
//   r.overlays           CalendarRoot (follows the current room + the call's participants)
//   r.onReady            reminder loop (25 s, then every 60 s)
// Public API for other features: openCalendar / openGameReel (entry.ts), useCalendarUpcoming,
// useCalendarEvent, the pure games model (model/games.ts).
import type { FeatureModule } from "@/core/registry";
import { getFormFactor } from "@/core/device";
import { CalendarWindow } from "./ui/CalendarWindow";
import { GameReelWindow } from "./ui/GameReelWindow";
import { CalendarButton, GameReelButton, NextUpChip } from "./ui/HeaderActions";
import { CalendarCard, hasCardMarker } from "./ui/CalendarCard";
import { CalendarRoot } from "./CalendarRoot";
import { CAL_WINDOW, REEL_WINDOW, openCalendar, openGameReel } from "./entry";
import { startReminders } from "./reminders";

export { openCalendar, openGameReel, openGameReelFor } from "./entry";
export { useCalendarUpcoming, useCalendarEvent } from "./calendarStore";
// widgets (Up next) — ADDITIVE: every space's events, RSVP into any container, the game's art
export { buildSnapshot, mineOf, rsvp, startNew, useCal } from "./calendarStore";
export { EVENT_TYPE, RSVP_TYPE, GAME_TYPE, type CalEvent, type Person } from "./model/calendar";
export { artUrl } from "./model/reel";
export { CATALOG_BASE } from "./gamesStore";
export { CalendarCard } from "./ui/CalendarCard";
export { setPresent as setReelPresence } from "./gamesStore";
export { myCredit } from "./gamesStore"; // widgets W2: Game night shows your Reel credit

export const feature: FeatureModule = {
  id: "calendar",
  setup(r) {
    r.windows.add({
      id: CAL_WINDOW,
      order: 0,
      // "Calendar · <container label> — Tin Hat" — never exactly "Tin Hat" (CAL-10)
      // (phones: the sheet header has no room for the app suffix)
      title: (p) => "Calendar" + (typeof p.label === "string" && p.label ? " · " + p.label : "") + (getFormFactor() === "mobile" ? "" : " — Tin Hat"),
      icon: "view-calendar-symbolic",
      component: CalendarWindow,
      defaultSize: { width: 1140, height: 780 },
      minSize: { width: 900, height: 600 },
    });
    r.windows.add({
      id: REEL_WINDOW,
      order: 0,
      title: () => (getFormFactor() === "mobile" ? "What do we play tonight?" : "What do we play tonight? — Tin Hat"),
      icon: "applications-games-symbolic",
      component: GameReelWindow,
      defaultSize: { width: 980, height: 760 },
      minSize: { width: 640, height: 480 },
    });
    r.roomHeaderActions.add({ id: "calendar-next-up", order: 5, component: NextUpChip });
    r.roomHeaderActions.add({ id: "game-reel", order: 10, component: GameReelButton });
    r.roomHeaderActions.add({ id: "calendar", order: 20, component: CalendarButton });
    r.timelineRenderers.add({ id: "calendar-card", order: 10, eventTypes: ["m.room.message"], match: hasCardMarker, component: CalendarCard });
    // Space context menu (nav hosts r.spaceMenu; its own order-50 fallback row yields to this one)
    r.spaceMenu.add({
      id: "space-calendar",
      order: 50,
      label: "Open the space calendar",
      icon: "view-calendar-symbolic",
      run: (ctx) => openCalendar({ containerId: ctx.spaceId }),
    });
    r.shortcuts.add({ id: "calendar", action: "calendar.open", order: 0, keys: "Ctrl+Shift+E", description: "Calendar", whenTyping: true, run: () => openCalendar() });
    r.overlays.add({ id: "calendar-root", order: 0, component: CalendarRoot });
    r.onReady.add({ id: "calendar-reminders", order: 50, run: () => startReminders() });
  },
};
