// people.ts — the add-people picker's shared rules (2026-11-12, feat/people-search): one picker for room Invite, New DM
// and space Invite. Pure (dmTarget only). The desktop's crates/app/src/people.rs applies the same rules; both replay
// testvectors/people-search.json byte for byte.
//
//   peopleQuery(text, own)   what the field means: empty / a name / a plain username (YOUR server, the dmTarget rule) /
//                            an address with a server ("@alex:elsewhere.example" or "alex:elsewhere.example")
//   matchScore(name, id, t)  4 exact, 3 prefix, 2 a word's prefix, 1 anywhere, 0 none (display name and username)
//   personLabel(id, name)    "Alex" for someone on your server, "Alex · elsewhere.example" for anyone else (display names are
//                            not unique: the server is the impostor guard, as on invite cards)
//   rankPeople(…)            the rows: People you know (DM partners first, then by match, then shared rooms; 8),
//                            On <your server> (the user directory in its own order; 10), and one look-up row for a
//                            typed username/address nobody listed; members dimmed, never yourself; Enter's pick (the
//                            typed person first) and its fallback when that look-up fails (yours only)
//   lookupOutcome(…)         why a profile look-up failed, in plain words; only a refusal still allows an invite
import { dmTarget, serverOf } from "../nav/dmTarget";

export type QueryKind = "empty" | "name" | "username" | "address";
export interface PeopleQuery {
  kind: QueryKind;
  /** the text to match and to search the directory with ("@" and a matrix.to prefix dropped) */
  term: string;
  /** the user the text names, if it can be one (a plain username → your server) */
  target: string | null;
}

const LINK = /^https?:\/\/matrix\.to\/#\/([^?]*)/i;

