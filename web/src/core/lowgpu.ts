// lowgpu.ts — the pure rules of the low-GPU contract (contract GPU.md §1–§2), shared by the web's runtime modules
// (core/winstate.ts, ui/motion.ts, ui/AnimatedImage.tsx, the call engine) and mirrored one-to-one by the desktop app
// (same constants, same case names in lowgpu.test.ts ↔ the desktop's tests). No DOM, no React, no imports.
//
//   window state  focused | unfocused | hidden (computeWinState)       GPU.md §1
//   render state  what the rules below act on: unfocused draws as focused unless the saver is on (computeRenderState)
//                 §1 amendment 10.8.1 — the option "Save GPU while Tin Hat isn't focused", default off
//   animate       focused AND NOT reduce motion (animateFor)            §1
//   duration      ONE token `dur` = 120 ms; named steps are fixed multiples of it; the cap is 400 ms (DUR)   §1
//   timers        ≥ 1 s whenever not focused (intervalFor)              §2.8
//   caret         blinks 5 s after key / pointer / focus, then solid (CARET_BLINK_MS)   §2.1
//   ring          unfocused AND NOT reduce motion AND < 25 s; 2 Hz two-state blink (ringOn, ringHigh)   §2.3
//   busy mark     static; ≤ 1 step per progress event, ≤ 4 steps/s, only while animate; "Still …" after 10 s   §2.5
//   GIFs          ≤ 3 loops or 15 s while focused + in view, then the first frame (gifRunMs)   §2.6
//   level bars    ≤ 10 updates/s while animate, a short ease that stops at rest (waveEase)   §2.7
//   call video    unfocused: cameras → the low layer at ≤ 15 fps; hidden: released per track (videoPolicy)   §2.11

export type WinState = "focused" | "unfocused" | "hidden";

/** The window state from what the page can see. `visible` = the main page is not hidden; `focused` = the main page
 *  or one of its pop-out windows has the keyboard focus. */
export function computeWinState(visible: boolean, focused: boolean): WinState {
  if (!visible) return "hidden";
  return focused ? "focused" : "unfocused";
}

/** The motion switch: focused AND NOT reduce motion (reduce motion = the app's pref OR the OS setting). */
export function animateFor(win: WinState, reduced: boolean): boolean {
  return win === "focused" && !reduced;
}

// ---- the render state (10.8.1, GPU.md §1 amendment) ---------------------------------------------------------------

/** Settings → Appearance → Performance → "Save GPU while Tin Hat isn't focused" — the pref key. It is the 10.8.0 key
 *  (then a calls-only switch that defaulted to on), kept because it can tell a choice from the default: only the
 *  Settings switch ever writes it, so a stored "1" / "0" is the user's own choice and stays; absent = never touched =
 *  the new default, OFF (2026-09-27: "for lower end machines … it just should be an option"). */
export const UNFOCUSED_SAVER_PREF = "call-unfocused-saver";
/** The option from its stored value: on only when the user turned it on ("1"; "true" read alike). */
export function unfocusedSaverOn(raw: string | null | undefined): boolean {
  return raw === "1" || raw === "true";
}
/** The RENDER state: the window state every drawing rule acts on (the motion switch, GIFs, meters, timers, call video,
 *  previews, widget / stats refresh). The real state, except that a visible-but-unfocused window renders as focused
 *  unless the saver is on; hidden stays hidden either way (nothing of it is on screen). What depends on REAL focus —
 *  the incoming-call ring, notifications / unread, the caret's 5 s rule, the call chrome — keeps the real state. */
export function renderStateFor(win: WinState, saverOn: boolean): WinState {
  return win === "unfocused" && !saverOn ? "focused" : win;
}
/** computeWinState + renderStateFor in one: the render state from what the page can see and the option. */
export function computeRenderState(visible: boolean, focused: boolean, saverOn: boolean): WinState {
  return renderStateFor(computeWinState(visible, focused), saverOn);
}
/** The line both apps log once per change (tag `winstate`): "focused → unfocused (render: focused, option off)". */
export function winStateLogText(prev: WinState, next: WinState, render: WinState, saverOn: boolean): string {
  return `${prev} → ${next} (render: ${render}, option ${saverOn ? "on" : "off"})`;
}

