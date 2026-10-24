// import.ts — ENGINE.md §7: terminal theme files → `tinhat-theme` v1 documents, format detected from content.
//
// importTheme(text, filenameHint?) → { ok: true, format, theme } | { ok: false, error: "<code>: <detail>" }
// Formats: iTerm2 .itermcolors, kitty, Alacritty TOML + legacy YAML, Ghostty, WezTerm TOML, Windows Terminal JSON,
// Xresources (incl. #define and the iTerm2 collection's xrdb files), base16/base24 YAML (tinted-theming terminal
// mapping), and our own tinhat-theme JSON (returned unchanged). Pure functions; the Rust port reproduces
// testvectors/import/<format>/*.expect.json byte for byte. Rules the port must copy: README.md "Importers".
import type { Theme } from "./engine";
import { MAX_STRING, codePoints, containsUrl, takeCodePoints, toWellFormed, utf8Length } from "./limits";
import { ParseError, RawToken, parseJsonc, parsePlist, parseToml, parseYaml } from "./parsers";

export type ImportFormat =
  | "tinhat"
  | "iterm2"
  | "kitty"
  | "alacritty-toml"
  | "alacritty-yaml"
  | "ghostty"
  | "wezterm"
  | "windows-terminal"
  | "xresources"
  | "base16"
  | "base24";

export const IMPORT_FORMATS: readonly ImportFormat[] = [
  "alacritty-toml", "alacritty-yaml", "base16", "base24", "ghostty", "iterm2", "kitty", "tinhat", "wezterm",
  "windows-terminal", "xresources",
];

export type ImportResult = { ok: true; format: ImportFormat; theme: Theme } | { ok: false; error: string };

export const MAX_IMPORT_BYTES = 262144;

class ImportError {
  code: string;
  detail: string;
  constructor(code: string, detail: string) {
    this.code = code;
    this.detail = detail;
  }
}
function fail(code: string, detail: string): never {
  throw new ImportError(code, detail);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof RawToken);
/** Every read of a document goes through OWN keys only: `constructor`, `toString`, `__proto__` … are ordinary keys, never
 *  inherited values (ENGINE.md §9, PORT-QUESTIONS Q1). */
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const own = (o: Obj, k: string): unknown => (hasOwn(o, k) ? o[k] : undefined);
const get = (o: unknown, ...path: string[]): unknown => {
  let v = o;
  for (const p of path) {
    if (!isObj(v) || !hasOwn(v, p)) return undefined;
    v = v[p];
  }
  return v;
};
/** A document value as colour text: strings as they are, TOML bare tokens by their text, anything else none. */
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : v instanceof RawToken ? v.raw : undefined);

// ---- colours -----------------------------------------------------------------------------------------------

/** A-Z → a-z only (the Rust port uses to_ascii_lowercase). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (m) => String.fromCharCode(m.charCodeAt(0) + 32));

const HEX = "0123456789abcdef";
const hex2 = (v: number) => HEX[v >> 4] + HEX[v & 15];
const isHex = (s: string) => s.length > 0 && /^[0-9a-fA-F]+$/.test(s);

/**
 * A colour as terminal theme files write it → `#rrggbb` (lower case), or null: `#rgb`, `#rrggbb`, bare `rrggbb`,
 * `0xrrggbb`, X11 `rgb:h/h/h` (1–4 hex digits per channel, scaled with round-half-up in integers). Surrounding
 * spaces and one pair of double quotes are ignored. Anything else (names, `none`, alpha forms) → null.
 */
export function importColour(raw: string): string | null {
  let s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
  let h = "";
  if (s[0] === "#") h = s.slice(1);
  else if (s.length === 8 && (s.startsWith("0x") || s.startsWith("0X"))) h = s.slice(2);
  else if (s.length === 6) h = s;
  else if (asciiLower(s.slice(0, 4)) === "rgb:") {
    const parts = s.slice(4).split("/");
    if (parts.length !== 3 || parts.some((p) => p.length < 1 || p.length > 4 || !isHex(p))) return null;
    return (
      "#" +
      parts
        .map((p) => {
          const max = 16 ** p.length - 1;
          return hex2(Math.floor((parseInt(p, 16) * 510 + max) / (2 * max)));
        })
        .join("")
    );
  } else return null;
  if (!isHex(h)) return null;
  h = asciiLower(h);
  if (h.length === 3) return "#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 6) return "#" + h;
  return null;
}

// ---- names, authors, ids -----------------------------------------------------------------------------------

const isAsciiWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

function controlsToSpace(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    out += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return out;
}

function words(s: string): string[] {
  const out: string[] = [];
  let w = "";
  for (const ch of s) {
    if (isAsciiWs(ch)) {
      if (w) out.push(w);
      w = "";
    } else w += ch;
  }
  if (w) out.push(w);
  return out;
}

function trimChars(s: string, set: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && set.includes(s[a])) a++;
  while (b > a && set.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** A display name: control characters → space, words with a URL dropped, spaces collapsed, ≤ 80 code points. */
export function cleanName(s: string | undefined): string {
  if (!s) return "";
  const w = words(controlsToSpace(s)).filter((x) => !containsUrl(x));
  return trimChars(takeCodePoints(w.join(" "), MAX_STRING), " ");
}

const linkish = (w: string) => containsUrl(w) || w.includes("@");

/**
 * An author line without links or e-mail addresses (README "Importers" has the exact steps):
 *  1. control characters → space; 2. `<…>` spans removed (to the next ">", or the end);
 *  3. `(…)` spans removed when their text holds a URL or "@", or has no whitespace but a "." (a bare domain);
 *  4. split at ","; a part with a word holding a URL or "@" is dropped whole; the others have their whitespace
 *     collapsed and are trimmed; empty parts dropped; joined with ", ";
 *  5. " ,;:" trimmed at both ends; at most 80 code points (then trimmed again).
 * "Tinted Theming (https://github.com/tinted-theming), Ayu Theme (https://…)" → "Tinted Theming, Ayu Theme".
 */
export function cleanAuthor(s: string | undefined): string {
  if (!s) return "";
  let t = controlsToSpace(s);
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "<") {
      const e = t.indexOf(">", i + 1);
      i = e < 0 ? t.length : e;
      continue;
    }
    out += t[i];
  }
  t = out;
  out = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") {
      const e = t.indexOf(")", i + 1);
      const inner = e < 0 ? t.slice(i + 1) : t.slice(i + 1, e);
      const bareDomain = words(inner).length === 1 && inner.includes(".") && !/[ \t\n\r\f\v]/.test(inner);
      if (linkish(inner) || bareDomain) {
        i = e < 0 ? t.length : e;
        continue;
      }
    }
    out += t[i];
  }
  const parts: string[] = [];
  for (const part of out.split(",")) {
    const w = words(part);
    if (w.length === 0 || w.some(linkish)) continue;
    parts.push(w.join(" "));
  }
  const r = trimChars(parts.join(", "), " ,;:");
  return trimChars(takeCodePoints(r, MAX_STRING), " ,;:");
}

// Latin-1 Supplement + Latin Extended-A letters → ASCII (for ids). Index = code point - 0xC0.
const FOLD_C0 =
  "a a a a a a ae c e e e e i i i i d n o o o o o _ o u u u u y th ss " + // U+00C0–00DF
  "a a a a a a ae c e e e e i i i i d n o o o o o _ o u u u u y th y " + // U+00E0–00FF
  "a a a a a a c c c c c c c c d d d d e e e e e e e e e e g g g g g g g g h h h h i i i i i i i i i i ij ij j j k k k " + // U+0100–0138
  "l l l l l l l l l l n n n n n n n n n o o o o o o oe oe r r r r r r s s s s s s s s t t t t t t u u u u u u u u u u u u w w y y y z z z z z z s"; // U+0139–017F
const FOLD: readonly string[] = FOLD_C0.split(" ");

function foldChar(cp: number): string {
  if (cp >= 0xc0 && cp <= 0x17f) {
    const f = FOLD[cp - 0xc0];
    return f === "_" ? "" : f;
  }
  return "";
}

/**
 * Theme id from a name: ASCII letters lower-cased and digits kept; Latin-1/Latin Extended-A letters folded to ASCII
 * (é → e, ß → ss); "+" becomes the word "plus"; every other character separates words; words joined with "-";
 * at most 64 characters (trailing "-" removed); "imported" when nothing is left. "Rosé Pine Moon" → "rose-pine-moon".
 */
export function slugify(name: string): string {
  const parts: string[] = [];
  let w = "";
  const flush = () => {
    if (w) parts.push(w);
    w = "";
  };
  for (const ch of name) {
    const cp = ch.codePointAt(0) as number;
    if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) w += ch;
    else if (cp >= 65 && cp <= 90) w += String.fromCharCode(cp + 32);
    else if (ch === "+") {
      flush();
      parts.push("plus");
    } else {
      const f = foldChar(cp);
      if (f) w += f;
      else flush();
    }
  }
  flush();
  let id = parts.join("-").slice(0, 64);
  while (id.endsWith("-")) id = id.slice(0, -1);
  return id || "imported";
}

