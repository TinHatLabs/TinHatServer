// av1.ts — receive Tin Hat desktops' AV1 screen shares inside encrypted calls (tinhat-av1-e2ee-v2).
//
// Natives pin their share to H.264 whenever a live call member's `dev.tinhat.client.kind` is not
// "native" (native rtc.rs non_native_call_members, call_ctl.rs maybe_rescan_peers). With the patched
// livekit-client E2EE worker (patches/livekit-client@2.22.3.patch, made by tools/av1-patch-worker.py) this
// browser can decrypt the natives' AV1 wrapper format, so — only when that is verified here — the
// membership advertises {kind:"native", web:true, caps:["av1e2ee"], …} and the desktops keep AV1.
//
// Kill switches: pref "av1-receive" (default on; off = kind "web" at once, membership re-published) and
// the runtime safety net below (repeated AV1 auth failures / AV1 packets without decoded frames → kind
// "web" for the rest of this tab). Format + evidence: ./AV1.md.
import type { RemoteVideoTrack, Room } from "livekit-client";
import { RoomEvent } from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import { getPref, onPrefChange, setPref } from "@/core/prefs";
import { createLogger } from "@/core/log";
import { getFormFactor } from "@/core/device";
import { PAD_CAP } from "./pad/rules";
import { padAllowed } from "./pad/prefs";
import { useCallStore } from "./store";

const log = createLogger("av1");

export const AV1_PREF = "av1-receive";
export const AV1_STAMP = "tinhat-av1-e2ee-v2";
/** Safety-net thresholds (AV1.md §kill switches). */
const AUTH_FAIL_TRIP = 30;
const STALL_TRIP_MS = 5000;
const FAIL_WINDOW_MS = 3000;

interface Caps {
  codec: boolean;
  transform: boolean;
  worker: boolean;
  /** mediaCapabilities says a 1080p30 AV1 share plays smoothly (phones: only with hardware AV1 decode). */
  smooth: boolean;
  ok: boolean;
}
let caps: Caps | null = null;
let probing: Promise<Caps> | null = null;
/** Why the safety net switched AV1 off for this tab ("" = it did not). */
let degraded = "";

function browserHasAv1(): boolean {
  try {
    const c = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null;
    return !!c?.codecs.some((x) => x.mimeType.toLowerCase() === "video/av1");
  } catch {
    return false;
  }
}

function browserHasEncodedTransform(): boolean {
  const g = globalThis as unknown as { RTCRtpScriptTransform?: unknown; RTCRtpReceiver?: { prototype: object } };
  return typeof g.RTCRtpScriptTransform !== "undefined" || (!!g.RTCRtpReceiver && "createEncodedStreams" in g.RTCRtpReceiver.prototype);
}

/** Ask a throwaway E2EE worker whether it is the patched one AND passes its round-trip self-test.
 *  "retry" = the worker never answered (load error / timeout — e.g. the boot-time probe starved by a busy main
 *  thread, or a network blip fetching the worker chunk): not a verdict about this browser. */
