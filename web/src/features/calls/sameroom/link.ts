// link.ts — Same room (Tin Hat 11.3; native crates/streamer/src/sameroom/ + call_ctl.rs): two call members in one
// physical room "link up". Linked members (a) do not play each other's audio, (b) exchange RAW mic levels 20× a
// second and run the room-mic election (elect.ts) so exactly one of them sends at a time, (c) tell the call
// about the link through `tinhat.rx` so every tile shows it. Wire (byte-compatible with the desktop):
//   tinhat.rx (existing, lossy, 3 s): + "cap":["sr"], + "sr":{"g","m":[…],"mic","spk"} while linked
//   tinhat.sr.link  (reliable, to one peer): {"v":1,"op":"ask"|"yes"|"no"|"unlink","g","m":[…],"auto"?:true}
//   tinhat.sr.lvl   (lossy, to the group):   {"s":<snr dB int>,"t":<sender ms>}
// Remembered pairs (pref blob `sameroom-pairs`, by bare mxid) link again by themselves next time (pref
// `sameroom-auto`, default on); only the lower identity of a remembered pair asks, so both never ask at once.
import { getBlob, getPref, setBlob } from "@/core/prefs";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import { getCall, patch, useCallStore } from "../store";
import { sess, type Sess } from "../session";
import { hooks, micShouldMute, sendData } from "../engine";
import * as audio from "../audio";
import { displayName, errText, isRecorder, mxidOf } from "../util";
import { ELECT_IDLE, electTick, FloorTracker, groupIdOf, SR, windowDb, type ElectState, type Level } from "./elect";

const log = createLogger("same-room");

export const LINK_TOPIC = "tinhat.sr.link";
export const LVL_TOPIC = "tinhat.sr.lvl";
const ASK_TTL_MS = 45_000; // 11.3 QOL: 45 s (was 20) — the card waits while someone looks away from the screen
const PEER_SILENT_MS = 12_000; // a linked peer whose tinhat.rx stopped listing us is gone
const WARM_WINDOWS = 20; // 1 s of windows after linking before the election counts (the rig flipped once at link time)
export const PAIRS_KEY = "sameroom-pairs";
const AUTO_KEY = "sameroom-auto";

export interface SameRoomState {
  linked: string[]; // identities of the peers I'm linked with ([] = not linked)
  holder: string; // identity holding the room mic ("" when not linked)
  live: boolean; // my mic sends (true when not linked)
  ask: { from: string; name: string; at: number } | null; // someone asked me to link up
  pending: string; // identity I asked (waiting for an answer)
  spk: boolean; // this device plays the call (false = hearing it through a linked peer's speakers)
  groups: Record<string, { m: string[]; mic: string }>; // every link in the call: identity → its group + live mic (tile badges)
  rawOk: boolean; // the raw (pre-AEC) capture is in use for the election
}
export const SAME_ROOM_IDLE: SameRoomState = { linked: [], holder: "", live: true, ask: null, pending: "", spk: true, groups: {}, rawOk: false };

interface PeerRx {
  at: number;
  cap: boolean;
  g: string;
  m: string[];
  mic: string;
  spk: boolean;
}

const sr = {
  group: new Set<string>(), // peers (not me)
  elect: ELECT_IDLE as ElectState,
  levels: new Map<string, Level>(), // per peer: the max of its packets from the last SR.holdMs (t = the latest)
  recent: new Map<string, Level[]>(),
  mineRecent: [] as Level[],
  warm: 0, // windows since the link: the floors need ~1 s before levels mean anything (a link mid-sentence)
  mine: { s: 0, t: 0 } as Level,
  floor: new FloorTracker(),
  tapClose: null as null | (() => void),
  rawTrack: null as MediaStreamTrack | null,
  rawOk: false,
  rawBusy: false,
  peers: new Map<string, PeerRx>(), // what each peer's tinhat.rx says
  ask: null as null | { from: string; at: number; m: string[] },
  pending: "" as string,
  pendingAt: 0,
  spk: true,
  lastProcessed: [] as number[], // the last processed-mic batch (fallback when no raw track)
  safety: 0 as number,
  lastTick: 0,
};

type Pairs = Record<string, { spk: boolean; at: number }>;
function pairs(): Pairs {
  const v = getBlob<Pairs>(PAIRS_KEY, {});
  return v && typeof v === "object" ? v : {};
}
export function rememberedPairs(): Pairs {
  return pairs();
}
export function forgetPair(mxid: string): void {
  const p = pairs();
  delete p[mxid];
  setBlob(PAIRS_KEY, p);
}
export function autoLink(): boolean {
  return getPref(AUTO_KEY, true);
}

