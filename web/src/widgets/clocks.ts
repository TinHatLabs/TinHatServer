// clocks.ts — Friends' clocks' rules (contract WIDGETS.md §15, vectors testvectors/widgets/clocks/*): the rows (who,
// in which order, whose row is yours, day or night, another day), the header's spread ("PT · ET +3 h"), the zone
// labels, and the automatic time-zone writes (opt-out since 2026-09-28: sharing starts ON). Pure: the apps turn
// an IANA zone into its current UTC offset with their own time-zone data (web Intl, desktop QTimeZone) and format a
// time with their own clock-mode formatter; everything else is here, and the desktop's Rust port
// (crates/widgets/src/clocks.rs) runs the same vectors.
import { cmpPeople } from "./people";

export const TZ_TYPE = "dev.tinhat.presence_tz";
const MINUTE_MS = 60_000;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const DAY_MIN = 1440;
/** An automatic zone write at most this often per device. */
export const TZ_WRITE_GAP_MS = 10 * MINUTE_MS;

/** The short labels of common zones; any other zone reads as its city ("Buenos Aires"). */
export const ZONE_LABELS: Readonly<Record<string, string>> = {
  "Pacific/Honolulu": "HST",
  "America/Anchorage": "AKT",
  "America/Los_Angeles": "PT",
  "America/Vancouver": "PT",
  "America/Tijuana": "PT",
  "America/Denver": "MT",
  "America/Edmonton": "MT",
  "America/Phoenix": "MST",
  "America/Chicago": "CT",
  "America/Winnipeg": "CT",
  "America/Mexico_City": "CST",
  "America/New_York": "ET",
  "America/Toronto": "ET",
  "America/Detroit": "ET",
  "America/Halifax": "AT",
  "America/Sao_Paulo": "BRT",
  "Europe/London": "UK",
  "Europe/Dublin": "IE",
  "Europe/Lisbon": "WET",
  "Europe/Paris": "CET",
  "Europe/Berlin": "CET",
  "Europe/Madrid": "CET",
  "Europe/Rome": "CET",
  "Europe/Amsterdam": "CET",
  "Europe/Stockholm": "CET",
  "Europe/Warsaw": "CET",
  "Europe/Athens": "EET",
  "Europe/Helsinki": "EET",
  "Europe/Moscow": "MSK",
  "Asia/Dubai": "GST",
  "Asia/Kolkata": "IST",
  "Asia/Singapore": "SGT",
  "Asia/Manila": "PHT",
  "Asia/Shanghai": "CST",
  "Asia/Tokyo": "JST",
  "Asia/Seoul": "KST",
  "Australia/Perth": "AWST",
  "Australia/Sydney": "AET",
  "Australia/Melbourne": "AET",
  "Pacific/Auckland": "NZT",
  UTC: "UTC",
  "Etc/UTC": "UTC",
};

/** The zones the manual picker offers (both apps, this order; "Automatic" = the device's zone comes first). */
export const ZONE_CHOICES: readonly string[] = Object.keys(ZONE_LABELS).filter((z) => z !== "Etc/UTC");

/** An IANA-shaped zone name the server accepts (presence.mjs TZ_RE, ≤ 64 characters): "UTC", "Area/City",
 *  "Area/Sub/City" — ASCII letters, digits, "_", "+", "-". */
export function validZone(tz: unknown): tz is string {
  return typeof tz === "string" && tz.length <= 64 && /^(UTC|[A-Za-z][A-Za-z0-9_+-]{0,30}(\/[A-Za-z0-9_+-]{1,30}){1,2})$/.test(tz);
}

/** `GET /api/presence?tz=1`'s answer → mxid → zone for every row with a valid `tz` (a row may carry a zone and no
 *  state: time-zone sharing is separate from presence). Other rows and malformed input → nothing. */
export function zonesOf(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const users = isObj(body) ? body.users : undefined;
  if (!isObj(users)) return out;
  for (const mxid of Object.keys(users).sort()) {
    const row = users[mxid];
    if (!mxid.startsWith("@") || !mxid.includes(":") || !isObj(row) || !validZone(row.tz)) continue;
    out[mxid] = row.tz;
  }
  return out;
}

/** A zone's short label: the table's; "Etc/GMT+10" (POSIX sign, 10 h BEHIND) → "UTC−10"; else its last part with
 *  "_" as spaces, runs of spaces as one, no space at either end ("America/Argentina/Buenos_Aires" → "Buenos Aires"); else the zone
 *  as written. */
export function zoneLabel(tz: string): string {
  if (Object.prototype.hasOwnProperty.call(ZONE_LABELS, tz)) return ZONE_LABELS[tz]!;
  const etc = /^Etc\/GMT([+-])(\d{1,2})$/.exec(tz);
  if (etc) return etc[2] === "0" ? "UTC" : `UTC${etc[1] === "+" ? "\u2212" : "+"}${Number(etc[2])}`;
  const last = (tz.split("/").pop() ?? "").replace(/_/g, " ").replace(/ +/g, " ").replace(/^ | $/g, "");
  return last || tz;
}

/** A picker entry: "PT · America/Los_Angeles" (a label equal to the zone shows once: "UTC"). */
export function zoneChoiceText(tz: string): string {
  const l = zoneLabel(tz);
  return l === tz ? tz : `${l} · ${tz}`;
}

/** A difference in minutes as "+6 h", "−3 h", "+5 h 30 m", "+45 m", "±0 h" (U+2212 for minus). */
export function fmtOffset(diffMin: number): string {
  const d = Math.trunc(diffMin);
  if (d === 0) return "±0 h";
  const sign = d > 0 ? "+" : "−";
  const a = Math.abs(d);
  const h = Math.floor(a / 60);
  const m = a % 60;
  if (!h) return `${sign}${m} m`;
  return m ? `${sign}${h} h ${m} m` : `${sign}${h} h`;
}

