// session.ts — the live call session object shared by the engine modules (no logic here, so the
// modules can import it without cycles).
import type { LocalAudioTrack, LocalVideoTrack, Room } from "livekit-client";
import type { Focus } from "./rtc";
import type { TinHatKeyProvider } from "./keys";
import type { Planner } from "./callrules";

export interface Sess {
  gen: number;
  roomId: string;
  room: Room;
  provider: TinHatKeyProvider;
  /** our media keys by index: the one in use and the pending one (M2, DESIGN §3.3) */
  keyRing: Map<number, Uint8Array>;
  /** the index our sender actually encrypts with (lags planner.inUse only while a switch failed / is running) */
  sendingIndex: number;
  /** `user|device` → the newest key index we still owe them (outstanding from BEFORE a planner send starts; cleared
   *  by a successful send of that index or newer): re-sent on a short ladder after a switch */
  resend: Map<string, number>;
  /** the sender switch in progress (one at a time) */
  switching: Promise<void> | null;
  /** the rotate-on-leave planner: which index is in use / pending, who holds it */
  planner: Planner;
  /** `user:device` → created_ts of a session that left the call server while ours was connected (DESIGN §3.1) */
  sfuGone: Map<string, number>;
  /** false = the server's kill switch is on (the planner tracks, nothing is minted) */
  rotation: boolean;
  planBusy: boolean;
  planAgain: boolean;
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
