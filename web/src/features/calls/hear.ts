// hear.ts — "can they hear me?" (Tin Hat 10.5, native hear.rs) — the web implementation of the
// same facts: mic check, talking while muted, "not coming through", what I receive from each peer,
// `tinhat.rx` receipts every 3 s, the heard-by summary, peers' echo reports (`tinhat.echo`).
// Analyzer step 250 ms; receipts every 12 ticks. The snapshot is the engine's `hear` field
// (same JSON as hear.rs:1707-1864).
import { Track } from "livekit-client";
import { playMutedCue } from "@/core/sounds";
import { createLogger } from "@/core/log";
import type { HearPeer, HearSnapshot, HearsMe, IHear } from "./contract";
import { getCall, patch } from "./store";
import { sess, type Sess } from "./session";
import { hooks, missingKeyFor, sendData, setMicCaptureHook, setMicFrameSink, setRemoteFrameSink } from "./engine";
import { inbound, micTx } from "./stats";
import * as audio from "./audio";
import { dbfs, displayName, isRecorder, joinNames } from "./util";
import { echoOf, echoStep, feedRecv, feedSent, localEcho, resetEcho } from "./echo";
import { notePeerRx, noteProcessedFrames, rxFields } from "./sameroom/link";
import { useCallStore } from "./store";

const log = createLogger("hear");

// ---- mic capture state -----------------------------------------------------------------------------

const mic = {
  captureStart: 0,
  aliveFrames: 0,
  alive: false,
  hintUnmutedMs: 0,
  osMuted: false,
  label: "",
  ref: -30, // learned speech level (dBFS)
  learned: false,
  mutedRing: [] as boolean[], // last 100 muted frames above threshold?
  mutedTalkUntil: 0,
  talkRing: [] as Array<{ above: boolean; loud: boolean; db: number }>, // last 200 unmuted frames
  burst: null as null | { start: number; confirmed: boolean; levels: number[]; lastTalk: number; loud: boolean },
  unconfLoud: [] as number[],
  quiet: [] as number[],
  unmutedAt: 0,
  lastFrames: [] as number[], // recent dB (for "silent")
};

let lastSpokeAt = 0; // SFU listed us as an active speaker
function threshold(): number {
  if (!mic.learned) return -38;
  return Math.max(-48, Math.min(-28, mic.ref - 12));
}

let captureListeners: AbortController | null = null;
setMicCaptureHook((t) => {
  captureListeners?.abort(); // the replaced capture can no longer flip osMuted
  captureListeners = new AbortController();
  mic.captureStart = Date.now();
  mic.aliveFrames = 0;
  mic.alive = false;
  mic.hintUnmutedMs = 0;
  mic.osMuted = t.muted;
  mic.label = t.label || "System default";
  t.addEventListener("mute", () => (mic.osMuted = true), { signal: captureListeners.signal });
  t.addEventListener("unmute", () => (mic.osMuted = false), { signal: captureListeners.signal });
});

setMicFrameSink((frames, stamp) => {
  const st = getCall();
  feedSent(frames, st.micMuted || st.serverMuted, stamp);
  noteProcessedFrames(frames); // same room: the election's fallback level when no raw capture could be opened
  const now = Date.now();
  const thr = threshold();
  for (const f of frames) {
    if (!mic.alive && f >= 3e-6) {
      mic.aliveFrames++;
      if (mic.aliveFrames >= 20) mic.alive = true;
    }
    const db = dbfs(f);
    if (st.micMuted) {
      mic.mutedRing.push(db > thr);
      if (mic.mutedRing.length > 100) mic.mutedRing.shift();
    } else {
      if (now - lastSpokeAt < 600 && db > -60) {
        mic.ref = 0.98 * mic.ref + 0.02 * db;
        mic.learned = true;
      }
      mic.talkRing.push({ above: db > thr, loud: db > Math.max(thr, -30), db });
      if (mic.talkRing.length > 200) mic.talkRing.shift();
    }
  }
  if (st.micMuted && mic.mutedRing.filter(Boolean).length >= 45) mic.mutedTalkUntil = now + 1500;
});

