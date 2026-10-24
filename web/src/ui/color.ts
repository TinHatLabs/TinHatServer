// color.ts — Qt's colour arithmetic, bit-for-bit, so derived tokens match the native pixels.
//
// QML's Qt.lighter / Qt.darker go through QColor::lighter/darker(int(factor*100)): HSV at 16-bit
// precision, V scaled by the factor (overflow drains saturation), converted back to RGB. The 8-bit
// channel the renderer uses is Qt 6's qt_div_257 of the 16-bit value — round to nearest (qtDiv257;
// PORT-QUESTIONS Q5). Qt.hsla / Qt.rgba / Qt.alpha are plain constructors. Pure functions, no DOM —
// node scripts import this file too (tools/), and the theme engine's lighter/darker are these.

export interface RGBA {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..1
}

const USHRT_MAX = 65535;

/**
 * Qt 6's `qt_div_257` (qdrawhelper_p.h, every Qt 6 release): a 16-bit channel (0..65535) → 8 bits rounded to nearest,
 * `qt_div_257_floor(x + 128)` = ⌊(x + 128) / 257⌋ = round(x / 257) (never a tie: 257 is odd) — what QColor::red() /
 * name() and the renderer give (measured on Qt 6.11.2 for all 65,536 values). Qt 5's `(x - (x >> 8) + 0x80) >> 8`,
 * used here until PORT-QUESTIONS Q5, rounds x = 257k + 128 (k < 128) up.
 */
export function qtDiv257(x: number): number {
  const y = x + 128;
  return (y - (y >> 8)) >> 8;
}

