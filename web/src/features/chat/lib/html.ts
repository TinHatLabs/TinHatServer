// html.ts — the READ side: formatted_body → safe HTML for the bubble (Matrix-allowed tags only),
// `<mx-reply>` fallbacks stripped (D7), spoilers hidden (embeds.rs), links re-targeted; plain bodies
// escaped with line breaks. Jumbo-emoji detection (CB:63-81).
//
// Security review 2026-10-26 (H2's web half, the shared vectors testvectors/member-content.json — the desktop's
// richtext.rs replays the same file): `<img>` becomes its alt text (no remote image ever loads); an href is kept only
// through core/openlink.ts safeExternalUrl (http/https with a host and no user name, mailto; WHATWG-normalised) and an
// `<a>` without one is no link; a link whose text names another host is followed by " (<real host>)"; `ol start` digits
// only; no style / title / target / rel from the member. Spoilers are hidden on the DOM (never by a regex over
// serialised HTML: on engines that write `<` `>` raw inside attribute values a fake spoiler inside an attribute broke out
// of it — Astra's review of this branch), and the final DOMPurify pass runs AFTER every transform.
import DOMPurify from "dompurify";
import { mentionFromHref } from "./mention";
import { linkVerdict } from "@/core/openlink";
import { claimFor, claimText } from "@/core/claims";
import { TLDS } from "@/core/tlds";

export { claimedHost, destinationHost } from "@/core/linkgate";

const ALLOWED_TAGS = [
  "font", "del", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol", "sup", "sub", "li",
  "b", "i", "u", "strong", "em", "strike", "s", "code", "hr", "br", "div", "table", "thead", "tbody", "tr", "th",
  "td", "caption", "pre", "span", "details", "summary",
  "img", // only to become its alt text (finish()); never kept, never loaded
];
const ALLOWED_ATTR = ["href", "data-mx-spoiler", "data-mx-color", "data-mx-bg-color", "color", "start", "class", "alt"];
// ALLOW_DATA_ATTR off: only the data-* names listed survive (DOMPurify keeps every data-* attribute by default)
// ALLOWED_URI_REGEXP: DOMPurify's own filter (it checks every attribute value that looks like "scheme:…") runs before our
// hook; its default pattern with only the schemes the link rule can allow (http, https, mailto, steam — linkVerdict
// decides the rest); values that aren't a scheme (a colour, a spoiler reason, a number) pass as with the default
const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ADD_ATTR: ["data-mention", "data-steam", "tabindex", "role", "style"],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|steam):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

/** At most this many characters of an image's alt text (the desktop's rule). */
const ALT_MAX = 256;

/** The final pass keeps the two spoiler classes this file writes (the first pass strips them from the member's HTML). */
let finalPass = false;
/** Rendering for a bubble (renderFormatted), not the shared vectors (sanitizeFormatted): a steam:// link's address moves
 *  from href to data-steam on the final pass, so the browser's own link menu (where one still shows) has nothing to open
 *  without our "Open in Steam?" (assembly verify D, sec-night 2026-10-27); linkgate.ts opens it from data-steam. */
