// reactions.ts — reactions (QOL A07.2): the one key rule and the grouping step for a message's reaction chips.
// - reactKeyNorm: a key's grouping form — the U+FE0E / U+FE0F variation selectors dropped, so ❤ and ❤️ are one chip and
//   the quick ❤️ button finds yours.
// - addReaction: one reaction event into a message's groups (model.ts pass 1): first appearance sets the chip's place
//   and shown key; one person counts once.
// SHARED LOGIC: = the desktop's reactions.rs (react_key_norm, group_chips); both replay testvectors/reactions/vectors.json.

export function reactKeyNorm(k: string): string {
  return String(k ?? "").replace(/[︎️]/g, "");
}

/** users = each sender's first reaction (the count); all = every reaction of each sender (❤ and ❤️ both sent: taking it
 *  back redacts them all — the desktop's reactionIds) */
export type ReactGroup<E> = { key: string; users: Map<string, E>; all: Map<string, E[]>; order: number };

/** Add one reaction (timeline order, oldest first) to a message's groups (keyed by the grouping form). */
export function addReaction<E>(per: Map<string, ReactGroup<E>>, key: string, sender: string, ev: E, order: number): void {
  const n = reactKeyNorm(key);
  let g = per.get(n);
  if (!g) per.set(n, (g = { key, users: new Map(), all: new Map(), order }));
  if (!g.users.has(sender)) g.users.set(sender, ev);
  const list = g.all.get(sender);
  if (list) list.push(ev);
  else g.all.set(sender, [ev]);
}

/** The chips of a message's reactions in timeline order (the vectors' shape): {key, count, mine} in chip order. */
export function groupChips(oldestFirst: readonly { key: string; sender: string }[], me: string): { key: string; count: number; mine: boolean }[] {
  const per = new Map<string, ReactGroup<null>>();
  let order = 0;
  for (const r of oldestFirst) if (r.key) addReaction(per, r.key, r.sender, null, order++);
  return [...per.values()].sort((a, b) => a.order - b.order).map((g) => ({ key: g.key, count: g.users.size, mine: g.users.has(me) }));
}
