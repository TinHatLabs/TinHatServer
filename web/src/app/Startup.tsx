// Startup.tsx — StartupWindow.qml, the "Starting Tin Hat" card (0.8.30 portrait design): 320×440,
// centred a touch above the middle, theme bg with a soft accentBright wash, a 1 px sep frame and a
// 3 px accent→accentBright strip along the top; the Tin Hat mark (128 px, its facets sweeping while
// we boot) over a 1.4× accent glow disc; "Tin Hat" 26 px bold + the version 12 px dim; a 232×6
// progress track (sep) with the accent fill easing to the percent (240 ms OutCubic) and a white
// sweep running across it every 1.4 s; the stage (15 px) and its detail (12 px dim) under it; the
// percent 11 px dim at the bottom. Fades in 160 ms; fades out 180 ms when `finished`.
//
// Stages (boot.rs / bridge.rs wording and percents): Starting up 5 · Loading the interface 40 ·
// Restoring your session 55 · Loading your rooms 80 (detail: the user id) · Catching up on
// messages 90 · Please sign in 95 · Ready 100.
import { useEffect, useState, type ReactNode } from "react";
import { TinHatLoader, durMs } from "@/ui";
import s from "./Startup.module.css";

export interface StartupProps {
  stage: string;
  detail?: string;
  percent: number;
  finished?: boolean;
  onHidden?: () => void;
  /** extra content under the stage (the web's "open in another tab" choice) */
  children?: ReactNode;
}

/** boot.version: the universal feature-set version, then the build (native StartupWindow text). */
export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? `Tin Hat Web · build ${(import.meta.env.VITE_TW_SEMVER as string | undefined) ?? "dev"}`; // ADDITIVE (nav, spec §2.12): web version line; deploy sets VITE_APP_VERSION="Tin Hat Web · build <hash>"

export function Startup({ stage, detail, percent, finished, onHidden, children }: StartupProps) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!finished) return;
    const t = window.setTimeout(() => {
      setGone(true);
      onHidden?.();
    }, durMs("slow")); // the fade-out's length (0 while the motion switch is off: the card just goes)
    return () => window.clearTimeout(t);
  }, [finished, onHidden]);
  if (gone) return null;
  const pct = Math.max(0, Math.min(100, finished ? 100 : percent));
  return (
    <div className={s.screen}>
      <div className={`${s.card} ${finished ? s.out : ""}`} role="status" aria-live="polite" aria-label="Starting Tin Hat">
        <div className={s.wash} />
        <div className={s.frame} />
        <div className={s.strip} />
        <div className={s.mascot}>
          <div className={s.glow} />
          {/* GPU.md §2.5: the mark's light moves one step per boot stage (the percent), never on its own; the
              "open in another tab" / "couldn't start" action cards are static */}
          <TinHatLoader size={128} running={!finished && !children} progress={pct} />
        </div>
        <div className={s.wordmark}>Tin Hat</div>
        <div className={s.version}>{APP_VERSION}</div>
        <div className={s.track}>
          <div className={s.fill} style={{ width: Math.max(12, (232 * pct) / 100) }} />
          {/* the native's sweep ran every 1.4 s; now a still glint at the track's start (GPU.md §2.5: no loop) */}
          {!finished && <div className={s.sweep} />}
        </div>
        <div className={s.stage}>{finished ? "Ready" : stage}</div>
        {detail && <div className={s.detail}>{detail}</div>}
        {children && <div className={s.extra}>{children}</div>}
        {/* no percent under an action card (e.g. "Use Tin Hat here"): it overlapped the button and ate its clicks */}
        {!children && <div className={s.percent}>{finished ? "" : `${Math.round(pct)}%`}</div>}
      </div>
    </div>
  );
}
