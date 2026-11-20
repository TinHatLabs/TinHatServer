// A room link to a room this account isn't in (PM 2026-11-14, found on Android): the conversation spun forever ("Room" +
// a spinner). Once the room is still unknown ROOM_MISSING.waitMs after opening, and the first sync is done, it says it
// can't be opened, with a way back; a room that arrives later (a slow sync, a join elsewhere) still opens. Shared with
// the desktop (RoomMissing.qml + room.rs) through testvectors/room-missing/vectors.json, byte-identical in both repos.

export const ROOM_MISSING = {
  waitMs: 10_000,
  title: "Can't open this room",
  explanation: "You're not in it, or it doesn't exist. Ask someone in it to invite you.",
  button: "Back to your rooms",
} as const;

/** Whether the conversation should stop loading and say the room can't be opened. */
export function roomMissing(known: boolean, synced: boolean, elapsedMs: number): boolean {
  return !known && synced && elapsedMs >= ROOM_MISSING.waitMs;
}

export interface MissingDeps {
  /** the client now (null while signed out): whether its first sync is done and whether it holds the room */
  client: () => { isInitialSyncComplete(): boolean; getRoom(id: string): unknown } | null | undefined;
  now: () => number;
  every: (fn: () => void, ms: number) => unknown;
  stop: (h: unknown) => void;
}

/** Watch a room that isn't known yet: `onMissing(true)` once the rule says so, `onMissing(false)` if the room arrives
 *  after that. Checks once a second; returns the stop function. */
export function watchMissing(roomId: string, onMissing: (missing: boolean) => void, d: MissingDeps): () => void {
  const openedAt = d.now();
  let shown = false;
  const h = d.every(() => {
    const c = d.client();
    const has = !!c?.getRoom(roomId);
    const now = !has && roomMissing(false, !!c?.isInitialSyncComplete(), d.now() - openedAt);
    if (now !== shown) {
      shown = now;
      onMissing(now);
    }
  }, 1000);
  return () => d.stop(h);
}
