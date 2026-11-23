// rules.ts — the games' small UI derivations both apps draw the same way (share claude/minigames/ui/ui.json: card
// faces, raise presets, seat slots, chip labels) + the Rig's deck / paytable / words. SHARED LOGIC: the desktop's
// play_wire.rs replays the same cases. Pure: no React, no app imports.
import wordsJson from "../../../testvectors/games/words.json" with { type: "json" };
import type { Game, HandCategory, HoldemView, Pot } from "./wire";
// gameVisible / gameSpace / rankContext live ONCE per app: features/prestige/clientRules.ts (the prestige feature).

// ---- cards ---------------------------------------------------------------------------------------------------------
const RANK_WORD: Record<string, string> = { "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Nine", T: "Ten", J: "Jack", Q: "Queen", K: "King", A: "Ace" };
const SUIT_WORD: Record<string, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
const SUIT_GLYPH: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
export interface CardFace {
  /** the corner index: "A", "10", "K" */
  rank: string;
  suit: string;
  glyph: string;
  red: boolean;
  /** the accessible name: "Ace of spades" */
  label: string;
}
export function cardFace(card: string): CardFace | null {
  if (!/^[2-9TJQKA][shdc]$/.test(card)) return null;
  const r = card[0]!,
    s = card[1]!;
  return { rank: r === "T" ? "10" : r, suit: s, glyph: SUIT_GLYPH[s]!, red: s === "h" || s === "d", label: `${RANK_WORD[r]} of ${SUIT_WORD[s]}` };
}

// ---- Hold'em derivations ------------------------------------------------------------------------------------------
/** Everything in the middle: `hand.total` (the pots of earlier streets + this street's bets). */
export function potTotal(v: Pick<HoldemView, "seats"> & { hand: { pots: Pot[]; total?: number } | null }): number {
  if (v.hand && typeof v.hand.total === "number") return v.hand.total;
  const pots = v.hand ? v.hand.pots.reduce((a, p) => a + p.amount, 0) : 0;
  return pots + v.seats.reduce((a, s) => a + s.bet, 0);
}

/** A made hand's words (result.best[seat].category; the shared words.json `table.categories`). */
export const HAND_WORDS: Readonly<Record<string, string>> = wordsJson.table.categories;

/** Why a table closed (view.closed.reason; the shared words.json `table.closed_reasons`). */
export const CLOSED_WORDS: Readonly<Record<string, string>> = wordsJson.table.closed_reasons;

/** "{who} wins {n} with {what}" split around {who} (the name is drawn as a name). */
export function wonWith(n: number, what: string): [string, string] {
  const t = wordsJson.table.won_with.replace("{n}", String(n)).replace("{what}", what);
  const i = t.indexOf("{who}");
  return i < 0 ? ["", t] : [t.slice(0, i), t.slice(i + 5)];
}
export const GAMES_TIP: string = wordsJson.callbar.games_tip;

/** F7 (addendum §4.1): what each reaction says ("Ana tipped their hat"); the shared words.json `react.*` once it has
 *  them, else these. */
export const R2X = ((wordsJson as unknown as { table: { r2?: Record<string, string>; react?: Record<string, string> } }).table.r2 ?? {}) as Record<string, string>;
const RXW = ((wordsJson as unknown as { table: { react?: Record<string, string> } }).table.react ?? {}) as Record<string, string>;
const REACT_W: Record<string, string> = {
  tip: "tipped their hat",
  knock: "knocked on the table",
  clap: "slow-clapped",
  toss: "tossed a coin to {person}",
  sweat: "is sweating",
  foil: "adjusted their foil",
  ...RXW,
  toss_pot: "tossed a coin into the pot",
  label_tip: R2X.react_tip_tip ?? "Tip your hat",
  label_knock: R2X.react_tip_knock ?? "Knock on the table",
  label_clap: R2X.react_tip_clap ?? "Slow clap",
  label_toss: R2X.react_tip_toss ?? "Toss a coin",
  label_sweat: R2X.react_tip_sweat ?? "Sweat",
  label_foil: R2X.react_tip_foil ?? "Adjust your foil",
  tray: "React",
  mute_all: R2X.react_mute_all ?? "Mute reactions",
  mute_person: R2X.react_mute_user ?? "Mute {person}'s reactions",
  unmute_person: R2X.react_unmute_user ?? "Show {person}'s reactions again",
  toss_to: "Toss to",
  pot: R2X.react_pot ? R2X.react_pot.charAt(0).toUpperCase() + R2X.react_pot.slice(1) : "The pot",
  many: R2X.react_n ?? "{n} reactions",
};
export const REACT_WORDS: Readonly<Record<string, string>> = REACT_W;

