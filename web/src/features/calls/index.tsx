// features/calls — the call ENGINE (calls-engine spec). No UI of its own: callui / chat / nav /
// media / settings read `useCall()` and call its actions. See contract.ts for the store shape.
//
//   useCall(sel?)              the zustand store (CallStore = CallState & CallActions & CallUiState)
//   useCallStore               the store itself (callui writes a dev fake call with setState)
//   useRoomCall(roomId)        {active, participants[{mxid,name,avatar}]} — header button, join banner, nav strip
//   useIncomingCalls()         incoming cards; answerIncoming(roomId) = the card's Join/Switch
//   useIncomingRing()          {ringing} — the card pulses only while the 25 s ring runs
//   useHear()                  the "can they hear me" snapshot; heardSummary(...) for tooltips
//   useAway(roomId)            mxids marked away (dev.tinhat.afk) in a room
//   rejoin() / dismissFailure()  the failure banner's Rejoin / Try again (dropped call's room) and close
//   flipCamera()               mobile: front ↔ back camera
//   setPopouts(n)              PiP / pop-outs open (keeps remote video flowing while the tab is hidden)
//   setPopoutTiles(ids)        the tiles a separate visible window shows (GPU.md §2.11: hidden = per track)
//   setPermsProvider(fn)       spaces: roles-aware effectivePerms(roomId, mxid)
//   setRankProvider(fn)        spaces: (roomId, mxid) => effectivePerms(roomId, mxid).rank (moderation packets
//                              are honoured only from a sender ranked above the target; PL fallback)
//   republishMembership()      "Never record me" flipped mid-call (DECISIONS D11)
import { create } from "zustand";
import type { FeatureModule } from "@/core/registry";
import { bus, toast } from "@/core/bus";
import { onClientChanged, onSessionEnding, peekClient, useRoomStateAll, useSessionStore } from "@/core/matrix";
import { onPrefChange } from "@/core/prefs";
import { createLogger } from "@/core/log";
import type { CallStore, HearSnapshot } from "./contract";
import { useCallStore, getCall } from "./store";
import * as engine from "./engine";
import * as audio from "./audio";
import { applyGameChat, applyShareRecordingOnly, joinCorner, leaveCorner, pullAside, setTileTunedIn } from "./topics";
import { installAfk, setAfk } from "./afk";
import { answerAsk, cancelAsk, installSameRoom, linkWith, setHearThrough, unlink } from "./sameroom/link";
export { rememberedPairs, forgetPair, PAIRS_KEY as SAME_ROOM_PAIRS_KEY } from "./sameroom/link";
import { disconnectParticipant, serverMute, serverUnmute, setPermsProvider, setRankProvider } from "./moderation";
import { answerIncoming, dismissIncoming, installCallWatch, roomCall, useIncomingCalls, useIncomingRing, useRoomCall } from "./callwatch";
import { heardSummary, I_HEAR_REASON, NOT_ME_REASON, noteMute } from "./hear";
import "./stats";
import "./rxstats";
import { runConnectionTest } from "./extras";
import { ingestKeyEvent, installKeyIntake } from "./keys";
import { callActive } from "./rtc";
import { AFK_TYPE, mxidOf } from "./util";
import { adoptGuestHandoff } from "./guest";
import { rnnoiseAvailable as rnnoiseAvailableProbe } from "./mic";
import { installCallResume, resumeFromTap } from "./resume";
import { eventKeyName } from "@/core/shortcuts";
import { pttKeys } from "@/actions/shortcutsStore";

export type * from "./contract";
export { useCallStore } from "./store";
export { useRoomCall, useIncomingCalls, useIncomingRing, answerIncoming, roomCall, callActive };
export { heardSummary, NOT_ME_REASON, I_HEAR_REASON, setPermsProvider, setRankProvider };
export const { rejoin, dismissFailure, flipCamera, setPopouts, setPopoutTiles, republishMembership } = engine;
export { outputRoutingSupported, followCallOutput } from "./audio";
/** The engine publishes the join sound itself (joinsound.rs port in extras.ts) — media's fallback stays off. */
export const joinSoundHandledByEngine = true;
export { rnnoiseAvailable } from "./mic";
// widgets (Call stats) — ADDITIVE: receiver stats per person, ConnectionQuality, tinhat.rxq (WIDGETS.md §5/§6)
export { useRxStats, useRxStore, watchRxStats, type RxPerson, type RxState } from "./rxstats";
export { focusServiceUrl } from "./rtc"; // widgets W2: "Is it just me?" probes the call JWT service