// ---- per-peer receive state --------------------------------------------------------------------------------

const peerAudio = new Map<string, { maxAt: Array<[number, number]> }>(); // identity → recent (t, dB)
const speakSamples = new Map<string, boolean[]>(); // identity → last 12 SFU speaking samples

setRemoteFrameSink((r, frames, stamp) => {
  feedRecv(r.sid, r.identity, r.category, frames, stamp);
  if (r.category !== "mic") return;
  const e = peerAudio.get(r.identity) ?? { maxAt: [] };
  let m = -100;
  for (const f of frames) m = Math.max(m, dbfs(f));
  const now = Date.now();
  e.maxAt.push([now, m]);
  while (e.maxAt.length && now - e.maxAt[0][0] > 3000) e.maxAt.shift();
  peerAudio.set(r.identity, e);
});

function iHear(s: Sess, identity: string): IHear {
  const p = s.room.remoteParticipants.get(identity);
  const pub = p?.getTrackPublication(Track.Source.Microphone);
  if (!p || !pub) return "nomic";
  if (pub.isMuted) return "muted";
  const now = Date.now();
  const r = audio.remotes.get(pub.trackSid);
  if (!r) return "waiting";
  const ib = inbound.get(pub.trackSid);
  const mk = missingKeyFor(identity);
  if (mk && now - mk >= 3000) return "nokey";
  if (!ib) return now - r.subscribedAt < 4000 ? "waiting" : "noaudio";
  if (now - ib.lastGrowAt > 2500) return "noaudio";
  // Bytes arrive but nothing reaches our playback graph (element paused / context suspended /
  // a dead source node) → stalled, and the healer's ladder starts (CALL-57).
  if (now - (r.lastFrameAt || r.subscribedAt) > 3000 || audio.contextSuspended()) {
    audio.noteStalled(pub.trackSid);
    return "stalled";
  }
  const samples = speakSamples.get(identity) ?? [];
  const spoke = samples.filter(Boolean).length;
  const e = peerAudio.get(identity);
  const recentMax = e && e.maxAt.length ? Math.max(...e.maxAt.map((x) => x[1])) : -100;
  if (spoke >= 6 && recentMax < -60) return "silent";
  return "ok";
}

// ---- receipts ------------------------------------------------------------------------------------------------

interface Report {
  at: number;
  rx: Record<string, string>;
  deaf: boolean;
  away: boolean;
}
const reports = new Map<string, Report>();
const echoReports = new Map<string, { at: number; lag: number; db: number; room: boolean }>();

hooks.onData.push((s, topic, payload, from) => {
  if (topic === "tinhat.rx") {
    notePeerRx(s, from, payload); // same room: capability + link state ride the receipt
    // Bounded (Astra 14): ≤ 64 entries, short keys/values, null prototype.
    const rx: Record<string, string> = Object.create(null) as Record<string, string>;
    let n = 0;
    if (payload.rx && typeof payload.rx === "object" && !Array.isArray(payload.rx))
      for (const [k, v] of Object.entries(payload.rx as Record<string, unknown>)) {
        if (typeof v !== "string" || k.length > 256 || v.length > 32) continue;
        rx[k] = v;
        if (++n >= 64) break;
      }
    reports.set(from, { at: Date.now(), rx, deaf: payload.deaf === true, away: payload.away === true });
  } else if (topic === "tinhat.echo") {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    if (payload.on === true) {
      echoReports.set(from, { at: Date.now(), lag: num(payload.lag), db: num(payload.db), room: payload.room === true });
    } else echoReports.delete(from);
  }
});

// ---- snapshot -----------------------------------------------------------------------------------------------------

let tick = 0;
let lastMutedCue = 0;

function micCheck(st: ReturnType<typeof getCall>): HearSnapshot["mic"]["check"] {
  if (mic.osMuted) return "osmuted";
  if (mic.alive) return "ok";
  const since = Date.now() - mic.captureStart;
  if (!mic.captureStart || since < 15000) return "wait";
  if (!st.micMuted) mic.hintUnmutedMs += 250;
  return mic.hintUnmutedMs >= 60000 ? "dead" : "hint";
}