let appLinks = false;
const SPOILER_CLASSES = new Set(["tw-spoiler-tag", "tw-spoiler"]);

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (!el.removeAttribute) return;
    // never trust incoming style / data-mention / data-steam / tabindex / role / target / rel / title: we set our own below
    for (const a of ["style", "data-mention", "data-steam", "tabindex", "role", "target", "rel", "title"]) el.removeAttribute(a);
    if (el.tagName === "IMG") {
      for (const a of [...el.getAttributeNames()]) if (a !== "alt") el.removeAttribute(a);
      return;
    }
    if (el.tagName !== "IMG" && el.hasAttribute("alt")) el.removeAttribute("alt");
    if (el.hasAttribute("start") && !(el.tagName === "OL" && /^\d{1,9}$/.test(el.getAttribute("start") ?? ""))) el.removeAttribute("start");
    // a spoiler is a <span data-mx-spoiler> only (the desktop's rule)
    if (el.tagName !== "SPAN" && el.hasAttribute("data-mx-spoiler")) el.removeAttribute("data-mx-spoiler");
    if (el.tagName === "A") {
      // the one link rule (core/openlink.ts): anything else loses its href, and finish() unwraps the <a>
      const verdict = linkVerdict(el.getAttribute("href"));
      const href = verdict?.as ?? null; // http(s), mailto, or steam:// (asks at the click)
      if (!href) el.removeAttribute("href");
      else if (verdict?.ask === "steam" && finalPass && appLinks) {
        el.removeAttribute("href");
        el.setAttribute("data-steam", href);
        // no href = no focus: Tab still reaches it, Enter goes through the same door (linkgate.ts onKeyDown)
        el.setAttribute("tabindex", "0");
        el.setAttribute("role", "link");
      } else {
        el.setAttribute("href", href);
        // W2: never throws (a stray % used to blank the app), %40user%3Aserver counts too
        const mention = mentionFromHref(href);
        if (mention) el.setAttribute("data-mention", mention);
      }
    }
    if (el.hasAttribute("class")) {
      const all = (el.getAttribute("class") ?? "").split(/\s+/);
      const cls =
        el.tagName === "CODE" ? all.filter((c) => /^language-[\w-]+$/.test(c)) : finalPass && el.tagName === "SPAN" ? all.filter((c) => SPOILER_CLASSES.has(c)) : [];
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

/** The real host to show after a link whose text names another one, else null (the shared claims rule: core/claims.ts,
 *  richtext.rs spoof_host — the same rule as the question at the click). */
export function spoofHost(href: string, text: string): string | null {
  return claimFor(href, text, TLDS)?.[1] ?? null;
}

/** Spoilers (embeds.rs hide_spoilers) on the DOM: each <span data-mx-spoiler> becomes the label (its reason as TEXT)
 *  + a space + <span class="tw-spoiler"> holding the original child nodes (moved, never re-parsed). */
function hideSpoilers(doc: Document): void {
  for (const sp of [...doc.body.querySelectorAll("span[data-mx-spoiler]")]) {
    const reason = sp.getAttribute("data-mx-spoiler") ?? "";
    const label = doc.createElement("span");
    label.className = "tw-spoiler-tag";
    label.textContent = `[${reason ? `spoiler: ${reason}` : "spoiler"} — select to reveal]`;
    const body = doc.createElement("span");
    body.className = "tw-spoiler";
    body.append(...Array.from(sp.childNodes));
    sp.replaceWith(label, doc.createTextNode(" "), body);
  }
}

/** The bidi controls that reorder text (embeddings, overrides, isolates): dropped from a whole body that holds a kept
 *  link (an override before a link reorders its text as much as one inside it). The marks (U+200E, U+200F, U+061C) stay:
 *  they can't reorder letters (shared vector: a spoof note through U+200E). */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** A body that holds a kept link loses its reordering bidi controls everywhere: text and spoiler reasons. */
function stripBidi(body: Element, doc: Document): void {
  const walk = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.nodeValue ?? "";
    const u = t.replace(BIDI_CONTROLS, "");
    if (u !== t) n.nodeValue = u;
  }
  for (const sp of body.querySelectorAll("[data-mx-spoiler]")) sp.setAttribute("data-mx-spoiler", (sp.getAttribute("data-mx-spoiler") ?? "").replace(BIDI_CONTROLS, ""));
}

/** A link the reader follows shows what the claim check reads (assembly-038, launch-gate D-c; the desktop's richtext.rs
 *  in_kept_link): on the <a> and everything inside it no member colours (text the colour of its background), no spoiler
 *  (text behind a label), and no folded <details> (text behind a disclosure: it becomes a block, as on the desktop). */
