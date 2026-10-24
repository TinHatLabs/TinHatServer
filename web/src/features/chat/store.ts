// store.ts — chat-wide state that outlives one ConversationView: per-room memory (draft, reply target,
// staged files, scroll), the upload echoes, drafts persistence (`chat-drafts`, 1.5 s debounce, max 40),
// floating chats and the "attending" registry (which view shows which room, focused).
import { create } from "zustand";
import { getPref, setPref } from "@/core/prefs";
import { bus, openRoom } from "@/core/bus";
import type { UploadEcho } from "./lib/model";

export interface StagedFile {
  id: string;
  file: File;
  url: string; // object URL (images) or ""
  isImage: boolean;
}

export interface RoomMemory {
  draft: string;
  replyToId: string;
  replyToBody: string;
  replyToName: string;
  staged: StagedFile[];
  atBottom: boolean;
  topId: string;
}

export interface FloatingChat {
  roomId: string;
  minimized: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

interface ChatStore {
  memory: Record<string, RoomMemory>;
  uploads: UploadEcho[];
  floating: FloatingChat[];
  zTop: number;
  /** room shown (and attended) by the main view */
  mainRoom: string | null;
  mainAttending: boolean;
  remember(roomId: string, m: RoomMemory): void;
  addUpload(u: UploadEcho): void;
  patchUpload(id: string, p: Partial<UploadEcho>): void;
  dropUpload(id: string): void;
}

export const useChatStore = create<ChatStore>()((set) => ({
  memory: {},
  uploads: [],
  floating: [],
  zTop: 1,
  mainRoom: null,
  mainAttending: false,
  remember: (roomId, m) => {
    set((s) => ({ memory: { ...s.memory, [roomId]: m } }));
    schedulePersist();
  },
  addUpload: (u) => set((s) => ({ uploads: [...s.uploads, u] })),
  patchUpload: (id, p) => set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...p } : u)) })),
  dropUpload: (id) =>
    set((s) => {
      const u = s.uploads.find((x) => x.id === id);
      if (u) URL.revokeObjectURL(u.localUrl);
      return { uploads: s.uploads.filter((x) => x.id !== id) };
    }),
}));

// ---- drafts persistence (AppCore:833-858) ------------------------------------------------------
interface PersistedDraft {
  draft?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToName?: string;
}
let persistTimer = 0;
function schedulePersist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persistChatMemory, 1500);
}
export function persistChatMemory() {
  const mem = useChatStore.getState().memory;
  const out: Record<string, PersistedDraft> = {};
  let n = 0;
  for (const [roomId, m] of Object.entries(mem)) {
    if (!m.draft && !m.replyToId) continue;
    if (n++ >= 40) break;
    const e: PersistedDraft = {};
    if (m.draft) e.draft = m.draft;
    if (m.replyToId) {
      e.replyToId = m.replyToId;
      e.replyToBody = m.replyToBody;
      e.replyToName = m.replyToName;
    }
    out[roomId] = e;
  }
  setPref("chat-drafts", JSON.stringify(out));
}

let restored = false;
/** Restore drafts + reply targets at sign-in (once per session). */
export function restoreChatMemory() {
  if (restored) return;
  restored = true;
  let raw: unknown = getPref("chat-drafts", "");
  try {
    if (typeof raw === "string") raw = raw ? JSON.parse(raw) : {};
  } catch {
    raw = {};
  }
  if (!raw || typeof raw !== "object") return;
  const memory: Record<string, RoomMemory> = {};
  for (const [roomId, v] of Object.entries(raw as Record<string, PersistedDraft>)) {
    memory[roomId] = {
      draft: v.draft ?? "",
      replyToId: v.replyToId ?? "",
      replyToBody: v.replyToBody ?? "",
      replyToName: v.replyToName ?? "",
      staged: [],
      atBottom: true,
      topId: "",
    };
  }
  useChatStore.setState((s) => ({ memory: { ...memory, ...s.memory } }));
}
bus.on("loggedOut", () => {
  restored = false;
  const st = useChatStore.getState();
  for (const u of st.uploads) URL.revokeObjectURL(u.localUrl);
  for (const m of Object.values(st.memory)) for (const f of m.staged) if (f.url) URL.revokeObjectURL(f.url);
  useChatStore.setState({ memory: {}, uploads: [], floating: [] });
});

// ---- floating chats (floating.rs) ---------------------------------------------------------------
export const MAX_FLOATING = 6;

export function openFloatingChat(roomId: string): void {
  // phones have no floating chats (ARCHITECTURE mobile rules): "Pop out chat" opens the room instead
  // (the layer renders nothing there, so the entry used to be dead)
  if (typeof document !== "undefined" && document.documentElement.dataset.ff === "mobile") {
    openRoom(roomId);
    return;
  }
  const st = useChatStore.getState();
  const open = st.floating.find((f) => f.roomId === roomId);
  const z = st.zTop + 1;
  if (open) {
    useChatStore.setState({ floating: st.floating.map((f) => (f.roomId === roomId ? { ...f, minimized: false, z } : f)), zTop: z });
    return;
  }
  if (st.floating.length >= MAX_FLOATING) {
    bus.emit("toast", { message: "You can have 6 popped-out chats at once — close one first" });
    return;
  }
  const w = Math.max(280, Math.min(7999, Number(getPref("bubble-w", 380)) || 380));
  const h = Math.max(240, Math.min(7999, Number(getPref("bubble-h", 520)) || 520));
  const n = st.floating.length;
  const x = Math.max(0, Math.min(window.innerWidth - w - 8, 24 + n * 28));
  const y = Math.max(0, Math.min(window.innerHeight - h - 8, 24 + n * 28));
  useChatStore.setState({ floating: [...st.floating, { roomId, minimized: false, x, y, w, h, z }], zTop: z });
}

export function closeFloatingChat(roomId: string): void {
  useChatStore.setState((s) => ({ floating: s.floating.filter((f) => f.roomId !== roomId) }));
}

export function patchFloating(roomId: string, p: Partial<FloatingChat>): void {
  useChatStore.setState((s) => ({ floating: s.floating.map((f) => (f.roomId === roomId ? { ...f, ...p } : f)) }));
}

export function raiseFloating(roomId: string): void {
  const z = useChatStore.getState().zTop + 1;
  useChatStore.setState((s) => ({ floating: s.floating.map((f) => (f.roomId === roomId ? { ...f, z } : f)), zTop: z }));
}

// ---- cross-view hooks (host API) ----------------------------------------------------------------
type Fn = (...a: never[]) => void;
const handles = new Map<string, { jumpTo: (eventId: string) => void; focusComposer: () => void; stageFiles: (f: File[]) => void }>();
export function registerView(key: string, h: { jumpTo: (eventId: string) => void; focusComposer: () => void; stageFiles: (f: File[]) => void }): () => void {
  handles.set(key, h);
  return () => {
    if (handles.get(key) === h) handles.delete(key);
  };
}
export function mainView() {
  return handles.get("main");
}
export function getView(key: string) {
  return handles.get(key);
}
export type { Fn };
