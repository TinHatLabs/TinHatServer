// layout.ts — the weighted call-grid layout engine, ported verbatim from Main.qml:5876-6158
// (mosaicFit / placeMosaic / stripRowsFor / placeStrip / placeColumn / weightedLayout(Inner)) and
// the grid height rules (Main.qml:5849-5867, 6163-6189). Pure arithmetic; every size clamped ≥ 0.

export interface LTile {
  id: string;
  kind: string;
  screenshare?: boolean;
}
export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
  pip?: boolean;
}
export interface LayoutOut {
  slots: Slot[];
  bottom: number;
  sideX: number;
  sideY: number;
  /** bottom of the main area (above any avatar strip) — where the self PiP sits */
  mainBottom?: number;
  /** height the horizontal side seam divides (portrait band layouts) */
  splitH?: number;
}

export type LayoutMode = "auto" | "gallery" | "speaker" | "sidebar";
export const GAP = 4;
const STRIP_MIN_W = 120;

export function normalizeMode(m: string): LayoutMode {
  return m === "gallery" || m === "speaker" || m === "sidebar" ? m : "auto";
}

function mosaicFit(W: number, H: number, n: number) {
  if (n <= 0 || W <= 0 || H <= 0) return { cols: 1, tileW: 0, tileH: 0 };
  const target = 16 / 9;
  let best: { cols: number; tileW: number; tileH: number; score: number } | null = null;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const tw = Math.floor((W - (c - 1) * GAP) / c);
    const th = Math.floor((H - (r - 1) * GAP) / r);
    if (tw <= 0 || th <= 0) continue;
    const shape = Math.abs(Math.log(tw / th / target));
    const empty = c * r - n;
    const score = shape + empty * 0.5;
    if (best === null || score < best.score) best = { cols: c, tileW: tw, tileH: th, score };
  }
  return best || { cols: 1, tileW: Math.floor(W), tileH: Math.floor(H) };
}

function placeMosaic(out: Slot[], idxs: number[], ox: number, oy: number, W: number, H: number): number {
  const n = idxs.length;
  if (n <= 0) return oy;
  const m = mosaicFit(W, H, n);
  const cols = Math.max(1, m.cols);
  const tw = Math.max(0, m.tileW),
    th = Math.max(0, m.tileH);
  const rows = Math.ceil(n / cols);
  for (let i = 0; i < n; i++) {
    const rr = Math.floor(i / cols);
    const cc = i % cols;
    const inRow = Math.max(1, Math.min(cols, n - rr * cols));
    const rowW = inRow * tw + (inRow - 1) * GAP;
    out[idxs[i]] = {
      x: Math.max(0, Math.round(ox + (W - rowW) / 2 + cc * (tw + GAP))),
      y: Math.max(0, Math.round(oy + rr * (th + GAP))),
      w: tw,
      h: th,
    };
  }
  return oy + rows * th + (rows - 1) * GAP;
}

export function stripRowsFor(n: number, W: number): number {
  if (n <= 0) return 0;
  const perRow = Math.max(1, Math.floor((W + GAP) / (STRIP_MIN_W + GAP)));
  return Math.ceil(n / perRow);
}

function placeStrip(out: Slot[], idxs: number[], ox: number, oy: number, W: number, bandH: number): number {
  const n = idxs.length;
  if (n <= 0) return oy;
  const rows = Math.max(1, stripRowsFor(n, W));
  const perRow = Math.ceil(n / rows);
  const rowH = Math.max(0, (bandH - (rows - 1) * GAP) / rows);
  const maxW = Math.round((rowH * 16) / 9);
  const fitW = Math.floor((W - (perRow - 1) * GAP) / perRow);
  const tw = Math.max(0, Math.min(maxW, fitW));
  const th = Math.max(0, rowH);
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / perRow),
      c = i % perRow;
    const inRow = Math.min(perRow, n - r * perRow);
    const rowW = inRow * tw + (inRow - 1) * GAP;
    out[idxs[i]] = {
      x: Math.max(0, Math.round(ox + (W - rowW) / 2 + c * (tw + GAP))),
      y: Math.max(0, Math.round(oy + r * (rowH + GAP))),
      w: tw,
      h: th,
    };
  }
  return oy + bandH;
}

function placeColumn(out: Slot[], idxs: number[], ox: number, oy: number, colW: number, H: number): number {
  const n = idxs.length;
  if (n <= 0) return oy;
  const th = Math.max(0, Math.min(Math.round((colW * 9) / 16), Math.floor((H - (n - 1) * GAP) / n)));
  for (let i = 0; i < n; i++) {
    out[idxs[i]] = { x: Math.max(0, Math.round(ox)), y: Math.max(0, Math.round(oy + i * (th + GAP))), w: Math.max(0, colW), h: th };
  }
  return oy + n * th + (n - 1) * GAP;
}

const isShare = (t: LTile) => t.kind === "screenshare" || t.screenshare === true;

