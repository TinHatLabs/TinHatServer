// claims.ts — the host a link's text claims (shared rule: member-content.json `claims`; the desktop's richtext.rs
// claim_for / word_host). Used for the " (real-host)" note after a link (chat/lib/html.ts) and the question at the click
// (core/linkgate.ts), and the app's own words for where a link goes. Pure: the TLD list is passed in (core/tlds.ts loads core/tlds.txt); claims.test.ts and the
// shared vectors run it under Node.
//   only an http(s) link with a host that isn't matrix.to (a mention pill's text is a display name);
//   invisible characters (\p{Cf}, \p{Default_Ignorable_Code_Point}) dropped; the text split at white space; each word loses
//   its leading / trailing characters that aren't letters or digits; a word claims a host when
//     (a) it has a scheme (`://`, http/https), starts with `www.` or has a path (`/`), and its host is dotted with a last
//         label of >= 2 ASCII letters or `xn--`; or
//     (b) it is a bare dotted name whose last label is a top-level domain on IANA's list (tlds.txt) and not one of the
//         code-file extensions in CLAIM_EXCLUDE (md, py, rs, sh, pl);
//   hosts compare lower case without a trailing dot or a leading `www.`; the first claim other than the link's host counts.

import { safeExternalUrl, steamUrl } from "./openlink";

export const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Top-level domains that are also code-file extensions: a BARE name ending in one (README.md, main.py, lib.rs, run.sh,
 *  script.pl) claims no host; with a scheme, `www.` or a path it still does (member-content.json `claimExclude`). */
export const CLAIM_EXCLUDE: readonly string[] = Object.freeze(["md", "py", "rs", "sh", "pl"]);
const EXCLUDE = new Set(CLAIM_EXCLUDE);
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

export function normHost(h: string): string {
  const x = h.replace(/\.+$/, "").toLowerCase();
  return x.startsWith("www.") ? x.slice(4) : x;
}

/** The TLD set from tlds.txt's text (IANA's list: one per line, `#` comments), lower case. */
export function parseTlds(text: string): Set<string> {
  const out = new Set<string>();
  for (const l of text.split(/\r?\n/)) {
    const t = l.trim();
    if (t && !t.startsWith("#")) out.add(t.toLowerCase());
  }
  return out;
}

/** The host one word of a link's text claims (word_host), or null. */
export function wordHost(word: string, tlds: ReadonlySet<string>): string | null {
  const w = word.replace(EDGES, "");
  if (!w) return null;
  const explicit = w.includes("://") || w.toLowerCase().startsWith("www.") || w.includes("/");
  let u: URL;
  try {
    u = new URL(w.includes("://") ? w : `http://${w}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname;
  const h = host.replace(/\.+$/, "");
  if (!h.includes(".")) return null;
  const last = h.split(".").pop() ?? "";
  const ok = explicit ? last.startsWith("xn--") || /^[A-Za-z]{2,}$/.test(last) : tlds.has(last.toLowerCase()) && !EXCLUDE.has(last.toLowerCase());
  return ok ? normHost(host) : null;
}

/** [claimed, real] when `text` claims another host than the http(s) link `href` opens (claim_for), else null. */
export function claimFor(href: string, text: string, tlds: ReadonlySet<string>): [string, string] | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  const real = normHost(u.hostname);
  if (real === "matrix.to") return null;
  for (const word of String(text ?? "").replace(INVISIBLE, "").split(/\s+/)) {
    const c = word ? wordHost(word, tlds) : null;
    if (c && c !== real) return [c, real];
  }
  return null;
}

/** The host a link opens, as the app names it (lower case, a leading www. dropped), or "" (mailto / none). */
export function destinationHost(href: string): string {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return normHost(u.hostname);
  } catch {
    return "";
  }
}

/** The hover text for a link in a message: where it goes, never the member's own words. */
export function linkHoverText(href: string): string {
  const safe = safeExternalUrl(href);
  if (!safe) return steamUrl(href) ? "Opens the Steam app (asks first)" : "";
  if (safe.startsWith("mailto:")) return `Writes to ${decodeURIComponentSafe(safe.slice(7).split("?")[0] ?? "")}`;
  const host = destinationHost(safe);
  return host ? `Opens ${host}` : "";
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

