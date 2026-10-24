// features/calls/contract.ts — THE call-store contract (orchestrator, from tw-spec/calls-engine.md §3.1).
//
// Owned by the calls-engine agent (features/calls) but read by callui, nav, chat, media and settings,
// which are built in parallel against these types. Changes after phase 2 starts must be ADDITIVE only
// (add optional fields/actions; never rename or remove). Field names follow the native QML property
// names so QML logic ports 1:1. The UI-state block at the bottom is what the shell already uses.

export type CallCategory = "mic" | "screenshare" | "music";

export interface Dev {
  id: string; // MediaDeviceInfo.deviceId ("" / "default" = system default)
  name: string; // human label
  isDefault?: boolean;
}

export interface Tile {
  id: string; // "vid_selfview" | "vid_<trackSid>" | "avatar_<identity>"
  participant: string; // LiveKit identity "@u:server:DEVICE"; "You" for the self tile
  kind: "video" | "screenshare" | "avatar";
  name: string;
  screenshare: boolean;
  muted: boolean; // their mic publication is muted
  avatar: string; // mxc→object URL ("" = generated avatar)
  recordingOnly?: boolean;
  tunedIn?: boolean;
  serverMuted: boolean;
  serverMutedBy: string;
}

export interface PublishStat {
  kind: string; // "screen" | "camera/q" | "camera/h" | "camera/f" | "mic"
  enc: string;
  encPick: string;
  rid: string;
  w: number;
  h: number;
  fps: number;
  targetKbps: number;
  sendKbps: number;
  qlim: "none" | "bandwidth" | "cpu" | "other";
  lossPct: number;
  rttMs: number;
  jitterMs: number;
  key: number;
  nack: number;
  pli: number;
  active: boolean;
  sendKnown: boolean;
}

export type HearsMe = "ok" | "waiting" | "unconfirmed" | "unknown" | "muted" | "silent" | "noaudio" | "nokey" | "stalled";
export type IHear = "ok" | "waiting" | "muted" | "stalled" | "nokey" | "noaudio" | "silent" | "nomic";

export interface HearPeer {
  deaf: boolean;
  away: boolean;
  hearsMe: HearsMe;
  notMe: "" | "nosub" | "muted" | "silent" | "noaudio" | "nokey" | "stalled" | "other";
  iHear: IHear;
  echo: null | { lag: number; db: number; room?: boolean }; // room: additive (hear.rs sends it)
}

export interface HearSnapshot {
  v: 1;
  on: boolean;
  me: string;
  mic: { check: "ok" | "wait" | "hint" | "dead" | "osmuted" | "osvol0"; dev: string };
  out: { check: "ok" | "osmuted" | "osvol0"; dev: string };
  mutedTalk: boolean;
  tx: { state: "ok" | "notsent" | "quiet"; why: string };
  peers: Record<string, HearPeer>;
  heard: { ok: number; total: number; not: string[]; unconf: string[]; deaf: string[]; pending: string[] };
  echoMe: { by: string[]; room: string[]; lag: number; db: number };
  localEcho: null | { lag: number; db: number; kind?: string; src?: "call" | "system" }; // src: additive (hear.rs)
  ecFix: { kind: "turn_on" | "volume" | "add_output" | "retry" | ""; out: string; label: string };
}

export interface IncomingCall {
  roomId: string;
  roomName: string;
  who: string;
}

/** Engine state — mirrors CallController + AfkController + AudioPrefsController. */
export interface CallState {
  inCall: boolean;
  connecting: boolean;
  hangingUp: boolean;
  reconnecting: boolean;
  callFailed: boolean;
  failReason: string;
  removedBy: string;
  callRoomId: string; // the call's room ("" = none) — native `roomId`; see UI block `roomId` (nullable alias)
  status: string;
  statusRev: number; // every set → toast (same text twice still toasts)
  micMuted: boolean;
  pushToTalk: boolean;
  pttSpeaking: boolean;
  deafened: boolean;
  cameraOn: boolean;
  sharing: boolean;
  musicPlaying: boolean;
  soundPlaying: boolean;
  shareRecOnly: boolean;
  gameChat: boolean;
  recActive: boolean;
  localAfk: boolean;
  awayUsers: string[]; // bare mxids in the call marked away
  tiles: Tile[];
  selfviewGen: number;
  recOnlyFlags: Record<string, [boolean, boolean]>; // tileId → [recOnly, tunedIn]
  gameChatPeers: { me: boolean; peers: string[]; muted: string[] };
  corner: { mine: string; active: boolean; members: string[]; corners: Record<string, string[]> };
  audioLevels: Record<string, number>; // "identity|category" → rms 0..1
  micLevel: number;
  micLevelPre: number;
  outputLevel: number;
  speakers: { me: string; active: string[] };
  publishStats: PublishStat[];
  hear: HearSnapshot | Record<string, never>;
  callPerms: Record<string, boolean>;
  canModerateCall: boolean;
  serverMuted: boolean;
  serverMutedBy: string;
  moderationRev: number;
  lastError: string;
  errorRev: number;
  inputs: Dev[];
  outputs: Dev[];
  cameras: Dev[];
  inputName: string;
  outputName: string;
  cameraName: string;
  micAec: boolean;
  micAgc: boolean;
  micNsMode: "off" | "standard" | "strong";
  ncAvailable: boolean;
  ecDegraded: boolean;
  ecNote: string;
  micSilent: boolean;
  outputMissing: boolean;
  shareQuality: string; // "W H FPS KBPS ENC" ("0 0 …" = Auto)
  camQuality: string; // "W H FPS KBPS SIM01"
  recvQuality: "auto" | "high" | "medium" | "low";
  audioSources: Dev[];
  musicSourceName: string;
  connTest: string;
  incomingCalls: IncomingCall[];
  /** Additive (fix/ios-resume): the browser needs a tap before the call works again — "audio" = its sound
   *  is paused (iOS after an app switch, a join without a click), "mic" = the mic must be re-acquired. */
  needsTap: "" | "audio" | "mic";
  /** Additive (11.3 Same room): who I'm linked with in this call and what the room-mic election decided.
   *  linked = peer identities; holder = the identity whose mic sends ("" when not linked); live = my mic sends;
   *  ask = someone asked me to link up (card); pending = who I asked; spk = this device plays the call
   *  (false = hearing it through a linked peer's speakers); groups = every link in the call for the tile badges;
   *  rawOk = the pre-AEC capture is driving the election. */
  sameRoom: SameRoomState;
}

