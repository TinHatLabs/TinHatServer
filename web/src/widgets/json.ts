// json.ts — the strict JSON reader of peer-sent widget data (`tinhat.rxq`; WIDGETS.md §10.2). JSON.parse cannot say what
// the Rust port's reader refuses (a duplicate key hides a 1e400 or a deep value behind the one it keeps; an escaped lone
// surrogate becomes a string Rust can't hold), so both apps read these texts with the same small RFC 8259 grammar:
//
//   - whitespace: only space, tab, LF, CR (a BOM or any other character outside a string refuses the text)
//   - strings: no raw control characters (< U+0020), escapes \" \\ \/ \b \f \n \r \t \uXXXX; a \u high surrogate must be
//     followed by a \u low surrogate (a pair), a lone one refuses the text; a raw lone surrogate in the text too
//   - numbers: -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?, read as the correctly rounded binary64 value (JS Number(),
//     Rust str::parse::<f64>); a value that is not finite (1e400) refuses the text
//   - objects: a key twice (after unescaping) refuses the text
//   - depth: the root value is level 1, a value inside an array/object one level deeper; a container at a level
//     > maxDepth refuses the text
//
// Objects come back with a null prototype (a key "__proto__" is an ordinary key). Never throws.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type StrictResult = { ok: true; value: Json } | { ok: false };

export function parseStrictJson(text: string, maxDepth: number): StrictResult {
  let i = 0;
  const n = text.length;
  const FAIL = { ok: false } as const;
  class Refuse extends Error {}
  const refuse = (): never => {
    throw new Refuse();
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const hex4 = (): number => {
    if (i + 4 > n) refuse();
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) refuse();
    i += 4;
    return parseInt(h, 16);
  };
  const str = (): string => {
    i++; // the opening quote
    let out = "";
    for (;;) {
      if (i >= n) refuse();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return out;
      }
      if (c < 0x20) refuse();
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "/") out += "/";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const u = hex4();
          if (u >= 0xdc00 && u <= 0xdfff) refuse(); // a lone low surrogate
          if (u >= 0xd800 && u <= 0xdbff) {
            if (text[i] !== "\\" || text[i + 1] !== "u") refuse();
            i += 2;
            const lo = hex4();
            if (!(lo >= 0xdc00 && lo <= 0xdfff)) refuse();
            out += String.fromCharCode(u, lo);
          } else out += String.fromCharCode(u);
        } else refuse();
        continue;
      }
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = i + 1 < n ? text.charCodeAt(i + 1) : 0;
        if (!(d >= 0xdc00 && d <= 0xdfff)) refuse();
        out += text[i]! + text[i + 1]!;
        i += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) refuse();
      out += text[i];
      i++;
    }
  };
  const NUM = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const num = (): number => {
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m || m[0].length === 0) refuse();
    i += m![0].length;
    const v = Number(m![0]);
    if (!Number.isFinite(v)) refuse();
    return v;
  };
  const lit = (word: string, v: Json): Json => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return v;
    }
    return refuse();
  };
  const value = (level: number): Json => {
    ws();
    if (i >= n) refuse();
    const c = text[i];
    if (c === "{") {
      if (level > maxDepth) refuse();
      i++;
      const o = Object.create(null) as { [k: string]: Json };
      ws();
      if (text[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') refuse();
        const k = str();
        if (Object.prototype.hasOwnProperty.call(o, k)) refuse();
        ws();
        if (text[i] !== ":") refuse();
        i++;
        o[k] = value(level + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return o;
        }
        refuse();
      }
    }
    if (c === "[") {
      if (level > maxDepth) refuse();
      i++;
      const a: Json[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(value(level + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return a;
        }
        refuse();
      }
    }
    if (c === '"') return str();
    if (c === "t") return lit("true", true);
    if (c === "f") return lit("false", false);
    if (c === "n") return lit("null", null);
    return num();
  };
  try {
    if (typeof text !== "string") return FAIL;
    const v = value(1);
    ws();
    if (i !== n) return FAIL;
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof Refuse) return FAIL;
    return FAIL;
  }
}