const KNOWN_EXT = [".itermcolors", ".conf", ".toml", ".yml", ".yaml", ".json", ".jsonc", ".xresources", ".xrdb", ".theme", ".txt"];

/** Display name from a file name: the base name, a known extension removed, "_" → space, then cleanName. */
export function nameFromFile(hint: string | undefined): string {
  if (!hint) return "";
  const slash = Math.max(hint.lastIndexOf("/"), hint.lastIndexOf("\\"));
  let base = hint.slice(slash + 1);
  const lower = asciiLower(base);
  for (const e of KNOWN_EXT) {
    if (lower.endsWith(e) && base.length > e.length) {
      base = base.slice(0, base.length - e.length);
      break;
    }
  }
  return cleanName(base.split("_").join(" "));
}

// ---- collecting a palette ----------------------------------------------------------------------------------

const SLOTS = ["bg", "fg", "cursor", "selectionBg", "selectionFg"] as const;
type Slot = (typeof SLOTS)[number];

class Collect {
  v = new Map<string, string>(); // slot ("bg", "c3", …) → raw text, last assignment wins
  name = "";
  author = "";
  set(slot: string, raw: unknown): void {
    const t = text(raw);
    if (t !== undefined) this.v.set(slot, t);
  }
}

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

function build(format: ImportFormat, col: Collect, hint: string | undefined): Theme {
  const req = (slot: string): string => {
    const raw = col.v.get(slot);
    if (raw === undefined) fail("import-incomplete", `missing ${slot}`);
    const c = importColour(raw);
    if (!c) fail("import-bad-colour", `${slot} '${takeCodePoints(raw.trim(), 40)}'`);
    return c;
  };
  const bg = req("bg");
  const fg = req("fg");
  const ansi: string[] = [];
  for (let i = 0; i < 16; i++) ansi.push(req(`c${i}`));
  const palette: Record<string, unknown> = { bg, fg };
  for (const s of SLOTS as readonly Slot[]) {
    if (s === "bg" || s === "fg") continue;
    const raw = col.v.get(s);
    const c = raw === undefined ? null : importColour(raw);
    if (c) palette[s] = c;
  }
  palette.ansi = ansi;
  const name = cleanName(col.name) || nameFromFile(hint) || "Imported theme";
  const author = cleanAuthor(col.author);
  const theme: Record<string, unknown> = { format: "tinhat-theme", v: 1, id: slugify(name), name };
  if (author) theme.author = author;
  theme.source = `import:${format}`;
  theme.palette = palette;
  return theme as unknown as Theme;
}

// ---- formats -----------------------------------------------------------------------------------------------

function fromIterm(doc: unknown, col: Collect): void {
  if (!isObj(doc)) fail("bad-plist", "not a property list");
  const NUM = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
  const colour = (d: unknown): string | undefined => {
    if (!isObj(d)) return undefined;
    const ch = (k: string) => {
      const v = own(d, k);
      if (typeof v !== "string" || !NUM.test(v)) return -1;
      return Math.min(255, Math.max(0, Math.round(Number(v) * 255)));
    };
    const r = ch("Red Component");
    const g = ch("Green Component");
    const b = ch("Blue Component");
    if (r < 0 || g < 0 || b < 0) return "invalid";
    return "#" + hex2(r) + hex2(g) + hex2(b);
  };
  const keys: [string, string][] = [
    ["bg", "Background Color"],
    ["fg", "Foreground Color"],
    ["cursor", "Cursor Color"],
    ["selectionBg", "Selection Color"],
    ["selectionFg", "Selected Text Color"],
  ];
  for (let i = 0; i < 16; i++) keys.push([`c${i}`, `Ansi ${i} Color`]);
  for (const [slot, key] of keys) if (hasOwn(doc, key)) col.set(slot, colour(own(doc, key)));
}

function lines(t: string): string[] {
  return t.split("\n");
}

