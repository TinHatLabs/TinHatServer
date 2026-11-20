// rankCache.ts — the prestige rank cache (GAMES-V1-SPEC rev 2 §3.3 / §3.4), pure: no React, no matrix client, no fetch.
// Ranks are per SPACE: everything is keyed by a scope = (owner server, space id), the owner being the server of the
// space's create-event sender (clientRules.gameSpace / the store), never a via.
// The clock, the timers and the transport are handed in, so the unit test drives it with a fake clock and a fake server
// (the contract's answers, good and bad). store.ts wires it to the app. The desktop's prestige_cache.rs is the same
// machine (same constants, same wire parsing: testvectors/prestige-wire.json, byte copy in both repos).
//
//   get(scope, mxid)       the rank to draw now: 0 = no token (no scope, unknown, the owner has no games, older than 1 h)
//                          — asking also queues a read when the answer is missing or older than 10 min
//   push(owner, frame)     a {"t":"rank","space":…,"u":…,"rank":…} frame from that owner's play WebSocket (it can only
//                          ever change that owner's scopes)
//   subscribe(key, cb)     per scope|mxid change notifications (key = keyOf(scope, mxid))
//
// Reads: GET <base>/ranks?space=!S&u=…&u=… (≤ 100 ids), `Authorization: Play <session>`, one read per space in flight
// and at most one every 2 s (a 401's retry included: the session is renewed for the next read, once; a second 401 in a
// row waits a minute). An owner whose well-known doesn't say features.play === true (or that answers 503) draws no
// tokens and is asked again after 10 min, its names kept queued. A failed read keeps what was known (≤ 1 h old) and is
// retried after a minute. A push newer than a read's start wins over that read's answer. A drawn token is re-checked
// when it turns 10 min old (a subscribed label re-reads → a refresh) and disappears at 1 h. Names nobody shows any more
// leave the queue; ranks older than 1 h are dropped (bounded memory). forgetPerson(space, mxid) = a member left.
import { validRank } from "./clientRules";

export const BATCH_MAX = 100;
export const MIN_GAP_MS = 2_000;
/** the first read of a burst waits this long so one render's names go out together */
export const GATHER_MS = 60;
export const FRESH_MS = 10 * 60_000;
export const MAX_AGE_MS = 60 * 60_000;
export const SERVER_RECHECK_MS = 10 * 60_000;
export const RETRY_MS = 60_000;

export interface RankAnswer {
  status: number;
  body: unknown;
}

export interface RankTransport {
  /** `<api>/play/v1` when the server's well-known says features.play === true; null when it has no games / can't be read */
  playBase(server: string): Promise<string | null>;
  /** a play session on that server (renew = the last one was refused) */
  session(server: string, base: string, renew: boolean): Promise<string>;
  /** GET <base>/ranks?space=… for these ids */
  ranks(base: string, session: string, space: string, ids: readonly string[]): Promise<RankAnswer>;
}

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
}

const MXID = /^@[^:\s]+:[^\s]+$/;

/** A user id the cache will ask about (and accept from a server). */
export function validMxid(u: unknown): u is string {
  return typeof u === "string" && u.length <= 255 && MXID.test(u);
}

/** The ranks answer (§3.4): {"v":1,"space":"!S","ranks":{mxid: rank>0}}. For each asked id: its rank, 0 when absent /
 *  not a rank. Ids that weren't asked are ignored. Anything that isn't a version-1 answer for the asked space → null. */
export function parseRanksAnswer(body: unknown, space: string, asked: readonly string[]): Map<string, number> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1 || b.space !== space) return null;
  const r = b.ranks;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const ranks = r as Record<string, unknown>;
  const out = new Map<string, number>();
  for (const id of asked) out.set(id, Object.prototype.hasOwnProperty.call(ranks, id) ? validRank(ranks[id]) : 0);
  return out;
}

/** A space id as the cache takes it: a room id ("!…", ≤ 255, no whitespace). */
export function validSpace(s: unknown): s is string {
  return typeof s === "string" && s.length >= 2 && s.length <= 255 && s[0] === "!" && !/\s/.test(s);
}

/** A play-socket frame (§6.3) {"t":"rank","space":"!S","u":mxid,"rank":n ≥ 0}; anything else → null (ignored). */
export function parseRankPush(frame: unknown): { space: string; u: string; rank: number } | null {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const f = frame as Record<string, unknown>;
  if (f.t !== "rank" || !validSpace(f.space) || !validMxid(f.u)) return null;
  if (typeof f.rank !== "number" || !Number.isSafeInteger(f.rank) || f.rank < 0) return null;
  return { space: f.space, u: f.u, rank: f.rank };
}

/** Whose rank: the space and the server that keeps its chips (the server of the space's create-event sender). */
export interface Scope {
  owner: string;
  space: string;
}