function members(s: Sess): string[] {
  return [...sr.group, s.myIdentity].sort();
}

function publish(s: Sess | null) {
  const groups: Record<string, { m: string[]; mic: string }> = Object.create(null) as Record<string, { m: string[]; mic: string }>;
  for (const [id, p] of sr.peers) if (p.m.length >= 2) groups[id] = { m: p.m, mic: p.mic };
  if (s && sr.group.size) for (const id of members(s)) groups[id] = { m: members(s), mic: sr.elect.holder };
  const next: SameRoomState = {
    linked: [...sr.group].sort(),
    holder: sr.group.size ? sr.elect.holder : "",
    live: sr.group.size ? sr.elect.holder === s?.myIdentity : true,
    ask: sr.ask && s ? { from: sr.ask.from, name: displayName(s.roomId, sr.ask.from), at: sr.ask.at } : null,
    pending: sr.pending,
    spk: sr.spk,
    groups,
    rawOk: sr.rawOk,
  };
  const cur = getCall().sameRoom;
  if (JSON.stringify(cur) !== JSON.stringify(next)) patch({ sameRoom: next });
}

// ---- what the audio policy and hear.ts read -------------------------------------------------------------------

/** A linked peer: we hear them in person, so Tin Hat must not play them. */
export function isLinkedPeer(identity: string): boolean {
  return sr.group.has(identity);
}
/** "Hear the call through <peer>'s speakers": my own playback is cut (mic stays live, receipts unaffected). */
export function speakersOff(): boolean {
  return sr.group.size > 0 && !sr.spk;
}
/** The `sr` block for our tinhat.rx (null when not linked) + the capability flag. */
export function rxFields(s: Sess): { cap: string[]; sr?: { g: string; m: string[]; mic: string; spk: boolean } } {
  if (!sr.group.size) return { cap: ["sr"] };
  const m = members(s);
  return { cap: ["sr"], sr: { g: groupIdOf(m), m, mic: sr.elect.holder, spk: sr.spk } };
}
/** hear.ts hands us every peer's tinhat.rx (cap + sr) — the call-wide picture and liveness of our own links. */
export function notePeerRx(s: Sess, from: string, payload: Record<string, unknown>): void {
  const cap = Array.isArray(payload.cap) && (payload.cap as unknown[]).includes("sr");
  const raw = payload.sr && typeof payload.sr === "object" && !Array.isArray(payload.sr) ? (payload.sr as Record<string, unknown>) : null;
  const m = raw && Array.isArray(raw.m) ? (raw.m as unknown[]).filter((x): x is string => typeof x === "string" && x.length <= 256).slice(0, 8) : [];
  const p: PeerRx = { at: Date.now(), cap, g: raw && typeof raw.g === "string" ? raw.g.slice(0, 2048) : "", m, mic: raw && typeof raw.mic === "string" ? raw.mic : "", spk: raw ? raw.spk !== false : true };
  sr.peers.set(from, p);
  publish(s);
}
export function peerSupportsLink(identity: string): boolean | null {
  const p = sr.peers.get(identity);
  return p ? p.cap : null;
}

// ---- linking ---------------------------------------------------------------------------------------------------

function resolve(s: Sess, target: string): string | null {
  const ids = [...s.room.remoteParticipants.keys()].filter((i) => !isRecorder(i)).sort();
  if (ids.includes(target)) return target;
  return ids.find((i) => mxidOf(i) === target) ?? null;
}

/** Ask `identity` to link up (the suggestion pill, the tile menu, auto-link). Returns "" or a reason. */
export function linkWith(target: string, auto = false): string {
  const s = sess();
  if (!s) return "You're not in a call";
  const id = resolve(s, target);
  if (!id) return `${displayName(s.roomId, target)} is not in this call`;
  if (sr.group.has(id)) return "";
  const cap = peerSupportsLink(id);
  if (cap === false) return `${displayName(s.roomId, id)} needs to update Tin Hat to link up`;
  sr.pending = id;
  sr.pendingAt = Date.now();
  sendData(LINK_TOPIC, { v: 1, op: "ask", g: groupIdOf([...members(s), id]), m: members(s), ...(auto ? { auto: true } : {}) }, { to: [id] });
  log.info(`[sr] asked ${id} to link up${auto ? " (remembered pair)" : ""}`);
  publish(s);
  return "";
}

