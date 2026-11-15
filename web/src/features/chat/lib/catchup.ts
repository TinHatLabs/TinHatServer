// catchup.ts — catching up in a busy room: the NEW line's rules, the same as ConversationView.qml's
// "catching-up pure" block (both replay testvectors/catching-up/vectors.json; the desktop owns it). No app imports
// (Node unit tests: tools/catching-up-unit.mts).

/** A35.1: where the NEW line search starts when the read marker isn't among the loaded rows: `hint` (the room's unread
 *  count) rows from the end. "more" = more unread than loaded rows while older history exists: load older first (the
 *  line used to land on the oldest loaded row). null = no NEW line. */
export function newLineStart(len: number, hint: number, canBack: boolean): number | "more" | null {
  if (hint <= 0) return null;
  if (hint >= len && canBack) return "more";
  return Math.max(-1, len - 1 - hint);
}

/** 12.1.16 fix 1-7: the unread count the NEW line may use: the room's on the main timeline, none in a thread's view
 *  (the room's count doesn't describe a thread, so a thread shows no NEW line). */
export function newLineHint(threadRoot: string, roomUnread: number): number {
  return threadRoot.length > 0 ? 0 : Math.max(0, roomUnread);
}

/** P2 a: the "Jump to NEW" pill shows while there is a NEW line (or one waiting for older history) that hasn't been
 *  on screen since the room opened. */
export function newPillShown(hasLine: boolean, waiting: boolean, seen: boolean): boolean {
  return (hasLine || waiting) && !seen;
}

/** A05.2: a day separator names the year when the day isn't in this year ("Tue, Jun 15, 2025"). */
export function dayNeedsYear(ts: number, now: number): boolean {
  return new Date(ts).getFullYear() !== new Date(now).getFullYear();
}
