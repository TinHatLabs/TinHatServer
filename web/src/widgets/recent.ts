// recent.ts — the rules the Pinned and Mentions widgets share (contract WIDGETS.md §11–§12, vectors
// testvectors/widgets/recent/*): which pins show and in which order, the one-line snippet of a message, the Small
// summaries, and which form a row's time takes. Pure: no DOM, no React, no locale — the apps render a "clock" form with
// their own clock-mode formatter (the rest of the app's times) and every other form from the fields returned here.
// The desktop's Rust port (crates/widgets/src/recent.rs) runs the same vectors, so every rule is byte-level: strings
// are cut in code points, whitespace is ASCII only.

/** At most this many pin ids are read (a room with more shows the newest). */
export const PIN_MAX = 100;
/** A snippet is cut to this many code points ("…" appended when cut). */
export const SNIPPET_MAX = 140;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isWs = (c: string) => c === " " || (c >= "\t" && c <= "\r");

/**
 * `m.room.pinned_events` content → the pinned event ids, the most recently pinned first. The list's END is the newest
 * pin (clients append), so it is read backwards; an id that appears twice keeps its later (newer) place; only strings
 * starting with "$" count; at most PIN_MAX ids.
 */
export function pinOrder(content: unknown): string[] {
  const list = isObj(content) && Array.isArray(content.pinned) ? content.pinned : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = list.length - 1; i >= 0 && out.length < PIN_MAX; i--) {
    const id = list[i];
    if (typeof id !== "string" || !id.startsWith("$") || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---- the snippet ----------------------------------------------------------------------------------------------------

export type SnippetKind = "text" | "image" | "video" | "audio" | "voice" | "file" | "sticker" | "location" | "poll" | "encrypted" | "deleted" | "other";

export interface Snippet {
  kind: SnippetKind;
  /** one line, ASCII whitespace collapsed, ≤ SNIPPET_MAX code points (+ "…") */
  text: string;
}

/**
 * The reply fallback a reply's `body` starts with (`> <@a:hs> quoted…` lines, then an empty line) is dropped: the
 * leading lines that start with "> " (or are exactly ">") go, and — when at least one went — the next line too when it
 * holds only ASCII whitespace. Lines are split on "\n" only.
 */
export function stripReplyFallback(s: string): string {
  const lines = s.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.startsWith("> ") || lines[i] === ">")) i++;
  if (i > 0 && i < lines.length && [...lines[i]!].every(isWs)) i++;
  return lines.slice(i).join("\n");
}

