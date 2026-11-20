// core.ts — shared chat backgrounds + particle effects ("ambience"): the pure rules both apps share, line for line.
// Desktop: crates/widgets/src/ambience.rs (same names in snake_case). Both replay testvectors/ambience/vectors.json
// (byte-identical copies in both repos). Design + privacy: docs/AMBIENCE.md.
//
//   state     the room state `dev.tinhat.chat.background` (key ""): {v: 1, preset, effect}; parseBackground / backgroundContent
//   who       canChangeBackground: the room's power levels (events[type] ?? state_default ?? 50) — moderators; both
//             people in a Tin Hat DM (trusted_private_chat makes both admins)
//   settings  effectsState: "run" | "paused" (keep the particles, stop the clock) | "off" (drop them)
//   looks     PRESETS × theme mode (light | dark | oled, themeMode from the timeline background) + scrimFor (text on the
//             background itself keeps ≥ 4.5:1)
//   sim       AmbienceSim: one deterministic simulation (seeded RNG, + − × ÷ √ floor only — no Math.sin / exp / pow — so
//             both languages compute the same bits) and its mesh: triangles with premultiplied per-vertex colour, never
//             inside a collider (a message bubble or a panel): nothing is ever drawn over or behind text.
//
// No DOM, no React, no imports.

export const BACKGROUND_STATE = "dev.tinhat.chat.background";

// ---- prefs (device prefs, "1" / "0"; same keys as the desktop's ui prefs) ----------------------------------------
export const PREF_BACKGROUNDS = "chat-backgrounds";
export const PREF_EFFECTS = "chat-effects";
export const PREF_PAUSE_UNFOCUSED = "chat-effects-pause-unfocused";
/** A stored switch: "1"/"true" on, "0"/"false" off, anything else (never touched) = the default. */
export function prefOn(raw: string | null | undefined, dflt: boolean): boolean {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return dflt;
}
export const PREF_DEFAULTS: Readonly<Record<string, boolean>> = {
  [PREF_BACKGROUNDS]: true,
  [PREF_EFFECTS]: true,
  [PREF_PAUSE_UNFOCUSED]: true,
};

// ---- presets ---------------------------------------------------------------------------------------------------
export type Effect = "rain" | "embers" | "snow" | "fireflies" | "none";
export const EFFECTS: readonly Effect[] = ["rain", "embers", "snow", "fireflies", "none"];
export const EFFECT_NAMES: Readonly<Record<Effect, string>> = { rain: "Rain", embers: "Embers", snow: "Snow", fireflies: "Fireflies", none: "None" };
export type Mode = "light" | "dark" | "oled";
export interface Glow {
  /** centre as a fraction of the view (y may sit just outside: a glow from below / above) */
  x: number;
  y: number;
  /** radii as fractions of the view's width / height */
  rx: number;
  ry: number;
  color: string;
  /** the glow's opacity at its centre (it fades linearly to 0 at the radii) */
  a: number;
}
export interface Look {
  /** a vertical gradient, top (0) to bottom (1) */
  stops: ReadonlyArray<readonly [number, string]>;
  glow: Glow;
}
export interface Preset {
  id: string;
  name: string;
  effect: Effect;
  dark: Look;
  oled: Look;
  light: Look;
}
const L = (s: Array<[number, string]>, x: number, y: number, rx: number, ry: number, color: string, a: number): Look => ({ stops: s, glow: { x, y, rx, ry, color, a } });
export const PRESETS: readonly Preset[] = [
  {
    id: "rain",
    name: "Rainy evening",
    effect: "rain",
    dark: L([[0, "#141b26"], [0.65, "#1a2230"], [1, "#232a35"]], 0.35, 1.02, 0.7, 0.35, "#c08a4a", 0.18),
    oled: L([[0, "#000000"], [0.6, "#000000"], [1, "#05070b"]], 0.35, 1.05, 0.6, 0.3, "#8a6234", 0.16),
    light: L([[0, "#f4f7fa"], [0.65, "#eef2f7"], [1, "#e8eef5"]], 0.35, 1.02, 0.7, 0.35, "#f6dcb8", 0.4),
  },
  {
    id: "hearth",
    name: "Hearth",
    effect: "embers",
    dark: L([[0, "#1a1210"], [0.6, "#221611"], [1, "#2e1a10"]], 0.5, 1.08, 0.8, 0.4, "#d2601e", 0.3),
    oled: L([[0, "#000000"], [0.6, "#000000"], [1, "#0c0503"]], 0.5, 1.08, 0.8, 0.4, "#b44a12", 0.22),
    light: L([[0, "#fbf8f5"], [0.6, "#faf4ee"], [1, "#f8eee6"]], 0.5, 1.08, 0.8, 0.4, "#f8d6b8", 0.3),
  },
  {
    id: "snow",
    name: "First snow",
    effect: "snow",
    dark: L([[0, "#18202a"], [0.6, "#1f2934"], [1, "#2a3440"]], 0.6, -0.05, 0.8, 0.4, "#9fb6cc", 0.14),
    oled: L([[0, "#000000"], [0.6, "#030507"], [1, "#070a0e"]], 0.6, -0.05, 0.8, 0.4, "#6a7f94", 0.12),
    light: L([[0, "#f6f8fb"], [0.6, "#f0f4f8"], [1, "#eaf0f6"]], 0.6, -0.05, 0.8, 0.4, "#ffffff", 0.6),
  },
  {
    id: "summer",
    name: "Summer night",
    effect: "fireflies",
    dark: L([[0, "#0f1a17"], [0.6, "#13221d"], [1, "#182a22"]], 0.8, -0.05, 0.5, 0.35, "#a7c4a0", 0.1),
    oled: L([[0, "#000000"], [0.6, "#000000"], [1, "#03100a"]], 0.8, -0.05, 0.5, 0.35, "#5c7a58", 0.1),
    light: L([[0, "#f4f8f3"], [0.6, "#eef5ee"], [1, "#e8f1e8"]], 0.8, -0.05, 0.5, 0.35, "#fff8e0", 0.5),
  },
  {
    id: "dusk",
    name: "Dusk",
    effect: "none",
    dark: L([[0, "#1b1626"], [0.6, "#251a2c"], [1, "#3a2028"]], 0.5, 1.05, 1, 0.35, "#d0704a", 0.22),
    oled: L([[0, "#000000"], [0.6, "#05030a"], [1, "#120608"]], 0.5, 1.05, 1, 0.35, "#9a4a30", 0.16),
    light: L([[0, "#f7f4fa"], [0.6, "#f8f1f4"], [1, "#faede6"]], 0.5, 1.05, 1, 0.35, "#f9d4bf", 0.4),
  },
  {
    id: "deep",
    name: "Deep water",
    effect: "none",
    dark: L([[0, "#0d1826"], [0.6, "#0f2030"], [1, "#10303a"]], 0.3, 1.05, 0.8, 0.4, "#2a7a8a", 0.16),
    oled: L([[0, "#000000"], [0.6, "#00040a"], [1, "#001014"]], 0.3, 1.05, 0.8, 0.4, "#13505a", 0.14),
    light: L([[0, "#f3f8fb"], [0.6, "#edf5f8"], [1, "#e5f1f4"]], 0.3, 1.05, 0.8, 0.4, "#cfeaf0", 0.45),
  },
];
export function presetById(id: string): Preset | null {
  for (const p of PRESETS) if (p.id === id) return p;
  return null;
}

// ---- the state event --------------------------------------------------------------------------------------------
/** What a room's background is:
 *    unset   no state (absent, or emptied `{}`): nothing chosen — a later kind (game art) may show by itself
 *    none    the room chose the plain theme: nothing shows, not even game art
 *    preset  a built-in scene (no upload at all)
 *    image   a member's own image: a normal (encrypted) m.image chat message, referenced by event id; `preset` is the
 *            fallback for anyone who can't show it (no key, joined later, redacted, someone else's image)
 *    game    the game being played (game art; this build only parses it): `preset` is the fallback */
