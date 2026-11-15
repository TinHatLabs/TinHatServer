// model.ts — "Match the game" chat backgrounds (lane sun-gamebg, 2026-11-14), the pure half. No DOM, no React, no
// imports. Byte-identical rules in the desktop's crates/widgets/src/gamebg.rs and the server's api/games/background.mjs
// (gameKey); all three replay testvectors/gamebg/vectors.json with the same case names.
//
//   gameKey(text)            the comparable form of a status text / game name ("Playing Valheim" → "valheim")
//   pickGame(input)          which game a room shows: members' shared statuses + the room's Now playing; call players
//                            first; ties → the most recent, then the smaller id; nobody → null
//   stepStable(st, cand, t)  at most one change per HOLD_MS, a candidate must last SETTLE_MS, the first look at once
//                            (a first look of nobody starts no hold)
//   veilFor(theme, cells)    the smallest theme-colour veil keeping the timeline's text colours at the target contrast
//                            over every measured pixel of the art
//   artMode(...)             whether game art applies to a room at all (the room's background state + the switches)

import { imageDims, parseBackground } from "../ambience/core";

/** Game art's size caps, shared with the desktop (gamebg.rs; vectors `constants` + `art_size`): at most 16 MP (a
 *  3840 × 1240 Steam hero is 4.8 MP) and at most 8192 px on a side, below common GPU texture maxima (R5). */
export const ART_MAX_PIXELS = 16_000_000;
export const ART_MAX_SIDE = 8192;
/** Game art of this size may be decoded and shown (the one rule both apps share). */
export function artDimsOk(w: number, h: number): boolean {
  return w > 0 && h > 0 && w <= ART_MAX_SIDE && h <= ART_MAX_SIDE && w * h <= ART_MAX_PIXELS;
}
/** R3-4: the art's size from its HEADER (ambience imageDims: PNG, JPEG, GIF incl. the first frame, WebP, BMP) before
 *  anything decodes it; over a cap, or a size the header doesn't give = no art (never decoded). */
export function artSizeOk(bytes: Uint8Array): boolean {
  const d = imageDims(bytes);
  return !!d && artDimsOk(d.w, d.h);
}

export const PREF_GAME_ART = "chat-game-art";
export const SETTLE_MS = 60_000;
export const HOLD_MS = 180_000;
/** the crossfade when the game changes (reduce motion: none) */
export const FADE_MS = 2400;
/** the gentle dim: the veil never goes below these (and rises only as far as the measured art needs) */
export const VEIL_FLOOR = { dark: 0.4, oled: 0.5, light: 0.45 } as const;
/** the most veil per theme kind. Light themes go further: hero art is mostly dark, and dark pixels are what fight a
 *  light theme's dark text (measured: Adwaita's "NEW" red needs 0.94–0.95 over the five heroes) — a faint wash there */
export const VEIL_CAP = { dark: 0.92, oled: 0.92, light: 0.96 } as const;
export const MIN_CONTRAST = 4.5;
/** the art is measured at FULL size (no downscale may average a crisp bright speck away: a 160-px and then a 960-px
 *  measure both missed specks the contrast gate found) into bound cells (boundPixels) */
/** the veil is fitted to a little more than the 4.5:1 required: the browser's / Qt's resampling of the art can overshoot
 *  its source pixels slightly */
export const FIT_CONTRAST = 4.6;

// ---- names --------------------------------------------------------------------------------------------------------
const WS = new Set([" ", "\t", "\n", "\r", "\f", "\v", " "]);
const MARKS = new Set(["™", "®", "©"]);
const NAME_MAX = 64;
/** The comparable form of a game name or a status text (vectors "gameKey"): drop ™ ® ©; every run of ASCII
 *  whitespace / NBSP → one space; trim; ASCII-only lower case; strip ONE leading "now playing" or "playing" followed by
 *  ":", "-" or a space; strip trailing "." / "!" then trailing spaces. Not a string or over 64 code points → "". */
export function gameKey(s: unknown): string {
  if (typeof s !== "string") return "";
  let out = "";
  let pend = false;
  for (const ch of s) {
    if (MARKS.has(ch)) continue;
    if (WS.has(ch)) {
      pend = out.length > 0;
      continue;
    }
    if (pend) {
      out += " ";
      pend = false;
    }
    const c = ch.charCodeAt(0);
    out += ch.length === 1 && c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
  }
  for (const p of ["now playing", "playing"]) {
    if (out.startsWith(p)) {
      const rest = out.slice(p.length);
      const m = /^(?: *[:-] *| +)/.exec(rest);
      if (m && m[0].length > 0 && rest.length > m[0].length) {
        out = rest.slice(m[0].length);
        break;
      }
    }
  }
  out = out.replace(/[.!]+$/, "").replace(/ +$/, "");
  return [...out].length > NAME_MAX ? "" : out;
}

