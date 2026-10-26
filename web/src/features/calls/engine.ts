// engine.ts — the call engine: join / leave / switch / drop / auto-rejoin state machine
// (call_ctl.rs do_join, leave_call, the drain loop), the LiveKit room with per-participant E2EE,
// tiles, mic / camera / screen / music / sound publishing, the receive policy and the
// one-call-per-device lock. Data topics live in topics.ts, BRB in afk.ts, moderation in
// moderation.ts, the incoming-call watcher in callwatch.ts, "can they hear me" in hear.ts.
import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  ParticipantEvent,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  VideoPreset,
  VideoQuality,
  createLocalAudioTrack,
  createLocalVideoTrack,
  isE2EESupported,
  type AudioCaptureOptions,
  type LocalTrackPublication,
  type Participant,
  type TrackPublishOptions,
  type VideoCodec,
} from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import { getSession, ensureWritable, getState, sendState, peekClient, fetchMedia, acquireMxcUrl, onClientChanged } from "@/core/matrix";
import { holdsTabLock } from "@/core/matrix/client";
import { RoomStateEvent, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import { apiUrl } from "@/core/api";
import { getPref, getPrefRaw, onPrefChange, setPref } from "@/core/prefs";
import { onWinState, winFocused, winState } from "@/core/winstate";
import { previewPaused, SPEAKING_LEVEL, UNFOCUSED_CAM_FPS, UNFOCUSED_SAVER_PREF, unfocusedSaverOn as saverFromPref, videoPolicy } from "@/core/lowgpu";
import { HiddenPlayers, isRemoteVideoTile } from "./hiddenplayers";
import { createLogger } from "@/core/log";
import { pageEpoch, pageHidden, whenVisible, type ResumeInfo } from "@/core/lifecycle";
import type { CallCategory, CallState, Dev, ShareOptions, Tile } from "./contract";
import { getCall, patch, setStatus, useCallStore } from "./store";
import { sess, sessFor, setSess, type Sess } from "./session";
import { advanceKeyIndex, announceKey, mintKey, replayKeys, setKeySink, TinHatKeyProvider, clearKeysFor, onPeerKey, recheckPending } from "./keys";
import {
  mintSfuToken,
  membershipContent,
  ownLiveCreatedTs,
  putMembership,
  wantMembership,
  dropMembership,
  resolveFocus,
  sweepOwnGhosts,
  withdrawKeepalive,
  withdrawMembership,
  contentLive,
  membershipWanted,
  ownStateKey,
} from "./rtc";
import * as audio from "./audio";
import { AFK_TYPE, MEMBER_TYPE, avatarMxc, displayName, errText, isRecorder, mxidOf, sleep, withTimeout } from "./util";
import { buildMicOptions, micProcessorFor, rnnoiseAvailable } from "./mic";
import { av1Probe, av1Watch } from "./av1";
import { setCallAudioSession } from "@/core/sounds";
import type { Stamp } from "./envclock";
// Tin Hat apps (bridge 2): the phone's native device does the call — Join goes to the app, never this engine
import { joinNatively, nativeDeviceId, pageOwnsMembership } from "@/features/native";

const log = createLogger("call");

// ---- engine-private state ---------------------------------------------------------------------------

let joinGen = 0;
let activeCallRoom: string | null = null; // our membership is (being) published here
let joinTarget: string | null = null;
let pendingSwitch: string | null = null;
let teardowns = 0;
let userHungUp = false;
let healthySince = 0;
let rejoinAttempts = 0;
let restoreMute: boolean | null = null;
let pressedMuteWhileConnecting: boolean | null = null;
let lockRelease: (() => void) | null = null;
let lastDropRoom = "";

/** Things other modules hook into (set by topics/afk/moderation/hear/stats at load). */
export const hooks = {
  onConnected: [] as Array<(s: Sess) => void>,
  onTeardown: [] as Array<(roomId: string) => void>,
  onParticipantJoined: [] as Array<(s: Sess, p: RemoteParticipant) => void>,
  onParticipantLeft: [] as Array<(s: Sess, p: RemoteParticipant) => void>,
  onData: [] as Array<(s: Sess, topic: string, payload: Record<string, unknown>, from: string) => void>,
  onPermissionChanged: [] as Array<(s: Sess) => void>,
  onRemoved: [] as Array<(s: Sess) => string>, // returns the moderator label if known
  micPublishBlocked: (_roomId: string): { muted: boolean; by: string } => ({ muted: false, by: "" }),
  shieldFor: (_identity: string): { serverMuted: boolean; serverMutedBy: string } => ({ serverMuted: false, serverMutedBy: "" }),
  recOnly: (_identity: string, _sid: string): [boolean, boolean] => [false, false],
  onShareChanged: [] as Array<(s: Sess) => void>,
  onUserMicToggle: [] as Array<() => void>, // the user changed the mic themselves (BRB drops its restore claim)
  joinSound: (_s: Sess) => undefined as void,
};

export function engineState() {
  return { joinGen, activeCallRoom, joinTarget, pendingSwitch, teardowns };
}

export function claimsRoom(roomId: string): boolean {
  return activeCallRoom === roomId || joinTarget === roomId || pendingSwitch === roomId;
}

// ---- friendly errors (call_ctl.rs:3847-3860) --------------------------------------------------------------

/** Why a join fails when the homeserver refuses our call membership (403 M_FORBIDDEN). */
export const MEMBERSHIP_FORBIDDEN = "you don't have permission to join calls in this room. Ask a room admin to allow it.";

/** The homeserver refused the write for lack of power (not a transient failure). */
function isForbidden(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as { httpStatus?: number; errcode?: string; data?: { errcode?: string } };
  return o.httpStatus === 403 || o.errcode === "M_FORBIDDEN" || o.data?.errcode === "M_FORBIDDEN";
}

export function friendly(e: unknown): string {
  const raw = errText(e);
  const t = raw.toLowerCase();
  if (/timed out|timeout|deadline/.test(t)) return "the call server didn't answer. Check your connection and try again.";
  if (t.includes("already") && /call|participant|identity/.test(t)) return "you're already in this call on another device.";
  if (/dns|resolve|connection refused|unreachable|network|connect/.test(t)) return "couldn't reach the call server. Check your connection and try again.";
  if (t.includes("not signed in")) return "you're not signed in.";
  return raw;
}

// ---- one call per device (Web Locks) ----------------------------------------------------------------------

let lockDone: Promise<unknown> | null = null; // settles once our previous lock is really released

/** Held by a tab that stole this device's call lock (below) for as long as that call lasts; the name
 *  carries the room. The stale tab ending its call for the take-over must not tombstone that room's
 *  membership — same device = same state key, so its late withdraw would wipe the new tab's live one
 *  (Astra review of the steal). A Web Lock, not localStorage: the lock manager answers with the CURRENT
 *  state, while a renderer that was suspended can read a stale localStorage copy (seen in Chromium). */
const stolenMarker = (deviceId: string, roomId: string) => `tinhat-web-call-stolen:${deviceId}:${roomId}`;
let stolenRelease: (() => void) | null = null;

/** Is another tab of this device in `roomId`'s call on a call lock it took over from us? */
async function callLockStolenFor(deviceId: string, roomId: string): Promise<boolean> {
  try {
    const q = await navigator.locks?.query?.();
    return !!q?.held?.some((l) => l.name === stolenMarker(deviceId, roomId));
  } catch {
    return false;
  }
}

async function takeCallLock(deviceId: string, stealFromStaleTab = false, forRoom = ""): Promise<boolean> {
  if (lockRelease) return true;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return true;
  // A switch / rejoin right after a teardown: our own lock's release is asynchronous — wait for it,
  // or `ifAvailable` would see our own lock and report "another tab".
  if (lockDone) {
    await Promise.race([lockDone, sleep(2000)]);
    lockDone = null;
  }
  const request = (mode: { ifAvailable: true } | { steal: true }) =>
    new Promise<boolean>((resolve) => {
      let held: (() => void) | null = null;
      const holder = new Promise<void>((res) => (held = res));
      lockDone = locks
        .request(`tinhat-web-call:${deviceId}`, mode, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          lockRelease = () => {
            lockRelease = null;
            held?.();
          };
          resolve(true);
          return holder;
        })
        .catch(() => resolve(false));
    });
  if (await request({ ifAvailable: true })) return true;
  if (!stealFromStaleTab) return false;
  // This tab OWNS the session (core's tab lock) and still finds the call lock taken: the tab holding it
  // lost the session to a take-over while it was suspended (iOS background tab / frozen tab) and can't run
  // to let go of it — its call is over the moment it runs again (session.ts onTabLost). Without this, the
  // tab that took over could never call until the old one was brought back to the foreground.
  log.warn("the call lock is held by a tab that no longer owns the session (taken over while it was suspended?) — taking it over");
  if (!(await request({ steal: true }))) return false;
  if (forRoom) {
    // (granted at once: nobody else ever asks for this name; held until the call lock is released)
    stolenRelease?.();
    let done: (() => void) | null = null;
    const hold = new Promise<void>((res) => (done = res));
    stolenRelease = () => {
      stolenRelease = null;
      done?.();
    };
    void locks.request(stolenMarker(deviceId, forRoom), { ifAvailable: true }, (l) => (l ? hold : undefined)).catch(() => undefined);
  }
  return true;
}

function releaseCallLock() {
  lockRelease?.();
  stolenRelease?.();
}

// ---- tiles ------------------------------------------------------------------------------------------------

// Tile avatars are object URLs (contract: "mxc→object URL", authenticated media), held for the call.
const avatarUrls = new Map<string, { url: string; release: () => void }>();
function tileAvatar(roomId: string, mxid: string): string {
  const mxc = avatarMxc(roomId, mxid);
  if (!mxc) return "";
  const hit = avatarUrls.get(mxc);
  if (hit) return hit.url;
  const a = acquireMxcUrl(mxc, { width: 96, height: 96, method: "crop" });
  const entry = { url: "", release: a.release };
  avatarUrls.set(mxc, entry);
  a.promise
    .then((u) => {
      if (avatarUrls.get(mxc) !== entry) return;
      entry.url = u;
      rebuildTiles();
    })
    .catch(() => undefined);
  return "";
}
function releaseAvatars() {
  for (const e of avatarUrls.values()) e.release();
  avatarUrls.clear();
}

function micMutedOf(p: Participant): boolean {
  const pub = p.getTrackPublication(Track.Source.Microphone);
  return !!pub && pub.isMuted;
}

export function rebuildTiles(): void {
  const s = sess();
  if (!s) return;
  const st = getCall();
  const tiles: Tile[] = [];
  const recOnlyFlags: Record<string, [boolean, boolean]> = {};
  tiles.push({
    id: "vid_selfview",
    participant: "You",
    kind: "video",
    name: "You",
    screenshare: false,
    muted: false,
    avatar: tileAvatar(s.roomId, s.me),
    serverMuted: st.serverMuted,
    serverMutedBy: st.serverMutedBy,
  });
  const camOwners = new Set<string>();
  const people = [...s.room.remoteParticipants.values()].filter((p) => !isRecorder(p.identity));
  for (const p of people) {
    const name = displayName(s.roomId, p.identity);
    const avatar = tileAvatar(s.roomId, mxidOf(p.identity));
    const muted = micMutedOf(p);
    const shield = hooks.shieldFor(p.identity);
    for (const pub of p.videoTrackPublications.values()) {
      if (!pub.track || !pub.trackSid) continue;
      const ss = pub.source === Track.Source.ScreenShare;
      if (!ss && pub.source !== Track.Source.Camera) continue;
      if (!ss) camOwners.add(p.identity);
      const id = `vid_${pub.trackSid}`;
      const [recOnly, tuned] = ss ? hooks.recOnly(p.identity, pub.trackSid) : [false, false];
      if (ss) recOnlyFlags[id] = [recOnly, tuned];
      tiles.push({
        id,
        participant: p.identity,
        kind: ss ? "screenshare" : "video",
        name,
        screenshare: ss,
        muted,
        avatar,
        ...(ss ? { recordingOnly: recOnly, tunedIn: tuned } : {}),
        ...shield,
      });
    }
  }
  for (const p of people) {
    if (camOwners.has(p.identity)) continue;
    tiles.push({
      id: `avatar_${p.identity}`,
      participant: p.identity,
      kind: "avatar",
      name: displayName(s.roomId, p.identity),
      screenshare: false,
      muted: micMutedOf(p),
      avatar: tileAvatar(s.roomId, mxidOf(p.identity)),
      ...hooks.shieldFor(p.identity),
    });
  }
  patch({ tiles, recOnlyFlags });
  reconcileVideo();
}

// ---- video attach + receive policy (call.rs:3749-3938, 4718-4787) -----------------------------------------

const attached = new Map<string, HTMLVideoElement>();
const hiddenTiles = new Set<string>();
const tileSizes = new Map<string, { w: number; h: number; bucket: number }>();
const tileQuality = new Map<string, string>();
const watched = new Set<string>();
let remotePaused = false;
let popouts = 0;
/** tiles a separate, visible Tin Hat window shows (Document PiP pop-outs) — kept alive per track while hidden */
let popoutTiles = new Set<string>();

function trackForTile(tileId: string): Track | null {
  const s = sess();
  if (!s) return null;
  if (tileId === "vid_selfview") return s.cam;
  if (tileId === "vid_selfshare") return s.screen;
  if (!tileId.startsWith("vid_")) return null;
  const sid = tileId.slice(4);
  for (const p of s.room.remoteParticipants.values()) {
    const pub = p.getTrackPublicationBySid(sid);
    if (pub?.track) return pub.track;
  }
  return null;
}

export function attachVideo(tileId: string, el: HTMLVideoElement | null): void {
  const prev = attached.get(tileId);
  if (prev && prev !== el) {
    for (const t of [trackForTile(tileId)]) t?.detach(prev);
    attached.delete(tileId);
  }
  if (!el) {
    hiddenPlayers.forget(tileId);
    return;
  }
  attached.set(tileId, el);
  const t = trackForTile(tileId);
  // 10.8.1+: a remote tile's element that arrives while the page is hidden gets its player on show (hiddenplayers.ts);
  // one that still holds the track (a re-attach before the hide reached reconcileVideo) gives it back now
  if (t && hiddenPlayers.holdOnAttach(winState() === "hidden", tileId, inVisiblePopout)) t.detach(el);
  else if (t) {
    t.attach(el);
    el.muted = true;
  }
  applyLocalPreviews();
}

/** Remote video has no <video> player while the page is hidden and a FRESH one on show, before the SFU is asked to send
 *  again (reconcileVideo) — Chromium wedges the E2EE receive side of a player that sat in a hidden page across the SFU
 *  pause (the camera stayed on one 320x180 frame for minutes). features/calls/hiddenplayers.ts has the whole story. */
const hiddenPlayers = new HiddenPlayers({
  detach(tileId) {
    const el = attached.get(tileId);
    const t = trackForTile(tileId);
    if (!el || !t) return false;
    t.detach(el);
    return true;
  },
  attach(tileId) {
    const el = attached.get(tileId);
    const t = trackForTile(tileId);
    if (!el || !t) return false;
    t.attach(el);
    el.muted = true;
    return true;
  },
});

function syncHiddenPlayers(win: string): void {
  const r = hiddenPlayers.sync(win === "hidden", [...attached.keys()].filter(isRemoteVideoTile), inVisiblePopout);
  if (r.held.length) log.info(`[video] players released while hidden: ${r.held.join(", ")}`);
  if (r.restored.length) log.info(`[video] fresh players on show: ${r.restored.join(", ")}`);
}

function reattach(tileId: string) {
  const el = attached.get(tileId);
  if (el) attachVideo(tileId, el);
}

function detachAll() {
  for (const [tileId, el] of attached) {
    trackForTile(tileId)?.detach(el);
    el.srcObject = null;
  }
  hiddenPlayers.clear();
}

const DIMS: Record<string, { width: number; height: number }> = {
  "180": { width: 320, height: 180 },
  "360": { width: 640, height: 360 },
  "720": { width: 1280, height: 720 },
  "1080": { width: 1920, height: 1080 },
  low: { width: 320, height: 180 },
  medium: { width: 640, height: 360 },
  high: { width: 1920, height: 1080 },
};

function bucketOf(h: number): number {
  return h <= 270 ? 180 : h <= 540 ? 360 : h <= 810 ? 720 : 1080;
}

/** A PiP surface is showing call video: `<video>` Picture-in-Picture or a Document PiP window (callui's
 *  pop-outs). Checked here as well as `setPopouts(n)` so a hidden tab never pauses the video a PiP shows. */
