// moved.ts — events of a server that moved to a new name (Tin Hat Server: Maintenance → "Move to your own domain",
// the server's move.py / move_synapse.py). The move gave every event a new id. An event's relation (edit, reaction,
// reply, thread, poll answer) sits outside the encryption, where the server renamed it, and also inside it, where nothing
// can change it; decryption hands back the inside copy, which still names the old ids. So the server leaves a note in
// each moved event's unsigned["dev.tinhat.moved"]:
//   former_ids  the ids the event had before (every move so far)
//   relates_to  for an encrypted event: its relation by the new ids
// Shared rule with the desktop (crates/app/src/moved.rs): the same cases in moved.test.ts and its tests.
export const MOVED_KEY = "dev.tinhat.moved";

type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : null);

export interface MovedNote {
  formerIds: string[];
  relatesTo: J | null;
}

/** The note on a moved event (from its unsigned), or null. */
export function movedNote(unsigned: unknown): MovedNote | null {
  const n = obj(obj(unsigned)?.[MOVED_KEY]);
  if (!n) return null;
  const formerIds = Array.isArray(n.former_ids) ? n.former_ids.filter((x): x is string => typeof x === "string") : [];
  return { formerIds, relatesTo: obj(n.relates_to) };
}

/**
 * An event's relation as it is now: the (decrypted) content's m.relates_to, its targets taken from the note when the
 * note describes the same relation (the same rel_type, and the same key for a reaction). Anything else stays as it is.
 */
export function currentRelation(relatesTo: unknown, unsigned: unknown): J | null {
  const r = obj(relatesTo);
  if (!r) return null;
  const moved = movedNote(unsigned)?.relatesTo;
  if (!moved || moved.rel_type !== r.rel_type) return r;
  if (r.rel_type === "m.annotation" && moved.key !== r.key) return r;
  const out: J = { ...r };
  if (typeof r.event_id === "string" && typeof moved.event_id === "string") out.event_id = moved.event_id;
  const reply = obj(r["m.in_reply_to"]);
  const movedReply = obj(moved["m.in_reply_to"]);
  if (reply && typeof movedReply?.event_id === "string") out["m.in_reply_to"] = { ...reply, event_id: movedReply.event_id };
  return out;
}

/** The content with its relation as it is now (currentRelation); the very same object when nothing changes. */
export function withCurrentRelation<T>(content: T, unsigned: unknown): T {
  const c = obj(content);
  if (!c || !obj(c["m.relates_to"])) return content;
  const now = currentRelation(c["m.relates_to"], unsigned);
  return now === c["m.relates_to"] ? content : ({ ...c, "m.relates_to": now } as T);
}

/** Old ids → today's ids, from the events at hand (ids named inside encrypted content other than its relation). */
export function formerIdMap(events: Iterable<{ id: string | undefined | null; unsigned: unknown }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) {
    if (!e.id) continue;
    for (const f of movedNote(e.unsigned)?.formerIds ?? []) if (f !== e.id) m.set(f, e.id);
  }
  return m;
}

export interface MoveInfo {
  /** on a former name: where the server went */
  movedTo: string | null;
  /** on the new address: the names it had before */
  movedFrom: string[];
}

// the same rule as the desktop's moved.rs host(): labels of letters, digits and inner dashes, the last one 2+ long
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const host = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const h = v.trim().toLowerCase().replace(/\.$/, "");
  return HOST.test(h) ? h : null;
};

/** What a server's /.well-known/matrix/client says about a move (dev.tinhat.moved_to / dev.tinhat.moved_from). Plain
 * host names only; anything else is ignored. */
export function parseMove(wellKnown: unknown): MoveInfo {
  const w = obj(wellKnown);
  if (!w) return { movedTo: null, movedFrom: [] };
  const from = Array.isArray(w["dev.tinhat.moved_from"]) ? (w["dev.tinhat.moved_from"] as unknown[]).map(host).filter((x): x is string => !!x) : [];
  return { movedTo: host(w["dev.tinhat.moved_to"]), movedFrom: from };
}

/**
 * The account has its Security Key's storage (Secret Storage) but no encryption identity on the server: the server
 * moved to a new name (the identities were made for the old one) or someone removed theirs. No other device can vouch
 * for this one then, so the unlock leads with the Security Key: it restores the message keys and makes a new identity
 * under the same key.
 */
export function keyFirst(st: { hasCrossSigningIdentity: boolean; secretStorageKeyId?: string | null }): boolean {
  return !st.hasCrossSigningIdentity && !!st.secretStorageKeyId;
}
