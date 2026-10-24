// sendGuard.ts — 2026-10-23 (rooms are encrypted by default). js-sdk decides whether to encrypt a timeline event from
// ITS copy of the room (MatrixClient.encryptEventIfNeeded: "If the room is unknown, we cannot encrypt for it"), so an
// event sent into a room this client hasn't synced yet — a room it has just created — would go out in the clear.
// Every timeline send this app makes goes through client.sendEvent (js-sdk's sendMessage calls it; reactions, polls,
// dice, calendar cards, game-server notices, …), so the guard sits there: until the room is known the send is refused
// (the caller's error path says so). Not covered, and not needed: resendEvent (re-sends a pending event that already
// passed here), redactions and state events (never encrypted); the app sends no delayed timeline events. An invite
// that was just accepted is known (its stripped state carries m.room.encryption with Synapse's default
// room_prejoin_state, so js-sdk encrypts — or refuses — rather than sending in the clear). The chat composer asks first
// and keeps the typed text (features/chat/actions.ts roomReadyToSend). matrix-sdk asks the server instead, so the
// desktop has no such window.
import type { MatrixClient } from "matrix-js-sdk";

export const ROOM_NOT_SYNCED = "This room is still opening — try again in a moment.";

type Guardable = Pick<MatrixClient, "getRoom"> & { sendEvent: (...args: never[]) => unknown };

/** Wrap this client's sendEvent (once). */
export function guardUnsyncedSends(client: Guardable): void {
  const c = client as unknown as { sendEvent: (...a: unknown[]) => unknown; __thSendGuard?: true; getRoom(id: string): unknown };
  if (c.__thSendGuard) return;
  const send = c.sendEvent.bind(client);
  c.sendEvent = (roomId: unknown, ...rest: unknown[]) =>
    typeof roomId === "string" && c.getRoom(roomId) ? send(roomId, ...rest) : Promise.reject(new Error(ROOM_NOT_SYNCED));
  c.__thSendGuard = true;
}
