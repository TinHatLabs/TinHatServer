// reactions.ts — F7 table reactions (GAMES-V1.1-ADDENDUM §4): light, no money. The set and the limits are the shared
// testvectors/games/table-ui-v1.json `reactions` (one list in both apps + the server); the bucket here is the client
// MIRROR of the server's (it greys a button for the cooldown; the server is the word). Pure: no React, no app imports.
import ui from "../../../testvectors/games/table-ui-v1.json" with { type: "json" };

type R = { ids: string[]; targeted: string[]; burst: number; refill_ms: number; table_per_min: number };
const RX = (ui as unknown as { reactions: R }).reactions;

export type ReactionId = "tip" | "knock" | "clap" | "toss" | "sweat" | "foil";
/** tray order */
export const REACTIONS: readonly ReactionId[] = RX.ids as ReactionId[];
export const REACT_TARGETED: ReadonlySet<string> = new Set(RX.targeted);
export const REACT_BURST = RX.burst;
export const REACT_REFILL_MS = RX.refill_ms;
export const REACT_TABLE_PER_MIN = RX.table_per_min;

/** A token bucket: `burst` at once, one more every `refillMs`, never above `burst`. */
export class ReactBucket {
  private tokens: number;
  private at: number | null = null;
  private readonly burst: number;
  private readonly refillMs: number;
  constructor(burst = REACT_BURST, refillMs = REACT_REFILL_MS) {
    this.burst = burst;
    this.refillMs = refillMs;
    this.tokens = burst;
  }
  private fill(now: number): void {
    if (this.at === null) {
      this.at = now;
      return;
    }
    const n = Math.floor((now - this.at) / this.refillMs);
    if (n > 0) {
      this.tokens = Math.min(this.burst, this.tokens + n);
      this.at = this.tokens >= this.burst ? now : this.at + n * this.refillMs;
    }
  }
  /** take one now; false = over the limit (nothing taken) */
  take(now: number): boolean {
    this.fill(now);
    if (this.tokens < 1) return false;
    if (this.tokens >= this.burst) this.at = now;
    this.tokens--;
    return true;
  }
  /** ms until the next take would pass (0 = now) */
  waitMs(now: number): number {
    this.fill(now);
    if (this.tokens >= 1) return 0;
    return Math.max(0, (this.at ?? now) + this.refillMs - now);
  }
}

/** The glyph each reaction draws (the tray and the stage). `tip` uses the prestige token's glyph (an icon, not text). */
export const REACT_GLYPH: Readonly<Record<ReactionId, string>> = { tip: "", knock: "✊", clap: "👏", toss: "🪙", sweat: "💧", foil: "🥶" };

/** A received reaction (the `react` frame, §4.2); never stored, never logged. */
export interface ReactEvt {
  table: string;
  u: string;
  seat: number | null;
  r: ReactionId;
  to?: number | "pot";
  at: number;
  /** local arrival time (drawing) */
  got: number;
}
export function parseReact(f: unknown): Omit<ReactEvt, "got"> | null {
  if (!f || typeof f !== "object") return null;
  const o = f as Record<string, unknown>;
  if (o.t !== "react" || typeof o.table !== "string" || typeof o.u !== "string" || typeof o.r !== "string" || !REACTIONS.includes(o.r as ReactionId)) return null;
  const seat = typeof o.seat === "number" && Number.isInteger(o.seat) ? o.seat : null;
  const to = o.to === "pot" ? "pot" : typeof o.to === "number" && Number.isInteger(o.to) ? o.to : undefined;
  if (o.r !== "toss" && to !== undefined) return null;
  return { table: o.table, u: o.u, seat, r: o.r as ReactionId, ...(to !== undefined ? { to } : {}), at: typeof o.at === "number" ? o.at : 0 };
}
