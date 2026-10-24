// meter.ts — how every level bar / waveform / meter moves (contract GPU.md §2.7): it updates on level changes at most
// 10 times a second (core/lowgpu.ts WAVE_TICK_MS) while the window is FOCUSED, easing toward the level (waveEase)
// while the motion switch is on and snapping to it under Reduce motion (the meter is data, the ease is the motion);
// while the window is not focused it shows the rest pose (flat, quiet) and runs nothing. Its one timer is cleared as
// soon as the level is quiet and the bars are at rest, and started again by `wake()` — the caller's level source (a
// store subscription) calls it on a change, so a silent call runs no meter timer at all.
// (Before: every tile's waveform and every popover / settings meter ran a 33 ms interval for as long as it was
// mounted, and one talking tile repainted ≈ 28×/s.)
// (relative imports: ui/ is loaded by the Node unit tests without the "@/" alias)
import { useEffect, useRef, useState } from "react";
import { SPEAKING_LEVEL, WAVE_TICK_MS, waveEase } from "../core/lowgpu";
import { onWinState, winFocused } from "../core/winstate";
import { animate, onMotionChange } from "./motion";

/** The shared amplitude curve of the call meters (level 0..1 → bar amplitude 0..1). */
export function levelAmp(level: number): number {
  return level > SPEAKING_LEVEL ? Math.pow(Math.min(1, (level - SPEAKING_LEVEL) / 0.48), 0.6) : 0;
}

export interface MeterDriver {
  /** the level may have changed: start the ticker if there is something to show */
  wake(): void;
  /** unmount */
  stop(): void;
}

/** `read()` = the current level 0..1; `paint(shown, level)` = draw the bars (shown = the eased amplitude 0..1, level =
 *  the sampled level; (0, 0) = the rest pose). */
export function meterDriver(read: () => number, paint: (shown: number, level: number) => void, amp: (level: number) => number = levelAmp): MeterDriver {
  let shown = 0;
  let timer: ReturnType<typeof setInterval> | 0 = 0;
  let alive = true;
  let atRest = false;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = 0;
  };
  const rest = () => {
    stopTimer();
    shown = 0;
    if (!atRest) paint(0, 0);
    atRest = true;
  };
  const tick = () => {
    if (!alive) return stopTimer();
    if (!winFocused()) return rest();
    const level = read();
    const target = amp(level);
    shown = animate() ? waveEase(shown, target) : target;
    paint(shown, level);
    atRest = shown === 0 && level <= SPEAKING_LEVEL;
    if (atRest) stopTimer();
  };
  const wake = () => {
    if (!alive || timer) return;
    if (!winFocused()) return rest();
    if (read() <= SPEAKING_LEVEL && shown === 0) {
      if (!atRest) rest();
      return;
    }
    tick();
    if (!atRest) timer = setInterval(tick, WAVE_TICK_MS);
  };
  const offs = [onMotionChange(() => wake()), onWinState(() => (winFocused() ? wake() : rest()))];
  rest();
  return {
    wake,
    stop() {
      alive = false;
      stopTimer();
      for (const o of offs) o();
    },
  };
}

/** React: a meter's sampled level and eased amplitude by the same rule (for meters rendered by React). `level` is the
 *  live level (re-renders at the source's rate draw nothing new: the output changes only on the ≤ 10/s ticks). */
export function useMeter(level: number, amp: (level: number) => number = levelAmp): { shown: number; level: number } {
  const [v, setV] = useState({ shown: 0, level: 0 });
  const live = useRef(level);
  live.current = level;
  const driver = useRef<MeterDriver | null>(null);
  useEffect(() => {
    const d = meterDriver(
      () => live.current,
      (shown, lv) => setV((cur) => (cur.shown === shown && cur.level === lv ? cur : { shown, level: lv })),
      amp,
    );
    driver.current = d;
    d.wake();
    return () => {
      driver.current = null;
      d.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => driver.current?.wake(), [level]);
  return v;
}
