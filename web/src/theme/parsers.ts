// parsers.ts — the small, dependency-free document parsers the importers need (ENGINE.md §7): JSON with
// comments, the plist XML of .itermcolors, TOML and a YAML subset. They build plain JS values; scalars stay
// strings (no number/bool typing) except JSON. Errors are thrown as ParseError(code, detail) with fixed texts
// (line numbers count "\n"); import.ts turns them into "<code>: <detail>". Imports only the shared limits.
//
// Rules shared with the Rust port (ENGINE.md §9, PORT-QUESTIONS Q1–Q3):
// - every key is an ordinary OWN key: documents are null-prototype objects, so `__proto__`, `constructor`,
//   `toString` … are data like any other key (never the prototype, never an inherited value);
// - at most MAX_NESTING (128) nested arrays/objects: JSON values, TOML arrays + inline tables, YAML block + flow
//   collections, plist dict/array — the 129th level is the parser's usual error (never a stack overflow);
// - JSON strings and keys hold no lone surrogate (a `\u` escape that leaves one is `bad-json`).
import { MAX_NESTING, isJsonData } from "./limits";

export class ParseError {
  code: string;
  detail: string;
  constructor(code: string, detail: string) {
    this.code = code;
    this.detail = detail;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
/** A document object: no prototype, so every key — `__proto__` and `constructor` too — is an ordinary own key. */
const newObj = (): Obj => Object.create(null) as Obj;
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/**
 * `String(v)` of a document value, spelled out: a null-prototype object has no `toString`, so `String()` would
 * throw on it (or on an array holding one). null → "", arrays join their items with "," (null items → ""),
 * objects → "[object Object]" — exactly what `String()` gave for plain-object documents, and the port's rule.
 */
const jsString = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : typeof v === "string"
      ? v
      : Array.isArray(v)
        ? v.map(jsString).join(",")
        : isObj(v)
          ? "[object Object]"
          : String(v);

/** Marker for TOML values that are not strings (numbers, booleans, dates): kept verbatim, never a colour. */
export class RawToken {
  raw: string;
  constructor(raw: string) {
    this.raw = raw;
  }
}

// ---- JSON with comments ------------------------------------------------------------------------------------

/**
 * JSON that may carry comments (`//` and `#` to end of line, `/* … *\/`) outside strings and trailing commas —
 * Windows Terminal settings and pasted snippets. Comments and trailing commas are removed, then strict JSON.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "#" || (ch === "/" && text[i + 1] === "/")) {
      while (i < n && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // trailing commas: a ',' whose next non-space character is '}' or ']'
  let clean = "";
  for (let k = 0; k < out.length; k++) {
    const ch = out[k];
    if (ch === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      clean += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (ch === ",") {
      let j = k + 1;
      while (j < out.length && (out[j] === " " || out[j] === "\t" || out[j] === "\n" || out[j] === "\r")) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    clean += ch;
  }
  let v: unknown;
  try {
    v = JSON.parse(clean);
  } catch {
    throw new ParseError("bad-json", "not valid JSON");
  }
  // what the Rust port can parse: nesting ≤ 128, no lone surrogate in a string or key
  if (!isJsonData(v)) throw new ParseError("bad-json", "not valid JSON");
  return v;
}

// ---- plist XML (.itermcolors) ------------------------------------------------------------------------------

interface XNode {
  tag: string;
  kids: XNode[];
  text: string;
}

function xmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
  });
}

function parseXml(text: string): XNode {
  const bad = () => new ParseError("bad-plist", "not a property list");
  const root: XNode = { tag: "", kids: [], text: "" };
  const stack: XNode[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    const chunk = text.slice(i, lt < 0 ? n : lt);
    if (chunk) stack[stack.length - 1].text += xmlUnescape(chunk);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      if (e < 0) throw bad();
      i = e + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt + 9);
      if (e < 0) throw bad();
      stack[stack.length - 1].text += text.slice(lt + 9, e);
      i = e + 3;
    } else if (text.startsWith("<?", lt)) {
      const e = text.indexOf("?>", lt + 2);
      if (e < 0) throw bad();
      i = e + 2;
    } else if (text.startsWith("<!", lt)) {
      // <!DOCTYPE …> with an optional [internal subset]
      let j = lt + 2;
      let depth = 0;
      while (j < n && (text[j] !== ">" || depth > 0)) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        j++;
      }
      if (j >= n) throw bad();
      i = j + 1;
    } else {
      const e = text.indexOf(">", lt + 1);
      if (e < 0) throw bad();
      const body = text.slice(lt + 1, e).trim();
      i = e + 1;
      if (body.startsWith("/")) {
        const tag = body.slice(1).trim();
        const top = stack.pop();
        if (!top || top.tag !== tag || stack.length === 0) throw bad();
      } else {
        const selfClose = body.endsWith("/");
        const tag = (selfClose ? body.slice(0, -1) : body).trim().split(/[\s]/)[0];
        if (!tag) throw bad();
        const node: XNode = { tag, kids: [], text: "" };
        stack[stack.length - 1].kids.push(node);
        if (!selfClose) stack.push(node);
      }
    }
  }
  if (stack.length !== 1) throw bad();
  return root;
}

/** A plist value; a dict or array deeper than MAX_NESTING (the top value is level 1) is not a property list. */
function plistValue(x: XNode, depth: number): unknown {
  switch (x.tag) {
    case "dict": {
      if (depth > MAX_NESTING) throw new ParseError("bad-plist", "not a property list");
      const o = newObj();
      for (let k = 0; k + 1 < x.kids.length; k += 2) {
        if (x.kids[k].tag !== "key") throw new ParseError("bad-plist", "not a property list");
        o[x.kids[k].text] = plistValue(x.kids[k + 1], depth + 1);
      }
      return o;
    }
    case "array":
      if (depth > MAX_NESTING) throw new ParseError("bad-plist", "not a property list");
      return x.kids.map((kid) => plistValue(kid, depth + 1));
    case "true":
      return "true";
    case "false":
      return "false";
    default:
      return x.text.trim(); // real, integer, string, date, data: text
  }
}

/** A plist document → its top value (a dict becomes an object whose values are objects/arrays/strings). */
export function parsePlist(text: string): unknown {
  const root = parseXml(text);
  const plist = root.kids.find((k) => k.tag === "plist");
  if (!plist || plist.kids.length < 1) throw new ParseError("bad-plist", "not a property list");
  return plistValue(plist.kids[0], 1);
}

// ---- TOML --------------------------------------------------------------------------------------------------

class Toml {
  s: string;
  i = 0;
  line = 1;
  depth = 0; // nested arrays + inline tables of the value being read
  root: Obj = newObj();
  constructor(s: string) {
    this.s = s;
  }
  fail(): never {
    throw new ParseError("bad-toml", `line ${this.line}`);
  }
  peek(k = 0): string {
    return this.s[this.i + k] ?? "";
  }
  /** spaces and tabs */
  ws(): void {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }
  /** spaces, tabs, newlines and comments */
  wsnl(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r") this.i++;
      else if (c === "\n") {
        this.i++;
        this.line++;
      } else if (c === "#") {
        while (this.i < this.s.length && this.peek() !== "\n") this.i++;
      } else return;
    }
  }
  /** after a statement: optional spaces, optional comment, then newline or end */
  eol(): void {
    this.ws();
    if (this.peek() === "#") while (this.i < this.s.length && this.peek() !== "\n") this.i++;
    if (this.peek() === "\r") this.i++;
    if (this.i >= this.s.length) return;
    if (this.peek() !== "\n") this.fail();
    this.i++;
    this.line++;
  }
  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === '"') parts.push(this.basic());
      else if (c === "'") parts.push(this.literal());
      else {
        const start = this.i;
        while (/[A-Za-z0-9_-]/.test(this.peek())) this.i++;
        if (this.i === start) this.fail();
        parts.push(this.s.slice(start, this.i));
      }
      this.ws();
      if (this.peek() !== ".") return parts;
      this.i++;
    }
  }
  basic(): string {
    this.i++; // "
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "" || c === "\n") this.fail();
      this.i++;
      if (c === '"') return out;
      if (c === "\\") out += this.escape();
      else out += c;
    }
  }
  escape(): string {
    const e = this.peek();
    this.i++;
    const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
    if (hasOwn(map, e)) return map[e];
    const len = e === "u" ? 4 : e === "U" ? 8 : e === "x" ? 2 : 0;
    if (!len) this.fail();
    const hex = this.s.slice(this.i, this.i + len);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) this.fail();
    this.i += len;
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail();
    return String.fromCodePoint(cp);
  }
  literal(): string {
    const end = this.s.indexOf("'", this.i + 1);
    const nl = this.s.indexOf("\n", this.i + 1);
    if (end < 0 || (nl >= 0 && nl < end)) this.fail();
    const v = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return v;
  }
  multiline(q: string): string {
    this.i += 3;
    if (this.peek() === "\r" && this.peek(1) === "\n") this.i++;
    if (this.peek() === "\n") {
      this.i++;
      this.line++;
    }
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail();
      if (this.s.startsWith(q + q + q, this.i)) {
        this.i += 3;
        while (this.peek() === q && !this.s.startsWith(q + q + q, this.i)) {
          out += q;
          this.i++;
        }
        return out;
      }
      const c = this.peek();
      this.i++;
      if (c === "\n") this.line++;
      if (q === '"' && c === "\\") {
        // line-ending backslash: trim whitespace and newlines up to the next content
        if (/[ \t\r\n]/.test(this.peek())) {
          let j = this.i;
          while (/[ \t\r]/.test(this.s[j] ?? "")) j++;
          if (this.s[j] === "\n") {
            while (/[ \t\r\n]/.test(this.s[j] ?? "")) {
              if (this.s[j] === "\n") this.line++;
              j++;
            }
            this.i = j;
            continue;
          }
        }
        out += this.escape();
      } else out += c;
    }
  }
  value(): unknown {
    const c = this.peek();
    if (c === '"') return this.s.startsWith('"""', this.i) ? this.multiline('"') : this.basic();
    if (c === "'") return this.s.startsWith("'''", this.i) ? this.multiline("'") : this.literal();
    if (c === "[") {
      if (++this.depth > MAX_NESTING) this.fail();
      this.i++;
      const arr: unknown[] = [];
      for (;;) {
        this.wsnl();
        if (this.peek() === "]") {
          this.i++;
          this.depth--;
          return arr;
        }
        arr.push(this.value());
        this.wsnl();
        if (this.peek() === ",") {
          this.i++;
          continue;
        }
        if (this.peek() === "]") {
          this.i++;
          this.depth--;
          return arr;
        }
        this.fail();
      }
    }
    if (c === "{") {
      if (++this.depth > MAX_NESTING) this.fail();
      this.i++;
      const t = newObj();
      this.ws();
      if (this.peek() === "}") {
        this.i++;
        this.depth--;
        return t;
      }
      for (;;) {
        const k = this.key();
        if (this.peek() !== "=") this.fail();
        this.i++;
        this.ws();
        this.assign(t, k, this.value());
        this.ws();
        if (this.peek() === ",") {
          this.i++;
          this.ws();
          continue;
        }
        if (this.peek() === "}") {
          this.i++;
          this.depth--;
          return t;
        }
        this.fail();
      }
    }
    const start = this.i;
    while (this.i < this.s.length && !/[ \t\r\n,\]}#]/.test(this.peek())) this.i++;
    if (this.i === start) this.fail();
    return new RawToken(this.s.slice(start, this.i));
  }
  table(path: string[], from: Obj = this.root): Obj {
    let t = from;
    for (const p of path) {
      let next = hasOwn(t, p) ? t[p] : undefined;
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isObj(next) || next instanceof RawToken) {
        next = newObj();
        t[p] = next;
      }
      t = next as Obj;
    }
    return t;
  }
  assign(t: Obj, path: string[], v: unknown): void {
    const owner = this.table(path.slice(0, -1), t);
    owner[path[path.length - 1]] = v;
  }
  parse(): Obj {
    let current = this.root;
    for (;;) {
      this.wsnl();
      if (this.i >= this.s.length) return this.root;
      if (this.peek() === "[") {
        const arrayTable = this.peek(1) === "[";
        this.i += arrayTable ? 2 : 1;
        const path = this.key();
        if (this.peek() !== "]" || (arrayTable && this.peek(1) !== "]")) this.fail();
        this.i += arrayTable ? 2 : 1;
        if (arrayTable) {
          const owner = this.table(path.slice(0, -1));
          const last = path[path.length - 1];
          const old = hasOwn(owner, last) ? owner[last] : undefined;
          const arr = Array.isArray(old) ? (old as unknown[]) : [];
          owner[last] = arr;
          current = newObj();
          arr.push(current);
        } else current = this.table(path);
        this.eol();
      } else {
        const k = this.key();
        if (this.peek() !== "=") this.fail();
        this.i++;
        this.ws();
        this.assign(current, k, this.value());
        this.eol();
      }
    }
  }
}

