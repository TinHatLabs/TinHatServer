// deleteRule.ts — A30.0: the message menu's Delete is my own message, or anyone's when I may redact others (the room's
// redact level: a moderator's "Delete anyone's messages"). The desktop's ConversationView.qml uses the same rule with
// RoomController.canRedactOthers.
export function mayDelete(mine: boolean, interactive: boolean, redactOthers: boolean): boolean {
  return interactive && (mine || redactOthers);
}