export function parseColor(c: string): RGBA {
  const s = c.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 3) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
    if (h.length === 6) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    // Qt's #AARRGGBB (alpha FIRST)
    if (h.length === 8) return { r: parseInt(h.slice(2, 4), 16), g: parseInt(h.slice(4, 6), 16), b: parseInt(h.slice(6, 8), 16), a: parseInt(h.slice(0, 2), 16) / 255 };
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  // the modern syntax the theme runtime uses for its float-alpha tokens (themeNames.ts cssColour)
  const n = s.match(/^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/i);
  if (n) return { r: +n[1], g: +n[2], b: +n[3], a: n[4] === undefined ? 1 : +n[4] };
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  throw new Error(`color: can't parse "${c}"`);
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** "#rrggbb" when opaque, else "rgba(r, g, b, a)" (CSS). */
export function formatColor(c: RGBA): string {
  if (c.a >= 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  const a = Math.round(c.a * 1000) / 1000;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}


// ---- QColor HSV (16-bit) ---------------------------------------------------------------------
interface HSV16 { h: number; s: number; v: number } // h = degrees*100 or USHRT_MAX (achromatic)

function toHsv16(c: RGBA): HSV16 {
  const r = (c.r * 257) / USHRT_MAX, g = (c.g * 257) / USHRT_MAX, b = (c.b * 257) / USHRT_MAX;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  const v = Math.round(max * USHRT_MAX);
  if (Math.abs(delta) < 1e-6) return { h: USHRT_MAX, s: 0, v };
  let hue: number;
  if (r === max) hue = (g - b) / delta;
  else if (g === max) hue = 2 + (b - r) / delta;
  else hue = 4 + (r - g) / delta;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { h: Math.round(hue * 100), s: Math.round((delta / max) * USHRT_MAX), v };
}

function fromHsv16(x: HSV16, a: number): RGBA {
  let R: number, G: number, B: number;
  if (x.s === 0 || x.h === USHRT_MAX) {
    R = G = B = x.v;
  } else {
    const h = x.h === 36000 ? 0 : x.h / 6000;
    const s = x.s / USHRT_MAX, v = x.v / USHRT_MAX;
    const i = Math.floor(h), f = h - i;
    const p = v * (1 - s);
    let rr: number, gg: number, bb: number;
    if (i & 1) {
      const q = v * (1 - s * f);
      if (i === 1) [rr, gg, bb] = [q, v, p];
      else if (i === 3) [rr, gg, bb] = [p, q, v];
      else [rr, gg, bb] = [v, p, q];
    } else {
      const t = v * (1 - s * (1 - f));
      if (i === 0) [rr, gg, bb] = [v, t, p];
      else if (i === 2) [rr, gg, bb] = [p, v, t];
      else [rr, gg, bb] = [t, p, v];
    }
    R = Math.round(rr * USHRT_MAX); G = Math.round(gg * USHRT_MAX); B = Math.round(bb * USHRT_MAX);
  }
  return { r: qtDiv257(R), g: qtDiv257(G), b: qtDiv257(B), a };
}

/** Qt.lighter(color, factor) — default factor 1.5 like QML. */
export function qtLighter(color: string, factor = 1.5): string {
  const f = Math.round(factor * 100);
  if (f <= 0) return color;
  if (f < 100) return qtDarkerInt(color, Math.trunc(10000 / f));
  return qtLighterInt(color, f);
}

/** Qt.darker(color, factor) — default factor 2.0 like QML. */
export function qtDarker(color: string, factor = 2.0): string {
  const f = Math.round(factor * 100);
  if (f <= 0) return color;
  if (f < 100) return qtLighterInt(color, Math.trunc(10000 / f));
  return qtDarkerInt(color, f);
}

function qtLighterInt(color: string, factor: number): string {
  const c = parseColor(color);
  const hsv = toHsv16(c);
  let s = hsv.s;
  let v = Math.trunc((factor * hsv.v) / 100);
  if (v > USHRT_MAX) {
    s -= v - USHRT_MAX;
    if (s < 0) s = 0;
    v = USHRT_MAX;
  }
  return formatColor(fromHsv16({ h: hsv.h, s, v }, c.a));
}

function qtDarkerInt(color: string, factor: number): string {
  const c = parseColor(color);
  const hsv = toHsv16(c);
  const v = Math.trunc((hsv.v * 100) / factor);
  return formatColor(fromHsv16({ h: hsv.h, s: hsv.s, v }, c.a));
}

/** Qt.alpha(color, a) — same colour, new alpha. */
export function qtAlpha(color: string, a: number): string {
  return formatColor({ ...parseColor(color), a });
}

/** Qt.rgba(r, g, b, a) with 0..1 channels. */
export function qtRgba(r: number, g: number, b: number, a = 1): string {
  return formatColor({ r: r * 255, g: g * 255, b: b * 255, a });
}

/** Qt.hsla(h, s, l, a) with 0..1 channels (QColor::fromHslF, 16-bit). */
export function qtHsla(h: number, s: number, l: number, a = 1): string {
  const H = Math.round(h * 36000) === 36000 ? 0 : Math.round(h * 36000) / 36000;
  const S = Math.round(s * USHRT_MAX) / USHRT_MAX;
  const L = Math.round(l * USHRT_MAX) / USHRT_MAX;
  if (S === 0) {
    const v = qtDiv257(Math.round(L * USHRT_MAX));
    return formatColor({ r: v, g: v, b: v, a });
  }
  const t2 = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const t1 = 2 * L - t2;
  const out: number[] = [];
  for (const t0 of [H + 1 / 3, H, H - 1 / 3]) {
    let t = t0;
    if (t < 0) t += 1;
    else if (t > 1) t -= 1;
    let x: number;
    if (t * 6 < 1) x = t1 + (t2 - t1) * t * 6;
    else if (t * 2 < 1) x = t2;
    else if (t * 3 < 2) x = t1 + (t2 - t1) * (2 / 3 - t) * 6;
    else x = t1;
    out.push(qtDiv257(Math.round(x * USHRT_MAX)));
  }
  return formatColor({ r: out[0], g: out[1], b: out[2], a });
}

/** Kirigami.ColorUtils.linearInterpolation(a, b, t) (separator colours etc.). */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a), y = parseColor(b);
  return formatColor({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t, a: x.a + (y.a - x.a) * t });
}

