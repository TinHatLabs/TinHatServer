// stats.ts — outgoing stream health every 3 s (`publishStats`, call.rs:615-920), the share
// auto-fit governor (lk_publish.rs AUTO_RUNGS) and inbound audio activity (bytes per remote track,
// the hear analyzer's "noaudio" input).
import { Track, type LocalTrack } from "livekit-client";
import { createLogger } from "@/core/log";
import { onWinState, winFocused } from "@/core/winstate";
import { UNFOCUSED_STATS_MS } from "@/core/lowgpu";
import type { PublishStat } from "./contract";
import { getCall, patch, setStatus } from "./store";
import { sess, type Sess } from "./session";
import { hooks, onCameraStalled, parseShareQuality, reapplyShare, shareAuto } from "./engine";

const log = createLogger("call-stats");

/** (w, h, base kbps at the Great tier, floor kbps) */
export const AUTO_RUNGS: Array<[number, number, number, number]> = [
  [3840, 2160, 24000, 16000],
  [2560, 1440, 15000, 9000],
  [1920, 1080, 9000, 4500],
  [1280, 720, 5000, 2200],
  [960, 540, 2800, 0],
];
let rung = 2;

function autoFactor(): number {
  const q = parseShareQuality(getCall().shareQuality);
  return Math.max(0.3, Math.min(3, q.kbps / 12000));
}

export function syncAutoRung(): void {
  const r = AUTO_RUNGS[rung];
  shareAuto.w = r[0];
  shareAuto.h = r[1];
  shareAuto.kbps = Math.round(r[2] * autoFactor());
}
syncAutoRung();

interface Prev {
  bytes: number;
  ts: number;
}
const prev = new Map<string, Prev>();
let autoEma = 0;
let autoAgree = 0;
let autoLastRefit = 0;

/** Remote inbound audio: track sid → {bytes, ts, lastGrowAt}. */
export const inbound = new Map<string, { bytes: number; lastGrowAt: number; packetsLost: number }>();
/** Our mic's bytesSent history (tx "nothing has left this computer for 8 s"). */
export const micTx = { bytes: 0, lastGrowAt: 0 };

function kindFor(t: LocalTrack, rid: string): string {
  if (t.source === Track.Source.Microphone) return "mic";
  if (t.source === Track.Source.ScreenShare) return "screen";
  if (t.source === Track.Source.Camera) return `camera/${rid || "f"}`;
  return t.source === Track.Source.ScreenShareAudio ? "music" : "sound";
}

function pickLabel(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("h264")) return "H.264 (browser)";
  if (m.includes("vp9")) return "VP9 (browser)";
  if (m.includes("vp8")) return "VP8 (browser)";
  if (m.includes("av1")) return "AV1 (browser)";
  if (m.includes("opus")) return "Opus";
  return mime.replace(/^.*\//, "");
}

let camFrames = 0;
let erle: number | null = null;
const camWatch = { frames: -1, flatSince: 0 };