// ---- picking ------------------------------------------------------------------------------------------------------
export interface Claim {
  user: string;
  /** the status text as shared */
  text: string;
  /** when it was set / first seen (ms) */
  at: number;
}
export interface PickIn {
  /** joined members of the room */
  members: readonly string[];
  /** people in the room's call right now */
  callers: readonly string[];
  /** the shared statuses (only people who share them are here at all) */
  claims: readonly Claim[];
  /** the room's Now playing */
  activity: { text: string; at: number } | null;
  /** gameKey → catalogue id (null / absent = not a game) */
  ids: Readonly<Record<string, string | null | undefined>>;
}
export interface PickOut {
  game: string | null;
  why: "call" | "room" | "none";
}
type Vote = readonly [id: string, at: number];
function winner(votes: readonly Vote[]): string {
  const g = new Map<string, { n: number; last: number }>();
  for (const [id, at] of votes) {
    const cur = g.get(id) ?? { n: 0, last: -Infinity };
    g.set(id, { n: cur.n + 1, last: Math.max(cur.last, at) });
  }
  let best: [string, { n: number; last: number }] | null = null;
  for (const e of g) {
    if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && (e[1].last > best[1].last || (e[1].last === best[1].last && e[0] < best[0])))) best = e;
  }
  return best![0];
}
export function pickGame(p: PickIn): PickOut {
  const members = new Set(p.members);
  const idOf = (text: string): string | null => {
    const k = gameKey(text);
    if (!k || !Object.prototype.hasOwnProperty.call(p.ids, k)) return null;
    return p.ids[k] || null;
  };
  const own = new Map<string, Vote>();
  for (const c of p.claims) {
    if (!members.has(c.user)) continue;
    const id = idOf(c.text);
    if (!id) continue;
    const cur = own.get(c.user);
    if (!cur || c.at > cur[1] || (c.at === cur[1] && id < cur[0])) own.set(c.user, [id, c.at]);
  }
  let act: Vote | null = null;
  if (p.activity) {
    const id = idOf(p.activity.text);
    if (id) act = [id, p.activity.at];
  }
  const callers: string[] = [];
  for (const u of p.callers) if (members.has(u) && !callers.includes(u)) callers.push(u);
  if (callers.length) {
    const votes: Vote[] = [];
    for (const u of callers) {
      const v = own.get(u) ?? act;
      if (v) votes.push(v);
    }
    if (votes.length) return { game: winner(votes), why: "call" };
  }
  const votes: Vote[] = [...own.values()];
  if (act) votes.push(act);
  if (votes.length) return { game: winner(votes), why: "room" };
  return { game: null, why: "none" };
}

// ---- no flicker ---------------------------------------------------------------------------------------------------
export interface Stable {
  shown: string | null;
  since: number;
  cand: string | null;
  candSince: number;
}
/** One step of the stabiliser (vectors "stabilise"). `st` null = the first look: the candidate shows at once. */
export function stepStable(st: Stable | null, cand: string | null, now: number): Stable {
  // a first look of nobody starts no hold: the first game that appears shows after the settle
  if (!st) return { shown: cand, since: cand === null ? -Infinity : now, cand, candSince: now };
  let s = st;
  if (cand !== s.cand) s = { ...s, cand, candSince: now };
  if (s.cand !== s.shown && now - s.candSince >= SETTLE_MS && now - s.since >= HOLD_MS) s = { ...s, shown: s.cand, since: now };
  return s;
}
/** When the next step could change what shows (ms from now), or null when nothing is pending. */
export function nextStepIn(st: Stable | null, now: number): number | null {
  if (!st || st.cand === st.shown) return null;
  return Math.max(0, st.candSince + SETTLE_MS - now, st.since + HOLD_MS - now);
}