function pipOpen(): boolean {
  if (typeof document === "undefined") return false;
  if (document.pictureInPictureElement) return true;
  const dpip = (window as unknown as { documentPictureInPicture?: { window?: Window | null } }).documentPictureInPicture;
  return !!dpip?.window && !dpip.window.closed;
}

/** A tile a visible Tin Hat window other than the (hidden) main page shows: a Document PiP pop-out, or the
 *  `<video>` element in the browser's own Picture-in-Picture. */
function inVisiblePopout(tileId: string): boolean {
  if (popoutTiles.has(tileId)) return true;
  const el = typeof document !== "undefined" ? document.pictureInPictureElement : null;
  return !!el && attached.get(tileId) === el;
}

/** Settings → Appearance → Performance → "Save GPU while Tin Hat isn't focused" (pref `call-unfocused-saver`, default
 *  OFF since 10.8.1 — core/lowgpu.ts unfocusedSaverOn). Read at the source: this module's pref listener may run before
 *  core/winstate.ts has re-read it. */
function unfocusedSaverOn(): boolean {
  return saverFromPref(getPrefRaw(UNFOCUSED_SAVER_PREF));
}

let lastEnabled = new Map<string, boolean>();
const lastLow = new Map<string, boolean>();
/** publications we put on the low layer (per publication object: a resubscription starts clean) */
const loweredPubs = new WeakSet<RemoteTrackPublication>();
/** the frame-rate request that lifts the unfocused cap: above every camera layer's rate */
const FULL_FPS = 60;

/** The receive policy per remote video track (call.rs:3749-3938, 4718-4787) + the low-GPU contract (GPU.md §2.11,
 *  core/lowgpu.ts videoPolicy):
 *   • focused: every visible tile at its tile-size layer (or the picked / Settings quality), as before;
 *   • unfocused (only while Settings → Appearance → Performance → "Save GPU while Tin Hat isn't focused" is on —
 *     default off since 10.8.1: `win` is the RENDER state, where an unfocused window renders as focused): camera
 *     tracks take the server's LOW layer at ≤ 15 fps; screen shares keep their quality (the watched share stays full);
 *   • hidden: released at the SFU (no decode) — per track: one a visible pop-out window shows keeps playing;
 *   • restored the moment the window gets the focus back. */
export function reconcileVideo(): void {
  const s = sess();
  if (!s) return;
  const st = getCall();
  const win = winState();
  // the players first: released while hidden, a fresh one before any track is re-enabled below
  syncHiddenPlayers(win);
  const saver = unfocusedSaverOn();
  const hideAll = remotePaused || st.localAfk;
  for (const p of s.room.remoteParticipants.values()) {
    for (const pub of p.videoTrackPublications.values()) {
      if (!pub.trackSid) continue;
      const tileId = `vid_${pub.trackSid}`;
      const ss = pub.source === Track.Source.ScreenShare;
      // A recording-only share I have not tuned in to is hidden → paused at the SFU (CALL-85).
      const [recOnly, tuned] = ss ? hooks.recOnly(p.identity, pub.trackSid) : [false, false];
      const pol = videoPolicy({ win, policyOn: saver, isShare: ss, inVisiblePopout: inVisiblePopout(tileId) });
      const enabled = !hideAll && pol.enabled && !hiddenTiles.has(tileId) && !(recOnly && !tuned);
      if (lastEnabled.get(tileId) !== enabled) {
        log.info(`[video] ${tileId} (${p.identity}) ${enabled ? "shown" : "hidden"} at the SFU${enabled ? "" : ` (${win})`}`);
        lastEnabled.set(tileId, enabled);
      }
      try {
        pub.setEnabled(enabled);
        if (!enabled) continue;
        // (LiveKit applies layer / fps requests only to a publication that has its track: without one there is
        // nothing to steer yet — the reconcile that follows the subscription applies it, and nothing is marked done)
        const hasTrack = !!pub.videoTrack;
        if (pol.low) {
          if (!hasTrack) continue;
          // the server's LOW layer explicitly (dimensions alone may pick a bigger one), at ≤ 15 fps
          pub.setVideoQuality(VideoQuality.LOW);
          pub.setVideoFPS(UNFOCUSED_CAM_FPS);
          loweredPubs.add(pub);
          if (lastLow.get(tileId) !== true) {
            log.info(`[video] ${tileId} (${p.identity}) low layer ≤ ${UNFOCUSED_CAM_FPS} fps (window ${win})`);
            lastLow.set(tileId, true);
          }
          continue;
        }
        const wasLow = loweredPubs.has(pub);
        const pick = tileQuality.get(tileId);
        let dims: { width: number; height: number } | null = null;
        if (pick && pick !== "auto") dims = DIMS[pick] ?? null;
        else if (st.recvQuality !== "auto") dims = DIMS[st.recvQuality] ?? null;
        else if (!ss) {
          const sz = tileSizes.get(tileId);
          if (sz) dims = DIMS[String(sz.bucket)] ?? null;
        }
        if (dims && (!ss || pick)) pub.setVideoDimensions(dims);
        else if (wasLow) pub.setVideoQuality(VideoQuality.HIGH); // no size known: unconstrained again (the SFU default)
        // back from the low layer: an explicit full frame rate (the SFU keeps a lowered temporal layer on fps 0)
        if (wasLow && hasTrack) {
          pub.setVideoFPS(FULL_FPS);
          loweredPubs.delete(pub);
          log.info(`[video] ${tileId} (${p.identity}) full policy again (window ${win})`);
          lastLow.set(tileId, false);
        }
      } catch (e) {
        log.debug(`video policy ${tileId}: ${errText(e)}`);
      }
    }
  }
  applyLocalPreviews();
}

/** GPU.md §2.11: the self-view and the share popover's preview pause (show their last frame) while the window is
 *  hidden, and while it is unfocused with the unfocused saver on; they play again on focus. Sending is unaffected. */
function applyLocalPreviews(): void {
  const pause = previewPaused(winState(), unfocusedSaverOn());
  for (const id of ["vid_selfview", "vid_selfshare"]) {
    const el = attached.get(id);
    if (!el || !el.srcObject) continue;
    if (pause && !el.paused) el.pause();
    else if (!pause && el.paused) void el.play().catch(() => undefined);
  }
}

export function setTileVideoHidden(tileId: string, hidden: boolean): void {
  if (hidden) hiddenTiles.add(tileId);
  else hiddenTiles.delete(tileId);
  reconcileVideo();
}

export function setTileVideoSize(tileId: string, w: number, h: number): void {
  const bucket = bucketOf(h);
  const prev = tileSizes.get(tileId);
  tileSizes.set(tileId, { w, h, bucket });
  if (!prev || prev.bucket !== bucket) reconcileVideo();
}

export function applyTileQuality(tileId: string, q: string): void {
  if (!q || q === "auto") tileQuality.delete(tileId);
  else tileQuality.set(tileId, q);
  reconcileVideo();
}

export function getTileQuality(tileId: string): string {
  return tileQuality.get(tileId) ?? "auto";
}

export function applyRecvQuality(q: CallState["recvQuality"]): void {
  setPref("recv-quality", q);
  patch({ recvQuality: q });
  reconcileVideo();
}

export function pauseRemoteTiles(paused: boolean): void {
  remotePaused = paused;
  reconcileVideo();
}

/** PiP / pop-out windows keep remote video flowing while the tab is hidden (kept for callers that only count). */
export function setPopouts(n: number): void {
  popouts = Math.max(0, n);
  reconcileVideo();
}

/** The tiles shown in a separate Tin Hat window (Document PiP pop-outs): while the main page is hidden exactly these
 *  keep their video (GPU.md §2.11 — "hidden" is per track: about what the user can see). */
export function setPopoutTiles(ids: readonly string[]): void {
  const next = new Set(ids);
  if (next.size === popoutTiles.size && [...next].every((x) => popoutTiles.has(x))) return;
  popoutTiles = next;
  reconcileVideo();
}

export function setTileWatched(tileId: string, on: boolean): void {
  if (on) watched.add(tileId);
  else watched.delete(tileId);
  audio.reapply();
}

export function watchedTiles(): ReadonlySet<string> {
  return watched;
}

// ---- remote audio subscription -----------------------------------------------------------------------------

function categoryOf(source: Track.Source): CallCategory {
  if (source === Track.Source.Microphone) return "mic";
  if (source === Track.Source.ScreenShareAudio) return "screenshare";
  return "music";
}

type FrameSink = (r: audio.RemoteAudio, frames: number[], stamp?: Stamp | null) => void;
let remoteFrameSink: FrameSink | undefined;
export function setRemoteFrameSink(f: FrameSink): void {
  remoteFrameSink = f;
}

function subscribeAudio(track: RemoteAudioTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
  if (isRecorder(p.identity)) return;
  const sid = pub.trackSid;
  audio.addRemote(sid, p.identity, categoryOf(pub.source), track.mediaStreamTrack, remoteFrameSink);
}

// ---- levels loop -------------------------------------------------------------------------------------------

let micTapClose: (() => void) | null = null;
let micLevelRaw = 0;
let micFramesSink: ((frames: number[], stamp?: Stamp | null) => void) | null = null;
export function setMicFrameSink(f: (frames: number[], stamp?: Stamp | null) => void): void {
  micFramesSink = f;
}

let micTapTok = 0;
async function tapMic(source: MediaStreamTrack) {
  micTapClose?.();
  micTapClose = null;
  const tok = ++micTapTok;
  // Tap a CLONE: livekit mutes by disabling the track (silence), but the meter and the
  // talking-while-muted detector must keep hearing the capture.
  const track = source.clone();
  track.enabled = true;
  const t = await audio.tapTrack(track, (frames, stamp) => {
    let m = 0;
    for (const f of frames) m = Math.max(m, f);
    micLevelRaw = Math.max(m, micLevelRaw * 0.7);
    wakeLevels(m);
    micFramesSink?.(frames, stamp);
  }).catch(() => null);
  if (!t || tok !== micTapTok) {
    // superseded (a newer capture, or the call/monitor ended while the tap was being built)
    t?.close();
    track.stop();
    return;
  }
  micTapClose = () => {
    t.close();
    track.stop();
  };
  micCaptureStartHook(source);
}

let micCaptureStartHook: (t: MediaStreamTrack) => void = () => undefined;
export function setMicCaptureHook(f: (t: MediaStreamTrack) => void): void {
  micCaptureStartHook = f;
}

function levelsTick() {
  const s = sess();
  const st = getCall();
  const levels: Record<string, number> = {};
  for (const r of audio.remotes.values()) {
    const k = `${r.identity}|${r.category}`;
    levels[k] = Math.max(levels[k] ?? 0, Math.round(Math.min(1, r.level * 3) * 1000) / 1000);
    r.level *= 0.6;
  }
  const micLevel = s?.mic && !st.micMuted ? Math.round(Math.min(1, micLevelRaw * 3) * 1000) / 1000 : 0;
  const pre = Math.round(Math.min(1, micLevelRaw * 3) * 1000) / 1000;
  micLevelRaw *= 0.6;
  const out = monitors.output ? Math.round(Math.min(1, audio.outputLevel() * 3) * 1000) / 1000 : st.outputLevel;
  // ~15 Hz: only touch the store when a value moved (a silent call used to re-render every level reader,
  // and every whole-store subscriber, 15× a second with identical numbers), and keep the same
  // audioLevels object when no participant's level changed.
  const next: Partial<CallState> = {};
  if (!sameLevels(st.audioLevels, levels)) next.audioLevels = levels;
  const ml = monitors.mic && !s ? pre : micLevel;
  if (ml !== st.micLevel) next.micLevel = ml;
  if (pre !== st.micLevelPre) next.micLevelPre = pre;
  if (out !== st.outputLevel) next.outputLevel = out;
  if (Object.keys(next).length) useCallStore.setState(next);
}

function sameLevels(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// ---- mic ---------------------------------------------------------------------------------------------------

async function createMic(): Promise<LocalAudioTrack> {
  const st = getCall();
  const opts: AudioCaptureOptions = buildMicOptions(st);
  const track = await boundedCapture(createLocalAudioTrack(opts));
  if (st.micNsMode === "strong") {
    try {
      track.setAudioContext(audio.audioContext());
      const proc = await micProcessorFor("strong");
      if (proc) await track.setProcessor(proc);
      patch({ ncAvailable: true });
    } catch (e) {
      log.warn(`RNNoise unavailable: ${errText(e)}`);
      patch({ ncAvailable: false });
    }
  }
  const label = track.mediaStreamTrack.label || "System default";
  patch({ inputName: getPref("call-input", "") ? label : "System default" });
  // (livekit's Ended follows the CURRENT capture: its own mobile re-acquire swaps the MediaStreamTrack, and
  // a listener on the first one would miss every later end)
  track.on(TrackEvent.Ended, () => onMicEnded(track));
  // livekit re-acquired it (mobile: back from the background, unmuted): the meter / hear taps hang off the
  // old capture — tap the new one
  track.on(TrackEvent.Restarted, () => {
    if (sess()?.mic === track || monitors.micTrack === track) {
      log.info("mic capture restarted by livekit — re-tapping it");
      void tapMic(track.mediaStreamTrack);
    }
  });
  return track;
}

/** A capture that never starts (an unanswered permission prompt, iOS asked while the app is in the
 *  background) must not hold the serialized mic chain forever: give up after 30 s, stop a late one. */
const CAPTURE_TIMEOUT_MS = 30_000;
function boundedCapture<T extends { stop(): unknown }>(p: Promise<T>): Promise<T> {
  let late = false;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      late = true;
      reject(new Error("the microphone didn't start within 30 s — allow microphone access and try again"));
    }, CAPTURE_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        if (late) v.stop();
        else resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * The mic's wanted state RIGHT NOW: muted by the user, push-to-talk up, or locked by a server mute
 * (AFK / BRB go through forceMicMuted → micMuted). Every mic operation publishes a new capture MUTED
 * and then applies this — so a mute pressed while a capture was pending can never be lost (Astra
 * finding 4: a device change + mute used to publish the replacement live while the UI said muted).
 */
export function micShouldMute(): boolean {
  const st = getCall();
  return st.micMuted || st.serverMuted || (st.pushToTalk && !st.pttSpeaking);
}

/**
 * Apply the latest mute intent to the session's mic. ONE runner per session: a call while it runs only
 * marks it dirty, and the runner re-reads the intent after every await until nothing changed — so a mute
 * that lands while an unmute is in flight is always applied after it (never "UI muted, track live").
 */
const micRecon = new WeakMap<Sess, { run: Promise<void>; dirty: boolean }>();
/** Tracks switched off by the fail-closed path below (re-enabled once an unmute is wanted again). */
const micForcedOff = new WeakMap<Sess, LocalAudioTrack>();
export function reconcileMic(s: Sess): Promise<void> {
  const cur = micRecon.get(s);
  if (cur) {
    cur.dirty = true;
    return cur.run;
  }
  const st = { run: Promise.resolve(), dirty: false };
  // Registered BEFORE the runner starts: when it finishes synchronously (nothing to do) its finally
  // must remove THIS entry, not run before the set and leave a finished runner behind for good.
  micRecon.set(s, st);
  st.run = (async () => {
    try {
      let failures = 0;
      for (;;) {
        // (every iteration awaits or exits: an intent that keeps flipping keeps being followed)
        st.dirty = false;
        const t = s.mic;
        if (!t || s.closing) return;
        const want = micShouldMute();
        if (!want && micForcedOff.get(s) === t) {
          // the fail-closed switch-off is lifted only when the user wants to be heard again
          micForcedOff.delete(s);
          const sent0 = t.getProcessor()?.processedTrack;
          if (sent0) sent0.enabled = true;
          t.mediaStreamTrack.enabled = true;
        }
        if (want !== t.isMuted) {
          try {
            await (want ? t.mute() : t.unmute());
            failures = 0;
          } catch (e) {
            log.warn(`mic ${want ? "mute" : "unmute"}: ${errText(e)}`);
            // back off; after 5 in a row stop trying — and a MUTE that can't be applied fails CLOSED:
            // the outgoing audio is switched off at the track (silence is sent) and the user is told.
            if (++failures >= 5) {
              if (want) {
                const sent = t.getProcessor()?.processedTrack;
                if (sent) sent.enabled = false;
                t.mediaStreamTrack.enabled = false;
                micForcedOff.set(s, t);
                setError("Couldn't mute the mic normally — its sound is switched off. Leave and rejoin if it stays stuck.");
              }
              return;
            }
            await sleep(250 * failures);
          }
          continue;
        }
        if (!st.dirty) return;
      }
    } finally {
      if (micRecon.get(s) === st) micRecon.delete(s);
    }
  })();
  return st.run;
}

/**
 * Serialize every mic operation (publish / replace / heal / reconnect) of ONE call session: one capture
 * change at a time, never overlapping. Per session: a hung step (an unanswered permission prompt) can
 * only hold up that call's mic changes — the next call starts with a fresh queue.
 */
const micChains = new WeakMap<Sess, Promise<unknown>>();
function micOp<T>(fn: () => Promise<T>, s: Sess | null = sess()): Promise<T> {
  if (!s) return fn();
  const prev = micChains.get(s) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  micChains.set(s, run.catch(() => undefined));
  return run;
}

async function publishMic(s: Sess): Promise<void> {
  const track = await createMic();
  await track.mute(); // always published muted; the latest intent is applied once it is ours
  if (s.closing) {
    track.stop();
    throw new Error("the call ended while the mic was starting");
  }
  try {
    await s.room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, name: "mic", dtx: true, red: true });
  } catch (e) {
    track.stop();
    throw e;
  }
  if (s.closing) {
    await s.room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
    track.stop();
    throw new Error("the call ended while the mic was starting");
  }
  s.mic = track;
  await reconcileMic(s);
  log.info(`mic published${track.isMuted ? " (muted)" : ""}`);
  void tapMic(track.mediaStreamTrack);
}

