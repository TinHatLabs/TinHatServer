// markdown.ts — the SEND side: ruma 0.34 `parse_markdown` (pulldown-cmark 0.13) reproduced on `marked`:
// CommonMark + tables + strikethrough, NO GFM autolinks, every soft break → `<br />\n`, a lone paragraph
// loses its <p> wrapper, and text without any markdown sends NO formatted_body (4.2.2). Also the mention
// HTML of room.rs:3657-3686 (4.2.5), which is built WITHOUT markdown.
import { Marked, type Token, type Tokens } from "marked";

// marked is used ONLY as a CommonMark/GFM lexer; the HTML is written here, byte-for-byte like
// pulldown-cmark 0.13's `html::push_html`, and the "does it contain markdown?" walk is ruma's
// (verified against the real ruma+pulldown code: tools/chat-md-oracle + tools/chat-md-check.mjs).
const md = new Marked({ gfm: true, breaks: true, async: false });
md.use({
  // No GFM autolinks (pulldown has none: a bare URL stays text).
  tokenizer: {
    url() {
      return undefined;
    },
  },
});

// pulldown escape_html: & < > " only
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", bull: "•",
  middot: "·", deg: "°", plusmn: "±", times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", hearts: "♥", star: "☆",
};
let decoder: HTMLTextAreaElement | null = null;
/** CommonMark entity decoding (named + numeric), like pulldown's Text events. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(cp);
    }
    if (NAMED[e] !== undefined) return NAMED[e];
    if (typeof document !== "undefined") {
      decoder ??= document.createElement("textarea");
      decoder.innerHTML = m;
      return decoder.value;
    }
    return m;
  });
}

type Inl = Token;

/** Paragraph/heading inline whitespace like CommonMark: strip at the start/end and around line breaks. */
function normInline(tokens: Inl[]): Inl[] {
  const out = tokens.map((t) => ({ ...t })) as Inl[];
  for (let i = 0; i < out.length; i++) {
    const t = out[i] as Tokens.Text;
    if (t.type !== "text") continue;
    let v = t.raw;
    const prev = out[i - 1];
    const next = out[i + 1];
    if (i === 0 || prev?.type === "br") v = v.replace(/^[ \t]+/, "");
    if (i === out.length - 1 || next?.type === "br") v = v.replace(/[ \t]+$/, "");
    (t as Tokens.Text & { _v: string })._v = v;
  }
  return out;
}

function textOf(t: Inl): string {
  const v = (t as Tokens.Text & { _v?: string })._v;
  return decodeEntities(v ?? (t as Tokens.Text).raw);
}

function renderInline(tokens: Inl[]): string {
  let h = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        h += tt.tokens && tt.tokens.length ? renderInline(normInline(tt.tokens)) : esc(textOf(tt));
        break;
      }
      case "escape":
        h += esc((t as Tokens.Escape).text);
        break;
      case "br":
        h += "<br />\n";
        break;
      case "strong":
        h += `<strong>${renderInline((t as Tokens.Strong).tokens)}</strong>`;
        break;
      case "em":
        h += `<em>${renderInline((t as Tokens.Em).tokens)}</em>`;
        break;
      case "del":
        h += `<del>${renderInline((t as Tokens.Del).tokens)}</del>`;
        break;
      case "codespan":
        h += `<code>${esc(decodeCodeSpan((t as Tokens.Codespan).text))}</code>`;
        break;
      case "link": {
        const l = t as Tokens.Link;
        const inner = l.tokens?.length ? renderInline(l.tokens) : esc(l.text);
        h += `<a href="${escHref(l.href)}"${l.title ? ` title="${esc(l.title)}"` : ""}>${inner}</a>`;
        break;
      }
      case "image": {
        const im = t as Tokens.Image;
        h += `<img src="${escHref(im.href)}" alt="${esc(plainText(im.tokens ?? []) || im.text)}"${im.title ? ` title="${esc(im.title)}"` : ""} />`;
        break;
      }
      case "html":
        h += (t as Tokens.HTML).raw;
        break;
      case "checkbox":
        h += esc((t as Tokens.Checkbox & { raw: string }).raw);
        break;
      default:
        h += esc((t as { raw?: string }).raw ?? "");
    }
  }
  return h;
}

// marked already un-escapes nothing inside code spans; entities stay literal there (CommonMark)
const decodeCodeSpan = (s: string) => s;

