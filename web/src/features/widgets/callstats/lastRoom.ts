// lastRoom.ts — Call stats "Last call": the text for the call's room = its name (trimmed), else "a room you left";
// never the raw room id (QA 12.1.11 D5: a room left or never synced on this device). The desktop's widgets_ctl.rs
// last_call_room_text is the same rule. Pure (the node unit test loads it).
export const LEFT_ROOM_TEXT = "a room you left";

export function lastCallRoomText(name: string | null | undefined, roomId: string): string {
  const n = (name ?? "").trim();
  return n && n !== roomId ? n : LEFT_ROOM_TEXT;
}
