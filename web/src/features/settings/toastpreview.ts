// toastpreview.ts — a message notification's preview text, the same rule as the desktop's notify::preview_text
// (shared vectors: testvectors/toast-preview.json). The body trimmed, every run of whitespace folded to one space,
// cut to 160 code points + "…", then "Name: " in a group room. null = no preview (the generic wording).

import { noteText } from "../chat/threads/core";

export const PREVIEW_MAX = 160;

export function previewText(body: string, name: string | null): string | null {
  const text = body.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const cps = [...text];
  const cut = cps.length > PREVIEW_MAX ? cps.slice(0, PREVIEW_MAX).join("") + "…" : text;
  return name === null ? cut : `${name}: ${cut}`;
}

/** fix1216 1-10: a group toast's sender label: the display name, or the id's localpart when the member isn't cached or
 *  its name is empty (the desktop's notify::sender_label). */
export function senderLabel(display: string | null | undefined, userId: string): string {
  return display || userId.replace(/^@/, "").split(":")[0]!;
}

/** fix1216 1-10: the whole toast line (shared vectors `notes`, the desktop's notify::toast_note): the cut text with the
 *  thread wording, "Name: …" in a group room, the text alone in a DM. null = no preview. */
export function toastNote(display: string | null | undefined, sender: string, dm: boolean, thread: boolean, body: string): string | null {
  const cut = previewText(body, null);
  if (cut === null) return null;
  const name = dm ? "" : senderLabel(display, sender);
  // no name to put first (no sender at all): the nameless form, which still says it is in a thread
  return noteText(name, cut, thread, dm || name === "");
}