/** Local minutes of the day (0…1439) of `now` in a zone `offsetMin` minutes ahead of UTC. */
export function localMinutes(now: number, offsetMin: number): number {
  const m = Math.floor((now + offsetMin * MINUTE_MS) / MINUTE_MS);
  return ((m % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/** Night = 22:00 to 07:00 local (a moon), day otherwise (a sun). */
export function isNight(localMin: number): boolean {
  return localMin >= 22 * 60 || localMin < 7 * 60;
}

/** Days since 1970-01-01 of `now` in a zone `offsetMin` ahead of UTC. */
function localDay(now: number, offsetMin: number): number {
  return Math.floor((now + offsetMin * MINUTE_MS) / (DAY_MIN * MINUTE_MS));
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface ClockPerson {
  id: string;
  name: string;
  tz: string;
  /** the zone's current offset from UTC in minutes (the app's time-zone data); null = the app doesn't know the zone */
  offsetMin: number | null;
}

export interface ClockRow {
  id: string;
  tz: string;
  label: string;
  offsetMin: number;
  /** HH·60 + MM local */
  minutes: number;
  night: boolean;
  me: boolean;
  /** the weekday ("Tue") when the local date is not the viewer's, else "" */
  day: string;
  /** the offset from the viewer's zone ("+6 h"; "" on the viewer's own row) */
  diff: string;
}

/**
 * The rows: every person whose zone the app knows (offsetMin a finite number), each id once (the first), sorted by
 * offset (west first), then the shared people order (cmpPeople); the viewer's own row (`me`) is marked. `myOffsetMin` =
 * the viewer's zone (the zone they share, else the device's). A row's weekday shows when its local date differs from
 * the viewer's.
 */
export function clockRows(people: readonly ClockPerson[], me: string, myOffsetMin: number, now: number): ClockRow[] {
  const seen = new Set<string>();
  const keep: ClockPerson[] = [];
  for (const p of people) {
    if (seen.has(p.id) || typeof p.offsetMin !== "number" || !Number.isFinite(p.offsetMin)) continue;
    seen.add(p.id);
    keep.push(p);
  }
  keep.sort((a, b) => a.offsetMin! - b.offsetMin! || cmpPeople(a, b));
  const myDay = localDay(now, myOffsetMin);
  return keep.map((p) => {
    const off = Math.trunc(p.offsetMin!);
    const minutes = localMinutes(now, off);
    const day = localDay(now, off);
    return {
      id: p.id,
      tz: p.tz,
      label: zoneLabel(p.tz),
      offsetMin: off,
      minutes,
      night: isNight(minutes),
      me: p.id === me,
      day: day === myDay ? "" : WEEKDAYS[(((day + 4) % 7) + 7) % 7]!,
      diff: p.id === me ? "" : fmtOffset(off - myOffsetMin),
    };
  });
}

/**
 * The header's spread: the viewer's zone label, then the zone furthest from it (largest |difference|; ties: the one
 * that comes later in row order) with the difference — "PT · ET +3 h". Nobody elsewhere → "<label> · everyone here";
 * no rows at all → the viewer's label alone.
 */
export function spreadLabel(rows: readonly ClockRow[], myTz: string, myOffsetMin: number): string {
  const mine = zoneLabel(myTz);
  let best: ClockRow | null = null;
  let bestAbs = 0;
  for (const r of rows) {
    const a = Math.abs(r.offsetMin - myOffsetMin);
    if (a > 0 && a >= bestAbs) {
      best = r;
      bestAbs = a;
    }
  }
  if (best) return `${mine} · ${best.label} ${fmtOffset(best.offsetMin - myOffsetMin)}`;
  return rows.some((r) => !r.me) ? `${mine} · everyone here` : mine;
}

// ---- the account data (opt-out: sharing starts on) -----------------------------------------------------------------

export interface TzPref {
  share: boolean;
  tz: string;
  /** follow the device's zone (never picked by hand) */
  auto: boolean;
  v: 1;
}

/** The stored `dev.tinhat.presence_tz` → a clean pref, or null when absent / not an object / no string zone. */
export function readTzPref(v: unknown): TzPref | null {
  if (!isObj(v) || typeof v.tz !== "string" || !v.tz) return null;
  return { share: v.share === true, tz: v.tz, auto: v.auto !== false, v: 1 };
}

/**
 * What this device writes when it starts or comes back to the foreground (2026-09-28: the zone is not secret
 * among friends — opt-out):
 *   nothing stored (absent, null or `{}`: a first run) → `{share: true, tz: device, auto: true, v: 1}`;
 *   stored, sharing, automatic, another zone than the device's and this device's last automatic write ≥ 10 min ago →
 *   the same pref with the device's zone (so with two devices in two zones, the one used last wins);
 *   anything else (switched off, picked by hand, the same zone, too soon, a value this app can't read) → null.
 * A `deviceTz` the server wouldn't accept ("" = unknown) never writes.
 */
export function tzAutoWrite(stored: unknown, deviceTz: string, now: number, lastWriteAt: number | null): TzPref | null {
  if (!validZone(deviceTz)) return null;
  const absent = stored === undefined || stored === null || (isObj(stored) && Object.keys(stored).length === 0);
  if (absent) return { share: true, tz: deviceTz, auto: true, v: 1 };
  const p = readTzPref(stored);
  if (!p || !p.share || !p.auto || p.tz === deviceTz) return null;
  if (lastWriteAt !== null && now - lastWriteAt < TZ_WRITE_GAP_MS) return null;
  return { share: true, tz: deviceTz, auto: true, v: 1 };
}
