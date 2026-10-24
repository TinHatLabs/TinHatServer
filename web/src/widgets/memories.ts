// memories.ts — the Memories widget (widget `memories`, contract WIDGETS.md §21, vectors testvectors/widgets/memories/*):
// your latest recordings (the Memories DVR sessions of the rooms you're in, the `/api/vods/sessions` answers the
// Memories window reads), newest first; the row texts; the Small line; and which frame is a memory's poster (the Memories
// window's own rule). Pure: the apps fetch the sessions and build the signed thumbnail URL from the track this returns.
// The desktop's Rust port (crates/widgets/src/memories.rs) runs the same vectors.

import { fmtAgo, fmtDur } from "./time";

/** What the M / L lists hold. */
export const MEM_ROWS = { M: 4, L: 8 } as const;
/** "New" = recorded within this many ms (the Small line's count). */
export const NEW_MS = 7 * 86_400_000;

export type MemState = "live" | "processing" | "ready";

export interface MemItem {
  room: string;
  id: string;
  /** the room's name as the session recorded it, else the name the app knows now, else "Memory" */
  title: string;
  start: number;
  end: number | null;
  state: MemState;
  /** end − start (null while live) */
  durMs: number | null;
  /** the poster frame: a video track's file + the second into THAT file (null = no poster: the glyph) */
  poster: { file: string; t: number } | null;
  /** the people behind the tracks (first-seen order), at most 5 */
  people: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface Track {
  file: string;
  identity: string;
  kind: string;
  start: number;
  end: number | null;
}

function tracksOf(s: Record<string, unknown>): Track[] {
  const list = Array.isArray(s.tracks) ? s.tracks : [];
  const out: Track[] = [];
  for (const t of list) {
    if (!isObj(t) || !str(t.file)) continue;
    out.push({ file: str(t.file), identity: str(t.identity), kind: str(t.kind), start: isNum(t.start_ms) ? t.start_ms : 0, end: isNum(t.end_ms) ? t.end_ms : null });
  }
  return out;
}

const isVideo = (t: Track) => t.kind === "share" || t.kind === "cam";
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The Memories window's poster rule (MemoriesWindow posterUrl): only an ended session; the earliest-starting video
 * track, scanning shares first then by file, a later one winning when it starts > 500 ms earlier, or within 500 ms when
 * it is a share and the best is not; dur = (end − start) / 1000 (≥ 1), off = max(0, (track start − start) / 1000);
 * t0 = floor(min(dur − 1, max(off + 1, min(off + 8, dur / 3)))); the second into the file = max(0, t0 − floor(off)).
 */
export function posterAt(session: unknown): { file: string; t: number } | null {
  if (!isObj(session) || !isNum(session.end_ms) || !isNum(session.start_ms)) return null;
  const start = session.start_ms;
  const vids = tracksOf(session)
    .filter(isVideo)
    .sort((a, b) => (a.kind === "share" ? 0 : 1) - (b.kind === "share" ? 0 : 1) || cmpStr(a.file, b.file));
  let best: Track | null = null;
  for (const t of vids) {
    if (!best) {
      best = t;
      continue;
    }
    const d = t.start - best.start;
    if (d < -500) best = t;
    else if (Math.abs(d) <= 500 && t.kind === "share" && best.kind !== "share") best = t;
  }
  if (!best) return null;
  const dur = Math.max(1, (session.end_ms - start) / 1000);
  const off = Math.max(0, (best.start - start) / 1000);
  const t0 = Math.floor(Math.min(dur - 1, Math.max(off + 1, Math.min(off + 8, dur / 3))));
  return { file: best.file, t: Math.max(0, t0 - Math.floor(off)) };
}

/** The people behind a session's tracks: `people` when the server sent it, else each identity's "@user:server". */
function peopleOf(s: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  if (Array.isArray(s.people)) for (const p of s.people) add(str(p));
  else
    for (const t of tracksOf(s)) {
      const m = /^(@[^:]+:[^:]+)/.exec(t.identity);
      if (m) add(m[1]!);
    }
  return out.slice(0, 5);
}

export interface MemRoom {
  room: string;
  /** the room's name the app knows now ("" = none) */
  name: string;
  /** the `/vods/sessions` answer's `sessions` */
  sessions: unknown;
}

/**
 * Every room's sessions → the memories, newest first (start descending, then room, then id, code-point order).
 * Dropped: non-objects, a session without a string id or a numeric start_ms, and sessions where nothing was captured
 * (`empty: true`, or no tracks at all). state: live (end_ms not a number), processing (`ready: false`), else ready.
 * A room's id repeating keeps the first; a session id repeating within a room keeps the first. `max` > 0 cuts the list.
 */
export function memoriesOf(rooms: MemRoom[], max = 0): MemItem[] {
  const out: MemItem[] = [];
  const seenRoom = new Set<string>();
  for (const r of Array.isArray(rooms) ? rooms : []) {
    if (!isObj(r) || !str(r.room) || seenRoom.has(str(r.room))) continue;
    seenRoom.add(str(r.room));
    const seen = new Set<string>();
    for (const s of Array.isArray(r.sessions) ? r.sessions : []) {
      if (!isObj(s) || !str(s.id) || !isNum(s.start_ms) || seen.has(str(s.id))) continue;
      seen.add(str(s.id));
      if (s.empty === true || tracksOf(s).length === 0) continue;
      const end = isNum(s.end_ms) ? s.end_ms : null;
      const state: MemState = end === null ? "live" : s.ready === false ? "processing" : "ready";
      out.push({
        room: str(r.room),
        id: str(s.id),
        title: str(s.room_name) || str(r.name) || "Memory",
        start: s.start_ms,
        end,
        state,
        durMs: end === null ? null : Math.max(0, end - s.start_ms),
        poster: posterAt(s),
        people: peopleOf(s),
      });
    }
  }
  out.sort((a, b) => b.start - a.start || cmpStr(a.room, b.room) || cmpStr(a.id, b.id));
  return max > 0 ? out.slice(0, max) : out;
}

/** A row's second line: "Recording now", "Processing…", or "<ago> · <length>" ("2 h ago · 1 h 20 m"). */
export function memLine(m: MemItem, now: number): string {
  if (m.state === "live") return "Recording now";
  if (m.state === "processing") return "Processing…";
  return `${fmtAgo(now - (m.end ?? m.start))} · ${fmtDur(m.durMs ?? 0)}`;
}

/** The Small line: none → "No memories yet"; the newest live → "Recording now"; n = memories that started within
 *  NEW_MS → "<n> new memor(y|ies) · latest <ago of the newest's end>"; none new → "Latest <ago>". */
export function memSummary(items: MemItem[], now: number): string {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "No memories yet";
  const first = list[0]!;
  if (first.state === "live") return "Recording now";
  const n = list.filter((m) => m.start >= now - NEW_MS).length;
  const ago = fmtAgo(now - (first.end ?? first.start));
  return n > 0 ? `${n} new ${n === 1 ? "memory" : "memories"} · latest ${ago}` : `Latest ${ago}`;
}
