// wire.ts — the play API's messages as the app reads them: the FROZEN contract v1 (contract.ts, testvectors/games/views/
// schema.json) + the wire hygiene of §6.3. SHARED LOGIC: the desktop's play_wire.rs reads the same contract against the
// same fixtures and malformed.json. Pure: no React, no app imports (the unit tests run it in plain Node).
import { check, type Contract } from "./contract";
import wordsJson from "../../../testvectors/games/words.json" with { type: "json" };

export type Game = "holdem" | "rig";
export const GAMES: readonly Game[] = ["holdem", "rig"];

// ---- shared shapes ----------------------------------------------------------------------------------------------
const MXID = /^@[^:\s]+:[^\s]+$/;
export const isMxid = (v: unknown): v is string => typeof v === "string" && v.length <= 255 && MXID.test(v);
const ROOM_ID = /^![^:\s]+:[^\s]+$/;
export const isRoomId = (v: unknown): v is string => typeof v === "string" && v.length <= 255 && ROOM_ID.test(v);
const TABLE = /^t[HR][A-Za-z0-9]{14}$/;
export const isTableId = (v: unknown): v is string => typeof v === "string" && TABLE.test(v);
/** A person in a history answer: a Matrix id, or `~1`, `~2`… for someone who deleted their chips. */
export const isPlaceholder = (u: string): boolean => /^~[1-9][0-9]?$/.test(u);
export const CARD = /^[2-9TJQKA][cdhs]$/;

export interface Closed {
  reason: "host" | "idle" | "no-call" | "restart" | "off" | "end" | "space-changed";
  at: number;
}
interface ViewBase {
  table: string;
  room: string;
  space: string;
  owner: string;
  vseq: number;
  now: number;
  host: string;
  closed: Closed | null;
  spectators: number;
}

// ---- Hold'em ----------------------------------------------------------------------------------------------------
export type SeatState = "waiting" | "active" | "folded" | "allin" | "away" | "out" | "leaving";
export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";
export interface HoldemSeat {
  seat: number;
  u: string;
  stack: number;
  bet: number;
  state: SeatState;
  cards: 0 | 2;
  connected: boolean;
  shown?: string[];
  /** 0.3.21 (addendum §8.1, additive): a pending / current sit-out; absent or null on older servers */
  away?: AwayInfo | null;
}
/** GAMES-V1.1-ADDENDUM §8.1: why and since when a player sits out, and when they'll stand up (chips kept). */
export interface AwayInfo {
  reason: "timeout" | "gone" | "asked";
  since: number;
  stand_at: number;
  hands_left: number;
}
export interface Pot {
  amount: number;
  eligible: number[];
}
export interface HoldemHand {
  n: number;
  button: number;
  sb: number;
  bb: number;
  street: Street;
  board: string[];
  pots: Pot[];
  /** everything in the middle: pots + this street's bets */
  total: number;
  to_act: { seat: number; turn: number; deadline: number } | null;
  last: { seat: number; a: string; to?: number } | null;
}
export type HandCategory = "high-card" | "pair" | "two-pair" | "trips" | "straight" | "flush" | "full-house" | "quads" | "straight-flush";
export interface HoldemResult {
  n: number;
  board: string[];
  pots: { amount: number; eligible: number[]; winners: number[]; paid: Record<string, number> }[];
  returned: Record<string, number>;
  shown: Record<string, string[]>;
  best: Record<string, { category: HandCategory; five: string[] }>;
  net: Record<string, number>;
  voided: boolean;
  next_at: number | null;
}
export interface HoldemLegal {
  fold: boolean;
  check: boolean;
  /** chips to call; 0 = nothing to call */
  call: number;
  /** raise TO (totals for this street); null = no raise */
  raise: { min: number; max: number } | null;
}
export interface HoldemYou {
  seat: number;
  state: SeatState;
  cards: string[];
  legal: HoldemLegal | null;
  screens: string[];
  at_cap: boolean;
  cap: number;
  holdings: number;
  timeouts: number;
  /** The host, in the lobby: Deal is possible (≥ 2 seated with chips). Absent from older servers. */
  can_deal?: boolean;
  /** 0.3.21 (addendum §8.1): my own sit-out, as on my seat */
  away?: AwayInfo | null;
}
export interface HoldemView extends ViewBase {
  game: "holdem";
  status: "lobby" | "hand" | "pause" | "closed";
  opts: { sb: number; bb: number; seats: number; turn_s: number };
  seats: HoldemSeat[];
  hand: HoldemHand | null;
  result: HoldemResult | null;
  you?: HoldemYou;
}

