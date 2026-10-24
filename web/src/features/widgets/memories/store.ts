// memories/store.ts — the Memories widget's data (WIDGETS.md §21): ONE reader for the whole app, running while a widget
// shows it. The rooms = the joined rooms that have a recording marker (`dev.tinhat.record`, any content: recording
// was set up there at least once — only they can hold memories), at most MAX_ROOMS; each is read with the Memories
// window's own request (`GET /api/vods/sessions?room=…`, the bearer; its rate bucket is 60 / min per client), one room
// after another. The list is the shared logic's (src/widgets/memories.ts). Cadence = the widget's registry refresh:
// on show, then every 5 min focused / 15 min unfocused (the RENDER window state), never while hidden; "Retry" asks now.
// Posters: each memory's frame is fetched ONCE per page (a blob in memory, one request at a time, ≤ 3 tries 2.5 s
// apart — the server renders it with ffmpeg and answers 503 while busy): a list refresh or a remount never asks again.
import { useEffect, useSyncExternalStore } from "react";
import { peekClient, onSessionEnding } from "@/core/matrix";
import { onWinState, winState } from "@/core/winstate";
import { createLogger } from "@/core/log";
import { fetchSessions, thumbUrl, type VodSession } from "@/features/media";
import { refreshMs, widgetDef } from "@/widgets/registry";
import type { MemRoom } from "@/widgets/memories";

const log = createLogger("memories-widget");

/** Recording is set up in a room = it has this state event. */
export const RECORD_TYPE = "dev.tinhat.record";
/** At most this many rooms are read per refresh. */
export const MAX_ROOMS = 12;

export interface MemState {
  /** every read room's sessions (the last good answer per room) */
  rooms: MemRoom[];
  /** a refresh is running and nothing was read yet */
  loading: boolean;
  /** the last refresh failed for every room and nothing is cached */
  error: boolean;
  /** when the last refresh finished */
  at: number | null;
  rev: number;
}

let state: MemState = { rooms: [], loading: true, error: false, at: null, rev: 0 };
const listeners = new Set<() => void>();
function set(patch: Partial<MemState>) {
  state = { ...state, ...patch, rev: state.rev + 1 };
  for (const l of [...listeners]) l();
}

const DEF = widgetDef("memories");
const FOCUSED_MS = refreshMs(DEF?.refresh.focused ?? "300s") || 300_000;
const UNFOCUSED_MS = refreshMs(DEF?.refresh.unfocused ?? "900s") || 900_000;

let consumers = 0;
let timer = 0;
let running = false;
let offWin: (() => void) | null = null;

/** The joined rooms with a recording marker: [{room, name}]. */
function recordRooms(): { room: string; name: string }[] {
  const c = peekClient();
  if (!c) return [];
  const out: { room: string; name: string }[] = [];
  for (const r of c.getRooms()) {
    if (r.getMyMembership() !== "join") continue;
    if (!r.currentState.getStateEvents(RECORD_TYPE, "")) continue;
    out.push({ room: r.roomId, name: r.name || "" });
  }
  out.sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0));
  return out.slice(0, MAX_ROOMS);
}

function schedule(ms?: number) {
  window.clearTimeout(timer);
  timer = 0;
  if (consumers <= 0) return;
  const ws = winState();
  if (ws === "hidden") return;
  timer = window.setTimeout(() => void refreshMemories(), ms ?? (ws === "focused" ? FOCUSED_MS : UNFOCUSED_MS));
}

/** Read every recording room now (no-op while a refresh runs or the window is hidden). */
export async function refreshMemories(): Promise<void> {
  if (running || winState() === "hidden" || !peekClient()) return;
  running = true;
  window.clearTimeout(timer);
  timer = 0;
  try {
    const rooms = recordRooms();
    const prev = new Map(state.rooms.map((r) => [r.room, r]));
    const next: MemRoom[] = [];
    let failed = 0;
    for (const r of rooms) {
      try {
        next.push({ room: r.room, name: r.name, sessions: await fetchSessions(r.room) });
      } catch (e) {
        failed++;
        log.info(`sessions of ${r.room}: ${(e as Error)?.message ?? e}`);
        const old = prev.get(r.room);
        if (old) next.push({ ...old, name: r.name });
      }
    }
    set({ rooms: next, loading: false, error: rooms.length > 0 && failed === rooms.length && next.length === 0, at: Date.now() });
  } finally {
    running = false;
    schedule();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const snap = () => state;

/** React: the state, and keep the reader running while mounted. */
export function useMemoriesData(active = true): MemState {
  useEffect(() => {
    if (!active) return;
    consumers += 1;
    if (consumers === 1) {
      offWin = onWinState((now, prev) => {
        if (now === "hidden") schedule();
        else if (prev === "hidden") {
          // back on screen: read now if the last read is older than the cadence, else keep the schedule
          if (state.at === null || Date.now() - state.at >= (now === "focused" ? FOCUSED_MS : UNFOCUSED_MS)) void refreshMemories();
          else schedule();
        } else schedule();
      });
      if (state.at === null || Date.now() - state.at >= FOCUSED_MS) void refreshMemories();
      else schedule();
    }
    return () => {
      consumers -= 1;
      if (consumers <= 0) {
        consumers = 0;
        window.clearTimeout(timer);
        timer = 0;
        offWin?.();
        offWin = null;
      }
    };
  }, [active]);
  return useSyncExternalStore(subscribe, snap, snap);
}

// ---- posters: fetched once, kept as blobs ------------------------------------------------------------------------

const posters = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

/** The raw session of a memory (the store's last answer). */
export function sessionOf(room: string, id: string): VodSession | null {
  const r = state.rooms.find((x) => x.room === room);
  const list = Array.isArray(r?.sessions) ? (r!.sessions as VodSession[]) : [];
  return list.find((s) => s && s.id === id) ?? null;
}

/** An object URL of a memory's poster frame (`file` at second `t`), fetched once per page; null = none. */
export function posterBlob(room: string, id: string, file: string, t: number): Promise<string | null> {
  const key = `${room}\u0000${id}\u0000${file}\u0000${t}`;
  const have = posters.get(key);
  if (have) return have;
  const p = (queue = queue.then(async () => {
    const track = sessionOf(room, id)?.tracks.find((x) => x.file === file);
    if (!track?.url) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(thumbUrl(track.url, t, attempt), { cache: "no-store", signal: AbortSignal.timeout(15_000) });
        if (r.ok) return URL.createObjectURL(await r.blob());
        if (r.status !== 503 && r.status !== 429) return null;
      } catch {
        /* retry */
      }
      await new Promise((res) => window.setTimeout(res, 2500));
    }
    return null;
  })) as Promise<string | null>;
  posters.set(key, p);
  // a failure may be retried by the next refresh
  void p.then((u) => {
    if (u === null) posters.delete(key);
  });
  return p;
}

onSessionEnding(() => {
  set({ rooms: [], loading: true, error: false, at: null });
  for (const p of posters.values()) void p.then((u) => u && URL.revokeObjectURL(u));
  posters.clear();
});