function fromKitty(t: string, col: Collect): void {
  const map: Record<string, string> = {
    foreground: "fg", background: "bg", cursor: "cursor", selection_background: "selectionBg", selection_foreground: "selectionFg",
  };
  for (const line of lines(t)) {
    const s = line.trim();
    if (s.startsWith("#")) {
      const m = /^##[ \t]*(name|author)[ \t]*:(.*)$/i.exec(s);
      if (m) {
        if (asciiLower(m[1]) === "name") col.name = m[2].trim();
        else col.author = m[2].trim();
      }
      continue;
    }
    const w = words(s);
    if (w.length < 2) continue;
    const m = /^color([0-9]{1,3})$/.exec(w[0]);
    if (m) {
      const n = Number(m[1]);
      if (n < 16) col.set(`c${n}`, w[1]);
    } else if (hasOwn(map, w[0])) col.set(map[w[0]], w[1]);
  }
}

function fromGhostty(t: string, col: Collect): void {
  const map: Record<string, string> = {
    background: "bg", foreground: "fg", "cursor-color": "cursor", "selection-background": "selectionBg",
    "selection-foreground": "selectionFg",
  };
  for (const line of lines(t)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    const val = s.slice(eq + 1).trim();
    if (key === "palette") {
      const m = /^([0-9]{1,3})[ \t]*=(.*)$/.exec(val);
      if (m && Number(m[1]) < 16) col.set(`c${Number(m[1])}`, m[2].trim());
    } else if (hasOwn(map, key)) col.set(map[key], val);
  }
}

function fromXresources(t: string, col: Collect): void {
  const defines = new Map<string, string>();
  const res = new Map<string, string>();
  const names: Record<string, string> = {
    foreground: "fg", background: "bg", cursorColor: "cursor", highlightColor: "selectionBg", highlightTextColor: "selectionFg",
  };
  for (const line of lines(t)) {
    const s = line.trim();
    if (!s || s.startsWith("!")) continue;
    if (s.startsWith("#")) {
      const m = /^#[ \t]*define[ \t]+(\S+)[ \t]+(.*)$/.exec(s);
      if (m) defines.set(m[1], m[2].trim());
      continue;
    }
    const colon = s.indexOf(":");
    if (colon < 0) continue;
    const spec = s.slice(0, colon).trim();
    const name = spec.slice(Math.max(spec.lastIndexOf("*"), spec.lastIndexOf(".")) + 1);
    const m = /^color([0-9]{1,3})$/.exec(name);
    const slot = m ? (Number(m[1]) < 16 ? `c${Number(m[1])}` : "") : hasOwn(names, name) ? names[name] : "";
    if (slot) res.set(slot, s.slice(colon + 1).trim());
  }
  const expand = (v: string): string => {
    let x = v;
    for (let k = 0; k < 8 && defines.has(x); k++) x = defines.get(x) as string;
    return x;
  };
  if (res.size > 0) {
    for (const [slot, v] of res) col.set(slot, expand(v));
    return;
  }
  // the iTerm2 collection's xrdb files: only #defines with fixed names
  const xrdb: [string, string][] = [
    ["bg", "Background_Color"],
    ["fg", "Foreground_Color"],
    ["cursor", "Cursor_Color"],
    ["selectionBg", "Selection_Color"],
    ["selectionFg", "Selected_Text_Color"],
  ];
  for (let i = 0; i < 16; i++) xrdb.push([`c${i}`, `Ansi_${i}_Color`]);
  for (const [slot, d] of xrdb) if (defines.has(d)) col.set(slot, expand(d));
}

function fromAlacritty(doc: unknown, col: Collect): void {
  const c = get(doc, "colors");
  col.set("bg", get(c, "primary", "background"));
  col.set("fg", get(c, "primary", "foreground"));
  col.set("cursor", get(c, "cursor", "cursor"));
  col.set("selectionBg", get(c, "selection", "background"));
  col.set("selectionFg", get(c, "selection", "text"));
  ANSI_NAMES.forEach((n, i) => {
    col.set(`c${i}`, get(c, "normal", n));
    col.set(`c${i + 8}`, get(c, "bright", n));
  });
}

function fromWezterm(doc: unknown, col: Collect): void {
  const c = get(doc, "colors");
  col.set("bg", get(c, "background"));
  col.set("fg", get(c, "foreground"));
  col.set("cursor", get(c, "cursor_bg"));
  col.set("selectionBg", get(c, "selection_bg"));
  col.set("selectionFg", get(c, "selection_fg"));
  const ansi = get(c, "ansi");
  const brights = get(c, "brights");
  for (let i = 0; i < 8; i++) {
    if (Array.isArray(ansi)) col.set(`c${i}`, ansi[i]);
    if (Array.isArray(brights)) col.set(`c${i + 8}`, brights[i]);
  }
  col.name = text(get(doc, "metadata", "name")) ?? "";
  col.author = text(get(doc, "metadata", "author")) ?? "";
}