// ---- The Rig ----------------------------------------------------------------------------------------------------
export const SYMBOLS = ["hat", "saucer", "dish", "eye", "moon", "lizard"] as const;
export type RigSymbol = (typeof SYMBOLS)[number];
export type RigRole = "spinner" | "mechanic" | "sharp" | "railbird";
export type RigPhase = "setup" | "turn" | "spin" | "land" | "nudge" | "payout" | "reveal";
export type BoardState = "open" | "dead" | "busted" | "wrong";
export interface RigPlayer {
  u: string;
  order: number;
  role: RigRole | null;
  connected: boolean;
  left: boolean;
  spun: boolean;
  skipped: boolean;
  /** 0.3.21 (addendum §8.1): sitting out from the next round's setup */
  away?: AwayInfo | null;
}
export interface RigBoardCard {
  card: string;
  state: BoardState;
  by?: string;
  spin?: number;
}
export interface RigSpin {
  spin: number;
  bet: number;
  reels: RigSymbol[];
  payout: number;
  result: "win" | "push" | "loss";
  stamps: string[];
}
export interface RigWhisper {
  spin: number;
  template?: string;
  person?: string;
  text?: string;
}
export interface RigReveal {
  seed: string;
  slots: { slot: number; card: string; owner: string; from_spin: number }[];
  mutes: { spin: number; owner: string }[];
  nudges: { spin: number; by: string; reel: number; step: number }[];
  calls: { spin: number; card: string; right: boolean; owner: string | null }[];
  peeks: { who: string; target: string; card: string; right: boolean; delta: number }[];
  market: { who: string; side: "up" | "not-up"; stake: number; back: number }[];
  whispers: (RigWhisper & { who: string })[];
  spins: unknown[];
  up: boolean;
  net: Record<string, number>;
}
export interface RigRound {
  r: number;
  spinner: string;
  preset: "lite" | "full";
  phase: RigPhase;
  spin: number;
  spins: number;
  deadline: number | null;
  seed_commit: string;
  bankroll: { start: number; now: number };
  net: number;
  dial: number;
  bet: number | null;
  calls_left: number;
  call_used_this_spin: boolean;
  audit_used: boolean;
  walk_from: number;
  peek_lock_after: number;
  peeks_locked: boolean;
  features: { mutes: boolean; nudge: boolean; whisper: boolean; patch: boolean };
  board: RigBoardCard[];
  dead: string[];
  mechanics: number;
  refilled: { spin: number }[];
  history: RigSpin[];
  reels: RigSymbol[] | null;
  nudge: { open: boolean; deadline: number | null; reel?: number; step?: number } | null;
  waiting_on: unknown;
  paused: { budget_ms: number } | null;
  audit?: { spin: number; honest_reels: RigSymbol[]; honest_payout: number; touched: number };
  reveal?: RigReveal;
}
export interface RigEnd {
  rounds: number;
  leaderboard: { u: string; net: number }[];
  pit_boss: string | null;
}
export interface RigYou {
  role: RigRole | null;
  /** 0.3.21 (addendum §8.1) */
  away?: AwayInfo | null;
  screens: string[];
  at_cap: boolean;
  holdings: number;
  timeouts?: number;
  whispers?: RigWhisper[];
  deal?: string[];
  kept?: boolean;
  card?: { card: string; bite: number } | null;
  busted?: boolean;
  patch?: { card: string; ok: boolean } | null;
  mutes_left?: number;
  armed?: boolean;
  rake?: number;
  call_shares?: number;
  nudge_left?: number;
  whisper_used?: boolean;
  peek?: { placed: boolean; mechanic?: string; card?: string; locks_after: number };
  market?: { side: "up" | "not-up"; stake: number } | null;
  market_done?: boolean;
}
export interface RigView extends ViewBase {
  game: "rig";
  status: "lobby" | "round" | "end" | "closed";
  opts: { preset: "lite" | "full"; bankroll: number; patch: boolean };
  players: RigPlayer[];
  round: RigRound | null;
  end: RigEnd | null;
  you?: RigYou;
}

