// limits.ts — ENGINE.md §4 limits: serialized size, string length, nesting depth, "no URLs", id syntax.
// NO value imports (node unit tests load it directly).

export const MAX_BYTES = 8192; // 8 KB = 8192 bytes of UTF-8
export const MAX_OVERRIDES = 400; // keys of `roles` + keys of `tokens`
export const MAX_ID = 64;
export const MAX_STRING = 80; // Unicode code points, every string (keys too) at any depth
export const MAX_DEPTH = 16; // objects/arrays nested deeper than this are refused (root = 1)

/** Unicode code points (a surrogate pair counts once; Rust: s.chars().count()). */
export function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** First `max` code points of s. */
export function takeCodePoints(s: string, max: number): string {
  let n = 0;
  let i = 0;
  while (i < s.length && n < max) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    n++;
  }
  return s.slice(0, i);
}

/** UTF-8 byte length. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const lowerAscii = (s: string) => s.replace(/[A-Z]/g, (m) => String.fromCharCode(m.charCodeAt(0) + 32));
const isAlnum = (ch: number) => (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90);

/** Schemes that make a string a URL when they start a word (also "www."). "://" anywhere is always a URL. */
export const URL_SCHEMES: readonly string[] = [
  "http:", "https:", "ftp:", "file:", "data:", "javascript:", "vbscript:", "mailto:", "blob:", "www.",
];

/**
 * "No URLs anywhere in a theme" (§4), as a portable rule: after ASCII-lowercasing, the string contains "://", or
 * one of URL_SCHEMES at the start or right after a character that is not an ASCII letter or digit.
 */
export function containsUrl(s: string): boolean {
  const t = lowerAscii(s);
  if (t.includes("://")) return true;
  for (const w of URL_SCHEMES) {
    let from = 0;
    for (;;) {
      const i = t.indexOf(w, from);
      if (i < 0) break;
      if (i === 0 || !isAlnum(t.charCodeAt(i - 1))) return true;
      from = i + 1;
    }
  }
  return false;
}

/** JSON pointer of the one field allowed to hold a URL (ENGINE.md §9 C2). */
export const BACKDROP_IMAGE_PATH = "/backdrop/image";

const isServerChar = (ch: number) => isAlnum(ch) || ch === 46 || ch === 58 || ch === 45; // . : -
const isMediaChar = (ch: number) => isAlnum(ch) || ch === 95 || ch === 45; // _ -

/**
 * `backdrop.image` (ENGINE.md §9 C2): exactly `^mxc://[A-Za-z0-9.:-]{1,255}/[A-Za-z0-9_-]{1,255}$` — "mxc://"
 * (lower case), 1–255 server characters, one "/", 1–255 media-id characters, nothing else (no trailing newline).
 */
export function isMxcUri(s: string): boolean {
  if (!s.startsWith("mxc://")) return false;
  const rest = s.slice(6);
  const slash = rest.indexOf("/");
  if (slash < 1 || slash > 255) return false;
  const media = rest.length - slash - 1;
  if (media < 1 || media > 255) return false;
  for (let i = 0; i < slash; i++) if (!isServerChar(rest.charCodeAt(i))) return false;
  for (let i = slash + 1; i < rest.length; i++) if (!isMediaChar(rest.charCodeAt(i))) return false;
  return true;
}

/** Theme id: 1–64 characters of a-z 0-9 . : - */
export function isThemeId(s: string): boolean {
  return s.length >= 1 && s.length <= MAX_ID && /^[a-z0-9.:-]+$/.test(s);
}

/** Role/token id (and expression ref): a letter, then letters, digits, . : - ; at most 64 characters. */
export function isKeyId(s: string): boolean {
  return s.length >= 1 && s.length <= MAX_ID && /^[A-Za-z][A-Za-z0-9.:-]*$/.test(s);
}

/** JSON-pointer segment (RFC 6901 escaping), cut to 40 code points so error details stay short. */
export function pathSeg(s: string): string {
  return takeCodePoints(s, 40).replace(/~/g, "~0").replace(/\//g, "~1");
}

// ---- JSON data the Rust port can hold (ENGINE.md §9, PORT-QUESTIONS Q2/Q3) --------------------------------------

/** Deepest nesting of arrays/objects (tables, mappings, dicts) in a document or JSON value; the root is level 1. The
 *  Rust port's limit (= serde_json's default): every parser refuses a 129th level with its usual error. */
export const MAX_NESTING = 128;

/** No lone UTF-16 surrogate: a Rust string cannot hold one. */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/** Every lone surrogate → U+FFFD: the text any UTF-8 transfer makes of it (all the desktop can ever be given). */
export function toWellFormed(s: string): string {
  if (isWellFormed(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      out += s[i] + s[i + 1];
      i++;
    } else out += c >= 0xd800 && c <= 0xdfff ? "�" : s[i];
  }
  return out;
}

/**
 * JSON data the Rust port can hold: arrays and objects nested at most MAX_NESTING deep (the root is level 1) and no
 * lone surrogate in any string or key. Iterative, so any depth is safe (a cycle ends at the depth limit).
 */
export function isJsonData(v: unknown): boolean {
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length > 0) {
    const [x, depth] = stack.pop() as [unknown, number];
    if (typeof x === "string") {
      if (!isWellFormed(x)) return false;
      continue;
    }
    if (x === null || typeof x !== "object") continue;
    if (depth > MAX_NESTING) return false;
    if (Array.isArray(x)) {
      for (const y of x) stack.push([y, depth + 1]);
      continue;
    }
    for (const k of Object.keys(x)) {
      if (!isWellFormed(k)) return false;
      stack.push([(x as Record<string, unknown>)[k], depth + 1]);
    }
  }
  return true;
}
