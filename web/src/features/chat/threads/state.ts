// threads/state.ts — the Threads panel (docs/THREADS.md): per room, the open thread (null = the list) and the list's
// filter. The panel is the right panel's "Threads" tab (spaces' RightPanel hosts it through r.rightPanelTabs); on
// phones that is the full-screen sheet with Back (thread → list → room).
import { create } from "zustand";

export const THREADS_TAB = "threads";

interface ThreadsPanelState {
  /** roomId → the open thread's root (absent / null = the list) */
  open: Record<string, string | null>;
  filter: "all" | "mine";
  /** where focus goes back to when the thread closes (the summary or menu that opened it) */
  opener: HTMLElement | null;
  /** roomId → a message of the open thread to centre (a jump / permalink to a reply) */
  focus: Record<string, string>;
  /** a new jump each time, also to the same reply (the thread view remounts on it) */
  focusSeq: number;
  /** roomId → how many pages of the server's thread list are shown ("Load more threads"; kept while a thread is open) */
  pages: Record<string, number>;
}

export const useThreadsPanel = create<ThreadsPanelState>()(() => ({ open: {}, filter: "all", opener: null, focus: {}, focusSeq: 0, pages: {} }));

/** threads (PM 2026-11-14, Android Back = history back): at phone widths — a phone, or the right panel overlaying the
 *  room in a narrow window — an open thread is a level of the back stack, so Back closes the thread (to the list)
 *  before the panel, and the panel before the room. A docked panel on a wide page is not (Back leaves the room). */
/** The open thread's level on the back stack: inside the panel's (0), so Back closes it first even when both register in
 *  one commit. */
export const THREAD_BACK_LEVEL = 1;

export function threadTakesBack(o: { threadOpen: boolean; phone: boolean; overlay: boolean }): boolean {
  return o.threadOpen && (o.phone || o.overlay);
}

export function moreThreadPages(roomId: string): void {
  useThreadsPanel.setState((s) => ({ pages: { ...s.pages, [roomId]: (s.pages[roomId] ?? 1) + 1 } }));
}

export function threadOpenIn(roomId: string): string | null {
  return useThreadsPanel.getState().open[roomId] ?? null;
}
export function setOpenThread(roomId: string, root: string | null, opener?: HTMLElement | null, focusEvent = ""): void {
  useThreadsPanel.setState((s) => ({
    open: { ...s.open, [roomId]: root },
    opener: opener === undefined ? s.opener : opener,
    focus: { ...s.focus, [roomId]: focusEvent },
    focusSeq: focusEvent ? s.focusSeq + 1 : s.focusSeq,
  }));
}
export function setThreadsFilter(filter: "all" | "mine"): void {
  useThreadsPanel.setState({ filter });
}
