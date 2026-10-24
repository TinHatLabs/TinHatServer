// topics.ts — the plaintext LiveKit data topics that ride beside the media (spec §4.6):
// tinhat.recording_only, tinhat.game_chat, tinhat.corner (pull aside / corners). Moderation packets are
// handled in moderation.ts, tinhat.rx / tinhat.echo in hear.ts. Payloads are compact JSON with the
// exact key spelling natives match by substring.
import { playUiSound } from "@/core/sounds";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import type { CallCategory } from "./contract";
import { getCall, patch } from "./store";
import { sess, type Sess } from "./session";
import { hooks, rebuildTiles, sendData, watchedTiles, reconcileVideo } from "./engine";
import * as audio from "./audio";
import { displayName, isRecorder, joinNames, mxidOf } from "./util";
import { Track } from "livekit-client";
import { isLinkedPeer, speakersOff } from "./sameroom/link";

const log = createLogger("call-topics");

// ---- recording-only shares -----------------------------------------------------------------------

const recOnlyBy = new Map<string, string>(); // sender identity → share track sid ("" = none)
const tunedIn = new Set<string>(); // tile ids

function myShareSid(s: Sess): string {
  const pub = s.room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  return pub?.trackSid ?? "";
}

function announceRecOnly(s: Sess, to?: string[]) {
  const sid = getCall().shareRecOnly && s.screen ? myShareSid(s) : "";
  sendData("tinhat.recording_only", { sid }, { to });
}

export function applyShareRecordingOnly(on: boolean): void {
  patch({ shareRecOnly: on });
  const s = sess();
  if (s) announceRecOnly(s);
}

export function setTileTunedIn(tileId: string, on: boolean): void {
  if (on) tunedIn.add(tileId);
  else tunedIn.delete(tileId);
  rebuildTiles();
  audio.reapply();
}

hooks.recOnly = (identity: string, sid: string): [boolean, boolean] => {
  const rec = !!sid && recOnlyBy.get(identity) === sid;
  return [rec, tunedIn.has(`vid_${sid}`)];
};

hooks.onShareChanged.push((s) => {
  // Announce on every share publish / re-publish / stop (call.rs:6654-6666) — the sid can only be
  // known once the publication exists, so give the publish a moment.
  setTimeout(() => sess() === s && announceRecOnly(s), 300);
});

// ---- game chat -------------------------------------------------------------------------------------

const gameChatPeers = new Set<string>();

function publishGameChatState() {
  const me = getCall().gameChat;
  const peers = [...gameChatPeers];
  patch({ gameChatPeers: { me, peers, muted: me ? peers : [] } });
  audio.reapply();
}

export function applyGameChat(on: boolean): void {
  if (on && corner.mine) leaveCorner();
  patch({ gameChat: on });
  sendData("tinhat.game_chat", { on });
  publishGameChatState();
}

// ---- corners ---------------------------------------------------------------------------------------

const corner = {
  mine: "",
  pendingSince: 0,
  byPeer: new Map<string, string>(), // identity → corner id
  gameChatBefore: null as boolean | null,
  startedByMe: false,
};

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function newCornerId(me: string): string {
  return `k${hash32(me).toString(16)}${(Date.now() & 0xffffff).toString(16)}`;
}

function cornerMembers(id: string): string[] {
  const out: string[] = [];
  for (const [who, c] of corner.byPeer) if (c === id) out.push(who);
  return out;
}

function activeCorners(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [who, c] of corner.byPeer) {
    if (!c) continue;
    m.set(c, [...(m.get(c) ?? []), who]);
  }
  return m;
}

function cornerActive(): boolean {
  return !!corner.mine && cornerMembers(corner.mine).length > 0;
}

/** A corner id from the wire: short, plain characters only (never `__proto__` & co — Astra 13). */
export function validCornerId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== "__proto__" && id !== "constructor" && id !== "prototype";
}

