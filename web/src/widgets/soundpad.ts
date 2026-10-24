// soundpad.ts — the Soundboard pad (widget `soundPad`, contract WIDGETS.md §22, vectors testvectors/widgets/soundpad/*):
// your soundboard favourites (the panel's "Favourites" = the personal sounds, global account data
// `dev.tinhat.soundboard_personal` `{sounds: [{name, sourceUrl, emoji?, duration}]}`, in the order you starred them)
// as big buttons; whether a press may play into the call (the advisory RBAC permission `use_soundboard`, docs/RBAC.md
// §2) and the one line under the pad — the soundboard panel shows the same line (one wording, both apps). Pure.
// The desktop's Rust port (crates/widgets/src/soundpad.rs) runs the same vectors.

/** How many buttons each size shows (S = chips in the header). */
export const PAD_MAX = { S: 3, M: 6, L: 12 } as const;
/** The glyph of a sound without an emoji (the panel's card). */
export const DEFAULT_EMOJI = "🔊";

/** The line under the pad (and in the panel) when the call's roles turned the soundboard off for you. */
export const OFF_TEXT = "The soundboard is off for your role in this call.";
/** The line under the pad outside a call: a press is a local preview. */
export const PREVIEW_TEXT = "Only you hear these here. Join a call to play them for everyone.";

export interface PadSound {
  name: string;
  url: string;
  emoji: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isWs = (c: string) => c === " " || (c >= "\t" && c <= "\r");
/** ASCII whitespace off both ends (the soundboard's trim). */
function trimAscii(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isWs(s[a]!)) a++;
  while (b > a && isWs(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/**
 * The favourites content → the pad's buttons, in the stored order: an entry counts when it is an object whose `name`
 * and `sourceUrl` are strings non-empty after an ASCII trim (the panel's rule, ASCII-only for byte-exact ports); a `sourceUrl` seen before is skipped
 * (the first wins); emoji = the entry's `emoji` when a string non-empty after the trim, else DEFAULT_EMOJI. At most
 * `max` (0 = all).
 */
export function padSounds(content: unknown, max = 0): PadSound[] {
  const list = isObj(content) && Array.isArray(content.sounds) ? content.sounds : [];
  const out: PadSound[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!isObj(e)) continue;
    const name = typeof e.name === "string" ? trimAscii(e.name) : "";
    const url = typeof e.sourceUrl === "string" ? trimAscii(e.sourceUrl) : "";
    if (!name || !url || seen.has(url)) continue;
    seen.add(url);
    const emoji = typeof e.emoji === "string" ? trimAscii(e.emoji) : "";
    out.push({ name, url, emoji: emoji || DEFAULT_EMOJI });
    if (max > 0 && out.length >= max) break;
  }
  return out;
}

export interface PadGate {
  /** a press may play (in a call: into the call; else the local preview) */
  allowed: boolean;
  /** the line under the pad ("" = none) */
  hint: string;
}

/** In a call whose roles set `use_soundboard` to false (exactly false) → not allowed + OFF_TEXT; in a call otherwise →
 *  allowed, no line; outside a call → allowed + PREVIEW_TEXT. */
export function padGate(inCall: boolean, callPerms: unknown): PadGate {
  if (inCall === true) {
    if (isObj(callPerms) && callPerms.use_soundboard === false) return { allowed: false, hint: OFF_TEXT };
    return { allowed: true, hint: "" };
  }
  return { allowed: true, hint: PREVIEW_TEXT };
}