// ---- the duration token -------------------------------------------------------------------------------------------

export type DurStep = "dur" | "short" | "slow" | "long" | "verylong";
/** THE duration token `dur` (Main.qml `dur`) and its named steps, all fixed multiples of it (short 5/6, slow 3/2,
 *  long 5/3, verylong 10/3). 0 whenever `animate` is off. Nothing moves longer than `verylong` = 400 ms. */
export const DUR: Readonly<Record<DurStep, number>> = { dur: 120, short: 100, slow: 180, long: 200, verylong: 400 };
export const DUR_CAP_MS = 400;
/** The nearest step for a literal duration of the pre-contract code (the migration rule both apps used: nearest
 *  step, ties to the shorter one; anything over 400 ms → verylong). */
export function nearestStep(ms: number): DurStep {
  const order: DurStep[] = ["short", "dur", "slow", "long", "verylong"];
  let best: DurStep = "short";
  for (const k of order) if (Math.abs(DUR[k] - ms) < Math.abs(DUR[best] - ms)) best = k;
  return best;
}

// ---- timers (§2.8) ------------------------------------------------------------------------------------------------

/** A repeating timer's period in a window state: `focusedMs` while focused, else max(1000, the unfocused / hidden
 *  period). The incoming-call ring's 250 ms steps are the one exempt timer (they don't use this). */
export function intervalFor(state: WinState, focusedMs: number, otherMs: number = focusedMs, hiddenMs: number = otherMs): number {
  if (state === "focused") return focusedMs;
  return Math.max(1000, state === "hidden" ? hiddenMs : otherMs);
}

// ---- the caret (§2.1) ---------------------------------------------------------------------------------------------

export const CARET_BLINK_MS = 5000;

// ---- the incoming-call ring (§2.3) --------------------------------------------------------------------------------

export const RING_LIMIT_MS = 25_000;
export const RING_STEP_MS = 250;
/** `ring` = ringing AND unfocused (visible, not focused) AND NOT reduce motion AND < 25 s since it started ringing. */
export function ringOn(ringingSince: number | null, now: number, win: WinState, reduced: boolean): boolean {
  return ringingSince != null && win === "unfocused" && !reduced && now - ringingSince >= 0 && now - ringingSince < RING_LIMIT_MS;
}
/** The ring's two-state blink: 250 ms per state (2 Hz = 4 visual steps/s), `high` first. */
export function ringHigh(ringingSince: number, now: number): boolean {
  return Math.floor(Math.max(0, now - ringingSince) / RING_STEP_MS) % 2 === 0;
}
/** The pulse layer's opacity: rest 0.12 (static — focused, reduce motion, after 25 s), ringing 0.22 / 0.06. */
export const RING_OPACITY = { rest: 0.12, high: 0.22, low: 0.06 } as const;

// ---- the busy mark (§2.5) -----------------------------------------------------------------------------------------

/** At most one visual step per 250 ms (≤ 4 steps/s). */
export const BUSY_STEP_MS = 250;
/** After this long without a progress event the label changes once ("Still loading…"). */
export const BUSY_STILL_MS = 10_000;
/** The house busy mark = Controls.BusyIndicator's ten dots. Step -1 (no progress yet) = all ten outlined (the
 *  resting glyph); step k ≥ 0 fills dot i when (k − i) mod 20 < 10 and i ≤ k (the native fill/empty order, one dot
 *  per step instead of one per 100 ms). */