function txState(st: ReturnType<typeof getCall>, s: Sess): HearSnapshot["tx"] {
  const now = Date.now();
  const eligible = !st.micMuted && !st.serverMuted && mic.alive && !st.reconnecting;
  if (!eligible) {
    mic.burst = null;
    return { state: "ok", why: "" };
  }
  if (now - lastSpokeAt < 5000) return { state: "ok", why: "" };
  // bursts
  const ring = mic.talkRing;
  const talking = ring.filter((x) => x.above).length >= 100;
  const loud = ring.filter((x) => x.loud).length >= 80;
  if (talking) {
    const last = ring[ring.length - 1];
    if (!mic.burst) mic.burst = { start: now, confirmed: false, levels: [], lastTalk: now, loud: false };
    mic.burst.lastTalk = now;
    mic.burst.loud = mic.burst.loud || loud;
    if (last) mic.burst.levels.push(last.db);
    if (lastSpokeAt >= mic.burst.start - 500) mic.burst.confirmed = true;
  } else if (mic.burst && now - mic.burst.lastTalk > 1500) {
    const b = mic.burst;
    mic.burst = null;
    if (b.confirmed) {
      mic.unconfLoud = [];
      mic.quiet = [];
    } else if (b.loud) mic.unconfLoud.push(now);
    else {
      const sorted = [...b.levels].sort((a, c) => a - c);
      const median = sorted[Math.floor(sorted.length / 2)] ?? -100;
      if (median < -38) mic.quiet.push(now);
    }
  }
  mic.unconfLoud = mic.unconfLoud.filter((t) => now - t < 60000);
  mic.quiet = mic.quiet.filter((t) => now - t < 120000);
  const micPub = s.room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (micPub?.track && micTx.lastGrowAt && now - micTx.lastGrowAt > 8000) return { state: "notsent", why: "nothing has left this computer for 8 s" };
  if (mic.unconfLoud.length >= 2) return { state: "notsent", why: "you were talking, but the call server didn't receive your voice" };
  if (mic.quiet.length >= 3) return { state: "quiet", why: "your voice reaches the call too quietly to count as speech" };
  return { state: "ok", why: "" };
}

function snapshot(s: Sess): HearSnapshot {
  const st = getCall();
  const now = Date.now();
  const peers: Record<string, HearPeer> = {};
  const heard = { ok: 0, total: 0, not: [] as string[], unconf: [] as string[], deaf: [] as string[], pending: [] as string[] };
  const echoMe = { by: [] as string[], room: [] as string[], lag: 0, db: -99 };
  for (const [identity] of s.room.remoteParticipants) {
    if (isRecorder(identity)) continue;
    const rep = reports.get(identity);
    const fresh = rep && now - rep.at <= 8000 ? rep : null;
    let hearsMe: HearsMe;
    if (!fresh) hearsMe = "unconfirmed";
    else {
      const v = fresh.rx[s.myIdentity];
      hearsMe = (v as HearsMe | undefined) ?? "unknown";
    }
    const deaf = !!fresh?.deaf;
    const away = !!fresh?.away || st.awayUsers.includes(identity.slice(0, identity.lastIndexOf(":")));
    // Their report about US (tinhat.echo, kept 75 s): they hear themselves through our mic (or, room:true,
    // our mic picks them up in the same room). Our own detection of THEIR stream → peers[id].echo.
    const ec = echoReports.get(identity);
    if (ec && now - ec.at < 75000) {
      if (ec.room) echoMe.room.push(identity);
      else {
        echoMe.by.push(identity);
        if (ec.db > echoMe.db) {
          echoMe.lag = ec.lag;
          echoMe.db = ec.db;
        }
      }
    }
    const echo = echoOf(identity);
    let notMe: HearPeer["notMe"] = "";
    heard.total++;
    if (hearsMe === "ok") {
      if (deaf || away) heard.deaf.push(identity);
      else heard.ok++;
    } else if (hearsMe === "waiting") heard.pending.push(identity);
    else if (hearsMe === "unconfirmed" || (hearsMe === "unknown" && now - mic.captureStart < 10000)) heard.unconf.push(identity);
    else if (hearsMe === "unknown") {
      heard.not.push(identity);
      notMe = "nosub";
    } else if (hearsMe === "muted") {
      if (st.micMuted || now - mic.unmutedAt < 7000) heard.ok++;
      else {
        heard.not.push(identity);
        notMe = "muted";
      }
    } else {
      heard.not.push(identity);
      notMe = hearsMe === "silent" || hearsMe === "noaudio" || hearsMe === "nokey" || hearsMe === "stalled" ? hearsMe : "other";
    }
    peers[identity] = { deaf, away, hearsMe, notMe, iHear: iHear(s, identity), echo };
  }
  const check = micCheck(st);
  const mutedTalk = st.micMuted && now < mic.mutedTalkUntil;
  return {
    v: 1,
    on: true,
    me: s.myIdentity,
    mic: { check, dev: mic.label },
    out: { check: "ok", dev: st.outputName },
    mutedTalk,
    tx: txState(st, s),
    peers,
    heard,
    echoMe,
    localEcho: localEcho(),
    ecFix:
      echoMe.by.length || localEcho()
        ? { kind: !st.micAec ? "turn_on" : st.ecDegraded ? "retry" : "volume", out: "", label: "" }
        : { kind: "", out: "", label: "" },
  };
}

