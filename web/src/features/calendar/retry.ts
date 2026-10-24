// retry.ts — state writes that ride out Synapse's rate limiter. js-sdk retries 429s for timeline
// messages (its scheduler) but not for PUT /state; a burst like "save event → game → RSVP → card →
// event again" on a busy account used to fail its last write with "Slow down a little". We wait the
// server's `retry_after_ms` (capped) and try again, up to 3 attempts; other errors pass straight
// through (the friendly() wording still applies when the limiter doesn't let go). Native has no
// retry (it shows the banner) — a web improvement, logged in docs/native-bugs/calendar.md.
import { sendState as coreSendState } from "@/core/matrix";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfter(e: unknown): number | null {
  const o = e as { errcode?: string; httpStatus?: number; data?: { errcode?: string; retry_after_ms?: number } };
  const code = o?.errcode ?? o?.data?.errcode;
  if (code !== "M_LIMIT_EXCEEDED" && o?.httpStatus !== 429) return null;
  const ms = Number(o?.data?.retry_after_ms);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms + 100, 10_000) : 2_000;
}

export async function sendStateRetry(roomId: string, type: string, key: string, content: Record<string, unknown>): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await coreSendState(roomId, type, key, content);
    } catch (e) {
      const wait = retryAfter(e);
      if (wait === null || attempt >= 3) throw e;
      await sleep(wait);
    }
  }
}
