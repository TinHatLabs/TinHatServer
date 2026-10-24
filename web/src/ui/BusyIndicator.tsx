// BusyIndicator.tsx — the house busy mark (GPU.md §2.5): Controls.BusyIndicator's ten circles on a ring, radius
// size/12, outlined in the pen colour — but STILL. The native Basic indicator filled them one by one every 100 ms in
// an endless 2 s loop (≈ 10 repaints/s for as long as anything loads); the low-GPU contract allows no loop, so the
// mark rests as ten outlined circles and advances one step (the next dot of the native fill/empty order,
// core/lowgpu.ts busyDotFilled) per REAL progress event — a stage change, a received chunk, a retry — passed as a
// changing `progress` value, at most 4 steps/s and only while the motion switch is on. With no events it stays
// still. Labels next to it change once after 10 s without progress ("Still loading…": useStillLabel).
// (relative imports: ui/ is loaded by the Node unit tests without the "@/" alias)
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BUSY_STEP_MS, BUSY_STILL_MS, busyDotFilled, stillLabel } from "../core/lowgpu";
import { animate } from "./motion";
import s from "./BusyIndicator.module.css";

export interface BusyIndicatorProps {
  size?: number;
  running?: boolean;
  /** dot colour — Basic uses palette.dark (the theme background) */
  color?: string;
  className?: string;
  style?: CSSProperties;
  /** a count (or any value) that changes on every real progress event: the mark advances one step per change */
  progress?: number | string;
}

/** The mark's step: -1 (at rest) until the first progress change, then one step per change, ≤ 1 per BUSY_STEP_MS,
 *  and none while the motion switch is off (the change is dropped, not queued — no catch-up burst on focus). */
function useBusyStep(progress: number | string | undefined): number {
  const [step, setStep] = useState(-1);
  const last = useRef<{ p: number | string | undefined; at: number }>({ p: progress, at: -Infinity });
  useEffect(() => {
    if (progress === undefined || progress === last.current.p) return;
    last.current.p = progress;
    if (!animate()) return;
    const now = performance.now();
    if (now - last.current.at < BUSY_STEP_MS) return;
    last.current.at = now;
    setStep((k) => k + 1);
  }, [progress]);
  return step;
}

export function BusyIndicator({ size = 36, running = true, color = "var(--th-loader-busy-fill)", className, style, progress }: BusyIndicatorProps) {
  const r = Math.floor(size / 12);
  const step = useBusyStep(progress);
  const dots = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10 - 0.25) * 2 * Math.PI;
    const c = size / 2;
    const d = size / 2 - r;
    return (
      <span
        key={i}
        className={s.dot}
        style={{
          left: c + d * Math.cos(a) - r,
          top: c + d * Math.sin(a) - r,
          width: r * 2,
          height: r * 2,
          ["--dot" as string]: color,
          background: busyDotFilled(i, step) ? color : undefined,
        }}
      />
    );
  });
  return (
    <span
      className={`${s.busy} ${running ? s.running : ""} ${className ?? ""}`}
      style={{ width: size, height: size, ...style }}
      role="progressbar"
      aria-busy={running}
      aria-label="Loading"
    >
      {dots}
    </span>
  );
}

/** A busy label that changes once after 10 s without progress ("Loading…" → "Still loading…"; GPU.md §2.5 — the
 *  right panel's 12 s cap, generalised). `busy` false resets it; a change of `progress` restarts the 10 s. One
 *  timeout, no ticking. */
export function useStillLabel(label: string, busy: boolean, progress?: number | string): string {
  const [still, setStill] = useState(false);
  useEffect(() => {
    setStill(false);
    if (!busy) return;
    const t = window.setTimeout(() => setStill(true), BUSY_STILL_MS);
    return () => window.clearTimeout(t);
  }, [busy, progress]);
  return still && busy ? stillLabel(label) : label;
}

/** True once `busy` has lasted 10 s without a progress change (for marks whose "still" state is not a label). */
export function useBusyStill(busy: boolean, progress?: number | string): boolean {
  return useStillLabel("x", busy, progress) !== "x";
}