/** F9 Tune In (addendum §6.4) + the earn line (§5.5): the shared words.json `side.*` once it has them, else these. */
export const SIDE_WORDS: Readonly<Record<string, string>> = {
  title: R2X.tune_title ?? "Tune In",
  button: R2X.tune_title ?? "Tune In",
  offer: R2X.tune_offer ?? "Out of chips? Tune In to earn up to {n} today",
  intro: R2X.tune_how ?? "A signal is out there between 1 and 100. Tune to it.",
  higher: R2X.tune_higher ?? "Static… higher",
  lower: R2X.tune_lower ?? "Static… lower",
  field: R2X.tune_field ?? "Your guess",
  range: R2X.tune_range ?? "Somewhere from {lo} to {hi}",
  tune: R2X.tune_go ?? "Tune",
  tries: R2X.tune_tries ?? "{n} tries left",
  found: R2X.tune_found ?? "Signal locked: +{n} chips",
  lost: R2X.tune_lost ?? "Lost the signal. It was {n}.",
  cancelled: "The signal faded. Nothing was paid.",
  starting: "Finding a signal…",
  again: R2X.tune_again ?? "Again",
  back: R2X.tune_back ?? "Back to the table",
  error: R2X.tune_error ?? "Couldn't reach the signal. Try again in a moment.",
  earn_line: R2X.admin_earn_line ?? "1 chip every {m} min in a call, up to {d} a day.",
};
/** Tune In's own words for a refusal (tune_code_*), else the shared code words. */
export function tuneCodeWords(code: string): string | null {
  return R2X[`tune_code_${code}`] ?? null;
}
/** "1 chip every 15 min in a call, up to 16 a day" (the wallet's own chip_s / day_max: per space since 0.3.21) */
export function earnLine(chipS: number, dayMax: number): string {
  return SIDE_WORDS.earn_line!.replace("{m}", String(Math.max(1, Math.round(chipS / 60)))).replace("{d}", String(dayMax));
}
export function reactWords(r: string, to?: number | "pot", person = "someone"): string {
  if (r === "toss" && (to === undefined || to === "pot")) return REACT_W.toss_pot!;
  return (REACT_W[r] ?? r).replace("{person}", person);
}

/** `/me/journal` reasons (PM ruling 16:57, addendum v1.0.7): the new `admin`, `side` and `oneoff` (the +25 gift; its tx
 *  KIND `admin-topup` is never a reason); ANY unknown reason (the server's `other`, `admin-topup` included) is "Other",
 *  never a borrowed label. */
const JOURNAL_W: Record<string, string> = {
  start: "Starting chips",
  earn: "Earned in a call",
  topup: "Daily top-up",
  prestige: "Prestige",
  sit: "Sat down at a table",
  cashout: "Left a table",
  "rig-escrow": "The Rig: staked",
  "rig-settle": "The Rig: settled",
  void: "A hand was called off",
  "lab-grant": "Lab chips",
  admin: "Admin change",
  side: "Tune In",
  oneoff: "A one-time gift from the server",
  ...(((wordsJson as unknown as { journal?: Record<string, string> }).journal) ?? {}),
};
export function journalReasonWords(reason: unknown): string {
  return (typeof reason === "string" && Object.prototype.hasOwnProperty.call(JOURNAL_W, reason) ? JOURNAL_W[reason] : undefined) ?? "Other";
}

/** F5 (GAMES-V1.1-ADDENDUM §2): the hand rankings, strongest first: the shared words.json `table.categories` (name),
 *  `rank_eg` (a five-card example) and `rank_lines` (one line). The desktop's sheet reads the same file. */
