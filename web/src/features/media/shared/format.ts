// format.ts — the media area's formatters (MemoriesWindow.qml / WatchPartyWindow.qml helpers).

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Memories fmtTime: `h:mm:ss` when ≥ 1 h else `m:ss` (floor, ≥ 0). */
export function fmtTime(secs: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(secs) ? secs : 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Watch party fmtTime: `m:ss` only (minutes unbounded). */
export function fmtMinSec(secs: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(secs) ? secs : 0));
  return `${Math.floor(t / 60)}:${pad2(t % 60)}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function hm12(d: Date): string {
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

/** "ddd MMM d · h:mm AP" → "Mon Aug 31 · 8:54 PM" (fixed 12-hour, not the clock pref). */
export function fmtDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${DAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()} · ${hm12(d)}`;
}

/** "dddd, MMMM d · h:mm AP" → "Monday, August 31 · 8:54 PM". */
export function fmtDateLong(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} · ${hm12(d)}`;
}

/** ≥1e9 → one decimal "GB" (none ≥1e10); ≥1e6 → round "MB"; >0 → max(1, round(/1e3)) "KB"; 0 → "". */
export function fmtBytes(b: number): string {
  if (!b || b <= 0) return "";
  if (b >= 1e10) return `${Math.round(b / 1e9)} GB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}

/** "@user:server[:DEVICE]" → "user". */
export function shortName(identity: string): string {
  const s = (identity ?? "").replace(/^@/, "");
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(0, i) : s;
}

/** "@user:server:DEVICE" → "@user:server". */
export function userIdOf(identity: string): string {
  const parts = (identity ?? "").split(":");
  if (parts.length >= 2 && parts[0].startsWith("@")) return `${parts[0]}:${parts[1]}`;
  return identity;
}

/** Strip HTML, collapse whitespace, ≤ 90 chars + "…" (MemoriesWindow shortError). */
export function shortError(e: unknown): string {
  let s = String((e as { message?: string })?.message ?? e ?? "");
  s = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/** Plural helper: n + singular/plural word. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