function probeWorker(timeoutMs = 4000): Promise<"yes" | "no" | "retry"> {
  return new Promise((resolve) => {
    let w: Worker | null = null;
    const done = (r: "yes" | "no" | "retry") => {
      clearTimeout(t);
      try {
        w?.terminate();
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    const t = setTimeout(() => done("retry"), timeoutMs);
    try {
      w = new E2EEWorker();
      w.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { kind?: string; data?: { stamp?: string; selfTest?: boolean } };
        if (m?.kind === "tinhat-av1-probe") done(m.data?.stamp === AV1_STAMP && m.data?.selfTest === true ? "yes" : "no");
      };
      w.onerror = () => done("retry");
      w.postMessage({ kind: "tinhat-av1-probe", data: {} });
    } catch {
      done("retry");
    }
  });
}

/** Can this device play a typical Tin Hat share (1080p30 AV1) well? A browser decodes AV1 in software with stock
 *  dav1d (no frame-parallel patch like the desktop's), and on a phone that means a choppy, battery-hungry share
 *  where H.264 would have been hardware-decoded — so phones need hardware AV1 (powerEfficient). Desktop Chromium
 *  reports smooth for everything (measured), so this mainly gates phones. No API / an error → allowed. */
async function av1DecodeOk(): Promise<boolean> {
  const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  if (!mc?.decodingInfo) return true;
  try {
    const r = await mc.decodingInfo({
      type: "webrtc",
      video: { contentType: "video/AV1", width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 },
    } as unknown as MediaDecodingConfiguration);
    if (!r.supported || !r.smooth) return false;
    return getFormFactor() === "mobile" ? r.powerEfficient === true : true;
  } catch {
    return true;
  }
}

/** Worker probes that got no answer so far; after MAX_PROBE_RETRIES the "no" is final for this tab. */
let probeMisses = 0;
const MAX_PROBE_RETRIES = 3;

/** Capability check. Memoised once it is a real verdict; a worker that never answered is re-probed on the next
 *  call (the next join), so one slow boot does not pin the whole tab to kind "web". */
export function av1Probe(): Promise<Caps> {
  if (probing) return probing;
  if (caps && (probeMisses === 0 || probeMisses >= MAX_PROBE_RETRIES)) return Promise.resolve(caps);
  probing = (async () => {
    const codec = browserHasAv1();
    const transform = browserHasEncodedTransform();
    const w = codec && transform ? await probeWorker() : "no";
    const worker = w === "yes";
    const smooth = worker ? await av1DecodeOk() : false;
    const c: Caps = { codec, transform, worker, smooth, ok: codec && transform && worker && smooth };
    caps = c;
    probeMisses = w === "retry" ? probeMisses + 1 : 0;
    const why = worker ? AV1_STAMP : w === "retry" ? `no answer (${probeMisses}/${MAX_PROBE_RETRIES}${probeMisses < MAX_PROBE_RETRIES ? ", re-checked at the next join" : ""})` : "no";
    log.info(`receive capability: AV1 decoder ${codec ? "yes" : "no"}, encoded transform ${transform ? "yes" : "no"}, patched worker ${why}, smooth decode ${smooth ? "yes" : "no"} → ${c.ok ? "can decrypt Tin Hat AV1" : 'kind "web"'}`);
    return c;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

/** True when our membership should tell natives they may keep AV1. */
export function av1Advertised(): boolean {
  return !!caps?.ok && !degraded && getPref(AV1_PREF, true) === true;
}

/** The `dev.tinhat.client` marker for our membership (key order as natives' own). `caps` sits in both branches:
 *  "av1e2ee" (this browser decrypts natives' AV1) and "pad1" (Settings → Calls → Pad is on: my other verified devices
 *  may control this call, docs/PAD.md); left out when empty. */
export function clientMarker(version: string, recordOptout: boolean): Record<string, unknown> {
  // a device that only WATCHES the call is never a Pad receiver (Pad QOL: its mic must not be openable remotely)
  const pad = padAllowed() && !useCallStore.getState().watching ? [PAD_CAP] : [];
  if (av1Advertised()) return { kind: "native", web: true, caps: ["av1e2ee", ...pad], version, record_optout: recordOptout };
  return pad.length ? { kind: "web", caps: pad, version, record_optout: recordOptout } : { kind: "web", version, record_optout: recordOptout };
}

// ---- runtime safety net ------------------------------------------------------------------------------

interface WorkerStat {
  ok: number;
  authFail: number;
  malformed: number;
  /** authFail+malformed at the last time `ok` advanced */
  failAtOk: number;
  /** when the current run of failures (since the last good frame) started, 0 = none */
  failSince: number;
  lastOk: number;
  lastSeen: number;
}
interface RtpStat {
  packets: number;
  decoded: number;
  stallMs: number;
  codec: string;
}
const workerStats = new Map<string, WorkerStat>(); // "identity|trackId" → counters from that track's cryptor
const rtpStats = new Map<string, RtpStat>(); // track sid → inbound-rtp deltas

let stopWatch: (() => void) | null = null;

/** Hook: called once per call session right after `room.setE2EEEnabled(true)` (engine.ts). */
export function av1Watch(room: Room, worker: Worker, republish: () => Promise<void>): void {
  stopWatch?.();
  workerStats.clear();
  rtpStats.clear();
  let stopped = false;
  const trip = (reason: string) => {
    if (degraded || stopped || !av1Advertised()) return;
    degraded = reason;
    // the ONE console line (createLogger prints "[av1] …" and keeps it in the diagnostics ring)
    log.warn(`safety net: ${reason} — advertising kind "web" from now on: Tin Hat desktops pick H.264 for new shares (their live re-publish of a running AV1 share still comes out AV1 — docs/native-bugs/calls-av1.md)`);
    void republish();
  };
  const onMsg = (ev: MessageEvent) => {
    const m = ev.data as { kind?: string; data?: { participantIdentity?: string; trackId?: string; ok?: number; authFail?: number; malformed?: number } };
    if (m?.kind !== "tinhat-av1" || !m.data?.participantIdentity) return;
    const id = m.data.participantIdentity;
    const key = `${id}|${m.data.trackId ?? ""}`;
    const now = Date.now();
    const prev = workerStats.get(key) ?? { ok: 0, authFail: 0, malformed: 0, failAtOk: 0, failSince: 0, lastOk: 0, lastSeen: 0 };
    const ok = m.data.ok ?? 0;
    const authFail = m.data.authFail ?? 0;
    const malformed = m.data.malformed ?? 0;
    const cur: WorkerStat = { ...prev, ok, authFail, malformed, lastSeen: now };
    if (ok > prev.ok) {
      cur.lastOk = now;
      cur.failAtOk = authFail + malformed;
      cur.failSince = 0;
    } else if (authFail + malformed > cur.failAtOk && !cur.failSince) {
      cur.failSince = now;
    }
    workerStats.set(key, cur);
    // ≥ 30 AV1 frames refused (GCM auth or not in the wrapper form) with no good frame for ≥ 3 s
    if (authFail + malformed - cur.failAtOk >= AUTH_FAIL_TRIP && cur.failSince && now - cur.failSince >= FAIL_WINDOW_MS) {
      trip(`AV1 from ${id}: ${authFail + malformed - cur.failAtOk} frames failed to decrypt (auth ${authFail}, malformed ${malformed})`);
    }
  };
  worker.addEventListener("message", onMsg);

  // No decoded AV1 frame for 5 s while AV1 packets arrive and the worker is decrypting them (a missing
  // key never reaches the worker's AV1 path, so a slow key doesn't trip this).
  const poll = setInterval(() => {
    void (async () => {
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.videoTrackPublications.values()) {
          const tr = pub.videoTrack as RemoteVideoTrack | undefined;
          const rx = tr?.receiver;
          if (!tr || !rx) continue;
          let rep: RTCStatsReport;
          try {
            rep = await rx.getStats();
          } catch {
            continue;
          }
          let inbound: { packetsReceived?: number; framesDecoded?: number; codecId?: string } | null = null;
          rep.forEach((s: { type?: string; kind?: string }) => {
            if (s.type === "inbound-rtp" && s.kind === "video") inbound = s as typeof inbound;
          });
          const ib = inbound as { packetsReceived?: number; framesDecoded?: number; codecId?: string } | null;
          if (!ib) continue;
          const codec = ((ib.codecId && (rep.get(ib.codecId) as { mimeType?: string } | undefined)?.mimeType) || "").toLowerCase();
          const sid = pub.trackSid;
          const prev = rtpStats.get(sid);
          const cur: RtpStat = { packets: ib.packetsReceived ?? 0, decoded: ib.framesDecoded ?? 0, stallMs: 0, codec };
          if (prev && codec === "video/av1") {
            const now = Date.now();
            const workerBusy = [...workerStats.entries()].some(([k, w]) => k.startsWith(`${p.identity}|`) && now - w.lastSeen < 3000);
            cur.stallMs = cur.packets > prev.packets && cur.decoded === prev.decoded && workerBusy ? prev.stallMs + 1000 : 0;
            if (cur.stallMs >= STALL_TRIP_MS) trip(`AV1 from ${p.identity}: packets arriving but no frame decoded for ${cur.stallMs / 1000} s`);
          }
          rtpStats.set(sid, cur);
        }
      }
    })();
  }, 1000);

  // "av1-receive" switched mid-call → re-publish the membership (same created_ts) with the new marker.
  const offPref = onPrefChange(AV1_PREF, () => {
    log.info(`pref ${AV1_PREF} = ${getPref(AV1_PREF, true)} → marker kind "${av1Advertised() ? "native" : "web"}"`);
    void republish();
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    worker.removeEventListener("message", onMsg);
    offPref();
    room.off(RoomEvent.Disconnected, stop);
    if (stopWatch === stop) stopWatch = null;
  };
  room.on(RoomEvent.Disconnected, stop);
  stopWatch = stop;
}

/** Test/diagnostics surface (`window.__twAv1`). */
export function av1State() {
  return {
    caps,
    advertised: av1Advertised(),
    pref: getPref(AV1_PREF, true),
    degraded,
    worker: Object.fromEntries(workerStats),
    rtp: Object.fromEntries(rtpStats),
  };
}

if (typeof window !== "undefined") {
  const w = window as unknown as { __TW_DEBUG__?: boolean; __twAv1?: unknown };
  // test hook, same gate as window.__twCall
  if (import.meta.env.DEV || w.__TW_DEBUG__)
    w.__twAv1 = { state: av1State, probe: av1Probe, setEnabled: (on: boolean) => setPref(AV1_PREF, on) };
  // start the probe early so the first join never waits for it
  void av1Probe();
}
