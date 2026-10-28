// links.ts — the links Tin Hat hands out: "Copy link" on a room or space, Share, a message's "Copy link" (12.0.6, "Tin Hat
// links, not matrix.to"). SHARED LOGIC: the desktop's crates/app/src/share_link.rs implements the same rules, line for
// line, and both replay testvectors/share-links/vectors.json (the desktop owns it: crates/app/src/testvectors/share-links.json,
// this is a byte copy). Whitespace = JS \s (String.trim; the desktop's js_space), case = ASCII only. Pure: no React, no app imports — the unit test runs it in plain Node.
//
// A room on the signed-in server opens in that server's own web app: `<web base>/#/room/<alias or id>[/<event id>]`, the
// parts encoded like encodeURIComponent (app/router.ts decodes exactly that). The desktop's web base is the well-known's
// `dev.tinhat.server.web` (an https origin), else the origin of its `api`; Tin Hat Web uses its own page's origin when
// that is https (this page IS the server's web app), else the same rule. Never a built-in name. A room on another
// server (federation), or a server that announces neither, keeps a matrix.to link: we don't know that server's web app.
//
// WRAP_OPEN_LINKS (off until tinhat.dev serves /open and its app-link files): an own-server link whose host is not under
// tinhat.me goes out as `https://tinhat.dev/open#<link>`, so the phone apps (which claim tinhat.dev/open and *.tinhat.me)
// open it. tinhat.me hosts are claimed directly and are never wrapped; matrix.to links never are.
//
// The read side (a pasted link of any of these shapes, the wrapped one included) is features/nav/actions.ts
// parseJoinLink; its cases are in the same vectors file (section `parse`).

/** Wrap own-server links in `https://tinhat.dev/open#…`. OFF until tinhat.dev serves /open + its app-link files and the
 *  apps that unwrap the form are out (server docs/DEEPLINKS.md "Rollout order"). */
export const WRAP_OPEN_LINKS = false;

/** The claimed link that carries a server's own link in its fragment (the phone apps and tinhat.dev/open read it). */
export const OPEN_PREFIX = "https://tinhat.dev/open#";