export type BackgroundKind = "unset" | "none" | "preset" | "image" | "game";
export interface Background {
  kind: BackgroundKind;
  /** the scene to draw: the preset itself, or the fallback of image / game; null = the plain theme */
  preset: string | null;
  /** the effect to run ("none" when there is no scene) */
  effect: Effect;
  /** kind "image": the image message's event id */
  image: string | null;
  /** who set it (the state event's sender; image: must be the image's sender) */
  by: string;
}
export const NO_BACKGROUND: Background = { kind: "unset", preset: null, effect: "none", image: null, by: "" };
const PLAIN: Background = { kind: "none", preset: null, effect: "none", image: null, by: "" };
function isEffect(v: unknown): v is Effect {
  return typeof v === "string" && (EFFECTS as readonly string[]).includes(v);
}
/** An event id as Matrix writes it ($ + 1..255 printable non-space characters). */
export function isEventId(v: unknown): v is string {
  return typeof v === "string" && /^\$[^\s]{1,255}$/.test(v);
}
/** The room's background from the state content (absent = null/undefined) and its sender. Never throws: anything
 *  unknown degrades to what can still be shown (a kind from a newer app shows its preset; nothing valid = the plain
 *  theme). */
export function parseBackground(content: unknown, sender = ""): Background {
  if (content === null || content === undefined) return NO_BACKGROUND;
  if (typeof content !== "object" || Array.isArray(content)) return { ...PLAIN, by: sender };
  const c = content as Record<string, unknown>;
  if (Object.keys(c).length === 0) return NO_BACKGROUND;
  if (c.v !== 1) return { ...PLAIN, by: sender };
  if (c.kind === "none") return { ...PLAIN, by: sender };
  if (c.kind === "game") {
    // "Match the game" is its own kind (3-1): the preset is only a fallback scene and may be absent; reading it as
    // plain made "None" a no-op while the game art kept showing
    const gp = typeof c.preset === "string" ? presetById(c.preset) : null;
    return { kind: "game", preset: gp ? gp.id : null, effect: isEffect(c.effect) ? c.effect : gp ? gp.effect : "none", image: null, by: sender };
  }
  const p = typeof c.preset === "string" ? presetById(c.preset) : null;
  if (!p) return { ...PLAIN, by: sender };
  const effect = isEffect(c.effect) ? c.effect : p.effect;
  const img = c.image && typeof c.image === "object" && !Array.isArray(c.image) ? (c.image as Record<string, unknown>).event_id : undefined;
  if (c.kind === "image" || (c.kind === undefined && img !== undefined)) {
    // a broken reference still shows the fallback scene
    return isEventId(img) ? { kind: "image", preset: p.id, effect, image: img, by: sender } : { kind: "preset", preset: p.id, effect, image: null, by: sender };
  }
  // "preset", absent, or a kind from a newer app: the preset
  return { kind: "preset", preset: p.id, effect, image: null, by: sender };
}
/** What the picker writes: kind "none" = plain on purpose; a preset; or an image (with its preset fallback). */
export function backgroundContent(kind: "none" | "preset" | "image", preset: string | null, effect: Effect | null, image: string | null = null): Record<string, unknown> {
  if (kind === "none") return { v: 1, kind: "none" };
  const p = preset ? presetById(preset) : null;
  const fallback = p ?? PRESETS[0];
  const eff = effect && isEffect(effect) ? effect : fallback.effect;
  if (kind === "image") {
    if (!isEventId(image)) return { v: 1, kind: "none" };
    return { v: 1, kind: "image", preset: fallback.id, effect: eff, image: { event_id: image } };
  }
  if (!p) return { v: 1, kind: "none" };
  return { v: 1, kind: "preset", preset: p.id, effect: eff };
}
/** What the picker's Apply does with a choice:
 *    skip     nothing changed: write nothing (Apply just closes)
 *    blocked  keeping an image that someone ELSE posted: writing it under my name would make imageShown refuse it for
 *             everyone — pick a scene or post your own image instead
 *    write    write backgroundContent(…) */
export interface SheetChoice {
  kind: "none" | "preset" | "image";
  /** the scene, or the image's fallback scene */
  preset: string | null;
  /** null = the scene's own */
  effect: Effect | null;
  /** a newly picked image is posted first (then it is mine) */
  newImage: boolean;
}
export function applyPlan(bg: Background, c: SheetChoice, me: string): "skip" | "blocked" | "write" {
  if (!c.newImage) {
    const p = c.preset ? presetById(c.preset) : null;
    const eff = c.effect ?? (p ? p.effect : "none");
    if (c.kind === "none" && bg.kind === "none") return "skip";
    if (c.kind === "preset" && bg.kind === "preset" && bg.preset === c.preset && bg.effect === eff) return "skip";
    if (c.kind === "image" && bg.kind === "image" && bg.preset === c.preset && bg.effect === eff) return "skip";
    if (c.kind === "image" && (bg.kind !== "image" || !bg.image || bg.by !== me || me === "")) return "blocked";
  }
  return "write";
}
// ---- the ☰ Particles menu (round 4, P-A7): the same rows in both apps (desktop ambience.rs particles_menu) ----------
/** The effect a background shows (nothing chosen / plain = "none"). */
export function shownEffect(bg: Background): Effect {
  return bg.kind === "unset" || bg.kind === "none" ? "none" : bg.effect;
}
/** Picking an effect with no scene yet (nothing chosen, plain, or game art) sets the matching scene. */
export const SCENE_FOR: Readonly<Record<Exclude<Effect, "none">, string>> = { rain: "rain", embers: "hearth", snow: "snow", fireflies: "summer" };
/** What picking an effect in the ☰ Particles menu does: the Chat background sheet's own write (applyPlan +
 *  backgroundContent) with only the effect changed. A scene's own effect is written as null ("the background's own"),
 *  like the sheet's first Effect row. */
export function particlesPick(bg: Background, e: Effect, me: string): { plan: "skip" | "blocked" | "write"; content: Record<string, unknown> | null } {
  if (shownEffect(bg) === e) return { plan: "skip", content: null };
  if (bg.kind === "preset" || bg.kind === "image") {
    const own = bg.preset ? presetById(bg.preset)?.effect ?? null : null;
    const effect = e === own ? null : e;
    const c: SheetChoice = { kind: bg.kind, preset: bg.preset, effect, newImage: false };
    const plan = applyPlan(bg, c, me);
    return { plan, content: plan === "write" ? backgroundContent(bg.kind, bg.preset, effect, bg.image) : null };
  }
  // game art with an effect: "None" keeps the art and drops the effect = the sheet's own "Match the game" write
  if (e === "none") return bg.kind === "game" ? { plan: "write", content: { v: 1, kind: "game" } } : { plan: "skip", content: null };
  // nothing chosen, plain or game art: the matching scene
  return { plan: "write", content: backgroundContent("preset", SCENE_FOR[e], null) };
}
export interface ParticlesMenuIn {
  /** a room is open (the home view: only the personal rows) */
  room: boolean;
  bg: Background;
  /** canChangeBackground for this room and person */
  canChange: boolean;
  me: string;
  /** Settings → Appearance → Performance, the same stored prefs (prefOn with PREF_DEFAULTS) */
  backgrounds: boolean;
  effects: boolean;
  pauseUnfocused: boolean;
  saver: boolean;
}
/** A row: id = effect:<e> | background | effects | pause | settings | note:<word key> (a disabled line); checked null =
 *  not a checkable row. */
export interface ParticlesRow {
  id: string;
  checked: boolean | null;
  enabled: boolean;
  sep: boolean;
}
export function particlesMenu(p: ParticlesMenuIn): ParticlesRow[] {
  const rows: ParticlesRow[] = [];
  if (p.room) {
    const shown = shownEffect(p.bg);
    let other = false;
    for (const e of EFFECTS) {
      const plan = particlesPick(p.bg, e, p.me).plan;
      if (plan === "blocked") other = true;
      rows.push({ id: `effect:${e}`, checked: shown === e, enabled: p.canChange && plan !== "blocked" && !(plan === "skip" && shown !== e), sep: false });
    }
    if (!p.canChange) rows.push({ id: "note:readOnly", checked: null, enabled: false, sep: false });
    else if (other) rows.push({ id: "note:otherImage", checked: null, enabled: false, sep: false });
    rows.push({ id: "background", checked: null, enabled: true, sep: false });
  }
  rows.push({ id: "effects", checked: p.backgrounds && p.effects, enabled: p.backgrounds, sep: p.room });
  if (!p.backgrounds) rows.push({ id: "note:offHere", checked: null, enabled: false, sep: false });
  const pr = pauseRow(p.pauseUnfocused, p.saver);
  rows.push({ id: "pause", checked: pr.checked, enabled: pr.enabled, sep: false });
  if (!pr.enabled) rows.push({ id: "note:pauseSaver", checked: null, enabled: false, sep: false });
  rows.push({ id: "settings", checked: null, enabled: true, sep: false });
  return rows;
}

