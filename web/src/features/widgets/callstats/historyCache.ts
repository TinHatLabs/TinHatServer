// callstats/historyCache.ts — the call history's events (contract WIDGETS.md §7, §10.1 rule 10): per joined room the
// call-membership state events of the last 8 days, fetched with a type-filtered /messages walk backwards, cached in
// IndexedDB per account (`tinhat-web-widgets`) and extended from sync. Only runs while a Call stats widget is shown.
// computeHistory (src/widgets/history.ts, the shared logic) turns them into calls, the week and the last call.
import { useEffect, useState } from "react";
import { ClientEvent, Method, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { createLogger } from "@/core/log";
import { onClientChanged, peekClient } from "@/core/matrix";
import { recorderRule } from "@/core/server";
import { onWinState, winState } from "@/core/winstate";
import { FETCH_MS, MEMBER_TYPES, computeHistory, type History, type MemberEvent } from "@/widgets/history";

const log = createLogger("widgets.history");

const DB = "tinhat-web-widgets";
const STORE = "callhist";
/** A page older than now − 8 d − this (clock skew bound) ends the walk; at most MAX_PAGES pages per room. */
const SKEW_MS = 3_600_000;
const MAX_PAGES = 20;
const PAGE = 100;

interface RoomCache {
  v: 1;
  /** timeline order */
  events: MemberEvent[];
  /** the walk reached the 8-day cut or the room's start */
  complete: boolean;
}

// ---- IndexedDB (one object store: `${userId}|${roomId}` → RoomCache) -----------------------------------------------

let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
  return dbp;
}
async function load(key: string): Promise<RoomCache | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const r = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => res((r.result as RoomCache | undefined)?.v === 1 ? (r.result as RoomCache) : null);
      r.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}
async function save(key: string, value: RoomCache): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    d.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
  } catch {
    /* quota / closed: the next start fetches again */
  }
}

// ---- events -------------------------------------------------------------------------------------------------------

/** The part of a membership event the history reads (keeps the cache small). */
function compact(ev: { event_id?: string; type?: string; state_key?: string; sender?: string; origin_server_ts?: number; content?: unknown }): MemberEvent | null {
  if (typeof ev.type !== "string" || !MEMBER_TYPES.includes(ev.type) || typeof ev.state_key !== "string") return null;
  const c = ev.content && typeof ev.content === "object" && !Array.isArray(ev.content) ? (ev.content as Record<string, unknown>) : {};
  const pick = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of ["application", "scope", "device_id", "created_ts", "expires", "expires_ts"]) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  };
  const content = Array.isArray(c.memberships) ? { memberships: (c.memberships as unknown[]).map((m) => (m && typeof m === "object" && !Array.isArray(m) ? pick(m as Record<string, unknown>) : m)) } : pick(c);
  return { id: ev.event_id, type: ev.type, key: ev.state_key, sender: ev.sender ?? "", ts: typeof ev.origin_server_ts === "number" ? ev.origin_server_ts : 0, content };
}

/** Keep the cache bounded: events older than the cut go, except each slot's newest one before it (the slot's state at
 *  the cut — a long refreshed membership keeps an opening event). */
function prune(events: MemberEvent[], now: number): MemberEvent[] {
  const cut = now - FETCH_MS;
  const keepOld = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.ts < cut) keepOld.set(`${e.type}\u0000${e.key}`, i);
  });
  const keep = new Set(keepOld.values());
  return events.filter((e, i) => e.ts >= cut || keep.has(i));
}

async function fetchRoom(c: MatrixClient, roomId: string, known: Set<string>, now: number): Promise<{ events: MemberEvent[]; complete: boolean; stitched: boolean }> {
  const filter = JSON.stringify({ types: MEMBER_TYPES });
  const newestFirst: MemberEvent[] = [];
  let from: string | undefined;
  let complete = false;
  let stitched = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q: Record<string, string> = { dir: "b", limit: String(PAGE), filter };
    if (from) q.from = from;
    const res = (await c.http.authedRequest(Method.Get, `/rooms/${encodeURIComponent(roomId)}/messages`, q)) as { chunk?: unknown[]; end?: string };
    const chunk = Array.isArray(res.chunk) ? res.chunk : [];
    let allOld = chunk.length > 0;
    for (const raw of chunk) {
      const e = compact(raw as Parameters<typeof compact>[0]);
      if (!e) continue;
      if (e.id && known.has(e.id)) {
        stitched = true;
        break;
      }
      newestFirst.push(e);
      if (e.ts >= now - FETCH_MS - SKEW_MS) allOld = false;
    }
    if (stitched) break;
    if (!res.end || !chunk.length || allOld) {
      complete = true;
      break;
    }
    from = res.end;
  }
  return { events: newestFirst.reverse(), complete, stitched };
}

// ---- the store ------------------------------------------------------------------------------------------------------

interface HistState {
  rooms: Map<string, MemberEvent[]>;
  /** rooms still to read */
  pending: number;
  /** rooms read so far (the busy mark's progress) */
  read: number;
  /** rooms whose walk failed (Retry reads them again) */
  failed: string[];
  loaded: boolean;
}
const fresh = (): HistState => ({ rooms: new Map(), pending: 0, read: 0, failed: [], loaded: false });
let state: HistState = fresh();
let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  for (const l of [...listeners]) l();
};
let watching = 0;
let started: MatrixClient | null = null;
let detach: (() => void) | null = null;
const fetched = new Set<string>();

function me(c: MatrixClient): string {
  return c.getUserId() ?? "";
}

