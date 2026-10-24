// mention.ts — which user a matrix.to link in a message points at (the read side of @mention pills).
// Pure, no DOM: html.ts (the DOMPurify hook) and the unit test use it; the desktop's ChatBubble.qml
// onLinkActivated applies the same two rules (W2, docs/VERIFY-SAS.md):
//   1. never throw — decodeURIComponent on a malformed escape ("@50%:server") threw inside the sanitiser
//      hook during render, and with no error boundary one such message blanked every web client showing it;
//      on a bad escape fall back to the raw id with only %40 / %3A decoded
//   2. percent-encoded mentions (https://matrix.to/#/%40user%3Aserver — what most clients' permalinks
//      produce) are mentions too, not external links
const MATRIX_TO_USER = /^https:\/\/matrix\.to\/#\/((?:@|%40)[^/?#]*)/i;

/** The user id a matrix.to link mentions, or null if the link is not a user mention. */
export function mentionFromHref(href: string): string | null {
  const m = MATRIX_TO_USER.exec(href);
  if (!m) return null;
  const raw = m[1];
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    id = raw.replace(/%40/gi, "@").replace(/%3a/gi, ":");
  }
  return id.length > 1 && id.startsWith("@") ? id : null;
}
