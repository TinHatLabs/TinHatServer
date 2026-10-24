// history.ts — call history from the rooms' call-membership state events (contract WIDGETS.md §7; the precise v1
// rules in §10.1; shared vectors testvectors/widgets/history/*). Pure: no DOM, no React, no matrix-js-sdk — the web's
// cache (features/widgets/historyCache.ts) feeds it plain events and the desktop's Rust port runs the same vectors.
//
//   events (timeline order) → slots → device intervals → per-user unions (per room) → calls (per room)
//     → the week per friend + my last call
//
// Arithmetic is binary64 (JS numbers / Rust f64) in the order written; inputs are floored and bounded to ±2^53 so
// every value stays an exact integer count of milliseconds. Every list has a fixed order, so both apps produce the
// same canonical JSON (canon.ts prettyJson) for the same input.

/** The two membership event types read (the unstable MSC3401 name the apps write + the stable name). */
export const MEMBER_TYPES: readonly string[] = ["org.matrix.msc3401.call.member", "m.call.member"];
/** `expires` when a membership has none (the apps' 4 h, calls/util.ts MEMBERSHIP_EXPIRES_MS). */
export const DEFAULT_EXPIRES_MS = 14_400_000;
/** A membership never lasts longer than this after the event that states it (guards garbage `expires`/`created_ts`). */
export const EXPIRY_CAP_MS = 86_400_000;
export const DAY_MS = 86_400_000;
/** "This week" = the last 7 days, [now − 7 d, now]. */
export const WEEK_MS = 7 * DAY_MS;
/** How far back the apps fetch membership events (/messages with a type filter): the week + a day of margin. */
export const FETCH_MS = 8 * DAY_MS;

/** One membership state event as the apps hand it over, in the room's TIMELINE order (the server's order: backward
 *  pagination reversed, then sync) — that order, not origin_server_ts, decides which event replaced which. */
export interface MemberEvent {
  /** event id — duplicates (the same id twice: cache + sync) are dropped, first one kept */
  id?: string;
  type: string;
  /** state key */
  key: string;
  sender: string;
  /** origin_server_ts */
  ts: number;
  content: unknown;
}
export interface RoomEvents {
  room: string;
  events: MemberEvent[];
}
export interface HistoryInput {
  /** my user id */
  me: string;
  now: number;
  rooms: RoomEvents[];
  /** the call recorder (left out of every call): the account the server announces; `null` or absent = this server
   *  has none (nobody is left out) */
  recorder?: string | null;
}

export interface UserMs {
  user: string;
  ms: number;
}
export interface Call {
  room: string;
  start: number;
  end: number;
  /** someone's membership is still live at `now` (then end = now) */
  ongoing: boolean;
  /** the member present at the call's first instant (the earliest opening event at `start`) */
  startedBy: string;
  /** everyone who was present, with their time in the call; user code-point order */
  members: UserMs[];
  /** my time in the call (0 = I was not in it) */
  myMs: number;
}
export interface Friend {
  user: string;
  /** time I spent in a call with them in the window */
  togetherMs: number;
  /** calls in the window in which we overlapped */
  calls: number;
  /** of those: started by me / by someone else */
  started: number;
  joined: number;
}
export interface Week {
  from: number;
  to: number;
  /** my time in calls in the window, and the calls I was in */
  myMs: number;
  myCalls: number;
  /** togetherMs descending, then user code-point order; only friends with calls > 0 */
  friends: Friend[];
}
export interface LastCall {
  room: string;
  /** the room call's bounds */
  start: number;
  end: number;
  /** my first and last instant in it (the list is ranked by myEnd — when I left) */
  myStart: number;
  myEnd: number;
  /** I am still in it at `now` */
  ongoing: boolean;
  startedBy: string;
  myMs: number;
  /** who overlapped with me in it and for how long; ms descending, then user */
  with: UserMs[];
}
export interface History {
  /** every call in the data; start ascending, then room */
  calls: Call[];
  week: Week;
  last: LastCall | null;
}

// ---- small pure helpers ---------------------------------------------------------------------------------------------

