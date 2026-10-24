// reply.ts — REACH A5.2: a reply notifies the person replied to. Its content carries
// `m.mentions.user_ids` = the parent's sender (unless that is you) ∪ the mentions picked in the composer —
// never you, no duplicates. (Once `m.mentions` is present Synapse stops the old name-matching rules, so the
// picked mentions MUST be in it.) Pure (no imports): reply.test.ts mirrors the desktop's reply_mentions.

export function replyMentionIds(parentSender: string | null | undefined, me: string, picked: readonly string[]): string[] {
  const ids = new Set<string>();
  if (parentSender && parentSender !== me) ids.add(parentSender);
  for (const id of picked) if (id && id !== me) ids.add(id);
  return [...ids].sort();
}
