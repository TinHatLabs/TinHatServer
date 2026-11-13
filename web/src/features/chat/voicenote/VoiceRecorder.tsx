// VoiceRecorder.tsx — voice notes in the composer (docs/VOICE-NOTES.md §2): the mic button (where Send is, only while
// the composer is empty) and the recorder row that replaces the composer box while the room has a voice draft —
// recording `[✕] ● 0:07 level [■] [➤]`, review `[🗑] [▶] 0:07 waveform [➤]` (dimmed + spinner while sending, the error
// inline, Send retries). Keyboard (scoped to the row, key repeats ignored): Escape = Stop while recording (review, never a
// discard; in review it returns focus to the text field) and Ctrl+Enter (⌘+Enter on a Mac) = Send. Focus moves to Stop
// on start and to Play in review.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { peekClient } from "@/core/matrix";
import { useCallStore } from "@/features/calls";
import { GlowButton, Icon, ToolButton, cx } from "@/ui";
import { VOICE_MAX_MS, VOICE_WARN_LEFT_MS, clock } from "./core";
import { LIVE_FRAMES } from "./recorder";
import { cancelVoice, deleteVoice, sendVoice, startVoice, stopVoice, type VoiceDraft } from "./store";
import { useVoiceDraft, useVoiceSupported } from "./wire";
import s from "./VoiceRecorder.module.css";

export const IN_CALL_TIP = "You're in a call — voice messages are off until you leave";
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

function maySend(roomId: string): boolean {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (!c || !room) return false;
  return room.currentState.maySendEvent("m.room.message", c.getUserId() ?? "");
}

/** The composer's mic button (in place of Send while the composer is empty). Hidden where the browser can't encode
 *  Opus (WEB-EXCEPTIONS) and where we may not send messages (`fallback` shows instead: the disabled Send); disabled while
 *  in a call (it says why, in the tooltip and the accessible description). */
export function MicButton({ roomId, mobile, className, fallback = null }: { roomId: string; mobile?: boolean; className?: string; fallback?: React.ReactNode }) {
  const supported = useVoiceSupported();
  const inCall = useCallStore((st) => st.inCall || st.connecting);
  const descId = useId();
  if (!supported || !maySend(roomId)) return <>{fallback}</>;
  return (
    <>
      <ToolButton
        iconName="audio-input-microphone-symbolic"
        tip={inCall ? IN_CALL_TIP : "Record a voice message"}
        aria-label="Record a voice message"
        aria-disabled={inCall || undefined}
        aria-describedby={inCall ? descId : undefined}
        className={cx(className, s.mic, inCall && s.micOff, mobile && s.micMobile)}
        data-voice-mic=""
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (inCall) return;
          void startVoice(roomId);
        }}
      />
      {inCall && (
        <span id={descId} className={s.sr}>
          {IN_CALL_TIP}
        </span>
      )}
    </>
  );
}

/** The recorder row (the composer box's content while the room has a voice draft). */
export function VoiceRow({ roomId, mobile, narrow, onEscape }: { roomId: string; mobile?: boolean; narrow?: boolean; onEscape: () => void }) {
  const d = useVoiceDraft(roomId);
  const rowRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const phase = !d ? "none" : d.state === "review" || d.state === "sending" ? "review" : "recording";
  const state = d?.state ?? "idle";
  // focus: Stop once recording runs (it is disabled while the permission is asked), Play in review — only when the focus
  // was in the row / the composer (or nowhere), never stolen from elsewhere
  const lastState = useRef("idle");
  useLayoutEffect(() => {
    if (state === lastState.current) return;
    const was = lastState.current;
    lastState.current = state;
    const a = document.activeElement;
    const ours = !a || a === document.body || !!rowRef.current?.contains(a) || !!(a as HTMLElement).closest?.("[data-composer]");
    if (!ours) return;
    if (state === "recording" && (was === "idle" || was === "requesting")) stopRef.current?.focus({ preventScroll: true });
    else if (state === "review" && was !== "sending") playRef.current?.focus({ preventScroll: true });
  }, [state]);
  if (!d) return null;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.repeat) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (d.state === "recording") void stopVoice(roomId);
      else if (d.state === "review") onEscape();
      return;
    }
    if (e.key === "Enter" && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (d.state === "recording" || d.state === "review") void sendVoice(roomId);
    }
  };
  return (
    <div ref={rowRef} className={cx(s.row, mobile && s.rowMobile, d.state === "sending" && s.dim)} data-voice-row={d.state} onKeyDown={onKeyDown} role="group" aria-label="Voice message">
      {phase === "recording" ? <Recording d={d} stopRef={stopRef} mobile={mobile} narrow={narrow} /> : <Review d={d} playRef={playRef} mobile={mobile} narrow={narrow} />}
    </div>
  );
}