/** weightedLayout (Main.qml:6003-6025): the inner engine + the self-view PiP. */
export function weightedLayout(
  W: number,
  H: number,
  tiles: LTile[],
  afk: boolean,
  hidden: string[],
  mode: LayoutMode,
  pinned: string | null,
  sideFrac: number,
  selfPipEffective: boolean,
): LayoutOut {
  let selfIdx = -1,
    others = 0;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t) continue;
    if (t.id === "vid_selfview") selfIdx = i;
    else if (hidden.indexOf(t.id) === -1 && t.kind !== "avatar") others++;
  }
  const pip = selfPipEffective && !afk && selfIdx >= 0 && others > 0;
  const out = inner(W, H, tiles, afk, pip ? hidden.concat(["vid_selfview"]) : hidden, mode, pinned, sideFrac);
  if (pip && out.slots.length > selfIdx) {
    let pw = Math.max(140, Math.min(300, Math.round(W / 5)));
    let ph = Math.round((pw * 9) / 16);
    const rightEdge = out.sideX > 0 ? out.sideX - GAP : W;
    // Native uses out.bottom here, which includes the avatar strip, so the PiP covered strip tiles
    // (docs/native-bugs/callui.md) — the web keeps it in the main area, above the strip.
    const mb = out.mainBottom && out.mainBottom > 0 ? out.mainBottom : out.bottom;
    const bottomEdge = out.sideY > 0 ? out.sideY - GAP : mb > 0 ? mb : H;
    // never larger than the area it sits in (tiny grids)
    if (pw > rightEdge - 2 * GAP) {
      pw = Math.max(0, rightEdge - 2 * GAP);
      ph = Math.round((pw * 9) / 16);
    }
    if (ph > bottomEdge - 2 * GAP) {
      ph = Math.max(0, bottomEdge - 2 * GAP);
      pw = Math.round((ph * 16) / 9);
    }
    out.slots[selfIdx] = { x: Math.max(0, rightEdge - pw - GAP), y: Math.max(0, bottomEdge - ph - GAP), w: pw, h: ph, pip: true };
  }
  return out;
}

