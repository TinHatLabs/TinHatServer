// linkify.ts — room topics and profile bios: plain text → escaped HTML with http(s) links (RightPanel / ProfileCard).
// Pure (relative imports only): linkify.test.ts runs it under Node.
import { safeExternalUrl } from "../../core/openlink";

/** RightPanel.linkify: escape, then wrap http(s) URLs (trailing punctuation stays outside) — only what the one link rule
 *  allows (core/openlink safeExternalUrl: no user name before the host, no controls; launch-gate review), with the
 *  normalised address as the href. The containers open them through core/linkgate (linkContainerEvents). */
export function linkify(s: string): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const unesc = (x: string) => x.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  const t = esc(String(s || "")).replace(/\n/g, "<br>");
  return t.replace(/(https?:\/\/[^\s<]+)/g, (u) => {
    const trail = /[.,;:!?)]+$/.exec(u);
    const core = trail ? u.slice(0, -trail[0].length) : u;
    const href = safeExternalUrl(unesc(core));
    if (!href) return u; // shown as the text it is, no link
    return `<a href="${esc(href)}">${core}</a>${trail ? trail[0] : ""}`;
  });
}