/** Composite `top` (with its alpha) over opaque `under` → opaque hex (what the screen shows). */
export function over(top: string, under: string): string {
  const t = parseColor(top), u = parseColor(under);
  return formatColor({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
}

/** HSL lightness 0..1 (QColor::hslLightnessF). */
export function hslLightness(color: string): number {
  const c = parseColor(color);
  const max = Math.max(c.r, c.g, c.b) / 255, min = Math.min(c.r, c.g, c.b) / 255;
  return (max + min) / 2;
}

// ---- KDE KHCY shading (kguiaddons KColorUtils::shade / KColorScheme::shade) -----------------
// The native app activates a generated KColorScheme (colorscheme.rs), so the Qt palette roles
// the app does NOT set itself (midlight, shadow) are KColorScheme shades of the Window
// background: the modal dim of every Controls.Dialog / Menu, the Basic Switch/Slider track.
const YC = [0.2126, 0.7152, 0.0722];
const norm = (a: number) => (a < 1 ? (a > 0 ? a : 0) : 1);
const gam = (n: number) => Math.pow(norm(n), 2.2);
const igam = (n: number) => Math.pow(norm(n), 1 / 2.2);
const wrap = (a: number, d = 1) => {
  const r = a % d;
  return r < 0 ? d + r : r > 0 ? r : 0;
};

interface HCY { h: number; c: number; y: number; a: number }

function toHcy(color: string): HCY {
  const k = parseColor(color);
  const r = gam(k.r / 255), g = gam(k.g / 255), b = gam(k.b / 255);
  const y = r * YC[0] + g * YC[1] + b * YC[2];
  const p = Math.max(r, g, b), n = Math.min(r, g, b);
  const d = 6 * (p - n);
  let h: number;
  if (n === p) h = 0;
  else if (r === p) h = (g - b) / d;
  else if (g === p) h = (b - r) / d + 1 / 3;
  else h = (r - g) / d + 2 / 3;
  const c = r === g && g === b ? 0 : Math.max((y - n) / y, (p - y) / (1 - y));
  return { h, c, y, a: k.a };
}

function fromHcy(x: HCY): string {
  const h = wrap(x.h), c = norm(x.c), y = norm(x.y);
  const hs = h * 6;
  let th: number, tm: number;
  if (hs < 1) { th = hs; tm = YC[0] + YC[1] * th; }
  else if (hs < 2) { th = 2 - hs; tm = YC[1] + YC[0] * th; }
  else if (hs < 3) { th = hs - 2; tm = YC[1] + YC[2] * th; }
  else if (hs < 4) { th = 4 - hs; tm = YC[2] + YC[1] * th; }
  else if (hs < 5) { th = hs - 4; tm = YC[2] + YC[0] * th; }
  else { th = 6 - hs; tm = YC[0] + YC[2] * th; }
  let tn: number, to: number, tp: number;
  if (tm >= y) {
    tp = y + (y * c * (1 - tm)) / tm;
    to = y + (y * c * (th - tm)) / tm;
    tn = y - y * c;
  } else {
    tp = y + (1 - y) * c;
    to = y + ((1 - y) * c * (th - tm)) / (1 - tm);
    tn = y - ((1 - y) * c * tm) / (1 - tm);
  }
  let rgb: number[];
  if (hs < 1) rgb = [tp, to, tn];
  else if (hs < 2) rgb = [to, tp, tn];
  else if (hs < 3) rgb = [tn, tp, to];
  else if (hs < 4) rgb = [tn, to, tp];
  else if (hs < 5) rgb = [to, tn, tp];
  else rgb = [tp, tn, to];
  return formatColor({ r: igam(rgb[0]) * 255, g: igam(rgb[1]) * 255, b: igam(rgb[2]) * 255, a: x.a });
}

/** KColorUtils::luma */
export function kdeLuma(color: string): number {
  return toHcy(color).y;
}

/** KColorUtils::shade(color, lumaAmount, chromaAmount) */
export function kdeShade(color: string, ky: number, kc = 0): string {
  const x = toHcy(color);
  return fromHcy({ ...x, y: norm(x.y + ky), c: norm(x.c + kc) });
}

/** KColorUtils::darken(color, amount, chromaGain) */
export function kdeDarken(color: string, ky: number, kc = 1): string {
  const x = toHcy(color);
  return fromHcy({ ...x, y: norm(x.y * (1 - ky)), c: norm(x.c * kc) });
}

export type KdeShadeRole = "light" | "midlight" | "mid" | "dark" | "shadow";

/** KColorScheme::shade(color, role, contrast = 0.7) — the palette's derived shades. */
export function kdeSchemeShade(color: string, role: KdeShadeRole, contrast = 0.7): string {
  const k = Math.max(-1, Math.min(1, contrast));
  const y = kdeLuma(color), yi = 1 - y;
  if (y < 0.006) {
    if (role === "light") return kdeShade(color, 0.05 + 0.95 * k);
    if (role === "mid") return kdeShade(color, 0.01 + 0.2 * k);
    if (role === "dark") return kdeShade(color, 0.02 + 0.4 * k);
    return kdeShade(color, 0.03 + 0.6 * k);
  }
  if (y > 0.93) {
    if (role === "midlight") return kdeShade(color, -0.02 - 0.2 * k);
    if (role === "dark") return kdeShade(color, -0.06 - 0.6 * k);
    if (role === "shadow") return kdeShade(color, -0.1 - 0.9 * k);
    return kdeShade(color, -0.04 - 0.4 * k);
  }
  const light = (0.05 + y * 0.55) * (0.25 + k * 0.75);
  const dark = -y * (0.55 + k * 0.35);
  if (role === "light") return kdeShade(color, light);
  if (role === "midlight") return kdeShade(color, (0.15 + 0.35 * yi) * light);
  if (role === "mid") return kdeShade(color, (0.35 + 0.15 * y) * dark);
  if (role === "dark") return kdeShade(color, dark);
  return kdeDarken(kdeShade(color, dark), 0.5 + 0.3 * y);
}
