// popovers.tsx — the popovers that rise from the call bar:
//   CallOptionsPopover (CallOptionsPopover.qml — mic / speaker / camera faces), StreamPopover
//   (StreamPopover.qml), HealthPopup (Main.qml:7512-7696), GamePopup (Main.qml:7751-7862).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover, ComboBox, CheckBox, RadioButton, Switch, Button, BasicButton, BasicTextField, ToolButton, Icon, HintLabel, meterDriver, useIsMobile, useTip } from "@/ui";
import { openSettings, toast } from "@/core/bus";
import { usePref, setPref } from "@/core/prefs";
import { useServerFeature } from "@/core/server";
import { ensureWritable, sendState, useRoomState, peekClient } from "@/core/matrix";
import type { PublishStat } from "@/features/calls/contract";
import { act, callStore, getC, ui, useC, useCallUi, SELF_SHARE_ID } from "./store";
import { heardSummary, snap } from "./hear";
import { useHoldChrome } from "./chrome";
import { fakeGuard, parseShareQuality } from "./menus";
import { nativeShareOn } from "@/features/native";
import s from "./popovers.module.css";

// ---- level meter (16 bars; GPU.md §2.7: ≤ 10 updates/s with a short ease while the motion switch is on, flat and
// timer-free when quiet or not focused — ui/meter.ts) -------------------------------------------------------------