export function busyDotFilled(i: number, step: number): boolean {
  if (step < 0 || i > step) return false;
  return (((step - i) % 20) + 20) % 20 < 10;
}
/** "Loading…" → "Still loading…" (the label changes once after BUSY_STILL_MS without progress). */
export function stillLabel(label: string): string {
  if (!label) return label;
  if (/^still\b/i.test(label)) return label;
  return `Still ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

// ---- GIFs / animated WebP (§2.6) ----------------------------------------------------------------------------------

export const GIF_MAX_LOOPS = 3;
export const GIF_MAX_MS = 15_000;
/** How long one autoplay run lasts: at most 3 loops (or the file's own smaller loop count) and at most 15 s.
 *  `loopMs` ≤ 0 (unknown) → 15 s. `loops` 0 = the file loops forever. `one` = a single loop (the click under
 *  reduce motion). */
export function gifRunMs(loopMs: number, loops: number, one = false): number {
  if (!(loopMs > 0)) return GIF_MAX_MS;
  const n = one ? 1 : loops > 0 ? Math.min(loops, GIF_MAX_LOOPS) : GIF_MAX_LOOPS;
  return Math.min(GIF_MAX_MS, loopMs * n);
}
/** Browsers play a GIF frame delay of 0 or 10 ms as 100 ms (Chromium/Firefox/Safari agree). */
export function gifFrameMs(centiseconds: number): number {
  return centiseconds <= 1 ? 100 : centiseconds * 10;
}

// ---- level bars, waveforms, speaking borders (§2.7) --------------------------------------------------------------

/** ≤ 10 updates/s while animate. */
export const WAVE_TICK_MS = 100;
/** One ease step of a bar's shown amplitude toward its target: halves the gap each tick, lands exactly when the gap
 *  is < 0.015 (so the ticker stops at rest). */
export function waveEase(shown: number, target: number): number {
  const d = target - shown;
  return Math.abs(d) < 0.015 ? target : shown + d * 0.5;
}
/** Speaking = the level is over the threshold (the native 0.02). */
export const SPEAKING_LEVEL = 0.02;

// ---- calls while not focused (§2.11) ------------------------------------------------------------------------------

export const UNFOCUSED_CAM_FPS = 15;
/** Stats refresh: every `focusedMs` while focused, every 5 s otherwise (DESIGN: "call stats every 5 s"). */
export const UNFOCUSED_STATS_MS = 5000;

export interface VideoPolicyIn {
  /** the RENDER state (renderStateFor): with the saver off an unfocused window arrives here as focused */
  win: WinState;
  /** Settings → Appearance → Performance → "Save GPU while Tin Hat isn't focused" (default off since 10.8.1) */
  policyOn: boolean;
  isShare: boolean;
  /** a visible Tin Hat pop-out window (Document PiP, `<video>` PiP) shows this track */
  inVisiblePopout: boolean;
}
export interface VideoPolicyOut {
  /** keep receiving + decoding (false = released at the SFU, no decode) */
  enabled: boolean;
  /** receive the server's low layer at ≤ UNFOCUSED_CAM_FPS instead of the tile-size layer */
  low: boolean;
}
/** Per remote video track. Hidden: released unless a visible pop-out shows it (per track — "hidden" is about what
 *  the user can see). Unfocused (and the policy on): camera tracks take the low layer at ≤ 15 fps; shares keep their
 *  quality (the watched share stays full). Focused: unchanged. */
export function videoPolicy(p: VideoPolicyIn): VideoPolicyOut {
  if (p.win === "hidden") return { enabled: p.inVisiblePopout, low: p.inVisiblePopout && p.policyOn && !p.isShare };
  if (p.win === "unfocused" && p.policyOn && !p.isShare) return { enabled: true, low: true };
  return { enabled: true, low: false };
}
/** Local previews (self-view camera, the share popover's preview) pause while hidden (nobody sees them — whatever the
 *  option), and while unfocused when the policy is on (pass the render state: with the saver off an unfocused window
 *  renders as focused and its previews run). */
export function previewPaused(win: WinState, policyOn: boolean): boolean {
  return win === "hidden" || (win === "unfocused" && policyOn);
}
