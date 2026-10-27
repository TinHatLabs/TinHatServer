// openlink.ts — the one way the app opens someone else's link in a new tab (security review 2026-10-26, the H1 class):
// http(s) and mailto only. A `javascript:` (or `data:`, `blob:`, `file:`…) URL handed to window.open runs in a fresh
// window whose initial document has THIS origin, so a link from room state (a Media Party queue item, a song's
// source) or a message must never reach window.open unchecked. The desktop routes Qt.openUrlExternally through the same
// rule. Pure except for the window.open call: openlink.test.ts runs safeExternalUrl under Node.

/** The URL when it may be opened outside the app (http:, https:, mailto:), else null. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    // Chromium's URL parser escapes a space in a host ("exa mple.org" → "exa%20mple.org") where the URL standard (and
    // the desktop) refuse it: no whitespace in the written authority and no "%" in the parsed host name
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(s)?.[1] ?? "";
    if (/\s/.test(authority) || u.hostname.includes("%") || !u.hostname) return null;
    return u.username || u.password ? null : u.href;
  }
  if (u.protocol === "mailto:") {
    try {
      return new URL(mailtoKept(s)).href;
    } catch {
      return null;
    }
  }
  return null;
}

/** A steam:// link — the only app scheme allowed, and only after an "Open in Steam?" question (the owner's decision, 2026-10-26; the
 *  shared links vectors' `ask: "steam"`): `steam://` and something after it, no white space, controls or backslash;
 *  returned as typed (trimmed). Everything else null. */
export function steamUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^steam:\/\/[^\s\\\u0000-\u001f\u007f]+$/i.test(s) ? s : null;
}

/** What a link may open, and whether the app asks first: http(s) / mailto (safeExternalUrl), or steam:// with the
 *  question; null = refused (member-content.json links: `open`, `as`, `ask`). */
export function linkVerdict(raw: unknown): { as: string; ask?: "steam" } | null {
  const web = safeExternalUrl(raw);
  if (web) return { as: web };
  const steam = steamUrl(raw);
  return steam ? { as: steam, ask: "steam" } : null;
}

/** Open `raw` in a new tab (noopener, no referrer) if safeExternalUrl allows it; false = refused. */
export function openExternal(raw: unknown): boolean {
  const url = safeExternalUrl(raw);
  if (!url) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/** A mailto keeps only its subject, body and cc fields (names case-insensitive), no fragment — an `attach=` /
 *  `bcc=` a member wrote never reaches the mail client (shared rule: member-content.json links "as"; richtext.rs
 *  mailto_kept). */
export function mailtoKept(s: string): string {
  const noFrag = s.split("#", 1)[0] ?? "";
  const q = noFrag.indexOf("?");
  if (q < 0) return noFrag;
  const kept = noFrag
    .slice(q + 1)
    .split("&")
    .filter((p) => ["subject", "body", "cc"].includes((p.split("=", 1)[0] ?? "").toLowerCase()));
  return kept.length ? `${noFrag.slice(0, q)}?${kept.join("&")}` : noFrag.slice(0, q);
}
