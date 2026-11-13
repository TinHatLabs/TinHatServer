// pins.ts — QA W1 (2026-11-07): a deleted (redacted) message is not a pin. The rules the composer's "📌 N" button, its
// Pinned messages list, the bubble's 📌 and Delete share; the desktop's crates/app/src/pins.rs is a line-for-line port and
// both replay testvectors/pins.json (byte-identical in the two repos). The Pinned widget keeps its contract rows (a
// deleted pin reads "Message deleted" there, its Unpin item is the way out for a pin nobody could take back).

export const PIN_DELETED = "Message deleted";
export const PIN_ENCRYPTED = "Encrypted message — open the room around it to read it";

/** A pinned row's line. */
export function pinRowBody(p: { encrypted: boolean; redacted: boolean; text: string }): string {
  // deleted first: a redaction keeps an encrypted event's m.room.encrypted type and drops its content — it is gone,
  // not waiting for a key
  return p.redacted ? PIN_DELETED : p.encrypted ? PIN_ENCRYPTED : p.text;
}

/** The pins the 📌 N button counts and its list shows, in the given order: a message known to be deleted is not one
 *  (a pin someone else's Delete left behind, or one I may not take back). */
export function shownPins(pinned: readonly string[], deleted: Iterable<string>): string[] {
  const gone = new Set(deleted);
  return pinned.filter((id) => !gone.has(id));
}

/** Deleting `id` also unpins it: the room's new pin list to write (every copy of the id dropped), or null = no write
 *  (it isn't pinned, or I may not edit the room's pins — then it is only hidden, shownPins). */
export function pinsAfterDelete(pinned: readonly string[], id: string, mayPin: boolean): string[] | null {
  if (!mayPin || !pinned.includes(id)) return null;
  return pinned.filter((x) => x !== id);
}
