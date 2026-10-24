// extras.ts — join sound (joinsound.rs), the connection test (call_ctl.rs:2204-2364, 4718-4771)
// and the guest-session hand-off (the server's Tin Hat API).
import { ConnectionState, LocalVideoTrack, Room, Track } from "livekit-client";
import { getState, getSession, peekClient, JOINSOUNDS_ROOM_TYPE, JOINSOUND_PROFILE_KEY } from "@/core/matrix";
import { apiFetch } from "@/core/api";
import { createLogger } from "@/core/log";
import { getCall, patch } from "./store";
import { sess } from "./session";
import { hooks, playSound, stopSound } from "./engine";
import { mintSfuToken, resolveFocus } from "./rtc";
import { errText, localpart, sleep } from "./util";

const log = createLogger("call-extras");

// ---- join sound ----------------------------------------------------------------------------------------

let lastJoinSoundAt = 0;

async function joinSoundUrl(me: string): Promise<string> {
  const c = peekClient();
  if (!c) return "";
  try {
    const base = c.getHomeserverUrl().replace(/\/+$/, "");
    const r = await fetch(`${base}/_matrix/client/v3/profile/${encodeURIComponent(me)}/${encodeURIComponent(JOINSOUND_PROFILE_KEY)}`, {
      headers: { Authorization: `Bearer ${c.getAccessToken()}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return "";
    const j = (await r.json()) as Record<string, unknown>;
    const v = j[JOINSOUND_PROFILE_KEY];
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

hooks.joinSound = (s) => {
  void (async () => {
    const url = await joinSoundUrl(s.me);
    if (!url) return log.info("[joinsound] skipped: no join sound set");
    const rs = getState<{ enabled?: boolean }>(s.roomId, JOINSOUNDS_ROOM_TYPE, "");
    if (rs && rs.enabled === false) return log.info("[joinsound] skipped: join sounds are off in this room");
    if (Date.now() - lastJoinSoundAt < 60000) return log.info("[joinsound] skipped: cooldown: rejoined too soon");
    if (sess() !== s) return;
    lastJoinSoundAt = Date.now();
    await playSound(url, 3000);
    setTimeout(() => {
      if (sess() === s) void stopSound();
    }, 3000);
  })();
};

// ---- connection test (call_ctl.rs:2204-2364; lk_publish.rs connection_probe) ---------------------------------
// Phase 1: raw uplink (8 MiB POST to /api/speedtest/up). Phase 2: publish "snow" (random noise, which no
// encoder can compress) as a screen share into a scratch LiveKit room capped at 100 Mbps and watch the
// congestion controller's grant (outbound targetBitrate) once a second: at least 20 s, then until it
// plateaus (≤ 4 % rise over the trailing 5 s), wall 45 s. Same verdict sentences as the native.

let testing = false;
const PROBE_CAP_BPS = 100_000_000;

/** A canvas of changing noise → a MediaStreamTrack (960×540 @ 30; pre-generated frames, cycled). */
function snowTrack(): { track: MediaStreamTrack; stop(): void } {
  const w = 960;
  const h = 540;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  const frames: ImageData[] = [];
  for (let f = 0; f < 8; f++) {
    const img = g.createImageData(w, h);
    const u32 = new Uint32Array(img.data.buffer);
    const rnd = new Uint32Array(u32.length);
    for (let i = 0; i < rnd.length; i += 16384) crypto.getRandomValues(rnd.subarray(i, Math.min(rnd.length, i + 16384)));
    for (let i = 0; i < u32.length; i++) u32[i] = rnd[i] | 0xff000000;
    frames.push(img);
  }
  let n = 0;
  const t = setInterval(() => g.putImageData(frames[n++ % frames.length], 0, 0), 33);
  const stream = canvas.captureStream(30);
  const track = stream.getVideoTracks()[0];
  return {
    track,
    stop() {
      clearInterval(t);
      track.stop();
    },
  };
}

function encLabel(mime: string, impl: string): string {
  const m = mime.toLowerCase();
  const codec = m.includes("h264") ? "H.264" : m.includes("vp9") ? "VP9" : m.includes("vp8") ? "VP8" : m.includes("av1") ? "AV1" : mime || "the";
  return impl && !/unknown/i.test(impl) ? `${codec} (${impl})` : `${codec} (browser)`;
}

export async function runConnectionTest(): Promise<void> {
  if (testing) return;
  const say = (t: string) => patch({ connTest: t });
  if (getCall().inCall || getCall().connecting) {
    say("End the call first — the test needs the line to itself.");
    return;
  }
  testing = true;
  let room: Room | null = null;
  let snow: ReturnType<typeof snowTrack> | null = null;
  try {
    say("Connection test: measuring your uplink…");
    let link: number | null = null;
    try {
      const body = new Uint8Array(8 * 1024 * 1024).fill(0x5a);
      const t0 = performance.now();
      const r = await apiFetch("/speedtest/up", { method: "POST", body, timeoutMs: 25000 });
      const dt = (performance.now() - t0) / 1000;
      if (r.ok) link = (body.length * 8) / dt / 1e6;
      else if (r.status === 429) log.info("uplink probe skipped: two other tests running");
    } catch (e) {
      log.warn(`uplink probe: ${errText(e)}`);
    }
    if (link !== null) say(`Uplink ${link.toFixed(1)} Mbps · now measuring the media path (20-45s, until it plateaus)…`);
    const s = getSession();
    if (!s.userId) throw new Error("not logged in");
    const lp = localpart(s.userId).replace(/[^A-Za-z0-9_-]/g, "") || "user";
    const probeRoom = `tinhat-conntest-${lp}-${Math.floor(Date.now() / 1000) % 100000}`;
    let tok;
    try {
      const focus = await resolveFocus(probeRoom);
      tok = await mintSfuToken({ serviceUrl: focus.serviceUrl, alias: probeRoom }, s.deviceId ?? "");
    } catch (e) {
      throw new Error(`token broker refused the probe room (${errText(e)})`);
    }
    say("Connection test: probing until the estimate plateaus (20-45s, cap 100 Mbps)…");
    room = new Room({ adaptiveStream: false, dynacast: false });
    await room.connect(tok.url, tok.jwt, { autoSubscribe: false });
    snow = snowTrack();
    const lt = new LocalVideoTrack(snow.track, undefined, true);
    await room.localParticipant.publishTrack(lt, {
      source: Track.Source.ScreenShare,
      name: "screen",
      videoCodec: "h264",
      backupCodec: false,
      simulcast: false,
      videoEncoding: { maxBitrate: PROBE_CAP_BPS, maxFramerate: 30 },
      screenShareEncoding: { maxBitrate: PROBE_CAP_BPS, maxFramerate: 30 },
      degradationPreference: "maintain-resolution",
    });
    const grants: number[] = [];
    let peak = 0;
    let bwe = 0;
    let sendKbps = 0;
    let path = "unknown";
    let enc = "the";
    let prev: { bytes: number; ts: number } | null = null;
    let rising = false;
    for (let i = 1; ; i++) {
      await sleep(1000);
      if (room.state !== ConnectionState.Connected) throw new Error("the probe room disconnected");
      const sender = lt.sender;
      if (!sender) continue;
      const rep = await sender.getStats();
      let grant = 0;
      let nominatedLocal = "";
      const locals = new Map<string, string>();
      const byId = new Map<string, Record<string, unknown>>();
      rep.forEach((v) => byId.set((v as { id: string }).id, v as Record<string, unknown>));
      for (const v of byId.values()) {
        if (v.type === "outbound-rtp" && v.kind === "video") {
          grant = Math.round(Number(v.targetBitrate ?? 0) / 1000);
          const bytes = Number(v.bytesSent ?? 0);
          const ts = Number(v.timestamp ?? 0);
          if (prev && ts > prev.ts) sendKbps = Math.round(((bytes - prev.bytes) * 8) / (ts - prev.ts));
          prev = { bytes, ts };
          const codec = byId.get(String(v.codecId ?? ""));
          enc = encLabel(String(codec?.mimeType ?? ""), String(v.encoderImplementation ?? ""));
        } else if (v.type === "candidate-pair" && (v.nominated === true || v.selected === true) && v.state === "succeeded") {
          nominatedLocal = String(v.localCandidateId ?? "");
          if (Number(v.availableOutgoingBitrate ?? 0) > 0) bwe = Math.round(Number(v.availableOutgoingBitrate) / 1000);
        } else if (v.type === "local-candidate") {
          const ct = String(v.candidateType ?? "");
          locals.set(String(v.id), ct === "relay" ? `RELAYED (TURN${v.relayProtocol ? `/${String(v.relayProtocol).toUpperCase()}` : ""})` : ct ? `direct ${String(v.protocol ?? "udp").toUpperCase()}` : "unknown");
        }
      }
      if (nominatedLocal && locals.has(nominatedLocal)) path = locals.get(nominatedLocal)!;
      peak = Math.max(peak, grant);
      grants.push(grant);
      log.info(`[conntest] t=${i}s grant=${grant}kbps send=${sendKbps}kbps bwe=${bwe}kbps path=${path}`);
      if (i >= 20) {
        const n = grants.length;
        const climbing = n >= 5 && grants[n - 1] / Math.max(1, grants[n - 5]) > 1.04;
        if (!climbing) break;
        if (i >= 45) {
          rising = true;
          break;
        }
      }
      say(`Connection test: probing until the estimate plateaus (20-45s, cap 100 Mbps)… ${(grant / 1000).toFixed(1)} Mbps`);
    }
    const tail = grants.slice(-5);
    const tailKbps = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
    const media = peak / 1000;
    const cap = PROBE_CAP_BPS / 1_000_000;
    const capped = media >= cap * 0.92;
    const stillRising = rising && !capped;
    const linkStr = (m: number) => (m >= 200 ? "200+ Mbps" : `${m.toFixed(0)} Mbps`);
    let verdict: string;
    if (link !== null) {
      if (capped) verdict = `Uplink ${linkStr(link)} · share pushed ${media.toFixed(0)} Mbps — the probe's own ${cap.toFixed(0)} Mbps ceiling; ${enc} and your connection both have headroom beyond every share preset`;
      else if (stillRising) verdict = `Uplink ${linkStr(link)} · share reached ${media.toFixed(0)} Mbps and was still climbing when the test ended — the real ceiling is higher; ${enc} kept up the whole way`;
      else if (link > media * 1.5) verdict = `Uplink ${linkStr(link)} · share tops out at ${media.toFixed(1)} Mbps — limited by the ${enc} encoder, not your connection`;
      else verdict = `Uplink ${linkStr(link)} · share tops out at ${media.toFixed(1)} Mbps — limited by your connection`;
    } else if (capped) verdict = `Share pushed ${media.toFixed(0)} Mbps — the probe's own ${cap.toFixed(0)} Mbps ceiling (${enc})`;
    else if (stillRising) verdict = `Share reached ${media.toFixed(0)} Mbps, still climbing at test end (${enc})`;
    else verdict = `Share tops out at ${media.toFixed(1)} Mbps (${enc})`;
    const msg = `${verdict} · sustained ${(tailKbps / 1000).toFixed(1)} · estimator ${(bwe / 1000).toFixed(1)} · ${path}`;
    log.info(`[conntest] RESULT: ${msg}`);
    say(msg);
  } catch (e) {
    say(`Connection test failed: ${errText(e)}`);
  } finally {
    snow?.stop();
    await room?.disconnect(true).catch(() => undefined);
    testing = false;
  }
}