function plainText(tokens: Inl[]): string {
  return tokens
    .map((t) => {
      const c = (t as { tokens?: Inl[] }).tokens;
      if (c && c.length) return plainText(c);
      if (t.type === "escape") return (t as Tokens.Escape).text;
      if (t.type === "text") return textOf(t);
      if (t.type === "codespan") return (t as Tokens.Codespan).text;
      return "";
    })
    .join("");
}

// pulldown escape_href: keep URL-safe ASCII, percent-encode the rest, & → &amp;, ' → &#x27;
function escHref(u: string): string {
  let o = "";
  for (const ch of u) {
    const c = ch.codePointAt(0)!;
    if (ch === "&") o += "&amp;";
    else if (ch === "'") o += "&#x27;";
    else if (c < 0x80 && /[A-Za-z0-9\-_.~!*();:@=+$,/?#[\]%]/.test(ch)) o += ch;
    else for (const b of new TextEncoder().encode(ch)) o += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return o;
}

function renderBlocks(tokens: Token[]): string {
  let h = "";
  for (const t of tokens) h += renderBlock(t);
  return h;
}

function renderBlock(t: Token): string {
  switch (t.type) {
    case "space":
    case "def":
      return "";
    case "paragraph":
      return `<p>${renderInline(normInline((t as Tokens.Paragraph).tokens))}</p>\n`;
    case "text": {
      const tt = t as Tokens.Text;
      return tt.tokens ? renderInline(normInline(tt.tokens)) : esc(textOf(tt));
    }
    case "heading": {
      const hd = t as Tokens.Heading;
      return `<h${hd.depth}>${renderInline(normInline(hd.tokens))}</h${hd.depth}>\n`;
    }
    case "hr":
      return "<hr />\n";
    case "code": {
      const c = t as Tokens.Code;
      const lang = (c.lang ?? "").trim().split(/\s+/)[0];
      const fenced = c.codeBlockStyle !== "indented";
      const body = c.text ? c.text + (fenced || /\n$/.test(c.raw) ? "\n" : "") : "";
      return `<pre><code${lang ? ` class="language-${esc(decodeEntities(lang))}"` : ""}>${esc(body)}</code></pre>\n`;
    }
    case "blockquote":
      return `<blockquote>\n${renderBlocks((t as Tokens.Blockquote).tokens)}</blockquote>\n`;
    case "list": {
      const l = t as Tokens.List;
      const tag = l.ordered ? "ol" : "ul";
      const start = l.ordered && l.start !== 1 && l.start !== "" ? ` start="${l.start}"` : "";
      let h = `<${tag}${start}>\n`;
      for (const it of l.items) {
        if (l.loose) h += `<li>\n${renderBlocks(it.tokens)}</li>\n`;
        else {
          let inner = "";
          let prevInline = false;
          for (const c of it.tokens) {
            if (c.type === "text" || c.type === "checkbox") {
              inner += c.type === "checkbox" ? esc((c as { raw: string }).raw) : renderBlock(c);
              prevInline = true;
            } else {
              if (prevInline) inner += "\n";
              inner += renderBlock(c);
              prevInline = false;
            }
          }
          h += `<li>${inner}</li>\n`;
        }
      }
      return h + `</${tag}>\n`;
    }
    case "table": {
      const tb = t as Tokens.Table;
      const al = (a: string | null) => (a ? ` style="text-align: ${a}"` : "");
      let h = "<table><thead><tr>";
      tb.header.forEach((c, i) => (h += `<th${al(tb.align[i])}>${renderInline(normInline(c.tokens))}</th>`));
      h += "</tr></thead>";
      h += "<tbody>\n";
      for (const r of tb.rows) {
        h += "<tr>";
        r.forEach((c, i) => (h += `<td${al(tb.align[i])}>${renderInline(normInline(c.tokens))}</td>`));
        h += "</tr>\n";
      }
      h += "</tbody>";
      return h + "</table>\n";
    }
    case "html":
      return (t as Tokens.HTML).raw.replace(/\n+$/, "\n");
    default:
      return esc((t as { raw?: string }).raw ?? "");
  }
}

/**
 * Markdown → formatted_body exactly like ruma 0.34 `parse_markdown` (room/message.rs:823-912), or
 * null when the text has no markdown (then send plain, no `format`) — 4.2.2.
 */
export function markdownToHtml(text: string): string | null {
  // link reference definitions and blank lines produce no pulldown events
  const blocks = md.lexer(text).filter((b) => b.type !== "space" && b.type !== "def");
  const inline = blocks.length === 1 && blocks[0].type === "paragraph";
  let hasMd = !inline;
  if (!hasMd) {
    // ruma: the text must be reproduced by Text events + newline breaks only
    const toks = normInline((blocks[0] as Tokens.Paragraph).tokens);
    let pos = 0;
    for (const t of toks) {
      if (t.type === "text" && !(t as Tokens.Text).tokens?.length) {
        const v = textOf(t);
        if (text.startsWith(v, pos)) {
          pos += v.length;
          continue;
        }
      } else if (t.type === "br") {
        if (text.startsWith("\r\n", pos)) {
          pos += 2;
          continue;
        }
        if (text[pos] === "\r" || text[pos] === "\n") {
          pos += 1;
          continue;
        }
      }
      hasMd = true;
      break;
    }
    if (pos !== text.length) hasMd = true;
  }
  if (!hasMd) return null;
  if (inline) return renderInline(normInline((blocks[0] as Tokens.Paragraph).tokens));
  return renderBlocks(blocks);
}

/** m.room.message content for a text message (4.2.1 / 4.2.2 / 4.2.3). */
export function textContent(text: string, msgtype: "m.text" | "m.emote" = "m.text"): Record<string, unknown> {
  const html = markdownToHtml(text);
  const c: Record<string, unknown> = { body: text, msgtype };
  if (html != null) {
    c.format = "org.matrix.custom.html";
    c.formatted_body = html;
  }
  return c;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface PickedMention {
  name: string;
  userId: string;
}

/**
 * 4.2.5 — room.rs render_mention_html (3657-3686): escape & < > ", swap each picked "@name" (pick order)
 * for a placeholder, \n → <br/>, placeholders → matrix.to anchors. `picks` = the live picks (the caller
 * filtered them by the raw text, like CV:1841); user_ids = a sorted set (ruma Mentions is a BTreeSet).
 */
export function mentionContent(text: string, picks: PickedMention[]): Record<string, unknown> {
  let html = escHtml(text);
  const links: Array<[string, string]> = [];
  picks.forEach((p, i) => {
    const needle = "@" + escHtml(p.name);
    if (html.includes(needle)) {
      const ph = `\u0001M${i}\u0001`;
      html = html.split(needle).join(ph);
      links.push([ph, `<a href="https://matrix.to/#/${p.userId}">@${escHtml(p.name)}</a>`]);
    }
  });
  html = html.replace(/\n/g, "<br/>");
  for (const [ph, a] of links) html = html.split(ph).join(a);
  const ids = [...new Set(picks.map((p) => p.userId))].sort();
  const c: Record<string, unknown> = { body: text, format: "org.matrix.custom.html", formatted_body: html, msgtype: "m.text" };
  if (ids.length) c["m.mentions"] = { user_ids: ids };
  return c;
}

/** 4.2.6 — an edit: markdown(new text) as m.new_content; top level = the same with body "* " prefixed. */
export function editContent(targetId: string, text: string): Record<string, unknown> {
  const inner = textContent(text, "m.text");
  const top: Record<string, unknown> = { ...inner, body: "* " + text };
  top["m.new_content"] = inner;
  top["m.relates_to"] = { event_id: targetId, rel_type: "m.replace" };
  return top;
}

/** Slash-command faces (CV:1808-1847). */
export function expandSlash(s: string): string {
  const rules: Array<[RegExp, string]> = [
    [/^\/shrug\b/i, " ¯\\_(ツ)_/¯"],
    [/^\/tableflip\b/i, " (╯°□°)╯︵ ┻━┻"],
    [/^\/unflip\b/i, " ┬─┬ノ( º _ ºノ)"],
    [/^\/lenny\b/i, " ( ͡° ͜ʖ ͡°)"],
  ];
  for (const [re, face] of rules) {
    if (re.test(s)) {
      const cmd = re.source.slice(3, -2); // "shrug"
      return (s.replace(new RegExp(`^\\/${cmd}\\s?`, "i"), "") + face).trim();
    }
  }
  return s.trim();
}
