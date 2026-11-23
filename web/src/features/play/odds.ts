// odds.ts — the Hold'em hand evaluator and "your odds" (GAMES-V1.1-ADDENDUM §2 F5 "your hand", §3 F6). Pure: no React, no
// app imports; it runs in a Web Worker (oddsWorker.ts) and in the unit tests. Byte-identical rules in the desktop
// (games_rules.rs); the vectors are testvectors/games/holdem-hand-ranking.json (the evaluator, now run by both apps) and
// testvectors/games/odds-v1.json (the method, exact integers). Inputs are ONLY the player's own: hole cards, the board,
// the number of live opponents (liveOpponents over the public seats). Never anyone else's cards.

// ---- cards -------------------------------------------------------------------------------------------------------
const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
/** deck index = suit × 13 + rank index (suits c d h s, ranks 2..A); -1 = not a card */
export function cardIndex(card: string): number {
  if (typeof card !== "string" || card.length !== 2) return -1;
  const r = RANKS.indexOf(card[0]!);
  const s = SUITS.indexOf(card[1]!);
  return r < 0 || s < 0 ? -1 : s * 13 + r;
}
export function cardOf(i: number): string {
  return RANKS[i % 13]! + SUITS[Math.floor(i / 13)]!;
}

// ---- the evaluator -----------------------------------------------------------------------------------------------
export const CATEGORIES = ["high-card", "pair", "two-pair", "trips", "straight", "flush", "full-house", "quads", "straight-flush"] as const;
export type Category = (typeof CATEGORIES)[number];

/** the highest straight in a rank bitmask (bit r = rank r, 2..14; the ace also counts as 1): its top rank, or 0 */
function straightHigh(mask: number): number {
  const m = mask | (mask & (1 << 14) ? 1 << 1 : 0);
  for (let h = 14; h >= 5; h--) {
    const need = 0b11111 << (h - 4);
    if ((m & need) === need) return h;
  }
  return 0;
}
/** the top `n` ranks of a mask, high first */
function topRanks(mask: number, n: number, out: number[]): void {
  for (let r = 14; r >= 2 && n > 0; r--)
    if (mask & (1 << r)) {
      out.push(r);
      n--;
    }
}

/** The key of the best five of 5–7 cards (deck indices): [category, …tie-break ranks 2..14] (a wheel's straight = 5),
 *  compared left to right (holdem-hand-ranking.json). Fewer than 5 cards: multiplicity categories only (quads, trips,
 *  two pair, pair, high card), with the same tie-break shape. */
export function handKey(cards: readonly number[]): number[] {
  const count = new Array<number>(15).fill(0);
  const suitMask = [0, 0, 0, 0];
  let all = 0;
  for (const c of cards) {
    const r = (c % 13) + 2;
    const s = Math.floor(c / 13);
    count[r]!++;
    suitMask[s]! |= 1 << r;
    all |= 1 << r;
  }
  const five = cards.length >= 5;
  if (five) {
    for (let s = 0; s < 4; s++) {
      const m = suitMask[s]!;
      if (popcount(m) >= 5) {
        const sf = straightHigh(m);
        if (sf) return [8, sf];
      }
    }
  }
  let quad = 0;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (count[r] === 4) quad = quad || r;
    else if (count[r] === 3) trips.push(r);
    else if (count[r] === 2) pairs.push(r);
  }
  if (quad) {
    const k: number[] = [7, quad];
    topRanks(all & ~(1 << quad), 1, k);
    return k;
  }
  if (five && trips.length && (trips.length > 1 || pairs.length)) {
    const t = trips[0]!;
    const p = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    return [6, t, p];
  }
  if (five) {
    for (let s = 0; s < 4; s++) {
      const m = suitMask[s]!;
      if (popcount(m) >= 5) {
        const k: number[] = [5];
        topRanks(m, 5, k);
        return k;
      }
    }
    const st = straightHigh(all);
    if (st) return [4, st];
  }
  const kick = Math.min(5, cards.length);
  if (trips.length) {
    const t = trips[0]!;
    const k: number[] = [3, t];
    topRanks(all & ~(1 << t), Math.max(0, kick - 3), k);
    return k;
  }
  if (pairs.length >= 2) {
    const [a, b] = [pairs[0]!, pairs[1]!];
    const k: number[] = [2, a, b];
    topRanks(all & ~(1 << a) & ~(1 << b), Math.max(0, kick - 4), k);
    return k;
  }
  if (pairs.length === 1) {
    const p = pairs[0]!;
    const k: number[] = [1, p];
    topRanks(all & ~(1 << p), Math.max(0, kick - 2), k);
    return k;
  }
  const k: number[] = [0];
  topRanks(all, kick, k);
  return k;
}
function popcount(m: number): number {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
}
/** A key as one comparable integer (category and up to five ranks, 4 bits each). */
export function keyScore(k: readonly number[]): number {
  let v = k[0]!;
  for (let i = 1; i <= 5; i++) v = v * 16 + (k[i] ?? 0);
  return v;
}
export function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
/** The made hand's category of these cards (2, 5, 6 or 7: odds-v1 `made_hand`). */
export function madeHand(cards: readonly string[]): Category | null {
  const ix = cards.map(cardIndex);
  if (ix.some((i) => i < 0) || new Set(ix).size !== ix.length || ix.length < 2 || ix.length > 7) return null;
  return CATEGORIES[handKey(ix)[0]!]!;
}

