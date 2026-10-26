// Calls & video pane — SETTINGS-WINDOW.md §5 (Main.qml Calls + §5 web equivalents, D11 codecs). Card Talking (Push to
// talk, Sound when I talk while muted, Keep call buttons visible), Camera (Camera, Camera quality, Adaptive layers),
// Screen share (resolution, frame rate, bandwidth, encoder), Incoming video (quality; web: Receive AV1 screen shares),
// Connection (Test connection speed + its result).
import { useEffect, useState } from "react";
import { setPref, usePref } from "@/core/prefs";
import { apiFetch } from "@/core/api";
import { Button } from "@/ui";
import {
  act,
  applyCamQuality,
  applyCamSimulcast,
  applyPushToTalk,
  applyRecvQuality,
  applyShareEncoder,
  applyShareQuality,
  refreshDeviceLists,
  setCamera,
  useDeviceLists,
  useEngine,
  usePushToTalk,
  useQualities,
  sameDev,
} from "../callbridge";
import { useFormFactor } from "@/core/device";
import { setCallBarPinned, useCallBarPinned } from "@/features/callui/chrome";
import { pttKeys } from "@/actions/shortcutsStore";
import { ComboRow, Hint, Row, Section, SwitchRow } from "../rows";
import { PAD_PREF } from "@/features/calls/pad/prefs";

export const SHARE_RES = [
  { label: "Auto", w: 0, h: 0, base: 12000 },
  { label: "720p", w: 1280, h: 720, base: 4000 },
  { label: "1080p", w: 1920, h: 1080, base: 8000 },
  { label: "1440p", w: 2560, h: 1440, base: 12000 },
  { label: "2160p (4K)", w: 3840, h: 2160, base: 16000 },
  { label: "Source (native)", w: 4096, h: 4096, base: 18000 },
];
export const SHARE_BW = [
  { label: "Good — lightest", f: 0.6 },
  { label: "Great — balanced", f: 1.0 },
  { label: "Best — most bandwidth", f: 1.5 },
  { label: "Unleashed — LAN-grade", f: 2.5 },
];
const FPS = [5, 15, 30, 60];
const ENCODERS = [
  { label: "GPU (H.264) — best", code: 0, tag: "nvenc" },
  { label: "VP9 (CPU) — sharpest text", code: 1, tag: "vp9" },
];
const CAMQ = [
  { label: "720p 30 fps (default)", w: 1280, h: 720, fps: 30, kbps: 2500 },
  { label: "1080p 30 fps", w: 1920, h: 1080, fps: 30, kbps: 3000 },
];
const RECV = [
  { label: "Auto — match tile size", tag: "auto" },
  { label: "Always highest", tag: "high" },
  { label: "Cap at medium (360p)", tag: "medium" },
  { label: "Data saver (180p)", tag: "low" },
] as const;

export function parseShare(q: string) {
  const [w, h, fps, kbps, enc] = q.split(/\s+/);
  return { w: +w || 0, h: +h || 0, fps: +fps || 30, kbps: +kbps || 12000, enc: enc || "nvenc" };
}

let localConn = "";

