// threads/open.ts — open the Threads panel (docs/THREADS.md): the right panel's "Threads" tab, on one thread (root) or
// on the list (null). `opener` = the control focus returns to when the thread is closed again.
import { bus } from "@/core/bus";
import { THREADS_TAB, setOpenThread } from "./state";

export function openThreadPanel(roomId: string, root: string | null, opener?: HTMLElement | null, focusEvent = ""): void {
  setOpenThread(roomId, root, opener ?? null, focusEvent);
  bus.emit("openRightPanel", { roomId, tab: THREADS_TAB });
}
