// note.ts — the Sticky note's rules (contract WIDGETS.md §14, vectors testvectors/widgets/note/*): one plain-text note
// per space in the space's `dev.tinhat.note` state (key ""), `{text, v: 1}`, at most 500 code points; links (http /
// https) are clickable. What a stored note reads as, what Save writes, the counter, the link segments and the Small
// line. Pure; the desktop's Rust port (crates/widgets/src/note.rs) runs the same vectors (code points, ASCII rules).

export const NOTE_TYPE = "dev.tinhat.note";
/** A note holds at most this many code points. */
export const NOTE_MAX = 500;
/** The counter turns to its "near the limit" colour from this many. */
export const NOTE_NEAR = 450;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isWs = (c: string) => c === " " || (c >= "\t" && c <= "\r");

/** CR LF and lone CR → LF; ASCII whitespace trimmed from both ends of the whole text (inner lines are kept). */
export function normalizeNote(s: string): string {
  const t = s.replace(/\r\n?/g, "\n");
  const cps = [...t];
  let a = 0;
  let b = cps.length;
  while (a < b && isWs(cps[a]!)) a++;
  while (b > a && isWs(cps[b - 1]!)) b--;
  return cps.slice(a, b).join("");
}

const cpLen = (s: string) => [...s].length;

/** A space's note content → the text shown, or null (no note): an object with a string `text`, normalized, not empty;
 *  longer than NOTE_MAX (another client) → cut to NOTE_MAX code points. */
export function noteOf(content: unknown): string | null {
  if (!isObj(content) || typeof content.text !== "string") return null;
  const t = normalizeNote(content.text);
  if (!t) return null;
  const cps = [...t];
  return cps.length > NOTE_MAX ? cps.slice(0, NOTE_MAX).join("") : t;
}

export type NoteSave = { ok: true; content: { text: string; v: 1 } | Record<string, never> } | { ok: false; reason: "tooLong" };

/** What Save writes for the typed text: normalized; "" → `{}` (the note is cleared); over NOTE_MAX → refused. */
export function noteToSave(input: string): NoteSave {
  const t = normalizeNote(input);
  if (!t) return { ok: true, content: {} };
  if (cpLen(t) > NOTE_MAX) return { ok: false, reason: "tooLong" };
  return { ok: true, content: { text: t, v: 1 } };
}

/** The editor's counter "n / 500": n = code points of what Save would write; near from NOTE_NEAR, over past NOTE_MAX. */
export function noteCounter(input: string): { count: number; max: number; near: boolean; over: boolean } {
  const n = cpLen(normalizeNote(input));
  return { count: n, max: NOTE_MAX, near: n >= NOTE_NEAR, over: n > NOTE_MAX };
}

export interface NoteSeg {
  text: string;
  /** a link: open this */
  url?: string;
}

const TRAIL = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const isAlnum = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
const stops = (c: string) => isWs(c) || c === "<" || c === ">" || c === '"' || c < " ";

/**
 * The note's text as plain and link segments (in order; joined they give the text back). A link starts at "http://" or
 * "https://" (the scheme in any ASCII case) not preceded by an ASCII letter or digit, runs until ASCII whitespace, a
 * control character or one of < > ", and then loses trailing . , ; : ! ? ' " and any closing ) ] } that has no opener
 * inside the link; it needs at least one character after "://".
 */
export function noteSegments(text: string): NoteSeg[] {
  const cps = [...text];
  const out: NoteSeg[] = [];
  let plain = "";
  let i = 0;
  const lower = (c: string) => (c >= "A" && c <= "Z" ? String.fromCharCode(c.charCodeAt(0) + 32) : c);
  const at = (k: number, s: string) => k + s.length <= cps.length && [...s].every((ch, n) => lower(cps[k + n]!) === ch);
  while (i < cps.length) {
    const scheme = at(i, "https://") ? 8 : at(i, "http://") ? 7 : 0;
    if (scheme && (i === 0 || !isAlnum(cps[i - 1]!))) {
      let j = i + scheme;
      while (j < cps.length && !stops(cps[j]!)) j++;
      // trim the trailing punctuation and unbalanced closers
      let end = j;
      for (;;) {
        if (end <= i + scheme) break;
        const c = cps[end - 1]!;
        if (TRAIL.has(c)) {
          end--;
          continue;
        }
        const open = CLOSE[c];
        if (open) {
          const inner = cps.slice(i, end - 1);
          const opens = inner.filter((x) => x === open).length;
          const closes = inner.filter((x) => x === c).length;
          if (opens <= closes) {
            end--;
            continue;
          }
        }
        break;
      }
      if (end > i + scheme) {
        if (plain) out.push({ text: plain });
        plain = "";
        const url = cps.slice(i, end).join("");
        out.push({ text: url, url });
        i = end;
        continue;
      }
    }
    plain += cps[i];
    i++;
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** The Small / collapsed line: the note's first line that is not blank, ASCII whitespace collapsed, at most 140 code
 *  points (+ "…"); no note → "". */
export function noteFirstLine(text: string | null): string {
  if (!text) return "";
  for (const line of text.split("\n")) {
    let out = "";
    let pend = false;
    for (const ch of line) {
      if (isWs(ch)) {
        pend = out.length > 0;
        continue;
      }
      if (pend) out += " ";
      pend = false;
      out += ch;
    }
    if (!out) continue;
    const cps = [...out];
    if (cps.length <= 140) return out;
    const cut = cps.slice(0, 140).join("");
    return (cut.endsWith(" ") ? cut.slice(0, -1) : cut) + "…";
  }
  return "";
}