function step(s: Sess) {
  if (sess() !== s) return;
  if (++expireTick % 20 === 0) expireReports(Date.now()); // every 5 s
  const st = getCall();
  // SFU speaking samples (250 ms apart)
  const active = new Set(st.speakers.active);
  if (active.has(s.myIdentity) || s.room.localParticipant.isSpeaking) lastSpokeAt = Date.now();
  for (const [identity] of s.room.remoteParticipants) {
    const arr = speakSamples.get(identity) ?? [];
    arr.push(active.has(identity));
    if (arr.length > 12) arr.shift();
    speakSamples.set(identity, arr);
  }
  const snap = snapshot(s);
  const prev = st.hear as Partial<HearSnapshot>;
  if (snap.mutedTalk && !prev.mutedTalk && !st.serverMuted && Date.now() - lastMutedCue > 30000) {
    lastMutedCue = Date.now();
    playMutedCue();
  }
  // 4 Hz: keep the same snapshot object (no re-render of every hear reader) when nothing in it changed.
  const micSilent = snap.mic.check === "dead" || snap.mic.check === "hint";
  if (micSilent !== st.micSilent || JSON.stringify(snap) !== JSON.stringify(prev)) patch({ hear: snap, micSilent });
  tick++;
  if (tick % 12 === 0) sendReceipt(s, snap);
  if (tick % 20 === 10)
    for (const [to, payload] of echoStep((sid) => {
      // the local-echo reference = what we actually PLAY (per-person gain, deafen/BRB cut, layers)
      const r = audio.remotes.get(sid);
      return r ? audio.effectiveGain(r) : 0;
    }))
      sendData("tinhat.echo", payload, { to: [to] });
  for (const [k, r] of reports) if (Date.now() - r.at > 20000) reports.delete(k);
}

function sendReceipt(s: Sess, snap: HearSnapshot) {
  const st = getCall();
  const rx: Record<string, string> = {};
  for (const [identity, p] of Object.entries(snap.peers)) {
    if (p.iHear === "nomic") continue;
    if (identity.includes('"') || identity.includes("\\")) continue;
    rx[identity] = p.iHear;
  }
  sendData("tinhat.rx", { v: 1, deaf: st.deafened, away: st.localAfk, rx, ...rxFields(s) }, { reliable: false });
}

// Same room: a link / speakers change goes out with the next analyzer step (≤ 250 ms) instead of waiting
// for the 3 s cadence; a room-mic handoff at most every 1.5 s (the tiles' live-mic dot).
let lastHolderPoke = 0;
useCallStore.subscribe((st, prev) => {
  const a = st.sameRoom,
    b = prev.sameRoom;
  if (a === b) return;
  if (a.linked.join() !== b.linked.join() || a.spk !== b.spk) tick = 11;
  else if (a.holder !== b.holder && Date.now() - lastHolderPoke > 1500) {
    lastHolderPoke = Date.now();
    tick = 11;
  }
});

