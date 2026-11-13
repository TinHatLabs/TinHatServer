// memlog.ts — the [mem] log line (12.1.12; the desktop's crates/app/src/memlog.rs).
//
// A report of the desktop taking 8 GB carried no memory figures, so its log could not say what grew. Both apps now log
// one [mem] line at start and every 60 s. A page cannot read its process's memory (no RSS/PSS/anonymous figures, see
// docs/WEB-EXCEPTIONS.md "Memory figures in the log"): Chromium exposes only its JavaScript heap
// (`performance.memory`, non-standard), so the web line carries that, with the growth per minute like the desktop's.
// Firefox and Safari expose nothing: one line says so and no timer runs.
import { createLogger } from "./log";

export const PERIOD_MS = 60_000;

/** Chromium's `performance.memory`, in bytes */
export interface JsMem {
  used: number;
  total: number;
  limit: number;
}

/** `performance.memory` when the browser has it (Chromium), else null */
export function readJsMem(perf: unknown): JsMem | null {
  const m = (perf as { memory?: Record<string, unknown> } | null | undefined)?.memory;
  if (!m) return null;
  const used = m.usedJSHeapSize, total = m.totalJSHeapSize, limit = m.jsHeapSizeLimit;
  if (typeof used !== "number" || typeof total !== "number" || typeof limit !== "number") return null;
  if (!Number.isFinite(used) || !Number.isFinite(total) || !Number.isFinite(limit) || used <= 0) return null;
  return { used, total, limit };
}

const mb = (b: number) => `${Math.round(b / 1048576)}MB`;
const rate = (d: number, secs: number) => `${d >= 0 ? "+" : "-"}${(Math.abs(d) / 1048576 * 60 / secs).toFixed(1)}MB/min`;

/** The line's text for `now`, with the growth since `prev` (taken `secs` earlier). The logger adds the [mem] tag. */
export function formatMemLine(now: JsMem, prev: { m: JsMem; secs: number } | null): string {
  let s = `js_used=${mb(now.used)} js_total=${mb(now.total)} js_limit=${mb(now.limit)}`;
  if (prev && prev.secs > 0) s += ` d_js_used=${rate(now.used - prev.m.used, prev.secs)}`;
  return s;
}

let started = false;

/** Start the [mem] lines (once per page). */
export function startMemLog(periodMs = PERIOD_MS): void {
  if (started) return;
  started = true;
  const log = createLogger("mem");
  const perf = typeof performance !== "undefined" ? performance : null;
  const first = readJsMem(perf);
  if (!first) {
    log.info("memory figures unavailable in this browser (no performance.memory)");
    return;
  }
  // elapsed time on the monotonic clock (a wall-clock change would distort the rate)
  let prev = { m: first, at: performance.now() };
  log.info(formatMemLine(first, null));
  setInterval(() => {
    const now = readJsMem(perf);
    if (!now) return;
    const at = performance.now();
    log.info(formatMemLine(now, { m: prev.m, secs: (at - prev.at) / 1000 }));
    prev = { m: now, at };
  }, periodMs);
}