/** Code-point order of two strings (= UTF-8 byte order = Rust's str Ord). */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** The call recorder: exactly the account the server announces (`recorder`); `null`, "" or absent = the server has
 *  none, so nobody is (the desktop's is_recorder_user). */
export function isRecorderUser(user: string, recorder?: string | null): boolean {
  return !!recorder && user === recorder;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
/** Inputs are bounded to ±2^53 so every sum and difference below stays an exact integer. */
export const MAX_MS = 9_007_199_254_740_992;
/** A JSON number within ±2^53, floored; else null (absent). */
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_MS ? Math.floor(v) : null;
}

/** Is `key` a membership state key owned by (sender, device)? The apps' keyrules.ts stateKeyOwned. */
export function keyOwned(key: string, sender: string, device: string, arrayForm: boolean): boolean {
  if (!sender) return false;
  if (arrayForm) return key === sender;
  if (!device) return false;
  return key === `_${sender}_${device}_m.call` || key === `_${sender}_${device}` || key === `${sender}_${device}` || key === `${sender}_${device}_m.call`;
}

/** One device a membership event states: its device id and until when it lasts. */
export interface DeviceState {
  dev: string;
  exp: number;
}

/**
 * The devices one membership event states (empty = the slot is empty: a leave, garbage, or a membership that is already
 * expired when it is sent). §7.1 rules 2–5.
 */
export function devicesOf(ev: MemberEvent): DeviceState[] {
  const c = ev.content;
  const ts = int(ev.ts) ?? 0;
  if (!isObj(c) || !ev.sender) return [];
  const mem = own(c, "memberships");
  const arrayForm = Array.isArray(mem);
  if (!arrayForm && Object.keys(c).length === 0) return [];
  const entries: unknown[] = arrayForm ? (mem as unknown[]) : [c];
  const out: DeviceState[] = [];
  for (const e of entries) {
    if (!isObj(e)) continue;
    // absent, or exactly the string (null or any other value = not a call membership, like the live liveSessions)
    const app = own(e, "application");
    const scope = own(e, "scope");
    if (app !== undefined && app !== "m.call") continue;
    if (scope !== undefined && scope !== "m.room") continue;
    const devRaw = own(e, "device_id");
    const dev = typeof devRaw === "string" ? devRaw : "";
    if (!dev || !keyOwned(ev.key, ev.sender, dev, arrayForm)) continue;
    if (out.some((d) => d.dev === dev)) continue;
    let exp: number;
    const abs = int(own(e, "expires_ts"));
    if (abs !== null) exp = abs;
    else {
      const created = int(own(e, "created_ts")) ?? ts;
      const expires = int(own(e, "expires")) ?? DEFAULT_EXPIRES_MS;
      exp = created + expires;
    }
    exp = Math.min(exp, ts + EXPIRY_CAP_MS);
    if (exp <= ts) continue;
    out.push({ dev, exp });
  }
  return out;
}

// ---- intervals ------------------------------------------------------------------------------------------------------

export interface DeviceInterval {
  user: string;
  start: number;
  end: number;
  /** index (after dedupe + sort) of the event that opened it — the started-by tie-break */
  open: number;
  ongoing: boolean;
}

/** The room's events to process, in the given (timeline) order — never re-sorted by ts: a known type, string key and
 *  sender, ts a number in [0, 2^53] (floored) and ≤ now, a repeated non-empty id dropped (first kept). */
export function roomOrder(events: readonly MemberEvent[], now: number): MemberEvent[] {
  const seen = new Set<string>();
  const kept: MemberEvent[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (typeof ev.type !== "string" || !MEMBER_TYPES.includes(ev.type)) continue;
    if (typeof ev.key !== "string" || typeof ev.sender !== "string") continue;
    const ts = int(ev.ts);
    if (ts === null || ts < 0 || ts > now) continue;
    if (typeof ev.id === "string" && ev.id) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
    }
    kept.push({ ...ev, ts });
  }
  return kept;
}

