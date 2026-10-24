// expr.ts — ENGINE.md §3: the expression language, parser only (evaluation: engine.ts).
//
//   expr   := literal | ref | fn '(' item (',' item)* ')'
//   item   := expr | number
//   ref    := [A-Za-z][A-Za-z0-9.:-]*            (role id, token id or palette slot)
//   number := D{1,4} | D{1,4}.D{1,4} | .D{1,4}      (exact: kept as k = value × 10000)
//   whitespace (space, tab, CR, LF) is allowed between tokens.
// Signatures: alpha(e, n) mix(e, e, n) lighter(e, n) darker(e, n) over(e, e) mixok(e, e, n)
//             best(e, e, …) guard(e, e, n); n ranges: alpha/mix/mixok 0..1, guard 1..21, lighter/darker any.
// Errors are a fixed set of messages (README "Expression errors") so the Rust port reports the same text.
import type { Colour } from "./literal";
import { parseDecimal4, parseLiteral } from "./literal";

export type FnName = "alpha" | "mix" | "lighter" | "darker" | "over" | "mixok" | "best" | "guard";

export type Expr =
  | { k: "lit"; c: Colour }
  | { k: "ref"; id: string }
  | { k: "fn"; f: FnName; args: Expr[]; n: number }; // n = the numeric argument (k / 10000), 0 if none

export type ParseResult = { ok: true; e: Expr } | { ok: false; why: string };

interface Sig {
  arity: number; // -1 = variadic, at least 2 colours (best)
  num: number; // index of the numeric argument, -1 if none
  lo: number; // allowed k range of the number (inclusive)
  hi: number;
}

const SIGS: Record<FnName, Sig> = {
  alpha: { arity: 2, num: 1, lo: 0, hi: 10000 },
  mix: { arity: 3, num: 2, lo: 0, hi: 10000 },
  lighter: { arity: 2, num: 1, lo: 0, hi: 99999999 },
  darker: { arity: 2, num: 1, lo: 0, hi: 99999999 },
  over: { arity: 2, num: -1, lo: 0, hi: 0 },
  mixok: { arity: 3, num: 2, lo: 0, hi: 10000 },
  best: { arity: -1, num: -1, lo: 0, hi: 0 },
  guard: { arity: 3, num: 2, lo: 10000, hi: 210000 },
};

export const FN_NAMES: readonly FnName[] = ["alpha", "best", "darker", "guard", "lighter", "mix", "mixok", "over"];

/** Maximum nesting of function calls in one expression. */
export const MAX_DEPTH = 32;

type Item = { num: true; k: number } | { num: false; e: Expr };

class Fail {
  why: string;
  constructor(why: string) {
    this.why = why;
  }
}

const isWs = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === 13;
const isLetter = (ch: number) => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
const isDigit = (ch: number) => ch >= 48 && ch <= 57;
const isIdChar = (ch: number) => isLetter(ch) || isDigit(ch) || ch === 46 || ch === 58 || ch === 45; // . : -
const isWordChar = (ch: number) => isLetter(ch) || isDigit(ch) || ch === 46 || ch === 47; // literal/number token chars