export interface SameRoomState {
  linked: string[];
  holder: string;
  live: boolean;
  ask: { from: string; name: string; at: number } | null;
  pending: string;
  spk: boolean;
  groups: Record<string, { m: string[]; mic: string }>;
  rawOk: boolean;
}

export interface ShareOptions {
  audio?: "browser" | "device" | "none";
  audioDeviceId?: string;
  recordingOnly?: boolean;
  quality?: { w: number; h: number; fps: number; kbps: number };
}

/** Engine actions — same names as the native invokables (call_ctl.rs). */
export interface CallActions {
  joinCall(roomId: string): void;
  leaveCall(): void;
  switchCall(roomId: string): void;
  toggleMic(): void;
  forceMicMuted(muted: boolean): void;
  applyPushToTalk(on: boolean): void;
  pttHold(down: boolean): void;
  applyDeafen(on: boolean): void;
  toggleCamera(): void;
  setInput(id: string): void;
  setOutput(id: string): void;
  setCamera(id: string): void;
  refreshInputs(): void;
  refreshOutputs(): void;
  refreshCameras(): void;
  shareScreen(opts?: ShareOptions): void;
  stopScreen(): void;
  startMusicSource(id: string): void;
  startMusic(fileOrUrl: File | string): void;
  stopMusic(): void;
  playSound(url: string): void;
  stopSound(): void;
  applyMicAec(on: boolean): void;
  applyMicAgc(on: boolean): void;
  applyMicNsMode(mode: "off" | "standard" | "strong"): void;
  applyShareQuality(w: number, h: number, fps: number, kbps: number): void;
  applyShareEncoder(code: string): void;
  applyCamQuality(w: number, h: number, fps: number, kbps: number): void;
  applyCamSimulcast(on: boolean): void;
  applyRecvQuality(q: "auto" | "high" | "medium" | "low"): void;
  setTileVideoHidden(tileId: string, hidden: boolean): void;
  applyTileQuality(tileId: string, q: string): void;
  tileQuality(tileId: string): string;
  setTileVideoSize(tileId: string, w: number, h: number): void;
  setTileWatched(tileId: string, watched: boolean): void;
  setTileTunedIn(tileId: string, tunedIn: boolean): void;
  applyShareRecordingOnly(on: boolean): void;
  applyGameChat(on: boolean): void;
  pullAside(identity: string): string; // "" or reason
  joinCorner(identity: string): string; // "" or reason
  leaveCorner(): void;
  setAfk(on: boolean): void;
  serverMute(identity: string): Promise<string>; // "" or reason
  serverUnmute(identity: string): Promise<string>;
  disconnectParticipant(identity: string): Promise<string>;
  reconnectMic(): void;
  healPeerAudio(identity: string): void;
  fixSystemLevel(): void; // no-op on web
  startMicMonitor(): void;
  stopMicMonitor(): void;
  startOutputMonitor(): void;
  stopOutputMonitor(): void;
  runConnectionTest(): void;
  pauseRemoteTiles(paused: boolean): void;
  /** Attach the tile's video track to a <video> element (null = detach). */
  attachVideo(tileId: string, el: HTMLVideoElement | null): void;
  volumeFor(identity: string, category: CallCategory): number;
  mutedFor(identity: string, category: CallCategory): boolean;
  setVolume(identity: string, category: CallCategory, v: number): void;
  pushVolume(identity: string, category: CallCategory, v: number): void;
  setMuted(identity: string, category: CallCategory, muted: boolean): void;
  reapplyAll(): void;
  dismissIncoming(roomId: string): void;
  /** Additive (fix/ios-resume): call INSIDE a click / tap — restarts the sound and, if needed, the mic. */
  resumeFromTap(): void;
  /** Additive (11.3 Same room): link up with a call member (identity or mxid; "" or a reason), unlink, answer an
   *  incoming ask, and "hear the call through their speakers" (false) / on this device (true). */
  sameRoomLink(target: string): string;
  sameRoomUnlink(): void;
  /** 11.3 QOL: take back my pending "link up?" ask */
  sameRoomCancel(): void;
  sameRoomAnswer(yes: boolean): void;
  sameRoomHearThrough(onThisDevice: boolean): void;
}

/** UI state the shell and call UI share (already used by app/Shell.tsx — keep these names). */
export interface CallUiState {
  roomId: string | null; // room whose call panel is shown / call we are in (null = none)
  joined: boolean; // = inCall
  shown: boolean; // a call panel is on screen for roomId (joined, joining, failed, or a fake call)
  maximized: boolean; // "Fill the app"
  collapsed: boolean; // call panel collapsed to its status bar
  paneFrac: number; // dragged call/chat split (−1 = automatic)
  fake: boolean; // dev/gate fake call (TINHAT_GUI_FAKECALL equivalent: ?fakecall=1)
  setMaximized(v: boolean): void;
  setCollapsed(v: boolean): void;
  setPaneFrac(v: number): void;
}

export type CallStore = CallState & CallActions & CallUiState;