// The spaces both apps agree on (Rust's ASCII whitespace): JavaScript's \s and trim() know more (U+00A0, U+0085 …) than
// Rust's, so these rules use ASCII only, and names compare by code point (UTF-16 order differs from Rust's above U+FFFF).
const WS = /[ \t\n\f\r]+/;
export const atrim = (s: string) => s.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, "");
function cmpCodePoints(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = (A[i].codePointAt(0) ?? 0) - (B[i].codePointAt(0) ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

export function peopleQuery(input: string, ownServer: string): PeopleQuery {
  let s = atrim(input ?? "");
  if (!s) return { kind: "empty", term: "", target: null };
  const link = LINK.exec(s);
  if (link) s = atrim(link[1]);
  const term = s.startsWith("@") ? s.slice(1) : s;
  const target = dmTarget(input, ownServer);
  if (!target) return { kind: "name", term, target: null };
  return { kind: term.includes(":") ? "address" : "username", term, target };
}

function localOf(mxid: string): string {
  const s = mxid.startsWith("@") ? mxid.slice(1) : mxid;
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(0, i) : s;
}

/** How well a person matches what was typed: 4 exact, 3 prefix, 2 a word of the name starts with it, 1 anywhere, 0 no. */
export function matchScore(name: string, mxid: string, term: string): number {
  let t = atrim(term ?? "").toLowerCase();
  if (t.startsWith("@")) t = t.slice(1);
  if (!t) return 0;
  const id = (mxid.startsWith("@") ? mxid.slice(1) : mxid).toLowerCase();
  if (t.includes(":")) return id === t ? 4 : id.startsWith(t) ? 3 : 0;
  const local = localOf(id);
  const n = atrim(name ?? "").toLowerCase();
  if (local === t || n === t) return 4;
  if (n.startsWith(t) || local.startsWith(t)) return 3;
  if (n.split(WS).some((w) => w.startsWith(t))) return 2;
  if (n.includes(t) || local.includes(t)) return 1;
  return 0;
}

/** The name to show ("" → the username) and, for anyone not on your server, their server. */
export function personLabel(mxid: string, name: string, ownServer: string): { server: string; line: string } {
  const shown = atrim(name ?? "") || localOf(mxid);
  const theirs = serverOf(mxid);
  const server = theirs.toLowerCase() === atrim(ownServer ?? "").toLowerCase() ? "" : theirs;
  return { server, line: server ? `${shown} · ${server}` : shown };
}

/** The picture a row may show: mxc:// only (fetched through your own server). An http(s) avatar_url in a directory,
 *  profile or member answer would make the browser reach that server directly; the desktop reads mxc:// only too. */
export function pickerPicture(url: string | null | undefined): string {
  return typeof url === "string" && url.startsWith("mxc://") ? url : "";
}

export type Section = "known" | "server" | "other";

export function sectionTitle(section: Section, ownServer: string): string {
  if (section === "known") return "People you know";
  if (section === "server") return `On ${ownServer}`;
  return "On another server";
}

export interface KnownPerson {
  mxid: string;
  name: string;
  avatar: string;
  /** you have a DM with them */
  dm: boolean;
  /** how many rooms you share (DMs included) */
  shared: number;
}
export interface DirectoryHit {
  mxid: string;
  name: string;
  avatar: string;
}
export interface PersonRow {
  section: Section;
  mxid: string;
  name: string;
  avatar: string;
  /** their server when it isn't yours ("" = yours) */
  server: string;
  /** name, plus " · server" for outsiders */
  line: string;
  /** already in the room/space: dimmed, can't be picked */
  member: boolean;
  /** nobody listed them: the picker looks the address up before it can be picked */
  lookup: boolean;
  dm: boolean;
}

export const KNOWN_MAX = 8;
export const DIRECTORY_MAX = 10;

export function rankPeople(o: {
  input: string;
  own: string;
  me: string;
  known: readonly KnownPerson[];
  directory: readonly DirectoryHit[];
  members: readonly string[];
}): { query: PeopleQuery; rows: PersonRow[]; pick: number; fallback: number } {
  const q = peopleQuery(o.input, o.own);
  if (q.kind === "empty") return { query: q, rows: [], pick: -1, fallback: -1 };
  const members = new Set(o.members);
  const listed = new Set<string>([o.me]);
  const row = (section: Section, mxid: string, name: string, avatar: string, dm: boolean, lookup: boolean): PersonRow => {
    const l = personLabel(mxid, name, o.own);
    return { section, mxid, name: atrim(name ?? "") || localOf(mxid), avatar: avatar ?? "", server: l.server, line: l.line, member: members.has(mxid), lookup, dm };
  };
  const scored = o.known
    .filter((p) => p.mxid !== o.me)
    .map((p) => ({ p, sc: matchScore(p.name, p.mxid, q.term) }))
    .filter((x) => x.sc > 0);
  scored.sort((a, b) => {
    if (a.p.dm !== b.p.dm) return a.p.dm ? -1 : 1;
    if (a.sc !== b.sc) return b.sc - a.sc;
    if (a.p.shared !== b.p.shared) return b.p.shared - a.p.shared;
    const byName = cmpCodePoints(atrim(a.p.name ?? "").toLowerCase(), atrim(b.p.name ?? "").toLowerCase());
    return byName || cmpCodePoints(a.p.mxid, b.p.mxid);
  });
  const rows: PersonRow[] = [];
  for (const { p } of scored.slice(0, KNOWN_MAX)) {
    rows.push(row("known", p.mxid, p.name, p.avatar, p.dm, false));
    listed.add(p.mxid);
  }
  let n = 0;
  for (const h of o.directory) {
    if (n >= DIRECTORY_MAX) break;
    if (listed.has(h.mxid)) continue;
    rows.push(row("server", h.mxid, h.name, h.avatar, false, false));
    listed.add(h.mxid);
    n++;
  }
  if (q.target && !listed.has(q.target)) {
    const outsider = personLabel(q.target, "", o.own).server !== "";
    rows.push(row(outsider ? "other" : "server", q.target, "", "", false, true));
  }
  // Enter: the person the text names, when it names one (a look-up row waits for its look-up; display names are not
  // unique, so a look-alike never takes Enter from a typed username); else the first listed person. `fallback` = what
  // Enter means once the typed username's look-up has failed: the first listed person on YOUR server (never an outsider).
  // when the text names someone, Enter never lands on another server's person instead (they may be a member already, or you)
  // A full address ("@alice:their.server") means exactly that person: Enter never lands on anyone else, not when they
  // are a member already and not after their look-up failed (a local person's display name may copy the address).
  const exact = q.kind === "address";
  let pick = rows.findIndex((r) => r.mxid === q.target && !r.member);
  if (pick < 0 && !exact) pick = rows.findIndex((r) => !r.member && !r.lookup && (!q.target || r.server === ""));
  const fallback = exact ? -1 : rows.findIndex((r) => !r.member && !r.lookup && r.server === "");
  return { query: q, rows, pick, fallback };
}

export type LookupKind = "found" | "notfound" | "nofederation" | "refused" | "unreachable" | "ratelimited";

/** A profile look-up's answer → what the picker says. `status` 0 = no answer at all (network). */
export function lookupOutcome(
  status: number,
  errcode: string,
  message: string,
  target: string,
  ownServer: string,
): { kind: LookupKind; pickable: boolean; text: string } {
  const server = personLabel(target, "", ownServer).server;
  const local = localOf(target);
  if (status >= 200 && status < 300) return { kind: "found", pickable: true, text: "" };
  if (status === 429 || errcode === "M_LIMIT_EXCEEDED") return { kind: "ratelimited", pickable: false, text: "Too many look-ups at once. Try again in a moment." };
  if (status === 404 || errcode === "M_NOT_FOUND")
    return {
      kind: "notfound",
      pickable: false,
      text: server ? `${server} has no one called ${local}. Check the spelling.` : `There's no one called ${local} on your server. Check the spelling.`,
    };
  if (status === 403 && server && /federation denied/i.test(message ?? ""))
    return {
      kind: "nofederation",
      pickable: false,
      text: `Your server doesn't connect to ${server}, so people there can't be reached from here. The owner of your server can change that.`,
    };
  if (status === 401 || status === 403)
    return {
      kind: "refused",
      pickable: true,
      text: `${server || "Your server"} only shows profiles to people who already share a room. You can still invite them.`,
    };
  return {
    kind: "unreachable",
    pickable: false,
    text: server ? `Couldn't reach ${server} right now. Their server may be down; try again later.` : "Couldn't reach your server right now. Try again in a moment.",
  };
}
