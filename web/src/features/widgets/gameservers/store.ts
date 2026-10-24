// gameservers/store.ts — the Game servers status for the whole app (docs/GAMESERVERS.md §4–§6): ONE poller of the Tin
// Hat server's /api/gameservers/status, running while something shows it (the widget, an Up next event whose game has a
// server, a visible calendar card): `useGameServers()` subscribes. Cadence = the widget's registry refresh (focused 15 s,
// unfocused 60 s — the RENDER window state, core/winstate.ts), 3 s while a power action is pending (≤ 3 min), nothing
// while hidden (one refresh on show). A 403 (not a member of the governing space) rests the poller for 30 minutes.
// Power requests (POST /api/gameservers/power) go through `powerAction`, which also posts the announcement notice (§6).
import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "@/core/api";
import { peekClient } from "@/core/matrix";
import { onWinState, winState } from "@/core/winstate";
import { createLogger } from "@/core/log";
import { refreshMs, widgetDef } from "@/widgets/registry";
import { noticeText, readStatus, type GameStatus, type PowerAction } from "@/widgets/gameservers";

const log = createLogger("gameservers");

export type GsError = "not-member" | "network" | "off" | null;

export interface GsState {
  /** the last good answer (kept through network trouble) */
  status: GameStatus | null;
  /** why the last refresh failed (null = it didn't) */
  error: GsError;
  /** no answer yet */
  loading: boolean;
  /** bumps on every change (for memo keys) */
  rev: number;
}

let state: GsState = { status: null, error: null, loading: true, rev: 0 };
const listeners = new Set<() => void>();
function set(patch: Partial<GsState>) {
  state = { ...state, ...patch, rev: state.rev + 1 };
  for (const l of [...listeners]) l();
}
export function gsState(): GsState {
  return state;
}

// ---- the poller -----------------------------------------------------------------------------------------------------

const DEF = widgetDef("gameServers");
const FOCUSED_MS = refreshMs(DEF?.refresh.focused ?? "15s") || 15_000;
const UNFOCUSED_MS = refreshMs(DEF?.refresh.unfocused ?? "60s") || 60_000;
const PENDING_MS = 3_000;
const PENDING_MAX_MS = 3 * 60_000;
const NOT_MEMBER_REST_MS = 30 * 60_000;

let consumers = 0;
let timer = 0;
let inflight = false;
let restUntil = 0;
let fastUntil = 0;
let offWin: (() => void) | null = null;
/** the dev / gate hook holds a fixed status: the poller asks nothing until it is released */
let mocked = false;

function hasPending(st: GameStatus | null): boolean {
  return !!st && (st.servers.some((s) => s.pending !== null || s.state === "starting" || s.state === "stopping") || st.job?.step === "stopping" || st.job?.step === "starting");
}

function schedule() {
  window.clearTimeout(timer);
  timer = 0;
  if (consumers <= 0) return;
  const ws = winState();
  if (ws === "hidden") return; // resumes on show (onWinState)
  let ms = ws === "focused" ? FOCUSED_MS : UNFOCUSED_MS;
  if (hasPending(state.status) && Date.now() < fastUntil) ms = PENDING_MS;
  if (restUntil > Date.now()) ms = Math.max(ms, restUntil - Date.now());
  timer = window.setTimeout(() => void refresh(), ms);
}

/** Ask the Tin Hat server now (no-op while a request is out). */
export async function refresh(): Promise<void> {
  if (inflight || mocked) return;
  if (restUntil > Date.now() && state.error === "not-member") return schedule();
  inflight = true;
  try {
    const r = await apiFetch("/gameservers/status", { auth: true, timeoutMs: 12000 });
    if (r.status === 403) {
      restUntil = Date.now() + NOT_MEMBER_REST_MS;
      set({ status: null, error: "not-member", loading: false });
    } else if (r.status === 503) {
      set({ error: "off", loading: false });
    } else if (!r.ok) {
      set({ error: "network", loading: false });
    } else {
      const st = readStatus(await r.json().catch(() => null));
      if (st) {
        restUntil = 0;
        set({ status: st, error: null, loading: false });
      } else set({ error: "network", loading: false });
    }
  } catch (e) {
    log.info(`refresh failed: ${(e as Error)?.message ?? e}`);
    set({ error: "network", loading: false });
  } finally {
    inflight = false;
    schedule();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const snap = () => state;

/** React: the status, and keep the poller running while mounted (`active` false = read only, don't poll). */
export function useGameServers(active = true): GsState {
  useEffect(() => {
    if (!active) return;
    consumers += 1;
    if (consumers === 1) {
      offWin = onWinState((now) => {
        if (now !== "hidden" && !timer && !inflight) void refresh();
        else schedule();
      });
      void refresh();
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

/** Sign-out / account switch: forget everything. */
export function resetGameServers(): void {
  restUntil = 0;
  set({ status: null, error: null, loading: true });
}

// ---- power ----------------------------------------------------------------------------------------------------------

export interface PowerResult {
  ok: boolean;
  /** the server's words when it refused / failed */
  error?: string;
  code?: string;
}

/** The actor's name for the notice: their display name in the room, else their global one, else the localpart. */
function actorName(roomId: string): string {
  const c = peekClient();
  const me = c?.getUserId() ?? "";
  const m = me && roomId ? c?.getRoom(roomId)?.getMember(me) : null;
  const local = me.replace(/^@/, "").split(":")[0] ?? me;
  return m?.name || c?.getUser(me)?.displayName || local;
}

/** Post the announcement (§6) in the configured room when this account is joined there; failures are logged only. */
async function announce(st: GameStatus, action: PowerAction, id: string, firstId: string | null): Promise<void> {
  const room = st.announceRoom;
  const c = peekClient();
  if (!room || !c) return;
  if (c.getRoom(room)?.getMyMembership() !== "join") return;
  const name = st.servers.find((s) => s.id === id)?.name ?? id;
  const first = firstId ? (st.servers.find((s) => s.id === firstId)?.name ?? firstId) : null;
  const body = noticeText(actorName(room), action, name, first);
  try {
    await c.sendMessage(room, { msgtype: "m.notice", body } as never);
  } catch (e) {
    log.warn(`the notice was not posted: ${(e as Error)?.message ?? e}`);
  }
}

/** Start / stop / restart `id` (with `firstId` stopped first: the switch). Refreshes fast until the state settles. */
export async function powerAction(action: PowerAction, id: string, firstId: string | null = null): Promise<PowerResult> {
  const before = state.status;
  let r: Response;
  try {
    r = await apiFetch("/gameservers/power", { auth: true, method: "POST", json: firstId ? { server: id, action, stopFirst: firstId } : { server: id, action }, timeoutMs: 20000 });
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || "Couldn't reach the server", code: "network" };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await r.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const error = typeof body?.error === "string" && body.error ? body.error : `The server said ${r.status}`;
    return { ok: false, error, code: typeof body?.code === "string" ? body.code : undefined };
  }
  fastUntil = Date.now() + PENDING_MAX_MS;
  if (before) void announce(before, action, id, firstId);
  void refresh();
  return { ok: true };
}

// ---- the dev / gate hook: a fixed status instead of the live one ------------------------------------------------------

/** Show `st` everywhere the status is read (the widget's samples; gates): the poller keeps running but is ignored. */
export function setGameServersMock(st: GameStatus | null, error: GsError = null): void {
  if (st === null && error === null) {
    mocked = false;
    set({ status: null, error: null, loading: true });
    void refresh();
    return;
  }
  mocked = true;
  set({ status: st, error, loading: false });
}