/** encodeURIComponent, byte for byte (UTF-8, upper-case hex). */
export function encodeComponent(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (b < 128 && /[A-Za-z0-9\-_.!~*'()]/.test(c)) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** decodeURIComponent, except that where it would throw (a `%` without two hex digits after it, bytes that aren't UTF-8)
 *  the text comes back as it is. The desktop's decode_component. */
export function decodeOrKeep(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** ASCII-only lower case (the desktop's to_ascii_lowercase / eq_ignore_ascii_case: no Unicode case folding). */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** A host[:port] as a link may carry it: a DNS-style host (letters, digits, `.` and `-`) or a bracketed IPv6 literal,
 *  then an optional port 1–65535. No user info, path, spaces or anything else. Server names are checked the same way
 *  before they become a `via` hint. The desktop's authority_ok. */
export function authorityOk(a: string): boolean {
  let hostOk: boolean;
  let rest: string;
  const end = a.startsWith("[") ? a.indexOf("]") : -1;
  if (end > 0) {
    hostOk = ipv6Ok(a.slice(1, end));
    rest = a.slice(end + 1);
  } else {
    const c = a.indexOf(":");
    const host = c >= 0 ? a.slice(0, c) : a;
    hostOk = host !== "" && /^[A-Za-z0-9.-]+$/.test(host);
    rest = a.slice(host.length);
  }
  if (!hostOk) return false;
  if (rest === "") return true;
  if (!rest.startsWith(":")) return false;
  const p = rest.slice(1);
  return p.length >= 1 && p.length <= 5 && /^[0-9]+$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
}

/** An IPv6 literal's inside (no brackets): eight groups of 1–4 hex digits, or fewer around one `::` (no dotted IPv4
 *  tail). A linear scan (the desktop's ipv6_ok; no backtracking regex). */
function ipv6Ok(inner: string): boolean {
  if (inner === "" || !/^[0-9A-Fa-f:]+$/.test(inner)) return false;
  const groupOk = (g: string) => g.length >= 1 && g.length <= 4;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const dc = inner.indexOf("::");
  if (dc >= 0) {
    const l = inner.slice(0, dc);
    const r = inner.slice(dc + 2);
    if (r.includes("::")) return false;
    const lg = groups(l);
    const rg = groups(r);
    return [...lg, ...rg].every(groupOk) && lg.length + rg.length <= 7;
  }
  const g = inner.split(":");
  return g.length === 8 && g.every(groupOk);
}

/** Where this server's web app lives (no trailing slash), or "" when it doesn't say:
 *  1. `web` (`dev.tinhat.server.web`): an https origin only (`https://host[:port]`, one trailing `/` allowed; no path,
 *     query, fragment or user info);
 *  2. else the origin of `api` (`dev.tinhat.server.api`, http or https: a home-network server may be plain http). */
export function webBase(web: string, api: string): string {
  const w = (web ?? "").trim();
  if (asciiLower(w.slice(0, 8)) === "https://") {
    let rest = w.slice(8);
    if (rest.endsWith("/")) rest = rest.slice(0, -1);
    if (authorityOk(rest)) return `https://${asciiLower(rest)}`;
  }
  const a = (api ?? "").trim();
  for (const scheme of ["https", "http"]) {
    const p = `${scheme}://`;
    if (asciiLower(a.slice(0, p.length)) === p) {
      const authority = a.slice(p.length).split(/[/?#]/)[0];
      return authorityOk(authority) ? `${scheme}://${asciiLower(authority)}` : "";
    }
  }
  return "";
}

/** The server part of a room id / alias / user id: everything after the first `:` ("" for a room id without one, room
 *  version 12). */
export function serverPart(id: string): string {
  const i = id.indexOf(":");
  return i >= 0 ? id.slice(i + 1) : "";
}

/** Is the link's host claimed by the phone apps directly (`tinhat.me` and its names)? `base` = `scheme://host[:port]`. */
function tinhatMeHost(base: string): boolean {
  const i = base.indexOf("://");
  const authority = i >= 0 ? base.slice(i + 3) : base;
  const host = authority.startsWith("[") ? authority : authority.split(":")[0];
  return host === "tinhat.me" || host.endsWith(".tinhat.me");
}

/** What a link is made from (the vectors' fields). */
export interface LinkInput {
  /** the room id (`!opaque:server`, or `!opaque` from room version 12) */
  room: string;
  /** its published alias, "" for none (a room link prefers it; a message link always names the room id) */
  alias?: string;
  /** the event id for a message link, "" for a room link */
  event?: string;
  /** the signed-in account's server name */
  own: string;
  /** the well-known's `dev.tinhat.server.web`, "" when absent */
  web?: string;
  /** the well-known's `dev.tinhat.server.api`, "" when absent */
  api?: string;
  /** WRAP_OPEN_LINKS (a parameter so the vectors cover both) */
  wrap?: boolean;
}

/** The link to share for a room, a space or a message ("" when there is no room id). */
export function shareLink(i: LinkInput): string {
  return shareLinkOn(i, webBase(i.web ?? "", i.api ?? ""));
}

/** shareLink with the web base already chosen (Tin Hat Web passes its own page's origin). */
export function shareLinkOn(i: LinkInput, base: string): string {
  const room = (i.room ?? "").trim();
  const alias = (i.alias ?? "").trim();
  const event = (i.event ?? "").trim();
  const own = (i.own ?? "").trim();
  const target = !event && alias ? alias : room;
  if (!target) return "";
  const server = serverPart(target);
  // someone signed in, and the room is on their server (ASCII case only; a room-version-12 id has no server part: we are
  // in the room, so our server can serve it)
  const isOwn = own !== "" && (server === "" || asciiLower(server) === asciiLower(own));
  const path = encodeComponent(target) + (event ? `/${encodeComponent(event)}` : "");
  if (isOwn && base) {
    const link = `${base}/#/room/${path}`;
    return i.wrap && base.startsWith("https://") && !tinhatMeHost(base) ? OPEN_PREFIX + link : link;
  }
  // matrix.to: a room id gets a `via` hint (a bare id leaves the other client no server to ask), only a server name that
  // can be one (never `&`, `=`, … into the query)
  const v = target.startsWith("!") ? server || own : "";
  const via = authorityOk(v) ? v : "";
  return `https://matrix.to/#/${path}${via ? `?via=${via}` : ""}`;
}

/** The web base Tin Hat Web uses: its own page's origin when https (this page is the server's web app), else the
 *  well-known's rule (a dev server on http://127.0.0.1, a home-network server on plain http). */
export function pageWebBase(pageOrigin: string, web: string, api: string): string {
  const p = (pageOrigin ?? "").trim().replace(/\/+$/, "");
  if (/^https:\/\//i.test(p) && authorityOk(p.slice(8))) return `https://${asciiLower(p.slice(8))}`;
  return webBase(web, api);
}
