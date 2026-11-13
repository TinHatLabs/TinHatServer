// uploadCrypto.ts — is a room encrypted, for an UPLOAD (security review round 4, VN-1). An upload's bytes must be
// encrypted whenever the event that points at them will be: js-sdk encrypts a timeline event when the room state has
// m.room.encryption OR its crypto store says the room is encrypted (MatrixClient.shouldEncryptEventForRoom: the Rust
// OlmMachine keeps that setting once seen, so a state reset or a hostile homeserver that drops m.room.encryption
// can't downgrade the room). Reading only the state would upload plaintext media under an encrypted event. So:
//   - the state says encrypted, or the crypto store does → encrypted (and remembered for this client: sticky)
//   - both say no → plaintext; the caller re-reads `encryptedNowSync` right before it starts the plaintext request
//   - can't tell (no crypto, the crypto store throws, the room unknown) → throws: nothing is uploaded (fail closed)
// Used by voice notes (features/chat/voicenote/wire.ts) and attachments (features/chat/actions.ts → media.ts
// uploadFile). The desktop asks matrix-sdk's latest_encryption_state, which is sticky the same way.
import type { MatrixClient } from "matrix-js-sdk";
import { ROOM_NOT_SYNCED } from "./sendGuard";

export const ENCRYPTION_UNKNOWN = "Couldn't check this room's encryption, so nothing was uploaded. Try again.";

type RoomLike = { hasEncryptionStateEvent(): boolean };
export type UploadCryptoClient = {
  getRoom(roomId: string): RoomLike | null | undefined;
  getCrypto(): { isEncryptionEnabledInRoom(roomId: string): Promise<boolean> } | undefined | null;
};

// rooms this client has seen encrypted (never forgotten while the client lives; a new client starts empty)
const seen = new WeakMap<object, Set<string>>();
function remember(client: object, roomId: string): void {
  let s = seen.get(client);
  if (!s) seen.set(client, (s = new Set()));
  s.add(roomId);
}

/** Synchronous: the room state says encrypted, or this client has seen it encrypted. For the last check right before a
 *  plaintext request starts (no await in between). An unknown room counts as encrypted (nothing goes up plain). */
export function encryptedNowSync(client: UploadCryptoClient | MatrixClient, roomId: string): boolean {
  const c = client as UploadCryptoClient;
  if (seen.get(c)?.has(roomId)) return true;
  const room = c.getRoom(roomId);
  if (!room) return true;
  if (room.hasEncryptionStateEvent()) {
    remember(c, roomId);
    return true;
  }
  return false;
}

/** The room's encryption for an upload: true / false, or throws (ROOM_NOT_SYNCED / ENCRYPTION_UNKNOWN) when it can't
 *  be told — the caller then uploads nothing. */
export async function roomEncryptedForUpload(client: UploadCryptoClient | MatrixClient, roomId: string): Promise<boolean> {
  const c = client as UploadCryptoClient;
  if (!c.getRoom(roomId)) throw new Error(ROOM_NOT_SYNCED);
  if (encryptedNowSync(c, roomId)) return true;
  let crypto: ReturnType<UploadCryptoClient["getCrypto"]>;
  try {
    crypto = c.getCrypto();
  } catch {
    crypto = null;
  }
  if (!crypto || typeof crypto.isEncryptionEnabledInRoom !== "function") throw new Error(ENCRYPTION_UNKNOWN);
  let on: unknown;
  try {
    on = await crypto.isEncryptionEnabledInRoom(roomId);
  } catch {
    throw new Error(ENCRYPTION_UNKNOWN);
  }
  if (on === true) {
    remember(c, roomId);
    return true;
  }
  if (on !== false) throw new Error(ENCRYPTION_UNKNOWN);
  // the state may have changed while the crypto store answered
  if (!c.getRoom(roomId)) throw new Error(ROOM_NOT_SYNCED);
  return encryptedNowSync(c, roomId);
}