function publishCornerState() {
  const s = sess();
  // null prototype: a remote id can only ever be an own key, never the object's prototype
  const corners: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [id, who] of activeCorners()) corners[id] = who;
  if (corner.mine && s) corners[corner.mine] = [...(corners[corner.mine] ?? []), s.myIdentity];
  const active = cornerActive();
  const wasActive = getCall().corner.active;
  patch({ corner: { mine: corner.mine, active, members: corner.mine ? corners[corner.mine] ?? [] : [], corners } });
  if (active && !wasActive) {
    corner.pendingSince = 0;
    if (getCall().gameChat) {
      corner.gameChatBefore = true;
      applyGameChat(false);
    }
  }
  if (!active && wasActive) {
    // The others left → my corner ends at once.
    if (corner.mine) {
      corner.mine = "";
      sendData("tinhat.corner", { corner: "" });
      patch({ corner: { ...getCall().corner, mine: "", active: false, members: [] } });
    }
    if (corner.gameChatBefore) {
      corner.gameChatBefore = null;
      applyGameChat(true);
    }
  }
  audio.reapply();
}

function resolveTarget(target: string): string | null {
  const s = sess();
  if (!s) return null;
  const ids = [...s.room.remoteParticipants.keys()].filter((i) => !isRecorder(i)).sort();
  if (ids.includes(target)) return target;
  return ids.find((i) => mxidOf(i) === target) ?? null;
}

export function pullAside(target: string): string {
  const s = sess();
  if (!s) return "You're not in a call";
  const id = resolveTarget(target);
  if (!id) return `${displayName(s.roomId, target)} is not in this call`;
  const theirs = corner.byPeer.get(id);
  if (theirs && cornerMembers(theirs).length >= 2 && theirs !== corner.mine) return "They are already aside — join them instead";
  if (!corner.mine) {
    corner.mine = newCornerId(s.myIdentity);
    corner.pendingSince = Date.now();
    corner.startedByMe = true;
  }
  sendData("tinhat.corner", { corner: corner.mine, pull: id });
  publishCornerState();
  return "";
}

export function joinCorner(target: string): string {
  const s = sess();
  if (!s) return "You're not in a call";
  const id = resolveTarget(target);
  if (!id) return `${displayName(s.roomId, target)} is not in this call`;
  const theirs = corner.byPeer.get(id);
  if (!theirs || cornerMembers(theirs).length < 2) return "They are not aside right now";
  corner.mine = theirs;
  corner.startedByMe = false;
  sendData("tinhat.corner", { corner: theirs });
  publishCornerState();
  return "";
}

export function leaveCorner(): void {
  if (!corner.mine) return;
  corner.mine = "";
  corner.pendingSince = 0;
  sendData("tinhat.corner", { corner: "" });
  publishCornerState();
}

// ---- audio policy -------------------------------------------------------------------------------------

function shareTilesOf(identity: string): string[] {
  const s = sess();
  if (!s) return [];
  const p = s.room.remoteParticipants.get(identity);
  if (!p) return [];
  const out: string[] = [];
  for (const pub of p.videoTrackPublications.values()) if (pub.source === Track.Source.ScreenShare && pub.trackSid) out.push(`vid_${pub.trackSid}`);
  return out;
}

function isWatched(tileId: string): boolean {
  const w = watchedTiles();
  if (w.size > 0) return w.has(tileId);
  // Nobody reported watched tiles: exactly one visible share → that one (AppCore.qml:291-337).
  const shares = getCall().tiles.filter((t) => t.screenshare && !(t.recordingOnly && !t.tunedIn));
  return shares.length === 1 && shares[0].id === tileId;
}