async function collect(s: Sess): Promise<PublishStat[]> {
  const out: PublishStat[] = [];
  camFrames = 0;
  erle = null;
  const tracks: LocalTrack[] = [];
  for (const pub of s.room.localParticipant.trackPublications.values()) if (pub.track) tracks.push(pub.track as LocalTrack);
  const seen = new Set<string>();
  for (const t of tracks) {
    const sender = t.sender;
    if (!sender) continue;
    let report: RTCStatsReport;
    try {
      report = await sender.getStats();
    } catch {
      continue;
    }
    const byId = new Map<string, Record<string, unknown>>();
    report.forEach((v) => byId.set((v as { id: string }).id, v as Record<string, unknown>));
    const remote = new Map<number, Record<string, unknown>>();
    for (const v of byId.values()) if (v.type === "remote-inbound-rtp") remote.set(v.ssrc as number, v);
    for (const v of byId.values()) {
      if (v.type !== "outbound-rtp") continue;
      const rid = typeof v.rid === "string" ? v.rid : "";
      const kind = kindFor(t, rid);
      const key = `${t.sid ?? t.mediaStreamID}|${rid}|${v.ssrc}`;
      seen.add(key);
      const bytes = Number(v.bytesSent ?? 0);
      const ts = Number(v.timestamp ?? performance.now());
      const p = prev.get(key);
      prev.set(key, { bytes, ts });
      const sendKnown = !!p && ts > p.ts;
      const sendKbps = sendKnown ? Math.max(0, Math.round(((bytes - p!.bytes) * 8) / (ts - p!.ts))) : 0;
      const codec = byId.get(String(v.codecId ?? ""));
      const mime = String(codec?.mimeType ?? "");
      const ri = remote.get(v.ssrc as number);
      const q = String(v.qualityLimitationReason ?? "none");
      out.push({
        kind,
        enc: String(v.encoderImplementation ?? pickLabel(mime)),
        encPick: pickLabel(mime),
        rid,
        w: Number(v.frameWidth ?? 0),
        h: Number(v.frameHeight ?? 0),
        fps: Math.round(Number(v.framesPerSecond ?? 0)),
        targetKbps: Math.round(Number(v.targetBitrate ?? 0) / 1000),
        sendKbps,
        qlim: (q === "bandwidth" || q === "cpu" || q === "none" ? q : "other") as PublishStat["qlim"],
        lossPct: ri && typeof ri.fractionLost === "number" ? Math.round((ri.fractionLost as number) * 1000) / 10 : -1,
        rttMs: ri && typeof ri.roundTripTime === "number" ? Math.round((ri.roundTripTime as number) * 1000) : -1,
        jitterMs: ri && typeof ri.jitter === "number" ? Math.round((ri.jitter as number) * 1000) : -1,
        key: Number(v.keyFramesEncoded ?? 0),
        nack: Number(v.nackCount ?? 0),
        pli: Number(v.pliCount ?? 0),
        active: v.active !== false,
        sendKnown,
      });
      if (kind === "mic") {
        if (bytes > micTx.bytes) micTx.lastGrowAt = Date.now();
        micTx.bytes = bytes;
      }
      if (kind.startsWith("camera/")) camFrames += Number(v.framesEncoded ?? v.framesSent ?? 0);
    }
    // The mic's media-source: the browser echo canceller's own ERLE (CALL-45 note).
    if (t.source === Track.Source.Microphone)
      for (const v of byId.values())
        if (v.type === "media-source" && v.kind === "audio" && typeof v.echoReturnLossEnhancement === "number") erle = v.echoReturnLossEnhancement as number;
  }
  for (const k of [...prev.keys()]) if (!seen.has(k)) prev.delete(k);
  return out;
}

async function inboundTick(s: Sess) {
  for (const p of s.room.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) {
      const t = pub.track;
      const recv = t?.receiver;
      if (!recv) continue;
      try {
        const rep = await recv.getStats();
        rep.forEach((v) => {
          const r = v as Record<string, unknown>;
          if (r.type !== "inbound-rtp") return;
          const bytes = Number(r.bytesReceived ?? 0);
          const cur = inbound.get(pub.trackSid) ?? { bytes: 0, lastGrowAt: Date.now(), packetsLost: 0 };
          if (bytes > cur.bytes) cur.lastGrowAt = Date.now();
          cur.bytes = bytes;
          cur.packetsLost = Number(r.packetsLost ?? 0);
          inbound.set(pub.trackSid, cur);
        });
      } catch {
        /* receiver gone */
      }
    }
  }
}

function governor(stats: PublishStat[]) {
  const q = parseShareQuality(getCall().shareQuality);
  if (q.w !== 0 && q.h !== 0) return;
  const scr = stats.find((x) => x.kind === "screen");
  if (!scr || scr.targetKbps <= 0) return;
  autoEma = autoEma === 0 ? scr.targetKbps : autoEma * 0.6 + scr.targetKbps * 0.4;
  const f = autoFactor();
  const cap = AUTO_RUNGS[rung][2] * f;
  const floor = AUTO_RUNGS[rung][3] * f;
  let want = rung;
  if (autoEma >= cap * 0.92) want = Math.max(0, rung - 1);
  else if (autoEma < floor * 0.85) {
    want = AUTO_RUNGS.length - 1;
    for (let i = 0; i < AUTO_RUNGS.length; i++) {
      if (autoEma >= AUTO_RUNGS[i][3] * f) {
        want = i;
        break;
      }
    }
  }
  autoAgree = want !== rung ? autoAgree + 1 : 0;
  if (autoAgree >= 4 && Date.now() - autoLastRefit >= 30000) {
    autoAgree = 0;
    autoLastRefit = Date.now();
    log.info(`[share-auto] grant ~${Math.round(autoEma)}kbps vs cap ${Math.round(cap)}/floor ${Math.round(floor)} -> ${AUTO_RUNGS[want][0]}x${AUTO_RUNGS[want][1]}`);
    rung = want;
    autoEma = 0;
    syncAutoRung();
    setStatus(`Share auto-fit: adjusting to ${AUTO_RUNGS[want][0]}x${AUTO_RUNGS[want][1]} for your connection`);
    void reapplyShare(false);
  }
}

