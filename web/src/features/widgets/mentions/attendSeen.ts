// mentions/attendSeen.ts — 12.1.16 fix 1-3: which of a room's unseen mentions a room coming on screen marks seen — by
// each mention's own timeline (threads core seenOnAttend, shared vectors testvectors/threads seen_on_attend): the main
// timeline on screen doesn't make a closed thread's mention seen. The desktop's mentions_ctl::attended_seen_ids.
// No app imports (Node unit test: attendSeen.test.ts).
import { seenOnAttend, threadOf } from "../../chat/threads/core";

/** A mention's thread lookup answered (`content` = the event's content) or failed (undefined): only an answer is
 *  recorded — a failed lookup leaves the thread unknown, so the mention stays unseen until its timeline is known to be on
 *  screen (Mark as read and "Mark all as seen" still clear it). True = recorded. The desktop's record_lookup. */
export function recordLookup(threads: Map<string, string>, event: string, content: unknown): boolean {
  if (content === undefined) return false;
  threads.set(event, threadOf(content));
  return true;
}

/** `threads`: event → its thread as recorded or looked up ("" = main). A mention not in it (recorded in an earlier run,
 *  its lookup pending) is not marked: no timeline is known to be its own yet. */
export function attendedSeenIds(
  list: ReadonlyArray<{ r: string; e: string; t: number; seen?: boolean }>,
  room: string,
  shown: readonly string[],
  upTo: number,
  threads: ReadonlyMap<string, string>,
): string[] {
  const ms = list.filter((m) => m.r === room && !m.seen && threads.has(m.e)).map((m) => ({ e: m.e, t: m.t, thread: threads.get(m.e)! }));
  return seenOnAttend(ms, shown, upTo);
}
