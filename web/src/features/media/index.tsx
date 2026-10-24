// features/media — Soundboard, join sounds, Watch party, Memories, Rec / Clip / REC cue,
// guest-call marker, music into the call. Spec: tw-spec/media.md (MED-*). Status: STATUS.md.
//
// Contributions (all inside setup): see the `setup` body. Public surface below — other features
// may import these by name (settings: JoinSoundSection / useJoinSound; callui: isSoundboardOpen …).
import type { FeatureModule } from "@/core/registry";
import { serverFeatureOn } from "@/core/server";
import { CallBridge } from "./shared/call";
import { SoundboardHost } from "./soundboard/SoundboardPopover";
import { SoundboardButton, SoundboardComposerButton, SoundboardNowPlayingPill } from "./soundboard/CallBarPieces";
import { openSoundboard, stopCurrent, useSoundboard } from "./soundboard/store";
import { installJoinSoundTrigger } from "./soundboard/joinsound";
import { MediaDevHooks } from "./devhooks";
import { registerWatchParty } from "./watchparty";
import { registerMemories } from "./memories";
import { registerRecord } from "./record";
import { JoinSoundDev } from "./soundboard/JoinSoundSection";

// ---- public surface ------------------------------------------------------------------------------
export { clipUrlFor } from "./shared/clip";
export { openSoundboard, closeSoundboard, toggleSoundboard, stopCurrent as stopSoundboardSound, useSoundboard, toggleSound } from "./soundboard/store";
export { PERSONAL_TYPE } from "./soundboard/data"; // widgets W2: the Soundboard pad reads the favourites
export { SoundboardButton, SoundboardNowPlayingPill, SoundboardComposerButton } from "./soundboard/CallBarPieces";
export { usePersonalSounds, addPersonalSound, searchSounds, fetchJoinSound, saveJoinSound } from "./soundboard/data";
export { useSoundPreview, playJoinSound } from "./soundboard/joinsound";
export { JoinSoundSection, useJoinSound } from "./soundboard/JoinSoundSection";
export { openWatchParty, WatchPartyBanner, useWatchParty, watchPartyOn, useWatchPartyOn } from "./watchparty";
export { MediaPartyButton, MediaPartyPhoneStrip, useCallParty } from "./watchparty/CallBarPieces";
export { addLink, addLinkToParty, type AddOutcome } from "./watchparty/add"; // chat's embed cards (Media Party 11.4)
export { openMemories, MemoriesHeaderButton } from "./memories";
export { fetchSessions, thumbUrl, type VodSession } from "./memories/model"; // widgets W2: the Memories widget
export {
  RecButton,
  ClipButton,
  RecCue,
  setRecordCall,
  clipMoment,
  openRecordConfirm,
  openMusicUrlPrompt,
  startMusic,
  pickMusicFile,
} from "./record";
export { playIntoCall } from "./soundboard/store";

/**
 * callui: the soundboard popover is open (keep the call chrome visible; it takes Esc first).
 * Integration: `onSoundboardOpenChange(open => ui().set({ soundboardOpen: open }))`.
 */
export function onSoundboardOpenChange(cb: (open: boolean) => void): () => void {
  return useSoundboard.subscribe((st, prev) => {
    if (st.open !== prev.open) cb(st.open);
  });
}
export function isSoundboardOpen(): boolean {
  return useSoundboard.getState().open;
}
export function useSoundboardOpen(): boolean {
  return useSoundboard((s) => s.open);
}

export const feature: FeatureModule = {
  id: "media",
  setup(r) {
    const offs: Array<() => void> = [];
    // always-mounted pieces
    offs.push(r.overlays.add({ id: "media-call-bridge", order: 0, component: CallBridge }));
    offs.push(r.overlays.add({ id: "media-soundboard", order: 50, component: SoundboardHost }));
    offs.push(r.overlays.add({ id: "media-devhooks", order: 99, component: MediaDevHooks }));

    // soundboard entry points (MED-01..03, MED-40)
    // call bar (callui "controls" slot, native order: … stream audio 60, health 70, soundboard 80,
    // now-playing pill 85, game 90 …; callui's phone bar picks the item with 75 <= order < 85)
    offs.push(r.callBarItems.add({ id: "media-soundboard", order: 80, side: "center", component: SoundboardButton }));
    offs.push(r.callBarItems.add({ id: "media-sound-playing", order: 85, side: "center", component: SoundboardNowPlayingPill }));
    offs.push(r.composerActions.add({ id: "media-soundboard", order: 30, component: SoundboardComposerButton }));
    offs.push(
      r.shortcuts.add({
        id: "media-soundboard",
        action: "soundboard.open",
        order: 0,
        keys: "Ctrl+Shift+S",
        whenTyping: true,
        description: "Soundboard",
        run: () => {
          if (!serverFeatureOn("soundboard")) return false; // selfhost/firstrun item 1: no soundboard on this server
          openSoundboard();
          return true;
        },
      }),
    );

    // join sounds (MED-53/54): the calls engine publishes them; this fallback only runs when
    // features/calls exports joinSoundHandledByEngine = false
    let joinOff: (() => void) | null = null;
    offs.push(
      r.onReady.add({
        id: "media-joinsound",
        order: 0,
        run: () => {
          joinOff?.();
          joinOff = installJoinSoundTrigger();
        },
      }),
    );

    // dev/QA host for the settings-owned join-sound block (?joinsound=1)
    offs.push(
      r.windows.add({
        id: "media-joinsound-dev",
        order: 99,
        title: "Join sound (dev preview)",
        icon: "audio-speakers-symbolic",
        component: JoinSoundDev,
        defaultSize: { width: 560, height: 520 },
      }),
    );

    registerWatchParty(r, offs);
    registerMemories(r, offs);
    registerRecord(r, offs);

    // MED-08: leaving the page stops a playing sound (and its call track) first
    const onHide = () => stopCurrent();
    window.addEventListener("pagehide", onHide);
    offs.push(() => window.removeEventListener("pagehide", onHide));

    return () => {
      joinOff?.();
      for (const off of offs) off();
    };
  },
};
