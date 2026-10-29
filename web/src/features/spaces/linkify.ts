// linkify.ts — room topics and profile bios: plain text → escaped HTML with http(s) links (RightPanel / ProfileCard).
// Pure (relative imports only): linkify.test.ts runs it under Node.
import { safeExternalUrl } from "../../core/openlink";

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = (x: string) => esc(x).replace(/\n/g, "<br>");

/** RightPanel.linkify: wrap http(s) URLs (trailing punctuation stays outside) — only what the one link rule allows
 *  (core/openlink safeExternalUrl: no user name before the host, no controls; launch-gate review), with the normalised
 *  address as the href — and escape everything. URLs are found and trimmed in the RAW text, then escaped (assembly verify
 *  C, sec-night 2026-10-27: trimming the escaped text cut the `;` off `&quot;`, so the link got `&quot` in its query).
 *  The desktop's RightPanel.qml linkify is the same walk. The containers open links through core/linkgate. */
export function linkify(s: string): string {
  const raw = String(s || "");
  const re = /https?:\/\/\S+/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const u = m[0];
    const trail = /[.,;:!?)]+$/.exec(u)?.[0] ?? "";
    const core = u.slice(0, u.length - trail.length);
    const href = safeExternalUrl(core);
    out += escText(raw.slice(last, m.index));
    out += href ? `<a href="${esc(href)}">${esc(core)}</a>${esc(trail)}` : esc(u); // refused: shown as the text it is
    last = m.index + u.length;
  }
  return out + escText(raw.slice(last));
}