/** TOML → nested objects; strings stay strings, other scalars become {raw}. */
export function parseToml(text: string): Obj {
  return new Toml(text).parse();
}

// ---- YAML subset -------------------------------------------------------------------------------------------
// Block mappings and sequences by indentation (spaces), plain / 'single' / "double" quoted scalars, one-line flow
// collections ({…} / […]), comments, block scalars (| >, kept as text). No anchors/aliases/tags semantics, no
// multi-line flow collections or multi-line quoted scalars (a line error). Every scalar is a string (null = empty).

interface YLine {
  n: number; // 1-based line number
  indent: number;
  text: string; // content after the indentation, trailing spaces removed
}

class Yaml {
  lines: YLine[] = [];
  constructor(text: string) {
    const raw = text.split("\n");
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k].replace(/[ \t\r]+$/, "");
      let ind = 0;
      while (l[ind] === " ") ind++;
      const t = l.slice(ind);
      if (t === "" || t[0] === "#") continue;
      if (ind === 0 && (t === "---" || t.startsWith("--- ") || t === "..." || t[0] === "%")) continue;
      if (t[0] === "\t") throw new ParseError("bad-yaml", `line ${k + 1}`);
      this.lines.push({ n: k + 1, indent: ind, text: t });
    }
  }
  fail(n: number): never {
    throw new ParseError("bad-yaml", `line ${n}`);
  }
  static isSeq(t: string): boolean {
    return t === "-" || t.startsWith("- ") || t.startsWith("-\t");
  }
  /** "key: rest" → [key, rest] (key unquoted), or null when the text is not a mapping entry. */
  static splitKey(t: string): [string, string] | null {
    if (t[0] === "{" || t[0] === "[") return null;
    if (t[0] === '"' || t[0] === "'") {
      const q = t[0];
      let j = 1;
      let key = "";
      for (; j < t.length; j++) {
        if (t[j] === "\\" && q === '"') {
          key += t[j + 1] ?? "";
          j++;
        } else if (t[j] === q) {
          if (q === "'" && t[j + 1] === "'") {
            key += "'";
            j++;
          } else break;
        } else key += t[j];
      }
      if (j >= t.length) return null;
      let k = j + 1;
      while (t[k] === " ") k++;
      if (t[k] !== ":" || (k + 1 < t.length && t[k + 1] !== " " && t[k + 1] !== "\t")) return null;
      return [key, t.slice(k + 1)];
    }
    for (let j = 0; j < t.length; j++) {
      if (t[j] === "#" && j > 0 && (t[j - 1] === " " || t[j - 1] === "\t")) return null;
      if (t[j] === ":" && (j + 1 === t.length || t[j + 1] === " " || t[j + 1] === "\t")) {
        const key = t.slice(0, j).replace(/[ \t]+$/, "");
        return key ? [key, t.slice(j + 1)] : null;
      }
    }
    return null;
  }
  /** A scalar or flow collection on one line; the rest of the line may only be a comment. `depth` = the nesting
   *  level of the collection holding this value (a flow collection here is level depth + 1). */
  inline(src: string, n: number, depth: number): unknown {
    let s = src.replace(/^[ \t]+/, "");
    if (s === "" || s[0] === "#") return null;
    const p = { s, i: 0 };
    let v: unknown;
    if (s[0] === '"' || s[0] === "'" || s[0] === "{" || s[0] === "[") {
      v = this.flowValue(p, n, false, depth);
      const rest = s.slice(p.i).replace(/^[ \t]+/, "");
      if (rest !== "" && rest[0] !== "#") this.fail(n);
      return v;
    }
    // plain scalar: up to a " #" comment
    const m = s.search(/[ \t]#/);
    if (m >= 0) s = s.slice(0, m);
    return s.replace(/[ \t]+$/, "");
  }
  quoted(p: { s: string; i: number }, n: number): string {
    const q = p.s[p.i];
    p.i++;
    let out = "";
    for (;;) {
      if (p.i >= p.s.length) this.fail(n);
      const c = p.s[p.i];
      p.i++;
      if (c === q) {
        if (q === "'" && p.s[p.i] === "'") {
          out += "'";
          p.i++;
          continue;
        }
        return out;
      }
      if (q === '"' && c === "\\") {
        const e = p.s[p.i];
        p.i++;
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " " };
        if (hasOwn(map, e)) out += map[e];
        else if (e === "x" || e === "u" || e === "U") {
          const len = e === "x" ? 2 : e === "u" ? 4 : 8;
          const hex = p.s.slice(p.i, p.i + len);
          if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) this.fail(n);
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail(n);
          out += String.fromCodePoint(cp);
          p.i += len;
        } else this.fail(n);
      } else out += c;
    }
  }
  flowValue(p: { s: string; i: number }, n: number, inFlow: boolean, depth: number): unknown {
    while (p.s[p.i] === " " || p.s[p.i] === "\t") p.i++;
    const c = p.s[p.i];
    if (c === '"' || c === "'") return this.quoted(p, n);
    if (c === "[" || c === "{") {
      if (depth + 1 > MAX_NESTING) this.fail(n);
      const close = c === "[" ? "]" : "}";
      p.i++;
      const arr: unknown[] = [];
      const obj = newObj();
      for (;;) {
        while (p.s[p.i] === " " || p.s[p.i] === "\t") p.i++;
        if (p.i >= p.s.length) this.fail(n);
        if (p.s[p.i] === close) {
          p.i++;
          return c === "[" ? arr : obj;
        }
        const k = this.flowValue(p, n, true, depth + 1);
        while (p.s[p.i] === " " || p.s[p.i] === "\t") p.i++;
        if (c === "{") {
          if (p.s[p.i] !== ":") this.fail(n);
          p.i++;
          obj[jsString(k)] = this.flowValue(p, n, true, depth + 1);
        } else arr.push(k);
        while (p.s[p.i] === " " || p.s[p.i] === "\t") p.i++;
        if (p.s[p.i] === ",") p.i++;
        else if (p.s[p.i] !== close) this.fail(n);
      }
    }
    const start = p.i;
    while (p.i < p.s.length) {
      const ch = p.s[p.i];
      if (inFlow && (ch === "," || ch === "]" || ch === "}")) break;
      if (inFlow && ch === ":" && (p.s[p.i + 1] === " " || p.s[p.i + 1] === "\t")) break;
      if ((ch === " " || ch === "\t") && p.s[p.i + 1] === "#") break;
      p.i++;
    }
    const v = p.s.slice(start, p.i).replace(/[ \t]+$/, "");
    return v === "" ? null : v;
  }
  /** A block collection at nesting level `depth` (the root block is level 1; deeper than MAX_NESTING fails). */
  block(i: number, ind: number, depth: number): [unknown, number] {
    if (depth > MAX_NESTING) this.fail(this.lines[i].n);
    return Yaml.isSeq(this.lines[i].text) ? this.seq(i, ind, depth) : this.map(i, ind, depth);
  }
  value(rest: string, i: number, ind: number, n: number, depth: number): [unknown, number] {
    const r = rest.replace(/^[ \t]+/, "");
    const L = this.lines;
    if (r === "" || r[0] === "#") {
      if (i < L.length && L[i].indent > ind) return this.block(i, L[i].indent, depth + 1);
      if (i < L.length && L[i].indent === ind && Yaml.isSeq(L[i].text)) {
        if (depth + 1 > MAX_NESTING) this.fail(L[i].n);
        return this.seq(i, ind, depth + 1);
      }
      return [null, i];
    }
    if (r[0] === "|" || r[0] === ">") {
      const parts: string[] = [];
      while (i < L.length && L[i].indent > ind) parts.push(L[i++].text);
      return [parts.join("\n"), i];
    }
    let v = this.inline(r, n, depth);
    const plain = !(r[0] === '"' || r[0] === "'" || r[0] === "{" || r[0] === "[");
    while (i < L.length && L[i].indent > ind) {
      if (!plain || Yaml.isSeq(L[i].text) || Yaml.splitKey(L[i].text)) this.fail(L[i].n);
      v = `${jsString(v)} ${jsString(this.inline(L[i].text, L[i].n, depth))}`.trim();
      i++;
    }
    return [v, i];
  }
  map(i: number, ind: number, depth: number): [unknown, number] {
    const L = this.lines;
    const o = newObj();
    while (i < L.length && L[i].indent === ind && !Yaml.isSeq(L[i].text)) {
      const kv = Yaml.splitKey(L[i].text);
      if (!kv) this.fail(L[i].n);
      const n = L[i].n;
      i++;
      const [v, next] = this.value(kv[1], i, ind, n, depth);
      o[kv[0]] = v;
      i = next;
    }
    if (i < L.length && L[i].indent > ind) this.fail(L[i].n);
    return [o, i];
  }
  seq(i: number, ind: number, depth: number): [unknown, number] {
    const L = this.lines;
    const arr: unknown[] = [];
    while (i < L.length && L[i].indent === ind && Yaml.isSeq(L[i].text)) {
      const t = L[i].text;
      const after = t.slice(1).replace(/^[ \t]+/, "");
      const col = ind + (t.length - after.length);
      if (after === "" || after[0] === "#") {
        i++;
        if (i < L.length && L[i].indent > ind) {
          const [v, next] = this.block(i, L[i].indent, depth + 1);
          arr.push(v);
          i = next;
        } else arr.push(null);
        continue;
      }
      if (Yaml.isSeq(after) || Yaml.splitKey(after)) {
        // "- key: v" / "- - x": the item is a block starting at the item's column
        L[i] = { n: L[i].n, indent: col, text: after };
        const [v, next] = this.block(i, col, depth + 1);
        arr.push(v);
        i = next;
        continue;
      }
      const n = L[i].n;
      i++;
      const [v, next] = this.value(after, i, ind, n, depth);
      arr.push(v);
      i = next;
    }
    if (i < L.length && L[i].indent > ind) this.fail(L[i].n);
    return [arr, i];
  }
  parse(): unknown {
    if (this.lines.length === 0) return null;
    const first = this.lines[0];
    if (!Yaml.isSeq(first.text) && !Yaml.splitKey(first.text)) {
      if (this.lines.length === 1) return this.inline(first.text, first.n, 0);
      this.fail(first.n);
    }
    const [v, i] = this.block(0, first.indent, 1);
    if (i < this.lines.length) this.fail(this.lines[i].n);
    return v;
  }
}

/** YAML subset → nested objects/arrays of string scalars (null for empty values). */
export function parseYaml(text: string): unknown {
  return new Yaml(text).parse();
}