/** What a ☰ Particles effect pick writes RIGHT NOW (both apps run every pick through this): null = NOTHING is sent (no
 *  room, not allowed to change the background, the row is greyed, or nothing would change). */
export function particlesWrite(p: ParticlesMenuIn, e: Effect): Record<string, unknown> | null {
  const row = particlesMenu(p).find((r) => r.id === `effect:${e}`);
  if (!p.room || !p.canChange || !row || !row.enabled) return null;
  const pick = particlesPick(p.bg, e, p.me);
  return pick.plan === "write" ? pick.content : null;
}

/** What an image background's message turned out to be, as the viewer's app sees it: null = not fetchable here
 *  (history visibility, gone). `decrypted` = the image itself decrypted on this device (false: no key yet). */
export interface ImageEvent {
  type: string;
  sender: string;
  room: string;
  msgtype: string;
  redacted: boolean;
  decrypted: boolean;
}
/** Show the custom image? Only the setter's OWN image message in THIS room, not redacted, that this device could
 *  decrypt. Anything else shows the preset fallback — never a broken tile. */
export function imageShown(bg: Background, room: string, ev: ImageEvent | null): boolean {
  if (bg.kind !== "image" || !bg.image || !ev) return false;
  return ev.type === "m.room.message" && ev.msgtype === "m.image" && ev.room === room && !ev.redacted && ev.decrypted && ev.sender === bg.by && bg.by !== "";
}
/** Custom image limits: re-encoded as JPEG (no metadata can survive), ≤ 2560 px on the long side, ≤ 1.5 MB. */
export const IMAGE_MAX_SIDE = 2560;
/** What "Your own image…" offers (12.1.17): every picture format the image is re-encoded from, HEIC / HEIF too (an
 *  iPhone camera's format: the 12.1.16 list left them out, so the Files picker greyed them out without a word). A
 *  picked picture this device can't decode gets AMBIENCE_WORDS.customFormat, never a silent nothing. The desktop's
 *  file dialog filters by the same extensions (image_pick_exts). */
export const IMAGE_PICK_EXTS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif"];
/** The web picker's accept list for those (MIME types: iOS Photos then hands over the picture as is or converted). */
export const IMAGE_PICK_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic,image/heif";
export const IMAGE_MAX_BYTES = 1_500_000;
/** JPEG qualities tried in turn; after the last, the image is scaled by IMAGE_SHRINK and the ladder starts again. */
export const IMAGE_QUALITIES: readonly number[] = [0.85, 0.75, 0.65];
export const IMAGE_SHRINK = 0.8;
/** The size an image is first re-encoded at (the long side capped, aspect kept, whole pixels, ≥ 1). */
/** An image's pixel size from its HEADER alone (3-6): read before anything decodes it, so a hostile 30000 × 30000
 *  picture is turned away without allocating its pixels. PNG, JPEG, GIF, WebP (VP8 / VP8L / VP8X) and BMP; any other
 *  format, or a header that doesn't say, → null (the caller shows the preset and never decodes it). */
export function imageDims(b: Uint8Array): { w: number; h: number } | null {
  const n = b.length;
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const be32 = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const ascii = (i: number, s: string) => n >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : null);
  // PNG: the signature, then IHDR first
  if (n >= 24 && b[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n") && ascii(12, "IHDR")) return ok(be32(16), be32(20));
  // GIF: the logical screen AND the first frame (what createImageBitmap decodes; a decoder may grow to a frame larger
  // than the screen), so walk past the colour table and the extensions to the first image descriptor
  if (n >= 13 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) {
    let i = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0);
    while (i < n) {
      if (b[i] === 0x21) {
        i += 2; // the extension's introducer + label, then its sub-blocks up to the empty one
        while (i < n && b[i] !== 0) i += b[i] + 1;
        i++;
        continue;
      }
      if (b[i] === 0x2c && i + 9 <= n) return ok(Math.max(le16(6), le16(i + 1) + le16(i + 5)), Math.max(le16(8), le16(i + 3) + le16(i + 7)));
      return null; // the trailer before any frame, or not a GIF block
    }
    return null;
  }
  // WebP
  if (n >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (ascii(12, "VP8L") && b[20] === 0x2f) {
      const v = le32(21);
      return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, "VP8X")) return ok((b[24] | (b[25] << 8) | (b[26] << 16)) + 1, (b[27] | (b[28] << 8) | (b[29] << 16)) + 1);
    return null;
  }
  // BMP: BITMAPCOREHEADER (16-bit sizes) or a later header (32-bit; a negative height = top-down)
  if (n >= 26 && ascii(0, "BM")) {
    if (le32(14) === 12) return ok(le16(18), le16(20));
    return ok(Math.abs(le32(18) | 0), Math.abs(le32(22) | 0));
  }
  // JPEG: walk the segments to the first frame header (SOF0–SOF15 but DHT C4, JPG C8, DAC CC)
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < n) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) {
        i++; // fill byte
        continue;
      }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2; // a marker with no length
        continue;
      }
      if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan before any frame header
      const len = be16(i + 2);
      if (len < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 8 < n ? ok(be16(i + 7), be16(i + 5)) : null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

export function fitImage(w: number, h: number, maxSide = IMAGE_MAX_SIDE): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// ---- who can change it --------------------------------------------------------------------------------------------
function plNum(v: unknown, dflt: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?[0-9]+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return dflt;
}
/** The power level a member needs to set the background: events[type] ?? state_default ?? 50. */
export function backgroundLevel(pl: unknown): number {
  const c = pl && typeof pl === "object" ? (pl as Record<string, unknown>) : {};
  const ev = c.events && typeof c.events === "object" ? (c.events as Record<string, unknown>) : {};
  return plNum(ev[BACKGROUND_STATE], plNum(c.state_default, 50));
}
/** Can `user` change the room's background? `creator` = the user is a room-v12 creator (unlimited power). No power
 *  levels event at all → only a creator (Matrix: the creator has 100 then; the apps pass creator = true for them). */
export function canChangeBackground(pl: unknown, user: string, creator: boolean): boolean {
  if (creator) return true;
  if (!pl || typeof pl !== "object") return false;
  const c = pl as Record<string, unknown>;
  const users = c.users && typeof c.users === "object" ? (c.users as Record<string, unknown>) : {};
  const mine = plNum(users[user], plNum(c.users_default, 0));
  return mine >= backgroundLevel(pl);
}

// ---- when effects run ---------------------------------------------------------------------------------------------
export type WinState = "focused" | "unfocused" | "hidden";
/** What the page / window can tell about itself. Web: `document.hidden` + the Tin Hat phone apps' bridge
 *  (Android `tinhatNative.appState()` → {visible, focused}; iOS `tinhatNative.covered()` = the native call screen hides
 *  the page; today's iOS app and older Android apps: document.hasFocus() can be false until the first tap, so a phone
 *  app counts as focused while visible). Desktop: the window's visibility + active state (the shell fields stay null / false). */
export interface LiveIn {
  hidden: boolean;
  /** Android appState().visible (null = no such bridge) */
  appVisible: boolean | null;
  /** iOS covered() (null = no such bridge) */
  covered: boolean | null;
  /** Android appState().focused (null = no such bridge) */
  appFocused: boolean | null;
  /** the page runs in a Tin Hat PHONE app (iOS or Android): its web view's hasFocus() can be false while it is plainly
   *  in front (iOS until the first tap; older Android apps), so without a native focus report visible = focused (3-4) */
  phoneShell: boolean;
  /** document.hasFocus() / the window is active */
  hasFocus: boolean;
  /** the phone app's NATIVE call is on (native/callState: connecting, in the call or leaving); false elsewhere */
  nativeCall: boolean;
}
/** The REAL window state the effects follow (one rule for both apps and every shell). */
export function liveWinState(p: LiveIn): WinState {
  if (p.hidden || p.appVisible === false || p.covered === true) return "hidden";
  // 3-3: an app that reports neither covered() nor appState() (today's iOS app) can't say when its native call screen
  // hides the page, so a native call counts as covering it for as long as the call is on
  if (p.covered === null && p.appVisible === null && p.nativeCall) return "hidden";
  const focused = p.appFocused !== null ? p.appFocused : p.phoneShell ? true : p.hasFocus;
  return focused ? "focused" : "unfocused";
}
export interface EffectsIn {
  /** Show chat backgrounds */
  backgrounds: boolean;
  /** Particle effects (the master switch) */
  effects: boolean;
  /** Pause effects when Tin Hat isn't focused (default ON) */
  pauseUnfocused: boolean;
  /** Save GPU while Tin Hat isn't focused: effects ALWAYS pause while unfocused, whatever pauseUnfocused says */
  saver: boolean;
  /** Reduce motion (the app's pref OR the OS setting): effects off */
  reduced: boolean;
  /** liveWinState */
  win: WinState;
  /** a GPU renderer draws the app (desktop: not Qt's software renderer; web: WebGL2 is there) */
  gpu: boolean;
  /** the room background's effect */
  effect: Effect;
}
export type EffectsState = "run" | "paused" | "off";
/** "off" drops the particles; "paused" keeps them and stops the clock (nothing is drawn again until it runs);
 *  "run" steps and draws. Hidden / minimised ALWAYS pauses (nobody sees it). */
export function effectsState(p: EffectsIn): EffectsState {
  if (!p.backgrounds || !p.effects || p.reduced || !p.gpu || p.effect === "none") return "off";
  if (p.win === "hidden") return "paused";
  if (p.win === "unfocused" && (p.pauseUnfocused || p.saver)) return "paused";
  return "run";
}
/** The "Pause effects when Tin Hat isn't focused" row as Settings shows it: Save GPU on → shown on and greyed. */
export function pauseRow(pauseUnfocused: boolean, saver: boolean): { checked: boolean; enabled: boolean } {
  return saver ? { checked: true, enabled: false } : { checked: pauseUnfocused, enabled: true };
}

// ---- colour maths ------------------------------------------------------------------------------------------------
export type Rgb = readonly [number, number, number];
/** "#rrggbb" (or "#rgb", or "#aarrggbb" — alpha ignored) → 0..1 channels; anything else → null. */
export function parseHex(s: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 8) h = h.slice(2);
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}
function lin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
/** WCAG contrast ratio (1..21). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** The theme's mode from its timeline background: near-black = oled, dark, else light. */
export function themeMode(timelineBg: string): Mode {
  const c = parseHex(timelineBg);
  if (!c) return "dark";
  const l = luminance(c);
  if (l <= 0.0025) return "oled";
  return l < 0.3 ? "dark" : "light";
}
export function lookFor(preset: Preset, mode: Mode): Look {
  return mode === "light" ? preset.light : mode === "oled" ? preset.oled : preset.dark;
}
export const MIN_CONTRAST = 4.5;
export const SCRIM_STEP = 0.05;
export const SCRIM_MAX = 1;
/** Text that is already below 4.5:1 on the theme's own background (some people's name colours) may lose at most
 *  this much on a chat background. */
