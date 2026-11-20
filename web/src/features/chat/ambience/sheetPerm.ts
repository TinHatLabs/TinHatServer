// sheetPerm.ts — may I change this room's background, as a LIVE value (bgsheet-1220, 12.2.0). The sheet used to read the
// room's power levels once when it opened; right after a fresh page load the room, its power levels or my own member
// weren't in the client yet, and a moderator got the read-only sheet until they reopened it. Now:
//   - "not known yet" (no client, no room, no m.room.create / m.room.power_levels, no member for me) is its OWN state: the sheet shows a
//     neutral form (the room's current choice, nothing pickable, no "only moderators" note, no greyed tiles), never the
//     read-only one;
//   - the value is re-evaluated whenever the room arrives, its power levels or my membership change, so the open sheet
//     turns editable (moderator) or read-only (everyone else) by itself.
// Pure + node-testable (sheetPerm.test.ts drives the derive spec with a fake client).
import { ClientEvent, EventType, RoomEvent, RoomMemberEvent, RoomStateEvent, type MatrixClient, type MatrixEvent, type Room, type RoomMember, type RoomState } from "matrix-js-sdk";

/** true = may change it, false = may not, null = not known yet (the room or its power levels haven't arrived). */
export type BackgroundPermission = boolean | null;

type PermClient = Pick<MatrixClient, "getRoom" | "getUserId">;

export function backgroundPermission(c: PermClient | null, roomId: string, type: string): BackgroundPermission {
  const r = c?.getRoom(roomId);
  const me = c?.getUserId();
  if (!r || !me) return null;
  const st = r.currentState;
  // js-sdk answers maySendStateEvent with "yes" when there are no power levels, and "no" when it has no member for me or
  // no m.room.create (a member's power level is only applied once the create event is there, room-state.js): all three
  // mean the room's state isn't here yet, not an answer. Known limits (js-sdk, not this rule): a room that really has no
  // power levels stays neutral (Synapse always writes them), and a create event arriving in a LATER batch than the
  // power levels leaves js-sdk's member power level at 0 until the next power-level event (initial state carries both)
  if (!st.getStateEvents(EventType.RoomCreate, "") || !st.getStateEvents(EventType.RoomPowerLevels, "") || !st.getMember(me)) return null;
  return st.maySendStateEvent(type, me);
}

const STATE_TYPES = new Set<string>([EventType.RoomCreate, EventType.RoomPowerLevels, EventType.RoomMember]);

/** The derive spec behind useCanSetBackground (room.ts): which client events can change the answer — the room arriving, its
 *  create / power levels / member state (sync and out-of-band members: RoomState.update), my membership, a member's power
 *  level, and a reset live timeline (a new currentState). All of them are re-emitted on the client (js-sdk sync.ts). */
export function backgroundPermissionSpec(roomId: string, type: string) {
  return {
    attach: (c: MatrixClient, changed: () => void) => {
      const onState = (ev: MatrixEvent) => {
        if (ev.getRoomId() === roomId && STATE_TYPES.has(ev.getType())) changed();
      };
      const onUpdate = (st: RoomState) => {
        if (st.roomId === roomId) changed();
      };
      const onRoom = (r: Room | undefined) => {
        if (r?.roomId === roomId) changed();
      };
      const onPower = (_ev: MatrixEvent, m: RoomMember) => {
        if (m.roomId === roomId) changed();
      };
      c.on(RoomStateEvent.Events, onState);
      c.on(RoomStateEvent.Update, onUpdate);
      c.on(ClientEvent.Room, onRoom);
      c.on(RoomEvent.MyMembership, onRoom);
      c.on(RoomEvent.TimelineReset, onRoom);
      c.on(RoomMemberEvent.PowerLevel, onPower);
      return () => {
        c.off(RoomStateEvent.Events, onState);
        c.off(RoomStateEvent.Update, onUpdate);
        c.off(ClientEvent.Room, onRoom);
        c.off(RoomEvent.MyMembership, onRoom);
        c.off(RoomEvent.TimelineReset, onRoom);
        c.off(RoomMemberEvent.PowerLevel, onPower);
      };
    },
    compute: (c: MatrixClient | null): BackgroundPermission => backgroundPermission(c, roomId, type),
  };
}

/** What the "Chat background" sheet shows for a permission. */
export function sheetMode(p: BackgroundPermission): { editable: boolean; note: "forEveryone" | "readOnly" | null; greyed: boolean; button: "cancel" | "close" } {
  if (p === true) return { editable: true, note: "forEveryone", greyed: false, button: "cancel" };
  if (p === false) return { editable: false, note: "readOnly", greyed: true, button: "close" };
  return { editable: false, note: null, greyed: false, button: "close" };
}