export function Meter({ source }: { source: "mic" | "output" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const read = () => {
      const c = getC();
      return source === "mic" ? (c.micMuted ? 0 : c.micLevel || c.micLevelPre || 0) : c.outputLevel || 0;
    };
    const d = meterDriver(read, (shown, level) => {
      const el = ref.current;
      if (!el) return;
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) {
        const bell = 1 - Math.abs(i - 7.5) * 0.07;
        const ripple = 0.6 + 0.4 * Math.abs(Math.sin(i * 1.1 + level * 22));
        const b = kids[i] as HTMLElement;
        b.style.height = `${3 + Math.min(1, shown) * bell * ripple * 33}px`;
        b.style.opacity = level > 0.02 ? "0.95" : "0.3";
      }
    });
    const unsub = callStore.subscribe(() => d.wake());
    d.wake();
    return () => {
      unsub();
      d.stop();
    };
  }, [source]);
  return (
    <div ref={ref} className={s.meter} aria-hidden>
      {Array.from({ length: 16 }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

// ---- Call options slide-out ------------------------------------------------------------------

export function CallOptionsPopover() {
  const mobile = useIsMobile();
  const face = useCallUi((x) => x.optsFace);
  const anchor = useCallUi((x) => x.optsAnchor);
  const close = () => ui().set({ optsFace: null });
  useEffect(() => {
    if (!face) return;
    if (face === "mic") act("startMicMonitor")();
    if (face === "speaker") act("startOutputMonitor")();
    return () => {
      if (face === "mic") act("stopMicMonitor")();
      if (face === "speaker") act("stopOutputMonitor")();
    };
  }, [face]);
  if (!face) return null;
  return (
    <Popover
      open
      onClose={close}
      anchor={anchor}
      placement="above"
      align="center"
      gap={14}
      margins={12}
      flip={false}
      plain
      className={mobile ? undefined : s.opts}
      title={mobile ? undefined : face === "mic" ? "Microphone" : face === "speaker" ? "Speaker" : "Camera"}
      aria-label="Call options"
    >
      <div key={face} className={s.optsBody}>
        {face === "mic" ? <MicFace /> : face === "speaker" ? <SpeakerFace /> : <CameraFace />}
        <div className={s.footer}>
          <Button flat text="All settings…" onClick={() => (close(), openSettings(face === "camera" ? "calls" : "audio"))} />
        </div>
      </div>
    </Popover>
  );
}

function FaceHead({ title, badge, color }: { title: string; badge: string; color: string }) {
  return (
    <div className={s.faceHead}>
      <span className={s.faceTitle}>{title}</span>
      <span className={s.faceBadge} style={{ color }}>
        {badge}
      </span>
    </div>
  );
}

function devModel(list: { id: string; name: string }[], first: string) {
  return [{ id: "", name: first }, ...list.filter((d) => d.id && d.id !== "default")];
}

function MicFace() {
  const inputs = useC("inputs");
  const inputName = useC("inputName");
  const micMuted = useC("micMuted");
  const gameChat = useC("gameChat");
  const aec = useC("micAec");
  const agc = useC("micAgc");
  const ns = useC("micNsMode");
  const ncOk = useC("ncAvailable");
  const ecDegraded = useC("ecDegraded");
  const ecNote = useC("ecNote");
  const ptt = useC("pushToTalk");
  const inCall = useC("inCall");
  const hear = snap(useC("hear"));
  useC("statusRev");
  const pref = usePref("call-input", "");
  const model = devModel(inputs, "System default");
  const idx = Math.max(0, model.findIndex((d) => (pref ? d.id === pref : d.name === inputName && d.id !== "")));
  const check = hear?.mic.check ?? "ok";
  const note = !inCall || check === "ok" || check === "wait" ? "" : check === "hint" ? "no sound yet" : check === "dead" ? "nothing from this mic" : check === "osmuted" ? "muted in system" : "volume 0 %";
  const heard = heardSummary(getC());
  const notRecv = !!hear && hear.heard.not.length > 0;
  return (
    <>
      <FaceHead title="Microphone" badge={micMuted ? "MUTED" : gameChat ? "GAME CHAT" : "LIVE"} color={micMuted ? "var(--th-callbar-popover-badge-fg-muted)" : "var(--th-callbar-popover-badge-fg-live)"} />
      <ComboBox model={model} textRole="name" currentIndex={idx} onActivated={(_, d) => act("setInput")(d.id)} />
      <div className={s.levelRow}>
        <span className={s.levelLbl}>Level</span>
        <Meter source="mic" />
        {note && <span className={s.levelNote} style={{ color: check === "hint" ? "var(--th-callbar-popover-hint-fg)" : "var(--th-callbar-popover-fg-error)" }}>{note}</span>}
      </div>
      {heard && (
        <div className={s.hint} style={{ color: notRecv ? "var(--th-callbar-popover-fg-error)" : undefined }}>
          {heard}
        </div>
      )}
      <div className={s.sep} />
      <CheckBox
        text={ecDegraded ? "Echo cancellation — NOT ACTIVE" : "Echo cancellation"}
        labelColor={ecDegraded ? "var(--th-callbar-popover-fg-error)" : undefined}
        checked={aec}
        onToggled={(v) => act("applyMicAec")(v)}
      />
      {ecNote && inCall && <div className={`${s.hint} ${s.indent}`}>{ecNote}</div>}
      <CheckBox text="Auto gain control" checked={agc} onToggled={(v) => act("applyMicAgc")(v)} />
      <CheckBox text="Push to talk" checked={ptt} onToggled={(v) => act("applyPushToTalk")(v)} />
      <div className={s.nsRow}>
        <span className={s.nsLbl}>Noise suppression</span>
        <RadioButton name="ns" text="Off" checked={ns === "off"} onToggled={(v) => v && act("applyMicNsMode")("off")} />
        <RadioButton name="ns" text="Standard" checked={ns === "standard"} onToggled={(v) => v && act("applyMicNsMode")("standard")} />
        <RadioButton
          name="ns"
          text={ncOk ? "Strong" : "Strong (not installed)"}
          disabled={!ncOk}
          style={{ opacity: ncOk ? 1 : 0.5 }}
          checked={ns === "strong"}
          onToggled={(v) => v && act("applyMicNsMode")("strong")}
        />
      </div>
    </>
  );
}

function SpeakerFace() {
  const outputs = useC("outputs");
  const outputName = useC("outputName");
  const deafened = useC("deafened");
  const missing = useC("outputMissing");
  const pref = usePref("call-output", "");
  const sinkOk = typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function";
  const model = devModel(sinkOk ? outputs : [], "System default");
  const idx = Math.max(0, model.findIndex((d) => (pref ? d.id === pref : d.name === outputName && d.id !== "")));
  return (
    <>
      <FaceHead title="Speaker" badge={deafened ? "DEAFENED" : ""} color="var(--th-callbar-popover-badge-fg-muted)" />
      <ComboBox model={model} textRole="name" currentIndex={idx} onActivated={(_, d) => act("setOutput")(d.id)} />
      <div className={s.levelRow}>
        <span className={s.levelLbl}>Level</span>
        <Meter source="output" />
        {missing && <span className={s.levelNote} style={{ color: "var(--th-callbar-popover-fg-error)" }}>no output device</span>}
      </div>
      <div className={s.sep} />
      <CheckBox text="Deafen — mute everyone (Ctrl+Shift+D)" checked={deafened} onToggled={(v) => act("applyDeafen")(v)} />
      <div className={s.hint}>Someone too loud or too quiet? Right-click their tile (or their name in the left bar) for per-person volumes.</div>
    </>
  );
}

function CameraFace() {
  const cameras = useC("cameras");
  const cameraName = useC("cameraName");
  const cameraOn = useC("cameraOn");
  const q = useC("camQuality");
  const pref = usePref("call-camera", "");
  const model = devModel(cameras, "Default (first camera)");
  const idx = Math.max(0, model.findIndex((d) => (pref ? d.id === pref : d.name === cameraName && d.id !== "")));
  const [w, h, fps, kbps, sim] = q.split(/\s+/).map(Number);
  const qModel = ["720p 30fps (default)", "1080p 30fps — needs a >1080p cam"];
  const simRef = useRef<HTMLDivElement>(null);
  useTip(simRef, "Publish 3 quality rungs so each viewer's connection picks what fits");
  return (
    <>
      <FaceHead title="Camera" badge={cameraOn ? "ON" : "OFF"} color={cameraOn ? "var(--th-callbar-popover-badge-fg-live)" : "var(--th-callbar-popover-badge-fg)"} />
      <ComboBox model={model} textRole="name" currentIndex={idx} onActivated={(_, d) => act("setCamera")(d.id)} />
      <ComboBox
        model={qModel}
        currentIndex={h >= 1080 ? 1 : 0}
        onActivated={(i) => (i === 1 ? act("applyCamQuality")(1920, 1080, 30, Math.max(kbps || 0, 3500)) : act("applyCamQuality")(1280, 720, 30, 1700))}
      />
      <div ref={simRef}>
        <CheckBox text="Adaptive layers" checked={sim === 1} onToggled={(v) => act("applyCamSimulcast")(v)} />
      </div>
      <div className={s.hint}>A device change applies to the next camera start; the quality applies live.</div>
      {void w}
      {void fps}
    </>
  );
}

// ---- Stream popover ----------------------------------------------------------------------------

const PRESETS: { key: string; label: string; sub: string; w: number; h: number; fps: number; kbps: number }[] = [
  { key: "smooth", label: "Smooth", sub: "1080p · 60 fps", w: 1920, h: 1080, fps: 60, kbps: 8000 },
  { key: "sharp", label: "Sharp", sub: "1440p · 30 fps", w: 2560, h: 1440, fps: 30, kbps: 12000 },
  { key: "max", label: "Max", sub: "4K · 60 fps", w: 3840, h: 2160, fps: 60, kbps: 24000 },
];

function Pill({ label, sub, checked, disabled, onClick, grow }: { label: string; sub?: string; checked?: boolean; disabled?: boolean; onClick: () => void; grow?: boolean }) {
  return (
    <button type="button" className={`${s.pill} ${checked ? s.pillOn : ""} ${sub ? s.pillTall : ""}`} style={{ flex: grow ? "1 1 auto" : undefined, opacity: disabled ? 0.45 : 1 }} disabled={disabled} onClick={onClick}>
      <span className={s.pillLabel}>{label}</span>
      {sub && <span className={s.pillSub}>{sub}</span>}
    </button>
  );
}

/** StreamPopover.qml qualitySummary: "Auto · F fps" / "Hp · F fps · M Mbps". */
export function qualitySummary(q: { w: number; h: number; fps: number; kbps: number }) {
  if (q.w === 0) return `Auto · ${q.fps} fps`;
  return `${q.h}p · ${q.fps} fps · ${Math.round(q.kbps / 1000)} Mbps`;
}

export function StreamPopover({ anchor }: { anchor: HTMLElement | null }) {
  const open = useCallUi((x) => x.streamPop);
  const inCall = useC("inCall");
  const sharing = useC("sharing");
  const shareRecOnly = useC("shareRecOnly");
  const musicPlaying = useC("musicPlaying");
  const q = parseShareQuality(useC("shareQuality"));
  const audioPref = usePref("share-audio", "");
  const [audio, setAudio] = useState<"none" | "browser">(audioPref === "browser" ? "browser" : "none");
  const [recOnly, setRecOnly] = useState(shareRecOnly);
  const mobile = useIsMobile();
  const memoriesOn = useServerFeature("memories");
  const previewRef = useRef<HTMLVideoElement>(null);
  const [W, setW] = useState(window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  useEffect(() => {
    if (open) setRecOnly(shareRecOnly);
  }, [open, shareRecOnly]);
  useEffect(() => {
    if (!open || !sharing) return;
    const el = previewRef.current;
    act("attachVideo")(SELF_SHARE_ID, el);
    return () => act("attachVideo")(SELF_SHARE_ID, null);
  }, [open, sharing]);
  if (!open) return null;
  const close = () => ui().set({ streamPop: false });
  const live = sharing || musicPlaying;
  const title = sharing ? "Sharing your screen" : musicPlaying ? "Sharing audio" : "Share your screen";
  const preset = PRESETS.find((p) => p.w === q.w && p.h === q.h && p.fps === q.fps);
  const summary = qualitySummary(q);
  const canDisplay = typeof navigator.mediaDevices?.getDisplayMedia === "function" || nativeShareOn();
  const start = () => {
    setPref("share-audio", audio);
    act("shareScreen")({ audio, recordingOnly: memoriesOn && recOnly && !nativeShareOn(), quality: { w: q.w, h: q.h, fps: q.fps, kbps: q.kbps } });
    close();
  };
  const primary = sharing ? "Done" : "Start sharing";
  const w = Math.min(560, W - 40);
  const content = (
    <div className={s.streamBody} style={mobile ? undefined : { width: w - 36 }}>
      <div className={s.spHead}>
        <Icon name="video-display-brightness-symbolic" size={22} color={live ? "var(--th-callbar-popover-icon-active)" : "var(--th-callbar-popover-icon)"} />
        <span className={s.spTitle}>{title}</span>
        <span style={{ flex: 1 }} />
        {live && (
          <span className={s.liveChip}>
            ● LIVE{sharing ? " · screen" : ""}
            {musicPlaying ? " · audio" : ""}
            {shareRecOnly ? " · recording only" : ""}
          </span>
        )}
        <ToolButton iconName="window-close-symbolic" tip="Close" onClick={close} />
      </div>
      {!inCall && <div className={s.dimText}>Join a call first — then pick what to share here.</div>}
      {sharing && (
        <div className={s.preview} style={{ height: Math.min(220, Math.round((w - 36) * 9 / 16)) }}>
          <video ref={previewRef} autoPlay playsInline muted className={s.previewVideo} />
          <div className={s.previewCap}>
            What you're sending · {summary} · {audio === "browser" ? "tab/system audio" : "no audio"}
          </div>
        </div>
      )}
      <div className={s.section}>What to share</div>
      <Button
        icon="monitor-symbolic"
        text={canDisplay ? (sharing ? "Change what you're sharing…" : "Choose a screen or window…") : "Screen sharing isn't available in this browser"}
        disabled={!inCall || !canDisplay}
        onClick={start}
        style={{ width: "100%" }}
      />
      <div className={s.qRow}>
        <span className={s.section}>Quality</span>
        <span className={s.qSummary}>{preset ? summary : `Custom: ${summary}`}</span>
      </div>
      <div className={s.pillRow}>
        {PRESETS.map((p) => (
          <Pill key={p.key} grow label={p.label} sub={p.sub} checked={preset?.key === p.key} onClick={() => act("applyShareQuality")(p.w, p.h, p.fps, p.kbps)} />
        ))}
        <Pill label="Custom…" sub="res · fps · encoder" checked={!preset} onClick={() => (close(), openSettings("calls"))} />
      </div>
      <div className={s.section}>Audio</div>
      <div className={s.pillFlow}>
        <Pill label="No audio" checked={audio === "none"} onClick={() => setAudio("none")} />
        <Pill label="Everything" sub="tab or system sound" checked={audio === "browser"} onClick={() => setAudio("browser")} />
      </div>
      <div className={s.hint}>Your browser shares a tab's sound (or, on Windows and ChromeOS, all system sound) — tick "Share audio" in its picker. Per-app audio needs the desktop app.</div>
      {/* selfhost/firstrun item 1: only where the server records (Memories) */}
      {memoriesOn && !nativeShareOn() && (
        <div className={s.recRow}>
          <Switch checked={recOnly} onToggled={(v) => (setRecOnly(v), sharing && act("applyShareRecordingOnly")(v))} aria-label="For the recording only" />
          <div>
            <div className={s.recTitle}>For the recording only</div>
            <div className={s.hint}>Streams straight into Memories. Everyone else sees it hidden and muted unless they tune in.</div>
          </div>
        </div>
      )}
      <div className={s.actions}>
        {live && (
          <Button
            icon="media-playback-stop-symbolic"
            text="Stop sharing"
            onClick={() => {
              if (sharing) act("stopScreen")();
              if (musicPlaying) act("stopMusic")();
            }}
          />
        )}
        <Button highlighted icon={sharing ? "dialog-ok-symbolic" : "media-record-symbolic"} text={primary} disabled={!inCall || (!sharing && !canDisplay)} onClick={sharing ? close : start} />
      </div>
    </div>
  );
  return (
    <Popover
      open
      onClose={close}
      anchor={{ x: 0, y: window.innerHeight - 120, width: window.innerWidth, height: 0 }}
      placement="above"
      align="center"
      gap={0}
      margins={16}
      flip={false}
      plain
      className={mobile ? undefined : s.streamPop}
      title={mobile ? undefined : title}
      aria-label="Share your screen"
    >
      {content}
      {void anchor}
    </Popover>
  );
}

// ---- Stream health ---------------------------------------------------------------------------

export function healthWorst(stats: PublishStat[]): "" | "warn" | "bad" {
  let worst: "" | "warn" | "bad" = "";
  for (const st of stats) {
    if (st.lossPct >= 3) return "bad";
    if ((st.qlim && st.qlim !== "none") || st.lossPct >= 1) worst = "warn";
  }
  return worst;
}

function rate(k: number) {
  return k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`;
}

function kindLabel(k: string) {
  if (k === "screen") return "Screen share";
  if (k === "mic") return "Microphone";
  const m = /^camera\/?(\w)?/.exec(k);
  if (m) return `Camera — ${m[1] === "f" ? "high" : m[1] === "h" ? "medium" : m[1] === "q" ? "low" : "high"} layer`;
  return k;
}

function statusOf(st: PublishStat, micMuted: boolean): { text: string; color: string } {
  let t: string;
  let c = "var(--th-health-status-idle-fg)";
  if (st.kind === "mic" && micMuted) t = "Muted";
  else if (!st.sendKnown) t = "Measuring…";
  else if (!st.active || st.sendKbps <= 0) {
    t = "Nothing is being sent right now";
    c = "var(--th-health-status-bad-fg)";
  } else if (st.qlim === "cpu") {
    t = "Your computer can't keep up — try 30 fps or a lower resolution";
    c = "var(--th-health-status-warn-fg)";
  } else if (st.qlim === "bandwidth" || st.lossPct >= 3) {
    t = "Your connection can't keep up — lower the bitrate";
    c = st.lossPct >= 3 ? "var(--th-health-status-bad-fg)" : "var(--th-health-status-warn-fg)";
  } else if (st.qlim && st.qlim !== "none") {
    t = `Limited by ${st.qlim}`;
    c = "var(--th-health-status-warn-fg)";
  } else if (st.lossPct >= 1) {
    t = "A little packet loss — should be fine";
    c = "var(--th-health-status-warn-fg)";
  } else {
    t = "Looking good";
    c = "var(--th-health-status-good-fg)";
  }
  if (st.lossPct >= 0 && st.rttMs > 0) t += `  ·  loss ${st.lossPct.toFixed(1)}% · RTT ${Math.round(st.rttMs)} ms`;
  return { text: t, color: c };
}

export function HealthPopup({ open, onClose, anchor }: { open: boolean; onClose: () => void; anchor: HTMLElement | null }) {
  const stats = useC("publishStats");
  const micMuted = useC("micMuted");
  const mobile = useIsMobile();
  useHoldChrome(open);
  if (!open) return null;
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="above" align="center" gap={8} margins={6} plain className={mobile ? undefined : s.health} aria-label="Outgoing streams">
      <div className={s.hTitle}>Outgoing streams</div>
      {stats.length === 0 && <div className={s.hintS}>Nothing is being sent right now.</div>}
      {stats.map((st, i) => {
        const stt = statusOf(st, micMuted);
        return (
          <div key={st.kind + i} className={s.card} style={{ opacity: st.active ? 1 : 0.55 }}>
            <div className={s.cardHead}>
              <span className={s.cardKind}>{kindLabel(st.kind)}</span>
              <span className={s.statusDot} style={{ background: stt.color }} />
            </div>
            <div className={s.hintS}>
              {st.enc}
              {st.encPick && st.encPick !== st.enc ? `  (${st.encPick})` : ""}
            </div>
            {st.w > 0 && (
              <div className={s.hintS}>
                {st.w}×{st.h} @ {Math.round(st.fps)} fps
              </div>
            )}
            <div className={s.hintS}>
              {rate(st.sendKbps)}
              {st.targetKbps > 0 ? `  ·  cap ${rate(st.targetKbps)}` : ""}
            </div>
            <div className={s.hintS} style={{ color: stt.color }}>
              {stt.text}
            </div>
            {st.w > 0 && (
              <div className={s.hintS}>
                keyframes {st.key} · nack {st.nack} · pli {st.pli}
              </div>
            )}
          </div>
        );
      })}
      {stats.length > 0 && <HintLabel>Loss and RTT are what the server reports receiving from you. Updates every 3 s.</HintLabel>}
    </Popover>
  );
}

// ---- Game popup ------------------------------------------------------------------------------

export function GamePopup({ open, onClose, anchor, roomId }: { open: boolean; onClose: () => void; anchor: HTMLElement | null; roomId: string }) {
  const act0 = useRoomState(roomId, "dev.tinhat.activity", "") as { game?: string; code?: string } | undefined;
  const gameChat = useC("gameChat");
  const mobile = useIsMobile();
  const [game, setGame] = useState("");
  const [code, setCode] = useState("");
  const gameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useHoldChrome(open);
  useEffect(() => {
    if (!open) return;
    setGame(act0?.game ?? "");
    setCode(act0?.code ?? "");
    window.setTimeout(() => gameRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const setActivity = async (g: string, c: string) => {
    if (fakeGuard()) return;
    const me = peekClient()?.getUserId() ?? "";
    const content: Record<string, unknown> = g.trim() ? { game: g.trim(), setBy: me, ts: Date.now() } : {};
    if (g.trim() && c.trim()) content.code = c.trim();
    try {
      await ensureWritable(roomId, ["dev.tinhat.activity"]);
      await sendState(roomId, "dev.tinhat.activity", "", content);
    } catch (e) {
      toast(`Couldn't set the game: ${(e as Error).message}`);
    }
  };
  const submit = () => {
    if (!game.trim()) return;
    void setActivity(game, code);
    onClose();
  };
  const shared = (act0?.game ?? "").trim();
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="above" align="center" gap={8} margins={6} plain className={mobile ? undefined : s.game} aria-label="What are we playing?">
      <div className={s.hTitle}>What are we playing?</div>
      <GameSwitch on={gameChat} />
      <BasicTextField ref={gameRef} value={game} placeholder="Game name (e.g. Helldivers 2)" onChange={(e) => setGame(e.target.value)} onAccepted={() => codeRef.current?.focus()} aria-label="Game name" />
      <div className={s.dimText}>Join / lobby code (optional)</div>
      <div className={s.codeRow}>
        <BasicTextField ref={codeRef} value={code} placeholder="Paste a join code" onChange={(e) => setCode(e.target.value)} onAccepted={submit} aria-label="Join code" style={{ flex: 1 }} />
        <BasicButton text="Set" disabled={!game.trim()} onClick={submit} />
      </div>
      {shared && (
        <div className={s.sharedCard}>
          <div className={s.sharedGame}>🎮 {shared}</div>
          {act0?.code && (
            <div className={s.sharedCode}>
              <span className={s.mono}>{act0.code}</span>
              <ToolButton iconName="edit-copy-symbolic" iconSize={16} tip="Copy code" onClick={() => void navigator.clipboard?.writeText(act0.code ?? "").then(() => toast("Copied"))} />
            </div>
          )}
          <div className={s.clearRow}>
            <ToolButton iconName="edit-clear-all-symbolic" label="Clear" onClick={() => (void setActivity("", ""), onClose())} />
          </div>
        </div>
      )}
    </Popover>
  );
}

function GameSwitch({ on }: { on: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTip(ref, "People who also switch this on won't hear your mic here (you hear each other in-game); everyone else still does");
  return (
    <div ref={ref}>
      <Switch text="I'm in the game's voice chat" checked={on} onToggled={(v) => act("applyGameChat")(v)} />
    </div>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return <div className={s.section}>{children}</div>;
}
