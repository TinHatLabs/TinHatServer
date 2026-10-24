// model/calendar.ts — pure calendar helpers (port of the helper functions in CalendarWindow.qml,
// CalendarCard.qml and calendar.rs): date keys, the Qt-format date/time strings, relative days,
// the "when" lines, kind labels/hints/colours, slugify/autoColor, effective start/end, the chat
// card's markdown + its HTML (ruma text_markdown) and the notification wording.
// Everything renders in the READER's zone (the browser's), exactly like the native.

export const EVENT_TYPE = "dev.tinhat.calendar.event";
export const RSVP_TYPE = "dev.tinhat.calendar.rsvp";
export const GAME_TYPE = "dev.tinhat.calendar.game";
export const CARD_KEY = "dev.tinhat.calendar";
export const DEFAULT_DURATION_MS = 3 * 3600_000;
export const RSVP_PRUNE_MS = 30 * 24 * 3600_000;
export const DAY_MS = 86400000;

export type Kind = "session" | "milestone" | "freeplay" | "proposal" | "cooloff" | "focus";
export const KINDS: Array<{ k: Kind; label: string }> = [
  { k: "session", label: "Group session" },
  { k: "milestone", label: "Progression" },
  { k: "freeplay", label: "Free play" },
  { k: "proposal", label: "Proposal" },
  { k: "cooloff", label: "Cool-off" },
  { k: "focus", label: "Main game" },
];

export const DURATIONS: Array<{ label: string; m: number }> = [
  { label: "30 min", m: 30 },
  { label: "1 hour", m: 60 },
  { label: "1½ hours", m: 90 },
  { label: "2 hours", m: 120 },
  { label: "3 hours", m: 180 },
  { label: "4 hours", m: 240 },
  { label: "5 hours", m: 300 },
  { label: "Open-ended", m: 0 },
];
export function durationIndex(mins: number): number {
  const i = DURATIONS.findIndex((d) => d.m === mins);
  return i >= 0 ? i : 4;
}

/** The 8 colour choices (also the Rust auto colour palette, same order). */
export const COLOR_CHOICES = ["#7cc4ff", "#ffb347", "#8ee08e", "#ff7c9c", "#c39bff", "#ffd75e", "#5ee0d0", "#ff9e6b"];

// ---- people / events as the UI uses them (calendar.rs build_snapshot JSON) -------------------

export interface Person {
  mxid: string;
  name: string;
  /** mxc:// (or "") */
  avatar: string;
}

export interface CalOption {
  start: number;
  end: number;
  votes: Person[];
}

export interface CalEvent {
  id: string;
  title: string;
  game: string;
  gameColor: string;
  kind: Kind | string;
  start: number;
  end: number;
  effStart: number;
  effEnd: number;
  allDay: boolean;
  notes: string;
  rules: string;
  freePlay: boolean;
  joinIfYouCan: boolean;
  options: CalOption[];
  chosen: number;
  createdBy: string;
  creator: Person;
  createdAt: number;
  updatedAt: number;
  canceled: boolean;
  hasCard: boolean;
  announce: { room?: string; event?: string; by?: string } | null;
  gameId: string;
  past: boolean;
  canEdit: boolean;
  rsvp: { yes: Person[]; no: Person[]; maybe: Person[] };
  my: { status: string; options: number[] };
  /** the raw state content (read-modify-write paths keep unknown keys) */
  raw: Record<string, unknown>;
}

export interface CalGame {
  slug: string;
  name: string;
  color: string;
  rules: string;
  server: string;
  catalogId?: string;
}

// ---- date keys (always local getters, never UTC fields) -------------------------------------

