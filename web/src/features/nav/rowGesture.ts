// rowGesture.ts — what a click and a double-click on a room-list row do (12.1.5, 2026-10-30: "double-clicking a
// room joins its call"). The desktop's RoomsIsland.qml has the same rule between its BEGIN pure / END pure markers;
// both replay testvectors/room-row-gesture.json (a byte copy in the desktop's crates/app/testvectors/room-row-gesture/).
//   click     a joined room opens · a listed room you are not in asks to join it (the join dialog) · an invite does
//             nothing (its Accept / Decline buttons are the way in)
//   dblclick  a joined room, ARMED (the double-click's first click landed on this row itself while it was a joined room)
//             → "call": the room's call through the call.join action, the call button's own path (the same action gates,
//             the switch when in another call, and every consent sheet inside joinCall). Anything else (an invite, a room
//             you are not in, a double-click that started on Accept / a row button) → "nothing": the first click already
//             did what a click does, and a double-click never joins a call in a room you have not opened or accepted.
//             Phones and touch input have no double-click (docs/WEB-EXCEPTIONS.md): "nothing" there too.
export type RowGesture = "open" | "askJoin" | "call" | "nothing";

export interface RowGestureInput {
  /** "click" | "dblclick" (left button; the right button is the context menu) */
  gesture: string;
  /** the row's membership: "join" | "invite" | "none" (listed in the space, not joined) */
  membership: string;
  /** the phone layout, or the double-click came from a touch pointer */
  touch?: boolean;
  /** dblclick: its first click landed on this row (not on a control in it) while the row was a joined room */
  armed?: boolean;
}

export function rowGesture(i: RowGestureInput): RowGesture {
  const joined = i.membership === "join";
  if (i.gesture === "click") return i.membership === "none" ? "askJoin" : i.membership === "invite" ? "nothing" : "open";
  if (i.gesture === "dblclick") return joined && !i.touch && i.armed === true ? "call" : "nothing";
  return "nothing";
}
