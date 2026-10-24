// newRoom.ts — what a room made with "New room" starts with (2026-10-23: rooms are encrypted from the start; only the
// guests' rooms aren't — then option (a): a PUBLIC room inside a space stays unencrypted, so people who join later can
// read what was said before). Shared logic: the
// desktop's crates/app/src/new_room.rs builds the same list and shows the same line, and both replay the contract
// vectors testvectors/new-room/vectors.json (reference: contract tools/new-room-vectors.py; byte copy in
// ./testvectors/new-room.json).
//
//   a space                      → []  (holds no messages; stays unencrypted, as before)
//   a PUBLIC room inside a space → [join rule "restricted" to the space's members] — NOT encrypted: the space's members
//                                  walk in without an invite, and end-to-end encryption gives such a joiner no earlier
//                                  messages (only an invite carries them)
//   any other room               → [encryption]  (private, in a space or not; public outside a space)
// The guest room is the server's (docs/GUESTS.md in the server repo) and stays unencrypted; the apps never make it.

/** m.room.encryption for every encrypted room the apps make: the spec's defaults — the same content a DM already gets. */
export const ROOM_ENCRYPTION = Object.freeze({
  algorithm: "m.megolm.v1.aes-sha2",
  rotation_period_ms: 604800000,
  rotation_period_msgs: 100,
});

export interface InitialStateEvent {
  type: string;
  state_key: string;
  content: Record<string, unknown>;
}

export interface NewRoomInput {
  space: boolean;
  isPrivate: boolean;
  /** the space it goes into ("" / null = none; ignored for a space) */
  parent: string | null;
}

/** A PUBLIC room inside a space: the one kind of room that is open to the space's members and unencrypted. */
const openChannel = (o: NewRoomInput): boolean => !o.space && !!o.parent && !o.isPrivate;

/** createRoom's initial_state for New room. */
export function newRoomInitialState(o: NewRoomInput): InitialStateEvent[] {
  if (o.space) return [];
  if (openChannel(o)) {
    return [
      {
        type: "m.room.join_rules",
        state_key: "",
        content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: o.parent }] },
      },
    ];
  }
  // A PRIVATE room stays invite-only even inside a space (the preset) — joining a space is never a key to its private
  // rooms — and is encrypted; so is a public room outside a space.
  return [{ type: "m.room.encryption", state_key: "", content: { ...ROOM_ENCRYPTION } }];
}

/** The line New room shows under its choices — the desktop's new_room.rs hint, word for word (shared vectors). */
export const NEW_ROOM_HINT = Object.freeze({
  private: "End-to-end encrypted: only the people in it can read the messages.",
  public: "End-to-end encrypted: people who join without an invite can't read earlier messages.",
  open: "Not end-to-end encrypted, so people who join later can read earlier messages, and so can the server.",
});

/** "" = no line (a space). */
export function newRoomHint(o: NewRoomInput): string {
  if (o.space) return "";
  if (openChannel(o)) return NEW_ROOM_HINT.open;
  return o.isPrivate ? NEW_ROOM_HINT.private : NEW_ROOM_HINT.public;
}