// ---- contrast -----------------------------------------------------------------------------------------------------
export type Rgb = readonly [number, number, number];
export function parseHex(s: string): Rgb | null {
  // ASCII-only trimming (the Rust port trims the same set: String.prototype.trim would also take U+FEFF etc.)
  const m = /^[ \t\n\r]*#([0-9a-f]{6})[ \t\n\r]*$/i.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lin(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}
export function luminance(c: Rgb): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export interface VeilTheme {
  /** the timeline's background (the veil's colour) */
  bg: string;
  /** the text colours the timeline draws straight on the background (timeline texts + people's name colours) */
  texts: readonly string[];
  /** the contrast every text must keep (4.5): a text counts when it already has it on the plain theme */
  need: number;
  /** the contrast the veil is fitted to (a little more than `need`: resampling headroom); falls back to `need` */
  target: number;
  floor: number;
  cap: number;
}
const contrastL = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** The smallest veil alpha (steps of 0.01 in [floor, cap]; every stronger veil up to 1 safe too) with every counted text at ≥ target over every cell mixed
 *  toward the theme background (a·bg + (1−a)·cell); if none reaches target, the smallest reaching `need`; if none does,
 *  null = the art can't be made readable here: draw no art. Contrast only depends on luminance, so each mixed cell is
 *  checked against the text luminances right below and above it (the nearest ones are the worst). */
/** The veil's text list (3-2): every colour drawn straight on the background — the timeline's own texts, the theme's name
 *  colours AND the room's role name colours — as unique lower-case "#rrggbb" in order; anything else is dropped (callers
 *  hand in colours already resolved to sRGB hex). Shared with the desktop (gamebg.rs ink_texts; vectors "ink"). */
export function inkTexts(own: readonly unknown[], names: readonly unknown[], roles: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const x of [...own, ...names, ...roles]) {
    if (typeof x !== "string" || !/^#[0-9a-f]{6}$/i.test(x)) continue;
    const h = x.toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export function veilFor(t: VeilTheme, cells: readonly Rgb[]): number | null {
  const bg = parseHex(t.bg);
  const lo = Math.round(t.floor * 100);
  const hi = Math.round(t.cap * 100);
  if (!bg) return null;
  const tl: number[] = [];
  for (const x of t.texts) {
    const c = parseHex(x);
    if (c && contrast(c, bg) >= t.need) {
      const l = luminance(c);
      if (!tl.includes(l)) tl.push(l);
    }
  }
  tl.sort((a, b) => a - b);
  if (!tl.length) return lo / 100;
  const ok = (a: number, want: number) => {
    for (const c of cells) {
      const L = luminance([a * bg[0] + (1 - a) * c[0], a * bg[1] + (1 - a) * c[1], a * bg[2] + (1 - a) * c[2]]);
      let i = 0;
      while (i < tl.length && tl[i] < L) i++; // bisect_left
      if (i > 0 && contrastL(tl[i - 1], L) < want) return false;
      if (i < tl.length && contrastL(tl[i], L) < want) return false;
    }
    return true;
  };
  // a veil counts only if every STRONGER veil up to fully opaque is safe too: a fade through the theme (= a rising veil,
  // how the art crossfades) then never dips under the need
  for (const want of [t.target, t.need]) {
    const good: boolean[] = [];
    for (let k = lo; k <= 100; k++) good.push(ok(k / 100, want));
    for (let k = lo; k <= hi; k++) if (good.slice(k - lo).every(Boolean)) return k / 100;
  }
  return null;
}
/** The cells veilFor measures for an art (`width` px wide): every pixel's 5×5 neighbourhood (clamped at the edges) gives
 *  its per-channel MINIMUM and MAXIMUM colour; for every (r, g) bucket of 4 levels that has any, its UPPER corner with the
 *  bucket's highest blue and its LOWER corner with the lowest (buckets in index order, upper ones first). The mixed
 *  colour's luminance rises with every channel, so these corners bound every pixel AND every average of nearby pixels a
 *  downscale can draw (a sort by the pixels' own luminance did not; nor did the source pixels alone). ≤ 8192 cells. */
export function boundPixels(rgba: ArrayLike<number>, width: number): Rgb[] {
  const w = Math.max(0, Math.floor(width));
  const h = w ? Math.floor(Math.floor(rgba.length / 4) / w) : 0;
  const mx = new Int16Array(4096).fill(-1);
  const mn = new Int16Array(4096).fill(256);
  const put = (r: number, g: number, b: number) => {
    const k = (r >> 2) * 64 + (g >> 2);
    if (b > mx[k]) mx[k] = b;
    if (b < mn[k]) mn[k] = b;
  };
  if (w && h) {
    // separable: the row pass, then the column pass over its results
    const hlo = new Uint8Array(w * h * 3);
    const hhi = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let lo = 255;
          let hi = 0;
          for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
            const v = rgba[(y * w + xx) * 4 + c];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          hlo[(y * w + x) * 3 + c] = lo;
          hhi[(y * w + x) * 3 + c] = hi;
        }
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let a = 255;
          let b = 0;
          for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++) {
            const i = (yy * w + x) * 3 + c;
            if (hlo[i] < a) a = hlo[i];
            if (hhi[i] > b) b = hhi[i];
          }
          lo[c] = a;
          hi[c] = b;
        }
        put(lo[0], lo[1], lo[2]);
        put(hi[0], hi[1], hi[2]);
      }
  }
  const up: Rgb[] = [];
  const dn: Rgb[] = [];
  for (let k = 0; k < 4096; k++) {
    if (mx[k] < 0) continue;
    up.push([(k >> 6) * 4 + 3, (k & 63) * 4 + 3, mx[k]]);
    dn.push([(k >> 6) * 4, (k & 63) * 4, mn[k]]);
  }
  return [...up, ...dn];
}
/** The distinct pixels of an RGBA buffer (small inputs / tests). */
export function pixelsOf(rgba: ArrayLike<number>): Rgb[] {
  const seen = new Set<number>();
  const out: Rgb[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
  return out;
}

// ---- does game art apply ------------------------------------------------------------------------------------------
export type ArtMode = "game" | "off";
/** Is the room's own background "nothing set"? Absent, not an object, or an object with no keys (a cleared state). */
export function nothingSet(content: unknown): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return true;
  return Object.keys(content as object).length === 0;
}
/** Whether game art may show in a room (vectors "mode"). `room` / `space` = the `dev.tinhat.chat.background` contents
 *  of the room and of its parent space (undefined = none). The owner's call (2026-11-14): game art is automatic where nothing is
 *  set; `kind: "game"` asks for it; any other background someone set (a preset, an image, an explicit "none") wins.
 *  The room's own state decides first; only when it has nothing set does the space's count. */