function sentMicTrack(t: LocalAudioTrack): MediaStreamTrack {
  return t.getProcessor()?.processedTrack ?? t.mediaStreamTrack;
}

/** Replace the mic track (device / processing change) keeping the mute state. Serialized: two quick
 * toggles (AEC then AGC) must not both publish a new track while unpublishing the same old one. */
function republishMic(reason: string): Promise<boolean> {
  const s = sess();
  if (!s) return Promise.resolve(false);
  return micOp(() => republishMicNow(reason), s);
}

let micReplacing = 0; // the healer stays out while a replacement runs
async function republishMicNow(reason: string): Promise<boolean> {
  micReplacing++;
  try {
    return await republishMicInner(reason);
  } finally {
    micReplacing--;
  }
}

async function republishMicInner(reason: string): Promise<boolean> {
  const s = sess();
  if (!s || !s.mic || s.closing) return false;
  const old = s.mic;
  let track: LocalAudioTrack | null = null;
  try {
    track = await createMic();
    if (!live(s) || s.mic !== old) {
      track.stop();
      return false;
    }
    // Published muted; the mute intent of THIS moment (not the one before the capture) is applied below.
    await track.mute();
    await s.room.localParticipant.unpublishTrack(old, true);
    s.mic = null; // the old capture is stopped: if the publish below fails, the mic healer starts a fresh one
    await s.room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, name: "mic", dtx: true, red: true });
    if (!live(s)) {
      await s.room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
      track.stop();
      return false;
    }
    s.mic = track;
    await reconcileMic(s);
    void tapMic(track.mediaStreamTrack);
    log.info(`mic re-published (${reason})`);
    return true;
  } catch (e) {
    if (track && s.mic !== track) track.stop();
    lastMicError = e;
    log.warn(`mic re-publish (${reason}) failed: ${errText(e)}`);
    return false;
  }
}

/** The last capture failure (resume: a permission / gesture refusal asks for a tap). */
let lastMicError: unknown = null;

let micRecoverDelay = 5000;
let micHealthyAt = 0;
function onMicEnded(track: LocalAudioTrack) {
  const s = sess();
  if (!s || s.mic !== track) return;
  log.warn(`mic capture ended (${pageHidden() ? "the app went to the background" : "device unplugged?"}) — re-acquiring${pageHidden() ? " once it is back" : ""}`);
  const attempt = async () => {
    const cur = sess();
    if (!cur || cur !== s || cur.mic !== track) return;
    // iOS ends the capture when the app goes to the background and refuses a new one until it is back
    // (a retry from the background only failed and doubled the back-off): wait for the return.
    if (pageHidden()) {
      await whenVisible();
      await sleep(1200);
      if (sess() !== s || s.mic !== track) return;
    }
    // livekit re-acquires an unmuted mobile mic on its own when the page is visible again
    if (!captureDead(track)) {
      log.info("mic capture is live again");
      micRecoverDelay = 5000;
      return;
    }
    if (await republishMic("capture ended")) {
      micRecoverDelay = 5000;
      micHealthyAt = Date.now();
      return;
    }
    setStatus("Mic switch failed — the mic is off for now; the app keeps retrying (or pick another input)");
    micRecoverDelay = Math.min(60000, micRecoverDelay * 2);
    s.timers.push(setTimeout(attempt, micRecoverDelay));
  };
  s.timers.push(setTimeout(attempt, pageHidden() ? 0 : micRecoverDelay));
}

let micHealBusy = false;
async function micHealthTick(s: Sess) {
  if (micHealBusy || micReplacing > 0 || sess() !== s || getCall().reconnecting) return;
  if (!s.micWanted || getCall().serverMuted) return;
  if (s.room.state !== ConnectionState.Connected) return;
  const pub = s.room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (pub?.track) {
    if (micHealthyAt && Date.now() - micHealthyAt > 120000) micRecoverDelay = 5000;
    return;
  }
  micHealBusy = true;
  try {
    await withTimeout(
      micOp(async () => {
        if (!live(s)) return;
        if (s.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track) return;
        if (s.mic) {
          await s.room.localParticipant.publishTrack(s.mic, { source: Track.Source.Microphone, name: "mic", dtx: true, red: true });
          await reconcileMic(s);
        } else await publishMic(s);
      }, s),
      6000,
      "mic re-publish timed out",
    );
    log.info("[mic-heal] the mic is published again");
  } catch (e) {
    log.warn(`[mic-heal] ${errText(e)}`);
  } finally {
    micHealBusy = false;
  }
}

export function toggleMic(): void {
  const st = getCall();
  if (st.serverMuted && (st.inCall || st.connecting)) {
    setStatus(`${st.serverMutedBy || "A moderator"} muted your mic for everyone — ask them to unmute you`);
    return;
  }
  for (const h of hooks.onUserMicToggle) h();
  forceMicMuted(!st.micMuted);
}

export function forceMicMuted(muted: boolean): void {
  const st = getCall();
  if (st.connecting && !st.inCall) pressedMuteWhileConnecting = muted;
  patch({ micMuted: muted });
  const s = sess();
  // The store holds the intent; a capture still being published applies it the moment it lands
  // (reconcileMic after every publish), and a server lock keeps the mic muted (micShouldMute).
  if (s?.mic) void reconcileMic(s);
}

export function applyPushToTalk(on: boolean): void {
  setPref("push-to-talk", on);
  patch({ pushToTalk: on, pttSpeaking: false });
  if (on) forceMicMuted(true);
}

export function pttHold(down: boolean): void {
  const st = getCall();
  if (!st.pushToTalk) return;
  if (st.pttSpeaking === down) return;
  patch({ pttSpeaking: down });
  if (!st.inCall && !st.connecting) return;
  forceMicMuted(!down);
}

export async function reconnectMic(): Promise<boolean> {
  const s = sess();
  if (!s) return false;
  setStatus("Reconnecting your mic…");
  let ok = false;
  if (s.mic) ok = await republishMic("reconnect");
  else {
    ok = await micOp(async () => {
      if (!live(s) || s.mic) return !!s.mic;
      await publishMic(s);
      return true;
    }, s).catch(() => false);
  }
  if (sess() !== s) return false; // the call changed meanwhile: its own checks decide
  setStatus(ok ? "Mic reconnected" : "Couldn't reconnect the mic — the app keeps trying");
  if (ok && getCall().needsTap === "mic") patch({ needsTap: "" });
  return ok;
}

// ---- devices -------------------------------------------------------------------------------------------------

async function enumerate(kind: MediaDeviceKind): Promise<Dev[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d, i) => ({ id: d.deviceId, name: d.label || `${kind === "audioinput" ? "Microphone" : kind === "audiooutput" ? "Speaker" : "Camera"} ${i + 1}` }));
  } catch {
    return [];
  }
}

export async function refreshInputs(): Promise<void> {
  const list = await enumerate("audioinput");
  const id = getPref("call-input", "");
  const cur = list.find((d) => d.id === id);
  patch({ inputs: list, inputName: cur ? cur.name : "System default" });
}

export async function refreshOutputs(): Promise<void> {
  const list = audio.outputRoutingSupported() ? await enumerate("audiooutput") : [];
  const id = getPref("call-output", "");
  const cur = list.find((d) => d.id === id);
  const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  const anyOut = all.some((d) => d.kind === "audiooutput") || !audio.outputRoutingSupported();
  patch({ outputs: list, outputName: cur ? cur.name : "System default", outputMissing: !anyOut && getCall().inCall });
}

export async function refreshCameras(): Promise<void> {
  const list = await enumerate("videoinput");
  const id = getPref("call-camera", "");
  const cur = list.find((d) => d.id === id);
  patch({ cameras: list, cameraName: cur ? cur.name : "Default (first camera)" });
}

export function setInput(id: string): void {
  const prev = getPref("call-input", "");
  setPref("call-input", id === "default" ? "" : id);
  void refreshInputs();
  const s = sess();
  if (s?.mic) {
    void republishMic("input change").then((ok) => {
      if (!ok) {
        setPref("call-input", prev);
        void refreshInputs();
        setStatus("Mic switch failed — still using the previous microphone");
      }
    });
  } else if (monitors.mic) {
    void startMicMonitor(true);
  }
}

export function setOutput(id: string): void {
  setPref("call-output", id === "default" ? "" : id);
  void refreshOutputs();
  void audio.applyOutputDevice();
}

export function setCamera(id: string): void {
  setPref("call-camera", id === "default" ? "" : id);
  void refreshCameras();
  const s = sess();
  if (s?.cam) {
    const q = parseCamQuality(getCall().camQuality);
    s.cam
      .restartTrack({ deviceId: id || undefined, resolution: { width: q.w, height: q.h, frameRate: q.fps } })
      .then(() => {
        patch({ selfviewGen: getCall().selfviewGen + 1 });
        reattach("vid_selfview");
      })
      .catch(() => setStatus("Camera switch failed — try another camera or toggle it off/on"));
  }
}

let devWatch = false;
export function watchDevices(): void {
  if (devWatch || !navigator.mediaDevices?.addEventListener) return;
  devWatch = true;
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void refreshAudioSources();
    void refreshInputs();
    void refreshOutputs();
    void refreshCameras();
  });
}

// ---- mic processing toggles ------------------------------------------------------------------------------------

export function applyMicAec(on: boolean): void {
  setPref("mic-echo-cancel", on);
  patch({ micAec: on });
  if (sess()?.mic) void republishMic("echo cancellation");
  else if (monitors.mic) void startMicMonitor(true);
}

export function applyMicAgc(on: boolean): void {
  setPref("mic-agc", on);
  patch({ micAgc: on });
  if (sess()?.mic) void republishMic("auto gain");
  else if (monitors.mic) void startMicMonitor(true);
}

export function applyMicNsMode(mode: "off" | "standard" | "strong"): void {
  const prev = getCall().micNsMode;
  if (mode === "strong" && !getCall().ncAvailable) {
    setStatus(`Noise suppression could not be changed — back to ${nsLabel(prev)}`);
    return;
  }
  setPref("mic-ns-mode", mode);
  patch({ micNsMode: mode });
  if (sess()?.mic) {
    void republishMic("noise suppression").then(async (ok) => {
      if (!ok || (mode === "strong" && !getCall().ncAvailable)) {
        setPref("mic-ns-mode", prev);
        patch({ micNsMode: prev });
        if (ok) await republishMic("noise suppression revert");
        setStatus(`Noise suppression could not be changed — back to ${nsLabel(prev)}`);
      }
    });
  } else if (monitors.mic) void startMicMonitor(true);
}

function nsLabel(m: string) {
  return m === "strong" ? "Strong" : m === "standard" ? "Standard" : "Off";
}

// ---- monitors (meters outside a call) ------------------------------------------------------------------------------

const monitors = { mic: false, output: false, micTrack: null as LocalAudioTrack | null };

export async function startMicMonitor(restart = false): Promise<void> {
  monitors.mic = true;
  ensureLevelLoop();
  if (sess()?.mic) return; // the call's own mic feeds the meter
  if (monitors.micTrack && !restart) return;
  monitors.micTrack?.stop();
  monitors.micTrack = null;
  try {
    const t = await createMic();
    if (!monitors.mic) {
      t.stop();
      return;
    }
    monitors.micTrack = t;
    void tapMic(t.mediaStreamTrack);
  } catch (e) {
    log.warn(`mic monitor: ${errText(e)}`);
  }
}

export function stopMicMonitor(): void {
  monitors.mic = false;
  monitors.micTrack?.stop();
  monitors.micTrack = null;
  if (!sess()) {
    micTapClose?.();
    micTapClose = null;
    patch({ micLevel: 0, micLevelPre: 0 });
    if (!monitors.output) audio.idleContext();
  }
  ensureLevelLoop();
}

export function startOutputMonitor(): void {
  monitors.output = true;
  ensureLevelLoop();
  audio.audioContext();
}

export function stopOutputMonitor(): void {
  monitors.output = false;
  patch({ outputLevel: 0 });
  if (!sess() && !monitors.mic) audio.idleContext();
  ensureLevelLoop();
}

// GPU.md §2.7 / §2.8: the level loop feeds only what is drawn — the speaking rings, the waveforms and the meters. It
// runs (66 ms) while the window is focused AND a call or an open meter needs it, and stops otherwise with every level
// back at 0, so rings and bars rest; the ≈ 15 store updates/s of a silent call are gone while unfocused. (hear.ts's
// own analyser — muted-talk, heard-by — and LiveKit's active speakers — the voice HUD — do not use it.)
// In a call it also stops once nobody has been audible for ~0.7 s (the bars are back at rest) and a frame loud enough
// to light a ring wakes it again (wakeLevels, from the remote and mic taps) — a silent call runs no level timer.
let levelTimer: ReturnType<typeof setInterval> | null = null;
let quietTicks = 0;
const QUIET_STOP_TICKS = 10;
/** a raw tap frame this loud shows as a speaking level (the store shows levels × 3; SPEAKING_LEVEL = 0.02) */
const LEVEL_WAKE_RAW = SPEAKING_LEVEL / 3;
const levelLoopWanted = () => winFocused() && (!!sess() || monitors.mic || monitors.output);
function ensureLevelLoop() {
  if (!levelLoopWanted()) return stopLevelLoop();
  if (levelTimer) return;
  quietTicks = 0;
  levelTimer = setInterval(() => {
    if (!levelLoopWanted()) return stopLevelLoop();
    levelsTick();
    if (monitors.mic || monitors.output) return; // an open meter keeps it (it shows the quiet floor too)
    const st = getCall();
    const loud = st.micLevel > SPEAKING_LEVEL || st.outputLevel > SPEAKING_LEVEL || Object.values(st.audioLevels).some((v) => v > SPEAKING_LEVEL);
    quietTicks = loud ? 0 : quietTicks + 1;
    if (quietTicks >= QUIET_STOP_TICKS) stopLevelLoop();
  }, 66);
}
/** A tap frame arrived (remote or mic, raw RMS): wake the level loop if it is loud enough to show. */
function wakeLevels(raw: number): void {
  if (raw > LEVEL_WAKE_RAW && !levelTimer) ensureLevelLoop();
}
audio.setLevelWake(wakeLevels);
function stopLevelLoop() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  const st = getCall();
  const next: Partial<CallState> = {};
  if (Object.keys(st.audioLevels).length) next.audioLevels = {};
  if (st.micLevel) next.micLevel = 0;
  if (st.micLevelPre) next.micLevelPre = 0;
  if (st.outputLevel) next.outputLevel = 0;
  if (Object.keys(next).length) useCallStore.setState(next);
}

// ---- camera ------------------------------------------------------------------------------------------------------

export function parseCamQuality(q: string) {
  const [w, h, fps, kbps, sim] = q.split(/\s+/).map((x) => Number(x));
  return {
    w: w || 1280,
    h: h || 720,
    fps: fps || 30,
    kbps: kbps || 2500,
    sim: sim === undefined || Number.isNaN(sim) ? true : sim !== 0,
  };
}