/** ASCII whitespace runs → one space, trimmed, cut to `max` code points (a space left at the cut goes; + "…" when cut). */
export function oneLine(s: string, max = SNIPPET_MAX): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of s) {
    if (isWs(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  const cps = [...out];
  if (cps.length <= max) return out;
  const cut = cps.slice(0, max).join("");
  return (cut.endsWith(" ") ? cut.slice(0, -1) : cut) + "…";
}

/**
 * A message as the timeline holds it after decryption → its row snippet:
 *   redacted → deleted "Message deleted" · still `m.room.encrypted` (no key) → encrypted "Encrypted message" ·
 *   `m.sticker` → sticker (its body, else "Sticker") · `m.room.message` by msgtype: m.image / m.video / m.file → the
 *   file name (`filename`, else `body`; else "Image" / "Video" / "File"), m.audio → voice "Voice message" when it
 *   carries `org.matrix.msc3245.voice`, else audio + the file name ("Audio"), m.location → "Location", anything else
 *   (m.text, m.notice, m.emote, unknown) → text = the body without its reply fallback, or other "Message" when that is
 *   empty · `m.poll.start` / `org.matrix.msc3381.poll.start` → poll "Poll" · any other type → other (its body, else
 *   "Message"). Every text goes through oneLine().
 */
export function snippetOf(ev: { type?: unknown; content?: unknown; redacted?: unknown }): Snippet {
  const type = str(ev.type);
  const c = isObj(ev.content) ? ev.content : {};
  if (ev.redacted === true) return { kind: "deleted", text: "Message deleted" };
  if (type === "m.room.encrypted") return { kind: "encrypted", text: "Encrypted message" };
  const body = oneLine(str(c.body));
  if (type === "m.sticker") return { kind: "sticker", text: body || "Sticker" };
  if (type === "m.poll.start" || type === "org.matrix.msc3381.poll.start") return { kind: "poll", text: "Poll" };
  if (type !== "m.room.message") return body ? { kind: "other", text: body } : { kind: "other", text: "Message" };
  const file = oneLine(str(c.filename)) || body;
  switch (str(c.msgtype)) {
    case "m.image":
      return { kind: "image", text: file || "Image" };
    case "m.video":
      return { kind: "video", text: file || "Video" };
    case "m.file":
      return { kind: "file", text: file || "File" };
    case "m.audio":
      return c["org.matrix.msc3245.voice"] !== undefined ? { kind: "voice", text: "Voice message" } : { kind: "audio", text: file || "Audio" };
    case "m.location":
      return { kind: "location", text: "Location" };
    default: {
      const t = oneLine(stripReplyFallback(str(c.body)));
      return t ? { kind: "text", text: t } : { kind: "other", text: "Message" };
    }
  }
}

// ---- the Small summaries --------------------------------------------------------------------------------------------

/** Pinned, Small / collapsed: "No pins" · "1 pin · <latest>" · "3 pins · latest: <latest>" (latest = the newest pin's
 *  snippet text; "" while it loads → just the count). */
export function pinSummary(count: number, latest: string): string {
  if (count <= 0) return "No pins";
  const n = count === 1 ? "1 pin" : `${count} pins`;
  if (!latest) return n;
  return count === 1 ? `${n} · ${latest}` : `${n} · latest: ${latest}`;
}

// ---- a row's time ---------------------------------------------------------------------------------------------------

export type WhenForm = "clock" | "yesterday" | "weekday" | "date" | "dateYear";

export interface When {
  form: WhenForm;
  /** the local calendar fields of `ts` (weekday 0 = Sunday, month 0 = January) */
  weekday: number;
  day: number;
  month: number;
  year: number;
}

/** Local calendar fields of `ms` in a zone `offsetMin` minutes ahead of UTC (proleptic Gregorian, no leap seconds). */
function civil(ms: number, offsetMin: number): { days: number; weekday: number; day: number; month: number; year: number } {
  const days = Math.floor((ms + offsetMin * MINUTE_MS) / DAY_MS);
  // days since 1970-01-01 → y/m/d (H. Hinnant's civil_from_days)
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 2 : mp - 10;
  const year = yoe + era * 400 + (month <= 1 ? 1 : 0);
  const weekday = (((days + 4) % 7) + 7) % 7;
  return { days, weekday, day, month, year };
}

/**
 * Which form a past row time takes, in the viewer's zone (`offsetMin` = minutes ahead of UTC now): the same local day
 * as `now` → clock (the app's clock-mode time); the day before → yesterday ("Yesterday"); 2–6 days before → weekday
 * ("Sat"); earlier this year → date ("Sep 3"); another year → dateYear ("Sep 3, 2025"). A time after `now` (a skewed
 * clock) counts as today.
 */
export function whenOf(ts: number, now: number, offsetMin: number): When {
  const a = civil(ts, offsetMin);
  const b = civil(now, offsetMin);
  const ago = b.days - a.days;
  const form: WhenForm = ago <= 0 ? "clock" : ago === 1 ? "yesterday" : ago < 7 ? "weekday" : a.year === b.year ? "date" : "dateYear";
  return { form, weekday: a.weekday, day: a.day, month: a.month, year: a.year };
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The label of a When; `clock` = the app's clock-mode text of the time (only used by the clock form). */
export function whenLabel(w: When, clock: string): string {
  switch (w.form) {
    case "clock":
      return clock;
    case "yesterday":
      return "Yesterday";
    case "weekday":
      return WEEKDAYS[w.weekday]!;
    case "date":
      return `${MONTHS[w.month]} ${w.day}`;
    default:
      return `${MONTHS[w.month]} ${w.day}, ${w.year}`;
  }
}