export function artMode(room: unknown, space: unknown, prefs: { backgrounds: boolean; gameArt: boolean }): ArtMode {
  if (!prefs.backgrounds || !prefs.gameArt) return "off";
  // THE one parse rule (ambience parseBackground, 3-1): game art iff the background is unset or "game"; the room's own
  // state decides first, the space's only when the room has nothing set
  const kind = (c: unknown) => parseBackground(c ?? null).kind;
  const k = kind(room) === "unset" ? kind(space) : kind(room);
  return k === "unset" || k === "game" ? "game" : "off";
}
/** The fallback preset of a `kind: "game"` state (shown while nobody plays / art is missing), or null. */
export function fallbackPreset(content: unknown): string | null {
  if (nothingSet(content)) return null;
  const c = content as Record<string, unknown>;
  return c.v === 1 && c.kind === "game" && typeof c.preset === "string" && c.preset ? c.preset : null;
}
/** What the sheet writes for "Match the game": no preset under it (nobody playing = the room's usual look). */
export function gameBackgroundContent(): Record<string, unknown> {
  return { v: 1, kind: "game" };
}
/** The background sheet's "Match the game" (vectors "sheet"): nothing to write where game art already shows (the room
 *  asks for it, or nothing is set and art is showing); otherwise write the game kind. */
export function matchGamePlan(bgKind: string, artShowing: boolean): { plan: "skip" | "write"; content: Record<string, unknown> | null } {
  const skip = bgKind === "game" || (bgKind === "unset" && artShowing);
  return skip ? { plan: "skip", content: null } : { plan: "write", content: gameBackgroundContent() };
}
/** The art url of a catalogue id on the person's own server. */
export const backgroundUrl = (catalogBase: string, id: string): string => `${catalogBase}/art/${encodeURIComponent(id)}/background`;

// ---- drawing without upscaling -------------------------------------------------------------------------------------
export interface Fit {
  /** drawn size and offset in CSS px, inside the area */
  w: number;
  h: number;
  x: number;
  y: number;
  /** the art is shorter than the area: fade its bottom edge into the theme */
  fadeBottom: boolean;
  /** the art is narrower than the area: fade its sides */
  fadeSides: boolean;
}
/** Cover the area, top-anchored and centred, but never past 1 art pixel per device pixel (no visible
 *  upscaling): when covering would upscale, the art keeps its own size and fades into the theme at its edges. */
export function fitArt(artW: number, artH: number, areaW: number, areaH: number, dpr: number): Fit {
  if (!(artW > 0 && artH > 0 && areaW > 0 && areaH > 0)) return { w: 0, h: 0, x: 0, y: 0, fadeBottom: false, fadeSides: false };
  const d = dpr > 0 ? dpr : 1;
  const cover = Math.max(areaW / artW, areaH / artH);
  const s = Math.min(cover, 1 / d);
  const w = artW * s;
  const h = artH * s;
  return { w, h, x: (areaW - w) / 2, y: 0, fadeBottom: h < areaH - 0.5, fadeSides: w < areaW - 0.5 };
}