// ---- the generator (odds-v1: FNV-1a 32 + mulberry32 + rejection below) ---------------------------------------------
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
/** An unbiased value in [0, r): rejection above the largest multiple of r below 2^32. */
export function below(next: () => number, r: number): number {
  const lim = 4294967296 - (4294967296 % r);
  for (;;) {
    const x = next();
    if (x < lim) return x % r;
  }
}

// ---- odds ---------------------------------------------------------------------------------------------------------
export const ODDS_EXACT_MAX = 50_000;
export const ODDS_SAMPLES = 10_000;

export interface OddsIn {
  hole: readonly string[];
  board: readonly string[];
  /** live opponents (liveOpponents) */
  n: number;
}
export interface Outs {
  total: number;
  by: Partial<Record<Category, number>>;
}
export interface Odds {
  method: "exact" | "mc";
  samples: number;
  win: number;
  tie: number;
  winLabel: string;
  tieLabel: string;
  /** the made hand now (hole + board) */
  made: Category;
  /** flop and turn only, else null */
  outs: Outs | null;
  /** the canonical input (the freshness tag) */
  input: string;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let v = 1;
  for (let i = 0; i < k; i++) v = (v * (n - i)) / (i + 1);
  return Math.round(v);
}
/** E = C(|D|, k) × Π C(|D| − k − 2i, 2), saturating just above `max`. */
export function enumCount(d: number, k: number, n: number, max = ODDS_EXACT_MAX): number {
  let e = choose(d, k);
  for (let i = 0; i < n && e <= max; i++) e *= choose(d - k - 2 * i, 2);
  return e > max ? max + 1 : e;
}

/** The canonical input (deck order) or null when it isn't a valid question (no odds, no error shown). */
export function canonical(i: OddsIn): { hole: number[]; board: number[]; key: string } | null {
  if (!Number.isInteger(i.n) || i.n < 1 || i.n > 7) return null;
  if (i.hole.length !== 2 || ![0, 3, 4, 5].includes(i.board.length)) return null;
  const hole = i.hole.map(cardIndex);
  const board = i.board.map(cardIndex);
  const all = [...hole, ...board];
  if (all.some((x) => x < 0) || new Set(all).size !== all.length) return null;
  hole.sort((a, b) => a - b);
  board.sort((a, b) => a - b);
  return { hole, board, key: `odds-v1|${hole.map(cardOf).join(",")}|${board.map(cardOf).join(",")}|${i.n}` };
}

export function label(num: number, den: number): string {
  if (num <= 0) return "0%";
  if (num >= den) return "100%";
  if (num * 200 < den) return "<1%";
  if (num * 200 >= den * 199) return ">99%";
  return `${Math.floor((num * 200 + den) / (2 * den))}%`;
}

function outsOf(hole: number[], board: number[], deck: number[]): Outs | null {
  if (board.length !== 3 && board.length !== 4) return null;
  const now = handKey([...hole, ...board])[0]!;
  const n = new Array<number>(CATEGORIES.length).fill(0);
  let total = 0;
  for (const c of deck) {
    const cat = handKey([...hole, ...board, c])[0]!;
    if (cat > now && cat > handKey([...board, c])[0]!) {
      n[cat]!++;
      total++;
    }
  }
  // strongest category first (the vectors' order, and the ⓘ list's)
  const by: Partial<Record<Category, number>> = {};
  for (let cat = CATEGORIES.length - 1; cat >= 0; cat--) if (n[cat]) by[CATEGORIES[cat]!] = n[cat];
  return { total, by };
}