export const SUB_AA_SLACK = 0.1;
/** A box of colours: per channel the lowest and the highest value of a region (a stretch of the gradient, the glow, a
 *  patch of an image). Blending toward the theme background is increasing in every channel and so is luminance, so the
 *  region's blended luminances fill exactly [lum(blend(lo)), lum(blend(hi))] — a true bound, not a sample. */
export type Cell = readonly [Rgb, Rgb];
function cellOf(cols: readonly Rgb[]): Cell {
  const lo: [number, number, number] = [1, 1, 1];
  const hi: [number, number, number] = [0, 0, 0];
  for (const c of cols)
    for (let k = 0; k < 3; k++) {
      if (c[k] < lo[k]) lo[k] = c[k];
      if (c[k] > hi[k]) hi[k] = c[k];
    }
  return [lo, hi];
}
/** The cells of a look: each stretch between two stops (plus the glow over it, where the glow reaches). */
export function lookCells(look: Look): Cell[] {
  const g = parseHex(look.glow.color);
  const out: Cell[] = [];
  const s = look.stops;
  for (let i = 0; i + 1 < s.length; i++) {
    const a = parseHex(s[i][1]);
    const b = parseHex(s[i + 1][1]);
    if (!a || !b) continue;
    const cols: Rgb[] = [a, b];
    const reach = look.glow.ry;
    const y0 = s[i][0];
    const y1 = s[i + 1][0];
    if (g && look.glow.a > 0 && y1 >= look.glow.y - reach && y0 <= look.glow.y + reach) cols.push(mix(a, g, look.glow.a), mix(b, g, look.glow.a));
    out.push(cellOf(cols));
  }
  return out;
}
/** What each text colour must keep: 4.5:1 when it reaches that on the theme's background, else its own level minus
 *  SUB_AA_SLACK. */
export function contrastTarget(fg: Rgb, bg: Rgb): number {
  const c = contrast(fg, bg);
  return c >= MIN_CONTRAST ? MIN_CONTRAST : c - SUB_AA_SLACK;
}
/** The worst contrast a text colour can meet over a cell veiled with `a` of the theme background. */
export function cellWorst(fg: Rgb, cell: Cell, bg: Rgb, a: number): number {
  const m0 = mix(cell[0], bg, a);
  const m1 = mix(cell[1], bg, a);
  const lt = luminance(fg);
  if (lt >= luminance(m0) && lt <= luminance(m1)) return 1;
  return Math.min(contrast(fg, m0), contrast(fg, m1));
}
/** The theme-coloured veil laid over a background so that every text colour drawn straight on it (`fgs`: the
 *  timeline's own text and the name colours in view) keeps its target (contrastTarget) over every cell: the smallest
 *  multiple of 0.05 that does. 1 (the plain theme) always does, so the promise has no exceptions. */
export function scrimForCells(cells: readonly Cell[], timelineBg: string, fgs: readonly string[]): number {
  const bg = parseHex(timelineBg);
  if (!bg) return 0;
  const texts: Array<[Rgb, number]> = [];
  for (const f of fgs) {
    const c = parseHex(f);
    if (c) texts.push([c, contrastTarget(c, bg)]);
  }
  for (let k = 0; k * SCRIM_STEP <= SCRIM_MAX + 1e-9; k++) {
    const a = Math.round(k * SCRIM_STEP * 100) / 100;
    let ok = true;
    for (const cell of cells) for (const [t, want] of texts) if (cellWorst(t, cell, bg, a) < want) ok = false;
    if (ok) return a;
  }
  return SCRIM_MAX;
}
export function scrimFor(look: Look, timelineBg: string, fgs: readonly string[]): number {
  return scrimForCells(lookCells(look), timelineBg, fgs);
}
/** An image's cells from its pixels (RGBA bytes, `w` × `h`): a `grid` × `grid` split, each cell the box of its pixels. */
export function imageCells(px: ArrayLike<number>, w: number, h: number, grid = 8): Cell[] {
  const out: Cell[] = [];
  for (let gy = 0; gy < grid; gy++)
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * w) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / grid));
      const y0 = Math.floor((gy * h) / grid);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / grid));
      const lo: [number, number, number] = [1, 1, 1];
      const hi: [number, number, number] = [0, 0, 0];
      for (let y = y0; y < y1 && y < h; y++)
        for (let x = x0; x < x1 && x < w; x++) {
          const o = (y * w + x) * 4;
          for (let k = 0; k < 3; k++) {
            const v = px[o + k] / 255;
            if (v < lo[k]) lo[k] = v;
            if (v > hi[k]) hi[k] = v;
          }
        }
      if (lo[0] <= hi[0]) out.push([lo, hi]);
    }
  return out;
}

// ---- deterministic maths -----------------------------------------------------------------------------------------
/** mulberry32 — u32 state, the same bits in both languages. */
export class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}
const PI = 3.141592653589793;
const TAU = 6.283185307179586;
/** sin without Math.sin: range-reduced to [-π, π], folded to [-π/2, π/2], an odd polynomial to x^11 (|err| < 6e-8). */
export function fsin(x: number): number {
  let r = x - TAU * Math.floor((x + PI) / TAU);
  if (r > PI / 2) r = PI - r;
  else if (r < -PI / 2) r = -PI - r;
  const r2 = r * r;
  return r * (1 + r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800))))));
}
function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

