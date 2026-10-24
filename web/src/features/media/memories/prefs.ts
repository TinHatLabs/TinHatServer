// memories/prefs.ts — clip bookmarks of a room + the transport prefs the native keeps across
// restarts (memories-volume / memories-muted / memories-resume, 800 ms debounced).
import { useMemo } from "react";
import { CLIP_TYPE, useRoomStateEvents } from "@/core/matrix";
import { getBlob, getPref, setBlob, setPref } from "@/core/prefs";

export interface Clip {
  at: number;
  by: string;
}

/** Clip bookmarks of a room (state `dev.tinhat.clip`, `{at}`, by = sender). */
export function useClips(roomId: string): Clip[] {
  const evs = useRoomStateEvents(roomId, CLIP_TYPE);
  return useMemo(
    () =>
      evs
        .map((e) => ({ at: Number((e.content as { at?: unknown }).at), by: e.sender }))
        .filter((c) => Number.isFinite(c.at) && c.at > 0 && Number.isInteger(c.at)),
    [evs],
  );
}

// ---- shared transport prefs (restored once per page, like _restoreTransport) ------------------------

export interface ResumeMap {
  [sessionId: string]: number;
}
export function loadResume(): ResumeMap {
  const v = getBlob<unknown>("memories-resume", {});
  return v && typeof v === "object" ? (v as ResumeMap) : {};
}
let resumeTimer = 0;
export function saveResume(map: ResumeMap): void {
  window.clearTimeout(resumeTimer);
  resumeTimer = window.setTimeout(() => {
    const keys = Object.keys(map).sort();
    const out: ResumeMap = {};
    for (const k of keys.slice(Math.max(0, keys.length - 80))) out[k] = map[k];
    setBlob("memories-resume", out);
  }, 800);
}
export function loadVolume(): { volume: number; muted: boolean } {
  const v = parseFloat(String(getPref("memories-volume", "100")));
  return { volume: Number.isFinite(v) && v >= 0 && v <= 100 ? v : 100, muted: getPref("memories-muted", false) === true };
}
let volTimer = 0;
export function saveVolume(volume: number, muted: boolean): void {
  window.clearTimeout(volTimer);
  volTimer = window.setTimeout(() => {
    setPref("memories-volume", String(Math.round(volume)));
    setPref("memories-muted", muted);
  }, 800);
}
