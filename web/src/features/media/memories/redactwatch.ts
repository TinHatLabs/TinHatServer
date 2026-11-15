// memories/redactwatch.ts — 2-4: a deleted photo message leaves Memories even when the SDK never held it. The SDK's
// own Redaction notice comes only for an event in a loaded timeline; Memories also reads older photos one by one
// (photosStore fetchOne), so every incoming redaction event is looked at too. Such a raw redaction event is not proof
// the redaction took effect (review): the photo's cached read is dropped and the server's next answer decides; a read
// that was already under way when the redaction arrived is not trusted. No imports: the unit test runs it in Node.

/** What the watcher needs of an incoming event (js-sdk's MatrixEvent has these). */
export interface EventLike {
  getType(): string;
  getRoomId(): string | undefined;
  getContent(): Record<string, unknown>;
  /** the wire event: `redacts` is the target in rooms before v11 */
  event?: { redacts?: unknown };
}

/** The message a redaction event removes ("" = not a redaction): its own `redacts`, else `content.redacts` (v11).
 *  Never the generic "associated id", which prefers a reply / relation target (review). */
export function redactionTarget(ev: EventLike): string {
  if (ev.getType() !== "m.room.redaction") return "";
  const top = ev.event?.redacts;
  if (typeof top === "string" && top) return top;
  const c = ev.getContent()?.redacts;
  return typeof c === "string" ? c : "";
}

export interface RedactDeps<G> {
  key: (room: string, id: string) => string;
  cache: Map<string, G>;
  /** the SDK's applied redactions (a read landing later is flagged redacted) */
  redacted: Set<string>;
  /** key → when a redaction event for it arrived (a read started before that is not trusted) */
  stale: Map<string, number>;
  /** a mounted Memories window re-renders */
  notify: () => void;
  now?: () => number;
}

/** The SDK applied a redaction of `target` in `room`: a later read can't bring it back, a cached read is flagged. */
export function markRedacted<G extends { fetched: { redacted: boolean } | null }>(room: string, target: string, d: RedactDeps<G>): void {
  if (!room || !target) return;
  const k = d.key(room, target);
  d.redacted.add(k);
  const g = d.cache.get(k);
  if (g?.fetched) d.cache.set(k, { ...g, fetched: { ...g.fetched, redacted: true } });
  d.notify();
}

/** An incoming timeline event (any room): a redaction drops its target's cached read (the photo leaves the window at
 *  once; the server's next answer decides), whether or not the SDK holds the target. */
export function onTimelineEvent<G>(ev: EventLike, d: RedactDeps<G>): void {
  const t = redactionTarget(ev);
  const room = ev.getRoomId() ?? "";
  if (!t || !room) return;
  const k = d.key(room, t);
  d.stale.set(k, (d.now ?? Date.now)());
  d.cache.delete(k);
  d.notify();
}

/** May a read of `k` that started at `startedAt` be stored? Not when a redaction of it arrived after it started. */
export function readStillGood(k: string, startedAt: number, stale: Map<string, number>): boolean {
  const at = stale.get(k);
  return at === undefined || at < startedAt;
}
