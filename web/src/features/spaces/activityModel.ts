// activityModel.ts — pure wire helpers for "now playing" (dev.tinhat.activity, activity.rs)
// and per-person status (dev.tinhat.userstatus, status_ctl.rs). NO imports: unit-tested under
// Node (activity.test.ts).

export const ACTIVITY_TYPE = "dev.tinhat.activity";
export const USERSTATUS_TYPE = "dev.tinhat.userstatus";

export interface Activity {
  game: string;
  emoji: string;
  code: string;
  setBy: string;
}

export interface UserStatus {
  userId: string;
  text: string;
  expiresAt: number | null;
}

/** Valid only when `game.trim()` is non-empty (activity.rs read). */
export function parseActivity(c: Record<string, unknown> | undefined | null): Activity | null {
  if (!c) return null;
  const game = typeof c.game === "string" ? c.game.trim() : "";
  if (!game) return null;
  const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
  return { game, emoji: s("emoji"), code: s("code"), setBy: s("setBy") };
}

/** set_activity content: blank game → `{}` (clear); else {game, setBy, ts, emoji?, code?}. */
export function activityContent(game: string, setBy: string, ts: number, emoji = "", code = ""): Record<string, unknown> {
  const g = game.trim();
  if (!g) return {};
  const out: Record<string, unknown> = { game: g, setBy, ts };
  if (emoji.trim()) out.emoji = emoji.trim();
  if (code.trim()) out.code = code.trim();
  return out;
}

/** post_status content: blank → `{}`; else {text, expiresAt?} (ttl 0 = no expiry). */
export function statusContent(text: string, ttlMin: number, now: number): Record<string, unknown> {
  const t = text.trim();
  if (!t) return {};
  const out: Record<string, unknown> = { text: t };
  const ttl = Math.max(0, Math.floor(ttlMin));
  if (ttl > 0) out.expiresAt = now + ttl * 60_000;
  return out;
}

/** Readers drop blank text and `expiresAt ≤ now`. */
export function liveStatuses(entries: ReadonlyArray<{ stateKey: string; content: Record<string, unknown> }>, now: number): UserStatus[] {
  const out: UserStatus[] = [];
  for (const e of entries) {
    const text = typeof e.content.text === "string" ? e.content.text.trim() : "";
    if (!text) continue;
    const exp = typeof e.content.expiresAt === "number" ? e.content.expiresAt : null;
    if (exp !== null && exp <= now) continue;
    out.push({ userId: e.stateKey, text, expiresAt: exp });
  }
  return out;
}