/** Every device's presence intervals in one room (recorders included; callers drop them). §7.1 rule 6. */
export function deviceIntervals(events: readonly MemberEvent[], now: number): DeviceInterval[] {
  const order = roomOrder(events, now);
  interface Rec {
    user: string;
    dev: string;
    since: number;
    open: number;
    exp: number;
  }
  const slots = new Map<string, Rec[]>();
  const out: DeviceInterval[] = [];
  const close = (r: Rec, end: number, ongoing: boolean) => {
    if (end > r.since) out.push({ user: r.user, start: r.since, end, open: r.open, ongoing });
  };
  // Every event REPLACES its slot's state, whoever sent it — room state semantics, as the live call view reads it: a
  // `{}` (or garbage) written into someone's slot by another member ends their membership there too (their app
  // re-sends it at its next refresh). Only a membership's OPENING needs the key to be owned (devicesOf).
  order.forEach((ev, i) => {
    const slot = `${ev.type}\u0000${ev.key}`;
    const prev = slots.get(slot) ?? [];
    const devs = devicesOf(ev);
    const next: Rec[] = [];
    const continued = new Set<string>();
    for (const r of prev) {
      const same = devs.find((d) => d.dev === r.dev && ev.sender === r.user);
      if (r.exp <= ev.ts) close(r, r.exp, false); // expired before this event
      else if (same) {
        next.push({ ...r, exp: same.exp }); // a refresh: the interval goes on, its expiry is the new one
        continued.add(same.dev);
      } else close(r, ev.ts, false);
    }
    for (const d of devs) if (!continued.has(d.dev)) next.push({ user: ev.sender, dev: d.dev, since: ev.ts, open: i, exp: d.exp });
    if (next.length) slots.set(slot, next);
    else slots.delete(slot);
  });
  for (const recs of slots.values()) for (const r of recs) close(r, Math.min(r.exp, now), r.exp > now);
  out.sort((a, b) => a.start - b.start || a.open - b.open || a.end - b.end);
  return out;
}

// ---- interval sets --------------------------------------------------------------------------------------------------

export type Span = [number, number];

