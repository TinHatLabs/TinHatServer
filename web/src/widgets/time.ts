// time.ts — the Up next widget's clock maths and the widgets' time labels (contract WIDGETS.md §4 + WIDGETS-UI.md;
// vectors testvectors/widgets/{ring,labels,upnext}.json): the countdown ring, the event phases, which events show, and
// the duration / "in …" / "… ago" labels every widget uses. Pure, integer maths, no locale (wall-clock times like
// "7:30 PM" are the apps' clock-mode formatters and are not in the vectors).

export const MINUTE_MS = 60_000;
export const DAY_MINUTES = 1440;
/** The ring fills over the last 24 h before the start. */
export const RING_MINUTES = DAY_MINUTES;
/** "Starting soon" (accent edge + Join) from 10 minutes before the start. */
export const SOON_MINUTES = 10;

export type Phase = "later" | "today" | "soon" | "live" | "over";

export interface Ring {
  phase: Phase;
  /** whole minutes to the start, rounded up (0 once it has started) */
  minutesLeft: number;
  /** the ring's filled part in minutes of RING_MINUTES (0 … 1440): the angle is fill / 1440 × 360°, from 12 o'clock
   *  clockwise */
  fill: number;
  /** when the ring / phase / label next change (the one timer to arm), null when nothing will */
  nextAt: number | null;
}

/**
 * The countdown of an event that runs [start, end): later (> 24 h ahead) → today (≤ 24 h: the ring fills a minute at a
 * time) → soon (≤ 10 min) → live (started) → over (ended). The ring ticks once a minute: nextAt is the next minute
 * boundary before the start (start − (minutesLeft − 1) min), then the end.
 */
export function ringOf(start: number, end: number, now: number): Ring {
  if (now >= end) return { phase: "over", minutesLeft: 0, fill: RING_MINUTES, nextAt: null };
  if (now >= start) return { phase: "live", minutesLeft: 0, fill: RING_MINUTES, nextAt: end };
  const m = Math.ceil((start - now) / MINUTE_MS);
  const fill = RING_MINUTES - Math.min(m, RING_MINUTES);
  const phase: Phase = m <= SOON_MINUTES ? "soon" : m <= RING_MINUTES ? "today" : "later";
  return { phase, minutesLeft: m, fill, nextAt: start - (m - 1) * MINUTE_MS };
}

// ---- labels ---------------------------------------------------------------------------------------------------------

/** "< 1 m", "45 m", "2 h", "2 h 10 m", "1 d", "1 d 4 h" (floored to the minute). */
export function fmtDur(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (m < 1) return "< 1 m";
  return spell(m);
}

function spell(m: number): string {
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h} h ${mm} m` : `${h} h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

/** Time until something: "now" (≤ 0), "in 1 m" … "in 59 m", "in 2 h 10 m", "in 1 d 4 h" (minutes rounded UP, so the
 *  label never says "in 0 m" before the start). */
export function fmtUntil(ms: number): string {
  if (ms <= 0) return "now";
  return `in ${spell(Math.ceil(ms / MINUTE_MS))}`;
}

/** Time since something: "just now" (< 1 min), "12 m ago", "3 h ago", "2 d ago", "3 w ago" (floored). */
export function fmtAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (m < 1) return "just now";
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return `${Math.floor(d / 7)} w ago`;
}

// ---- which events Up next shows -------------------------------------------------------------------------------------

export interface UpNextItem {
  /** calendar container (space or room id) */
  container: string;
  /** event id (state key) */
  id: string;
  kind: string;
  /** effective start / end (the calendar's effectiveStart / effectiveEnd: end = start + 3 h when unset) */
  start: number;
  end: number;
  canceled: boolean;
}

/**
 * The events Up next lists, in order: not cancelled, not the "focus" kind (Main game), start > 0, not over (end > now),
 * starting before now + `days` days; sorted by start, end, container, id (code-point order); the first `max` (0 = all).
 * M shows 3, S the first, L all of them (the widget's `days` setting, 1–14, default 7).
 */
export function selectUpNext(items: readonly UpNextItem[], now: number, days: number, max: number): UpNextItem[] {
  const horizon = now + Math.max(1, Math.min(14, Math.floor(days))) * DAY_MINUTES * MINUTE_MS;
  const keep = items.filter((e) => !e.canceled && e.kind !== "focus" && e.start > 0 && e.end > now && e.start < horizon);
  keep.sort((a, b) => a.start - b.start || a.end - b.end || cmp(a.container, b.container) || cmp(a.id, b.id));
  return max > 0 ? keep.slice(0, max) : keep;
}

function cmp(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    if (xs !== ys) return xs ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