function camPublishOptions(): TrackPublishOptions {
  const q = parseCamQuality(getCall().camQuality);
  const big = Math.max(q.w, q.h) >= 1920;
  return {
    source: Track.Source.Camera,
    name: "camera",
    videoCodec: "vp8",
    simulcast: q.sim,
    videoEncoding: { maxBitrate: q.kbps * 1000, maxFramerate: q.fps },
    videoSimulcastLayers: [
      new VideoPreset(Math.round(q.w / 4), Math.round(q.h / 4), 150_000, 15),
      new VideoPreset(Math.round(q.w / 2), Math.round(q.h / 2), (big ? 700 : 450) * 1000, 20),
    ],
    degradationPreference: "balanced",
  };
}

let camDiedAt = 0;
let camOp = 0; // bumped by every stop: a start that was still acquiring stands down
async function startCamera(s: Sess): Promise<boolean> {
  const op = ++camOp;
  const q = parseCamQuality(getCall().camQuality);
  const dev = getPref("call-camera", "");
  const facing = getPref("call-facing", "");
  const track = await createLocalVideoTrack({
    deviceId: dev ? { ideal: dev } : undefined,
    facingMode: !dev && (facing === "environment" || facing === "user") ? facing : undefined,
    resolution: { width: q.w, height: q.h, frameRate: q.fps },
  });
  if (op !== camOp || sess() !== s) {
    track.stop();
    return false;
  }
  try {
    await s.room.localParticipant.publishTrack(track, camPublishOptions());
  } catch (e) {
    track.stop();
    throw e;
  }
  if (op !== camOp || sess() !== s) {
    await s.room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
    track.stop();
    return false;
  }
  s.cam = track;
  track.on(TrackEvent.Ended, () => onCameraEnded(track));
  patch({ cameraOn: true, selfviewGen: getCall().selfviewGen + 1, cameraName: dev ? track.mediaStreamTrack.label : "Default (first camera)" });
  reattach("vid_selfview");
  return true;
}

async function stopCamera(s: Sess): Promise<void> {
  camOp++;
  const t = s.cam;
  s.cam = null;
  patch({ cameraOn: false, selfviewGen: getCall().selfviewGen + 1 });
  if (t) {
    const el = attached.get("vid_selfview");
    if (el) t.detach(el);
    await s.room.localParticipant.unpublishTrack(t, true).catch(() => undefined);
    t.stop();
  }
}

function onCameraEnded(track: LocalVideoTrack) {
  const s = sess();
  if (!s || s.cam !== track) return;
  if (pageHidden()) {
    // iOS stops the camera in the background: restart it when the app is back (resume.ts checks too)
    log.info("camera capture ended while the app is in the background — restarting it on return");
    void whenVisible().then(() => {
      if (sess() === s && s.cam === track && track.mediaStreamTrack.readyState !== "live") void restartCameraCapture(s, "back from the background");
    });
    return;
  }
  const now = Date.now();
  if (now - camDiedAt < 10000) {
    void stopCamera(s);
    setStatus(
      "Camera feed keeps dying — if this is a virtual camera (NVIDIA Broadcast), make sure its input camera isn't in use by another app (or by this one).",
    );
    return;
  }
  camDiedAt = now;
  setStatus("Camera feed died — retrying in a moment (virtual cameras can take a few seconds to start)…");
  s.timers.push(
    setTimeout(async () => {
      if (sess() !== s || s.cam !== track) return;
      try {
        await s.room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
        s.cam = null;
        await startCamera(s);
        setStatus("Camera restarted — waiting for video…");
      } catch (e) {
        patch({ cameraOn: false });
        setStatus(`Camera retry failed: ${errText(e)}`);
      }
    }, 2500),
  );
}

// Camera stalled (frames flat ≥ 3 s, stats.ts): restart ≤ 1 per 20 s, ≤ 3 per 10 min (call_ctl.rs:1440-1515).
const camStalls: number[] = [];
let camStallGaveUp = false;
export function onCameraStalled(): void {
  const s = sess();
  if (!s?.cam) return;
  const now = Date.now();
  while (camStalls.length && now - camStalls[0] > 600000) camStalls.shift();
  if (camStalls.length && now - camStalls[camStalls.length - 1] < 20000) return;
  if (camStalls.length >= 3) {
    if (!camStallGaveUp) {
      camStallGaveUp = true;
      setStatus("Camera keeps stalling — try another USB port or camera, or turn it off and on");
    }
    return;
  }
  camStalls.push(now);
  setStatus("Camera stalled — restarting its capture…");
  const q = parseCamQuality(getCall().camQuality);
  const dev = getPref("call-camera", "");
  const cam = s.cam;
  void cam
    .restartTrack({ deviceId: dev || undefined, resolution: { width: q.w, height: q.h, frameRate: q.fps } })
    .then(() => {
      if (sess() !== s || s.cam !== cam) return;
      patch({ selfviewGen: getCall().selfviewGen + 1 });
      reattach("vid_selfview");
    })
    .catch((e) => setStatus(`Camera restart failed: ${errText(e)}`));
}

export function toggleCamera(): void {
  const s = sess();
  if (!s) return;
  camStallGaveUp = false;
  camStalls.length = 0;
  if (s.cam || getCall().cameraOn) {
    void stopCamera(s).then(() => setStatus("Camera off"));
    return;
  }
  patch({ cameraOn: true });
  startCamera(s)
    .then((ok) => ok && setStatus("Camera on"))
    .catch((e) => {
      patch({ cameraOn: false });
      setStatus(`Camera failed: ${errText(e)}`);
    });
}

/** Mobile: flip between the front and back camera. */
export function flipCamera(): void {
  const cur = getPref("call-facing", "user");
  const next = cur === "environment" ? "user" : "environment";
  setPref("call-facing", next);
  const s = sess();
  if (s?.cam) {
    void s.cam.restartTrack({ facingMode: next }).then(() => {
      patch({ selfviewGen: getCall().selfviewGen + 1 });
      reattach("vid_selfview");
    });
  }
}

export function applyCamQuality(w: number, h: number, fps: number, kbps: number): void {
  const cur = parseCamQuality(getCall().camQuality);
  const q = `${w} ${h} ${fps} ${kbps} ${cur.sim ? 1 : 0}`;
  setPref("cam-quality", q);
  patch({ camQuality: q });
  void restartCameraPublish("Camera quality applied");
}

export function applyCamSimulcast(on: boolean): void {
  const cur = parseCamQuality(getCall().camQuality);
  const q = `${cur.w} ${cur.h} ${cur.fps} ${cur.kbps} ${on ? 1 : 0}`;
  setPref("cam-quality", q);
  patch({ camQuality: q });
  void restartCameraPublish("Camera quality applied");
}

async function restartCameraPublish(msg: string) {
  const s = sess();
  if (!s) return;
  // The camera is still starting (switched on a moment ago): let that start finish, then re-publish.
  for (let i = 0; i < 20 && !s.cam && getCall().cameraOn && sess() === s; i++) await sleep(250);
  if (!s.cam || sess() !== s) return;
  try {
    await stopCamera(s);
    await startCamera(s);
    setStatus(msg);
  } catch (e) {
    patch({ cameraOn: false });
    setStatus(`Camera restart failed: ${errText(e)}`);
  }
}

// ---- screen share ---------------------------------------------------------------------------------------------------

export interface ShareQ {
  w: number;
  h: number;
  fps: number;
  kbps: number;
  enc: string;
}

export function parseShareQuality(q: string): ShareQ {
  const parts = q.split(/\s+/);
  const n = (i: number, d: number) => {
    const v = Number(parts[i]);
    return Number.isFinite(v) ? v : d;
  };
  return { w: n(0, 1920), h: n(1, 1080), fps: Math.max(1, Math.min(120, n(2, 30))), kbps: Math.max(500, n(3, 12000)), enc: parts[4] || "nvenc" };
}

function shareCodec(enc: string): VideoCodec {
  return enc === "vp9" ? "vp9" : "h264";
}

/** Auto mode rung (share auto-fit governor state, see stats.ts). */
export const shareAuto = { w: 1920, h: 1080, kbps: 12000 };

export function shareBox(q: ShareQ): { w: number; h: number; kbps: number } {
  if (q.w === 0 || q.h === 0) return { w: shareAuto.w, h: shareAuto.h, kbps: shareAuto.kbps };
  return { w: Math.min(4096, q.w), h: Math.min(4096, q.h), kbps: q.kbps };
}

function sharePublishOptions(q: ShareQ, box: { kbps: number }): TrackPublishOptions {
  const codec = shareCodec(q.enc);
  return {
    source: Track.Source.ScreenShare,
    name: "screen",
    videoCodec: codec,
    backupCodec: false,
    simulcast: false,
    ...(codec === "vp9" ? { scalabilityMode: "L1T1" as const } : {}),
    videoEncoding: { maxBitrate: box.kbps * 1000, maxFramerate: q.fps },
    screenShareEncoding: { maxBitrate: box.kbps * 1000, maxFramerate: q.fps },
    degradationPreference: "maintain-resolution",
  };
}

async function fitTrack(track: MediaStreamTrack, q: ShareQ): Promise<void> {
  const box = shareBox(q);
  const set = track.getSettings();
  const sw = set.width ?? box.w;
  const sh = set.height ?? box.h;
  const scale = Math.min(1, box.w / sw, box.h / sh);
  const w = Math.max(16, Math.floor((sw * scale) / 16) * 16);
  const h = Math.max(16, Math.floor((sh * scale) / 16) * 16);
  try {
    await track.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: q.fps } });
  } catch (e) {
    log.debug(`share applyConstraints: ${errText(e)}`);
  }
}

/** Some capturers ignore applyConstraints (and even report the constrained size): 2 s after a (re-)fit,
 * compare the ENCODED frame size with the box and scale down at the encoder if it is still too big. */
function enforceShareBox(s: Sess, box: { w: number; h: number }) {
  s.timers.push(
    setTimeout(async () => {
      const snd = s.screen?.sender;
      if (!snd || sess() !== s) return;
      let fw = 0;
      let fh = 0;
      try {
        (await snd.getStats()).forEach((v) => {
          const r = v as Record<string, unknown>;
          if (r.type === "outbound-rtp" && Number(r.frameWidth) > 0) {
            fw = Number(r.frameWidth);
            fh = Number(r.frameHeight);
          }
        });
      } catch {
        return;
      }
      const over = Math.max(fw / box.w, fh / box.h);
      if (!fw || over <= 1.05) return;
      const p = snd.getParameters();
      for (const e of p.encodings ?? []) e.scaleResolutionDownBy = (e.scaleResolutionDownBy ?? 1) * over;
      await snd.setParameters(p).catch(() => undefined);
      log.info(`[share] capturer ignored the ${box.w}x${box.h} box (sending ${fw}x${fh}) — encoder scale ×${over.toFixed(2)}`);
    }, 2000),
  );
}

/** Bumped by every share start AND stop: a start still in the picker / publish stands down (Astra 5). */
let shareOp = 0;

export async function shareScreen(opts: ShareOptions = {}): Promise<void> {
  const s = sess();
  if (!s) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Share failed: your browser can't share the screen");
    return;
  }
  const op = ++shareOp; // taken BEFORE any await: a Stop from here on cancels this start
  const superseded = () => op !== shareOp || !live(s);
  if (s.screen) {
    // "Change what you're sharing…": a new pick, then replace the track (re-prompts).
    await takeDownScreen(s, true);
    if (superseded()) return;
  }
  setStatus("Preparing screen share…");
  if (opts.quality) applyShareQualityPref(opts.quality.w, opts.quality.h, opts.quality.fps, opts.quality.kbps, false);
  const q = parseShareQuality(getCall().shareQuality);
  const box = shareBox(q);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: box.w }, height: { max: box.h }, frameRate: { max: q.fps } },
      audio: opts.audio === "browser",
      // Chromium extras (ignored elsewhere)
      ...({ selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include" } as object),
    } as DisplayMediaStreamOptions);
  } catch (e) {
    if (!superseded()) setStatus(`Share failed: ${errText(e)}`);
    return;
  }
  // Every exit below that doesn't keep the share stops EVERY track the picker gave us.
  const dropStream = () => stream.getTracks().forEach((t) => t.stop());
  if (superseded()) {
    dropStream();
    return;
  }
  const vt = stream.getVideoTracks()[0];
  if (!vt) {
    dropStream();
    setStatus("Share failed: no video track");
    return;
  }
  vt.contentHint = q.enc === "vp9" ? "detail" : "motion";
  await fitTrack(vt, q);
  if (superseded()) {
    dropStream();
    return;
  }
  const track = new LocalVideoTrack(vt, undefined, true);
  try {
    await s.room.localParticipant.publishTrack(track, sharePublishOptions(q, box));
  } catch (e) {
    dropStream();
    if (!superseded()) setStatus(`Share failed: ${errText(e)}`);
    return;
  }
  if (superseded() || s.screen) {
    // A stop / newer share / hang-up happened while this one published: it must not stay live.
    await s.room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
    dropStream();
    return;
  }
  s.screen = track;
  enforceShareBox(s, box);
  vt.addEventListener("ended", () => {
    // (compare the MediaStreamTrack: a codec change re-wraps it in a new LocalVideoTrack)
    if (sess()?.screen?.mediaStreamTrack === vt) {
      void stopScreen().then(() => setStatus("Screen share ended — the shared window closed"));
    }
  });
  patch({ sharing: true, shareRecOnly: !!opts.recordingOnly || getCall().shareRecOnly });
  const at = stream.getAudioTracks()[0];
  if (at) {
    s.screenAudio = at;
    const mop = ++musicOp;
    void publishMusicTrack(at, "share audio", undefined, s, mop).catch((e) => setStatus(`Audio share failed: ${errText(e)}`));
  }
  else if (opts.audio === "device" && opts.audioDeviceId) void startMusicSource(opts.audioDeviceId);
  reattach("vid_selfshare");
  for (const h of hooks.onShareChanged) h(s);
  setStatus("Sharing screen");
}

export async function stopScreen(quiet = false): Promise<void> {
  shareOp++; // a start / codec re-publish still in flight stands down
  const s = sess();
  if (!s) return;
  await takeDownScreen(s, quiet);
}

/** Unpublish + stop the current share (and its audio) without touching the operation token. */
async function takeDownScreen(s: Sess, quiet: boolean): Promise<void> {
  const t = s.screen;
  s.screen = null;
  if (t) {
    const el = attached.get("vid_selfshare");
    if (el) t.detach(el);
    await s.room.localParticipant.unpublishTrack(t, true).catch(() => undefined);
    t.stop();
  }
  if (s.screenAudio) {
    const at = s.screenAudio;
    s.screenAudio = null;
    if (s.music && s.music.mediaStreamTrack === at) await stopMusic(true);
    at.stop();
  }
  patch({ sharing: false });
  for (const h of hooks.onShareChanged) h(s);
  if (!quiet) setStatus("In call");
}

function applyShareQualityPref(w: number, h: number, fps: number, kbps: number, live = true) {
  const cur = parseShareQuality(getCall().shareQuality);
  const q = `${w} ${h} ${fps} ${kbps} ${cur.enc}`;
  setPref("share-quality", q);
  patch({ shareQuality: q });
  if (live) void reapplyShare(false);
}

export function applyShareQuality(w: number, h: number, fps: number, kbps: number): void {
  applyShareQualityPref(w, h, fps, kbps, true);
}

export function applyShareEncoder(code: string): void {
  const cur = parseShareQuality(getCall().shareQuality);
  const enc = code === "vp9" ? "vp9" : code === "h264" ? "h264" : "nvenc";
  const q = `${cur.w} ${cur.h} ${cur.fps} ${cur.kbps} ${enc}`;
  setPref("share-quality", q);
  patch({ shareQuality: q });
  void reapplyShare(shareCodec(cur.enc) !== shareCodec(enc));
}

/** Re-apply the quality to a live share (size/fps via constraints, bitrate via the sender; codec = re-publish). */
/** Per call session: quality/codec re-applies run one at a time, bound to the session that asked. */
const shareReapply = new WeakMap<Sess, Promise<unknown>>();
/** Re-apply the quality to a live share — one at a time (two codec re-publishes never wrap the same capture). */
export function reapplyShare(codecChanged: boolean): Promise<void> {
  const s = sess();
  if (!s) return Promise.resolve();
  const run = () => reapplyShareNow(codecChanged, s);
  const p = (shareReapply.get(s) ?? Promise.resolve()).then(run, run);
  shareReapply.set(s, p.catch(() => undefined));
  return p;
}

