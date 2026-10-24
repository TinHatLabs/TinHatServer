// mentions.ts — the Mentions widget's list (contract WIDGETS.md §13, vectors testvectors/widgets/mentions/*): each app
// keeps, on this device only, the recent events its own push-rule evaluation highlighted (after decryption — so
// encrypted rooms count), as ids — never their text. These are the rules for that list: what a stored list may hold,
// adding, marking seen, and the Small line. Pure; the desktop's Rust port (crates/widgets/src/mentions.rs) runs the
// same vectors (strings in code-point order, numbers as doubles).

/** The list keeps the newest this many. */
export const MENTIONS_MAX = 50;

export interface Mention {
  /** room id */
  r: string;
  /** event id */
  e: string;
  /** sender */
  s: string;
  /** origin_server_ts (ms) */
  t: number;
  /** opened (clicked, or its room shown in this app since); absent = not yet */
  seen?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function cmpStr(a: string, b: string): number {
  // code-point order (= UTF-8 byte order), not UTF-16 units
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i]!.codePointAt(0)!;
    const q = y[i]!.codePointAt(0)!;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

/** Newest first: t descending, then e in code-point order. */
function order(a: Mention, b: Mention): number {
  return b.t - a.t || cmpStr(a.e, b.e);
}

/**
 * A stored value → a clean list: only objects whose `r` is a string starting with "!", `e` one starting with "$", `s` one
 * starting with "@" and `t` a finite number ≥ 0 (floored); `seen` is kept only when it is `true`; each event once (the
 * first occurrence in the input wins); newest first (t descending, then e); at most MENTIONS_MAX. Anything that is not
 * an array → [].
 */
export function normalizeMentions(v: unknown): Mention[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const { r, e, s, t } = x;
    if (typeof r !== "string" || !r.startsWith("!") || typeof e !== "string" || !e.startsWith("$") || typeof s !== "string" || !s.startsWith("@")) continue;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    const m: Mention = { r, e, s, t: Math.floor(t) };
    if (x.seen === true) m.seen = true;
    out.push(m);
  }
  out.sort(order);
  return out.slice(0, MENTIONS_MAX);
}

/** A new highlight: added unless the event is already listed (then the list is unchanged — its seen flag stays). */
export function addMention(list: readonly Mention[], m: Mention): Mention[] {
  if (list.some((x) => x.e === m.e)) return normalizeMentions(list);
  return normalizeMentions([...list, m]);
}

/**
 * Mark entries seen: `e` = that event; `r` = every entry of that room whose t ≤ `upTo` (the room was shown: what had
 * arrived by then is read); neither = every entry. Returns the normalized list.
 */
export function markSeen(list: readonly Mention[], sel: { e?: string; r?: string; upTo?: number } = {}): Mention[] {
  const hit = (m: Mention) =>
    sel.e !== undefined ? m.e === sel.e : sel.r !== undefined ? m.r === sel.r && (sel.upTo === undefined || m.t <= sel.upTo) : true;
  return normalizeMentions(list.map((m) => (hit(m) ? { ...m, seen: true } : m)));
}

export function unseenCount(list: readonly Mention[]): number {
  let n = 0;
  for (const m of list) if (m.seen !== true) n++;
  return n;
}

/**
 * The Small / collapsed line: nothing listed → "No mentions"; nothing unseen → "No new mentions"; else "1 new mention" /
 * "<n> new mentions" + " · <room>" — the room of the NEWEST unseen entry, by its name (`roomName(r)`; "" leaves the
 * " · …" out).
 */
export function mentionSummary(list: readonly Mention[], roomName: (r: string) => string): string {
  const all = normalizeMentions(list);
  if (!all.length) return "No mentions";
  const unseen = all.filter((m) => m.seen !== true);
  if (!unseen.length) return "No new mentions";
  const head = unseen.length === 1 ? "1 new mention" : `${unseen.length} new mentions`;
  const name = roomName(unseen[0]!.r);
  return name ? `${head} · ${name}` : head;
}