function join(s: Sess, peerIds: string[]) {
  for (const id of peerIds) if (id !== s.myIdentity && resolve(s, id)) sr.group.add(id);
  if (!sr.group.size) return;
  sr.elect = ELECT_IDLE;
  sr.levels.clear();
  sr.recent.clear();
  sr.mineRecent = [];
  sr.warm = 0;
  const p = pairs();
  for (const id of sr.group) p[mxidOf(id)] = { spk: p[mxidOf(id)]?.spk ?? true, at: Date.now() };
  setBlob(PAIRS_KEY, p);
  // the remembered speakers choice for this room: off only if every linked peer was saved that way
  sr.spk = ![...sr.group].every((id) => p[mxidOf(id)]?.spk === false);
  void startRaw(s);
  audio.reapply();
  log.info(`[sr] linked with ${[...sr.group].join(", ")} — room mic election on`);
  publish(s);
}

export function answerAsk(yes: boolean): void {
  const s = sess();
  const a = sr.ask;
  sr.ask = null;
  if (!s || !a) return publish(s);
  sendData(LINK_TOPIC, { v: 1, op: yes ? "yes" : "no", g: groupIdOf([...members(s), ...a.m, a.from]), m: members(s) }, { to: [a.from] });
  if (yes) join(s, [a.from, ...a.m]);
  else publish(s);
}

/** Take back my "link up?" ask (the pending pill's Cancel): the peer's card goes away ("no" from the asker). */
export function cancelAsk(): void {
  const s = sess();
  const who = sr.pending;
  if (!who) return;
  sr.pending = "";
  if (s) sendData(LINK_TOPIC, { v: 1, op: "no", g: "", m: [] }, { to: [who] });
  log.info(`[sr] cancelled the ask to ${who}`);
  publish(s);
}

export function unlink(): void {
  const s = sess();
  if (!s || !sr.group.size) return;
  for (const id of sr.group) sendData(LINK_TOPIC, { v: 1, op: "unlink", g: "", m: [] }, { to: [id] });
  leaveGroup(s, "you unlinked");
}

function leaveGroup(s: Sess | null, why: string) {
  if (!sr.group.size) return;
  sr.group.clear();
  sr.elect = ELECT_IDLE;
  sr.levels.clear();
  sr.spk = true;
  stopRaw();
  applyGate(s);
  audio.reapply();
  log.info(`[sr] unlinked (${why})`);
  publish(s);
}

/** Hear the call through a linked peer's speakers (false) or on this device (true). Remembered per pair. */
export function setHearThrough(onThisDevice: boolean): void {
  const s = sess();
  if (!s || !sr.group.size) return;
  sr.spk = onThisDevice;
  const p = pairs();
  for (const id of sr.group) p[mxidOf(id)] = { spk: onThisDevice, at: Date.now() };
  setBlob(PAIRS_KEY, p);
  audio.reapply();
  publish(s);
}

function onLink(s: Sess, from: string, payload: Record<string, unknown>) {
  const op = typeof payload.op === "string" ? payload.op : "";
  const m = Array.isArray(payload.m) ? (payload.m as unknown[]).filter((x): x is string => typeof x === "string" && x.length <= 256).slice(0, 8) : [];
  if (op === "ask") {
    if (sr.group.has(from)) return sendData(LINK_TOPIC, { v: 1, op: "yes", g: groupIdOf(members(s)), m: members(s) }, { to: [from] });
    const remembered = !!pairs()[mxidOf(from)];
    if (payload.auto === true && remembered && autoLink()) {
      sendData(LINK_TOPIC, { v: 1, op: "yes", g: groupIdOf([...members(s), from, ...m]), m: members(s) }, { to: [from] });
      join(s, [from, ...m]);
      toast(`Linked up with ${displayName(s.roomId, from)} — same room`, { timeoutMs: 4000 });
      return;
    }
    sr.ask = { from, at: Date.now(), m };
    publish(s);
  } else if (op === "yes") {
    if (sr.pending !== from && !sr.group.size) {
      // a late yes (I cancelled or it expired): tell them, so they don't stay linked on their own
      sendData(LINK_TOPIC, { v: 1, op: "unlink", g: "", m: [] }, { to: [from] });
      return;
    }
    if (sr.pending === from) sr.pending = "";
    join(s, [from, ...m]);
    toast(`Linked up with ${displayName(s.roomId, from)} — same room`, { timeoutMs: 4000 });
  } else if (op === "no") {
    if (sr.pending === from) {
      sr.pending = "";
      toast(`${displayName(s.roomId, from)} didn't link up`, { timeoutMs: 4000 });
      publish(s);
    }
    // the asker took it back (their Cancel): the card goes away
    if (sr.ask && sr.ask.from === from) {
      sr.ask = null;
      log.info(`[sr] ${from} took back the ask`);
      publish(s);
    }
  } else if (op === "unlink") {
    if (!sr.group.has(from)) return;
    sr.group.delete(from);
    if (sr.group.size === 0) leaveGroup(s, `${from} unlinked`);
    else {
      sr.levels.delete(from);
      audio.reapply();
      publish(s);
    }
  }
}

