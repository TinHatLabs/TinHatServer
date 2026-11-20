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

/** 12.1.17 round 2 (memories-hide-chat review #6 + its review): the row carrying NEW left the chat (its photo went into
 *  Memories): NEW moves to the first row strictly later than it (a row at the same time may be older: NEW never moves
 *  back) that is someone else's and no echo, never past the freeze-time tail (its row, else its time tailTs; 0 = no
 *  limit); none left = "" (NEW goes). A divider still among the rows (or none) stays. */
export function dividerAfterHide(rows: ReadonlyArray<{ id: string; sender: string; ts: number; echo?: boolean }>, divider: string, dividerTs: number, me: string, tail: string, tailTs: number): string {
  if (!divider || rows.some((r) => r.id === divider)) return divider;
  let end = rows.length;
  if (tail)
    for (let t = rows.length - 1; t >= 0; t--)
      if (rows[t]!.id === tail) {
        end = t + 1;
        break;
      }
  for (let i = 0; i < end; i++) {
    const r = rows[i]!;
    if (r.id !== divider && r.ts > dividerTs && (tailTs <= 0 || r.ts <= tailTs) && r.sender !== me && r.echo !== true) return r.id;
  }
  return "";
}

/** A05.2: a day separator names the year when the day isn't in this year ("Tue, Jun 15, 2025"). */
export function dayNeedsYear(ts: number, now: number): boolean {
  return new Date(ts).getFullYear() !== new Date(now).getFullYear();
}
