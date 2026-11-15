// shareQuick.ts — the share picker's "Custom…" panel (12.1.15): the three lists it offers (resolution, frame rate,
// bandwidth), which rows the current share quality is, and the quality a pick gives. Logic only; popovers.tsx draws
// the panel. A quality is [width, height, fps, kbps]. The rules and the lists are the desktop app's
// (crates/app/qml/ShareQuick.qml, AppCore.qml shareResList / shareBwList); both sides run
// testvectors/share-custom-quick/vectors.json (byte-identical in both repos).

export const SHARE_RES: { label: string; w: number; h: number; base: number }[] = [
  { label: "Auto — fit my connection", w: 0, h: 0, base: 12000 },
  { label: "720p", w: 1280, h: 720, base: 4000 },
  { label: "1080p", w: 1920, h: 1080, base: 8000 },
  { label: "1440p", w: 2560, h: 1440, base: 12000 },
  { label: "2160p (4K)", w: 3840, h: 2160, base: 16000 },
  { label: "Source (native)", w: 4096, h: 4096, base: 18000 },
];
export const SHARE_BW: { label: string; f: number }[] = [
  { label: "Good — lightest", f: 0.6 },
  { label: "Great — balanced", f: 1.0 },
  { label: "Best — most bandwidth", f: 1.5 },
  { label: "Unleashed — LAN-grade", f: 2.5 },
];
export const SHARE_FPS = [5, 15, 30, 60];
export const SHARE_FPS_LABELS = SHARE_FPS.map((r) => `${r} fps`);

/** The panel's words (the desktop's StreamPopover.qml says the same). */
export const QUICK_WORDS = {
  pill: "Custom…",
  pillSub: "res · fps · bandwidth",
  resolution: "Resolution",
  frameRate: "Frame rate",
  bandwidth: "Bandwidth",
  more: "More settings…",
} as const;

/** 12.1.15: the line under a screen share's rate in the Outgoing streams card (the desktop's CallIsland.qml statsPopup
 *  says the same; vectors rateHint): the usual reason a shared game's rate drops. */
export const SHARE_RATE_HINT = "Games often lower their frame rate when they're not the focused window.";

export type Quality4 = readonly [w: number, h: number, fps: number, kbps: number];
export type QuickPick = "res" | "fps" | "bw";

/** The row with exactly that size, else 1080p. */
export function quickResIndex(q: Quality4): number {
  const i = SHARE_RES.findIndex((r) => r.w === q[0] && r.h === q[1]);
  return i >= 0 ? i : 2;
}
/** That rate, else 30 fps. */
export function quickFpsIndex(q: Quality4): number {
  const i = SHARE_FPS.indexOf(q[2]);
  return i >= 0 ? i : SHARE_FPS.indexOf(30);
}
/** The step whose bitrate for the current resolution row is nearest; the lower step on a tie. */
export function quickBwIndex(q: Quality4): number {
  const base = SHARE_RES[quickResIndex(q)].base;
  let best = 1;
  let bestD = 1e12;
  SHARE_BW.forEach((t, i) => {
    const d = Math.abs(q[3] - Math.round(base * t.f));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
/** The quality after picking row `i`: a resolution keeps the frame rate and the bandwidth STEP, a frame rate keeps
 *  size and bitrate, a bandwidth step keeps size and frame rate. */
export function quickPick(q: Quality4, what: QuickPick, i: number): [number, number, number, number] {
  if (what === "res") return [SHARE_RES[i].w, SHARE_RES[i].h, q[2], Math.round(SHARE_RES[i].base * SHARE_BW[quickBwIndex(q)].f)];
  if (what === "fps") return [q[0], q[1], SHARE_FPS[i], q[3]];
  return [q[0], q[1], q[2], Math.round(SHARE_RES[quickResIndex(q)].base * SHARE_BW[i].f)];
}