/** Read one room: its cache first, then the walk back to the newest cached event; merged with what sync delivered. */
async function readRoom(c: MatrixClient, roomId: string): Promise<boolean> {
  const key = `${me(c)}|${roomId}`;
  try {
    const cached = await load(key);
    const known = new Set((cached?.events ?? []).map((e) => e.id).filter((x): x is string => !!x));
    const now = Date.now();
    const got = await fetchRoom(c, roomId, known, now);
    if (started !== c) return false;
    const base = got.stitched && cached ? cached.events : [];
    const live = state.rooms.get(roomId) ?? [];
    const ids = new Set<string>();
    const merged: MemberEvent[] = [];
    for (const e of [...base, ...got.events, ...live]) {
      if (e.id) {
        if (ids.has(e.id)) continue;
        ids.add(e.id);
      }
      merged.push(e);
    }
    const events = prune(merged, now);
    state.rooms.set(roomId, events);
    fetched.add(roomId);
    void save(key, { v: 1, events, complete: got.complete || got.stitched });
    return true;
  } catch (e) {
    log.debug(`history ${roomId}: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

async function startFor(c: MatrixClient) {
  started = c;
  fetched.clear();
  state = fresh();
  const rooms = c.getRooms().filter((r: Room) => r.getMyMembership() === "join" && !r.isSpaceRoom());
  state.pending = rooms.length;
  bump();
  // live events first, so nothing slips between the fetch and the listener
  const onTimeline = (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined) => {
    if (toStart || !room || !MEMBER_TYPES.includes(ev.getType()) || ev.getStateKey() === undefined) return;
    const e = compact({ event_id: ev.getId(), type: ev.getType(), state_key: ev.getStateKey(), sender: ev.getSender(), origin_server_ts: ev.getTs(), content: ev.getContent() });
    if (!e) return;
    const list = state.rooms.get(room.roomId) ?? [];
    if (e.id && list.some((x) => x.id === e.id)) return;
    state.rooms.set(room.roomId, [...list, e]);
    // only a room whose walk is done is saved (a cache holding just the newest event would stop the next walk at it)
    if (fetched.has(room.roomId)) void save(`${me(c)}|${room.roomId}`, { v: 1, events: state.rooms.get(room.roomId)!, complete: true });
    bump();
  };
  c.on(RoomEvent.Timeline, onTimeline);
  detach = () => c.off(RoomEvent.Timeline, onTimeline);
  // one room at a time (low priority)
  for (const r of rooms) {
    if (started !== c) return;
    const ok = await readRoom(c, r.roomId);
    if (started !== c) return;
    if (!ok) state.failed = [...state.failed, r.roomId];
    state.pending--;
    state.read++;
    bump();
  }
  state.loaded = true;
  bump();
}

/** Read the rooms whose walk failed again ("Couldn't read some rooms · Retry"). */
export async function retryHistory(): Promise<void> {
  const c = started;
  if (!c || !state.failed.length || state.pending) return;
  const rooms = state.failed;
  state.failed = [];
  state.pending = rooms.length;
  bump();
  for (const id of rooms) {
    if (started !== c) return;
    const ok = await readRoom(c, id);
    if (started !== c) return;
    if (!ok) state.failed = [...state.failed, id];
    state.pending--;
    bump();
  }
}

onClientChanged(() => {
  detach?.();
  detach = null;
  started = null;
  state = fresh();
  bump();
});

function ensureStarted() {
  const c = peekClient();
  if (!c || started === c || !watching) return;
  if (!c.getRooms().length) {
    // the first sync hasn't delivered the rooms yet
    const once = () => {
      c.off(ClientEvent.Sync, once);
      ensureStarted();
    };
    c.on(ClientEvent.Sync, once);
    return;
  }
  void startFor(c);
}

export interface HistoryView {
  history: History | null;
  /** rooms still to read / read so far / failed */
  pending: number;
  read: number;
  failed: number;
  loaded: boolean;
  /** when `history` was computed (ms) — the "… ago" labels use it */
  at: number;
}

export const NO_HISTORY: HistoryView = { history: null, pending: 0, read: 0, failed: 0, loaded: false, at: 0 };

/** React: the call history (recomputed on a change, at most every 5 s focused / 60 s otherwise; the minute labels
 *  re-render once a minute). */
export function useCallHistory(enabled: boolean): HistoryView {
  const [view, setView] = useState<HistoryView>(NO_HISTORY);
  useEffect(() => {
    if (!enabled) return;
    watching++;
    ensureStarted();
    let last = 0;
    let t = 0;
    let seen = -1;
    const run = () => {
      t = 0;
      const c = peekClient();
      if (!c) return;
      last = Date.now();
      seen = version;
      const rooms = [...state.rooms].map(([room, events]) => ({ room, events }));
      const history = computeHistory({ me: me(c), now: last, rooms, recorder: recorderRule() });
      setView({ history, pending: state.pending, read: state.read, failed: state.failed.length, loaded: state.loaded, at: last });
    };
    const schedule = () => {
      if (t) return;
      // while the rooms are still being read: every second (the progress), then 5 s focused / 60 s otherwise
      const gap = !state.loaded || state.pending ? 1000 : winState() === "focused" ? 5000 : 60_000;
      t = window.setTimeout(run, Math.max(0, last + gap - Date.now()));
    };
    const onChange = () => {
      if (version !== seen) schedule();
    };
    listeners.add(onChange);
    run();
    // the "… ago" labels and ongoing calls: one timeout at the next minute boundary, again and again (≥ 60 s apart)
    let minute = 0;
    const tick = () => {
      schedule();
      minute = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    minute = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    const offWin = onWinState((st) => st === "focused" && schedule());
    return () => {
      watching--;
      listeners.delete(onChange);
      if (t) window.clearTimeout(t);
      window.clearTimeout(minute);
      offWin();
    };
  }, [enabled]);
  return view;
}