function SendButton({ d, mobile, narrow }: { d: VoiceDraft; mobile?: boolean; narrow?: boolean }) {
  const sending = d.state === "sending";
  const busy = sending || d.state === "finalizing";
  return (
    <GlowButton
      className={mobile ? s.sendRound : s.send}
      icon="document-send-symbolic"
      text={mobile || narrow ? undefined : d.error ? "Retry" : "Send"}
      aria-label={d.error ? "Send voice message again" : "Send voice message"}
      tip={`${d.error ? "Try sending again" : "Send voice message"} (${IS_MAC ? "⌘" : "Ctrl"}+Enter)`}
      busy={busy}
      disabled={d.state === "requesting"}
      data-voice-send=""
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void sendVoice(d.roomId)}
    />
  );
}

function Recording({ d, stopRef, mobile, narrow }: { d: VoiceDraft; stopRef: React.RefObject<HTMLButtonElement | null>; mobile?: boolean; narrow?: boolean }) {
  const left = VOICE_MAX_MS - d.durationMs;
  const warn = d.state !== "requesting" && left <= VOICE_WARN_LEFT_MS;
  return (
    <div className={s.line}>
      <ToolButton iconName="window-close-symbolic" tip="Cancel recording" className={s.tb} data-voice-cancel="" onClick={() => cancelVoice(d.roomId)} />
      {d.state === "requesting" ? (
        <span className={s.waiting}>Waiting for microphone permission…</span>
      ) : (
        <>
          <span className={s.dot} aria-hidden />
          <span className={cx(s.time, warn && s.warn)} aria-live="off" data-voice-timer="">
            {warn ? `${clock(left)} left` : clock(d.durationMs)}
          </span>
          <LiveStrip recent={d.recent} bars={mobile || narrow ? 28 : 60} />
        </>
      )}
      <ToolButton ref={stopRef} iconName="media-playback-stop-symbolic" tip="Stop recording (Esc)" aria-label="Stop recording" className={s.tb} data-voice-stop="" disabled={d.state !== "recording"} onClick={() => void stopVoice(d.roomId)} />
      <SendButton d={d} mobile={mobile} narrow={narrow} />
    </div>
  );
}

/** The last ~3 s of frame peaks, scrolling (decorative: aria-hidden). */
function LiveStrip({ recent, bars }: { recent: number[]; bars: number }) {
  const per = Math.max(1, Math.floor(LIVE_FRAMES / bars));
  const vals: number[] = [];
  const start = recent.length - bars * per;
  for (let i = 0; i < bars; i++) {
    let p = 0;
    for (let j = 0; j < per; j++) {
      const k = start + i * per + j;
      if (k >= 0 && recent[k]! > p) p = recent[k]!;
    }
    vals.push(p);
  }
  return (
    <span className={s.strip} aria-hidden>
      {vals.map((p, i) => (
        <span key={i} className={s.bar} style={{ height: `${Math.max(8, Math.round(Math.sqrt(p / 32768) * 100))}%` }} />
      ))}
    </span>
  );
}

