// keys.ts — key sequences (ACTIONS.md §8.1): parsing a sequence into its canonical text, and the web's key classes.
// Pure; ASCII case folding only (never toLowerCase / toUpperCase, which fold non-ASCII letters too); no regexes.
// The desktop's crates/actions/src/keys.rs is the same code, proven by the shared vectors (testvectors/actions/keys/).
import type { Json } from "../layout/json";
import { has, isStr } from "../layout/json";
import { TABLE } from "./table";

export interface Sequence {
  ok: true;
  /** canonical text: Ctrl, Alt, Shift, Meta (in this order) then the key, joined by "+"; a bare modifier alone */
  text: string;
  /** the key: A–Z, 0–9, F1–F24, a named key, a punctuation character — or the modifier of a bare-modifier sequence */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** a modifier held on its own (push to talk) */
  bare: boolean;
}
export type SequenceResult = Sequence | { ok: false; error: string };

export const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const isModifierName = (s: string): boolean => (MODIFIERS as readonly string[]).includes(s);

/** ASCII-only lower case. */
export function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 0x20) a++;
  while (b > a && s.charCodeAt(b - 1) === 0x20) b--;
  return s.slice(a, b);
}

const alias = (l: string): string | undefined => (has(TABLE.keys.aliases, l) ? TABLE.keys.aliases[l] : undefined);

/** A token as a modifier (canonical name) or undefined. */
function asModifier(tok: string): string | undefined {
  const l = asciiLower(tok);
  for (const m of MODIFIERS) if (asciiLower(m) === l) return m;
  const al = alias(l);
  return al !== undefined && isModifierName(al) ? al : undefined;
}

/** "f1".."f24" (ASCII case-insensitive, no leading zero) → "F1".."F24". */
function asFunctionKey(l: string): string | undefined {
  if (l.length < 2 || l.length > 3 || l.charCodeAt(0) !== 0x66) return undefined;
  let n = 0;
  for (let i = 1; i < l.length; i++) {
    const d = l.charCodeAt(i);
    if (d < 0x30 || d > 0x39) return undefined;
    if (i === 1 && d === 0x30) return undefined;
    n = n * 10 + (d - 0x30);
  }
  return n >= 1 && n <= TABLE.keys.function ? `F${n}` : undefined;
}

/** A token as a key (canonical name) or undefined. */
function asKey(tok: string): string | undefined {
  if (tok.length === 1) {
    const c = tok.charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 32);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)) return tok;
    if (TABLE.keys.punctuation.includes(tok)) return tok;
    return undefined;
  }
  const l = asciiLower(tok);
  const f = asFunctionKey(l);
  if (f !== undefined) return f;
  for (const k of TABLE.keys.named) if (asciiLower(k) === l) return k;
  const al = alias(l);
  return al !== undefined && !isModifierName(al) ? al : undefined;
}

/** The number of UTF-16-independent code points of a string. */
function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Parse a key sequence (ACTIONS.md §8.1). The first failure: not-string, empty, too-long (more than
 * limits.sequenceChars code points), then per token left to right: empty-token, key-not-last (a modifier after the
 * key), duplicate-modifier, two-keys, unknown-key; finally no-key (only modifiers, more than one).
 */
export function parseSequence(text: Json | undefined): SequenceResult {
  if (!isStr(text)) return { ok: false, error: "not-string" };
  if (text.length === 0) return { ok: false, error: "empty" };
  if (cpLength(text) > (TABLE.limits.sequenceChars ?? 64)) return { ok: false, error: "too-long" };
  // spaces around the whole text go first, so a trailing "+" key is still seen ("Ctrl++ ")
  const t = trimSpaces(text);
  let toks: string[];
  if (t === "+") toks = ["+"];
  else if (t.endsWith("++")) toks = [...t.slice(0, -2).split("+"), "+"];
  else toks = t.split("+");
  const mods: Record<string, boolean> = { Ctrl: false, Alt: false, Shift: false, Meta: false };
  let key: string | undefined;
  let nMods = 0;
  for (const raw of toks) {
    const tok = trimSpaces(raw);
    if (tok.length === 0) return { ok: false, error: "empty-token" };
    const m = asModifier(tok);
    if (m !== undefined) {
      if (key !== undefined) return { ok: false, error: "key-not-last" };
      if (mods[m]) return { ok: false, error: "duplicate-modifier" };
      mods[m] = true;
      nMods++;
      continue;
    }
    const k = asKey(tok);
    if (key !== undefined) return { ok: false, error: "two-keys" };
    if (k === undefined) return { ok: false, error: "unknown-key" };
    key = k;
  }
  if (key === undefined) {
    if (nMods === 1 && toks.length === 1) {
      const m = MODIFIERS.find((x) => mods[x]) as string;
      return { ok: true, text: m, key: m, ctrl: false, alt: false, shift: false, meta: false, bare: true };
    }
    return { ok: false, error: "no-key" };
  }
  return { ok: true, text: chordText(key, mods.Ctrl, mods.Alt, mods.Shift, mods.Meta), key, ctrl: mods.Ctrl, alt: mods.Alt, shift: mods.Shift, meta: mods.Meta, bare: false };
}

/** The canonical text of a key press: the flags + the key (the key already canonical). */
export function chordText(key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean): string {
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  if (meta) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

/** How browsers treat a canonical sequence: reserved (never reaches a page), browser (the page takes it while focus is
 *  inside Tin Hat; the browser's own use is lost there) or free. */
export function webClass(canonical: string): "reserved" | "browser" | "free" {
  if (TABLE.webKeys.reserved.includes(canonical)) return "reserved";
  if (TABLE.webKeys.browser.includes(canonical)) return "browser";
  return "free";
}

/** F1–F24. */
export function isFunctionKey(key: string): boolean {
  return key.length >= 2 && key.charCodeAt(0) === 0x46 && asFunctionKey(asciiLower(key)) === key;
}