async function reapplyShareNow(codecChanged: boolean, s: Sess): Promise<void> {
  if (!live(s) || !s.screen) return;
  const q = parseShareQuality(getCall().shareQuality);
  const box = shareBox(q);
  const mst = s.screen.mediaStreamTrack;
  const op = shareOp;
  const superseded = () => op !== shareOp || !live(s) || s.screen?.mediaStreamTrack !== mst;
  try {
    mst.contentHint = q.enc === "vp9" ? "detail" : "motion";
    await fitTrack(mst, q);
    if (superseded()) return;
    if (codecChanged) {
      const old = s.screen!;
      await s.room.localParticipant.unpublishTrack(old, false);
      if (superseded()) return;
      const track = new LocalVideoTrack(mst, undefined, true);
      await s.room.localParticipant.publishTrack(track, sharePublishOptions(q, box));
      if (op !== shareOp || !live(s) || s.screen !== old) {
        // stopped / replaced / hung up while re-publishing: this publication must not stay live (unpublish
        // only — the capture underneath belongs to whoever owns the share now, or was already stopped)
        await s.room.localParticipant.unpublishTrack(track, false).catch(() => undefined);
        return;
      }
      s.screen = track;
      enforceShareBox(s, box);
      reattach("vid_selfshare");
      for (const h of hooks.onShareChanged) h(s);
    } else {
      const sender = s.screen.sender;
      if (sender) {
        // Some capturers ignore applyConstraints: scale at the encoder instead so the box still holds.
        const set = mst.getSettings();
        const over = Math.max(1, (set.width ?? 0) / box.w, (set.height ?? 0) / box.h);
        log.info(`[share] re-fit to ${box.w}x${box.h} @ ${box.kbps} kbps (source ${set.width}x${set.height})`);
        const p = sender.getParameters();
        for (const e of p.encodings ?? []) {
          e.maxBitrate = box.kbps * 1000;
          e.maxFramerate = q.fps;
          e.scaleResolutionDownBy = over > 1.01 ? over : 1;
        }
        await sender.setParameters(p);
        enforceShareBox(s, box);
      }
    }
  } catch (e) {
    patch({ sharing: false });
    setStatus(`Share restart failed: ${errText(e)}`);
  }
}

// ---- second audio track (music / share audio) + sound ------------------------------------------------------------------

/** Bumped by every music / audio-share start AND by stopMusic (Astra 5). */
let musicOp = 0;
let musicChain: Promise<unknown> = Promise.resolve();

/**
 * Publish `mst` into the one "music" slot (music / share audio). Serialized, and owned by the call
 * session + music operation that started it: a start that was superseded (stop, a newer start, a
 * hang-up) while it published unpublishes and stops its own track — no second publication survives.
 */
function publishMusicTrack(mst: MediaStreamTrack, why: string, onStop: (() => void) | undefined, owner: Sess | null, op: number): Promise<void> {
  const run = async () => {
    const s = sess();
    const stale = () => !s || owner !== s || !live(s) || op !== musicOp;
    const drop = () => {
      mst.stop();
      onStop?.();
    };
    // The picker / file load took a while: the call it was started in may be gone (or another one live).
    if (!s || stale()) {
      drop();
      if (op === musicOp) patch({ musicPlaying: false });
      return;
    }
    await unpublishMusic(s);
    const t = new LocalAudioTrack(mst, undefined, true);
    try {
      await s.room.localParticipant.publishTrack(t, {
        source: Track.Source.ScreenShareAudio,
        name: "music",
        dtx: false,
        red: false,
        audioPreset: { maxBitrate: 128_000 },
        forceStereo: true,
      });
    } catch (e) {
      drop();
      throw e;
    }
    if (stale()) {
      await s.room.localParticipant.unpublishTrack(t, false).catch(() => undefined);
      drop();
      return;
    }
    s.music = t;
    s.musicStop = onStop ?? null;
    patch({ musicPlaying: true });
    log.info(`music slot: ${why}`);
  };
  const p = musicChain.then(run, run);
  musicChain = p.catch(() => undefined);
  return p;
}

/** Take whatever is in the music slot down (no operation bump — publishMusicTrack's own replace). */
async function unpublishMusic(s: Sess): Promise<void> {
  const t = s.music;
  const stop = s.musicStop;
  s.music = null;
  s.musicStop = null;
  if (t) await s.room.localParticipant.unpublishTrack(t, false).catch(() => undefined);
  stop?.();
}

export async function stopMusic(quiet = false): Promise<void> {
  musicOp++; // a start still in flight stands down
  const s = sess();
  if (!s) {
    patch({ musicPlaying: false });
    return;
  }
  await unpublishMusic(s);
  patch({ musicPlaying: false });
  if (!quiet && getCall().inCall) setStatus("In call");
}

/** Music from a file or a (CORS-enabled) URL through WebAudio → the "music" slot. */
export async function startMusic(src: File | string): Promise<void> {
  if (!sess() || !getCall().inCall) {
    setStatus("Join a call to play music");
    return;
  }
  patch({ musicPlaying: true });
  setStatus("Playing music…");
  const owner = sess();
  const op = ++musicOp;
  try {
    const c = audio.audioContext();
    const gen = audio.contextGen();
    const el = new Audio();
    el.crossOrigin = "anonymous";
    const url = typeof src === "string" ? src : URL.createObjectURL(src);
    el.src = url;
    const node = c.createMediaElementSource(el);
    const dest = c.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);
    await el.play().catch((e: unknown) => {
      throw typeof src === "string" ? new Error("That site doesn't allow its audio to be streamed from a browser") : e;
    });
    const mst = dest.stream.getAudioTracks()[0];
    if (audio.contextGen() !== gen) {
      el.pause();
      throw new Error("the call's sound restarted while the music was starting — start it again");
    }
    ctxBoundMusic.add(mst);
    const cleanup = () => {
      el.pause();
      node.disconnect();
      if (typeof src !== "string") URL.revokeObjectURL(url);
    };
    await publishMusicTrack(mst, "music", cleanup, owner, op);
    if (audio.contextGen() !== gen && sess()?.music?.mediaStreamTrack === mst) {
      void stopMusic(true);
      setStatus("Your music stopped when the call's sound restarted — start it again");
      return;
    }
    el.addEventListener("ended", () => {
      if (sess()?.music?.mediaStreamTrack === mst) void stopMusic();
    });
  } catch (e) {
    if (op === musicOp) {
      patch({ musicPlaying: false });
      setStatus(`Music failed: ${errText(e)}`);
    }
  }
}

/** Can this browser capture tab/system audio through getDisplayMedia? (Chromium yes; Firefox/Safari no.) */
function displayAudioSupported(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return false;
  const ua = navigator.userAgent;
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Mobile/.test(ua);
}

const TAB_SOURCE: Dev = { id: "tab", name: "A browser tab or the whole screen's audio (you pick)" };

/** "Share audio output ▸" sources: tab/system capture (Chromium) + every audio input (loopback / virtual cables). */
export async function refreshAudioSources(): Promise<void> {
  const inputs = await enumerate("audioinput");
  const list = [...(displayAudioSupported() ? [TAB_SOURCE] : []), ...inputs];
  const id = getPref("music-source", "");
  patch({ audioSources: list, musicSourceName: list.find((d) => d.id === id)?.name ?? "" });
}

/** Share audio: tab/system capture (getDisplayMedia audio) or an audio input device (music slot). */
export async function startMusicSource(id: string): Promise<void> {
  setPref("music-source", id);
  const known = getCall().audioSources.find((d) => d.id === id);
  patch({ musicSourceName: id === "tab" ? TAB_SOURCE.name : known?.name ?? id });
  if (!sess() || !getCall().inCall) {
    setStatus("Join a call to share audio");
    return;
  }
  if (!id) {
    setStatus("Pick an audio source to share");
    return;
  }
  patch({ musicPlaying: true });
  setStatus("Sharing audio…");
  const owner = sess();
  const op = ++musicOp;
  try {
    let at: MediaStreamTrack | undefined;
    if (id === "tab") {
      if (!displayAudioSupported()) throw new Error("Your browser can't share audio");
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, ...({ systemAudio: "include" } as object) } as DisplayMediaStreamOptions);
      stream.getVideoTracks().forEach((t) => t.stop());
      at = stream.getAudioTracks()[0];
      if (!at) throw new Error("no audio was shared — tick “Share audio” in the browser's picker");
    } else {
      // An audio input (loopback / virtual cable / monitor device): raw, stereo, no voice processing.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
      });
      at = stream.getAudioTracks()[0];
      if (!at) throw new Error("that audio source gave no sound track");
    }
    await publishMusicTrack(at, "share audio", () => at!.stop(), owner, op);
    at.addEventListener("ended", () => {
      if (sess()?.music?.mediaStreamTrack === at) void stopMusic();
    });
  } catch (e) {
    if (op === musicOp) {
      patch({ musicPlaying: false });
      setStatus(`Audio share failed: ${errText(e)}`);
    }
  }
}

function clipUrl(src: string): string {
  if (/^(blob:|data:)/.test(src)) return src;
  // Stored upload URLs are absolute on the server that took them (a Tin Hat Server: this page's origin); the API
  // sends no CORS headers — always play through this origin's /api.
  if (src.startsWith(`${location.origin}/api/`) || src.startsWith(apiUrl("/"))) return src;
  if (!/^[a-z]+:/i.test(src) || /myinstants\.com/i.test(src)) return apiUrl(`/soundboard/clip?url=${encodeURIComponent(src)}`);
  return src;
}

/** Bumped by every sound start AND by stopSound — a start that was superseded while it published stands down. */
let soundOp = 0;
let soundChain: Promise<unknown> = Promise.resolve();

/**
 * Soundboard / join sound: a one-shot "sound" track (Unknown source); stop-then-replace. 10.8 (leak track, desktop
 * call.rs store_aux): serialized like the music slot — two plays that overlapped the publish (a double click, a join
 * sound during a soundboard play) used to leave the first track PUBLISHED for the rest of the call (the second one
 * overwrote `s.sound`, and the first one's end only stopped the slot's CURRENT track), so every receiver kept a silent
 * subscription (on desktop receivers: a playback pipeline and an E2EE thread each).
 */
export function playSound(url: string, maxMs = 0): Promise<void> {
  const op = ++soundOp;
  const run = () => playSoundNow(url, maxMs, op);
  const p = soundChain.then(run, run);
  soundChain = p.catch(() => undefined);
  return p;
}

async function playSoundNow(url: string, maxMs: number, op: number): Promise<void> {
  if (op !== soundOp) return; // a newer play or a stop came in while this one queued
  const s = sess();
  if (!s || !getCall().inCall) return;
  if (getCall().serverMuted) {
    setError("A moderator muted you for everyone — sounds are off until you're unmuted");
    return;
  }
  await takeSoundDown(s);
  try {
    const c = audio.audioContext();
    const gen = audio.contextGen();
    const buf = url.startsWith("mxc://") ? await (await fetchMedia(url)).arrayBuffer() : await (await fetch(clipUrl(url))).arrayBuffer();
    const decoded = await c.decodeAudioData(buf);
    if (sess() !== s || audio.contextGen() !== gen) return; // (a replaced context would publish silence)
    const node = c.createBufferSource();
    node.buffer = decoded;
    const dest = c.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);
    const mst = dest.stream.getAudioTracks()[0];
    const t = new LocalAudioTrack(mst, undefined, true);
    await s.room.localParticipant.publishTrack(t, {
      source: Track.Source.Unknown,
      name: "sound",
      dtx: false,
      red: false,
      audioPreset: { maxBitrate: 128_000 },
      forceStereo: true,
    });
    if (audio.contextGen() !== gen || op !== soundOp || sess() !== s) {
      await s.room.localParticipant.unpublishTrack(t, true).catch(() => undefined);
      return;
    }
    s.sound = t;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // the sound ended by itself (or hit maxMs): take it down without bumping soundOp — a play queued meanwhile stays
      if (s.sound === t) void takeSoundDown(s).then(() => patch({ soundPlaying: false }));
    };
    s.soundStop = () => {
      done = true;
      try {
        node.stop();
      } catch {
        /* not started */
      }
      node.disconnect();
    };
    node.onended = finish;
    node.start();
    patch({ soundPlaying: true });
    if (maxMs > 0) s.timers.push(setTimeout(finish, maxMs));
  } catch (e) {
    log.warn(`sound ${url}: ${errText(e)}`);
    patch({ soundPlaying: false });
  }
}

export async function stopSound(): Promise<void> {
  soundOp++; // a play still in flight stands down
  const s = sess();
  if (!s) return;
  await takeSoundDown(s);
  patch({ soundPlaying: false });
}

/** Take whatever is in the sound slot down (no operation bump — playSoundNow's own replace). */
async function takeSoundDown(s: Sess): Promise<void> {
  const t = s.sound;
  const stop = s.soundStop;
  s.sound = null;
  s.soundStop = null;
  stop?.();
  if (t) await s.room.localParticipant.unpublishTrack(t, true).catch(() => undefined);
}

function setError(text: string) {
  const cur = getCall();
  patch({ lastError: text, errorRev: cur.errorRev + 1 });
}

// ---- data packets ---------------------------------------------------------------------------------------------------------

export function sendData(topic: string, payload: object, opts: { reliable?: boolean; to?: string[] } = {}): void {
  const s = sess();
  if (!s || s.room.state !== ConnectionState.Connected) return;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  void s.room.localParticipant
    .publishData(bytes, { reliable: opts.reliable !== false, topic, destinationIdentities: opts.to })
    .catch((e) => log.debug(`publishData ${topic}: ${errText(e)}`));
}

// ---- join ---------------------------------------------------------------------------------------------------------------

/**
 * Called synchronously inside the click that starts / switches / rejoins a call: iOS lets audio start only
 * there (doJoin makes the context after its first await — too late on iOS, where the call then played
 * nothing until the next tap). A context that isn't running is replaced by one made inside the click.
 */
function primeAudioInGesture(): void {
  // REACH §4: Safari's audio session goes to "auto" right before a call (UI chimes run as "ambient");
  // callwatch.ts puts it back once the call is fully over, on every teardown / failure path
  setCallAudioSession(true);
  const cs = audio.contextState();
  if (cs !== "none" && cs !== "running") audio.recreateContext("a call is starting");
  else audio.audioContext();
}

export function joinCall(roomId: string): void {
  if (joinNatively(roomId)) return; // a Tin Hat app with "calls": the app joins (features/native; false everywhere else)
  const st = getCall();
  if (roomId && !st.inCall && !st.connecting) primeAudioInGesture();
  if (roomId && st.hangingUp && !st.inCall && !st.connecting) {
    // Join pressed while the last call is still being cleaned up (a hang-up, a drop, a join that gave up):
    // join the moment the teardown ends instead of ignoring the click (the teardown joins pendingSwitch).
    pendingSwitch = roomId;
    setStatus("Joining as soon as the last call has ended…");
    return;
  }
  if (!roomId || st.inCall || st.connecting || st.hangingUp) return;
  if (st.fake) useCallStore.setState({ fake: false });
  const gen = ++joinGen;
  joinTarget = roomId;
  userHungUp = false;
  const restore = restoreMute;
  restoreMute = null;
  pressedMuteWhileConnecting = null;
  const pttUp = st.pushToTalk && !st.pttSpeaking;
  patch({
    callRoomId: roomId,
    connecting: true,
    callFailed: false,
    failReason: "",
    removedBy: "",
    serverMuted: false,
    serverMutedBy: "",
    micMuted: restore !== null ? restore : pttUp,
    deafened: false,
    gameChat: false,
  });
  setStatus("Joining call…");
  // Backstop: every step of a join is bounded, but a join must never sit at "Connecting…" (Join button
  // disabled) for good — e.g. the page was suspended mid-join by an iOS app switch.
  armJoinDeadline(gen, JOIN_DEADLINE_MS);
  void doJoin(roomId, gen, restore);
}

const JOIN_DEADLINE_MS = 60_000;
/** After the page was away during a join: how long the join still gets once it runs again. */
const JOIN_DEADLINE_AFTER_RETURN_MS = 30_000;

/**
 * The backstop counts time the page RAN: a timer that comes due while the page is suspended (an app
 * switch mid-join) fires the moment the page is back — before the join had a single chance to continue —
 * and said "didn't connect within a minute" for a join that was frozen, not stuck. Hidden now → wait for
 * the return; hidden since it was armed → 30 s more from now.
 */