export const scopeKey = (sc: Scope): string => `${sc.owner}|${sc.space}`;
export const keyOf = (sc: Scope, mxid: string): string => `${sc.owner}|${sc.space}|${mxid}`;

interface Entry {
  rank: number;
  at: number;
}

interface OwnerState {
  /** undefined = not asked yet; null = no games there */
  base?: string | null;
  baseAt: number;
  /** the well-known read on the wire */
  asking: Promise<string | null> | null;
  /** the last read was refused (401): the next one renews the session */
  renew: boolean;
}

interface ScopeState {
  scope: Scope;
  ranks: Map<string, Entry>;
  queue: Set<string>;
  /** ids in the request on the wire */
  inflight: Set<string>;
  timer: boolean;
  /** a flush is running (discovery, session, read): one read per space at a time */
  busy: boolean;
  lastSent: number;
  /** failed reads wait until then */
  holdUntil: number;
  /** 401s in a row */
  refused: number;
}

export class RankCache {
  private owners = new Map<string, OwnerState>();
  private scopes = new Map<string, ScopeState>();
  private listeners = new Map<string, Set<() => void>>();
  private any = new Set<() => void>();
  private transport: RankTransport;
  private clock: Clock;

  // plain fields (no parameter properties: node's type stripping runs the unit test on this file as is)
  constructor(transport: RankTransport, clock: Clock) {
    this.transport = transport;
    this.clock = clock;
  }

  private owner(o: string): OwnerState {
    let s = this.owners.get(o);
    if (!s) this.owners.set(o, (s = { baseAt: 0, asking: null, renew: false }));
    return s;
  }

  private state(sc: Scope): ScopeState {
    const k = scopeKey(sc);
    let s = this.scopes.get(k);
    if (!s) {
      s = { scope: { owner: sc.owner, space: sc.space }, ranks: new Map(), queue: new Set(), inflight: new Set(), timer: false, busy: false, lastSent: 0, holdUntil: 0, refused: 0 };
      this.scopes.set(k, s);
    }
    return s;
  }

  /** The rank to draw now (0 = no token). Queues a read when missing or older than FRESH_MS. */
  get(sc: Scope | null, mxid: string): number {
    if (!sc || !sc.owner || !validSpace(sc.space) || !validMxid(mxid)) return 0;
    const s = this.state(sc);
    const now = this.clock.now();
    const e = s.ranks.get(mxid);
    if (!e || now - e.at >= FRESH_MS) this.want(s, mxid, now);
    if (this.owner(sc.owner).base === null) return 0;
    if (!e || now - e.at >= MAX_AGE_MS) return 0;
    return e.rank;
  }

  /** A rank frame from `owner`'s play socket: it can only change that owner's scopes. */
  push(owner: string, frame: unknown): boolean {
    const p = parseRankPush(frame);
    if (!p || !owner) return false;
    const s = this.state({ owner, space: p.space });
    this.set(s, p.u, p.rank, this.clock.now());
    return true;
  }

  /** A member left `space` (any owner): their token there goes at once (§1.1: no rank for a departed member). Recorded
   *  as rank 0 NOW, so an answer of a read that began before the departure can't bring it back. */
  forgetPerson(space: string, mxid: string): void {
    const now = this.clock.now();
    for (const s of this.scopes.values()) {
      if (s.scope.space !== space) continue;
      s.queue.delete(mxid);
      this.set(s, mxid, 0, now);
    }
  }

  /** Drop everything (sign-out / account switch). */
  clear(): void {
    const keys = [...this.scopes.values()].flatMap((s) => [...s.ranks.keys()].map((m) => keyOf(s.scope, m)));
    this.scopes.clear();
    this.owners.clear();
    for (const k of keys) this.emit(k);
    for (const cb of this.any) cb();
  }

