// TinHatLoader.tsx — TinHatLoader.qml, the Tin Hat mark (a faceted tin-foil hat): 21 polygons in a
// 512-unit drawing (translated −14.384, 62.96 and scaled 1.046), each facet's grey shifted by
// amplitude × sin(2π(phase − offset)) × strength per channel. The native sweeps the light round the facets once
// per 2400 ms while `running`; the low-GPU contract allows no loop (GPU.md §2.5), so the light moves ONE step
// (an eighth of a turn at lightStrength 3.2) per real progress event — a boot stage (Startup passes its percent)
// — at most 4 steps/s and only while the motion switch is on. At rest (no progress yet, not running, Reduce
// motion) it shows the resting shade (phase 0, strength 1). Facets are recoloured straight on the DOM (no React
// re-render).
// (relative imports: ui/ is loaded by the Node unit tests without the "@/" alias)
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BUSY_STEP_MS } from "../core/lowgpu";
import { animate } from "./motion";

const FACETS: Array<[string, number, number, string]> = [
  ["#CBD3DA", 0, 0, "M 308 40 L 313 103 L 373 178 L 409 258 L 267 245 L 114 231 L 181 139 L 256 70 Z"],
  ["#CBD3DA", 0, 0, "M 52 218 L 104 201 L 152 217 L 280 231 L 405 242 L 465 267 L 426 294 L 267 277 L 85 264 Z"],
  ["#BAC3CC", 9, 0.16, "M 52 218 L 104 201 L 152 217 L 280 231 L 405 242 L 465 267 L 413 276 L 267 252 L 119 239 Z"],
  ["#8F9CA9", 4, 0.12, "M 70 216 L 104 207 L 123 229 Z"],
  ["#F5F7F9", 6, 0.07, "M 52 218 L 104 201 L 104 207 L 70 216 L 123 229 Z"],
  ["#8E9CA8", 5, 0.6, "M 397 242 L 447 263 L 413 265 Z"],
  ["#F8FAFC", 5, 0.04, "M 308 40 L 256 70 L 269 107 Z"],
  ["#E2E7EC", 12, 0.1, "M 256 70 L 181 139 L 269 107 Z"],
  ["#D3DAE1", 15, 0.17, "M 181 139 L 114 231 L 267 245 Z"],
  ["#EEF2F5", 11, 0.3, "M 181 139 L 269 107 L 267 245 Z"],
  ["#A9B3BE", 15, 0.44, "M 269 107 L 308 40 L 309 101 L 367 178 Z"],
  ["#BFC8D0", 18, 0.52, "M 269 107 L 367 178 L 267 245 Z"],
  ["#8F9DAA", 14, 0.61, "M 367 178 L 405 257 L 267 245 Z"],
  ["#CDD6DE", 11, 0.7, "M 308 40 L 313 103 L 373 178 L 409 258 L 405 257 L 367 178 L 309 101 Z"],
  ["#A8B3BF", 8, 0.2, "M 52 218 L 114 231 L 85 264 Z"],
  ["#F0F4F7", 8, 0.37, "M 114 231 L 267 245 L 85 264 Z"],
  ["#CAD3DC", 15, 0.45, "M 85 264 L 267 245 L 267 277 Z"],
  ["#D7DFE5", 11, 0.64, "M 267 245 L 405 257 L 426 294 Z"],
  ["#9BAAB7", 9, 0.72, "M 267 245 L 426 294 L 267 277 Z"],
  ["#ADBCC8", 10, 0.79, "M 405 257 L 465 267 L 426 294 Z"],
  ["#F1F6F6", 6, 0.85, "M 405 257 L 465 267 L 452 270 L 408 262 Z"],
];

function lit(hex: string, amplitude: number, offset: number, phase: number, strength: number): string {
  const delta = amplitude * Math.sin(2 * Math.PI * (phase - offset)) * strength;
  const ch = (i: number) => Math.max(0, Math.min(255, parseInt(hex.substring(i, i + 2), 16) + delta));
  // Qt.rgba(channel/255 …) → the renderer rounds each channel
  return `rgb(${Math.round(ch(1))}, ${Math.round(ch(3))}, ${Math.round(ch(5))})`;
}

export interface TinHatLoaderProps {
  size?: number;
  running?: boolean;
  /** changes on every real progress event (e.g. the boot stage's percent): the light advances one step per change */
  progress?: number | string;
  lightStrength?: number;
  className?: string;
  style?: CSSProperties;
}

/** One step of the light per progress change, ≤ 1 per 250 ms, only while the motion switch is on (-1 = at rest). */
function useLightStep(progress: number | string | undefined, running: boolean): number {
  const [step, setStep] = useState(-1);
  const last = useRef<{ p: number | string | undefined; at: number }>({ p: progress, at: -Infinity });
  useEffect(() => {
    if (!running || progress === undefined || progress === last.current.p) return;
    last.current.p = progress;
    if (!animate()) return;
    const now = performance.now();
    if (now - last.current.at < BUSY_STEP_MS) return;
    last.current.at = now;
    setStep((k) => k + 1);
  }, [progress, running]);
  return step;
}

export function TinHatLoader({ size = 64, running = true, progress, lightStrength = 3.2, className, style }: TinHatLoaderProps) {
  const paths = useRef<Array<SVGPathElement | null>>([]);
  const step = useLightStep(progress, running);
  const lit_ = running && step >= 0;
  useEffect(() => {
    const paint = (phase: number, strength: number) => {
      FACETS.forEach(([hex, amp, off], i) => paths.current[i]?.setAttribute("fill", lit(hex, amp, off, phase, strength)));
    };
    if (!lit_) {
      paint(0, 1);
      return;
    }
    paint(((step + 1) % 8) / 8, Math.max(0, Math.min(5, lightStrength)));
  }, [lit_, step, lightStrength]);
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label={running ? "Loading" : "Tin Hat"}
    >
      <g transform="translate(-14.384 62.96) scale(1.046)">
        {FACETS.map(([hex, amp, off, d], i) => (
          <path key={i} ref={(el) => void (paths.current[i] = el)} d={d} fill={lit(hex, amp, off, 0, 1)} />
        ))}
      </g>
    </svg>
  );
}