function fromWindowsTerminal(o: Obj, col: Collect): void {
  const keys: [string, string][] = [
    ["bg", "background"],
    ["fg", "foreground"],
    ["cursor", "cursorColor"],
    ["selectionBg", "selectionBackground"],
  ];
  const wt = ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white"];
  wt.forEach((n, i) => {
    keys.push([`c${i}`, n]);
    keys.push([`c${i + 8}`, "bright" + n[0].toUpperCase() + n.slice(1)]);
  });
  for (const [slot, k] of keys) col.set(slot, own(o, k));
  const name = own(o, "name");
  col.name = typeof name === "string" ? name : "";
}

const B16 = ["00", "08", "0B", "0A", "0D", "0E", "0C", "05", "03", "08", "0B", "0A", "0D", "0E", "0C", "07"];
const B24 = ["00", "08", "0B", "0A", "0D", "0E", "0C", "05", "03", "12", "14", "13", "16", "17", "15", "07"];

function fromBase(doc: unknown): { format: ImportFormat; col: Collect } {
  if (!isObj(doc)) fail("unknown-format", "not a theme file this app understands");
  const palette = own(doc, "palette");
  const pal = isObj(palette) ? palette : doc;
  const base = new Map<string, unknown>();
  for (const k of Object.keys(pal)) if (/^base[0-9A-Fa-f]{2}$/.test(k)) base.set("base" + k.slice(4).toUpperCase(), own(pal, k));
  const system = text(own(doc, "system"));
  let format: ImportFormat;
  if (system === "base24") format = "base24";
  else if (system === "base16") format = "base16";
  else if (system !== undefined) fail("unknown-format", "not a theme file this app understands");
  else format = ["10", "11", "12", "13", "14", "15", "16", "17"].every((x) => base.has(`base${x}`)) ? "base24" : "base16";
  const map = format === "base24" ? B24 : B16;
  const col = new Collect();
  col.set("bg", base.get("base00"));
  col.set("fg", base.get("base05"));
  col.set("cursor", base.get("base05"));
  col.set("selectionBg", base.get("base02"));
  map.forEach((b, i) => col.set(`c${i}`, base.get(`base${b}`)));
  col.name = text(own(doc, "name")) ?? text(own(doc, "scheme")) ?? "";
  col.author = text(own(doc, "author")) ?? "";
  return { format, col };
}

// ---- detection ---------------------------------------------------------------------------------------------