/** Your odds (odds-v1). null = not a valid question. */
export function odds(i: OddsIn): Odds | null {
  const c = canonical(i);
  if (!c) return null;
  const { hole, board, key } = c;
  const used = new Set([...hole, ...board]);
  const deck: number[] = [];
  for (let x = 0; x < 52; x++) if (!used.has(x)) deck.push(x);
  const k = 5 - board.length;
  const n = i.n;
  const e = enumCount(deck.length, k, n);
  let win = 0;
  let tie = 0;
  let samples = 0;
  const seven = new Array<number>(7);
  const opp = new Array<number>(7);
  const judge = (run: readonly number[], opps: readonly number[]) => {
    for (let j = 0; j < 5; j++) seven[j] = j < board.length ? board[j]! : run[j - board.length]!;
    seven[5] = hole[0]!;
    seven[6] = hole[1]!;
    const me = keyScore(handKey(seven));
    let best = -1;
    for (let t = 0; t < n; t++) {
      for (let j = 0; j < 5; j++) opp[j] = seven[j]!;
      opp[5] = opps[2 * t]!;
      opp[6] = opps[2 * t + 1]!;
      const s = keyScore(handKey(opp));
      if (s > best) best = s;
    }
    samples++;
    if (me > best) win++;
    else if (me === best) tie++;
  };
  let method: "exact" | "mc";
  if (e <= ODDS_EXACT_MAX) {
    method = "exact";
    const run: number[] = [];
    const opps: number[] = [];
    const taken = new Set<number>();
    const oppRec = (t: number) => {
      if (t === n) return judge(run, opps);
      for (let a = 0; a < deck.length; a++) {
        const ca = deck[a]!;
        if (taken.has(ca)) continue;
        for (let b = a + 1; b < deck.length; b++) {
          const cb = deck[b]!;
          if (taken.has(cb)) continue;
          taken.add(ca).add(cb);
          opps.push(ca, cb);
          oppRec(t + 1);
          opps.length -= 2;
          taken.delete(ca);
          taken.delete(cb);
        }
      }
    };
    const runRec = (start: number) => {
      if (run.length === k) return oppRec(0);
      for (let a = start; a < deck.length; a++) {
        run.push(deck[a]!);
        taken.add(deck[a]!);
        runRec(a + 1);
        taken.delete(deck[a]!);
        run.length--;
      }
    };
    runRec(0);
  } else {
    method = "mc";
    const next = mulberry32(fnv1a32(key));
    const need = k + 2 * n;
    const d = new Array<number>(deck.length);
    for (let s = 0; s < ODDS_SAMPLES; s++) {
      for (let j = 0; j < deck.length; j++) d[j] = deck[j]!;
      for (let j = 0; j < need; j++) {
        const r = j + below(next, deck.length - j);
        const tmp = d[j]!;
        d[j] = d[r]!;
        d[r] = tmp;
      }
      judge(d.slice(0, k), d.slice(k, need));
    }
  }
  return {
    method,
    samples,
    win,
    tie,
    winLabel: label(win, samples),
    tieLabel: label(tie, samples),
    made: CATEGORIES[handKey([...hole, ...board])[0]!]!,
    outs: outsOf(hole, board, deck),
    input: key,
  };
}

/** n for the odds (table-ui-v1 `live_opponents`): seats still in the hand (active, allin, leaving: a leaving player
 *  plays out the hand), never mine (`you` = my seat, null for a spectator). */
export function liveOpponents(seats: readonly { seat: number; state: string }[], you: number | null): number {
  return seats.filter((s) => s.seat !== you && (s.state === "active" || s.state === "allin" || s.state === "leaving")).length;
}

export const ODDS_DEFAULT_ON = true;

export interface OddsVisibleIn {
  /** Show my odds (only a literal true counts) */
  setting: unknown;
  youState: string | null;
  street: string | null;
  /** the hand's result is set (the hand is done) */
  result: unknown;
  /** cardsFace, or "peeking" while the hold-to-peek is held */
  face: string;
  opponents: number;
}
/** table-ui-v1 `odds_visible`: the odds line shows only while I hold live cards I can see, before the showdown. */
export function oddsVisible(i: OddsVisibleIn): boolean {
  if (i.setting !== true) return false;
  if (i.youState !== "active" && i.youState !== "allin") return false;
  if (!i.street || i.street === "showdown" || i.result) return false;
  if (i.face !== "up" && i.face !== "peeking") return false;
  return i.opponents > 0;
}