function armJoinDeadline(gen: number, ms: number): void {
  const epoch = pageEpoch();
  const hiddenAtArm = pageHidden();
  const due = Date.now() + ms;
  setTimeout(() => {
    if (stale(gen)) return;
    if (pageHidden()) {
      void whenVisible().then(() => !stale(gen) && armJoinDeadline(gen, JOIN_DEADLINE_AFTER_RETURN_MS));
      return;
    }
    // away since it was armed: hidden then (or since), or the timer came due while the page didn't run
    // (fired late — a suspended page / a sleeping machine runs no timers)
    if (hiddenAtArm || pageEpoch() !== epoch || Date.now() - due > 5000) return armJoinDeadline(gen, JOIN_DEADLINE_AFTER_RETURN_MS);
    failStuckJoin(gen, "the call didn't connect within a minute. Check your connection and try again.");
  }, ms);
}

/** End a join that is still "Connecting…" (join generation `gen`) with a failure + Try again. */
function failStuckJoin(gen: number, reason: string): void {
  const st = getCall();
  if (stale(gen) || !st.connecting || st.inCall) return;
  const roomId = joinTarget ?? (st.callRoomId || null);
  log.warn(`join ${roomId ?? "?"} (gen ${gen}) is still connecting — giving up: ${reason}`);
  ++joinGen; // the stuck doJoin stands down at its next step and closes what it opened
  userHungUp = true; // (no auto-rejoin for this one)
  joinTarget = null;
  restoreMute = null;
  rejoinAttempts = 0;
  healthySince = 0;
  const s = sess();
  if (s) s.closing = true;
  if (roomId) lastDropRoom = roomId;
  patch({
    inCall: false,
    connecting: false,
    reconnecting: false,
    hangingUp: true,
    callFailed: true,
    failReason: reason,
    sharing: false,
    deafened: false,
    gameChat: false,
    localAfk: false,
    callPerms: {},
    canModerateCall: false,
    serverMuted: false,
    serverMutedBy: "",
  });
  setStatus(`Couldn't join the call — ${reason}`);
  clearCallView();
  for (const h of hooks.onTeardown) h(roomId ?? "");
  void teardown(s, roomId, "join gave up");
}

function stale(gen: number): boolean {
  return gen !== joinGen;
}

/** `s` is the current, open call session (async work started for it may still act). */
function live(s: Sess): boolean {
  return sess() === s && !s.closing;
}

async function doJoin(roomId: string, gen: number, restore: boolean | null): Promise<void> {
  const ses = getSession();
  const me = ses.userId ?? "";
  const dev = ses.deviceId ?? "";
  const myIdentity = `${me}:${dev}`;
  let room: Room | null = null;
  let worker: Worker | null = null;
  let prov: Sess | null = null; // the provisional session once wired (its listeners/timers need disposal)
  let membershipLanded = false;
  const dispose = async () => {
    if (prov) {
      prov.closing = true;
      for (const c of prov.cleanups.splice(0)) c();
      for (const t of prov.timers.splice(0)) {
        clearTimeout(t as ReturnType<typeof setTimeout>);
        clearInterval(t as ReturnType<typeof setInterval>);
      }
      if (sess() === prov) setSess(null);
    }
    try {
      await room?.disconnect(true);
    } catch {
      /* ignore */
    }
    worker?.terminate();
    worker = null;
  };
  const fail = async (e: unknown) => {
    if (stale(gen)) {
      log.info(`join ${roomId} (gen ${gen}) superseded: ${errText(e)}`);
      await dispose();
      return;
    }
    log.warn(`join ${roomId} failed: ${errText(e)}`);
    await dispose();
    if (stale(gen)) return; // a leave / newer join happened while we were closing: it owns the state now
    dropMembership(roomId, gen);
    if (membershipLanded || activeCallRoom === roomId) {
      activeCallRoom = null;
      void withdrawMembership(roomId);
    }
    setKeySink(null);
    joinTarget = null;
    releaseCallLock();
    const reason = friendly(e);
    lastDropRoom = roomId;
    patch({ connecting: false, reconnecting: false, callFailed: true, failReason: reason });
    setStatus(`Couldn't join the call — ${reason}`);
  };
  try {
    if (!me || !dev) throw new Error("not signed in");
    if (!isE2EESupported()) throw new Error("this browser can't encrypt calls (end-to-end encryption is not supported here)");
    if (!(await takeCallLock(dev, holdsTabLock(), roomId))) {
      if (stale(gen)) return;
      joinTarget = null;
      patch({ connecting: false, callRoomId: "" });
      setStatus("You're in a call in another Tin Hat tab");
      return;
    }
    audio.audioContext(); // created inside the click that started the join (autoplay policy)
    setKeySink({ roomId, myIdentity, provider: null });
    // 2. focus
    const focus = await resolveFocus(roomId);
    if (stale(gen)) return fail("superseded");
    // 3. token
    const tok = await mintSfuToken(focus, dev);
    if (stale(gen)) return fail("superseded");
    // 4. leftover session
    const left = sess();
    if (left) await closeSession(left, "leftover");
    if (stale(gen)) return fail("superseded");
    await av1Probe(); // AV1 hook: the marker below needs the (memoised, early-started) capability probe
    // 5. membership (0 / 1 / 3 s, then every 15 s in the background)
    const createdTs = ownLiveCreatedTs(roomId, me, dev) ?? Date.now();
    const content = () => membershipContent({ roomId, userId: me, deviceId: dev, createdTs, focus, refresh: Date.now() - createdTs > 60000 });
    wantMembership(roomId, gen); // this generation owns our membership in roomId until it leaves
    let memErr: unknown = null;
    for (const delay of [0, 1000, 2000]) {
      if (delay) await sleep(delay);
      if (stale(gen)) return fail("superseded");
      try {
        if (await putMembership(roomId, content(), gen)) {
          membershipLanded = true;
          break;
        }
        if (stale(gen)) return fail("superseded");
      } catch (e) {
        memErr = e;
        log.warn(`membership publish failed: ${errText(e)}`);
        // 403: the room's power levels don't let us write a call membership — retrying can't help,
        // and without it nobody sees us or keys us (fix/polish item 1: the join used to report
        // "In call" with no error while the user was invisible to everyone).
        if (isForbidden(e)) break;
      }
    }
    // a leave / switch while the PUT was in flight owns the state now: no stale error for it
    if (stale(gen)) return fail("superseded");
    if (!membershipLanded && isForbidden(memErr)) {
      const why = MEMBERSHIP_FORBIDDEN;
      setError(`Couldn't join the call — ${why}`);
      return fail(new Error(why));
    }
    activeCallRoom = roomId;
    if (!membershipLanded) {
      if (memErr) setError("Your call membership couldn't be published yet — others can't see or hear you. Retrying…");
      backgroundMembership(roomId, gen, content);
    }
    // 7. key
    if (stale(gen)) {
      // withdrawMembership stands down by itself when a newer join wants this room again
      dropMembership(roomId, gen);
      void withdrawMembership(roomId);
      return fail("superseded");
    }
    const keyIndex = advanceKeyIndex();
    const key = mintKey();
    void clearStaleAway(roomId, me);
    const provider = new TinHatKeyProvider();
    provider.ownIndex = keyIndex;
    await provider.setRawKey(myIdentity, keyIndex, key);
    void announceKey(roomId, keyIndex, key, "join", () => !stale(gen)).catch((e) => log.warn(`[send-key-td] ${errText(e)}`));
    // 8. connect
    room = new Room({
      adaptiveStream: false,
      dynacast: false,
      webAudioMix: false,
      disconnectOnPageLeave: false,
      stopLocalTrackOnUnpublish: true,
      e2ee: { keyProvider: provider, worker: (worker = new E2EEWorker()) },
    });
    await room.setE2EEEnabled(true);
    // A newer join may own the key sink by now — never point it back at this (stale) session.
    if (stale(gen)) return fail("superseded");
    if (worker) av1Watch(room, worker, republishMembership); // AV1 hook: safety net + pref switch
    setKeySink({ roomId, myIdentity, provider });
    await replayKeys(provider, roomId);
    const s: Sess = {
      gen,
      roomId,
      room,
      provider,
      key,
      keyIndex,
      myIdentity,
      me,
      deviceId: dev,
      focus,
      createdTs,
      connectedAt: 0,
      mic: null,
      micWanted: true,
      cam: null,
      screen: null,
      screenAudio: null,
      music: null,
      musicStop: null,
      sound: null,
      soundStop: null,
      timers: [],
      cleanups: [],
      worker,
      chimesArmedAt: 0,
      closing: false,
    };
    prov = s;
    wireRoom(s);
    await withTimeout(room.connect(tok.url, tok.jwt, { autoSubscribe: true }), 15000, "connect timed out — the call may be stale, try again");
    if (stale(gen)) return fail("superseded");
    // 9. moderation state at join
    const block = hooks.micPublishBlocked(roomId);
    setSess(s);
    if (block.muted) {
      s.micWanted = false;
      patch({ serverMuted: true, serverMutedBy: block.by });
    } else {
      try {
        // joinCall seeded micMuted with the restore / PTT state and forceMicMuted keeps it current, so
        // the store is the latest intent; publishMic applies it once the capture is published.
        await micOp(() => publishMic(s), s);
      } catch (e) {
        throw new Error(`mic: ${errText(e)}`);
      }
    }
    if (stale(gen) || !live(s)) return fail("superseded");
    // Mute pressed while the mic was being acquired/published: the store holds the latest intent.
    const finalMuted = getCall().micMuted || (getCall().pushToTalk && !getCall().pttSpeaking);
    if (finalMuted !== getCall().micMuted) patch({ micMuted: finalMuted });
    await reconcileMic(s);
    // Astra finding 9: a leave / switch during that await must not be overwritten by "In call".
    if (stale(gen) || !live(s)) return fail("superseded");
    prov = null; // committed: from here on the session is closed by leave/drop
    // 11. live
    s.connectedAt = Date.now();
    healthySince = Date.now();
    joinTarget = null;
    patch({
      connecting: false,
      inCall: true,
      micMuted: finalMuted,
      callFailed: false,
      reconnecting: false,
      failReason: "",
      localAfk: false,
      speakers: { me: myIdentity, active: [] },
      // the recorder may already be in the SFU (it stays while anyone is in the call): livekit
      // emits no ParticipantConnected for participants present at join → REC cue / Clip were
      // missing for everyone who joined after it (media fix round)
      recActive: [...room.remoteParticipants.values()].some((x) => isRecorder(x.identity)),
    });
    setStatus("In call");
    startLoops(s);
    // Re-send our key to the people already in the call once we are connected too (the pre-connect
    // announce can reach a peer before our membership has synced there; its intake holds it ≤ 30 s,
    // this ladder makes sure a copy arrives after the membership is visible).
    if (s.room.remoteParticipants.size > 0) announceLadder(s, "the members already in the call");
    rebuildTiles();
    for (const h of hooks.onConnected) h(s);
    hooks.joinSound(s);
    audio.reapply();
    for (let i = 1; i <= 4; i++) s.timers.push(setTimeout(() => audio.reapply(), 1500 * i));
    void refreshOutputs();
    ensureLevelLoop();
    log.info(`in call ${roomId} as ${myIdentity} (key #${keyIndex})`);
  } catch (e) {
    await fail(e);
  }
}

function claimsRoomOtherThan(gen: number, roomId: string): boolean {
  return gen !== joinGen && (joinTarget === roomId || pendingSwitch === roomId);
}

function backgroundMembership(roomId: string, gen: number, content: () => Record<string, unknown>) {
  const t = setInterval(async () => {
    const st = getCall();
    if (stale(gen) || activeCallRoom !== roomId || (!st.inCall && !st.connecting)) {
      clearInterval(t);
      return;
    }
    try {
      // (a publish that lands after this call ended tombstones itself inside putMembership)
      const ok = await putMembership(roomId, content(), gen);
      clearInterval(t);
      if (ok) log.info("membership landed (background retry)");
    } catch (e) {
      log.warn(`membership background retry: ${errText(e)}`);
      const now = getCall();
      if (stale(gen) || activeCallRoom !== roomId || (!now.inCall && !now.connecting)) {
        clearInterval(t); // the call this retry belonged to is over — no error for it
        return;
      }
      if (isForbidden(e)) {
        clearInterval(t);
        setError(`Others can't see or hear you — ${MEMBERSHIP_FORBIDDEN}`);
      }
    }
  }, 15000);
}

async function clearStaleAway(roomId: string, me: string) {
  const cur = getState<{ away?: boolean }>(roomId, AFK_TYPE, me);
  if (cur?.away === true) {
    try {
      await ensureWritable(roomId, [AFK_TYPE]);
      await sendState(roomId, AFK_TYPE, me, { away: false, ts: Date.now() });
    } catch (e) {
      log.debug(`clear stale away: ${errText(e)}`);
    }
  }
}

// ---- loops ----------------------------------------------------------------------------------------------------------

function startLoops(s: Sess) {
  // 60 s steady key re-announce
  s.timers.push(
    setInterval(() => {
      if (sess() !== s) return;
      void announceKey(s.roomId, s.keyIndex, s.key, "steady", () => live(s)).catch(() => undefined);
    }, 60000),
  );
  // 30 min membership refresh (same created_ts), then re-announce
  s.timers.push(setInterval(() => void refreshMembership(s), 30 * 60 * 1000));
  // mic health
  s.timers.push(setInterval(() => void micHealthTick(s), 2000));
}

/** The 30-min refresh (rtc.rs:323-335): same `created_ts`, `expires` grows; re-announce the key after. */
async function refreshMembership(s: Sess): Promise<boolean> {
  if (sess() !== s) return false;
  try {
    if (!(await putMembership(s.roomId, membershipContent({ roomId: s.roomId, userId: s.me, deviceId: s.deviceId, createdTs: s.createdTs, focus: s.focus, refresh: true }), s.gen))) return false;
    log.info("membership refreshed");
    void announceKey(s.roomId, s.keyIndex, s.key, "refresh", () => live(s)).catch(() => undefined);
    return true;
  } catch (e) {
    log.warn(`membership refresh: ${errText(e)}`);
    return false;
  }
}

/** Re-publish the membership now (same created_ts) — "Never record me" flipped mid-call. */
export async function republishMembership(): Promise<void> {
  const s = sess();
  if (!s) return;
  try {
    await putMembership(s.roomId, membershipContent({ roomId: s.roomId, userId: s.me, deviceId: s.deviceId, createdTs: s.createdTs, focus: s.focus, refresh: true }), s.gen);
  } catch (e) {
    log.warn(`membership re-publish: ${errText(e)}`);
  }
}

function announceLadder(s: Sess, who: string) {
  for (const d of [0, 3, 10, 30, 60, 120]) {
    s.timers.push(
      setTimeout(() => {
        if (sess() !== s) return;
        void announceKey(s.roomId, s.keyIndex, s.key, `ladder ${d}s for ${who}`, () => live(s)).catch(() => undefined);
      }, d * 1000),
    );
  }
}

// ---- room events --------------------------------------------------------------------------------------------------------

const missingKeySince = new Map<string, number>();
export function missingKeyFor(identity: string): number {
  return missingKeySince.get(identity) ?? 0;
}

