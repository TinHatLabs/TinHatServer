// invitewatch.ts — REACH A5.1: which invites announce themselves. A per-session seen-set: whatever is
// pending at the first LIVE sync is old news and never alerts; a later invite alerts exactly once; seeing
// it again (every nav refresh) never re-alerts. Pure (no imports): invitewatch.test.ts mirrors the
// desktop's invite_seen_once.

export class InviteWatch {
  private seen: Set<string> | null = null;

  get seeded(): boolean {
    return this.seen !== null;
  }

  /** The first live snapshot: every invite in it is old news. */
  seed(ids: Iterable<string>): void {
    this.seen = new Set(ids);
  }

  /** A later snapshot → the invites to announce now (each once per session). Nothing before the seed. */
  observe(ids: Iterable<string>): string[] {
    if (!this.seen) return [];
    const fresh: string[] = [];
    for (const id of ids) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      fresh.push(id);
    }
    return fresh;
  }

  /** Signed out / a new session. */
  reset(): void {
    this.seen = null;
  }
}
