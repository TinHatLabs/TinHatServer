// soundpad/SoundPad.tsx — the Soundboard pad (widget `soundPad`, contract WIDGETS.md §22, WIDGETS-UI.md §22; the
// desktop's SoundPadWidget.qml): your soundboard favourites (the panel's "Favourites", starred with "Add to favourites")
// as big buttons, in the order you starred them — M 6, L 12 (3 per row), S the first 3 as chips in the header. A press
// plays exactly as the soundboard panel does (its own toggleSound: in a call into the call — the LiveKit "sound" track
// — and locally; outside a call only locally, "Only you hear these here…"); pressing the playing sound stops it. In a
// call whose roles turned `use_soundboard` off for you the buttons are disabled with the panel's own line. Motion:
// pressRipple (a one-shot ripple from the press point, `verylong`, only while animate). No timer.
import { useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { useAccountData } from "@/core/matrix";
import { cx, useAnimate } from "@/ui";
import { useCall } from "@/features/calls";
import { PERSONAL_TYPE, openSoundboard, toggleSound, useSoundboard } from "@/features/media";
import { PAD_MAX, padGate, padSounds, type PadGate, type PadSound } from "@/widgets/soundpad";
import { defineWidget, type PartProps, type WidgetCtx } from "../impl";
import s from "./SoundPad.module.css";

export interface SoundPadModel {
  /** every favourite (the pad cuts per size) */
  sounds: PadSound[];
  gate: PadGate;
  /** the sound playing now ("" = none) */
  playingUrl: string;
  /** a sample (gallery / gates): presses do nothing */
  sample?: boolean;
}

function useModel(ctx: WidgetCtx): SoundPadModel {
  void ctx;
  const content = useAccountData(PERSONAL_TYPE);
  const inCall = useCall((c) => !!(c.inCall ?? c.joined));
  const perms = useCall((c) => c.callPerms);
  const playingUrl = useSoundboard((x) => x.playingUrl);
  const sounds = padSounds(content, PAD_MAX.L);
  return { sounds, gate: padGate(inCall, perms), playingUrl };
}

/** One pad button as drawn (the emoji over the name, the playing glow, the press ripple). Exported for the Pad screen
 *  (features/pad), whose sound grid IS this widget's grid; `pending` = a Pad press waiting for the PC's answer. */
export function SoundPadButton({ d, playing, disabled, compact, pending, onPress }: { d: PadSound; playing: boolean; disabled?: boolean; compact?: boolean; pending?: boolean; onPress: () => void }) {
  const animate = useAnimate();
  const [ripple, setRipple] = useState<{ x: number; y: number; k: number } | null>(null);
  const seq = useRef(0);
  const press = (e: RPointerEvent<HTMLButtonElement>) => {
    if (disabled || !animate) return;
    const r = e.currentTarget.getBoundingClientRect();
    setRipple({ x: e.clientX - r.left, y: e.clientY - r.top, k: ++seq.current });
  };
  return (
    <button
      type="button"
      className={cx(compact ? s.chip : s.pad, playing && s.playing, pending && s.pending)}
      disabled={disabled}
      aria-pressed={playing}
      aria-label={playing ? `Stop ${d.name}` : `Play ${d.name}`}
      title={playing ? `Stop ${d.name}` : d.name}
      data-sound={d.url}
      data-no-drag=""
      onPointerDown={press}
      onClick={(e) => {
        e.stopPropagation();
        onPress();
      }}
    >
      <span className={s.emoji} aria-hidden>
        {d.emoji}
      </span>
      {!compact && <span className={s.name}>{d.name}</span>}
      {ripple && <span key={ripple.k} className={s.ripple} style={{ left: ripple.x, top: ripple.y }} onAnimationEnd={() => setRipple(null)} aria-hidden />}
    </button>
  );
}

/** The pad's grid (3 per row; phones: the bigger buttons) + its one line under it. */
export function SoundPadGrid({ mobile, hint, hintOff, columns, children }: { mobile?: boolean; hint?: string; hintOff?: boolean; columns?: number; children: ReactNode }) {
  return (
    <div className={s.body} data-mobile={mobile ? "" : undefined}>
      <div className={s.grid} style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
        {children}
      </div>
      {hint && (
        <div className={s.hint} data-off={hintOff ? "" : undefined}>
          {hint}
        </div>
      )}
    </div>
  );
}

function PadButton({ d, m, ctx, compact }: { d: PadSound; m: SoundPadModel; ctx: WidgetCtx; compact?: boolean }) {
  return <SoundPadButton d={d} playing={d.url === m.playingUrl} disabled={ctx.preview || !m.gate.allowed} compact={compact} onPress={() => !m.sample && toggleSound(d.url, d.name, d.emoji)} />;
}

function Body({ model: m, ctx }: PartProps<SoundPadModel>) {
  const max = ctx.size === "L" && !ctx.preview ? PAD_MAX.L : PAD_MAX.M;
  const shown = m.sounds.slice(0, max);
  if (!shown.length)
    return (
      <div className={s.empty}>
        <span>Star sounds in the soundboard to pin them here</span>
        <button type="button" className={s.linkBtn} disabled={ctx.preview} data-no-drag="" onClick={(e) => (e.stopPropagation(), openSoundboard())}>
          Open soundboard
        </button>
      </div>
    );
  return (
    <SoundPadGrid mobile={ctx.mobile} hint={m.gate.hint} hintOff={!m.gate.allowed}>
      {shown.map((d) => (
        <PadButton key={d.url} d={d} m={m} ctx={ctx} />
      ))}
    </SoundPadGrid>
  );
}

/** S / collapsed: the first 3 as emoji chips (they play too; the name is the tooltip); none → the empty line. */
function Summary({ model: m, ctx }: PartProps<SoundPadModel>) {
  const first = m.sounds.slice(0, PAD_MAX.S);
  if (!first.length) return <span className={s.summaryText}>Star sounds to pin them here</span>;
  return (
    <span className={s.chips}>
      {first.map((d) => (
        <PadButton key={d.url} d={d} m={m} ctx={ctx} compact />
      ))}
    </span>
  );
}

/** M / L header: the sound playing now. */
function Playing({ model: m }: PartProps<SoundPadModel>) {
  const d = m.playingUrl ? m.sounds.find((x) => x.url === m.playingUrl) : undefined;
  return d ? <span className={s.summaryText}>▶ {d.name}</span> : null;
}

// ---- samples (the gallery's preview, the review screenshots, the gates; the desktop's SoundPadWidget.qml holds the same)
const mi = (f: string) => `https://www.myinstants.com/media/sounds/${f}`;
const SAMPLE: PadSound[] = [
  { name: "Bruh", url: mi("bruh.mp3"), emoji: "😐" },
  { name: "MLG Airhorn", url: mi("airhorn.mp3"), emoji: "📯" },
  { name: "Sad trombone", url: mi("sadtrombone.mp3"), emoji: "🎺" },
  { name: "Vine boom", url: mi("vine-boom.mp3"), emoji: "💥" },
  { name: "Emotional damage", url: mi("emotional-damage.mp3"), emoji: "😭" },
  { name: "Discord call", url: mi("discord-call.mp3"), emoji: "📞" },
  { name: "Oof", url: mi("oof.mp3"), emoji: "🔊" },
  { name: "Wow", url: mi("wow.mp3"), emoji: "🤩" },
  { name: "Drum roll", url: mi("drumroll.mp3"), emoji: "🥁" },
  { name: "Crickets", url: mi("crickets.mp3"), emoji: "🦗" },
];
function sample(opts: { n?: number; inCall?: boolean; off?: boolean; playing?: number } = {}): SoundPadModel {
  const sounds = SAMPLE.slice(0, opts.n ?? 8);
  return {
    sounds,
    gate: padGate(opts.inCall ?? false, opts.off ? { use_soundboard: false } : {}),
    playingUrl: opts.playing !== undefined ? (sounds[opts.playing]?.url ?? "") : "",
    sample: true,
  };
}

export const soundPad = defineWidget<SoundPadModel>({
  id: "soundPad",
  useModel,
  live: () => false,
  Summary,
  HeaderExtra: Playing,
  Body,
  hasData: (m) => m.sounds.length > 0,
  samples: {
    preview: () => sample({ inCall: true }),
    data: () => sample({ inCall: true }),
    playing: () => sample({ inCall: true, playing: 1 }),
    local: () => sample({ inCall: false }),
    off: () => sample({ inCall: true, off: true }),
    few: () => sample({ n: 2, inCall: true }),
    empty: () => sample({ n: 0 }),
  },
});