const log = createLogger("calls");

/** React: the call state (use a selector for fine-grained re-renders). */
export function useCall(): CallStore;
export function useCall<T>(sel: (s: CallStore) => T): T;
export function useCall<T>(sel?: (s: CallStore) => T) {
  return useCallStore(sel ?? ((s) => s as unknown as T));
}

export function useHear(): HearSnapshot | Record<string, never> {
  return useCallStore((s) => s.hear);
}

const EMPTY: string[] = [];
const awayCache = new Map<string, string[]>();
/** mxids marked away (BRB) in a room — for the call room, restricted to people in the call. */
export function useAway(roomId: string | null | undefined): string[] {
  const all = useRoomStateAll<{ away?: boolean }>(roomId, AFK_TYPE);
  const callRoom = useCallStore((s) => s.callRoomId);
  const inCallAway = useCallStore((s) => s.awayUsers);
  if (roomId && roomId === callRoom) return inCallAway;
  const out: string[] = [];
  for (const [k, v] of all) if (v?.away === true) out.push(k);
  if (!out.length || !roomId) return EMPTY;
  out.sort();
  const prev = awayCache.get(roomId);
  if (prev && prev.join("|") === out.join("|")) return prev;
  awayCache.set(roomId, out);
  return out;
}

// ---- actions → store ------------------------------------------------------------------------------------

useCallStore.setState({
  joinCall: engine.joinCall,
  leaveCall: engine.leaveCall,
  switchCall: engine.switchCall,
  toggleMic: engine.toggleMic,
  forceMicMuted: engine.forceMicMuted,
  applyPushToTalk: engine.applyPushToTalk,
  pttHold: engine.pttHold,
  applyDeafen: engine.applyDeafen,
  toggleCamera: engine.toggleCamera,
  setInput: engine.setInput,
  setOutput: engine.setOutput,
  setCamera: engine.setCamera,
  refreshInputs: () => void engine.refreshInputs(),
  refreshOutputs: () => void engine.refreshOutputs(),
  refreshCameras: () => void engine.refreshCameras(),
  shareScreen: (o) => void engine.shareScreen(o),
  stopScreen: () => void engine.stopScreen(),
  startMusicSource: (id) => void engine.startMusicSource(id),
  startMusic: (f) => void engine.startMusic(f),
  stopMusic: () => void engine.stopMusic(),
  // (media passes an optional hard cap in ms, e.g. 3000 for join sounds)
  playSound: ((u: string, maxMs?: number) => void engine.playSound(u, maxMs ?? 0)) as CallStore["playSound"],
  stopSound: () => void engine.stopSound(),
  applyMicAec: engine.applyMicAec,
  applyMicAgc: engine.applyMicAgc,
  applyMicNsMode: engine.applyMicNsMode,
  applyShareQuality: engine.applyShareQuality,
  applyShareEncoder: engine.applyShareEncoder,
  applyCamQuality: engine.applyCamQuality,
  applyCamSimulcast: engine.applyCamSimulcast,
  applyRecvQuality: engine.applyRecvQuality,
  setTileVideoHidden: engine.setTileVideoHidden,
  applyTileQuality: engine.applyTileQuality,
  tileQuality: engine.getTileQuality,
  setTileVideoSize: engine.setTileVideoSize,
  setTileWatched: engine.setTileWatched,
  setTileTunedIn,
  applyShareRecordingOnly,
  applyGameChat,
  pullAside,
  joinCorner,
  leaveCorner,
  setAfk,
  serverMute,
  serverUnmute,
  disconnectParticipant,
  reconnectMic: () => void engine.reconnectMic(),
  healPeerAudio: (identity: string) => {
    let n = 0;
    for (const r of [...audio.remotes.values()]) if (r.identity === identity && audio.repairRemote(r.sid)) n++;
    log.info(`[heal] rebuilt ${n} playback path(s) for ${identity}`);
  },
  // Web: the only "system mute" we can see is the browser muting the capture (iOS after an app switch):
  // the pill's Unmute re-acquires it (inside the click).
  fixSystemLevel: () => {
    if (engine.micNeedsReacquire()) void engine.reconnectMic();
  },
  startMicMonitor: () => void engine.startMicMonitor(),
  stopMicMonitor: engine.stopMicMonitor,
  startOutputMonitor: engine.startOutputMonitor,
  stopOutputMonitor: engine.stopOutputMonitor,
  runConnectionTest: () => void runConnectionTest(),
  pauseRemoteTiles: engine.pauseRemoteTiles,
  attachVideo: engine.attachVideo,
  volumeFor: audio.volumeFor,
  mutedFor: audio.mutedFor,
  setVolume: audio.setVolume,
  pushVolume: audio.pushVolume,
  setMuted: audio.setMuted,
  reapplyAll: audio.reapply,
  dismissIncoming,
  resumeFromTap,
  sameRoomLink: linkWith,
  sameRoomUnlink: unlink,
  sameRoomCancel: cancelAsk,
  sameRoomAnswer: answerAsk,
  sameRoomHearThrough: setHearThrough,
});

