// gamenight.ts — Game night (widget `gameNight`, contract WIDGETS.md §23, vectors testvectors/widgets/gamenight/*): which
// calendar events are game nights (the Game Reel's sessions: kind `session`, the calendar's "Group session" — "the squad
// plays together at a set time"), which one is the hero, the countdown line, the Small line and the credit line. Pure: the
// apps pass the calendar items they already read for Up next, and their own clock-mode "Sat 7:30 PM" text. The desktop's
// Rust port (crates/widgets/src/gamenight.rs) runs the same vectors.
import { fmtUntil } from "./time";

/** A game night is at most this far ahead to show (Up next's longest look-ahead: the calendar read covers 14 days). */
export const LOOK_AHEAD_MS = 14 * 86_400_000;
/** How many nights each size lists (the hero + the next ones on L). */
export const NIGHTS = { S: 1, M: 1, L: 3 } as const;
export const DAY_MS = 86_400_000;

export interface NightItem {
  container: string;
  id: string;
  kind: string;
  start: number;
  end: number;
  canceled: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isWs = (c: string) => c === " " || (c >= "\t" && c <= "\r");
/** ASCII whitespace off both ends. */
function trimAscii(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isWs(s[a]!)) a++;
  while (b > a && isWs(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** The calendar's kind of an event: its `kind` when a non-empty string, else "session" (the calendar's default). */
export function kindOf(kind: unknown): string {
  return typeof kind === "string" && kind ? kind : "session";
}

/**
 * The game nights to show, soonest first: kind "session", not canceled (`true` only), start and end numbers with
 * start > 0, end > now (a running one stays until it ends), start < now + LOOK_AHEAD_MS; sorted by start, then end,
 * container, id (code points); the first `max` (0 = all). An item that is not an object is skipped.
 */
export function selectNights(items: unknown[], now: number, max = 0): NightItem[] {
  const out: NightItem[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const o = it as Record<string, unknown>;
    if (kindOf(o.kind) !== "session" || o.canceled === true) continue;
    if (!isNum(o.start) || !isNum(o.end) || o.start <= 0 || o.end <= now || o.start >= now + LOOK_AHEAD_MS) continue;
    out.push({ container: typeof o.container === "string" ? o.container : "", id: typeof o.id === "string" ? o.id : "", kind: "session", start: o.start, end: o.end, canceled: false });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end || cmpStr(a.container, b.container) || cmpStr(a.id, b.id));
  return max > 0 ? out.slice(0, max) : out;
}

/** The countdown: "now" while it runs, `fmtUntil` ("in 2 h 10 m") while it starts within 24 h, else `dayTime` (the
 *  app's "Sat 7:30 PM"). */
export function nightWhen(start: number, end: number, now: number, dayTime: string): string {
  if (now >= start && now < end) return "now";
  if (start - now < DAY_MS) return fmtUntil(start - now);
  return dayTime;
}

/** The Small line after the header's title "Game night": "Valheim · in 2 h" (the game ASCII-trimmed; "Game TBD" without
 *  one) — the header reads "Game night  Valheim · in 2 h"; none → "No game night planned". */
export function nightSummary(has: boolean, game: string, when: string): string {
  if (!has) return "No game night planned";
  return `${trimAscii(game) || "Game TBD"} · ${when}`;
}

/** Your Game Reel credit (the regret credit, banked): mode "free" → "Credits are off tonight"; unknown (null) → "";
 *  else "Your credit: +n" (n > 0) or "Your credit: 0". */
export function creditText(credit: number | null, mode: string): string {
  if (mode === "free") return "Credits are off tonight";
  if (credit === null || !isNum(credit)) return "";
  const n = Math.max(0, Math.floor(credit));
  return n > 0 ? `Your credit: +${n}` : "Your credit: 0";
}