// ---- the raw mic + the election --------------------------------------------------------------------------------

async function startRaw(s: Sess) {
  if (sr.rawBusy || sr.tapClose) return;
  // a watching device captures nothing until Talk here (assembly-042): no raw microphone for the room election either
  if (getCall().noCapture) return;
  sr.rawBusy = true;
  try {
    const dev = getPref("call-input", "");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: dev ? { ideal: dev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const track = stream.getAudioTracks()[0];
    if (!track || !sr.group.size || sess() !== s) {
      track?.stop();
      return;
    }
    const st = track.getSettings();
    sr.rawOk = st.echoCancellation === false;
    sr.rawTrack = track;
    sr.floor.reset();
    const tap = await audio.tapTrack(track, (frames) => onWindow(frames, true));
    if (!sr.group.size || sess() !== s) {
      tap.close();
      track.stop();
      sr.rawTrack = null;
      return;
    }
    sr.tapClose = () => {
      tap.close();
      track.stop();
    };
    log.info(`[sr] raw mic tap ${sr.rawOk ? "on (echo cancellation off)" : "on, but the browser kept its processing — using it anyway"}`);
  } catch (e) {
    sr.rawOk = false;
    log.warn(`[sr] no raw capture (${errText(e)}) — the election uses the processed mic`);
  } finally {
    sr.rawBusy = false;
    publish(s);
  }
}

function stopRaw() {
  sr.tapClose?.();
  sr.tapClose = null;
  sr.rawTrack = null;
  sr.rawOk = false;
  sr.floor.reset();
}

/** The processed-mic frames (engine tap) — the election's fallback when no raw track could be opened. */
export function noteProcessedFrames(frames: number[]): void {
  if (!sr.group.size || sr.tapClose) return;
  onWindow(frames, false);
}

function onWindow(frames: number[], raw: boolean) {
  const s = sess();
  if (!s || !sr.group.size) return;
  if (!raw && sr.tapClose) return;
  const snr = sr.floor.push(windowDb(frames));
  const now = Date.now();
  if (sr.warm < WARM_WINDOWS) sr.warm++;
  // my own level gets the same holdMs max as the peers' (symmetric decay at the end of a sentence —
  // without it the rig showed the holder flipping to the peer in every speech gap)
  sr.mineRecent = sr.mineRecent.filter((l) => now - l.t <= SR.holdMs);
  sr.mineRecent.push({ s: snr, t: now });
  sr.mine = { s: Math.max(...sr.mineRecent.map((l) => l.s)), t: now };
  sendData(LVL_TOPIC, { s: snr, t: now }, { reliable: false, to: [...sr.group] });
  runElection(s, now);
}

function runElection(s: Sess, now: number) {
  sr.lastTick = now;
  const levels: Record<string, Level | undefined> = Object.create(null) as Record<string, Level | undefined>;
  if (sr.warm >= WARM_WINDOWS) {
    // before the warm-up nobody can challenge: the default holder (lowest identity) keeps the mic
    levels[s.myIdentity] = sr.mine;
    for (const [id, l] of sr.levels) levels[id] = l;
  }
  const r = electTick(sr.elect, { me: s.myIdentity, members: members(s), levels, now });
  const changed = r.holder !== sr.elect.holder;
  sr.elect = { holder: r.holder, wins: r.wins };
  if (changed) {
    log.info(`[sr] room mic → ${r.holder === s.myIdentity ? "me" : r.holder}`);
    publish(s);
  }
  applyGate(s);
}

/** Send silence while a linked peer holds the room mic: the tracks stay published (no mute icon flaps). */
function applyGate(s: Sess | null) {
  const t = s?.mic;
  if (!t) return;
  if (micShouldMute()) return; // the user's / moderator's / push-to-talk mute owns the track then
  const en = sr.group.size === 0 || sr.elect.holder === s!.myIdentity;
  if (t.mediaStreamTrack.enabled !== en) t.mediaStreamTrack.enabled = en;
  const pt = t.getProcessor()?.processedTrack;
  if (pt && pt.enabled !== en) pt.enabled = en;
}

// ---- lifecycle -------------------------------------------------------------------------------------------------

function reset(s: Sess | null) {
  sr.group.clear();
  sr.elect = ELECT_IDLE;
  sr.levels.clear();
  sr.peers.clear();
  sr.ask = null;
  sr.pending = "";
  sr.spk = true;
  stopRaw();
  publish(s);
}

function tryAutoLink(s: Sess, identity: string) {
  if (!autoLink() || sr.group.has(identity) || sr.pending || isRecorder(identity)) return;
  if (!pairs()[mxidOf(identity)]) return;
  if (s.myIdentity > identity) return; // the lower identity asks
  const cap = peerSupportsLink(identity);
  if (cap === false) return;
  linkWith(identity, true);
}

export function installSameRoom(): void {
  hooks.onData.push((s, topic, payload, from) => {
    if (topic === LVL_TOPIC) {
      if (!sr.group.has(from)) return;
      const v = typeof payload.s === "number" && Number.isFinite(payload.s) ? Math.max(0, Math.min(SR.snrMaxDb, Math.round(payload.s))) : 0;
      const now = Date.now();
      const rec = (sr.recent.get(from) ?? []).filter((l) => now - l.t <= SR.holdMs);
      rec.push({ s: v, t: now });
      sr.recent.set(from, rec);
      sr.levels.set(from, { s: Math.max(...rec.map((l) => l.s)), t: now });
      // a peer's level alone can move the election (we may be between our own windows)
      if (Date.now() - sr.lastTick > 60) runElection(s, Date.now());
    } else if (topic === LINK_TOPIC) onLink(s, from, payload);
  });
  hooks.onParticipantJoined.push((s, p) => {
    // give their first tinhat.rx (capability) a moment, then auto-link a remembered pair
    const t = setTimeout(() => sess() === s && tryAutoLink(s, p.identity), 3500);
    s.timers.push(t);
  });
  hooks.onParticipantLeft.push((s, p) => {
    sr.peers.delete(p.identity);
    sr.levels.delete(p.identity);
    sr.recent.delete(p.identity);
    if (sr.ask?.from === p.identity) sr.ask = null;
    if (sr.pending === p.identity) sr.pending = "";
    if (sr.group.has(p.identity)) {
      sr.group.delete(p.identity);
      if (!sr.group.size) leaveGroup(s, `${p.identity} left the call`);
      else publish(s);
    } else publish(s);
  });
  hooks.onConnected.push((s) => {
    reset(s);
    // remembered pairs already in the call
    const t0 = setTimeout(() => {
      if (sess() !== s) return;
      for (const id of s.room.remoteParticipants.keys()) tryAutoLink(s, id);
    }, 4000);
    s.timers.push(t0);
    s.timers.push(
      setInterval(() => {
        if (sess() !== s) return;
        const now = Date.now();
        if (sr.ask && now - sr.ask.at > ASK_TTL_MS) {
          sr.ask = null;
          publish(s);
        }
        if (sr.pending && now - sr.pendingAt > ASK_TTL_MS) {
          toast(`${displayName(s.roomId, sr.pending)} didn't answer`, { timeoutMs: 4000 });
          sr.pending = "";
          publish(s);
        }
        // a linked peer whose receipts stopped listing us (they restarted / unlinked without telling us)
        for (const id of [...sr.group]) {
          const p = sr.peers.get(id);
          if (p && now - p.at < PEER_SILENT_MS && p.m.length && !p.m.includes(s.myIdentity) && now - p.at > 6000) {
            sr.group.delete(id);
            log.info(`[sr] ${id} no longer lists us as linked`);
          }
        }
        if (!sr.group.size && sr.elect.holder) leaveGroup(s, "no peers left");
        // the election must keep running while our own tap is quiet (a peer may be speaking)
        if (sr.group.size && now - sr.lastTick > 150) runElection(s, now);
        // a replaced mic track starts enabled: keep the gate applied
        applyGate(s);
      }, 500),
    );
  });
  hooks.onTeardown.push(() => reset(null));
  // mute changes: the gate must follow (an unmute re-enables the track — re-apply)
  useCallStore.subscribe((st, prev) => {
    if (st.micMuted !== prev.micMuted || st.pttSpeaking !== prev.pttSpeaking || st.serverMuted !== prev.serverMuted) setTimeout(() => applyGate(sess()), 0);
  });
}
