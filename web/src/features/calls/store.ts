// store.ts — the zustand call store (contract.ts: CallStore = CallState & CallActions & CallUiState).
// The engine (engine.ts) installs the real actions at load; until then they are no-ops so a
// surface that renders before the engine loads never crashes. `callui` may write a dev fake call
// into the store with setState (fake: true) — the engine leaves such a call alone.
import { create } from "zustand";
import { getPref } from "@/core/prefs";
import type { CallActions, CallState, CallStore, CallUiState } from "./contract";

export function initialCallState(): CallState {
  const ns = getPref("mic-ns-mode", "off");
  const rq = getPref("recv-quality", "auto");
  return {
    inCall: false,
    connecting: false,
    hangingUp: false,
    reconnecting: false,
    callFailed: false,
    failReason: "",
    removedBy: "",
    callRoomId: "",
    status: "",
    statusRev: 0,
    micMuted: false,
    pushToTalk: getPref("push-to-talk", false),
    pttSpeaking: false,
    deafened: false,
    cameraOn: false,
    sharing: false,
    musicPlaying: false,
    soundPlaying: false,
    shareRecOnly: false,
    gameChat: false,
    recActive: false,
    localAfk: false,
    awayUsers: [],
    tiles: [],
    selfviewGen: 0,
    recOnlyFlags: {},
    gameChatPeers: { me: false, peers: [], muted: [] },
    corner: { mine: "", active: false, members: [], corners: {} },
    audioLevels: {},
    micLevel: 0,
    micLevelPre: 0,
    outputLevel: 0,
    speakers: { me: "", active: [] },
    publishStats: [],
    hear: {},
    callPerms: {},
    canModerateCall: false,
    serverMuted: false,
    serverMutedBy: "",
    moderationRev: 0,
    lastError: "",
    errorRev: 0,
    inputs: [],
    outputs: [],
    cameras: [],
    inputName: "System default",
    outputName: "System default",
    cameraName: "Default (first camera)",
    micAec: getPref("mic-echo-cancel", true),
    micAgc: getPref("mic-agc", true),
    micNsMode: ns === "standard" || ns === "strong" ? ns : "off",
    ncAvailable: true,
    ecDegraded: false,
    ecNote: "",
    micSilent: false,
    outputMissing: false,
    shareQuality: getPref("share-quality", "1920 1080 30 12000 nvenc"),
    camQuality: getPref("cam-quality", "1280 720 30 2500 1"),
    recvQuality: rq === "high" || rq === "medium" || rq === "low" ? rq : "auto",
    audioSources: [],
    musicSourceName: "",
    connTest: "",
    incomingCalls: [],
    needsTap: "",
    sameRoom: { linked: [], holder: "", live: true, ask: null, pending: "", spk: true, groups: {}, rawOk: false },
  };
}

const noop = () => undefined;
const noopActions: CallActions = {
  joinCall: noop,
  leaveCall: noop,
  switchCall: noop,
  toggleMic: noop,
  forceMicMuted: noop,
  applyPushToTalk: noop,
  pttHold: noop,
  applyDeafen: noop,
  toggleCamera: noop,
  setInput: noop,
  setOutput: noop,
  setCamera: noop,
  refreshInputs: noop,
  refreshOutputs: noop,
  refreshCameras: noop,
  shareScreen: noop,
  stopScreen: noop,
  startMusicSource: noop,
  startMusic: noop,
  stopMusic: noop,
  playSound: noop,
  stopSound: noop,
  applyMicAec: noop,
  applyMicAgc: noop,
  applyMicNsMode: noop,
  applyShareQuality: noop,
  applyShareEncoder: noop,
  applyCamQuality: noop,
  applyCamSimulcast: noop,
  applyRecvQuality: noop,
  setTileVideoHidden: noop,
  applyTileQuality: noop,
  tileQuality: () => "auto",
  setTileVideoSize: noop,
  setTileWatched: noop,
  setTileTunedIn: noop,
  applyShareRecordingOnly: noop,
  applyGameChat: noop,
  pullAside: () => "",
  joinCorner: () => "",
  leaveCorner: noop,
  setAfk: noop,
  serverMute: async () => "",
  serverUnmute: async () => "",
  disconnectParticipant: async () => "",
  reconnectMic: noop,
  healPeerAudio: noop,
  fixSystemLevel: noop,
  startMicMonitor: noop,
  stopMicMonitor: noop,
  startOutputMonitor: noop,
  stopOutputMonitor: noop,
  runConnectionTest: noop,
  pauseRemoteTiles: noop,
  attachVideo: noop,
  volumeFor: () => 1,
  mutedFor: () => false,
  setVolume: noop,
  pushVolume: noop,
  setMuted: noop,
  reapplyAll: noop,
  dismissIncoming: noop,
  resumeFromTap: noop,
  sameRoomLink: () => "",
  sameRoomUnlink: noop,
  sameRoomCancel: noop,
  sameRoomAnswer: noop,
  sameRoomHearThrough: noop,
};

export const useCallStore = create<CallStore>()((set) => {
  const ui: CallUiState = {
    roomId: null,
    joined: false,
    shown: false,
    maximized: false,
    collapsed: getPref("call-collapsed", false),
    paneFrac: getPref("call-pane-frac", -1),
    fake: false,
    setMaximized: (v) => set({ maximized: v }),
    setCollapsed: (v) => set({ collapsed: v }),
    setPaneFrac: (v) => set({ paneFrac: v }),
  };
  return { ...initialCallState(), ...noopActions, ...ui };
});

export const getCall = () => useCallStore.getState();

/** Patch engine state; keeps the shell's derived UI fields (roomId/joined/shown) consistent. */
export function patch(p: Partial<CallState>): void {
  const cur = useCallStore.getState();
  if (cur.fake && !("inCall" in p || "connecting" in p || "callRoomId" in p)) {
    useCallStore.setState(p);
    return;
  }
  const next = { ...cur, ...p };
  const derived: Partial<CallUiState> = {};
  if (!cur.fake) {
    derived.joined = next.inCall;
    // (reconnecting: the auto-rejoin's teardown + 1.5 s wait keeps the panel and its amber banner up)
    derived.shown = next.inCall || next.connecting || next.callFailed || next.reconnecting;
    derived.roomId = next.callRoomId || null;
    if (!derived.shown) derived.maximized = false;
  }
  useCallStore.setState({ ...p, ...derived });
}

/** Status line: every set toasts (statusRev bumps even for the same text). */
export function setStatus(text: string): void {
  const cur = useCallStore.getState();
  patch({ status: text, statusRev: cur.statusRev + 1 });
}

export function setError(text: string): void {
  const cur = useCallStore.getState();
  patch({ lastError: text, errorRev: cur.errorRev + 1 });
}