class Parser {
  s: string;
  i = 0;
  constructor(s: string) {
    this.s = s;
  }
  ws(): void {
    while (this.i < this.s.length && isWs(this.s.charCodeAt(this.i))) this.i++;
  }
  /** "unexpected 'X'" for the code point at i, or "unexpected end". */
  unexpected(): Fail {
    if (this.i >= this.s.length) return new Fail("unexpected end");
    const cp = this.s.codePointAt(this.i) as number;
    return new Fail(`unexpected '${String.fromCodePoint(cp)}'`);
  }
  word(start: number): string {
    while (this.i < this.s.length && isWordChar(this.s.charCodeAt(this.i))) this.i++;
    return this.s.slice(start, this.i);
  }
  expr(depth: number): Expr {
    this.ws();
    if (this.i >= this.s.length) throw this.unexpected();
    const ch = this.s.charCodeAt(this.i);
    if (ch === 35 /* # */) {
      const start = this.i++;
      this.word(this.i); // hex digits, letters, '/', '.' — the whole token is judged by parseLiteral
      const tok = this.s.slice(start, this.i);
      const c = parseLiteral(tok);
      if (!c) throw new Fail(`bad colour literal '${tok}'`);
      return { k: "lit", c };
    }
    if (!isLetter(ch)) throw this.unexpected();
    const start = this.i;
    while (this.i < this.s.length && isIdChar(this.s.charCodeAt(this.i))) this.i++;
    const name = this.s.slice(start, this.i);
    this.ws();
    if (this.i < this.s.length && this.s.charCodeAt(this.i) === 40 /* ( */) {
      if (!Object.prototype.hasOwnProperty.call(SIGS, name)) throw new Fail(`unknown function '${name}'`);
      if (depth + 1 > MAX_DEPTH) throw new Fail("too deeply nested");
      this.i++;
      return this.call(name as FnName, depth + 1);
    }
    return { k: "ref", id: name };
  }
  item(depth: number): Item {
    this.ws();
    if (this.i >= this.s.length) throw this.unexpected();
    const ch = this.s.charCodeAt(this.i);
    if (isDigit(ch) || ch === 46) {
      const start = this.i;
      const tok = this.word(start);
      const k = parseDecimal4(tok);
      if (k < 0) throw new Fail(`bad number '${tok}'`);
      return { num: true, k };
    }
    return { num: false, e: this.expr(depth) };
  }
  call(f: FnName, depth: number): Expr {
    const items: Item[] = [];
    this.ws();
    if (this.i < this.s.length && this.s.charCodeAt(this.i) === 41 /* ) */) {
      this.i++;
    } else {
      for (;;) {
        items.push(this.item(depth));
        this.ws();
        if (this.i >= this.s.length) throw this.unexpected();
        const ch = this.s.charCodeAt(this.i);
        if (ch === 44 /* , */) {
          this.i++;
          continue;
        }
        if (ch === 41 /* ) */) {
          this.i++;
          break;
        }
        throw this.unexpected();
      }
    }
    const sig = SIGS[f];
    if (sig.arity < 0) {
      if (items.length < 2) throw new Fail(`${f}() takes at least 2 arguments`);
    } else if (items.length !== sig.arity) {
      throw new Fail(`${f}() takes ${sig.arity} arguments`);
    }
    const args: Expr[] = [];
    let n = 0;
    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      if (j === sig.num) {
        if (!it.num) throw new Fail(`${f}() argument ${j + 1} must be a number`);
        if (it.k < sig.lo || it.k > sig.hi) throw new Fail(`${f}() argument ${j + 1} out of range`);
        n = it.k / 10000;
      } else {
        if (it.num) throw new Fail(`${f}() argument ${j + 1} must be a colour`);
        args.push(it.e);
      }
    }
    return { k: "fn", f, args, n };
  }
}

/** Parse one expression. Never throws. */
export function parseExpr(src: string): ParseResult {
  const p = new Parser(src);
  p.ws();
  if (p.i >= src.length) return { ok: false, why: "empty expression" };
  try {
    const e = p.expr(0);
    p.ws();
    if (p.i < src.length) throw p.unexpected();
    return { ok: true, e };
  } catch (x) {
    if (x instanceof Fail) return { ok: false, why: x.why };
    throw x;
  }
}

/** Canonical text of a parsed expression (debugging / README examples; not part of the vectors). */
export function exprText(e: Expr, fmt: (c: Colour) => string): string {
  if (e.k === "lit") return fmt(e.c);
  if (e.k === "ref") return e.id;
  const parts = e.args.map((a) => exprText(a, fmt));
  const sig = SIGS[e.f];
  if (sig.num >= 0) parts.splice(sig.num, 0, String(e.n));
  return `${e.f}(${parts.join(", ")})`;
}