export type View = HoldemView | RigView;

// ---- table lists, wallets, sessions -------------------------------------------------------------------------------
export interface TableItem {
  table: string;
  game: Game;
  status: "lobby" | "hand" | "pause" | "round" | "end" | "closed";
  host: string;
  seated: number;
  seats: number;
  players: string[];
  hand: number | null;
  round: number | null;
  space: string;
  owner: string;
}
export interface Wallet {
  space: string;
  balance: number;
  holdings: number;
  rank: number;
  cap: number;
  at_table: { table: string; game: Game; room: string } | null;
  earned_today: number;
  day_max: number;
  accrual_s: number;
  chip_s: number;
  day: string;
  topup: { available: boolean; next_day: string };
  /** 0.3.21 (addendum §6.4): whether Tune In is offered to me now (read tolerantly: side.ts parseSide) */
  side?: unknown;
  /** 0.3.21 (addendum §5.5): admin changes to my wallet not yet seen (read tolerantly: adminRules parseNotices) */
  notices?: unknown;
}
export interface SessionAnswer {
  v: 1;
  session: string;
  user: string;
  expires: number;
  wallets: string[];
  rig_hidden: boolean;
}
export interface Summary {
  table: string;
  game: Game;
  room: string;
  space: string;
  owner: string;
  host: string;
  status: "open" | "closed";
  hands: number;
  rounds: number;
  biggest_pot: number;
  net: Record<string, number>;
  leaderboard: { u: string; net: number }[];
  pit_boss: string | null;
}

// ---- server → client frames -----------------------------------------------------------------------------------------
export type CardKind = "invite" | "result" | "summary";
export type ServerFrame =
  | { t: "hello"; user: string; now: number; rig_hidden: boolean; wallets: string[] }
  | { t: "room"; room: string; space: string; owner: string; tables: TableItem[] }
  | { t: "view"; table: string; vseq: number; view: View }
  | { t: "live"; table: string; vseq: number; dial: number }
  | { t: "ack"; op: string; ok: boolean; code: string; dup: boolean }
  | { t: "wallet"; space: string; balance: number; holdings: number; rank: number; cap: number; earned_today?: number }
  | { t: "rank"; space: string; u: string; rank: number }
  | { t: "react"; table: string; u: string; seat: number | null; r: string; to?: number | "pot"; at: number }
  | { t: "post"; kind: CardKind; table: string; round?: number }
  | { t: "pong" }
  | { t: "bye"; code: string }
  | { t: "error"; code: string; table?: string; room?: string; space?: string; server?: string };

/** The wire hygiene of the Pad contract (§6.3): ≤ 16 KiB, depth ≤ 32, no lone surrogates, integers ≤ 2^53−1. */
export const MAX_FRAME = 16 * 1024;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function depthOk(v: unknown, d: number): boolean {
  if (d > 32) return false;
  if (Array.isArray(v)) return v.every((x) => depthOk(x, d + 1));
  // decoded keys and strings too: an escaped "\ud800" passes the raw-text check
  if (v && typeof v === "object") return Object.entries(v).every(([k, x]) => !LONE.test(k) && depthOk(x, d + 1));
  if (typeof v === "string") return !LONE.test(v);
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
  return true;
}

/** One text frame from the server, checked against the contract; null = drop it (malformed, or a frame type this app
 *  doesn't know: ignored, as the contract asks). */
