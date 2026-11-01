// store.ts — the call UI's view of the calls engine + its own session state.
//
// The engine (features/calls) is written in parallel; we read it ONLY through `useCallStore` from
// "@/features/calls", typed by the contract (src/features/calls/contract.ts). Until the engine lands
// the stub store only has the shell's UI block, so every read goes through `DEFAULTS` (a missing
// field reads as its idle value) and every action through `act()` (a missing action is a no-op).
//
// `useCallUi` is this feature's own zustand store: session-only UI state that the native keeps in
// AppCore.qml (pin, session hides, Listen choices, side fraction, pop-outs, open popovers, chrome).
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { isRecorder } from "@/core/server";
import { useCallStore as engineStore } from "@/features/calls";
import type { CallActions, CallState, CallStore, CallUiState, Tile } from "@/features/calls/contract";

export type { CallStore, Tile };

/** The engine store, typed by the contract. */
export const callStore = engineStore as unknown as UseBoundStore<StoreApi<CallStore>>;

const EMPTY: never[] = [];
const EMPTY_OBJ = {} as Record<string, never>;

export const DEFAULTS: CallState & Omit<CallUiState, "setMaximized" | "setCollapsed" | "setPaneFrac"> = {
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
  pushToTalk: false,
  pttSpeaking: false,
  deafened: false,
  watching: false,
  noCapture: false,
  cameraOn: false,
  sharing: false,
  musicPlaying: false,
  soundPlaying: false,
  shareRecOnly: false,
  gameChat: false,
  recActive: false,
  localAfk: false,
  awayUsers: EMPTY,
  tiles: EMPTY,
  selfviewGen: 0,
  recOnlyFlags: EMPTY_OBJ,
  gameChatPeers: { me: false, peers: EMPTY, muted: EMPTY },
  corner: { mine: "", active: false, members: EMPTY, corners: EMPTY_OBJ },
  audioLevels: EMPTY_OBJ,
  micLevel: 0,
  micLevelPre: 0,
  outputLevel: 0,
  speakers: { me: "", active: EMPTY },
  publishStats: EMPTY,
  hear: EMPTY_OBJ,
  callPerms: EMPTY_OBJ,
  canModerateCall: false,
  serverMuted: false,
  serverMutedBy: "",
  moderationRev: 0,
  lastError: "",
  errorRev: 0,
  inputs: EMPTY,
  outputs: EMPTY,
  cameras: EMPTY,
  inputName: "",
  outputName: "",
  cameraName: "",
  micAec: true,
  micAgc: true,
  micNsMode: "standard",
  ncAvailable: false,
  ecDegraded: false,
  ecNote: "",
  micSilent: false,
  outputMissing: false,
  shareQuality: "1920 1080 60 8000 auto",
  camQuality: "1280 720 30 1700 0",
  recvQuality: "auto",
  audioSources: EMPTY,
  musicSourceName: "",
  connTest: "",
  incomingCalls: EMPTY,
  needsTap: "",
  sameRoom: { linked: EMPTY, holder: "", live: true, ask: null, pending: "", spk: true, groups: EMPTY_OBJ, rawOk: false },
  roomId: null,
  joined: false,
  shown: false,
  maximized: false,
  collapsed: false,
  paneFrac: -1,
  fake: false,
};

type StateKey = keyof typeof DEFAULTS;

/** One engine field, reactive, with its idle default when the engine doesn't provide it. */
export function useC<K extends StateKey>(k: K): CallStore[K] {
  return callStore((s) => ((s as Partial<CallStore>)[k] ?? DEFAULTS[k]) as CallStore[K]);
}

/** Non-reactive snapshot with defaults filled in. */
export function getC(): CallStore {
  return { ...(DEFAULTS as unknown as CallStore), ...callStore.getState() };
}

const NOOPS: Partial<CallActions> = {
  pullAside: () => "",
  joinCorner: () => "",
  tileQuality: () => "auto",
  serverMute: async () => "Calls aren't available yet",
  serverUnmute: async () => "Calls aren't available yet",
  disconnectParticipant: async () => "Calls aren't available yet",
  volumeFor: () => 1,
  mutedFor: () => false,
};

/** An engine action (a no-op until the engine provides it). */
export function act<K extends keyof CallActions>(k: K): CallActions[K] {
  const f = (callStore.getState() as Partial<CallActions>)[k];
  if (typeof f === "function") return f as CallActions[K];
  return (NOOPS[k] ?? (() => undefined)) as CallActions[K];
}

/** Whether the call panel is shown (native callShown = inCall || connecting || fakeCall || callFailed).
 *  Like native, the panel follows you: it sits on top of whichever room page is open (Main.qml:5327),
 *  so browsing another room mid-call keeps the call in view. `roomId` is kept for the call site's API. */