audio.setPolicy({
  cornerFactor(identity: string, category: CallCategory) {
    // call.rs:4473-4570, applied in order (the later rule wins): 1 → 0.1 (I'm aside, they're not
    // with me) → 0 for the MIC of someone aside in a corner that isn't mine.
    const theirs = corner.byPeer.get(identity) ?? "";
    if (category === "mic" && theirs && theirs !== corner.mine && cornerMembers(theirs).length >= 2) return 0;
    if (cornerActive() && theirs !== corner.mine) return 0.1;
    return 1;
  },
  layerMuted(identity: string, category: CallCategory) {
    // Same room (11.3): we hear a linked peer in person — Tin Hat never plays them (mic, share audio, sounds)
    if (isLinkedPeer(identity)) return true;
    if (category === "mic") return getCall().gameChat && gameChatPeers.has(identity);
    if (category === "screenshare") {
      const recSid = recOnlyBy.get(identity);
      if (recSid && !tunedIn.has(`vid_${recSid}`) && shareTilesOf(identity).includes(`vid_${recSid}`)) return true;
      const tiles = shareTilesOf(identity);
      if (tiles.length === 0) return false; // audio-only shares are never gated
      return !tiles.some(isWatched);
    }
    return false;
  },
  cut() {
    const st = getCall();
    // speakersOff: "hear the call through <linked peer>'s speakers" — my playback is cut, my mic stays live
    return st.deafened || st.localAfk || speakersOff();
  },
});

// ---- receive + late joiners ------------------------------------------------------------------------------

hooks.onData.push((s, topic, payload, from) => {
  if (topic === "tinhat.recording_only") {
    const sid = typeof payload.sid === "string" ? payload.sid : "";
    if (sid) recOnlyBy.set(from, sid);
    else recOnlyBy.delete(from);
    rebuildTiles();
    reconcileVideo();
    audio.reapply();
  } else if (topic === "tinhat.game_chat") {
    if (payload.on === true) gameChatPeers.add(from);
    else gameChatPeers.delete(from);
    publishGameChatState();
  } else if (topic === "tinhat.corner") {
    const raw = typeof payload.corner === "string" ? payload.corner : "";
    if (raw && !validCornerId(raw)) return log.warn(`ignoring a corner packet from ${from} with a malformed id`);
    const id = raw;
    const pull = typeof payload.pull === "string" ? payload.pull : "";
    if (id) corner.byPeer.set(from, id);
    else corner.byPeer.delete(from);
    if (pull && pull === s.myIdentity) {
      if (!corner.mine) {
        corner.mine = id;
        corner.startedByMe = false;
        sendData("tinhat.corner", { corner: id });
        const names = joinNames(cornerMembers(id).map((i) => displayName(s.roomId, i)));
        toast(
          `${names || displayName(s.roomId, from)} pulled you aside — everyone else is at 10 % for you and can't hear your mic. The yellow mic button takes you back`,
          { timeoutMs: 7000 },
        );
        playUiSound("notify");
      } else if (corner.mine !== id) log.info(`pulled into ${id} by ${from} but already in ${corner.mine}`);
    }
    publishCornerState();
  }
});

hooks.onParticipantJoined.push((s, p) => {
  const to = [p.identity];
  if (getCall().shareRecOnly && s.screen) announceRecOnly(s, to);
  if (getCall().gameChat) sendData("tinhat.game_chat", { on: true }, { to });
  if (corner.mine) sendData("tinhat.corner", { corner: corner.mine }, { to });
});

hooks.onParticipantLeft.push((_s, p) => {
  recOnlyBy.delete(p.identity);
  gameChatPeers.delete(p.identity);
  corner.byPeer.delete(p.identity);
  publishGameChatState();
  publishCornerState();
});

hooks.onConnected.push((s) => {
  // Alone in a pending corner id for 4 s → leave (call.rs:4663-4674).
  s.timers.push(
    setInterval(() => {
      if (sess() !== s || !corner.mine || cornerActive()) return;
      if (corner.pendingSince && Date.now() - corner.pendingSince > 4000) {
        log.info("nobody joined my corner within 4 s — leaving it");
        leaveCorner();
      }
    }, 1000),
  );
  // Re-push watched state every 5 s (share-audio gating follows tile changes).
  s.timers.push(setInterval(() => sess() === s && audio.reapply(), 5000));
});

hooks.onTeardown.push(() => {
  recOnlyBy.clear();
  tunedIn.clear();
  gameChatPeers.clear();
  corner.mine = "";
  corner.byPeer.clear();
  corner.pendingSince = 0;
  corner.gameChatBefore = null;
  patch({ gameChatPeers: { me: false, peers: [], muted: [] }, corner: { mine: "", active: false, members: [], corners: {} }, shareRecOnly: false });
});