export function parseFrame(c: Contract, text: string): ServerFrame | null {
  if (typeof text !== "string" || text.length > MAX_FRAME || new TextEncoder().encode(text).length > MAX_FRAME || LONE.test(text)) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!depthOk(v, 1)) return null;
  const f = check<ServerFrame>(c, "serverFrame", v);
  if (!f) return null;
  if (f.t === "view" && f.view.table !== f.table) return null;
  return f;
}

/** A view (e.g. from GET /tables/{id}), checked; null = refused. */
export function parseView(c: Contract, v: unknown): View | null {
  return check<View>(c, "view", v);
}
export function parseTables(c: Contract, v: unknown): { space: string; owner: string; tables: TableItem[] } | null {
  return check(c, "tables", v);
}
export function parseMe(c: Contract, v: unknown): Wallet | null {
  return check<Wallet>(c, "me", v);
}
export function parseSession(c: Contract, v: unknown): SessionAnswer | null {
  return check<SessionAnswer>(c, "sessionAnswer", v);
}
export function parseSummary(c: Contract, v: unknown): Summary | null {
  return check<Summary>(c, "summary", v);
}
export function parseSpace(c: Contract, v: unknown): { space: string; server: string } | null {
  return check(c, "spaceAnswer", v);
}
/** An HTTP refusal body: `{code, …}` (wrong-server names space + server). */
export function parseHttpError(c: Contract, v: unknown): { code: string; space?: string; server?: string } | null {
  return check(c, "httpError", v);
}

/** Keep the newest: a view replaces the one shown only with a higher vseq (another table id = a new table). */
export function newerView(cur: View | undefined, next: View): boolean {
  return !cur || cur.table !== next.table || next.vseq > cur.vseq;
}

// ---- client → server moves ----------------------------------------------------------------------------------------
/** op ids: 16–32 of [A-Za-z0-9_-] (§2.5). */
export const OP = /^[A-Za-z0-9_-]{16,32}$/;
const OP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
/** A fresh op id (22 chars, crypto random). */
export function newOp(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rand(22);
  let s = "";
  for (let i = 0; i < 22; i++) s += OP_CHARS[b[i]! & 63];
  return s;
}

/** Moves that name no turn (table-level moves carry no `at`). */
export const TABLE_MOVES: ReadonlySet<string> = new Set(["sit", "leave", "deal", "away", "kick", "close", "join", "start", "react"]); // react: addendum §4.2 (lab7 17:3x)

/** The `at` a move names: the turn shown when it was pressed (a stale one is refused by the server, never re-aimed). */
export function atFor(view: View, act: string): Record<string, number | string> | undefined {
  if (TABLE_MOVES.has(act)) return undefined;
  if (view.game === "holdem") {
    const h = view.hand;
    return h?.to_act ? { hand: h.n, turn: h.to_act.turn } : undefined;
  }
  const r = view.round;
  return r ? { round: r.r, spin: r.spin, phase: r.phase } : undefined;
}

/** The words for a refusal code (an ack, an HTTP answer, an `error` frame, or the app's own discovery results): the
 *  shared testvectors/games/words.json `codes` (byte-identical in the desktop). */
/** The v1.1 codes (contract v1.1b) until the shared words.json has them (games-desktop2 appends; proposed lines). */
const CODES_V11: Record<string, string> = {
  cooldown: "Easy there: one more in a moment.",
  "op-reused": "That was already sent differently. Try again.",
  "bad-reason": "That note can't be used. Keep it short, with no links or user ids.",
  "bad-value": "That value is out of range.",
  "at-table": "They're at a table right now. Try after they leave.",
  "not-admin": "Only this space's admins can do that.",
  "not-broke": "Tune In is for when you're down to 4 chips or fewer.",
  "day-max": "That's all for today. More tomorrow.",
  "side-off": "Tune In is off in this space.",
  "no-run": "That signal is gone. Start a new one.",
};
export const CODE_WORDS: Readonly<Record<string, string>> = { ...CODES_V11, ...wordsJson.codes };
export function codeWords(code: string): string {
  return CODE_WORDS[code] ?? CODE_WORDS.other ?? "Something went wrong.";
}