export function useCallShownFor(_roomId: string): boolean {
  return callStore((s) => {
    const st = s as Partial<CallStore>;
    return !!(st.inCall || st.connecting || st.callFailed || st.reconnecting || st.fake || st.shown);
  });
}

/** Push UI-state fields into the engine store (shell reads them); uses the engine's setters when present. */
export function setUiState(p: Partial<Pick<CallUiState, "maximized" | "collapsed" | "paneFrac">>) {
  const st = callStore.getState() as Partial<CallStore>;
  if (p.maximized !== undefined) {
    if (st.setMaximized) st.setMaximized(p.maximized);
    else callStore.setState({ maximized: p.maximized } as Partial<CallStore>);
  }
  if (p.collapsed !== undefined) {
    if (st.setCollapsed) st.setCollapsed(p.collapsed);
    else callStore.setState({ collapsed: p.collapsed } as Partial<CallStore>);
  }
  if (p.paneFrac !== undefined) {
    if (st.setPaneFrac) st.setPaneFrac(p.paneFrac);
    else callStore.setState({ paneFrac: p.paneFrac } as Partial<CallStore>);
  }
}

// ---- tile helpers ------------------------------------------------------------------------------

export const SELF_ID = "vid_selfview";
export const SELF_SHARE_ID = "vid_selfshare";

/** Bare mxid from a LiveKit identity "@u:server:DEVICE" (tileMxid). */
export function tileMxid(identity: string): string {
  const m = /^(@[^:]+:[^:]+)/.exec(identity || "");
  return m ? m[1] : identity || "";
}

/** The Memories recorder (the account the server announces — core/server) is never a tile (call_ctl.rs:787-893) —
 *  defensive filter over the engine's list. */
export function isRecorderTile(t: Tile): boolean {
  return isRecorder(t.participant || "");
}

export function isShareTile(t: Tile | undefined | null): boolean {
  return !!t && (t.kind === "screenshare" || t.screenshare === true);
}

/** "hidden memory" key of a tile: "<mxid>|share" / "|avatar" / "|cam". */
export function tileKey(t: Tile): string {
  const kind = isShareTile(t) ? "share" : t.kind === "avatar" ? "avatar" : "cam";
  return `${tileMxid(t.participant)}|${kind}`;
}

/** view-memory key "<mxid>|share|cam". */
export function viewKey(t: Tile): string {
  return `${tileMxid(t.participant)}|${isShareTile(t) ? "share" : "cam"}`;
}

export function localpartOf(mxid: string): string {
  const m = /^@([^:]+)/.exec(mxid || "");
  return m ? m[1] : mxid;
}

/** The label a tile shows: "You" / display name / localpart. */
export function tileName(t: Tile): string {
  if (t.id === SELF_ID) return "You";
  if (t.name) return t.name;
  return localpartOf(tileMxid(t.participant));
}

/** "a", "a and b", "a, b and c" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

// ---- the call UI's own session state (AppCore.qml) ----------------------------------------------

export interface PipEntry {
  tileId: string;
  participant: string;
  name: string;
  isShare: boolean;
  /** the PiP hid the tile itself (so closing it un-hides) */
  hidBy: boolean;
}

export type OptsFace = "mic" | "speaker" | "camera";

export interface VolMenuState {
  mxid: string;
  identity: string;
  name: string;
  anchor: { x: number; y: number } | { x: number; y: number; width: number; height: number };
}

interface CallUi {
  pinned: string | null;
  sessionHidden: string[];
  listen: string[];
  sideFrac: number;
  animate: boolean;
  pips: PipEntry[];
  optsFace: OptsFace | null;
  optsAnchor: HTMLElement | null;
  streamPop: boolean;
  ecOpen: boolean;
  menuHeld: number; // devices menu / health popup / game popup (counter)
  volMenu: VolMenuState | null;
  mutedBubble: boolean;
  forceChrome: boolean;
  soundboardOpen: boolean;
  mobileMin: boolean; // phones: the call is minimised to the pill
  mobileChrome: boolean;
  set: (p: Partial<CallUi>) => void;
}

export const useCallUi = create<CallUi>()((set) => ({
  pinned: null,
  sessionHidden: [],
  listen: [],
  sideFrac: 0.28,
  animate: true,
  pips: [],
  optsFace: null,
  optsAnchor: null,
  streamPop: false,
  ecOpen: false,
  menuHeld: 0,
  volMenu: null,
  mutedBubble: false,
  forceChrome: false,
  soundboardOpen: false,
  mobileMin: false,
  mobileChrome: true,
  set: (p) => set(p),
}));

export function ui() {
  return useCallUi.getState();
}

/** Corner actions started from this UI (so the "pulled you aside" toast skips our own pulls). */
export const cornerLocal = { at: 0 };
