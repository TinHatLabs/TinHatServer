// joinsound.ts — join sounds (native joinsound.rs) + the self-audible preview player.
//
// onCallJoined(roomId) — detached, never delays being in the call:
//   url = my profile field dev.tinhat.joinsound ("" when 404)
//   enabled = room state dev.tinhat.joinsounds "" .enabled ?? true
//   skip when blank / room opted out / < 60 s since my last one (per page lifetime)
//   engine.playSound(url) ("sound" track = receivers' Soundboard dial), hard cut at 3000 ms.
// "a join sound nobody can turn down is a griefing tool" — it MUST ride the sound track.
import { useSyncExternalStore } from "react";
import { getState, JOINSOUNDS_ROOM_TYPE } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { toast } from "@/core/bus";
import { FOREIGN_SOUND_NOTE, clipUrlFor } from "../shared/clip";
import { playClip, stopClip } from "@/core/sounds";
import { callRoomOf, enginePlaySound, engineStopSound, engineHandlesJoinSound, isInCall, onCallChange } from "../shared/call";
import { fetchJoinSound } from "./data";

const log = createLogger("joinsound");
const COOLDOWN_MS = 60_000;
const CAP_MS = 3000;
let lastPlayed = 0;
let capTimer = 0;

export async function playJoinSound(roomId: string): Promise<string> {
  const url = (await fetchJoinSound()).trim();
  if (!url) return "no join sound set";
  const room = getState(roomId, JOINSOUNDS_ROOM_TYPE, "");
  if (room && room.enabled === false) return "join sounds are off in this room";
  if (lastPlayed && Date.now() - lastPlayed < COOLDOWN_MS) return "cooldown: rejoined too soon";
  lastPlayed = Date.now();
  window.clearTimeout(capTimer);
  capTimer = window.setTimeout(() => engineStopSound(), CAP_MS);
  if (!(await enginePlaySound(url, CAP_MS))) {
    window.clearTimeout(capTimer);
    return "not in a call";
  }
  return "";
}

/** Watches the call store: false → true `inCall` fires the join sound (unless the engine owns it). */
export function installJoinSoundTrigger(): () => void {
  return onCallChange((c, prev) => {
    if (!isInCall(c) || isInCall(prev)) return;
    if (engineHandlesJoinSound()) return;
    const roomId = callRoomOf(c);
    if (!roomId) return;
    void playJoinSound(roomId).then((why) => {
      if (why) log.info(`join sound skipped: ${why}`);
    });
  });
}

// ---- preview (self-audible, via the clip cache) -----------------------------------------------

// REACH A5.8: through the one Web Audio context (core/sounds playClip, the "preview" channel) — an <audio>
// element is media playback on iOS (Now Playing, the Dynamic Island).
let previewUrl = "";
const previewSubs = new Set<() => void>();
const emit = () => previewSubs.forEach((f) => f());

export function togglePreview(url: string): void {
  if (!url) return;
  if (previewUrl === url) {
    stopPreview();
    return;
  }
  stopClip("preview");
  previewUrl = url;
  emit();
  const clear = () => {
    if (previewUrl !== url) return;
    previewUrl = "";
    emit();
  };
  const src = clipUrlFor(url);
  if (!src) {
    toast(FOREIGN_SOUND_NOTE);
    clear();
    return;
  }
  void playClip(src, { channel: "preview", onEnded: clear }).then((h) => {
    if (!h) clear();
    else if (previewUrl !== url) h.stop();
  });
}

export function stopPreview(): void {
  stopClip("preview");
  previewUrl = "";
  emit();
}

/** React: the url being previewed ("" = none) + toggle/stop. */
export function useSoundPreview(): { playingUrl: string; toggle: (url: string) => void; stop: () => void } {
  const playingUrl = useSyncExternalStore(
    (cb) => {
      previewSubs.add(cb);
      return () => previewSubs.delete(cb);
    },
    () => previewUrl,
  );
  return { playingUrl, toggle: togglePreview, stop: stopPreview };
}
