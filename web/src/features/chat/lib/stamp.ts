// stamp.ts — P19: a grouped follow-up (same sender, a few minutes later) shows its clock only while the row is hovered
// or focused. "Sending…", "Not sent", the pin and "(edited)" always show. The desktop's ChatBubble.qml clockQuiet is
// the same rule.
export function clockQuiet(r: { grouped: boolean; pending?: boolean; failed?: boolean; pinned?: boolean; edited?: boolean }): boolean {
  return r.grouped && !r.pending && !r.failed && !r.pinned && !r.edited;
}