export interface HandRankRow {
  category: HandCategory;
  name: string;
  example: readonly string[];
  line: string;
}
type R2Table = { r2: Record<string, string>; rank_eg: Record<string, string[]>; rank_lines: Record<string, string>; categories: Record<string, string> };
const R2T = (wordsJson as unknown as { table: R2Table }).table;
export const HAND_ORDER: readonly HandCategory[] = ["straight-flush", "quads", "full-house", "flush", "straight", "trips", "two-pair", "pair", "high-card"];
export const HAND_RANKINGS: readonly HandRankRow[] = HAND_ORDER.map((c) => ({ category: c, name: R2T.categories[c]!, example: R2T.rank_eg[c]!, line: R2T.rank_lines[c]! }));
export const HAND_NAME: Readonly<Record<HandCategory, string>> = R2T.categories as Record<HandCategory, string>;

/** Round 2's new lines (GAMES-V1.1-ADDENDUM): the shared words.json `table.r2` (games-desktop2 keeps the file). */
export const R2_WORDS: Readonly<{
  cards_on_phone: string;
  show_here: string;
  hands_button: string;
  hands_title: string;
  hands_foot: string;
  hands_you: string;
  hands_close: string;
  hidden_sharing: string;
  odds_win: string;
  odds_tie: string;
  odds_improve: string;
  odds_improve_one: string;
  odds_info: string;
  odds_toggle: string;
  away_back: string;
  away_stand_hands: string;
  away_stand_one: string;
  away_pill_hands: string;
  away_reason_timeout: string;
  away_reason_gone: string;
  away_reason_asked: string;
  stood_up: string;
  sit_down: string;
  stage_table: string;
  stage_call: string;
  turn_title: string;
  turn_title_prefix: string;
  turn_body: string;
  turn_last: string;
  turn_ask: string;
  turn_yes: string;
  turn_no: string;
  turn_toggle: string;
  away_stand_rounds: string;
  away_stand_one_round: string;
  away_rig_watch: string;
  away_rig_skipped: string;
}> = {
  // B10 (addendum §8.2): until the shared words.json carries them (games-desktop2 appends; these are the proposed lines)
  away_back: "I'm back",
  away_stand_hands: "You'll stand up in {n} hands (chips kept)",
  away_stand_one: "You'll stand up after the next hand (chips kept)",
  away_pill_hands: "away · {n}",
  away_reason_timeout: "Your turn ran out, so you're sitting out",
  away_reason_gone: "You were away when the hand was dealt",
  away_reason_asked: "You're sitting out",
  stood_up: "You stood up: {n} chips back in your wallet",
  sit_down: "Sit down",
  // B4 / B10 §8.3 (proposed for the shared file)
  stage_table: "Table",
  stage_call: "Call",
  turn_title: "Your turn",
  turn_title_prefix: "(Your turn) ",
  turn_body: "{game} in {room}",
  turn_last: "{s} s left · you'll check or fold",
  turn_ask: "Tell me when it's my turn, even in another game?",
  turn_yes: "Yes",
  turn_no: "No",
  turn_toggle: "Tell me when it's my turn",
  // B10 on The Rig (proposed for the shared file)
  away_stand_rounds: "You'll stand up in {n} rounds (chips kept)",
  away_stand_one_round: "You'll stand up after this round (chips kept)",
  away_rig_watch: "You're away: watching only this round (no Nudge, Whisper, Peek or Market)",
  away_rig_skipped: "Your turn to spin is skipped while you're away",
  ...(R2T.r2 as Record<string, string>),
} as never;

type WordsT = { table: Record<string, unknown> };
const T = (wordsJson as unknown as WordsT).table;
/** A made hand inside a sentence ("a straight", "two pair"): words.json `table.categories_in_sentence` once the shared
 *  file has it (proposed by the web, 12:2x), else these. */
