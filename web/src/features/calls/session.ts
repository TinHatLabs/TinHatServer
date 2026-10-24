// session.ts — the live call session object shared by the engine modules (no logic here, so the
// modules can import it without cycles).
import type { LocalAudioTrack, LocalVideoTrack, Room } from "livekit-client";
import type { Focus } from "./rtc";
import type { TinHatKeyProvider } from "./keys";

export interface Sess {
  gen: number;
  roomId: string;
  room: Room;
  provider: TinHatKeyProvider;
  key: Uint8Array;
  keyIndex: number;
  myIdentity: string; // "@me:server:DEVICE"
  me: string; // "@me:server"
  deviceId: string;
  focus: Focus;
  createdTs: number;
  connectedAt: number;
  mic: LocalAudioTrack | null;
  micWanted: boolean; // the mic should be published (not server-muted-at-join)
  cam: LocalVideoTrack | null;
  screen: LocalVideoTrack | null;
  screenAudio: MediaStreamTrack | null; // display-capture audio (published as the "music" slot)
  music: LocalAudioTrack | null;
  musicStop: (() => void) | null;
  sound: LocalAudioTrack | null;
  soundStop: (() => void) | null;
  timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>;
  cleanups: Array<() => void>; // listeners to remove when the session closes
  worker: Worker | null; // the E2EE worker we created (terminated at close)
  chimesArmedAt: number;
  closing: boolean; // we initiated the disconnect
}

let current: Sess | null = null;

export function sess(): Sess | null {
  return current;
}

export function setSess(s: Sess | null): void {
  current = s;
}

/** The session if it is still the one for `gen` (join generation guard). */
export function sessFor(gen: number): Sess | null {
  return current && current.gen === gen ? current : null;
}