export const pad2 = (n: number) => (n < 10 ? "0" : "") + n;
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const dayKeyOf = (ms: number) => dayKey(new Date(ms));
export function keyToDate(key: string, minutes?: number): Date {
  const p = String(key).split("-");
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0, 0);
  if (minutes !== undefined) d.setMinutes(minutes);
  return d;
}
export function validKey(key: string): boolean {
  const p = String(key).split("-");
  if (p.length !== 3) return false;
  const d = keyToDate(key);
  return !isNaN(d.getTime()) && d.getMonth() === Number(p[1]) - 1;
}
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// ---- Qt date/time formats (C / en locale) ----------------------------------------------------

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "h:mm AP" → "7:00 PM" */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
export const fmtMinutes = (m: number) => fmtTime(new Date(2000, 0, 1, Math.floor(m / 60), m % 60).getTime());
/** "ddd, MMM d" → "Wed, Sep 23" */
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${DOW[d.getDay()].slice(0, 3)}, ${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}
/** "dddd, MMMM d" → "Wednesday, September 23" */
export function fmtDayLong(ms: number): string {
  const d = new Date(ms);
  return `${DOW[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}`;
}
/** "dddd, MMM d" → "Wednesday, Sep 23" (header chip tooltip) */
export function fmtDayLongMonShort(ms: number): string {
  const d = new Date(ms);
  return `${DOW[d.getDay()]}, ${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}
/** "ddd" */
export const fmtDow = (ms: number) => DOW[new Date(ms).getDay()].slice(0, 3);
/** "MMMM yyyy" */
export const fmtMonthYear = (y: number, m: number) => `${MON[m]} ${y}`;
/** "MMM d" */
export const fmtMonDay = (ms: number) => `${MON[new Date(ms).getMonth()].slice(0, 3)} ${new Date(ms).getDate()}`;
/** Reel: "ddd d MMM" → "Wed 23 Sep" */
export const fmtReelDay = (ms: number) => `${DOW[new Date(ms).getDay()].slice(0, 3)} ${new Date(ms).getDate()} ${MON[new Date(ms).getMonth()].slice(0, 3)}`;
/** Reel log: "d MMM" → "23 Sep" */
export const fmtDMon = (ms: number) => `${new Date(ms).getDate()} ${MON[new Date(ms).getMonth()].slice(0, 3)}`;
/** Month chip time: "7:00 PM" → "7pm", "7:30 PM" → "7:30pm" */
export const chipTime = (ms: number) => fmtTime(ms).replace(":00", "").replace(" ", "").toLowerCase();
export const DOW_SHORT = DOW.map((d) => d.slice(0, 3));

/** Zone abbreviation OF THAT MOMENT ("EDT in July even when planned in March", TH-CAL-07). */
export function tz(ms?: number): string {
  const at = ms !== undefined && ms > 0 ? ms : Date.now();
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

/** Locale week start (0 = Sunday). Qt's C locale → Sunday; the browser locale's weekInfo when known. */
export function weekStart(): number {
  try {
    const L = Intl.Locale as unknown as new (s: string) => { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } };
    const loc = new L(navigator.language || "en-US");
    const wi = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (wi && wi.firstDay) return wi.firstDay % 7;
  } catch {
    /* default */
  }
  return 0;
}

export function relDay(ms: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(new Date(ms)) - startOfDay(new Date(now))) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return `In ${diff} days`;
  if (diff < -1 && diff > -7) return `${-diff} days ago`;
  return "";
}

type WhenEv = Pick<CalEvent, "effStart" | "effEnd" | "start" | "end" | "kind" | "options" | "chosen">;

export function whenLine(ev: WhenEv | null | undefined): string {
  if (!ev || !ev.effStart) return "Time to be decided";
  if (ev.kind === "focus") return fmtDay(ev.effStart) + " – " + fmtDay(ev.end || ev.effStart);
  const s = ev.effStart;
  const e = ev.end || 0;
  let line = fmtDay(s) + " · " + fmtTime(s);
  if (e > s) line += " – " + fmtTime(e);
  const r = relDay(s);
  return r ? `${r} · ${line}` : line;
}

/** The chat card's "when" for an existing event (`chosenIndex` overrides for lock/unlock). */
export function whenTextFor(ev: WhenEv | null | undefined, chosenIndex?: number): string {
  if (!ev) return "";
  const opts = ev.options || [];
  if (ev.kind === "focus") return fmtDay(ev.effStart || ev.start) + " – " + fmtDay(ev.effEnd || ev.end);
  let start = ev.start || 0;
  let end = ev.end || 0;
  if (chosenIndex !== undefined) {
    if (chosenIndex >= 0 && opts[chosenIndex]) {
      start = opts[chosenIndex].start;
      end = opts[chosenIndex].end || 0;
    } else if (chosenIndex < 0) {
      start = 0;
      end = 0;
    }
  }
  if (start > 0) return fmtDay(start) + " · " + fmtTime(start) + (end > start ? " – " + fmtTime(end) : "") + " " + tz(start);
  return "vote for a time: " + opts.map((o) => fmtDay(o.start) + " " + fmtTime(o.start)).join(" / ") + " " + tz();
}

/** CalendarCard.qml fmtWhen */
export function cardWhen(ev: WhenEv): string {
  if (ev.kind === "focus") return fmtMonDay(ev.effStart) + " – " + fmtMonDay(ev.effEnd);
  if (ev.kind === "proposal" && ev.chosen < 0) {
    const n = (ev.options || []).length;
    return n > 0 ? `Vote for a time — ${n} option${n === 1 ? "" : "s"}` : "Vote for a time";
  }
  if (!ev.effStart) return "";
  const s = ev.effStart;
  return fmtDay(s) + " · " + fmtTime(s) + (ev.end && ev.end > s ? " – " + fmtTime(ev.end) : "") + " " + tz(s);
}

// ---- kinds -------------------------------------------------------------------------------------

export function kindLabel(k: string): string {
  switch (k) {
    case "freeplay":
      return "Free play";
    case "milestone":
      return "Scheduled progression";
    case "proposal":
      return "Proposal";
    case "cooloff":
      return "Cool-off game";
    case "focus":
      return "Main game";
    default:
      return "Group session";
  }
}
export function kindHint(k: string): string {
  switch (k) {
    case "freeplay":
      return "Play whenever — no need to be there";
    case "milestone":
      return "A boss run, a story beat — join if you can";
    case "proposal":
      return "Offer a few times, everyone votes, you lock one in";
    case "cooloff":
      return "A lighter game between the main ones";
    case "focus":
      return "The game we're on for a while — colours those days on the calendar";
    default:
      return "The squad plays together at a set time";
  }
}
/** CSS colour (token var) of a kind */
export function kindColor(k: string): string {
  switch (k) {
    case "freeplay":
      return "var(--th-calendar-kind-freeplay-fill)";
    case "milestone":
      return "var(--th-calendar-kind-milestone-fill)";
    case "cooloff":
      return "var(--th-calendar-kind-cooloff-fill)";
    default:
      return "var(--th-calendar-kind-session-fill)";
  }
}
export const chipColor = (ev: Pick<CalEvent, "gameColor" | "kind">) => (ev.gameColor ? ev.gameColor : kindColor(ev.kind));
/** CSS colour with alpha (tint(c, a)) — works for hex literals AND var(--th-*) tokens. */
export const tint = (c: string, a: number) => `color-mix(in srgb, ${c} ${Math.round(a * 1000) / 10}%, transparent)`;

/** Card + announce kind label (calendar.rs announce_text / CalendarCard kindLabel). */
export function cardKindLabel(kind: string, chosen: number): string {
  switch (kind) {
    case "freeplay":
      return "Free play";
    case "milestone":
      return "Scheduled progression — join if you can";
    case "proposal":
      return chosen >= 0 ? "Time locked in" : "Proposal — vote for a time";
    case "cooloff":
      return "Cool-off game";
    case "focus":
      return "Main game";
    default:
      return "Group session";
  }
}

// ---- slug + colour -----------------------------------------------------------------------------

export function slugify(name: string): string {
  let out = "";
  let dash = false;
  for (const c of name.trim()) {
    if (/^[A-Za-z0-9]$/.test(c)) {
      out += c.toLowerCase();
      dash = false;
    } else if (!dash && out) {
      out += "-";
      dash = true;
    }
  }
  out = out.replace(/-+$/, "");
  return out || "game";
}

export function autoColor(slug: string): string {
  let h = 0;
  for (const b of new TextEncoder().encode(slug)) h = (Math.imul(h, 31) + b) >>> 0;
  return COLOR_CHOICES[h % COLOR_CHOICES.length];
}

// ---- effective start / end ---------------------------------------------------------------------

const u64 = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

export function effectiveStart(c: Record<string, unknown>): number {
  const start = u64(c.start);
  if (start > 0) return start;
  let min = 0;
  if (Array.isArray(c.options)) {
    for (const o of c.options) {
      const s = o && typeof o === "object" ? u64((o as Record<string, unknown>).start) : 0;
      if (s > 0 && (min === 0 || s < min)) min = s;
    }
  }
  return min;
}
export function effectiveEnd(c: Record<string, unknown>): number {
  const end = u64(c.end);
  if (end > 0) return end;
  const s = effectiveStart(c);
  return s === 0 ? 0 : s + DEFAULT_DURATION_MS;
}
export const isCanceled = (c: Record<string, unknown>) => c.canceled === true;

/** calendar.rs rel_when (notifications; no TZ). */
export function relWhen(start: number, now: number): string {
  if (start <= now) return "now";
  const mins = Math.floor((start - now) / 60000);
  if (mins < 60) return `in ${Math.max(mins, 1)} min`;
  if (mins < 36 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
  }
  return `in ${Math.floor((mins + 12 * 60) / (24 * 60))} days`;
}

// ---- the chat card message (calendar.rs announce_text / announce_content) ---------------------

export function announceText(content: Record<string, unknown>, when: string): string {
  const title = typeof content.title === "string" ? content.title : "";
  const game = typeof content.game === "string" ? content.game : "";
  const kind = typeof content.kind === "string" ? content.kind : "session";
  const canceled = isCanceled(content);
  let text = canceled ? `📅 ~~${title}~~ — **CANCELLED**` : `📅 **${title}**`;
  if (game) text += ` — ${game}`;
  const chosen = typeof content.chosen === "number" && Number.isInteger(content.chosen) ? content.chosen : -1;
  text += `\n${cardKindLabel(kind, chosen)}`;
  if (when) text += ` · ${when}`;
  if (content.freePlay === true && kind !== "freeplay") text += "\nFree play is allowed outside the session.";
  const notes = typeof content.notes === "string" ? content.notes : "";
  if (notes) text += "\n\n" + notes;
  if (!canceled) text += "\n\n_RSVP on the calendar (📅 in the room header)._";
  return text;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlineMd(s: string): string {
  let h = esc(s);
  h = h.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
  h = h.replace(/(^|[^\w])_([^_\n]+?)_(?=$|[^\w])/g, "$1<em>$2</em>");
  return h;
}

/**
 * The HTML ruma's `text_markdown` (pulldown-cmark, hard breaks) produces for the card text:
 * paragraphs split on blank lines → `<p>…</p>\n`, single newlines → `<br />\n`, `**`→strong,
 * `_`→em, `~~`→del. Matches the real card in tw-spec §4.4 byte for byte.
 */
export function markdownToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(inlineMd).join("<br />\n")}</p>\n`)
    .join("");
}

export function announceContent(text: string, cid: string, id: string): Record<string, unknown> {
  return {
    msgtype: "m.text",
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: markdownToHtml(text),
    [CARD_KEY]: { container: cid, event: id },
  };
}

/** calendar.rs friendly() */
export function friendly(e: unknown): string {
  const s = String((e as { message?: string })?.message ?? e);
  const code = String((e as { errcode?: string; data?: { errcode?: string } })?.errcode ?? (e as { data?: { errcode?: string } })?.data?.errcode ?? "");
  const http = String((e as { httpStatus?: number })?.httpStatus ?? "");
  if (code === "M_FORBIDDEN" || http === "403" || s.includes("M_FORBIDDEN") || s.includes("403"))
    return "You can't write to this calendar yet — ask a space admin to open the calendar once (that unlocks it for everyone)";
  if (code === "M_LIMIT_EXCEEDED" || http === "429" || s.includes("M_LIMIT_EXCEEDED") || s.includes("429")) return "Slow down a little — the server is rate-limiting";
  return `Couldn't save: ${s}`;
}

export const randHex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
