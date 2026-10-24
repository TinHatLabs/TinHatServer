// log.ts — tagged console logging with an in-memory ring buffer.
//
// The native app writes `[tag] message` lines to its log file (and ships the previous session's
// scrubbed log with a bug report). The web keeps the last LOG_MAX lines in memory so the Bug
// report dialog (settings agent) can attach them via `getLogText()`. Access tokens / passwords
// are scrubbed from every line before it is stored.
//
//   const log = createLogger("sync");
//   log.info("first sync done", { rooms: 12 });
//   log.warn(...); log.error(...); log.debug(...)   // debug only prints with #twdebug / DEV
//
// Never log secrets on purpose — the scrubber is a backstop, not a licence.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  ts: number;
  level: LogLevel;
  tag: string;
  text: string;
}

const LOG_MAX = 2000;
const lines: LogLine[] = [];
const listeners = new Set<() => void>();

const DEBUG =
  (typeof import.meta !== "undefined" && import.meta.env?.DEV) ||
  (typeof location !== "undefined" && /twdebug/.test(location.hash));

const SCRUB: Array<[RegExp, string]> = [
  [/(access_token|refresh_token|accessToken|refreshToken|password|new_password|token|client_secret|key)(["']?\s*[:=]\s*["']?)[^"'\s&,}]+/gi, "$1$2<redacted>"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>"],
  [/syt_[A-Za-z0-9_]+/g, "syt_<redacted>"],
];

export function scrub(s: string): string {
  let out = s;
  for (const [re, rep] of SCRUB) out = out.replace(re, rep);
  return out;
}

function fmt(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function push(level: LogLevel, tag: string, args: unknown[]) {
  const text = scrub(args.map(fmt).join(" "));
  lines.push({ ts: Date.now(), level, tag, text });
  if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX);
  for (const l of listeners) l();
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(tag: string): Logger {
  const p = `[${tag}]`;
  return {
    debug: (...a) => {
      push("debug", tag, a);
      if (DEBUG) console.debug(p, ...a);
    },
    info: (...a) => {
      push("info", tag, a);
      console.info(p, ...a);
    },
    warn: (...a) => {
      push("warn", tag, a);
      console.warn(p, ...a);
    },
    error: (...a) => {
      push("error", tag, a);
      console.error(p, ...a);
    },
  };
}

/** The retained log, one `ISO-time LEVEL [tag] text` line each (already scrubbed). */
export function getLogText(): string {
  return lines
    .map((l) => `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} [${l.tag}] ${l.text}`)
    .join("\n");
}

export function getLogLines(): readonly LogLine[] {
  return lines;
}

export function onLog(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const isDebug = (): boolean => DEBUG;