hooks.onConnected.push((s) => {
  rung = 2;
  syncAutoRung();
  micTx.bytes = 0;
  micTx.lastGrowAt = Date.now();
  // Sampling stays every 3 s (the share auto-fit, the camera and echo watches keep their timing). GPU.md §2.8 /
  // §2.11: what the UI shows (the call bar's health dot, the health popup — both re-render with each patch) refreshes
  // with every sample while the window is focused, at most every 5 s while it isn't, and at once on focus.
  let shown = 0;
  let latest: PublishStat[] | null = null;
  const show = () => {
    if (!latest || sess() !== s) return;
    shown = Date.now();
    patch({ publishStats: latest });
  };
  s.timers.push(
    setInterval(async () => {
      if (sess() !== s) return;
      const stats = await collect(s);
      if (sess() !== s) return;
      latest = stats;
      if (winFocused() || Date.now() - shown >= UNFOCUSED_STATS_MS - 250) show();
      governor(stats);
      cameraWatch(s);
      ecWatch(s);
    }, 3000),
  );
  s.cleanups.push(onWinState((now, prev) => now === "focused" && prev !== "focused" && show()));
  // Inbound audio activity at 1 Hz (the hear analyzer's "no audio arriving for 2 s").
  s.timers.push(setInterval(() => sess() === s && void inboundTick(s), 1000));
});

/** Camera frames stopped for ≥ 3 s while live → restart the capture (call_ctl.rs:1384-1515). */
function cameraWatch(s: Sess) {
  const cam = s.cam;
  // (hidden: phones pause / stop the camera in the background — a restart from there only fails; the
  // engine checks the capture when the page is back)
  if (!cam || cam.mediaStreamTrack.readyState !== "live" || cam.isMuted || document.visibilityState === "hidden") {
    camWatch.frames = -1;
    camWatch.flatSince = 0;
    return;
  }
  if (camWatch.frames >= 0 && camFrames <= camWatch.frames) {
    if (!camWatch.flatSince) camWatch.flatSince = Date.now() - 3000;
    if (Date.now() - camWatch.flatSince >= 3000) {
      log.warn(`[cam-health] frames flat for ${Math.round((Date.now() - camWatch.flatSince) / 1000)} s`);
      camWatch.flatSince = 0;
      camWatch.frames = -1;
      onCameraStalled();
      return;
    }
  } else camWatch.flatSince = 0;
  camWatch.frames = camFrames;
}

/** Echo canceller state + note (CALL-44/45): wanted but not running = degraded. */
function ecWatch(s: Sess) {
  const st = getCall();
  const mic = s.mic;
  if (!st.micAec || !mic) {
    if (st.ecDegraded || st.ecNote) patch({ ecDegraded: false, ecNote: "" });
    return;
  }
  const running = mic.mediaStreamTrack.getSettings().echoCancellation !== false;
  let note: string;
  if (!running) note = "switched on but NOT running — the browser gave us the mic without it, so others may hear their own voice back";
  else if (erle !== null && Number.isFinite(erle) && erle > 0.5) note = `running — removing about ${erle.toFixed(0)} dB of what your speakers play from your mic`;
  else if (erle !== null) note = "running — it measures itself as soon as someone else talks";
  else note = "running";
  if (st.ecDegraded !== !running || st.ecNote !== note) patch({ ecDegraded: !running, ecNote: note });
}

hooks.onTeardown.push(() => {
  camWatch.frames = -1;
  camWatch.flatSince = 0;
  prev.clear();
  inbound.clear();
  autoEma = 0;
  autoAgree = 0;
});