function showAsChecked(a: Element, doc: Document): void {
  for (const el of [a, ...a.querySelectorAll("*")]) {
    for (const at of ["data-mx-color", "data-mx-bg-color", "color", "style", "data-mx-spoiler"]) el.removeAttribute(at);
  }
  for (const d of [...a.querySelectorAll("details")]) {
    for (const s of [...d.querySelectorAll(":scope > summary")]) {
      const p = doc.createElement("p");
      const b = doc.createElement("b");
      b.append(...Array.from(s.childNodes));
      p.append(b);
      s.replaceWith(p);
    }
    const div = doc.createElement("div");
    div.append(...Array.from(d.childNodes));
    d.replaceWith(div);
  }
}

/** Second pass over the sanitiser's output in an INERT document (DOMParser: nothing loads, nothing runs): images →
 *  their alt text, an <a> without an allowed href → its text, the spoof note after a link, (rendering) the spoilers. */
function finish(clean: string, spoilers: boolean): string {
  if (typeof DOMParser === "undefined") return clean;
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${clean}`, "text/html");
  const body = doc.body;
  // alt text trimmed, as the desktop (assembly-038: " x" read as a separate word here and as part of the host there)
  for (const img of [...body.querySelectorAll("img")]) img.replaceWith(doc.createTextNode(Array.from((img.getAttribute("alt") ?? "").trim()).slice(0, ALT_MAX).join("")));
  for (const a of [...body.querySelectorAll("a")]) if (!a.hasAttribute("href")) a.replaceWith(...Array.from(a.childNodes));
  if (body.querySelector("a")) stripBidi(body, doc);
  for (const a of [...body.querySelectorAll("a")]) {
    showAsChecked(a, doc);
    const host = spoofHost(a.getAttribute("href") ?? "", claimText(a));
    // (not twice: a body that already says it — this app's own output, quoted — keeps one)
    const next = a.nextSibling;
    if (host && !(next && next.nodeType === 3 && (next.textContent ?? "").startsWith(` (${host})`))) a.after(doc.createTextNode(` (${host})`));
  }
  if (spoilers) hideSpoilers(doc);
  return body.innerHTML;
}

function pipeline(formatted: string, spoilers: boolean): string {
  hook();
  // the hook's two modes are module state: set per pass, restored whatever happens (an exception, a nested call)
  const saved = [finalPass, appLinks] as const;
  try {
    finalPass = false;
    appLinks = spoilers;
    const noReply = formatted.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "");
    const once = DOMPurify.sanitize(noReply, CONFIG) as string;
    const done = finish(once, spoilers);
    // every transform's serialisation goes through the sanitiser once more, LAST (defence in depth)
    finalPass = true;
    appLinks = spoilers;
    return DOMPurify.sanitize(done, CONFIG) as string;
  } finally {
    [finalPass, appLinks] = saved;
  }
}

/** The sanitiser alone (no spoiler hiding): what the shared vectors test. */
export function sanitizeFormatted(formatted: string): string {
  return pipeline(formatted, false);
}

const cache = new Map<string, string>();

/** Sanitised, spoiler-hidden HTML of a formatted_body. */
export function renderFormatted(formatted: string): string {
  const hit = cache.get(formatted);
  if (hit != null) return hit;
  let out: string;
  try {
    out = pipeline(formatted, true);
  } catch {
    // W2 defence in depth: this runs during render — a throw here must never take the app down.
    // Show the text without its markup instead.
    out = escapeHtml(formatted.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "").replace(/<[^>]*>/g, ""));
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

/** Plain text of some HTML (for the reply snippet of a formatted message). Parsed in an INERT document (DOMParser):
 *  an element of this page's document would fetch a member's <img> even detached (security review 2026-10-26). */
export function htmlToText(html: string): string {
  const clean = sanitizeFormatted(html.replace(/<br\s*\/?>/gi, "\n"));
  return new DOMParser().parseFromString(`<!doctype html><body>${clean}`, "text/html").body.textContent ?? "";
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