// ---- global wiring (once) ---------------------------------------------------------------------------------

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  installKeyIntake();
  // Sign-out / token loss / tab takeover end the call while the departing session can still withdraw
  // our membership (Astra finding 6); a client swapped under a live call is a hard stop as well.
  onSessionEnding((why) => engine.endCallForSessionLoss(why));
  let callClient = peekClient();
  onClientChanged(() => {
    const c = peekClient();
    if (c !== callClient) {
      callClient = c;
      // (no ownership reset here: a stale publish of the old session tombstones itself with its own writer,
      // and clearing later could erase a NEW join's ownership)
      void engine.endCallForSessionLoss("client-changed");
    }
  });
  installAfk();
  installSameRoom();
  installCallWatch();
  engine.installPageLifecycle();
  installCallResume(); // back from an iOS app switch / frozen tab / sleep (resume.ts)
  engine.installMembershipWatch(); // a membership write that landed out of order is put right
  engine.watchDevices();
  // Status lines → short toasts; lastError → 6 s toast (CALL-19 / CUI-12/13). Toasted HERE only: the
  // round-1 fixes removed them from both the engine and callui's CallEffects (each said the other owns
  // them), so no call status or error was shown at all — fix/polish restored the single owner.
  useCallStore.subscribe((st, prev) => {
    // (a status line that repeats the error just raised is already on screen as the 6 s error toast)
    if (st.statusRev !== prev.statusRev && st.status && !st.fake && st.status !== st.lastError) toast(st.status, { timeoutMs: 3000 });
    if (st.errorRev !== prev.errorRev && st.lastError) toast(st.lastError, { kind: "error", timeoutMs: 6000 });
    if (st.micMuted !== prev.micMuted) noteMute(st.micMuted);
  });
  bus.on("startCall", ({ roomId }) => engine.switchCall(roomId));
  // A killed tab's ghost membership: sweep again once the first NETWORK sync is in (the IndexedDB
  // cache the onReady sweep sees can predate the ghost), and once more 20 s later.
  useSessionStore.subscribe((s, p) => {
    if (s.liveSyncDone && !p.liveSyncDone) {
      engine.sweepGhosts();
      setTimeout(() => engine.sweepGhosts(), 20000);
    }
  });
  onPrefChange("audio_prefs", () => audio.reloadPrefs());
  onPrefChange("record-optout", () => {
    if (getCall().inCall) void engine.republishMembership();
  });
  // Closing the tab mid-call asks first (the native window-close confirmation, TH-SHELL-04) — the
  // browser's own "Leave site?" prompt. Not under test automation (webshot sets __TW_DEBUG__).
  window.addEventListener("beforeunload", (e) => {
    if (!getCall().inCall || (window as unknown as { __TW_DEBUG__?: boolean }).__TW_DEBUG__) return;
    e.preventDefault();
    e.returnValue = "";
  });
  // Push-to-talk: hold its key (Ctrl unless Settings → Shortcuts moved it: a modifier held alone or an F-key,
  // ACTIONS.md §8.4) while Tin Hat has focus; blur / hidden = released.
  const isPttKey = (e: KeyboardEvent) => {
    const name = eventKeyName(e);
    return name !== null && pttKeys().includes(name);
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (isPttKey(e) && !e.repeat && getCall().pushToTalk) engine.pttHold(true);
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (isPttKey(e) && getCall().pushToTalk) engine.pttHold(false);
    },
    true,
  );
  window.addEventListener("blur", () => getCall().pttSpeaking && engine.pttHold(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && getCall().pttSpeaking) engine.pttHold(false);
  });
  // Wake Lock while in a call (phones sleep mid-call otherwise).
  let wake: { release(): Promise<void>; released?: boolean } | null = null;
  const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void>; released?: boolean }> } }).wakeLock;
  const takeWake = () => {
    if (!wl || (wake && !wake.released)) return;
    void wl
      .request("screen")
      .then((w) => (wake = w))
      .catch(() => undefined);
  };
  useCallStore.subscribe((st, prev) => {
    if (st.inCall === prev.inCall) return;
    if (st.inCall) takeWake();
    if (!st.inCall && wake) {
      void wake.release().catch(() => undefined);
      wake = null;
    }
  });
  // The browser drops a screen wake lock whenever the tab is hidden: take it again on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && getCall().inCall) takeWake();
  });
  // Dev / test hook (window.__twCall) — only with the debug hook enabled.
  const w = window as unknown as { __TW_DEBUG__?: boolean; __twCall?: unknown };
  if (import.meta.env.DEV || w.__TW_DEBUG__ || /twdebug/.test(location.hash)) {
    w.__twCall = {
      store: useCallStore,
      get: () => {
        const st = getCall();
        return {
          tiles: st.tiles,
          inCall: st.inCall,
          connecting: st.connecting,
          hangingUp: st.hangingUp,
          reconnecting: st.reconnecting,
          removedBy: st.removedBy,
          serverMutedBy: st.serverMutedBy,
          callFailed: st.callFailed,
          failReason: st.failReason,
          status: st.status,
          micMuted: st.micMuted,
          deafened: st.deafened,
          cameraOn: st.cameraOn,
          sharing: st.sharing,
          hear: st.hear,
          speakers: st.speakers,
          audioLevels: st.audioLevels,
          publishStats: st.publishStats,
          callRoomId: st.callRoomId,
          recActive: st.recActive,
          awayUsers: st.awayUsers,
          localAfk: st.localAfk,
          gameChatPeers: st.gameChatPeers,
          corner: st.corner,
          serverMuted: st.serverMuted,
          incomingCalls: st.incomingCalls,
        };
      },
      engine,
      audio,
      keys: { ingestKeyEvent }, // the app's OWN key-intake instance (tools/calls-security-e2e.mjs)
      roomCall,
      mxidOf,
      answerIncoming,
      dismissIncoming,
      ringing: () => useIncomingRing.getState().ringing,
    };
  }
}