/** Sorted, disjoint, merged (touching spans merge) union of [start, end) spans. */
export function union(spans: readonly Span[]): Span[] {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Span[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Intersection of two unions. */
export function intersect(x: readonly Span[], y: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const a = Math.max(x[i]![0], y[j]![0]);
    const b = Math.min(x[i]![1], y[j]![1]);
    if (b > a) out.push([a, b]);
    if (x[i]![1] < y[j]![1]) i++;
    else j++;
  }
  return out;
}

/** Total length of a union within [from, to]. */
export function lengthIn(u: readonly Span[], from: number, to: number): number {
  let n = 0;
  for (const [a, b] of u) {
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (e > s) n += e - s;
  }
  return n;
}

// ---- calls ----------------------------------------------------------------------------------------------------------

interface RoomData {
  room: string;
  /** per user (recorders excluded): the union of their device intervals */
  users: Map<string, Span[]>;
  calls: Call[];
  /** one of my devices is still in this room's call at `now` */
  myOngoing: boolean;
}

function roomData(room: string, events: readonly MemberEvent[], me: string, now: number, recorder?: string | null): RoomData {
  const ivs = deviceIntervals(events, now).filter((iv) => !isRecorderUser(iv.user, recorder));
  const byUser = new Map<string, Span[]>();
  for (const iv of ivs) {
    const l = byUser.get(iv.user) ?? [];
    l.push([iv.start, iv.end]);
    byUser.set(iv.user, l);
  }
  const users = new Map<string, Span[]>();
  for (const [u, l] of byUser) users.set(u, union(l));
  // calls = maximal periods with ≥ 1 member present (touching periods merge); ivs is sorted by (start, open, end)
  const calls: Call[] = [];
  let cur: { start: number; end: number; ongoing: boolean; startedBy: string } | null = null;
  const flush = () => {
    if (!cur) return;
    const members: UserMs[] = [];
    for (const [u, un] of users) {
      const ms = lengthIn(un, cur.start, cur.end);
      if (ms > 0) members.push({ user: u, ms });
    }
    members.sort((a, b) => cmpStr(a.user, b.user));
    calls.push({ room, start: cur.start, end: cur.end, ongoing: cur.ongoing, startedBy: cur.startedBy, members, myMs: members.find((m) => m.user === me)?.ms ?? 0 });
    cur = null;
  };
  for (const iv of ivs) {
    if (cur && iv.start <= cur.end) {
      if (iv.end > cur.end) cur.end = iv.end;
      if (iv.ongoing) cur.ongoing = true;
    } else {
      flush();
      cur = { start: iv.start, end: iv.end, ongoing: iv.ongoing, startedBy: iv.user };
    }
  }
  flush();
  return { room, users, calls, myOngoing: ivs.some((iv) => iv.user === me && iv.ongoing) };
}

/** The whole history: every call, the week per friend and my last call (WIDGETS.md §10.1). */
export function computeHistory(input: HistoryInput): History {
  const me = input.me;
  const now = int(input.now) ?? 0;
  const rooms: RoomData[] = [];
  const seenRooms = new Set<string>();
  for (const r of input.rooms) {
    if (!r || typeof r.room !== "string" || seenRooms.has(r.room) || !Array.isArray(r.events)) continue;
    seenRooms.add(r.room);
    rooms.push(roomData(r.room, r.events, me, now, input.recorder));
  }
  rooms.sort((a, b) => cmpStr(a.room, b.room));
  const calls = rooms.flatMap((r) => r.calls);
  calls.sort((a, b) => a.start - b.start || cmpStr(a.room, b.room));

  // ---- the week
  const from = now - WEEK_MS;
  const to = now;
  const friends = new Map<string, Friend>();
  const friend = (u: string): Friend => {
    let f = friends.get(u);
    if (!f) friends.set(u, (f = { user: u, togetherMs: 0, calls: 0, started: 0, joined: 0 }));
    return f;
  };
  let myMs = 0;
  let myCalls = 0;
  for (const r of rooms) {
    const mine = r.users.get(me) ?? [];
    myMs += lengthIn(mine, from, to);
    // time together: my union ∩ theirs, within the window
    for (const [u, un] of r.users) {
      if (u === me) continue;
      const ov = lengthIn(intersect(mine, un), from, to);
      if (ov > 0) friend(u).togetherMs += ov;
    }
    // calls in the window (the part inside it counts) that I was in; per friend who overlapped with me in it
    for (const c of r.calls) {
      if (!(c.end > from && c.start < to)) continue;
      const a = Math.max(c.start, from);
      const b = Math.min(c.end, to);
      if (lengthIn(mine, a, b) <= 0) continue;
      myCalls++;
      for (const [u, un] of r.users) {
        if (u === me) continue;
        if (lengthIn(intersect(mine, un), a, b) <= 0) continue;
        const f = friend(u);
        f.calls++;
        if (c.startedBy === me) f.started++;
        else f.joined++;
      }
    }
  }
  const list = [...friends.values()].filter((f) => f.calls > 0);
  list.sort((a, b) => b.togetherMs - a.togetherMs || cmpStr(a.user, b.user));

  // ---- my last call: among calls I shared with someone, the one I LEFT last (my last instant in it), then my first
  // instant, then the smaller room id; its "when" is when I left, its length my time in it
  let last: LastCall | null = null;
  for (const r of rooms) {
    const mine = r.users.get(me) ?? [];
    const myOngoing = r.myOngoing;
    for (const c of r.calls) {
      if (c.myMs <= 0) continue;
      const withL: UserMs[] = [];
      for (const [u, un] of r.users) {
        if (u === me) continue;
        const ms = lengthIn(intersect(mine, un), c.start, c.end);
        if (ms > 0) withL.push({ user: u, ms });
      }
      if (!withL.length) continue;
      withL.sort((a, b) => b.ms - a.ms || cmpStr(a.user, b.user));
      const inside = intersect(mine, [[c.start, c.end]]);
      const myStart = inside[0]![0];
      const myEnd = inside[inside.length - 1]![1];
      const better =
        !last || myEnd > last.myEnd || (myEnd === last.myEnd && (myStart > last.myStart || (myStart === last.myStart && cmpStr(c.room, last.room) < 0)));
      if (better)
        last = { room: c.room, start: c.start, end: c.end, myStart, myEnd, ongoing: myOngoing && myEnd === now, startedBy: c.startedBy, myMs: c.myMs, with: withL };
    }
  }
  return { calls, week: { from, to, myMs, myCalls, friends: list }, last };
}
