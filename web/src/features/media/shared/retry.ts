// retry.ts — ride out Synapse's per-user rate limit (429 / M_LIMIT_EXCEEDED) on state writes: wait
// retry_after_ms (0.5–5 s) and try again, at most twice. Every other error is thrown at once.
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const any = e as { errcode?: string; httpStatus?: number; data?: { errcode?: string; retry_after_ms?: number } };
      const limited = any?.errcode === "M_LIMIT_EXCEEDED" || any?.data?.errcode === "M_LIMIT_EXCEEDED" || any?.httpStatus === 429;
      if (!limited || i >= tries - 1) throw e;
      const ms = Math.min(5000, Math.max(500, Number(any?.data?.retry_after_ms ?? 1000)));
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