export const feature: FeatureModule = {
  id: "calls",
  setup(r) {
    adoptGuestHandoff(); // before App's restoreSession(): a #/guest-session hand-off becomes the stored session
    install();
    r.shortcuts.add({
      id: "calls-toggle-mic",
      action: "call.mic.toggle",
      order: 500,
      keys: "Ctrl+Shift+M",
      description: "Mute / unmute the mic (in a call)",
      whenTyping: true,
      enabled: () => getCall().inCall || getCall().connecting,
      run: () => engine.toggleMic(),
    });
    r.shortcuts.add({
      id: "calls-toggle-deafen",
      action: "call.deafen.toggle",
      order: 510,
      keys: "Ctrl+Shift+D",
      description: "Deafen / undeafen (in a call)",
      whenTyping: true,
      enabled: () => getCall().inCall,
      run: () => engine.applyDeafen(!getCall().deafened),
    });
    r.onReady.add({
      id: "calls-ready",
      order: 50,
      run: () => {
        engine.sweepGhosts();
        void engine.refreshInputs();
        void engine.refreshOutputs();
        void engine.refreshCameras();
        void engine.refreshAudioSources();
        // "Strong (not installed)": probe the RNNoise worklet + WASM once, off the boot path.
        setTimeout(() => void rnnoiseAvailableProbe().then((ok) => useCallStore.setState({ ncAvailable: ok })), 5000);
      },
    });
  },
};