  subscribe(key: string, cb: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(key);
        // nobody shows this name any more: it leaves the queue (no retries for unmounted labels)
        for (const s of this.scopes.values()) if (key.startsWith(scopeKey(s.scope) + "|")) s.queue.delete(key.slice(scopeKey(s.scope).length + 1));
      }
    };
  }

  /** every change (tests, debugging) */
  subscribeAll(cb: () => void): () => void {
    this.any.add(cb);
    return () => this.any.delete(cb);
  }

  private emit(key: string): void {
    const set = this.listeners.get(key);
    if (set) for (const cb of [...set]) cb();
  }

  private emitOwner(owner: string): void {
    for (const s of this.scopes.values()) if (s.scope.owner === owner) for (const m of s.ranks.keys()) this.emit(keyOf(s.scope, m));
    for (const cb of this.any) cb();
  }

  private set(s: ScopeState, mxid: string, rank: number, at: number): void {
    const before = s.ranks.get(mxid);
    s.ranks.set(mxid, { rank, at });
    const key = keyOf(s.scope, mxid);
    // the drawn value can change on a new rank, and on a refresh of an entry that had aged out (> 1 h → shown again)
    if (!before || before.rank !== rank || at - before.at >= MAX_AGE_MS) {
      this.emit(key);
      for (const cb of this.any) cb();
    }
    // a mounted label re-reads when this answer turns 10 min old (→ a refresh) and when it turns 1 h old (→ gone)
    for (const after of [FRESH_MS, MAX_AGE_MS]) {
      this.clock.setTimeout(() => {
        if (s.ranks.get(mxid)?.at === at) {
          if (after === MAX_AGE_MS) s.ranks.delete(mxid); // not drawable any more: dropped (bounded memory)
          this.emit(key);
        }
      }, after);
    }
  }

  private want(s: ScopeState, mxid: string, now: number): void {
    if (s.inflight.has(mxid)) return;
    s.queue.add(mxid);
    this.schedule(s, now);
  }

  private schedule(s: ScopeState, now: number): void {
    if (s.timer || s.busy || s.queue.size === 0) return;
    const o = this.owner(s.scope.owner);
    if (o.base === null && now - o.baseAt < SERVER_RECHECK_MS) {
      // no games there: nothing is asked until the recheck
      s.timer = true;
      this.clock.setTimeout(() => {
        s.timer = false;
        this.schedule(s, this.clock.now());
      }, SERVER_RECHECK_MS - (now - o.baseAt));
      return;
    }
    const at = Math.max(now + GATHER_MS, s.lastSent + MIN_GAP_MS, s.holdUntil);
    s.timer = true;
    this.clock.setTimeout(() => {
      s.timer = false;
      void this.flush(s);
    }, at - now);
  }

  private async base(owner: string): Promise<string | null> {
    const o = this.owner(owner);
    const now = this.clock.now();
    if (o.base !== undefined && now - o.baseAt < SERVER_RECHECK_MS) return o.base;
    if (!o.asking) {
      o.asking = (async () => {
        let b: string | null = null;
        try {
          b = await this.transport.playBase(owner);
        } catch {
          b = null;
        }
        const had = o.base;
        o.base = b;
        o.baseAt = this.clock.now();
        o.asking = null;
        // games appeared / went away there: every drawn token of that owner may change
        if (had !== b && (had === null || b === null)) this.emitOwner(owner);
        return b;
      })();
    }
    return o.asking;
  }

  private async flush(s: ScopeState): Promise<void> {
    if (s.queue.size === 0 || s.busy) return;
    s.busy = true;
    try {
      await this.flushOnce(s);
    } finally {
      s.busy = false;
      this.schedule(s, this.clock.now());
    }
  }

  private async flushOnce(s: ScopeState): Promise<void> {
    const owner = s.scope.owner;
    const base = await this.base(owner);
    if (!base) return; // no games there: the names stay queued for the recheck
    const ids = [...s.queue].slice(0, BATCH_MAX);
    for (const id of ids) {
      s.queue.delete(id);
      s.inflight.add(id);
    }
    s.lastSent = this.clock.now();
    let sentAt = s.lastSent;
    const o = this.owner(owner);
    let answer: Map<string, number> | null = null;
    let status = 0;
    try {
      const renew = o.renew;
      o.renew = false;
      const session = await this.transport.session(owner, base, renew);
      // the 2 s gap counts from the read itself, not from before a (slow) session exchange
      sentAt = s.lastSent = this.clock.now();
      const res = await this.transport.ranks(base, session, s.scope.space, ids);
      status = res.status;
      if (status === 200) answer = parseRanksAnswer(res.body, s.scope.space, ids);
    } catch {
      answer = null;
    }
    const now = this.clock.now();
    for (const id of ids) s.inflight.delete(id);
    if (answer) {
      s.refused = 0;
      // a push (or a departure) that arrived once this read had begun — the same millisecond included — is newer than
      // its answer: it wins
      for (const [id, rank] of answer) if (!((s.ranks.get(id)?.at ?? -1) >= sentAt)) this.set(s, id, rank, now);
      return;
    }
    // no answer: the names go back in the queue (only the ones still shown)
    for (const id of ids) if (this.listeners.has(keyOf(s.scope, id))) s.queue.add(id);
    if (status === 503) {
      // games off (or draining) there: as "no games" until the recheck
      o.base = null;
      o.baseAt = now;
      this.emitOwner(owner);
    } else if (status === 401 && s.refused === 0) {
      // the session was refused: the next read (after the usual 2 s) renews it, once
      s.refused = 1;
      o.renew = true;
    } else {
      s.refused = status === 401 ? s.refused + 1 : 0;
      s.holdUntil = now + RETRY_MS;
    }
  }
}
