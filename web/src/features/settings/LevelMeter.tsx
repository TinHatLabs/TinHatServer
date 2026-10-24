// LevelMeter.tsx — Main.qml LevelMeter (838-869): 16 bars × 4 px, spacing 3, radius 2; bar height
// 3 + shown·bell·ripple·33 (bell = 1 − |i − 7.5|·0.07, ripple = 0.6 + 0.4·|sin(i·1.1 + level·22)|,
// shown = clamp((level − 0.02)/0.48)^0.6); bars 0.95 opaque above 0.02 else 0.3; the displayed
// value steps toward the target by half the difference (snap < 0.015) — at 10 Hz now (was 30 Hz), see below.
// GPU.md §2.7 (the low-GPU contract): ≤ 10 updates/s while the window is focused (eased while the motion switch is
// on, snapped under Reduce motion), the flat rest pose and no timer while it isn't or all is quiet — ui/meter.ts.
import { useMeter } from "@/ui/meter";
import { useLevel } from "./callbridge";

export function LevelMeter({ level, color = "var(--th-settings-meter-fill)", dim }: { level: number; color?: string; dim?: boolean }) {
  const { shown, level: v } = useMeter(level);
  const bars = [];
  for (let i = 0; i < 16; i++) {
    const bell = 1 - Math.abs(i - 7.5) * 0.07;
    const ripple = 0.6 + 0.4 * Math.abs(Math.sin(i * 1.1 + v * 22));
    const h = 3 + shown * bell * ripple * 33;
    bars.push(<span key={i} style={{ width: 4, height: h, borderRadius: 2, background: color, opacity: v > 0.02 ? 0.95 : 0.3 }} />);
  }
  return (
    <span
      aria-hidden
      style={{ display: "inline-flex", alignItems: "center", gap: 3, minHeight: 17, width: 109, flex: "none", opacity: dim ? 0.35 : 1 }}
    >
      {bars}
    </span>
  );
}

/** A LevelMeter bound to one engine level — only this component re-renders at the level rate. */
export function EngineLevelMeter({ which, color, dim }: { which: "mic" | "pre" | "out"; color?: string; dim?: boolean }) {
  return <LevelMeter level={useLevel(which)} color={color} dim={dim} />;
}
