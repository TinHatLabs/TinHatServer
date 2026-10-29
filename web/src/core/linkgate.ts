// linkgate.ts — opening someone else's link (security review 2026-10-26: Astra, launch-gate): the app itself — not the
// member's formatting, which can hide the " (real-host)" note in its own colours or stop it with a hidden word — names
// the destination. The desktop's LinkGate.qml / richtext.rs link_claim follow the same rules.
//   • hovering a link shows "Opens <host>" (members can't set a title: html.ts drops it);
//   • a click (primary or middle) on a link whose text names ANOTHER host — any word of it, invisible characters ignored —
//     asks first in the app's own dialog (chat/linkconfirm.tsx): "The text says bank.example, but this link opens
//     attacker.example.";
//   • the same for every container of member text with links: message bubbles, room topics, profile bios.
// The pure rules live in core/claims.ts; this adds the store the dialog reads and the container events.
import { create } from "zustand";
import { openExternal, safeExternalUrl, steamUrl } from "./openlink";
import { claimFor, claimText, destinationHost, linkHoverText, normHost } from "./claims";
import { TLDS } from "./tlds";

export { destinationHost, linkHoverText, normHost };

/** The host `text` claims other than the one `href` opens (core/claims.ts, the shared rule), or null. */
export function claimedHost(href: string, text: string): string | null {
  return claimFor(href, text, TLDS)?.[0] ?? null;
}

/** What the app's one link dialog asks (chat/linkconfirm.tsx renders it). */
export interface LinkQuestion {
  /** what Open opens (already through the link rules) */
  href: string;
  title: string;
  message: string;
  confirmText: string;
  /** "web" = a new tab (openExternal); "app" = the OS hands it to an app (steam:) */
  how: "web" | "app";
}
export const useLinkConfirm = create<{ pending: LinkQuestion | null }>(() => ({ pending: null }));

/** Ask before opening (the dialog's Open runs openNow). */
function ask(q: LinkQuestion): void {
  useLinkConfirm.setState({ pending: q });
}

/** Open what a LinkQuestion confirmed. */
export function openConfirmed(q: LinkQuestion): void {
  if (q.how === "web") openExternal(q.href);
  else if (steamUrl(q.href)) window.location.assign(q.href); // the browser asks which app handles steam:
}

/** A click on a link in a message: open it, or — when its text names another host, or it opens the Steam app — ask
 *  first. */
export function openMessageLink(href: string, text: string): void {
  const safe = safeExternalUrl(href);
  if (!safe) {
    const steam = steamUrl(href);
    if (steam) ask({ href: steam, title: "Open in Steam?", message: `This link opens the Steam app: ${steam}`, confirmText: "Open", how: "app" });
    return;
  }
  const c = claimFor(safe, text, TLDS);
  if (c) ask({ href: safe, title: "Open this link?", message: `The text says ${c[0]}, but this link opens ${c[1]}.`, confirmText: `Open ${c[1]}`, how: "web" });
  else openExternal(safe);
}

/** Event handlers for an element whose HTML holds member links (a bubble's body, a topic, a bio): every link goes through
 *  openMessageLink (click and middle-click), says where it goes on hover, can't be dragged out to a tab. `onMention`
 *  takes the matrix.to user links the sanitiser marked (data-mention). */
export function linkContainerEvents(onMention?: (mxid: string, a: HTMLAnchorElement) => void) {
  const anchor = (e: { target: EventTarget | null }) => (e.target instanceof Element ? (e.target.closest("a") as HTMLAnchorElement | null) : null);
  const activate = (e: { target: EventTarget | null; preventDefault(): void; stopPropagation(): void }) => {
    const a = anchor(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const mx = a.getAttribute("data-mention");
    // a bubble's steam:// link carries its address in data-steam, not href (html.ts appLinks)
    const href = a.getAttribute("href") || a.getAttribute("data-steam");
    if (mx && onMention) onMention(mx, a);
    else if (!mx && href) openMessageLink(href, claimText(a));
  };
  return {
    onClick: activate,
    // middle-click opens a tab natively: the same door instead (auxclick is where that default action is cancelled)
    onAuxClick: (e: { button: number; target: EventTarget | null; preventDefault(): void; stopPropagation(): void }) => {
      if (e.button === 1) activate(e);
    },
    // a bubble's steam:// link has no href (html.ts), so the browser gives it no Enter: the same door here
    onKeyDown: (e: { key: string; target: EventTarget | null; preventDefault(): void; stopPropagation(): void }) => {
      if (e.key === "Enter" && anchor(e)?.hasAttribute("data-steam")) activate(e);
    },
    onMouseDown: (e: { button: number; target: EventTarget | null; preventDefault(): void }) => {
      if (e.button === 1 && anchor(e)) e.preventDefault(); // no autoscroll / paste on a link
    },
    onMouseOver: (e: { target: EventTarget | null }) => {
      const a = anchor(e);
      const href = a ? a.getAttribute("href") || a.getAttribute("data-steam") : null;
      if (a && href && !a.getAttribute("data-mention") && !a.hasAttribute("title")) a.setAttribute("title", linkHoverText(href));
    },
    onDragStart: (e: { target: EventTarget | null; preventDefault(): void }) => {
      if (anchor(e)) e.preventDefault(); // dropping it on the tab bar would open it without the door
    },
  };
}