function inner(W: number, H: number, tiles: LTile[], afk: boolean, hidden: string[], mode: LayoutMode, pinned: string | null, sideFrac: number): LayoutOut {
  const slots: Slot[] = tiles.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const out: LayoutOut = { slots, bottom: 0, sideX: 0, sideY: 0 };
  if (W <= 0 || H <= 0 || tiles.length === 0) return out;
  if (afk) {
    // only the self tile shows while we're away (never a remote one if there is no self tile)
    const me = tiles.findIndex((t) => t && t.id === "vid_selfview");
    if (me < 0) return out;
    slots[me] = { x: 0, y: 0, w: Math.max(0, Math.floor(W)), h: Math.max(0, Math.floor(H)) };
    out.bottom = Math.max(0, Math.floor(H));
    return out;
  }
  const shares: number[] = [],
    cams: number[] = [],
    avatars: number[] = [],
    all: number[] = [];
  let pinIdx = -1;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t || hidden.indexOf(t.id) !== -1) continue;
    all.push(i);
    if (pinned && t.id === pinned) pinIdx = i;
    if (t.kind === "avatar") avatars.push(i);
    else if (isShare(t)) shares.push(i);
    else cams.push(i);
  }
  if (all.length === 0) return out;
  const sideW = Math.max(160, Math.min(Math.round(W * 0.5), Math.round(W * (sideFrac || 0.28))));
  const stripHFor = (n: number) => {
    if (n <= 0) return 0;
    const base = Math.max(96, Math.min(200, Math.round(H * 0.22)));
    const rows = Math.max(1, stripRowsFor(n, W));
    return Math.min(Math.round(H * 0.5), rows * base + (rows - 1) * GAP);
  };
  const without = (list: number[], idx: number) => list.filter((k) => k !== idx);

  if (mode === "gallery") {
    out.bottom = placeMosaic(slots, all, 0, 0, W, H);
    return out;
  }
  if (mode === "speaker" || (pinIdx >= 0 && mode !== "sidebar")) {
    const main = pinIdx >= 0 ? pinIdx : shares.length ? shares[0] : cams.length ? cams[0] : avatars[0];
    const rest = without(all, main);
    const sH = stripHFor(rest.length);
    const mainH = Math.max(0, H - (sH > 0 ? sH + GAP : 0));
    slots[main] = { x: 0, y: 0, w: Math.max(0, Math.floor(W)), h: Math.max(0, Math.floor(mainH)) };
    let b = mainH;
    if (sH > 0) b = placeStrip(slots, rest, 0, mainH + GAP, W, sH);
    out.bottom = Math.max(0, Math.round(b));
    out.mainBottom = Math.round(mainH);
    return out;
  }
  const portrait = H > W;
  const bandHFor = (avail: number) => Math.max(110, Math.min(Math.round(avail * 0.45), Math.round(avail * (sideFrac || 0.28))));

  if (mode === "sidebar") {
    let mains = shares.length ? shares.slice() : pinIdx >= 0 ? [pinIdx] : cams.length ? [cams[0]] : [];
    if (pinIdx >= 0 && mains.indexOf(pinIdx) === -1) mains = [pinIdx];
    const side = all.filter((k) => mains.indexOf(k) === -1);
    if (mains.length === 0) {
      out.bottom = placeMosaic(slots, side, 0, 0, W, H);
      return out;
    }
    if (side.length === 0) {
      out.bottom = placeMosaic(slots, mains, 0, 0, W, H);
      return out;
    }
    if (portrait) {
      const bandH = bandHFor(H);
      const mainH2 = Math.max(0, H - bandH - GAP);
      const mbP = placeMosaic(slots, mains, 0, 0, W, mainH2);
      const sbP = placeStrip(slots, side, 0, mainH2 + GAP, W, bandH);
      out.sideY = mainH2 + GAP;
      out.splitH = H;
      out.bottom = Math.max(0, Math.round(Math.max(mbP, sbP)));
      return out;
    }
    const mainW = Math.max(0, W - sideW - GAP);
    const mb = placeMosaic(slots, mains, 0, 0, mainW, H);
    const sb = placeColumn(slots, side, mainW + GAP, 0, sideW, H);
    out.sideX = mainW + GAP;
    out.bottom = Math.max(0, Math.round(Math.max(mb, sb)));
    return out;
  }

  // auto
  if (shares.length > 0) {
    const sH2 = stripHFor(avatars.length);
    const bodyH = Math.max(0, H - (sH2 > 0 ? sH2 + GAP : 0));
    let b2: number;
    if (portrait && cams.length > 0) {
      const camBand = bandHFor(bodyH);
      const shareH = Math.max(0, bodyH - camBand - GAP);
      placeMosaic(slots, shares, 0, 0, W, shareH);
      placeStrip(slots, cams, 0, shareH + GAP, W, camBand);
      out.sideY = shareH + GAP;
      out.splitH = bodyH;
      b2 = bodyH;
    } else {
      const mainW2 = cams.length > 0 ? Math.max(0, W - sideW - GAP) : W;
      const mb2 = placeMosaic(slots, shares, 0, 0, mainW2, bodyH);
      const cb2 = cams.length > 0 ? placeColumn(slots, cams, mainW2 + GAP, 0, sideW, bodyH) : 0;
      if (cams.length > 0) out.sideX = mainW2 + GAP;
      b2 = Math.max(mb2, cb2, bodyH);
    }
    if (sH2 > 0) {
      b2 = placeStrip(slots, avatars, 0, bodyH + GAP, W, sH2);
      out.mainBottom = Math.round(bodyH);
    }
    out.bottom = Math.max(0, Math.round(b2));
    return out;
  }
  if (cams.length === 0) {
    out.bottom = placeMosaic(slots, avatars, 0, 0, W, H);
    return out;
  }
  const sH3 = stripHFor(avatars.length);
  const primH = Math.max(0, H - (sH3 > 0 ? sH3 + GAP : 0));
  let b3 = placeMosaic(slots, cams, 0, 0, W, primH);
  if (sH3 > 0) {
    out.mainBottom = Math.round(b3);
    b3 = placeStrip(slots, avatars, 0, primH + GAP, W, sH3);
  }
  out.bottom = Math.max(0, Math.round(b3));
  return out;
}

/** normalBoxH (Main.qml:6163-6178): ≈2-up rows of 16:9 + a strip if any avatar. */
export function normalBoxH(width: number, liveCount: number, shown: LTile[], afk: boolean): number {
  if (liveCount <= 0) return 0;
  const c = liveCount <= 1 ? 1 : 2;
  const w = Math.max(0, Math.floor((width - (c - 1) * GAP) / c));
  const primTiles = afk ? 1 : shown.filter((t) => t.kind !== "avatar").length;
  const hasAvatar = !afk && shown.some((t) => t.kind === "avatar");
  const rows = Math.max(1, Math.ceil(Math.max(1, primTiles) / c));
  let h = rows * Math.round((w * 9) / 16) + (rows - 1) * GAP;
  if (hasAvatar) h += GAP + Math.max(96, Math.min(160, Math.round(((w * 9) / 16) * 0.5)));
  return Math.max(0, h);
}

/** The height fed to the engine (Main.qml:5849-5867, 6180-6189). Islands C2 (ISLANDS-ARCH §4.2): whole pixels, rounded
 *  the way the layout solver rounds a per-mille length (fdiv = floor) — the seam share as per mille of the page, the
 *  chat's quarter as floor(pageH / 4) — so the dock host will reproduce exactly these heights. */
export function engineHeight(o: { maximized: boolean; pageH: number; chromeH: number; paneFrac: number; boxH: number }): number {
  if (o.maximized) return Math.max(160, o.pageH - o.chromeH - 16);
  const pm = Math.round(o.paneFrac * 1000);
  const cap = o.paneFrac >= 0 ? Math.max(120, Math.floor((o.pageH * pm) / 1000) - o.chromeH) : Math.max(200, o.pageH - o.chromeH - Math.max(160, Math.floor(o.pageH / 4)));
  return o.paneFrac >= 0 ? cap : Math.min(o.boxH, cap);
}
