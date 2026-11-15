// memories/photos.ts — Memories photos: the shared core (docs/MEMORIES-PHOTOS.md §3–§4).
// The desktop's crates/widgets/src/memphotos.rs is a line-for-line port; both replay
// testvectors/memories-photos/vectors.json (a byte-identical copy in both repos). Pure: no SDK, no I/O.
//
// A Memories photo is a normal image message in the room (encrypted where the room is). The reference is the room
// state `dev.tinhat.memories` keyed by the WRITER's own user id (Matrix rejects an "@" state key that isn't the
// sender), content {v: 1, photos: [{event_id, ts}], hidden: [event_id]}: event ids and a sort time only.

/** The room state type of a person's Memories list (state_key = their own user id). */
export const MEMORIES_TYPE = "dev.tinhat.memories";
/** Entries kept per list (photos, and a moderator's take-downs, each). */
export const MAX_ENTRIES = 500;
/** A list's serialised size budget (UTF-8 bytes of its compact JSON), under the 64 KiB event limit. */
export const MAX_BYTES = 49152;

export type Filter = "all" | "recordings" | "photos";

/** One timeline item: a recording session or a photo message, at its time. */
export interface Item {
  kind: "recording" | "photo";
  id: string;
  at: number;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * The Memories timeline: recordings (their `start_ms`) and photos (their message's time), newest first, the filter
 * applied. Ties: recordings before photos, then id ascending (code-point order). Items without an id or a finite
 * time are left out.
 */
export function timeline(recordings: Array<{ id: string; start_ms: number }>, photos: Array<{ event_id: string; ts: number }>, filter: Filter): Item[] {
  const out: Item[] = [];
  if (filter !== "photos") for (const r of recordings) if (typeof r?.id === "string" && r.id && finite(r.start_ms)) out.push({ kind: "recording", id: r.id, at: r.start_ms });
  if (filter !== "recordings") for (const p of photos) if (typeof p?.event_id === "string" && p.event_id && finite(p.ts)) out.push({ kind: "photo", id: p.event_id, at: p.ts });
  out.sort((a, b) => b.at - a.at || (a.kind === b.kind ? 0 : a.kind === "recording" ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** The photo the viewer's Previous (-1) / Next (+1) goes to from `current` in `items` (photos only, no wrap), or "". */
export function step(items: Item[], current: string, dir: 1 | -1): string {
  const photos = items.filter((i) => i.kind === "photo");
  const at = photos.findIndex((i) => i.id === current);
  if (at < 0) return "";
  const next = photos[at + dir];
  return next ? next.id : "";
}

/** The window's subtitle count: "3 recordings · 12 photos" (a zero part is left out; nothing → ""). */
export function countText(recordings: number, photos: number): string {
  const parts: string[] = [];
  if (recordings > 0) parts.push(`${recordings} ${recordings === 1 ? "recording" : "recordings"}`);
  if (photos > 0) parts.push(`${photos} ${photos === 1 ? "photo" : "photos"}`);
  return parts.join(" · ");
}

/** A photo's comment count: the server's thread aggregation on its message (`unsigned["m.relations"]["m.thread"]
 *  .count`: relations only, the comments stay encrypted). Approximate by nature (docs/MEMORIES-PHOTOS.md). */
export function commentCount(unsigned: unknown): number {
  const rel = isObj(unsigned) ? unsigned["m.relations"] : undefined;
  const th = isObj(rel) ? rel["m.thread"] : undefined;
  const n = isObj(th) ? th.count : undefined;
  return finite(n) && n > 0 ? Math.floor(n) : 0;
}

// ---- the window on a server with / without a call recorder ------------------------------------------------------

const REC_EMPTY = "Press ⏺ Rec in a call and every stream and voice is saved for reliving later — with 🔖 Clip to bookmark the good bits. Add photos and screenshots with Add photos.";
const PHOTO_EMPTY = "Add photos or screenshots with Add photos, or choose Add to Memories on one of your images in the chat.";

/** What the Memories window is on this server. Memories opens on every server; one without a call recorder
 *  (memories:false in its announcement) shows photos only: no recordings fetched, no Recordings filter, no recording
 *  words. `recorder` = the server records calls. */
export interface WindowMode {
  recordings: boolean;
  filters: Filter[];
  subtitle_empty: string;
  empty_title: string;
  empty_text: string;
  photos_empty_title: string;
  photos_empty_text: string;
  tip: string;
}
export function windowMode(recorder: boolean): WindowMode {
  const common = { photos_empty_title: "No photos here yet", photos_empty_text: PHOTO_EMPTY };
  if (recorder === true)
    return { ...common, recordings: true, filters: ["all", "recordings", "photos"], subtitle_empty: "recordings and photos of this room",
      empty_title: "No memories here yet", empty_text: REC_EMPTY, tip: "Memories — relive this room's recorded calls" };
  return { ...common, recordings: false, filters: [], subtitle_empty: "photos of this room",
    empty_title: "No photos here yet", empty_text: PHOTO_EMPTY, tip: "Memories — this room's photos" };
}

/** 2-5: my pending (just-written) list wins over the store only while the store still shows the very event my write
 *  replaced (sync hasn't caught up); any other event there (my write itself, or another device's newer one) wins. */
export function pendingWins(storeEventId: string, pending: { event_id?: unknown; replaced?: unknown } | null | undefined): boolean {
  return isObj(pending) && typeof pending.replaced === "string" && storeEventId === pending.replaced;
}

/** 2-8: where a photo's comments go: a photo posted INSIDE a thread → that thread (its root); otherwise the photo. */
export function threadRoot(eventId: string, content: unknown): string {
  const rel = isObj(content) ? content["m.relates_to"] : undefined;
  if (isObj(rel) && rel.rel_type === "m.thread" && isId(rel.event_id)) return rel.event_id;
  return eventId;
}

/** 2-8 (launch-gate ruling): a photo's Comments button. A photo posted inside a thread takes its comments to that
 *  thread and shows NO count (the thread's count is not the photo's): "Comments in thread". Otherwise the photo's own
 *  thread with its count. */
export interface CommentsFace {
  root: string;
  count: number | null;
  button: string;
}
export function commentsFace(eventId: string, content: unknown, count: unknown): CommentsFace {
  const root = threadRoot(eventId, content);
  if (root !== eventId) return { root, count: null, button: "Comments in thread" };
  const n = finite(count) && count > 0 ? Math.floor(count) : 0;
  return { root: eventId, count: n, button: n === 0 ? "Comment" : n === 1 ? "1 comment" : `${n} comments` };
}

// ---- the lists (dev.tinhat.memories) ----------------------------------------------------------------------------

/** An event id a list may name: "$" + 1–254 printable ASCII characters (no spaces). */
const ID_RE = /^\$[\x21-\x7E]{1,254}$/;
const isId = (s: unknown): s is string => typeof s === "string" && ID_RE.test(s);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface Ref {
  event_id: string;
  ts: number;
}
export interface List {
  owner: string;
  photos: Ref[];
  hidden: string[];
}

function refsOf(v: unknown): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(v)) return out;
  for (const e of v) {
    if (out.length >= MAX_ENTRIES) break;
    if (!isObj(e) || !isId(e.event_id) || !finite(e.ts) || seen.has(e.event_id)) continue;
    seen.add(e.event_id);
    out.push({ event_id: e.event_id, ts: e.ts });
  }
  return out;
}

function idsOf(v: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(v)) return out;
  for (const e of v) {
    if (out.length >= MAX_ENTRIES) break;
    if (isId(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

/** One state event as a list (R1 + R2), or null: the key must be the sender's own user id, `v` must be 1. */
export function parseList(stateKey: unknown, sender: unknown, content: unknown): List | null {
  if (typeof stateKey !== "string" || !stateKey.startsWith("@") || stateKey !== sender) return null;
  if (!isObj(content) || content.v !== 1) return null;
  return { owner: stateKey, photos: refsOf(content.photos), hidden: idsOf(content.hidden) };
}

export interface Candidate {
  event_id: string;
  owner: string;
  ts: number;
}

/**
 * Every (photo, owner) pair the room's lists name (R4: nothing deduplicated away before the fetch) + the take-downs
 * of the people who are moderators now (`mods`, R3). Photos: newest first, then event id, then owner; hidden: sorted.
 */
export function candidates(states: Array<{ state_key: unknown; sender: unknown; content: unknown }>, mods: string[]): { photos: Candidate[]; hidden: string[] } {
  const photos: Candidate[] = [];
  const seen = new Set<string>();
  const hidden = new Set<string>();
  for (const st of states) {
    const l = parseList(st?.state_key, st?.sender, st?.content);
    if (!l) continue;
    for (const r of l.photos) {
      const k = `${r.event_id}\n${l.owner}`;
      if (seen.has(k)) continue;
      seen.add(k);
      photos.push({ event_id: r.event_id, owner: l.owner, ts: r.ts });
    }
    if (mods.includes(l.owner)) for (const h of l.hidden) hidden.add(h);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  photos.sort((a, b) => b.ts - a.ts || cmp(a.event_id, b.event_id) || cmp(a.owner, b.owner));
  return { photos, hidden: [...hidden].sort(cmp) };
}

/** What the app learned fetching one photo's event (decrypted), or null = it couldn't be read on this device. */
export interface Fetched {
  sender: string;
  room_id: string;
  type: string;
  msgtype: string;
  redacted: boolean;
  ts: number;
}

/**
 * The photos to show (R5): not taken down, fetched, an image message of this room that isn't redacted, and named by
 * its SENDER's own list. Newest first (the message's own time), then event id. `unavailable` = how many couldn't be
 * read here (null: history visibility, no key yet); not-yet-fetched ids (absent) are neither shown nor counted.
 */
export function shown(c: { photos: Candidate[]; hidden: string[] }, fetched: Record<string, Fetched | null>, roomId: string): { photos: Candidate[]; unavailable: number } {
  const out: Candidate[] = [];
  const done = new Set<string>();
  let unavailable = 0;
  for (const p of c.photos) {
    if (done.has(p.event_id) || c.hidden.includes(p.event_id)) continue;
    if (!Object.prototype.hasOwnProperty.call(fetched, p.event_id)) continue;
    done.add(p.event_id);
    const f = fetched[p.event_id];
    if (!f) {
      unavailable++;
      continue;
    }
    if (f.room_id !== roomId || f.type !== "m.room.message" || f.msgtype !== "m.image" || f.redacted || !finite(f.ts)) continue;
    if (!c.photos.some((q) => q.event_id === p.event_id && q.owner === f.sender)) continue;
    out.push({ event_id: p.event_id, owner: f.sender, ts: f.ts });
  }
  out.sort((a, b) => b.ts - a.ts || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  return { photos: out, unavailable };
}

// ---- writing my own list ------------------------------------------------------------------------------------------

/** Canonical JSON (sorted keys, compact, ECMAScript numbers): what the byte budget measures on both sides. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export type Edit = { content: Record<string, unknown> } | { error: "full" | "newer" };

/** My list's next content after `change`: unknown fields kept, entries normalised; "newer" = a later version wrote it. */
function edit(current: unknown, change: (photos: Ref[], hidden: string[]) => void): Edit {
  const base: Record<string, unknown> = isObj(current) ? { ...current } : {};
  if (base.v !== undefined && base.v !== 1) return { error: "newer" };
  const photos = refsOf(base.photos);
  const hidden = idsOf(base.hidden);
  change(photos, hidden);
  if (photos.length > MAX_ENTRIES || hidden.length > MAX_ENTRIES) return { error: "full" };
  const content = { ...base, v: 1, photos, hidden };
  if (new TextEncoder().encode(canon(content)).length > MAX_BYTES) return { error: "full" };
  return { content };
}

/** Add one of MY photo messages to my list (no-op when it's there). */
export function withPhoto(current: unknown, ref: Ref): Edit {
  return edit(current, (photos) => {
    if (isId(ref?.event_id) && finite(ref?.ts) && !photos.some((p) => p.event_id === ref.event_id)) photos.push({ event_id: ref.event_id, ts: ref.ts });
  });
}

/** Take a photo off my list. */
export function withoutPhoto(current: unknown, eventId: string): Edit {
  return edit(current, (photos) => {
    const i = photos.findIndex((p) => p.event_id === eventId);
    if (i >= 0) photos.splice(i, 1);
  });
}

/** A moderator's take-down (counts only while they are a moderator). */
export function withHidden(current: unknown, eventId: string): Edit {
  return edit(current, (_p, hidden) => {
    if (isId(eventId) && !hidden.includes(eventId)) hidden.push(eventId);
  });
}

/** Undo a take-down. */
export function withoutHidden(current: unknown, eventId: string): Edit {
  return edit(current, (_p, hidden) => {
    const i = hidden.indexOf(eventId);
    if (i >= 0) hidden.splice(i, 1);
  });
}
