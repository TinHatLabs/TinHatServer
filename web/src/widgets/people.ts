// people.ts — who is listed where, and in which order (contract WIDGETS.md §10.6; vectors testvectors/widgets/people/*):
// the Call stats rows (their order, each person's band, the summary's worst person, the compact ↓ ↑ label) and Who's
// around's groups (Playing, In a call, Online, Away, the Small row). Pure: no DOM, no React. The desktop's Rust port
// runs the same vectors, so every rule here is byte-level: strings compare in code-point order (cmpStr), case changes
// and trims are ASCII-only.
import { cmpStr, isRecorderUser } from "./history";
import { cqBand, fmtRate, worstBand, type Band } from "./quality";

/** ASCII letters lower-cased (A–Z → a–z); every other character unchanged (the same bytes in every language). */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/** ASCII whitespace (U+0009–U+000D, U+0020) trimmed from both ends. */
export function asciiTrim(s: string): string {
  const ws = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  let a = 0;
  let b = s.length;
  while (a < b && ws(s.charCodeAt(a))) a++;
  while (b > a && ws(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** Row order everywhere a list of people is shown: the name with ASCII letters lower-cased, then the name as written,
 *  then the id — each in code-point order. */
export function cmpPeople(a: { id: string; name: string }, b: { id: string; name: string }): number {
  return cmpStr(asciiLower(a.name), asciiLower(b.name)) || cmpStr(a.name, b.name) || cmpStr(a.id, b.id);
}

// ---- Call stats -----------------------------------------------------------------------------------------------------

export interface CallPerson {
  /** the LiveKit identity (unique per device) */
  id: string;
  /** the display name the row shows */
  name: string;
  /** LiveKit ConnectionQuality ("excellent" | "good" | "poor" | "lost" | anything else = unknown) */
  cq?: string | null;
  /** the incoming lane's band (worst of the received tracks) and the outgoing lane's (their last tinhat.rxq q; null =
   *  stale / never) */
  inBand?: Band | null;
  outBand?: Band | null;
}

export interface CallSummary {
  /** alone: nobody else in the call · measuring: nobody has a band yet · good: every known band is good ·
   *  worst: `id` has the worst band (`band` = ok | poor) */
  kind: "alone" | "measuring" | "good" | "worst";
  id?: string;
  band?: Band;
}

export interface CallPeople {
  /** the ids in row order */
  order: string[];
  /** each row's band (row order): worstBand(cqBand(cq), inBand, outBand) — the row's dot uses cqBand alone */
  bands: (Band | null)[];
  summary: CallSummary;
}

const RANK: Record<Band, number> = { good: 0, ok: 1, poor: 2 };
const bandOrNull = (b: unknown): Band | null => (b === "good" || b === "ok" || b === "poor" ? b : null);

/** The Call stats rows: sorted by cmpPeople; each person's band; the summary — the FIRST person in row order with the
 *  worst band when that band is ok or poor. */
export function callPeople(people: readonly CallPerson[]): CallPeople {
  const rows = [...people].sort(cmpPeople);
  const bands = rows.map((p) => worstBand([cqBand(p.cq ?? null), bandOrNull(p.inBand), bandOrNull(p.outBand)]));
  let worst = -1;
  bands.forEach((b, i) => {
    if (b && (worst < 0 || RANK[b] > RANK[bands[worst]!])) worst = i;
  });
  let summary: CallSummary;
  if (!rows.length) summary = { kind: "alone" };
  else if (worst < 0) summary = { kind: "measuring" };
  else if (bands[worst] === "good") summary = { kind: "good" };
  else summary = { kind: "worst", id: rows[worst]!.id, band: bands[worst]! };
  return { order: rows.map((p) => p.id), bands, summary };
}

/** The collapsed / Small summary's rates: "↓ 2.4 ↑ 1.1 Mb/s" (one unit when both rates use the same one), else
 *  "↓ 640 kb/s ↑ 1.1 Mb/s" (fmtRate each). */
export function fmtRatePair(down: number, up: number): string {
  const a = fmtRate(down);
  const b = fmtRate(up);
  const ua = a.slice(a.lastIndexOf(" ") + 1);
  const ub = b.slice(b.lastIndexOf(" ") + 1);
  if (ua === ub) return `↓ ${a.slice(0, a.lastIndexOf(" "))} ↑ ${b.slice(0, b.lastIndexOf(" "))} ${ua}`;
  return `↓ ${a} ↑ ${b}`;
}

// ---- Who's around ---------------------------------------------------------------------------------------------------

export interface AroundPerson {
  /** the Matrix user id */
  id: string;
  /** the display name the row shows */
  name: string;
  /** the Reach state ("online" | "away" | "call"; anything else is not listed) */
  state: string;
  /** the call's room when the service tells us (you share that room), else null */
  room?: string | null;
}

export interface AroundInput {
  /** the signed-in user (never listed) */
  me: string;
  people: readonly AroundPerson[];
  /** each joined room's now-playing activity (`dev.tinhat.activity`, key ""): game + emoji as written */
  activities: Readonly<Record<string, { game?: unknown; emoji?: unknown }>>;
  /** the widget's `away` setting (false = the Away group is not shown and its people are not counted) */
  showAway: boolean;
  /** the call recorder (never listed): the account the server announces; `null` or absent = none
   *  (history.ts isRecorderUser) */
  recorder?: string | null;
}

export interface AroundRoom {
  room: string;
  /** ids in cmpPeople order */
  people: string[];
  /** Playing only: the game (ASCII-trimmed, non-empty) and the emoji (ASCII-trimmed, may be "") */
  game: string;
  emoji: string;
}

export interface AroundGroups {
  playing: AroundRoom[];
  inCall: AroundRoom[];
  /** in a call in a room you are not in (no room from the service) */
  callElsewhere: string[];
  online: string[];
  away: string[];
  /** everyone shown (the groups' people added up) */
  total: number;
  /** the Small / collapsed row: Playing rooms' people, In a call rooms' people, call elsewhere, Online, Away */
  summary: string[];
}

/** Who's around's groups: me and the recorder (`recorder`) are left out; a person in a call with a room goes to that
 *  room's row — Playing when the room's activity has a game, else In a call; rooms ordered by their number of people
 *  (most first), then room id; every list of people in cmpPeople order; a later duplicate of an id is ignored. */
export function groupAround(input: AroundInput): AroundGroups {
  const seen = new Set<string>();
  const rooms = new Map<string, AroundPerson[]>();
  const elsewhere: AroundPerson[] = [];
  const online: AroundPerson[] = [];
  const away: AroundPerson[] = [];
  for (const p of input.people) {
    if (!p || typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.id === input.me || isRecorderUser(p.id, input.recorder)) continue;
    const who = { ...p, name: typeof p.name === "string" ? p.name : "" };
    if (p.state === "call") {
      const room = typeof p.room === "string" && p.room ? p.room : "";
      if (room) rooms.set(room, [...(rooms.get(room) ?? []), who]);
      else elsewhere.push(who);
    } else if (p.state === "online") online.push(who);
    else if (p.state === "away") away.push(who);
  }
  const ids = (l: AroundPerson[]) => [...l].sort(cmpPeople).map((p) => p.id);
  const ordered = [...rooms].sort((a, b) => b[1].length - a[1].length || cmpStr(a[0], b[0]));
  const playing: AroundRoom[] = [];
  const inCall: AroundRoom[] = [];
  for (const [room, people] of ordered) {
    const act = Object.prototype.hasOwnProperty.call(input.activities, room) ? input.activities[room] : undefined;
    const game = typeof act?.game === "string" ? asciiTrim(act.game) : "";
    const emoji = typeof act?.emoji === "string" ? asciiTrim(act.emoji) : "";
    if (game) playing.push({ room, people: ids(people), game, emoji });
    else inCall.push({ room, people: ids(people), game: "", emoji: "" });
  }
  const g: AroundGroups = {
    playing,
    inCall,
    callElsewhere: ids(elsewhere),
    online: ids(online),
    away: input.showAway ? ids(away) : [],
    total: 0,
    summary: [],
  };
  g.summary = [...g.playing.flatMap((r) => r.people), ...g.inCall.flatMap((r) => r.people), ...g.callElsewhere, ...g.online, ...g.away];
  g.total = g.summary.length;
  return g;
}