// ---- the simulation -----------------------------------------------------------------------------------------------
export interface Collider {
  /** stable id ending in ":<kind>" (the row's key + SURFACE_KINDS, e.g. "$ev:b"): pools / snow lines follow it while it
   *  moves; an id without a card kind is no surface (setColliders drops it) */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** the top-left / top-right corner radii (a bubble's rounded top): pools and snow follow the curve there */
  rl?: number;
  rr?: number;
}
/** What particles may settle on: the visible message cards only. A collider's id ends in ":<kind>" with kind b (a
 *  message bubble), n (a sender name), d (a day pill) or r (a message's reaction chips, their own rect). Never a
 *  container, a divider or a whole row: 12.1.17, the web's NEW line (a full-width 18 px box whose only ink is a 1 px
 *  rule) caught the phone's rain on an invisible line and kept it off every card below. Shared rule:
 *  testvectors/ambience/surfaces.json (the desktop's surface_kind). */
export const SURFACE_KINDS: readonly string[] = ["b", "n", "d", "r"];
/** The card kind an id ends in (after its last ":"), or null: not a surface. */
export function surfaceKind(id: string): string | null {
  const i = id.lastIndexOf(":");
  if (i < 0) return null;
  const k = id.slice(i + 1);
  return SURFACE_KINDS.includes(k) ? k : null;
}
/** The y of a collider's top edge at x (its rounded corners curve down; square = c.y). */
export function topAt(c: Collider, x: number): number {
  const rl = Math.min(c.rl ?? 0, c.w / 2, c.h);
  const rr = Math.min(c.rr ?? 0, c.w / 2, c.h);
  if (rl > 0 && x < c.x + rl) {
    const d = Math.min(rl, c.x + rl - x);
    return c.y + rl - Math.sqrt(Math.max(0, rl * rl - d * d));
  }
  if (rr > 0 && x > c.x + c.w - rr) {
    const d = Math.min(rr, x - (c.x + c.w - rr));
    return c.y + rr - Math.sqrt(Math.max(0, rr * rr - d * d));
  }
  return c.y;
}
/** Is (x, y) inside the collider's shape (the rect minus the air of its rounded top corners)? */
export function insideShape(c: Collider, x: number, y: number): boolean {
  return x > c.x && x < c.x + c.w && y < c.y + c.h && y > topAt(c, x);
}
/** A moving piece: k = 0 rain, 1 splash, 2 drip (falling), 3 runner (down a side), 4 ember, 5 spark, 6 flake, 7 firefly. */
export interface Particle {
  k: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  seed: number;
  /** runner: the collider id it runs down; ember: the collider it slides under ("" = none) */
  on: string;
  /** runner / sliding ember: -1 left side, +1 right side */
  dir: number;
}
export interface Ledge {
  /** column heights in px (rain: water depth; snow: snow depth) */
  h: number[];
  /** water waiting at the left / right end (rain) */
  endL: number;
  endR: number;
}
/** Fixed simulation step (s); a frame runs as many steps as its time covers (≤ MAX_STEPS). */
export const STEP = 1 / 60;
export const MAX_STEPS = 6;
/** Frames per second the hosts draw at, per effect: 30 for all (half the cost of 60; rain draws streaks as long as a
 *  frame's fall, so it stays smooth). */
export const EFFECT_FPS: Readonly<Record<Effect, number>> = { rain: 30, embers: 30, snow: 30, fireflies: 30, none: 0 };
/** Pool / snow-line column width. */
export const COL_W = 6;
/** The deepest a pool or snow line gets (px): small, below any text. */
export const LEDGE_MAX = 3;
export const PARTICLE_CAP = 400;
/** Spawn rates — SUBTLE ("not quite as many particles as in the game"): rain drops/s per px of width (+200),
 *  embers and snowflakes per px of width, fireflies per million px² of view. A full game scene, for comparison: rain
 *  0.0908 × (W + 500)/s (steady rain), embers 85/s on a 1600 px view (0.053 per px). */
export const RATE: Readonly<Record<"rain" | "embers" | "snow" | "fireflies", number>> = { rain: 0.02, embers: 0.006, snow: 0.003, fireflies: 8 };
/** Seconds simulated at once when an effect starts (AmbienceSim.warm). */
export const WARM_S = 6;
/** Rain: what one drop adds to a pool (px of depth over one column), how fast a pool runs to its ends (px/s), and how
 *  much gathers at an end before it lets go down the side (px²). Tuned for "not too numerous": a wide bubble in full
 *  rain drips from each corner about every two seconds. */
export const RAIN_MASS = 0.6;
export const POOL_SPEED = 14;
/** Snow: what one flake (per px of its size) adds to the line it lands on. */
export const SNOW_MASS = 0.6;
export const RUNNER_MASS = 60;

export class AmbienceSim {
  effect: Effect;
  density: number;
  rng: Rng;
  w = 0;
  h = 0;
  t = 0;
  acc = 0;
  parts: Particle[] = [];
  ledges = new Map<string, Ledge>();
  cols: Collider[] = [];
  wind = 0;
  constructor(effect: Effect, seed: number, density: number) {
    this.effect = effect;
    this.density = density;
    this.rng = new Rng(seed);
  }
  setView(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }
  /** The colliders this frame, top to bottom as drawn: the cards among them (surfaceKind), nothing else. Ledges of
   *  colliders that left are dropped; a column count that changed (a bubble resized) starts its ledge again. */
  setColliders(cols: readonly Collider[]): void {
    this.cols = cols.filter((c) => surfaceKind(c.id) !== null);
    const keep = new Set<string>();
    for (const c of this.cols) {
      keep.add(c.id);
      const n = Math.max(1, Math.floor(c.w / COL_W));
      const l = this.ledges.get(c.id);
      if (!l || l.h.length !== n) this.ledges.set(c.id, { h: new Array<number>(n).fill(0), endL: 0, endR: 0 });
    }
    for (const id of Array.from(this.ledges.keys())) if (!keep.has(id)) this.ledges.delete(id);
  }
  private col(id: string): Collider | null {
    for (const c of this.cols) if (c.id === id) return c;
    return null;
  }
  /** Run `seconds` of simulation at once (a scene that starts settled: rain already pooled, snow on the ledges,
   *  fireflies out). Call after the first setView / setColliders. */
  warm(seconds: number): void {
    const n = Math.round(seconds / STEP);
    for (let i = 0; i < n; i++) this.step();
  }
  /** Advance by `dt` seconds of real time (fixed steps; a long stall is not caught up). */
  advance(dt: number): number {
    this.acc += Math.min(dt, STEP * MAX_STEPS);
    let n = 0;
    while (this.acc >= STEP - 1e-9 && n < MAX_STEPS) {
      this.acc -= STEP;
      this.step();
      n++;
    }
    return n;
  }
  /** One fixed step. */
  step(): void {
    const dt = STEP;
    this.t += dt;
    const area = this.w * this.h;
    this.wind = 0.5 * fsin(this.t * 0.23) + 0.25 * fsin(this.t * 0.71 + 1.3);
    if (this.effect === "rain") this.spawn(RATE.rain * (this.w + 200) * this.density, () => this.newRain());
    else if (this.effect === "embers") this.spawn(RATE.embers * this.w * this.density, () => this.newEmber());
    else if (this.effect === "snow") this.spawn(RATE.snow * this.w * this.density, () => this.newFlake());
    else if (this.effect === "fireflies") {
      const want = clamp(Math.round((RATE.fireflies * area * this.density) / 1e6), 3, 10);
      let have = 0;
      for (const p of this.parts) if (p.k === 7) have++;
      if (have < want && this.rng.next() < 0.05) this.parts.push(this.newFirefly());
    }
    for (let i = 0; i < this.parts.length; i++) this.move(this.parts[i], dt);
    // drop the dead in place, order kept (no new array per step)
    let w = 0;
    for (let i = 0; i < this.parts.length; i++) if (this.parts[i].life > 0) this.parts[w++] = this.parts[i];
    this.parts.length = w;
    if (this.effect === "rain") this.flow(dt);
    else if (this.effect === "snow") this.melt(dt);
  }
  private spawnAcc = 0;
  private spawn(perSecond: number, make: () => Particle): void {
    this.spawnAcc += perSecond * STEP;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.parts.length < PARTICLE_CAP) this.parts.push(make());
    }
  }
  private base(k: number, x: number, y: number, vx: number, vy: number, life: number, size: number): Particle {
    return { k, x, y, vx, vy, life, max: life, size, seed: this.rng.range(0, 60), on: "", dir: 0 };
  }
  private newRain(): Particle {
    const vy = this.rng.range(700, 950);
    return this.base(0, this.rng.range(-100, this.w + 100), -20 - this.rng.next() * 60, this.wind * 140 + this.rng.range(-15, 15), vy, 10, this.rng.range(20, 28));
  }
  private newEmber(): Particle {
    const spread = (this.rng.next() + this.rng.next() + this.rng.next()) / 3 - 0.5;
    return this.base(4, this.w * (0.5 + spread * 1.6), this.h + 6, this.rng.range(-20, 20), -this.rng.range(35, 90), this.rng.range(4, 8), this.rng.range(1.2, 2.4));
  }
  private newFlake(): Particle {
    return this.base(6, this.rng.range(-40, this.w + 40), -8, 0, this.rng.range(18, 40), 90, this.rng.range(1.2, 2.6));
  }
  private newFirefly(): Particle {
    const p = this.base(7, this.rng.range(0.05, 0.95) * this.w, this.rng.range(0.1, 0.95) * this.h, 0, 0, this.rng.range(14, 30), this.rng.range(0.8, 1.2));
    return p;
  }
  /** The collider whose top edge the segment (x, y0) → (x, y1) crosses going down, the highest one first. */
  private hitTop(x: number, y0: number, y1: number): Collider | null {
    let best: Collider | null = null;
    for (const c of this.cols) {
      if (x <= c.x || x >= c.x + c.w) continue;
      const top = topAt(c, x);
      if (y0 <= top && y1 > top && (!best || top < topAt(best, x))) best = c;
    }
    return best;
  }
  /** The collider whose bottom edge the segment crosses going UP, the lowest one first. */
  private hitBottom(x: number, y0: number, y1: number): Collider | null {
    let best: Collider | null = null;
    for (const c of this.cols) {
      if (x <= c.x || x >= c.x + c.w) continue;
      const b = c.y + c.h;
      if (y0 >= b && y1 < b && (!best || b > best.y + best.h)) best = c;
    }
    return best;
  }
  private inside(x: number, y: number, m: number): Collider | null {
    for (const c of this.cols) if (x > c.x - m && x < c.x + c.w + m && y > c.y - m && y < c.y + c.h + m) return c;
    return null;
  }
  private land(c: Collider, x: number, mass: number): void {
    const l = this.ledges.get(c.id);
    if (!l) return;
    const n = l.h.length;
    const i = clamp(Math.floor((x - c.x) / COL_W), 0, n - 1);
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, n - 1);
    l.h[a] += mass * 0.25;
    l.h[i] += mass * 0.5;
    l.h[b] += mass * 0.25;
  }
  private move(p: Particle, dt: number): void {
    const x0 = p.x;
    const y0 = p.y;
    if (p.k === 0) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const c = this.hitTop(p.x, y0, p.y);
      if (c) {
        this.land(c, p.x, RAIN_MASS);
        p.life = 0;
        if (this.rng.next() < 0.2 && this.parts.length < PARTICLE_CAP) this.parts.push(this.base(1, p.x, topAt(c, p.x) - 1.5, this.rng.range(-60, 60), -this.rng.range(50, 120), 0.35, 0.9));
      } else if (p.y > this.h + 30) p.life = 0;
      return;
    }
    if (p.k === 1 || p.k === 2 || p.k === 5) {
      p.vy += (p.k === 5 ? -120 : 1400) * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.k === 2 ? 0 : dt;
      if (p.k === 2 && p.vy > 0) {
        const c = this.hitTop(p.x, y0, p.y);
        if (c) {
          this.land(c, p.x, p.size * 0.12);
          p.life = 0;
        }
      }
      if (p.k === 1 && p.vy > 0 && this.hitTop(p.x, y0, p.y)) p.life = 0;
      if (p.y > this.h + 20 || this.inside(p.x, p.y, 0)) p.life = 0;
      return;
    }
    if (p.k === 3) {
      const c = this.col(p.on);
      if (!c) {
        p.life = 0;
        return;
      }
      p.vy += (110 - p.vy) * Math.min(1, dt * 3);
      p.y += p.vy * dt;
      p.x = p.dir < 0 ? c.x - 2.2 : c.x + c.w + 2.2;
      if (p.y >= c.y + c.h) {
        p.k = 2;
        p.on = "";
        p.vx = p.dir * this.rng.range(4, 18);
        p.vy = Math.max(p.vy, 60);
      }
      return;
    }
    if (p.k === 4) {
      p.life -= dt * (p.on ? 1.6 : 1);
      if (p.on) {
        const c = this.col(p.on);
        if (!c) {
          p.on = "";
        } else {
          p.x += p.dir * p.vx * dt;
          p.y = c.y + c.h + 3 + 0.8 * fsin(this.t * 9 + p.seed);
          if (p.x < c.x - 3 || p.x > c.x + c.w + 3) {
            p.on = "";
            p.vy = -this.rng.range(35, 70);
            p.vx = p.dir * this.rng.range(6, 20);
          }
        }
      } else {
        p.vx += (fsin(p.seed + this.t * 1.1 + p.y * 0.011) * 60 + fsin(p.seed * 3.1 + this.t * 2.9) * 22 - p.vx * 1.6) * dt;
        p.vy += (-38 - p.vy) * 0.45 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const c = this.hitBottom(p.x, y0, p.y);
        if (c) {
          // it meets the underside of a panel: slide along it to the nearer side (sometimes the other way), then rise
          p.on = c.id;
          p.dir = p.x - c.x < c.x + c.w - p.x ? -1 : 1;
          if (this.rng.next() < 0.15) p.dir = -p.dir;
          p.vx = this.rng.range(30, 70);
          p.y = c.y + c.h + 3;
        } else {
          const s = this.inside(p.x, p.y, 0);
          if (s) {
            const left = p.x - s.x < s.x + s.w - p.x;
            p.x = left ? s.x - 3 : s.x + s.w + 3;
            p.vx = left ? -Math.abs(p.vx) * 0.3 : Math.abs(p.vx) * 0.3;
          }
        }
      }
      if (p.y < -40 || p.x < -60 || p.x > this.w + 60) p.life = 0;
      return;
    }
    if (p.k === 6) {
      p.x += (this.wind * 18 + 14 * fsin(this.t * 0.9 + p.seed)) * dt;
      p.y += p.vy * dt;
      const c = this.hitTop(p.x, y0, p.y);
      if (c) {
        this.land(c, p.x, p.size * SNOW_MASS);
        p.life = 0;
      } else if (p.y > this.h + 10) p.life = 0;
      return;
    }
    if (p.k === 7) {
      p.life -= dt;
      const ang = p.seed + this.t * 0.35 + 1.4 * fsin(this.t * 0.21 + p.seed * 1.7);
      const sp = 20 * p.size;
      const tx = sp * fsin(ang + PI / 2);
      const ty = sp * fsin(ang);
      p.vx += (tx - p.vx) * Math.min(1, dt * 1.2);
      p.vy += (ty - p.vy) * Math.min(1, dt * 1.2);
      // steer clear of the panels (14 px of air) and the edges
      const s = this.inside(p.x, p.y, 16);
      if (s) {
        const cx = s.x + s.w / 2;
        const cy = s.y + s.h / 2;
        const dx = (p.x - cx) / Math.max(1, s.w / 2);
        const dy = (p.y - cy) / Math.max(1, s.h / 2);
        if (Math.abs(dx) > Math.abs(dy)) p.vx += (dx > 0 ? 1 : -1) * 90 * dt;
        else p.vy += (dy > 0 ? 1 : -1) * 90 * dt;
      }
      if (p.x < 10) p.vx += 40 * dt;
      if (p.x > this.w - 10) p.vx -= 40 * dt;
      if (p.y < 10) p.vy += 40 * dt;
      if (p.y > this.h - 10) p.vy -= 40 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -30 || p.x > this.w + 30 || p.y < -30 || p.y > this.h + 30) p.life = 0;
      return;
    }
  }
  /** Rain: a pool on a bubble's top runs toward the nearer end (a bubble top is never quite level), smooths itself,
   *  and the ends drip down the sides; a dry spell slowly takes the film. Never deeper than LEDGE_MAX. */
  private flow(dt: number): void {
    const f = Math.min(0.5, POOL_SPEED * dt / COL_W);
    const k = Math.min(0.3, 12 * dt);
    for (const c of this.cols) {
      const l = this.ledges.get(c.id);
      if (!l) continue;
      const h = l.h;
      const n = h.length;
      const mid = (n - 1) / 2;
      // outward: the left half moves left, the right half right (from the ends inward, so water moves one column a step)
      for (let i = 0; i < n; i++) {
        if (i < mid) {
          const m = h[i] * f;
          h[i] -= m;
          if (i === 0) l.endL += m * COL_W;
          else h[i - 1] += m;
        }
      }
      for (let i = n - 1; i >= 0; i--) {
        if (i > mid) {
          const m = h[i] * f;
          h[i] -= m;
          if (i === n - 1) l.endR += m * COL_W;
          else h[i + 1] += m;
        }
      }
      // level: each column moves toward its neighbours' mean (old values: `prev` keeps the left one)
      let prev = h[0];
      for (let i = 0; i < n; i++) {
        const cur = h[i];
        const left = i > 0 ? prev : cur;
        const right = i < n - 1 ? h[i + 1] : cur;
        h[i] = Math.max(0, cur + (left + right - 2 * cur) * k * 0.5 - 0.02 * dt);
        prev = cur;
      }
      for (let i = 0; i < n; i++) {
        if (h[i] > LEDGE_MAX) {
          const extra = h[i] - LEDGE_MAX;
          h[i] = LEDGE_MAX;
          if (i < mid) l.endL += extra * COL_W;
          else l.endR += extra * COL_W;
        }
      }
      if (l.endL > RUNNER_MASS) {
        this.runner(c, -1, l.endL);
        l.endL = 0;
      }
      if (l.endR > RUNNER_MASS) {
        this.runner(c, 1, l.endR);
        l.endR = 0;
      }
    }
  }
  private runner(c: Collider, dir: number, mass: number): void {
    if (this.parts.length >= PARTICLE_CAP) return;
    const p = this.base(3, dir < 0 ? c.x - 2.2 : c.x + c.w + 2.2, c.y + 0.7 * Math.min(c.h, dir < 0 ? c.rl ?? 0 : c.rr ?? 0) + 2, 0, 20, 10, clamp(mass * 0.12, 3, 9));
    p.on = c.id;
    p.dir = dir;
    this.parts.push(p);
  }
  /** Snow: the lines melt slowly and never grow past LEDGE_MAX. */
  private melt(dt: number): void {
    for (const c of this.cols) {
      const l = this.ledges.get(c.id);
      if (!l) continue;
      for (let i = 0; i < l.h.length; i++) l.h[i] = clamp(l.h[i] - 0.01 * dt, 0, LEDGE_MAX);
    }
  }

  // ---- the mesh ----------------------------------------------------------------------------------------------------
  /** Triangles, 6 floats per vertex: x, y, r, g, b, a (premultiplied, 0..1). A piece whose box touches any collider is
   *  left out (nothing is ever drawn inside a bubble or a panel). Returns the vertex count. */
  mesh(mode: Mode, out: MeshOut): number {
    out.n = 0;
    const pal = PALETTE[mode];
    if (this.effect === "rain" || this.effect === "snow") {
      const water = this.effect === "rain";
      const c0 = water ? pal.pool : pal.snow;
      const c1 = water ? pal.poolTop : pal.snowTop;
      for (const c of this.cols) {
        const l = this.ledges.get(c.id);
        if (!l) continue;
        const n = l.h.length;
        const cw = c.w / n;
        for (let i = 0; i < n; i++) {
          const ha = i > 0 ? (l.h[i - 1] + l.h[i]) / 2 : l.h[i];
          const hb = i < n - 1 ? (l.h[i] + l.h[i + 1]) / 2 : l.h[i];
          if (ha < 0.12 && hb < 0.12) continue;
          // the pool sits on the top edge and steps down its rounded corners: each column's floor is the HIGHER of its
          // two ends (a straight edge between two points of a convex corner would cut into the panel)
          const xa = c.x + i * cw;
          const xb = xa + cw;
          const ba = Math.min(topAt(c, xa), topAt(c, xb)) - 0.5;
          const bb = ba;
          const ya = ba - Math.min(ha, LEDGE_MAX);
          const yb2 = bb - Math.min(hb, LEDGE_MAX);
          if (this.blocked(xa, Math.min(ya, yb2), xb, Math.max(ba, bb), c)) continue;
          out.tri(xa, ba, c0, xb, bb, c0, xa, ya, c1);
          out.tri(xb, bb, c0, xb, yb2, c1, xa, ya, c1);
        }
      }
    }
    for (const p of this.parts) {
      if (p.k === 0) {
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const ux = p.vx / sp;
        const uy = p.vy / sp;
        const len = p.size;
        const tx = p.x - ux * len;
        const ty = p.y - uy * len;
        // a streak with soft sides (its own anti-aliasing): bright down the middle, clear at the edges and the tail
        const hw = 1.0;
        if (this.blocked(Math.min(tx, p.x) - hw, Math.min(ty, p.y), Math.max(tx, p.x) + hw, Math.max(ty, p.y))) continue;
        const px = -uy * hw;
        const py = ux * hw;
        out.tri(p.x + px, p.y + py, CLEAR, p.x, p.y, pal.rain, tx, ty, CLEAR);
        out.tri(p.x + px, p.y + py, CLEAR, tx, ty, CLEAR, tx + px, ty + py, CLEAR);
        out.tri(p.x, p.y, pal.rain, p.x - px, p.y - py, CLEAR, tx - px, ty - py, CLEAR);
        out.tri(p.x, p.y, pal.rain, tx - px, ty - py, CLEAR, tx, ty, CLEAR);
      } else if (p.k === 1) {
        const a = clamp(p.life / p.max, 0, 1);
        this.blob(out, p.x, p.y, p.size, p.size, 0, 1, scale(pal.drop, a), CLEAR, 6);
      } else if (p.k === 2 || p.k === 3) {
        const r = 0.55 * Math.sqrt(p.size);
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const ux = sp > 0 ? p.vx / sp : 0;
        const uy = sp > 0 ? p.vy / sp : 1;
        const stretch = 1 + Math.min(1.2, sp / 600);
        this.blob(out, p.x, p.y, r, r * stretch, ux, uy, pal.drop, pal.dropEdge, 8);
        if (p.k === 3) {
          // the wet track it leaves above itself, faint
          const c = this.col(p.on);
          if (c && p.y - c.y > 4) {
            const hw = 0.7;
            const top = Math.max(c.y, p.y - 26);
            if (!this.blocked(p.x - hw, top, p.x + hw, p.y - r)) {
              out.tri(p.x - hw, p.y - r, pal.track, p.x + hw, p.y - r, pal.track, p.x - hw, top, CLEAR);
              out.tri(p.x + hw, p.y - r, pal.track, p.x + hw, top, CLEAR, p.x - hw, top, CLEAR);
            }
          }
        }
      } else if (p.k === 4 || p.k === 5) {
        const f = clamp(p.life / p.max, 0, 1);
        const flick = 0.88 + 0.12 * fsin(this.t * 7 + p.seed * 7);
        const heat = f * Math.sqrt(f) * flick;
        const vx = p.on ? p.dir * p.vx : p.vx;
        const vy = p.on ? 0 : p.vy;
        const sp = Math.sqrt(vx * vx + vy * vy);
        const ux = sp > 0 ? vx / sp : 0;
        const uy = sp > 0 ? vy / sp : 1;
        const hot: Rgb = [1, 0.25 + 0.65 * f * f, 0.04 + 0.45 * f * f * f];
        const r = p.size * 3.4;
        const glow = mode === "light" ? lightGlow(hot, 0.4 * heat) : addGlow(hot, 0.38 * heat);
        const core = mode === "light" ? lightGlow(hot, 0.7 * heat) : addGlow(hot, 0.8 * heat);
        this.blob(out, p.x, p.y, r, r * (1 + Math.min(1.6, sp / 160)), ux, uy, glow, CLEAR, 8);
        this.blob(out, p.x, p.y, p.size * 0.8, p.size * 0.8 * (1 + Math.min(1.2, sp / 220)), ux, uy, core, scale(core, 0.2), 6);
      } else if (p.k === 6) {
        this.blob(out, p.x, p.y, p.size, p.size, 0, 1, pal.flake, CLEAR, 6);
      } else if (p.k === 7) {
        // a soft glow that never quite goes out, and a slow blink on top
        const pulse = Math.max(0, fsin(this.t * 1.3 + p.seed * 2.3));
        const b = (0.18 + 0.82 * pulse * pulse * pulse) * clamp(p.life, 0, 1) * clamp((p.max - p.life) / 1.5, 0, 1);
        if (b < 0.02) continue;
        const g = mode === "light" ? lightGlow(FIREFLY, 0.4 * b) : addGlow(FIREFLY, 0.4 * b);
        const k = mode === "light" ? lightGlow(FIREFLY, 0.8 * b) : addGlow(FIREFLY, 0.8 * b);
        this.blob(out, p.x, p.y, 13 * p.size, 13 * p.size, 0, 1, g, CLEAR, 8);
        this.blob(out, p.x, p.y, 2, 2, 0, 1, k, scale(k, 0.3), 6);
      }
    }
    return out.n;
  }
  /** Is the box (x0, y0)–(x1, y1) touching a collider (other than `skip`)? */
  blocked(x0: number, y0: number, x1: number, y1: number, skip: Collider | null = null): boolean {
    for (const c of this.cols) if (c !== skip && x1 > c.x && x0 < c.x + c.w && y1 > c.y && y0 < c.y + c.h) return true;
    return false;
  }
  /** How far (x, y) is from the nearest collider, as the half-size of the largest square around it that touches none
   *  (Chebyshev distance; 0 inside one). */
  clearance(x: number, y: number): number {
    let best = 1e9;
    for (const c of this.cols) {
      const dx = Math.max(c.x - x, 0, x - (c.x + c.w));
      const dy = Math.max(c.y - y, 0, y - (c.y + c.h));
      const d = Math.max(dx, dy);
      if (d < best) best = d;
    }
    return best;
  }
  /** An ellipse (a fan of `n` triangles) with its `ry` axis along (ux, uy); centre colour `ci`, rim colour `co`. Near a
   *  collider it shrinks to the air around it (a glow never reaches into a bubble; too close = not drawn). */
  private blob(out: MeshOut, x: number, y: number, rx0: number, ry0: number, ux: number, uy: number, ci: Rgba, co: Rgba, n: 6 | 8): void {
    const ext = Math.max(rx0, ry0);
    const room = this.clearance(x, y) - 0.5;
    if (room <= 0.5) return;
    const k = room < ext ? room / ext : 1;
    const rx = rx0 * k;
    const ry = ry0 * k;
    const ring = n === 6 ? RING6 : RING8;
    // axes: v along (ux, uy) scaled by ry, u across scaled by rx
    const ax = -uy * rx;
    const ay = ux * rx;
    const bx = ux * ry;
    const by = uy * ry;
    for (let i = 0; i < n; i++) {
      const [c0, s0] = ring[i];
      const [c1, s1] = ring[(i + 1) % n];
      out.tri(x, y, ci, x + ax * c0 + bx * s0, y + ay * c0 + by * s0, co, x + ax * c1 + bx * s1, y + ay * c1 + by * s1, co);
    }
  }
}