export function CallsPane() {
  const e = useEngine();
  const dev = useDeviceLists();
  const q = useQualities();
  const ptt = usePushToTalk();
  const mutedTalk = usePref("snd.mutedtalk", "0");
  const pinned = useCallBarPinned();
  const phone = useFormFactor() === "mobile";
  const av1Receive = usePref("av1-receive", true);
  const padOn = usePref(PAD_PREF, true);
  const [conn, setConn] = useState(localConn);
  useEffect(() => {
    refreshDeviceLists();
  }, []);
  const cams = [{ id: "", name: "Default (first camera)" }, ...dev.cameras];
  const camIdx = Math.max(0, cams.findIndex((c) => sameDev(c, dev.cameraId)));
  const sq = parseShare(q.shareQuality);
  const cq = q.camQuality.split(/\s+/);
  const resIdx = (() => {
    const i = SHARE_RES.findIndex((r) => r.w === sq.w && r.h === sq.h);
    return i >= 0 ? i : 2;
  })();
  const curRes = SHARE_RES[resIdx];
  const tier = (() => {
    let best = 0;
    let bd = Infinity;
    SHARE_BW.forEach((t, i) => {
      const d = Math.abs(curRes.base * t.f - sq.kbps);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  })();
  const fpsIdx = FPS.indexOf(sq.fps) >= 0 ? FPS.indexOf(sq.fps) : FPS.indexOf(30);
  const connText = e.connTest || conn;

  const runTest = async () => {
    if (e.inCall) {
      setConn((localConn = "End the call first — the test needs the line to itself."));
      return;
    }
    if (act("runConnectionTest")) return;
    // Fallback until the engine's runner lands: the uplink half (8 MB to the speedtest sink).
    setConn((localConn = "Connection test: measuring your uplink…"));
    try {
      const body = new Uint8Array(8 * 1024 * 1024).fill(0x5a);
      const t0 = performance.now();
      const r = await apiFetch("/speedtest/up", { method: "POST", body, timeoutMs: 25000 });
      if (r.status === 429) throw new Error("the test server is busy — try again in a minute");
      if (!r.ok) throw new Error(`the test server said ${r.status}`);
      const secs = (performance.now() - t0) / 1000;
      const mbps = (body.length * 8) / secs / 1e6;
      setConn((localConn = `Uplink ${mbps.toFixed(1)} Mbps. The media-path half of the test needs the call engine.`));
    } catch (err) {
      setConn((localConn = `Connection test failed: ${(err as Error)?.message ?? err}`));
    }
  };

  return (
    <>
      <Section title="Talking">
        {!phone && <SwitchRow
          id="calls.push-to-talk"
          label="Push to talk"
          // one text node, like 10.8's static text
          description={`Hold ${pttKeys()[0] ?? "Ctrl"} to speak while Tin Hat is the focused tab. Browsers can't do push to talk while you're in a game.`}
          checked={ptt}
          onToggled={applyPushToTalk}
        />}
        <SwitchRow
          id="calls.muted-sound"
          label="Sound when I talk while muted"
          description={`A "You're muted" reminder always shows when Tin Hat hears you. Nothing leaves your computer while you're muted.`}
          checked={mutedTalk === "1"}
          onToggled={(on) => setPref("snd.mutedtalk", on ? "1" : "0")}
        />
        {/* 11.0.2: the call bar's hiding (callui/chrome.ts, device-local, default off); not on phones — the phone call
            screen never hides its bar by itself */}
        {!phone && (
          <SwitchRow
            id="calls.keep-buttons"
            label="Keep call buttons visible"
            description="Otherwise they hide a few seconds after you stop moving the mouse."
            checked={pinned}
            onToggled={setCallBarPinned}
          />
        )}
      </Section>

      {/* Pad (docs/PAD.md, both apps): my other verified devices may control this device's calls (default on). Off =
          no `pad1` cap in the call membership and every Pad command refused with "off". */}
      <Section title="Pad">
        <SwitchRow
          id="calls.pad"
          label="Let my other verified devices control my calls here"
          description="While this device is in a call, your phone (or another device of yours) can play sounds, mute you and set people's volumes here. Only your own verified devices can; the call bar shows a chip while one does."
          checked={padOn !== false}
          onToggled={(on) => setPref(PAD_PREF, on)}
        />
      </Section>

      <Section title="Camera">
        <ComboRow id="calls.camera" label="Camera" model={cams} textRole="name" currentIndex={camIdx} onActivated={(i) => setCamera(cams[i].id)} />
        <ComboRow
          id="calls.camera-quality"
          label="Camera quality"
          description="1080p needs a camera that can do more than 1080p."
          model={CAMQ}
          textRole="label"
          currentIndex={+cq[0] === 1920 ? 1 : 0}
          onActivated={(i) => applyCamQuality(CAMQ[i].w, CAMQ[i].h, CAMQ[i].fps, CAMQ[i].kbps)}
        />
        <SwitchRow
          id="calls.adaptive-layers"
          label="Adaptive layers"
          description="Sends three quality levels so each viewer gets what their connection can take."
          checked={(cq[4] ?? "1") !== "0"}
          onToggled={applyCamSimulcast}
        />
      </Section>

      <Section title="Screen share">
        <ComboRow
          id="calls.share-resolution"
          label="Screen share resolution"
          model={SHARE_RES}
          textRole="label"
          currentIndex={resIdx}
          onActivated={(i) => applyShareQuality(SHARE_RES[i].w, SHARE_RES[i].h, sq.fps, Math.round(SHARE_RES[i].base * SHARE_BW[tier].f))}
        />
        <ComboRow id="calls.share-fps" label="Frame rate" model={FPS} textRole={(f) => `${f} fps`} currentIndex={fpsIdx} onActivated={(i) => applyShareQuality(sq.w, sq.h, FPS[i], sq.kbps)} />
        <ComboRow
          id="calls.share-bandwidth"
          label="Bandwidth"
          description="How much upload your share may use."
          model={SHARE_BW}
          textRole="label"
          currentIndex={tier}
          onActivated={(i) => applyShareQuality(sq.w, sq.h, sq.fps, Math.round(curRes.base * SHARE_BW[i].f))}
        />
        <ComboRow
          id="calls.share-encoder"
          label="Encoder"
          description="GPU uses your browser's hardware encoder when there is one. VP9 keeps text and documents sharpest."
          model={ENCODERS}
          textRole="label"
          currentIndex={sq.enc === "vp9" ? 1 : 0}
          onActivated={(i) => applyShareEncoder(ENCODERS[i].code)}
        />
      </Section>

      <Section title="Incoming video">
        <ComboRow
          id="calls.incoming-quality"
          label="Incoming video quality"
          description="Auto matches each tile's size — the recommended choice."
          model={RECV}
          textRole="label"
          currentIndex={Math.max(0, RECV.findIndex((r) => r.tag === q.recvQuality))}
          onActivated={(i) => applyRecvQuality(RECV[i].tag)}
        />
        <SwitchRow
          label="Receive AV1 screen shares"
          description="Desktop users can share in AV1 (sharper at the same bandwidth) while you watch here. Turn it off if shares look choppy or stay black."
          checked={av1Receive === true}
          onToggled={(v) => setPref("av1-receive", v)}
        />
        {/* 10.8.1: "Save GPU while Tin Hat isn't focused" moved to Appearance → Performance (it covers every unfocused rule) */}
      </Section>

      <Section title="Connection">
        <Row
          id="calls.speed-test"
          label="Test connection speed"
          description="Checks your upload to the server, then what this machine can encode (about 25 s). Your share quality is capped by the lower one. Run it outside of calls."
          disabled={!!e.inCall}
          control={<Button text="Test" icon="network-wireless-symbolic" disabled={!!e.inCall} onClick={() => void runTest()} />}
        >
          {connText && <Hint>{connText}</Hint>}
        </Row>
      </Section>
    </>
  );
}