// ---- lifecycle ------------------------------------------------------------------------------------------------------

hooks.onConnected.push((s) => {
  tick = 0;
  lastSpokeAt = 0;
  mic.mutedRing = [];
  mic.talkRing = [];
  mic.unconfLoud = [];
  mic.quiet = [];
  mic.burst = null;
  mic.unmutedAt = Date.now();
  s.timers.push(setInterval(() => step(s), 250));
  log.info("hear analyzer on");
});

// Departed peers take their receipts / echo reports with them; stale ones expire (Astra 14).
hooks.onParticipantLeft.push((_s, p) => {
  reports.delete(p.identity);
  echoReports.delete(p.identity);
  peerAudio.delete(p.identity);
  speakSamples.delete(p.identity);
});
let expireTick = 0;
function expireReports(now: number) {
  for (const [k, r] of reports) if (now - r.at > 60000) reports.delete(k);
  for (const [k, r] of echoReports) if (now - r.at >= 75000) echoReports.delete(k);
}

hooks.onTeardown.push(() => {
  resetEcho();
  captureListeners?.abort();
  captureListeners = null;
  mic.captureStart = 0;
  mic.aliveFrames = 0;
  mic.alive = false;
  mic.hintUnmutedMs = 0;
  mic.osMuted = false;
  reports.clear();
  echoReports.clear();
  peerAudio.clear();
  speakSamples.clear();
  patch({ hear: {}, micSilent: false });
});

// track unmute moments (the 7 s grace for peers still seeing us muted)
let wasMuted = false;
export function noteMute(muted: boolean): void {
  if (wasMuted && !muted) mic.unmutedAt = Date.now();
  wasMuted = muted;
}

// ---- heard-by summary (AppCore.qml:596-612) -------------------------------------------------------------------------

/** "Heard by 2 of 3 · Ann isn't receiving you · …" for the mic button tooltip / mic face. */
export function heardSummary(h: HearSnapshot | Record<string, never>, micMuted: boolean, inCall: boolean, roomId: string): string {
  const hs = h as HearSnapshot;
  if (!inCall || !hs.heard || hs.heard.total === 0) return "";
  if (micMuted) return "You're muted — nobody hears your mic";
  const name = (i: string) => displayName(roomId, i);
  const parts: string[] = [];
  const reporting = hs.heard.total - hs.heard.unconf.length - hs.heard.pending.length;
  if (reporting > 0) parts.push(`Heard by ${hs.heard.ok} of ${reporting}`);
  if (hs.heard.not.length) parts.push(`${joinNames(hs.heard.not.map(name))} ${hs.heard.not.length === 1 ? "isn't" : "aren't"} receiving you`);
  if (hs.heard.deaf.length) parts.push(`${joinNames(hs.heard.deaf.map(name))} ${hs.heard.deaf.length === 1 ? "has" : "have"} deafened or stepped away`);
  if (hs.heard.unconf.length)
    parts.push(`${joinNames(hs.heard.unconf.map(name))}${hs.heard.unconf.length === 1 ? "'s app doesn't" : "'s apps don't"} report what it hears`);
  return parts.join(" · ");
}

/** Plain-English reasons for the tile marks (AppCore.qml:578-593). */
export const NOT_ME_REASON: Record<string, string> = {
  silent: "your audio reaches them silent",
  noaudio: "no audio from you is arriving there",
  nokey: "they can't decrypt you — the key is missing",
  stalled: "their speakers stalled — their app is repairing it",
  nosub: "their app isn't subscribed to your mic",
  muted: "they still see you as muted",
  other: "their app reports a problem",
};
export const I_HEAR_REASON: Record<string, string> = {
  silent: "they're talking, but their audio arrives silent",
  noaudio: "no audio from them is arriving",
  nokey: "their encryption key is missing",
  stalled: "your output for them stalled — repairing",
};