export type Rgba = readonly [number, number, number, number];
const CLEAR: Rgba = [0, 0, 0, 0];
const FIREFLY: Rgb = [0.78, 1, 0.42];
function scale(c: Rgba, k: number): Rgba {
  return [c[0] * k, c[1] * k, c[2] * k, c[3] * k];
}
/** A glow on a dark background: premultiplied with alpha = the brightest channel (reads like light added). */
function addGlow(c: Rgb, i: number): Rgba {
  const m = Math.max(c[0], c[1], c[2]);
  return [c[0] * i, c[1] * i, c[2] * i, m * i];
}
/** A glow on a light background: a deeper, opaque-ish tone (light added to white would be invisible). */
function lightGlow(c: Rgb, i: number): Rgba {
  const d: Rgb = [c[0] * 0.78, c[1] * 0.5, c[2] * 0.35];
  return [d[0] * i, d[1] * i, d[2] * i, i];
}
/** Premultiplied from straight colour + alpha. */
function pm(r: number, g: number, b: number, a: number): Rgba {
  return [r * a, g * a, b * a, a];
}
interface Palette {
  rain: Rgba;
  drop: Rgba;
  dropEdge: Rgba;
  track: Rgba;
  pool: Rgba;
  poolTop: Rgba;
  snow: Rgba;
  snowTop: Rgba;
  flake: Rgba;
}
const PALETTE: Readonly<Record<Mode, Palette>> = {
  dark: {
    rain: pm(0.78, 0.84, 0.92, 0.3),
    drop: pm(0.85, 0.9, 0.97, 0.7),
    dropEdge: pm(0.6, 0.68, 0.78, 0.25),
    track: pm(0.75, 0.82, 0.9, 0.16),
    pool: pm(0.55, 0.64, 0.76, 0.38),
    poolTop: pm(0.88, 0.93, 1, 0.75),
    snow: pm(0.86, 0.9, 0.95, 0.7),
    snowTop: pm(0.97, 0.98, 1, 0.9),
    flake: pm(0.94, 0.96, 1, 0.65),
  },
  oled: {
    rain: pm(0.7, 0.76, 0.86, 0.26),
    drop: pm(0.78, 0.84, 0.92, 0.6),
    dropEdge: pm(0.5, 0.58, 0.68, 0.2),
    track: pm(0.7, 0.76, 0.86, 0.12),
    pool: pm(0.45, 0.53, 0.64, 0.28),
    poolTop: pm(0.8, 0.86, 0.95, 0.55),
    snow: pm(0.8, 0.84, 0.9, 0.6),
    snowTop: pm(0.92, 0.94, 0.98, 0.8),
    flake: pm(0.88, 0.9, 0.96, 0.55),
  },
  light: {
    rain: pm(0.3, 0.38, 0.5, 0.26),
    drop: pm(0.35, 0.45, 0.6, 0.6),
    dropEdge: pm(0.3, 0.38, 0.5, 0.2),
    track: pm(0.35, 0.45, 0.6, 0.12),
    pool: pm(0.4, 0.52, 0.68, 0.3),
    poolTop: pm(0.3, 0.42, 0.6, 0.55),
    snow: pm(1, 1, 1, 0.92),
    snowTop: pm(0.78, 0.84, 0.92, 0.95),
    flake: pm(0.62, 0.7, 0.82, 0.7),
  },
};
const S2 = 0.7071067811865476;
const S3 = 0.8660254037844386;
const RING8: ReadonlyArray<readonly [number, number]> = [[1, 0], [S2, S2], [0, 1], [-S2, S2], [-1, 0], [-S2, -S2], [0, -1], [S2, -S2]];
const RING6: ReadonlyArray<readonly [number, number]> = [[1, 0], [0.5, S3], [-0.5, S3], [-1, 0], [-0.5, -S3], [0.5, -S3]];