const IN_SENTENCE: Readonly<Record<string, string>> = (T.categories_in_sentence as Record<string, string> | undefined) ?? {
  "high-card": "high card",
  pair: "a pair",
  "two-pair": "two pair",
  trips: "three of a kind",
  straight: "a straight",
  flush: "a flush",
  "full-house": "a full house",
  quads: "four of a kind",
  "straight-flush": "a straight flush",
};
/** The winner line: mine "You win 60 with a straight", someone's "{who} wins 60 with a pair" (split around {who}). */
export function winLine(me: boolean, n: number, category: string | undefined): [string, string] {
  const won = T.won_with as string;
  const cats = T.categories as Record<string, string>;
  // the shared line decides the form: "· {what}" takes the hand's name, "with {what}" the in-sentence words
  const what = category ? (won.includes(" with ") ? (IN_SENTENCE[category] ?? category) : (cats[category] ?? category)) : "";
  if (me) {
    const t = (T.you_win_with as string | undefined) ?? won.replace("{who} wins", "You win");
    const tn = (T.you_win as string | undefined) ?? "You win {n}";
    return ["", (what ? t : tn).replace("{n}", String(n)).replace("{what}", what)];
  }
  const t = what ? (T.won_with as string).replace("{n}", String(n)).replace("{what}", what) : ((T.won_n as string | undefined) ?? "{who} won {n}").replace("{n}", String(n));
  const i = t.indexOf("{who}");
  return i < 0 ? ["", t] : [t.slice(0, i), t.slice(i + 5)];
}
export const WHISPER_ALONE: string = wordsJson.rig.whisper_alone;

/** A person in a history answer: `~1`, `~2`… = someone who deleted their chips. */
export function isSomeone(u: string): boolean {
  return /^~[1-9][0-9]?$/.test(u);
}

export interface RaisePreset {
  id: "half" | "pot" | "allin";
  label: string;
  to: number;
}
/** One raise-bar quick amount (ui.json `raise_preset`): f = 0.5 (½ pot) or 1 (pot): raise TO = the highest bet on the
 *  street + floor(f × (the pots + every seat's bet + my call)), clamped to legal.raise; "max" = legal.raise.max; null
 *  when no raise is legal. */
export function raisePreset(i: { pots: number[]; bets: number[]; call: number | false | null | undefined; raise: { min: number; max: number } | null | undefined; f: 0.5 | 1 | "max" }): number | null {
  const r = i.raise;
  if (!r) return null;
  if (i.f === "max") return r.max;
  const top = i.bets.reduce((a, b) => Math.max(a, b), 0);
  const pot = i.pots.reduce((a, b) => a + b, 0) + i.bets.reduce((a, b) => a + b, 0) + (typeof i.call === "number" ? i.call : 0);
  return Math.max(r.min, Math.min(r.max, top + Math.floor(i.f * pot)));
}

export interface RaisePreset {
  id: "half" | "pot" | "allin";
  label: string;
  to: number;
}
/** The raise chips (½ pot · pot · all-in) for a view; a chip that lands on an earlier one's amount or on the all-in is
 *  left out (all-in always stays). */
export function raisePresets(v: HoldemView): RaisePreset[] {
  const y = v.you;
  const r = y?.legal?.raise;
  if (!y || !r) return [];
  const base = { pots: v.hand ? v.hand.pots.map((p) => p.amount) : [], bets: v.seats.map((x) => x.bet), call: y.legal?.call, raise: r };
  const out: RaisePreset[] = [];
  const add = (p: RaisePreset) => {
    if (p.id !== "allin" && (out.some((o) => o.to === p.to) || p.to >= r.max)) return;
    out.push(p);
  };
  add({ id: "half", label: "½ pot", to: raisePreset({ ...base, f: 0.5 })! });
  add({ id: "pot", label: "Pot", to: raisePreset({ ...base, f: 1 })! });
  add({ id: "allin", label: "All-in", to: r.max });
  return out;
}

/** ui.json `seat_slot`: slot 0 = bottom centre, then clockwise; rotated so MY seat is slot 0 (watching: seat 1). */
export function seatSlot(seat: number, mySeat: number, seats: number): number {
  const base = mySeat >= 1 ? mySeat : 1;
  return (((seat - base) % seats) + seats) % seats;
}

