// html.ts — the READ side: formatted_body → safe HTML for the bubble (Matrix-allowed tags only),
// `<mx-reply>` fallbacks stripped (D7), spoilers hidden (embeds.rs), links re-targeted; plain bodies
// escaped with line breaks. Jumbo-emoji detection (CB:63-81).
import DOMPurify from "dompurify";
import { hideSpoilers } from "./embeds";
import { mentionFromHref } from "./mention";

const ALLOWED_TAGS = [
  "font", "del", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol", "sup", "sub", "li",
  "b", "i", "u", "strong", "em", "strike", "s", "code", "hr", "br", "div", "table", "thead", "tbody", "tr", "th",
  "td", "caption", "pre", "span", "details", "summary",
];
const ALLOWED_ATTR = ["href", "data-mx-spoiler", "data-mx-color", "data-mx-bg-color", "color", "start", "class", "title"];

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    // never trust incoming style / data-mention / target: we set our own below
    el.removeAttribute("style");
    el.removeAttribute("data-mention");
    el.removeAttribute("target");
    el.removeAttribute("rel");
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) el.removeAttribute("href");
      else {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
        // W2: never throws (a stray % used to blank the app), %40user%3Aserver counts too
        const mention = mentionFromHref(href);
        if (mention) el.setAttribute("data-mention", mention);
      }
    }
    if (el.hasAttribute("class")) {
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => /^language-[\w-]+$/.test(c));
      if (cls.length) el.setAttribute("class", cls.join(" "));
      else el.removeAttribute("class");
    }
    const color = el.getAttribute("data-mx-color") ?? el.getAttribute("color");
    const bg = el.getAttribute("data-mx-bg-color");
    const styles: string[] = [];
    if (color && /^#[0-9a-f]{3,8}$/i.test(color)) styles.push(`color:${color}`);
    if (bg && /^#[0-9a-f]{3,8}$/i.test(bg)) styles.push(`background-color:${bg}`);
    if (styles.length) el.setAttribute("style", styles.join(";"));
  });
}

const cache = new Map<string, string>();

/** Sanitised, spoiler-hidden HTML of a formatted_body. */
export function renderFormatted(formatted: string): string {
  const hit = cache.get(formatted);
  if (hit != null) return hit;
  hook();
  const noReply = formatted.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "");
  let out: string;
  try {
    const clean = DOMPurify.sanitize(noReply, { ALLOWED_TAGS, ALLOWED_ATTR, ADD_ATTR: ["target", "rel", "data-mention", "style"] }) as string;
    out = hideSpoilers(clean);
  } catch {
    // W2 defence in depth: this runs during render — a throw here must never take the app down.
    // Show the text without its markup instead.
    out = escapeHtml(noReply.replace(/<[^>]*>/g, ""));
  }
  if (cache.size > 2000) cache.clear();
  cache.set(formatted, out);
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain body → HTML (escaped, newlines kept by CSS pre-wrap). */
export function renderPlain(body: string): string {
  return escapeHtml(body);
}

/** Plain text of some HTML (for the reply snippet of a formatted message). */
export function htmlToText(html: string): string {
  const d = document.createElement("div");
  d.innerHTML = DOMPurify.sanitize(html.replace(/<br\s*\/?>/gi, "\n").replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, ""));
  return d.textContent ?? "";
}

const seg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** A plain line of 1–3 emoji (≤ 24 UTF-16 units; joiners/VS/skin tones/keycaps ignored). */
export function isJumbo(body: string): boolean {
  const t = body.trim();
  if (!t || t.length > 24 || /\s/.test(t.replace(/ /g, "")) || /[\n]/.test(t)) return false;
  const stripped = t.replace(/ /g, "");
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(stripped)) return false;
  const graphemes = seg ? [...seg.segment(stripped)].map((g) => g.segment) : Array.from(stripped);
  if (graphemes.length < 1 || graphemes.length > 3) return false;
  return graphemes.every((g) => /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u.test(g));
}
