// datefmt.ts — the locale clock strings of the message rows (format.ts: the clock and its tooltip), one cached
// Intl.DateTimeFormat per option set and default locale. `toLocale{Time,Date}String(locales, opts)` builds a new formatter
// on every call: ~1 ms each on a phone at 4x CPU, two per message row, 1.2 s of a 750-row room's first open (web-perf-2).
// Same strings: with explicit fields both give identical output (datefmt.test.ts). No app imports (Node unit tests).
const cache = new Map<string, Intl.DateTimeFormat>();
// A formatter keeps the time zone it was built in: the system zone is looked at again at most once a minute (a device
// that moved zones gets fresh formatters within a minute, as a reload would), on a monotonic clock (a system clock set
// back doesn't postpone it), and every formatter is built FOR the zone it is cached under.
let zone = "";
let zoneAt = Number.NEGATIVE_INFINITY;
let wallAt = 0;
function currentZone(): string {
  const now = performance.now();
  const wall = Date.now();
  // also when the wall clock moved apart from the monotonic one by over a minute (a device asleep: some engines pause
  // performance.now() then; a clock set by hand)
  if (now - zoneAt > 60_000 || Math.abs(wall - wallAt - (now - zoneAt)) > 60_000) {
    zoneAt = now;
    wallAt = wall;
    try {
      zone = new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    } catch {
      zone = "";
    }
  }
  return zone;
}
/** Look at the system zone again on the next format (tests; a caller that knows the zone changed). */
export function recheckZone(): void {
  zoneAt = Number.NEGATIVE_INFINITY;
}
function dtf(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const loc = typeof navigator !== "undefined" ? (navigator.languages ?? []).join(",") : "";
  const k = `${key}|${loc}|${currentZone()}`;
  let f = cache.get(k);
  if (!f) {
    const z = k.slice(k.lastIndexOf("|") + 1);
    f = new Intl.DateTimeFormat([], z ? { ...opts, timeZone: z } : opts);
    cache.set(k, f);
  }
  return f;
}
/** = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) */
export const shortTimeSystem = (d: Date): string => dtf("t", { hour: "numeric", minute: "2-digit" }).format(d);
/** = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }) */
export const fullDay = (d: Date): string => dtf("fd", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(d);
/** = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) */
export const fullTimeSystem = (d: Date): string => dtf("ft", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(d);