/** Seat positions around the oval, in % of the felt (x, y), with MY seat at the bottom centre and the rest clockwise. A
 *  spectator sees seat 1 at the bottom. `n` = the table's seat count (2–8). */
export function seatLayout(n: number, mySeat: number | null): { seat: number; x: number; y: number }[] {
  const count = Math.max(2, Math.min(8, Math.floor(n)));
  const bottom = mySeat && mySeat >= 1 && mySeat <= count ? mySeat : 1;
  const out: { seat: number; x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const seat = ((bottom - 1 + i) % count) + 1;
    // clockwise from the bottom: angle 90° (bottom) → 180° (left) → 270° (top) → 0° (right)
    const a = Math.PI / 2 + (i * 2 * Math.PI) / count;
    out.push({ seat, x: Math.round((50 + 46 * Math.cos(a)) * 10) / 10, y: Math.round((50 + 44 * Math.sin(a)) * 10) / 10 });
  }
  return out;
}

/** Seconds left on a server deadline, corrected for the clock difference seen in the view (`now` = the server's time
 *  when it built the view, `seenAt` = our time when it arrived). Never negative. */
export function secondsLeft(deadline: number, serverNow: number, seenAt: number, localNow: number): number {
  if (!deadline) return 0;
  const serverClock = serverNow + (localNow - seenAt);
  return Math.max(0, Math.ceil((deadline - serverClock) / 1000));
}

/** The words of a seat's last action ("Raise to 18", "All-in", "Check"). */
export function actionWords(a: string, to?: number): string {
  switch (a) {
    case "fold":
      return "Fold";
    case "check":
      return "Check";
    case "call":
      return to ? `Call ${to}` : "Call";
    case "raise":
      return to ? `Raise to ${to}` : "Raise";
    case "bet":
      return to ? `Bet ${to}` : "Bet";
    case "allin":
      return "All-in";
    case "sb":
      return "Small blind";
    case "bb":
      return "Big blind";
    default:
      return "";
  }
}

export const SEAT_STATE_WORDS: Readonly<Record<string, string>> = {
  waiting: "Next hand",
  active: "",
  folded: "Folded",
  allin: "All-in",
  away: "Away",
  out: "Out of chips",
  leaving: "Leaving",
};

// ---- The Rig: the deck, symbols, paytable (§5.0) ------------------------------------------------------------------
const W = wordsJson;

