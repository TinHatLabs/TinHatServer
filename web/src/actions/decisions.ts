// decisions.ts — product calls for the buttons (2026-09-27), one constant
// each, so a change of mind is a one-line flip. The desktop app keeps the same three in ActionsHost.qml
// (`recClipRoom`, `dimCallControlsWhileConnecting`, `palettePeople`) — flip both apps together (parity rule).
import type { JObj } from "../layout/json";
import { get, isObj } from "../layout/json";

/** (1) Rec and Clip on the call's status line act on the CALL's room ("call"), even while you look at another room;
 *  "screen" = the room on screen. */
export const REC_CLIP_ROOM: "call" | "screen" = "call";

/** (2) The call controls dim while the call is still connecting (true). false = they stay usable: the call's own
 *  rows read "connecting" as "in the call" (callRowSnapshot). */
export const DIM_CALL_CONTROLS_WHILE_CONNECTING: boolean = true;

/** (3) Ctrl+K lists the people you have DMs with ("dmPartners"); "roomMembers" also lists the members of the room on
 *  screen (both apps; the palette builds its person list from it — features/nav/QuickSwitcher.tsx). */
export const PALETTE_PEOPLE: "dmPartners" | "roomMembers" = "dmPartners";

/** Decision (1): the room Rec and Clip act on — the call's room, or the room on screen. */
export function recClipRoom(callRoom: string | null | undefined, screenRoom: string | null | undefined): string | null {
  return (REC_CLIP_ROOM === "call" ? callRoom || screenRoom : screenRoom || callRoom) || null;
}

/** The snapshot the call's own rows (the bar, the phone bar) are evaluated against — decision (2). */
export function callRowSnapshot(snap: JObj): JObj {
  if (DIM_CALL_CONTROLS_WHILE_CONNECTING) return snap;
  const values = get(snap, "values");
  if (!isObj(values) || get(values, "call.connecting") !== true || get(values, "call.in") === true) return snap;
  const v2: JObj = Object.assign(Object.create(null), values);
  v2["call.in"] = true;
  const out: JObj = Object.assign(Object.create(null), snap);
  out["values"] = v2;
  return out;
}