function wireRoom(s: Sess) {
  const room = s.room;
  room
    .on(RoomEvent.ParticipantConnected, (p) => {
      if (sess() !== s) return;
      announceLadder(s, p.identity);
      recheckPending(); // a key that arrived before this peer's membership synced
      if (isRecorder(p.identity)) {
        patch({ recActive: true });
        return;
      }
      rebuildTiles();
      if (s.chimesArmedAt && Date.now() >= s.chimesArmedAt) chime("join");
      for (const h of hooks.onParticipantJoined) h(s, p);
    })
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      if (sess() !== s) return;
      if (isRecorder(p.identity)) {
        patch({ recActive: [...room.remoteParticipants.values()].some((x) => isRecorder(x.identity)) });
        return;
      }
      missingKeySince.delete(p.identity);
      rebuildTiles();
      chime("leave");
      for (const h of hooks.onParticipantLeft) h(s, p);
    })
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (sess() !== s && s.gen !== joinGen) return;
      if (track.kind === Track.Kind.Audio) subscribeAudio(track as RemoteAudioTrack, pub, p);
      else {
        reattach(`vid_${pub.trackSid}`);
        rebuildTiles();
      }
      log.info(`${track.kind} TrackSubscribed ${p.identity} ${pub.source} ${pub.trackSid}`);
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
      if (track.kind === Track.Kind.Audio) audio.removeRemote(pub.trackSid);
      else {
        const el = attached.get(`vid_${pub.trackSid}`);
        if (el) track.detach(el);
        lastEnabled.delete(`vid_${pub.trackSid}`);
        hiddenPlayers.forget(`vid_${pub.trackSid}`);
      }
      if (sess() === s) rebuildTiles();
    })
    .on(RoomEvent.TrackMuted, () => sess() === s && rebuildTiles())
    .on(RoomEvent.TrackUnmuted, () => sess() === s && rebuildTiles())
    .on(RoomEvent.TrackPublished, () => sess() === s && rebuildTiles())
    .on(RoomEvent.TrackUnpublished, () => sess() === s && rebuildTiles())
    .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      if (sess() !== s) return;
      patch({ speakers: { me: s.myIdentity, active: speakers.map((p) => p.identity).filter((i) => !isRecorder(i)) } });
    })
    .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (sess() !== s || !topic || !participant) return;
      let obj: unknown;
      try {
        obj = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
      for (const h of hooks.onData) {
        try {
          h(s, topic, obj as Record<string, unknown>, participant.identity);
        } catch (e) {
          log.debug(`data ${topic} from ${participant.identity}: ${errText(e)}`);
        }
      }
    })
    .on(RoomEvent.Reconnecting, () => {
      if (sess() !== s) return;
      patch({ reconnecting: true, speakers: { me: s.myIdentity, active: [] } });
    })
    .on(RoomEvent.Reconnected, () => {
      if (sess() !== s) return;
      patch({ reconnecting: false, callFailed: false });
      s.timers.push(
        setTimeout(() => {
          if (sess() !== s) return;
          const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
          if (!pub?.track && s.micWanted && !getCall().serverMuted) void withTimeout(republishOrPublish(s), 6000, "mic check timed out").catch(() => undefined);
        }, 3000),
      );
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (s.closing) return;
      if (sess() !== s) return;
      void onTerminalDrop(s, reason);
    })
    .on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
      if (sess() !== s || participant !== room.localParticipant) return;
      for (const h of hooks.onPermissionChanged) h(s);
    })
    .on(RoomEvent.ParticipantEncryptionStatusChanged, () => undefined)
    .on(RoomEvent.EncryptionError, (err: Error, participant?: Participant) => {
      const id = participant?.identity;
      if (!id) return;
      if (!missingKeySince.has(id)) missingKeySince.set(id, Date.now());
      const since = missingKeySince.get(id)!;
      if (Date.now() - since > 10000 && !missingLogged.has(id)) {
        missingLogged.add(id);
        log.warn(`[e2ee] ${id} stuck without a working key for > 10 s: ${errText(err)}`);
      }
    })
    .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
      if (sess() === s && pub.source === Track.Source.ScreenShare) for (const h of hooks.onShareChanged) h(s);
    });
  const offKey = onPeerKey((identity) => {
    missingKeySince.delete(identity);
    missingLogged.delete(identity);
  });
  s.cleanups.push(offKey);
  s.chimesArmedAt = 0;
  s.timers.push(setTimeout(() => (s.chimesArmedAt = Date.now()), 2500));
}
const missingLogged = new Set<string>();

async function republishOrPublish(s: Sess) {
  await micOp(async () => {
    if (!live(s)) return;
    if (s.mic) {
      await s.room.localParticipant.publishTrack(s.mic, { source: Track.Source.Microphone, name: "mic", dtx: true, red: true });
      await reconcileMic(s);
    } else await publishMic(s);
  }, s);
}

function chime(kind: "join" | "leave") {
  chimeHook(kind);
}
let chimeHook: (kind: "join" | "leave") => void = () => undefined;
export function setChimeHook(f: (kind: "join" | "leave") => void): void {
  chimeHook = f;
}

// ---- teardown ---------------------------------------------------------------------------------------------------------------

async function closeSession(s: Sess, why: string): Promise<void> {
  s.closing = true;
  for (const c of s.cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
  for (const t of s.timers) {
    clearTimeout(t as ReturnType<typeof setTimeout>);
    clearInterval(t as ReturnType<typeof setInterval>);
  }
  s.timers = [];
  try {
    s.soundStop?.();
    s.musicStop?.();
  } catch {
    /* ignore */
  }
  for (const t of [s.mic, s.cam, s.screen, s.music, s.sound]) {
    try {
      t?.stop();
    } catch {
      /* ignore */
    }
  }
  s.screenAudio?.stop();
  micTapTok++;
  micTapClose?.();
  micTapClose = null;
  audio.clearRemotes();
  try {
    await withTimeout(s.room.disconnect(true), 12000, "disconnect timed out");
  } catch (e) {
    log.warn(`disconnect (${why}): ${errText(e)}`);
  }
  s.worker?.terminate();
  if (sess() === s) setSess(null);
  log.info(`session closed (${why})`);
  // GPU.md §2.10 / §2.7: nothing needs the call's audio thread or the level loop now (a meter keeps them)
  if (!sess() && !monitors.mic && !monitors.output) {
    audio.idleContext();
    ensureLevelLoop();
  }
}

function clearCallView() {
  detachAll();
  releaseAvatars();
  hiddenTiles.clear();
  tileSizes.clear();
  tileQuality.clear();
  watched.clear();
  lastEnabled = new Map();
  missingKeySince.clear();
  patch({
    tiles: [],
    recOnlyFlags: {},
    cameraOn: false,
    musicPlaying: false,
    soundPlaying: false,
    sharing: false,
    audioLevels: {},
    micLevel: 0,
    speakers: { me: "", active: [] },
    recActive: false,
    publishStats: [],
    hear: {},
  });
}

export function leaveCall(): void {
  const st = getCall();
  if (st.hangingUp) {
    // Leave pressed while a teardown runs: cancel a join / switch queued behind it.
    if (pendingSwitch) {
      pendingSwitch = null;
      setStatus("Left call");
    }
    return;
  }
  if (!st.inCall && !st.connecting && !st.callFailed) {
    // Hang up during an auto-rejoin's 1.5 s wait (amber "Reconnecting…" banner): cancel it.
    if (st.reconnecting) {
      userHungUp = true;
      ++joinGen;
      patch({ reconnecting: false, callRoomId: "" });
      setStatus("Left call");
    }
    return;
  }
  ++joinGen;
  userHungUp = true;
  joinTarget = null; // the canceled join's claim (a switch's target lives in pendingSwitch)
  restoreMute = null;
  rejoinAttempts = 0;
  healthySince = 0;
  const roomId = activeCallRoom ?? st.callRoomId;
  const s = sess();
  if (s) s.closing = true;
  patch({
    inCall: false,
    sharing: false,
    connecting: false,
    callFailed: false,
    failReason: "",
    hangingUp: true,
    deafened: false,
    gameChat: false,
    localAfk: false,
    callPerms: {},
    canModerateCall: false,
    serverMuted: false,
    serverMutedBy: "",
    reconnecting: false,
  });
  setStatus("Hanging up…");
  clearCallView();
  for (const h of hooks.onTeardown) h(roomId ?? "");
  void teardown(s, roomId, "hang up");
}

/** keepKeys: an auto-rejoin into the same room follows — keep the peers' keys for its replay (a peer that
 *  sees our rejoin as a reconnect of the same identity never re-sends its key; without this we heard
 *  nobody until their 60 s re-announce). */
async function teardown(s: Sess | null, roomId: string | null, why: string, keepKeys = false): Promise<void> {
  teardowns++;
  setKeySink(null);
  if (roomId) dropMembership(roomId); // nobody wants it now: in-flight publishes tombstone, retries skip
  let withdrawn = true;
  try {
    [, withdrawn] = await Promise.all([s ? closeSession(s, why) : Promise.resolve(), roomId ? withdrawMembership(roomId, 8000) : Promise.resolve(true)]);
  } finally {
    // The tombstone didn't land (rate-limited, a socket killed by an app switch, the 8 s bound came due
    // while the page was suspended): nothing else retries it, and peers keep a ghost of us (keyed, shown
    // in the call) for hours — the membership watch takes it from here (withdraws it while nobody wants it).
    if (roomId && !withdrawn) markMemberDirty(roomId, 5000);
    if (roomId && !keepKeys) clearKeysFor(roomId);
    if (activeCallRoom === roomId) activeCallRoom = null;
    teardowns = Math.max(0, teardowns - 1);
    if (teardowns === 0) {
      releaseCallLock();
      const target = pendingSwitch;
      pendingSwitch = null;
      const st = getCall();
      patch({ hangingUp: false, ...(st.callFailed || st.reconnecting ? {} : { callRoomId: target ?? "" }) });
      if (target) joinCall(target);
      else if (why === "hang up") setStatus("Left call");
    }
  }
}

const NON_RECOVERABLE = new Set<DisconnectReason | undefined>([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
  DisconnectReason.USER_REJECTED,
  DisconnectReason.USER_UNAVAILABLE,
]);

async function onTerminalDrop(s: Sess, reason?: DisconnectReason, force = false): Promise<void> {
  const roomId = s.roomId;
  const recoverable = !NON_RECOVERABLE.has(reason);
  const healthy = healthySince > 0 && Date.now() - healthySince >= 45000;
  if (healthy || force) rejoinAttempts = 0;
  const followUp = rejoinAttempts > 0;
  // force: back from the background with a dead SFU session — the user was in this call, take them back
  const auto = (force || recoverable) && !userHungUp && (force || healthy || followUp) && rejoinAttempts < 2;
  let removedBy = "";
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
    for (const h of hooks.onRemoved) removedBy = h(s) || removedBy;
    removedBy = removedBy || "A moderator";
  }
  const preMute = getCall().micMuted;
  log.warn(`terminal disconnect (reason ${reason ?? "?"}) — ${auto ? "auto-rejoin" : "call ended"}`);
  ++joinGen;
  lastDropRoom = roomId;
  healthySince = 0;
  clearCallView();
  patch({
    callFailed: !auto,
    reconnecting: auto,
    inCall: false,
    connecting: false,
    hangingUp: true,
    removedBy,
    failReason: "",
    callPerms: {},
    canModerateCall: false,
    serverMuted: false,
    serverMutedBy: "",
    deafened: false,
    gameChat: false,
  });
  setStatus(removedBy ? `${removedBy} disconnected you from the call` : auto ? "Connection lost — reconnecting…" : "Call ended (connection lost)");
  for (const h of hooks.onTeardown) h(roomId);
  await teardown(s, roomId, "drop", auto);
  if (auto) {
    rejoinAttempts++;
    const myGen = joinGen;
    await sleep(force ? 300 : 1500);
    const st = getCall();
    if (!userHungUp && joinGen === myGen && !st.inCall && !st.connecting && !st.hangingUp) {
      restoreMute = preMute;
      patch({ reconnecting: false });
      joinCall(roomId);
    } else {
      patch({ reconnecting: false });
      if (!claimsRoom(roomId)) clearKeysFor(roomId); // no rejoin after all: don't keep its keys
    }
  }
}

export function switchCall(roomId: string): void {
  if (joinNatively(roomId)) return; // a Tin Hat app with "calls": the app joins or switches (features/native)
  const st = getCall();
  if (roomId && st.callRoomId !== roomId) primeAudioInGesture();
  if (!st.inCall && !st.connecting && !st.hangingUp) {
    if (st.callFailed) patch({ callFailed: false });
    joinCall(roomId);
    return;
  }
  if (st.callRoomId === roomId && (st.inCall || st.connecting)) return;
  pendingSwitch = roomId;
  if (!st.hangingUp) leaveCall();
}

/** Rejoin / Try again from the failure banner: the DROPPED call's room (native bug fix, D6). */
export function rejoin(): void {
  const room = lastDropRoom || getCall().callRoomId;
  const st = getCall();
  if (st.hangingUp || !room) return;
  patch({ callFailed: false });
  joinCall(room);
}

/** Dismiss the failure banner without rejoining. */
export function dismissFailure(): void {
  const st = getCall();
  if (st.inCall || st.connecting || st.hangingUp) return;
  patch({ callFailed: false, failReason: "", removedBy: "", callRoomId: "" });
}

// ---- deafen ---------------------------------------------------------------------------------------------------------

export function applyDeafen(on: boolean): void {
  patch({ deafened: on });
  audio.reapply();
}

// ---- tab close ------------------------------------------------------------------------------------------------------

let leftToBfcache = false;

export function installPageLifecycle(): void {
  window.addEventListener("pagehide", (e) => {
    const roomId = activeCallRoom;
    const s = sess();
    if (!roomId && !s && !getCall().connecting) return;
    if (s) {
      s.closing = true;
      void s.room.disconnect(true).catch(() => undefined);
    }
    if (roomId) withdrawKeepalive(roomId);
    // Kept in the back/forward cache: the page may come back with this call's state still on screen.
    if ((e as PageTransitionEvent).persisted) leftToBfcache = true;
  });
  window.addEventListener("pageshow", (e) => {
    if (!(e as PageTransitionEvent).persisted || !leftToBfcache) return;
    leftToBfcache = false;
    endCallLeftBehind();
  });
  document.addEventListener("visibilitychange", () => reconcileVideo());
  // GPU.md §2.11: the unfocused / hidden video policy, the previews and the level loop follow the window state —
  // and restore the moment the window is focused again (and when the Settings switch flips)
  onWinState(() => {
    reconcileVideo();
    applyLocalPreviews();
    ensureLevelLoop();
  });
  onPrefChange(UNFOCUSED_SAVER_PREF, () => {
    reconcileVideo();
    applyLocalPreviews();
  });
  // PiP opening / closing changes what a hidden tab must keep flowing (inVisiblePopout()).
  document.addEventListener("enterpictureinpicture", () => reconcileVideo(), true);
  document.addEventListener("leavepictureinpicture", () => reconcileVideo(), true);
  const dpip = (window as unknown as { documentPictureInPicture?: EventTarget }).documentPictureInPicture;
  dpip?.addEventListener("enter", (e) => {
    reconcileVideo();
    (e as Event & { window?: Window }).window?.addEventListener("pagehide", () => setTimeout(reconcileVideo, 0));
  });
}

// ---- back from the background (iOS app switch, frozen tab, back/forward cache, sleep) -----------------------
//
// resume.ts calls afterPageResume() when core/lifecycle.ts says the page is back. LiveKit notices a dead
// signal socket itself (its ping timeout fires the moment timers run again) and either resumes, rejoins
// the SFU, or ends with Disconnected → onTerminalDrop (auto-rejoin or "Call ended" + Rejoin). What it
// does not repair is ours: a mic / camera capture iOS ended or left muted, a membership + key that may
// have lapsed while we were away, and engine flags a frozen page may have left behind.

/** The page came back from the back/forward cache: its call was ended at pagehide — say so, offer Rejoin. */
function endCallLeftBehind(): void {
  const s = sess();
  const st = getCall();
  log.warn("page restored from the back/forward cache — its call was ended when the page was left");
  if (s) void onTerminalDrop(s, DisconnectReason.CLIENT_INITIATED);
  else if (st.connecting) failStuckJoin(joinGen, "the page was left while the call was connecting. Try again.");
}

export async function afterPageResume(info: ResumeInfo): Promise<void> {
  sweepStuckFlags();
  const s = sess();
  if (!s || s.closing || !getCall().inCall) return;
  // iOS pauses media elements in the background; muted call video may autoplay again without a tap
  for (const el of attached.values()) if (el.paused && el.srcObject) void el.play().catch(() => undefined);
  reconcileVideo();
  if (s.room.state === ConnectionState.Disconnected) {
    // (the Disconnected event can't have been handled: onTerminalDrop would have replaced the session)
    log.warn("[resume] the call's room is disconnected — handling it as a drop");
    void onTerminalDrop(s, undefined, true);
    return;
  }
  // Away longer than the SFU token lives (lk-jwt: 10 min; LiveKit refreshes it only while connected):
  // LiveKit's own resume would present the expired token and retry ~45 s before giving up. Rejoin at once
  // with a fresh one instead (native call_ctl.rs does the same after a late drop).
  const exp = sfuTokenExp(s);
  if (exp && exp - Date.now() < 5000 && info.suspect) {
    log.warn(`[resume] the call's SFU token expired ${Math.round((Date.now() - exp) / 1000)} s ago while Tin Hat was away — rejoining with a fresh one`);
    setStatus("Reconnecting to the call…");
    void onTerminalDrop(s, undefined, true);
    return;
  }
  // Let iOS un-mute the capture and livekit finish its own reconnect / mic restart first.
  await sleep(1500);
  if (!(await waitConnected(s, 20000))) return; // still reconnecting: livekit ends it with Disconnected if it can't
  const mic = await ensureMicAlive(s, "back from the background");
  // refused (iOS wants a tap) or failed: a tap retries the capture inside the gesture — the best chance
  if ((mic === "blocked" || mic === "failed") && sess() === s) patch({ needsTap: "mic" });
  void ensureCameraAlive(s);
  if (info.suspended && Math.max(info.hiddenMs, info.gapMs) >= 20000) {
    // Away long enough for peers to have dropped us (SFU departure timeout) or our membership to lapse:
    // refresh it (same created_ts) — that re-sends our key on success — and ladder the key once more.
    log.info(`[resume] away ${Math.round(Math.max(info.hiddenMs, info.gapMs) / 1000)} s — refreshing the membership + re-sending our key`);
    void refreshMembership(s);
    announceLadder(s, "everyone, after the app came back");
    recheckPending();
  }
}