/** One shared word (testvectors/games/words.json, byte-identical in the desktop): `w("table.fold")`, with {vars}. */
export function w(path: string, vars?: Readonly<Record<string, string | number>>): string {
  let v: unknown = wordsJson;
  for (const k of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
  let out = typeof v === "string" ? v : path;
  if (vars) for (const [k, x] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(x));
  return out;
}
export const RIG_SYMBOL_WORDS: Readonly<Record<string, string>> = W.rig.symbols;
export const RIG_SYMBOL_GLYPH: Readonly<Record<string, string>> = { hat: "🎩", saucer: "🛸", dish: "📡", eye: "👁", moon: "🌙", lizard: "🦎" };
export const PAYTABLE: readonly { what: string; pays: number }[] = (W.rig.paytable as [string, number][]).map(([what, pays]) => ({ what, pays }));

export interface RigCardInfo {
  id: string;
  n: number;
  name: string;
  kind: "reel" | "payout";
  lite: boolean;
  bite: number;
  tax: boolean;
  rule: string;
}
/** The 16 cards in deck order (the shared words.json `rig.cards`, the spec's §5.0 table in plain words). */
export const RIG_CARDS: readonly RigCardInfo[] = Object.entries(W.rig.cards as Record<string, Omit<RigCardInfo, "id" | "n">>).map(([id, c], i) => ({ id, n: i + 1, ...c }));
const BY_ID = new Map(RIG_CARDS.map((c) => [c.id, c]));
export function rigCard(id: string): RigCardInfo | null {
  return BY_ID.get(id) ?? null;
}

export const RIG_ROLE_WORDS: Readonly<Record<string, string>> = { spinner: W.rig.spinner, mechanic: W.rig.mechanic, sharp: W.rig.sharp, railbird: W.rig.railbird, spectator: W.rig.spectator, lobby: W.rig.join };
export const RIG_PHASE_WORDS: Readonly<Record<string, string>> = { paused: "Paused: the Spinner dropped out", ...W.rig.phases };
export const STAMP_WORDS: Readonly<Record<string, string>> = { refilled: "Slot refilled", ...W.rig.stamps };

/** The six Whisper templates (§5.1 item 12) by their contract ids; `{person}` is filled with a name. */
export const WHISPER_TEMPLATES: Readonly<Record<string, string>> = Object.fromEntries(
  ["bet-size", "not-moon", "last-spin", "reel-2", "bluffing", "trust-nobody"].map((id, i) => [id, (W.rig.whisper_templates as string[])[i] ?? id]),
);
/** A free-text Whisper the server will take: 1–60 characters, no control characters, no links. */
export function whisperOk(text: string): boolean {
  const t = text.trim();
  // eslint-disable-next-line no-control-regex
  return t.length >= 1 && [...t].length <= 60 && !/[\u0000-\u001f\u007f-\u009f]/.test(t) && !/:\/\/|www\./i.test(t);
}

// ---- which tables a context lists ---------------------------------------------------------------------------------
/** ui.json `chip_label`: the call strip's chip ("♠ Hold'em · 3 seated · Join"). */
/** The statuses that get a chip (the shared rule): an ended or closed table is listed but draws none. */
export const CHIP_STATUSES: ReadonlySet<string> = new Set(["lobby", "hand", "pause", "round"]);
export function chipLabel(t: { game: Game; status: string; seated: number; round?: number | null }): string | null {
  if (!CHIP_STATUSES.has(t.status)) return null;
  if (t.game === "holdem") return `♠ Hold'em · ${t.seated} seated · Join`;
  return t.status !== "lobby" && t.round ? `🎰 The Rig · round ${t.round} · Join` : `🎰 The Rig · ${t.seated} joined · Join`;
}
/** The chip's label without its trailing "· Join" (the app draws Join as its own pill). */
export function chipWords(t: { game: Game; status: string; seated: number; round?: number | null }): string | null {
  const l = chipLabel(t);
  return l === null ? null : l.replace(/ · Join$/, "");
}

export const GAME_WORDS: Readonly<Record<Game, string>> = { holdem: "Texas Hold'em", rig: "The Rig" };

/** The plain bodies other clients show (§6.6: no amounts, ever). The Rig's are always the neutral lines, so a client
 *  that hides The Rig (a phone app) shows nothing of it even where it draws only the body. */
export function cardBody(kind: "invite" | "result" | "summary", game: Game, who: string): string {
  if (game === "rig") return kind === "invite" ? "A game is on in this call." : "Game results are in: open this in Tin Hat.";
  if (kind === "invite") return `${who} opened a Texas Hold'em table: join from the call.`;
  return "Texas Hold'em results are in: open this in Tin Hat.";
}

/** The opt-in line (rev 2 §2.2): once per space (the shared words.json `optin.body`). */
export function optInLine(space: string): string {
  return W.optin.body.replace("{space}", space);
}

/** Deal (the host, in the lobby): the server's `you.can_deal` when the view carries it; older servers: two seated
 *  players with chips, not away (the same count the server makes). */
export function canDeal(v: Pick<HoldemView, "seats" | "you">): boolean {
  if (typeof v.you?.can_deal === "boolean") return v.you.can_deal;
  return v.seats.filter((x) => x.stack > 0 && x.state !== "away").length >= 2;
}

export type CardAction = "open" | "join_call" | "";
/** A game chat card's action (spec §4.5; one rule for both apps): an invite only. A LIVE table (lobby / hand / pause /
 *  round): in this room's call → Open; outside it → Join the call (the server refuses live views outside the call). An
 *  ENDED table: Open in the call (its results); outside → nothing ("Table over": the results card carries them). Closed
 *  or no longer listed: nothing. */
export function cardAction(kind: string, status: string | null | undefined, inCall: boolean): CardAction {
  if (kind !== "invite" || !status || status === "closed") return "";
  if (status === "end") return inCall ? "open" : "";
  return inCall ? "open" : "join_call";
}