const RE_TOML_HEADER = /^[ \t]*\[\[?[ \t]*[A-Za-z0-9_."' -]+[ \t]*\]\]?[ \t]*(#.*)?$/;
const RE_TOML_COLORS = /^[ \t]*colors\.[A-Za-z0-9_.]+[ \t]*=/;
const RE_BASE = /^[ \t]*["']?base0[0-9A-Fa-f]["']?[ \t]*:/;
const RE_ALACRITTY_YAML = /^colors:[ \t]*(#.*)?$/;
const RE_GHOSTTY = /^[ \t]*(palette|background|foreground|cursor-color|selection-background|selection-foreground)[ \t]*=/;
const RE_KITTY = /^[ \t]*(color[0-9]{1,3}|foreground|background|cursor|selection_background|selection_foreground)[ \t]+\S/;
const RE_XRES = /^[A-Za-z0-9_.*-]*(color[0-9]{1,3}|foreground|background|cursorColor)[ \t]*:/;
const RE_XRDB = /^[ \t]*#[ \t]*define[ \t]+(Ansi_[0-9]+_Color|Background_Color|Foreground_Color)[ \t]/;

type Kind = "plist" | "json" | "toml" | "base" | "alacritty-yaml" | "ghostty" | "kitty" | "xresources";

/** Content-based detection, first match wins in this order: plist, JSON, TOML, base16/24, Alacritty YAML, Ghostty, kitty, Xresources. */
function detectKind(t: string): Kind | null {
  const ls = lines(t);
  const first = ls.find((l) => l.trim() !== "");
  if (first !== undefined && first.trim().startsWith("<")) return /<plist[\s>]/.test(t) ? "plist" : null;
  for (const l of ls) {
    const x = l.trim();
    if (x === "" || x.startsWith("#") || x.startsWith("//")) continue;
    if (x.startsWith("{")) return "json";
    break;
  }
  if (ls.some((l) => RE_TOML_HEADER.test(l) || RE_TOML_COLORS.test(l))) return "toml";
  if (ls.some((l) => RE_BASE.test(l))) return "base";
  if (ls.some((l) => RE_ALACRITTY_YAML.test(l))) return "alacritty-yaml";
  if (ls.some((l) => RE_GHOSTTY.test(l))) return "ghostty";
  if (ls.some((l) => RE_KITTY.test(l))) return "kitty";
  if (ls.some((l) => RE_XRES.test(l) || RE_XRDB.test(l))) return "xresources";
  return null;
}

function unknown(): never {
  fail("unknown-format", "not a theme file this app understands");
}

function run(input: string, hint: string | undefined): { format: ImportFormat; theme: Theme } {
  if (typeof input !== "string") fail("import-empty", "nothing to import");
  // the text as Unicode scalar values: a lone surrogate reads as U+FFFD, exactly what any UTF-8 transfer gives the
  // desktop (which can only ever see that); same byte count (3)
  input = toWellFormed(input);
  if (typeof hint === "string") hint = toWellFormed(hint);
  const bytes = utf8Length(input);
  if (bytes > MAX_IMPORT_BYTES) fail("import-too-large", `${bytes} bytes (max ${MAX_IMPORT_BYTES})`);
  let t = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  t = t.split("\r\n").join("\n").split("\r").join("\n");
  if (t.trim() === "") fail("import-empty", "nothing to import");
  const kind = detectKind(t);
  const col = new Collect();
  switch (kind) {
    case "plist":
      fromIterm(parsePlist(t), col);
      return { format: "iterm2", theme: build("iterm2", col, hint) };
    case "json": {
      const doc = parseJsonc(t);
      if (!isObj(doc)) unknown();
      if (own(doc, "format") === "tinhat-theme") return { format: "tinhat", theme: doc as unknown as Theme };
      const schemes = own(doc, "schemes");
      const scheme = Array.isArray(schemes) ? schemes.find((x) => isObj(x)) : doc;
      if (!isObj(scheme) || (!hasOwn(scheme, "background") && !hasOwn(scheme, "black"))) unknown();
      fromWindowsTerminal(scheme, col);
      return { format: "windows-terminal", theme: build("windows-terminal", col, hint) };
    }
    case "toml": {
      const doc = parseToml(t);
      const c = get(doc, "colors");
      if (isObj(c) && (isObj(own(c, "primary")) || isObj(own(c, "normal")) || isObj(own(c, "bright")))) {
        fromAlacritty(doc, col);
        return { format: "alacritty-toml", theme: build("alacritty-toml", col, hint) };
      }
      if (isObj(c) && (hasOwn(c, "ansi") || hasOwn(c, "brights") || hasOwn(c, "cursor_bg") || hasOwn(c, "selection_bg"))) {
        fromWezterm(doc, col);
        return { format: "wezterm", theme: build("wezterm", col, hint) };
      }
      return unknown();
    }
    case "base": {
      const r = fromBase(parseYaml(t));
      return { format: r.format, theme: build(r.format, r.col, hint) };
    }
    case "alacritty-yaml": {
      const doc = parseYaml(t);
      if (!isObj(get(doc, "colors"))) unknown();
      fromAlacritty(doc, col);
      return { format: "alacritty-yaml", theme: build("alacritty-yaml", col, hint) };
    }
    case "ghostty":
      fromGhostty(t, col);
      return { format: "ghostty", theme: build("ghostty", col, hint) };
    case "kitty":
      fromKitty(t, col);
      return { format: "kitty", theme: build("kitty", col, hint) };
    case "xresources":
      fromXresources(t, col);
      return { format: "xresources", theme: build("xresources", col, hint) };
    default:
      return unknown();
  }
}

/** ENGINE.md §7. Never throws for bad input. */
export function importTheme(text: string, filenameHint?: string): ImportResult {
  try {
    const r = run(text, filenameHint);
    return { ok: true, format: r.format, theme: r.theme };
  } catch (x) {
    if (x instanceof ImportError || x instanceof ParseError) return { ok: false, error: `${x.code}: ${x.detail}` };
    throw x;
  }
}

/** Every string of an imported theme obeys the engine's limits (used by the library build as a self-check). */
export function withinLimits(theme: Theme): boolean {
  const strs = [theme.id, theme.name, theme.author ?? "", theme.source ?? ""];
  return strs.every((s) => codePoints(s) <= MAX_STRING && !containsUrl(s));
}