function Review({ d, playRef, mobile, narrow }: { d: VoiceDraft; playRef: React.RefObject<HTMLButtonElement | null>; mobile?: boolean; narrow?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0); // seconds
  const dur = d.durationMs / 1000;
  const sending = d.state === "sending";
  useEffect(() => {
    // Send stops the preview
    if (sending) audio.current?.pause();
  }, [sending]);
  useEffect(() => () => audio.current?.pause(), []);
  const seek = (t: number) => {
    const v = Math.max(0, Math.min(dur, t));
    if (audio.current) audio.current.currentTime = v;
    setPos(v);
  };
  return (
    <>
      <div className={s.line}>
        <ToolButton iconName="edit-delete-symbolic" tip="Delete voice message" className={s.tb} data-voice-delete="" disabled={sending} onClick={() => deleteVoice(d.roomId)} />
        <ToolButton
          ref={playRef}
          iconName={playing ? "media-playback-pause" : "media-playback-start"}
          tip={playing ? "Pause voice message" : "Play voice message"}
          className={s.tb}
          data-voice-play=""
          disabled={!d.url}
          onClick={() => {
            const el = audio.current;
            if (!el) return;
            if (el.paused) {
              if (el.ended || el.currentTime >= dur - 0.01) el.currentTime = 0;
              void el.play().catch(() => setPlaying(false));
            } else el.pause();
          }}
        />
        <span className={s.time} aria-live="off">
          {playing || pos > 0 ? clock(pos * 1000) : clock(d.durationMs)}
        </span>
        <Wave waveform={d.waveform} pos={pos} dur={dur} onSeek={seek} bars={mobile || narrow ? 40 : 100} />
        <SendButton d={d} mobile={mobile} narrow={narrow} />
        {d.url && (
          <audio
            ref={audio}
            src={d.url}
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => (setPlaying(false), setPos(dur))}
            onTimeUpdate={(e) => setPos(Math.min(dur, e.currentTarget.currentTime))}
          />
        )}
      </div>
      {(d.error || d.note) && (
        <div className={cx(s.msg, d.error && s.err)} data-voice-error={d.error || undefined}>
          {d.error || d.note}
        </div>
      )}
    </>
  );
}

/** The note's waveform as a seek slider (role="slider", arrows ±1 s, Home/End, click/drag to seek). */
function Wave({ waveform, pos, dur, onSeek, bars }: { waveform: number[]; pos: number; dur: number; onSeek: (t: number) => void; bars: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const n = Math.min(bars, waveform.length) || 1;
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.floor((i * waveform.length) / n);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * waveform.length) / n));
    let m = 0;
    for (let j = lo; j < hi && j < waveform.length; j++) m = Math.max(m, waveform[j]!);
    vals.push(m);
  }
  const frac = dur > 0 ? pos / dur : 0;
  const at = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    onSeek(((clientX - r.left) / r.width) * dur);
  };
  return (
    <div
      ref={ref}
      className={s.wave}
      role="slider"
      tabIndex={0}
      aria-label="Seek voice message"
      aria-valuemin={0}
      aria-valuemax={Math.round(dur * 10) / 10}
      aria-valuenow={Math.round(pos * 10) / 10}
      aria-valuetext={`${clock(pos * 1000)} of ${clock(dur * 1000)}`}
      data-voice-wave=""
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        at(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) at(e.clientX);
      }}
      onKeyDown={(e) => {
        const k = e.key;
        if (k === "ArrowLeft" || k === "ArrowDown") onSeek(pos - 1);
        else if (k === "ArrowRight" || k === "ArrowUp") onSeek(pos + 1);
        else if (k === "Home") onSeek(0);
        else if (k === "End") onSeek(dur);
        else return;
        e.preventDefault();
      }}
    >
      {vals.map((v, i) => (
        <span key={i} className={cx(s.wbar, (i + 0.5) / n <= frac && s.played)} style={{ height: `${Math.max(8, Math.round((v / 1024) * 100))}%` }} />
      ))}
    </div>
  );
}

/** A voice draft set aside (Escape in review): kept, shown above the composer box; a click (or Enter/Space) brings the
 *  review row back. The text field is usable meanwhile. */
export function VoicePill({ roomId, onOpen }: { roomId: string; onOpen: () => void }) {
  const d = useVoiceDraft(roomId);
  if (!d) return null;
  return (
    <div className={s.pillRow}>
      <button type="button" className={s.pill} data-voice-pill="" aria-label={`Voice message, ${clock(d.durationMs)} — back to the recording`} onClick={onOpen}>
        <Icon name="audio-input-microphone-symbolic" size={16} color="var(--th-composer-staged-icon)" />
        <span>Voice message · {clock(d.durationMs)}</span>
        {d.error && <span className={s.err}> · not sent</span>}
      </button>
    </div>
  );
}
