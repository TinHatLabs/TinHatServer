// roomMenuCall.ts — A04.3 (2026-11-14): the room menu's call item, so a room's call can be found without knowing the
// double-click (the desktop's Main.qml roomMenuCall runs the same rule between its BEGIN / END room-menu-call markers;
// tools/qol-l3-test.mjs checks it on these cases, roomMenuCall.test.ts here). Joined rooms only; not the call you are
// already in. The words are call.join's own variants (actions.json): "Join the active call" / "Start a call".
export function roomMenuCall(membership: string, callLive: boolean, inThisCall: boolean): string {
  if (membership !== "join" || inThisCall) return "";
  return callLive ? "Join the active call" : "Start a call";
}
