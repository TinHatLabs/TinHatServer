// share.ts — theme share cards (THEMES-UI.md §13): the `m.room.message` a "Share to a room…" sends, reading one back
// (a card, a refusal, a newer card, or not a card at all), and what Keep does. The TypeScript REFERENCE: the desktop
// ports it (crates/theme/src/share.rs) and both run the shared vectors (testvectors/share/) byte for byte.
//
// Pure: no DOM, no I/O. A card carries DATA ONLY — one `tinhat-theme` v1 document, which the receiver checks with the
// engine exactly like a theme file (size, strings, no URLs except an mxc backdrop, expressions, fonts from the allowed
// list); the receiver computes the swatches and the variant itself and never trusts anything else the sender wrote.
// Other apps (Element X, Element Web) show `body`: one plain line of text.
import { canonJson, cmpCodePoint } from "./canon";
import type { TokensSpec } from "./engine";
import { resolveTheme } from "./engine";
import { trimAscii } from "./editor";
import { slugify } from "./import";
import { codePoints, containsUrl, isJsonData, isThemeId, utf8Length } from "./limits";
import type { JObj } from "./sync";
import { clone, isObj, uniqueThemeId } from "./sync";

/** The content key that makes an `m.room.message` a theme card. */
export const SHARE_KEY = "dev.tinhat.theme.share";
export const SHARE_FORMAT = "tinhat-theme-share";
export const SHARE_V = 1;
/** Canonical UTF-8 size of the share object (a theme is ≤ 8,192 bytes, ENGINE.md §4; the rest is its envelope). */
export const SHARE_MAX_BYTES = 12_288;
/** The roles the card's swatch strip shows, left to right. */
export const SWATCH_ROLES: readonly string[] = [
  "surface.window", "surface.island", "surface.raised", "text.secondary", "text.primary", "accent.base", "accent.bright",
  "state.success", "state.warning", "state.danger",
];
/** How long Try shows a shared theme before switching back (ms). */
export const TRY_MS = 30_000;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const own = (o: JObj, k: string): unknown => (has(o, k) ? o[k] : undefined);

/** A display string from a theme field: a string of 1–80 code points with no URL, else null. */
function shownText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = trimAscii(v);
  return t.length > 0 && codePoints(t) <= 80 && !containsUrl(t) ? t : null;
}

/** The plain line other apps show: `🎨 Nord by Arctic Ice Studio — a Tin Hat theme. Open it in Tin Hat to try it.` */
export function shareBody(name: string, author: string | null): string {
  return `🎨 ${name}${author ? ` by ${author}` : ""} — a Tin Hat theme. Open it in Tin Hat to try it.`;
}

export type ShareContent = { ok: true; content: JObj } | { ok: false; error: string };

/**
 * The message content that shares `theme` (§13.1): `{msgtype: "m.text", body, "m.mentions": {}, [SHARE_KEY]: {format,
 * v, theme}}`. Refused when the theme does not resolve (`refused: <engine error>`) or the share object is larger than
 * SHARE_MAX_BYTES (`too-large`). The theme travels as it is (its own id and name).
 */
export function shareContent(theme: unknown, spec: TokensSpec): ShareContent {
  const r = resolveTheme(theme, spec);
  if (!r.ok) return { ok: false, error: `refused: ${r.error}` };
  const t = clone(theme as JObj);
  const share: JObj = Object.create(null);
  share.format = SHARE_FORMAT;
  share.v = SHARE_V;
  share.theme = t;
  if (utf8Length(canonJson(share)) > SHARE_MAX_BYTES) return { ok: false, error: "too-large" };
  const content: JObj = Object.create(null);
  content.msgtype = "m.text";
  content.body = shareBody(shownText(t.name) ?? "A theme", shownText(t.author));
  content["m.mentions"] = Object.create(null) as JObj;
  content[SHARE_KEY] = share;
  return { ok: true, content };
}

export type ShareRead =
  | { kind: "none" }
  | { kind: "newer"; name: string | null }
  | { kind: "refused"; error: string; name: string | null }
  | { kind: "ok"; theme: JObj; name: string; author: string | null; variant: "dark" | "light"; swatches: string[] };

/**
 * Read a message's content (§13.2). `none`: not a theme card (render the message as usual). `newer`: a card of a later
 * version (`v` > 1). `refused`: a card that cannot be used — `bad-card` (not a v1 share object, no theme object, not
 * JSON data), `too-large`, or the engine's refusal of the theme — shown as such, never applied. `ok`: the theme, its
 * name / author / variant and the swatch colours (SWATCH_ROLES, canonical), all computed here.
 */
export function readShare(content: unknown, spec: TokensSpec): ShareRead {
  if (!isObj(content)) return { kind: "none" };
  const share = own(content, SHARE_KEY);
  if (!isObj(share)) return { kind: "none" };
  if (own(share, "format") !== SHARE_FORMAT) return { kind: "none" };
  const theme = own(share, "theme");
  const name = isObj(theme) ? shownText(own(theme, "name")) : null;
  const v = own(share, "v");
  // a number that overflows a double (1e400) is null for the Rust reader (ENGINE.md §9): bad-card on both sides
  if (typeof v !== "number" || !Number.isFinite(v)) return { kind: "refused", error: "bad-card", name };
  if (v > SHARE_V) return { kind: "newer", name };
  if (v !== SHARE_V) return { kind: "refused", error: "bad-card", name };
  if (!isJsonData(share) || !isObj(theme)) return { kind: "refused", error: "bad-card", name };
  if (utf8Length(canonJson(share)) > SHARE_MAX_BYTES) return { kind: "refused", error: "too-large", name };
  const r = resolveTheme(theme, spec);
  if (!r.ok) return { kind: "refused", error: r.error, name };
  const swatches = SWATCH_ROLES.map((id) => r.roles[id]);
  return {
    kind: "ok",
    theme: clone(theme as JObj),
    name: name ?? "A theme",
    author: shownText(own(theme, "author")),
    variant: r.variant,
    swatches,
  };
}

/** A theme document without its `id` (what "the same theme" means for Keep). */
function withoutId(t: JObj): string {
  const c = clone(t);
  delete c.id;
  return canonJson(c);
}

export type KeepPlan = { kind: "library"; id: string } | { kind: "mine"; id: string } | { kind: "save"; doc: JObj };

/**
 * What Keep does with a card's theme (§13.4): a library theme exactly as shipped → use it by id (nothing is saved);
 * the same theme as one of My themes (compared without `id`) → use that one; else save it as a new My theme — its id
 * = slugify(name) made unique against the library and My themes (THEMES-SYNC §4.1) — and use it.
 * `mine` in any order (the first equal one in id order wins).
 */
export function keepPlan(theme: JObj, library: (id: string) => JObj | undefined, mine: readonly JObj[]): KeepPlan {
  const id = own(theme, "id");
  if (typeof id === "string" && isThemeId(id)) {
    const lib = library(id);
    if (lib && canonJson(lib) === canonJson(theme)) return { kind: "library", id };
  }
  const key = withoutId(theme);
  const sorted = [...mine].filter((m) => typeof m.id === "string").sort((a, b) => cmpCodePoint(a.id as string, b.id as string));
  for (const m of sorted) if (withoutId(m) === key) return { kind: "mine", id: m.id as string };
  const taken = new Set(sorted.map((m) => m.id as string));
  const doc = clone(theme);
  doc.id = uniqueThemeId(slugify(typeof doc.name === "string" ? doc.name : ""), (x) => taken.has(x) || library(x) !== undefined);
  return { kind: "save", doc };
}
