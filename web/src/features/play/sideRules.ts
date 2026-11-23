// sideRules.ts — F9 "Tune In" (GAMES-V1.1-ADDENDUM §6): the answers' shapes, read tolerantly until the contract
// carries them (a wrong shape = nothing drawn), and the one client-side check (a try inside the still-possible range).
// Pure: no React, no app imports.
export interface SideInfo {
  on: boolean;
  eligible: boolean;
  reason: null | "not-broke" | "open-money" | "day-max" | "off";
  left_today: number;
  day_max: number;
  broke_max: number;
}
export interface TuneRun {
  run: string;
  lo: number;
  hi: number;
  tries_left: number;
  expires: number;
  pay: number[];
  left_today: number;
}
export type TuneResult = "higher" | "lower" | "found" | "lost" | "cancelled";
export interface TuneAnswer {
  result: TuneResult;
  lo: number;
  hi: number;
  tries_left: number;
  paid: number;
  secret: number | null;
}

const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
export function parseSide(v: unknown): SideInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.on !== "boolean" || typeof o.eligible !== "boolean" || !int(o.left_today) || !int(o.day_max) || !int(o.broke_max)) return null;
  const reasons = ["not-broke", "open-money", "day-max", "off"];
  const reason = typeof o.reason === "string" && reasons.includes(o.reason) ? (o.reason as SideInfo["reason"]) : null;
  return { on: o.on, eligible: o.eligible, reason, left_today: o.left_today, day_max: o.day_max, broke_max: o.broke_max };
}
export function parseRun(v: unknown): TuneRun | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.run !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(o.run) || !int(o.lo) || !int(o.hi) || !int(o.tries_left) || o.lo < 1 || o.hi > 100 || o.lo > o.hi) return null;
  const pay = Array.isArray(o.pay) && o.pay.every(int) ? (o.pay as number[]) : [3, 3, 3, 3, 2, 2, 1];
  return { run: o.run, lo: o.lo, hi: o.hi, tries_left: o.tries_left, expires: int(o.expires) ? o.expires : 0, pay, left_today: int(o.left_today) ? o.left_today : 0 };
}
export function parseAnswer(v: unknown): TuneAnswer | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const results = ["higher", "lower", "found", "lost", "cancelled"];
  if (typeof o.result !== "string" || !results.includes(o.result) || !int(o.lo) || !int(o.hi) || !int(o.tries_left)) return null;
  return { result: o.result as TuneResult, lo: o.lo, hi: o.hi, tries_left: o.tries_left, paid: int(o.paid) ? o.paid : 0, secret: int(o.secret) ? o.secret : null };
}
/** The tries still allowed: inside lo..hi (anything else is refused `bad` and costs nothing). */
export function guessOk(g: number, lo: number, hi: number): boolean {
  return Number.isInteger(g) && g >= lo && g <= hi;
}