/** Expiry (ms) of the token LiveKit would present on a reconnect (its latest refresh), 0 = unknown. */
function sfuTokenExp(s: Sess): number {
  try {
    const tok = Reflect.get(s.room.engine, "token") as string | undefined;
    const part = tok?.split(".")[1];
    if (!part) return 0;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as { exp?: number };
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function waitConnected(s: Sess, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (live(s) && s.room.state !== ConnectionState.Connected) {
    if (Date.now() > end) return false;
    await sleep(250);
  }
  return live(s);
}

/** The CAPTURE itself: livekit's `mediaStreamTrack` is the processor's output when one runs ("Strong"
 *  noise suppression) — that one stays live while the microphone under it has ended. */
function rawCapture(t: LocalAudioTrack | LocalVideoTrack): MediaStreamTrack {
  return (Reflect.get(t, "_mediaStreamTrack") as MediaStreamTrack | undefined) ?? t.mediaStreamTrack;
}

function captureDead(t: LocalAudioTrack | LocalVideoTrack | null): string {
  const m = t ? rawCapture(t) : undefined;
  if (!t || !m) return "missing";
  if (m.readyState !== "live") return "ended";
  if (m.muted) return "muted by the system";
  return "";
}

/** The mic capture is ended / muted by the OS (or missing while wanted): re-acquire it, keeping the mute. */
export function ensureMicAlive(s: Sess, why: string): Promise<"ok" | "fixed" | "failed" | "blocked"> {
  return micOp(async () => {
    if (!live(s) || !s.micWanted || getCall().serverMuted) return "ok" as const;
    const dead = captureDead(s.mic);
    if (!dead) return "ok" as const;
    log.warn(`[mic-resume] capture ${dead} (${why}) — re-acquiring`);
    lastMicError = null;
    let ok = false;
    if (s.mic) ok = await republishMicNow(why);
    else {
      try {
        await publishMic(s);
        ok = true;
      } catch (e) {
        lastMicError = e;
        log.warn(`[mic-resume] ${errText(e)}`);
      }
    }
    if (ok) {
      micRecoverDelay = 5000;
      micHealthyAt = Date.now();
      if (getCall().needsTap === "mic") patch({ needsTap: "" });
      return "fixed" as const;
    }
    const name = (lastMicError as { name?: string } | null)?.name ?? "";
    return name === "NotAllowedError" || name === "SecurityError" || name === "InvalidStateError" ? ("blocked" as const) : ("failed" as const);
  }, s);
}

/** Is the call mic in need of a fresh capture (the tap-to-resume action re-acquires it in the gesture)? */
export function micNeedsReacquire(): boolean {
  const s = sess();
  return !!s && s.micWanted && !getCall().serverMuted && !!captureDead(s.mic);
}

async function ensureCameraAlive(s: Sess): Promise<void> {
  if (!s.cam || !live(s)) return;
  const dead = captureDead(s.cam);
  if (dead) await restartCameraCapture(s, `camera ${dead} after the return`);
}

async function restartCameraCapture(s: Sess, why: string): Promise<void> {
  const cam = s.cam;
  if (!cam || !live(s)) return;
  const q = parseCamQuality(getCall().camQuality);
  const dev = getPref("call-camera", "");
  const facing = getPref("call-facing", "");
  try {
    await withTimeout(
      cam.restartTrack({
        deviceId: dev || undefined,
        facingMode: !dev && (facing === "environment" || facing === "user") ? facing : undefined,
        resolution: { width: q.w, height: q.h, frameRate: q.fps },
      }),
      15000,
      "camera restart timed out",
    );
    if (sess() !== s || s.cam !== cam) return;
    patch({ selfviewGen: getCall().selfviewGen + 1 });
    reattach("vid_selfview");
    log.info(`[cam] capture restarted (${why})`);
  } catch (e) {
    log.warn(`[cam] restart (${why}) failed: ${errText(e)}`);
    if (sess() === s && s.cam === cam) {
      await stopCamera(s);
      setStatus("Your camera stopped while Tin Hat was in the background — turn it back on");
    }
  }
}

let hangingUpSince = 0;
let stuckTeardownLogged = false;
useCallStore.subscribe((st, prev) => {
  if (st.hangingUp !== prev.hangingUp) hangingUpSince = st.hangingUp ? Date.now() : 0;
});

/**
 * Flags a frozen page (or a bug) may have left behind. Every step they wait on is bounded, so these are
 * backstops: "Hanging up…" with no teardown running (15 s) or a teardown that never finished (45 s), and a
 * one-call-per-device lock still held with no call (other tabs of this device could never call).
 */
export function sweepStuckFlags(): void {
  const st = getCall();
  const idle = !st.inCall && !st.connecting && !st.reconnecting && !joinTarget && !pendingSwitch && !activeCallRoom && !sess();
  if (st.hangingUp && hangingUpSince) {
    const age = Date.now() - hangingUpSince;
    // Only when NO teardown runs: a running one still owns the lock + the queued join (clearing the flag
    // under it would let a new join overlap its cleanup — every await in it is bounded, so it ends).
    if (teardowns === 0 && age > 15000) {
      log.warn(`[stuck] "hanging up" for ${Math.round(age / 1000)} s with no teardown running — clearing it`);
      patch({ hangingUp: false });
      const target = pendingSwitch;
      pendingSwitch = null;
      if (idle) releaseCallLock();
      if (target) joinCall(target);
      return;
    }
    if (teardowns > 0 && age > 45000 && !stuckTeardownLogged) {
      stuckTeardownLogged = true;
      log.warn(`[stuck] a teardown has been running for ${Math.round(age / 1000)} s`);
    }
  } else stuckTeardownLogged = false;
  if (lockRelease && idle && !st.hangingUp && teardowns === 0) {
    log.warn("[stuck] releasing a call lock no call owns");
    releaseCallLock();
  }
}

/** After a reload that ended a call (resume.ts: IndexedDB lost on iOS): join it again with the old mute. */
export function rejoinAfterReload(roomId: string, muted: boolean): void {
  const st = getCall();
  if (st.inCall || st.connecting || st.hangingUp) return;
  restoreMute = muted;
  log.info(`rejoining ${roomId} after the reload`);
  joinCall(roomId);
}

/** The AudioContext was replaced (resume.ts): the meter / hear taps of the mic live in the old one. */
export function retapMic(): void {
  const t = sess()?.mic ?? monitors.micTrack;
  if (t) void tapMic(t.mediaStreamTrack);
}

/** Music from a file / URL and soundboard clips are produced INSIDE the call's AudioContext. */
const ctxBoundMusic = new WeakSet<MediaStreamTrack>();
audio.onContextReplaced(() => {
  retapMic();
  const s = sess();
  if (!s) return;
  if (s.sound) void stopSound();
  if (s.music && ctxBoundMusic.has(s.music.mediaStreamTrack)) {
    void stopMusic(true);
    setStatus("Your music stopped when the call's sound restarted — start it again");
  }
});

// ---- our own membership as the server has it (fix/ios-resume, Astra review 6) ----------------------------
//
// A membership PUT that timed out (15 s, rtc.ts) may still land later, AFTER a newer write: a late publish
// resurrects a membership we withdrew (peers key a ghost), a late tombstone wipes the call we are in
// (peers stop seeing / keying us). Watch our own state event and put it right, 3 s after it changes.

let memberWatch: MatrixClient | null = null;
const memberDirty = new Map<string, { timer: ReturnType<typeof setTimeout>; tries: number }>();
const memberFixAt = new Map<string, number>();

function onOwnMemberEvent(ev: MatrixEvent) {
  if (ev.getType() !== MEMBER_TYPE) return;
  const ses = getSession();
  const roomId = ev.getRoomId();
  // only our OWN device's key (never the phone app's native call device: another device of this account)
  if (!roomId || !pageOwnsMembership(ev.getStateKey(), ses.userId, ses.deviceId, nativeDeviceId())) return;
  markMemberDirty(roomId, 3000);
}

/** One pending check per room; re-armed while a join / leave is in flight or after a failed repair. */
function markMemberDirty(roomId: string, delay: number, tries = 0) {
  const cur = memberDirty.get(roomId);
  if (cur) clearTimeout(cur.timer);
  const entry = { tries, timer: setTimeout(() => void reconcileOwnMembership(roomId, entry), delay) };
  memberDirty.set(roomId, entry);
}

async function reconcileOwnMembership(roomId: string, entry: { tries: number }) {
  if (memberDirty.get(roomId) !== (entry as unknown)) return;
  memberDirty.delete(roomId);
  const ses = getSession();
  const c = peekClient();
  // one tab owns this device's session (core's Web Lock) — only that tab ever corrects its membership
  if (!c || c !== memberWatch || !ses.userId || !ses.deviceId || !holdsTabLock()) return;
  if (!pageOwnsMembership(ownStateKey(ses.userId, ses.deviceId), ses.userId, ses.deviceId, nativeDeviceId())) return;
  const again = (ms: number) => entry.tries < 12 && markMemberDirty(roomId, ms, entry.tries + 1);
  const st = getCall();
  // a join / leave / switch in flight owns the membership right now: look again once it has settled
  if (st.hangingUp || st.connecting || teardowns > 0 || (joinTarget === roomId && !st.inCall) || pendingSwitch === roomId) return void again(5000);
  const last = memberFixAt.get(roomId) ?? 0;
  if (Date.now() - last < 10000) return void again(10000 - (Date.now() - last) + 500);
  const ev = c.getRoom(roomId)?.currentState.getStateEvents(MEMBER_TYPE, ownStateKey(ses.userId, ses.deviceId));
  const content = (ev?.getContent() ?? {}) as Record<string, unknown>;
  const live = !!ev && contentLive(content, ev.getTs());
  const s = sess();
  const inThisCall = st.inCall && activeCallRoom === roomId && s?.roomId === roomId && membershipWanted(roomId);
  let fix: (() => Promise<boolean>) | null = null;
  if (live && !claimsRoom(roomId) && !membershipWanted(roomId)) {
    log.warn(`[member] our membership in ${roomId} is live but we are not in its call (a write landed late, or our leave's tombstone never did) — withdrawing it`);
    fix = () => withdrawMembership(roomId);
  } else if (inThisCall && s && (!live || content.created_ts !== s.createdTs)) {
    // wiped by a late tombstone, or replaced by an OLDER session's late publish
    log.warn(`[member] our membership in ${roomId} ${live ? "is an older session's" : "was wiped"} while we are in its call (a late write) — publishing ours again`);
    fix = async () => {
      await republishMembership();
      return true;
    };
  }
  if (!fix) return;
  memberFixAt.set(roomId, Date.now());
  const ok = await fix().catch(() => false);
  if (!ok) again(15000); // (rate-limited / offline: try again; the next state event re-arms it anyway)
}

export function installMembershipWatch(): void {
  const attach = () => {
    const c = peekClient();
    if (c === memberWatch) return;
    memberWatch?.off(RoomStateEvent.Events, onOwnMemberEvent);
    memberWatch = c;
    c?.on(RoomStateEvent.Events, onOwnMemberEvent);
  };
  attach();
  onClientChanged(attach);
}

// ---- session loss (Astra finding 6) -----------------------------------------------------------------------

let sessionLossRun: Promise<void> | null = null;

/**
 * The Matrix session is going away (sign-out, token rejected, another tab took over, the client was
 * replaced): stop every capture NOW, cancel pending joins / rejoins, withdraw our membership while
 * the token still works (not for "token": it is already dead) and disconnect from the SFU.
 * Idempotent; also safe when no call is going on.
 */
export function endCallForSessionLoss(why: string): Promise<void> {
  if (sessionLossRun) return sessionLossRun;
  const st = getCall();
  const s = sess();
  // callui's fake call (?fakecall=1, QA captures) is no call at all: the client coming up at boot
  // used to "end" it here and wipe its tiles (black stage in every fake-call capture).
  if (st.fake && !s) return Promise.resolve();
  const roomId = activeCallRoom ?? (st.inCall || st.connecting || st.hangingUp ? st.callRoomId || null : null);
  if (!s && !roomId && !st.connecting && !st.reconnecting && !joinTarget && !pendingSwitch) return Promise.resolve();
  log.warn(`session ${why}: ending the call`);
  const myGen = ++joinGen; // pending joins, publishes and the auto-rejoin all stand down
  userHungUp = true;
  joinTarget = null;
  pendingSwitch = null;
  restoreMute = null;
  rejoinAttempts = 0;
  healthySince = 0;
  shareOp++;
  musicOp++;
  if (s) {
    s.closing = true;
    for (const t of [s.mic, s.cam, s.screen, s.music, s.sound]) {
      try {
        t?.stop(); // capture off immediately — before anything asynchronous
      } catch {
        /* ignore */
      }
    }
    s.screenAudio?.stop();
  }
  stopMicMonitor();
  setKeySink(null);
  if (roomId) dropMembership(roomId);
  clearCallView();
  patch({
    inCall: false,
    connecting: false,
    reconnecting: false,
    hangingUp: false,
    callFailed: false,
    failReason: "",
    callRoomId: "",
    sharing: false,
    deafened: false,
    gameChat: false,
    localAfk: false,
    callPerms: {},
    canModerateCall: false,
    serverMuted: false,
    serverMutedBy: "",
  });
  for (const h of hooks.onTeardown) h(roomId ?? "");
  sessionLossRun = (async () => {
    try {
      // The tombstone goes through the room's write chain only (after any publish still in flight, whose
      // own late-landing check then sees nobody wants the membership), bounded. No unordered keepalive
      // fallback: if it can't finish, the next start's ghost sweep tombstones it. Not for a dead token.
      const withdraw = async () => {
        if (!roomId || why === "token") return;
        // Taken over while suspended, and the new tab (same device → same state key) joined THIS room's call:
        // the membership is its now — a tombstone from here would wipe it.
        if (why === "takeover" && (await callLockStolenFor(getSession().deviceId ?? "", roomId))) {
          log.info(`session takeover: the tab that took over is in ${roomId}'s call — leaving the membership to it`);
          return;
        }
        if (!(await withdrawMembership(roomId, 3000))) log.warn(`session ${why}: membership withdrawal didn't finish — the next start sweeps it`);
      };
      await Promise.all([withdraw(), s ? closeSession(s, `session ${why}`) : Promise.resolve()]);
    } finally {
      // Only what is still ours: a newer join (after a re-login) owns its own keys, room and lock.
      if (joinGen === myGen) {
        if (roomId) clearKeysFor(roomId);
        if (activeCallRoom === roomId) activeCallRoom = null;
        releaseCallLock();
      }
      sessionLossRun = null;
    }
  })();
  return sessionLossRun;
}

/** Start-up sweep of our own ghost memberships (a killed tab). */
export function sweepGhosts(): void {
  const idle = () => {
    const st = getCall();
    return !(st.inCall || st.connecting || st.hangingUp || st.reconnecting || joinTarget || pendingSwitch || activeCallRoom);
  };
  // Never while a join / call / teardown is in flight (it would tombstone our own fresh membership).
  if (!idle()) return;
  void (async () => {
    // Another tab of this device holding the call lock is IN that call — its membership is no ghost.
    const dev = getSession().deviceId ?? "";
    const q = await navigator.locks?.query?.().catch(() => null);
    if (q?.held?.some((l) => l.name === `tinhat-web-call:${dev}`) && !lockRelease) return;
    await sweepOwnGhosts(activeCallRoom, (roomId) => idle() && !claimsRoom(roomId));
  })().catch(() => undefined);
}

export { rnnoiseAvailable };
export const _debug = { sess, engineState, peekClient, refreshNow: () => (sess() ? refreshMembership(sess()!) : Promise.resolve(false)) };
