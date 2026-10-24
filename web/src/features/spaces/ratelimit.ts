// ratelimit.ts — Synapse rate limits (M_LIMIT_EXCEEDED / 429) on membership changes and state
// bursts: wait the server's retry_after_ms (≤ 15 s) and try again, twice at most. The native
// surfaces the 429 as an error; retrying is strictly better and changes nothing on the wire.
import { createLogger } from "@/core/log";

const log = createLogger("spaces.rl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function rl<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      const err = e as { errcode?: string; httpStatus?: number; data?: { retry_after_ms?: number; errcode?: string } };
      const limited = err?.errcode === "M_LIMIT_EXCEEDED" || err?.data?.errcode === "M_LIMIT_EXCEEDED" || err?.httpStatus === 429;
      const wait = Number(err?.data?.retry_after_ms ?? 2000);
      if (!limited || attempt >= 2 || wait > 15000) throw e;
      log.info(`rate limited — retrying in ${wait} ms`);
      await sleep(wait + 100);
    }
  }
}
