// useNowPlaying.ts — the React side of nowPlaying.ts (QOL A00.1): spread the returned handlers on the <audio>/<video>
// element; when another player starts (or a recording does), this one is paused.
import { useEffect, useState, type RefObject } from "react";
import { newPlayerId, playing, registerPlayer, stopped } from "./nowPlaying";

export function useNowPlaying(kind: string, el: RefObject<HTMLMediaElement | null>) {
  const [id] = useState(() => newPlayerId(kind));
  useEffect(() => registerPlayer(id, () => el.current?.pause()), [id, el]);
  return {
    onPlayCapture: () => playing(id),
    onPauseCapture: () => stopped(id),
    onEndedCapture: () => stopped(id),
  };
}