/** A growable vertex buffer (6 floats per vertex). */
export class MeshOut {
  buf: Float32Array;
  n = 0;
  constructor(cap = 8192) {
    this.buf = new Float32Array(cap * 6);
  }
  private v(x: number, y: number, c: Rgba): void {
    if ((this.n + 1) * 6 > this.buf.length) {
      const b = new Float32Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    const o = this.n * 6;
    this.buf[o] = x;
    this.buf[o + 1] = y;
    this.buf[o + 2] = c[0];
    this.buf[o + 3] = c[1];
    this.buf[o + 4] = c[2];
    this.buf[o + 5] = c[3];
    this.n++;
  }
  tri(x0: number, y0: number, c0: Rgba, x1: number, y1: number, c1: Rgba, x2: number, y2: number, c2: Rgba): void {
    this.v(x0, y0, c0);
    this.v(x1, y1, c1);
    this.v(x2, y2, c2);
  }
}

/** Round to 1/1000 the same way in both languages (floor(x·1000 + 0.5) / 1000) — what the vectors compare. */
export function r3(x: number): number {
  return Math.floor(x * 1000 + 0.5) / 1000;
}
/** A summary of the sim the vectors pin: counts per kind, the first pieces, ledge sums, and the mesh. */
export function simDigest(sim: AmbienceSim, mode: Mode): Record<string, unknown> {
  const kinds = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of sim.parts) kinds[p.k]++;
  const first = sim.parts.slice(0, 6).map((p) => [p.k, r3(p.x), r3(p.y), r3(p.vx), r3(p.vy)]);
  const ledges = sim.cols.map((c) => {
    const l = sim.ledges.get(c.id);
    let s = 0;
    if (l) for (const v of l.h) s += v;
    return [c.id, r3(s)];
  });
  const out = new MeshOut(1024);
  const n = sim.mesh(mode, out);
  let sx = 0;
  let sa = 0;
  for (let i = 0; i < n; i++) {
    sx += out.buf[i * 6] + out.buf[i * 6 + 1];
    sa += out.buf[i * 6 + 5];
  }
  return { kinds, first, ledges, verts: n, sumxy: r3(sx), suma: r3(sa) };
}
