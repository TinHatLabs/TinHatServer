// joinLink.ts — what a pasted link points at: the pure core of actions.ts parseJoinLink (room.rs parse_join_link, the
// same rules). Takes every shape people paste: matrix.to links, Tin Hat Web links (`<web app>/#/room/…`, also to a
// message: `…/$event`), the wrapped form `https://tinhat.dev/open#<link>` (core/links.ts), old element-web links, bare
// `#alias:server` / `!id:server`, percent-encoded or not. Cases: testvectors/share-links/vectors.json (section `parse`,
// shared with the desktop). No app imports: the unit test runs it in plain Node.
import { decodeOrKeep, OPEN_PREFIX } from "../../core/links";

export type LinkTarget = { kind: "room"; target: string; via: string[] } | { kind: "person"; who: string } | { kind: "none" };

export function linkTarget(input: string): LinkTarget {
  let s = (input ?? "").trim();
  if (!s) return { kind: "none" };
  // a wrapped link carries the real one in its fragment
  if (s.startsWith(OPEN_PREFIX)) s = s.slice(OPEN_PREFIX.length);
  const hashAt = s.indexOf("#/");
  if (hashAt >= 0) s = s.slice(hashAt + 2);
  // `#/room/…`, or a profile (`#/user/@…`: a person, answered as one)
  if (s.startsWith("room/") || s.startsWith("user/")) s = s.slice(5);
  // the forms chat clients make (and our own links: encodeURIComponent); the desktop decodes the same five
  s = s.replace(/%21/gi, "!").replace(/%23/gi, "#").replace(/%40/gi, "@").replace(/%24/gi, "$").replace(/%3A/gi, ":");
  const via: string[] = [];
  const q = s.indexOf("?");
  if (q >= 0) {
    for (const part of s.slice(q + 1).split("&")) {
      if (part.startsWith("via=") && part.length > 4) via.push(decodeOrKeep(part.slice(4)));
    }
    s = s.slice(0, q);
  }
  s = s.replace(/\/+$/, "").trim();
  // a link to a message (`!room:server/$event`, matrix.to's and ours): the room. Only a `/` followed by an event id
  // (`$…`) ends the room part (`/` is legal in an alias: a bare `#a/b:server` stays whole). Cut before decoding, so an
  // encoded `%2F` inside an alias stays in it and a broken escape in the event part can't stop the room decoding …
  s = cutAtEvent(s);
  // anything still encoded (a non-ASCII alias); a malformed escape keeps the text as it is
  s = decodeOrKeep(s).trim();
  // … and again after it, for a link that encoded the `/$` too
  s = cutAtEvent(s);
  if (s.startsWith("@") && s.includes(":")) return { kind: "person", who: s };
  // `!id:server` / `#alias:server` (something on both sides of the `:`), or a room-version-12 id `!opaque`
  if (/^[!#][^:]+:[^]+$/.test(s) || /^![^\s:]+$/.test(s)) return { kind: "room", target: s, via };
  return { kind: "none" };
}

/** `!room:server/$event` → the room: cut at the first `/$` whose head is a whole room (`!id:server`, `#alias:server`
 *  or a v12 `!opaque`). An alias may itself hold `/$` (`#a/$b:server`, legal): its `#a` is no room, so it stays whole
 *  (assembly-037 W4; room.rs cut_at_event is the same rule). */
function cutAtEvent(s: string): string {
  if (!/^[!#]/.test(s)) return s;
  for (let i = s.indexOf("/$"); i > 0; i = s.indexOf("/$", i + 1)) {
    const head = s.slice(0, i);
    if (/^[!#][^:]+:[^]+$/.test(head) || /^![^\s:]+$/.test(head)) return head;
  }
  return s;
}
