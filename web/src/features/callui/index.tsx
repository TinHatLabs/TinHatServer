// features/callui — the call UI of Tin Hat Web (spec tw-spec/call-ui.md, prefix CUI).
//
// Shell contract (unchanged names):
//   CallStage({roomId, mobile})   the in-call panel of the room page (status bar, banners, tile grid,
//                                 control bar, call/chat seam; "fill the app" overlays the room page).
//                                 Also draws the join banner when no CallHeaderChips is mounted.
//   CallHeaderChips({roomId})     the "<a> is in a call · Join" banner (chat's RoomPage renders it
//                                 under the header).
// Also exported for other features: CallHeaderButton + CallHeaderGear (chat's RoomHeaderBar: the call
// button and the gear ▾, RoomHeaderBar.qml:227-248), NavCallStrip + useRoomCallLive + useLiveCallParts (nav's room
// row: the call participants under the row and the live-call dot, ThRoomList.qml:243, 470-600),
// ParticipantVolumeMenu (nav call strip right-click), openVoiceHud({preview}) / voiceHudAvailable() (Settings ›
// Overlay: the checkbox / "Preview (10 s)" call it inside their click — Document PiP needs the gesture), CallDevicesMenu
// + openCallDevicesMenu(anchor, roomId) (room header gear; or bus "openCallDevicesMenu"),
// IncomingCallCards + PipHost (registered as r.overlays here), useCallChrome(), useCallParticipants(roomId)
// (live MatrixRTC roster of a room), CallButton (the round call-bar button, for r.callBarItems).
// The engine is read only through "@/features/calls" (useCallStore) typed by its contract.
import type { FeatureModule } from "@/core/registry";
import { bus, toast } from "@/core/bus";
import { popupDepth } from "@/ui/overlay";
import { act, getC, setUiState, ui } from "./store";
import { installFakeCall } from "./fake";
import { IncomingCallCards, CallHeaderChips as Chips, useCallParticipants as useParts, joinBannerText as jbt } from "./Incoming";
import { PipHost, openPip as pip } from "./Pip";
import { CallEffects, openCallDevicesMenu as ocdm } from "./Effects";
import { CallStage as Stage, type CallStageProps as StageProps } from "./CallStage";
import { ParticipantVolumeMenu as PVM, DevicesMenu } from "./menus";
import { useChromeShown, useHoldChrome } from "./chrome";
import { CallHeaderButton as HeaderCall, CallHeaderGear as HeaderGear } from "./HeaderButtons";
import { VoiceHudHost } from "./VoiceHud";

export type CallStageProps = StageProps;
export const CallStage = Stage;
export const CallHeaderChips = Chips;
export const ParticipantVolumeMenu = PVM;
export const CallDevicesMenu = DevicesMenu;
export const openCallDevicesMenu = ocdm;
export const useCallChrome = useChromeShown;
/** Hold the call chrome (bar + tile buttons) visible while `open` — e.g. media's soundboard popover. */
export const useHoldCallChrome = useHoldChrome;
export const useCallParticipants = useParts;
export const joinBannerText = jbt;
export const openPip = pip;
export { IncomingCallCards, PipHost };
export { CallButton } from "./CallButton";
export { CallHeaderButton, CallHeaderGear } from "./HeaderButtons";
export { NavCallStrip, useRoomCallLive, useLiveCallParts, type CallPart } from "./NavStrip";
export { openVoiceHud, closeVoiceHud, voiceHudAvailable } from "./VoiceHud";

function callShown(): boolean {
  const c = getC();
  return !!(c.inCall || c.connecting || c.callFailed || c.reconnecting || c.fake || c.shown);
}

export const feature: FeatureModule = {
  id: "callui",
  setup(r) {
    installFakeCall();
    const offs = [
      r.overlays.add({ id: "callui-effects", order: 10, component: CallEffects }),
      r.overlays.add({ id: "callui-incoming", order: 900, component: IncomingCallCards }),
      r.overlays.add({ id: "callui-pip", order: 800, component: PipHost }),
      r.overlays.add({ id: "callui-voicehud", order: 810, component: VoiceHudHost }),
      // RoomHeaderBar.qml:227-248 — [Game reel][Calendar][Memories] · call · gear ▾ · [info]
      r.roomHeaderActions.add({ id: "callui-call", order: 70, component: HeaderCall }),
      r.roomHeaderActions.add({ id: "callui-gear", order: 80, component: HeaderGear }),
      // CUI-153: Ctrl+Shift+M — app-wide, only in a call; server-muted → toast instead
      r.shortcuts.add({
        id: "callui-mute",
        action: "call.mic.toggle",
        order: 10,
        keys: "Ctrl+Shift+M",
        whenTyping: true,
        description: "Mute / unmute the microphone (in a call)",
        enabled: () => getC().inCall,
        run: () => {
          const c = getC();
          if (c.serverMuted) toast(`${c.serverMutedBy || "A moderator"} muted your mic for everyone`, { timeoutMs: 3000 });
          else act("toggleMic")();
        },
      }),
      // CUI-154: Ctrl+Shift+D — deafen
      r.shortcuts.add({
        id: "callui-deafen",
        action: "call.deafen.toggle",
        order: 11,
        keys: "Ctrl+Shift+D",
        whenTyping: true,
        description: "Deafen / undeafen (in a call)",
        enabled: () => getC().inCall,
        run: () => act("applyDeafen")(!getC().deafened),
      }),
      // CUI-156: Esc leaves fill-the-app (not while a popover / menu / sheet is open); F11 toggles it
      r.shortcuts.add({
        id: "callui-escape",
        order: 12,
        keys: "Escape",
        description: "Leave “fill the app”",
        enabled: () => getC().maximized && popupDepth() === 0 && !ui().optsFace && !ui().streamPop && !ui().soundboardOpen,
        run: () => setUiState({ maximized: false }),
      }),
      r.shortcuts.add({
        id: "callui-f11",
        action: "call.fill.toggle",
        order: 13,
        keys: "F11",
        description: "Fill the app with the call",
        enabled: () => callShown(),
        run: () => setUiState({ maximized: !getC().maximized }),
      }),
    ];
    const offBus = bus.on("openPip", ({ tileId }) => {
      const t = getC().tiles.find((x) => x.id === tileId);
      if (t) pip(t);
    });
    return () => {
      offs.forEach((f) => f());
      offBus();
    };
  },
};
