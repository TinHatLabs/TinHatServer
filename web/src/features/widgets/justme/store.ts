// justme/store.ts — "Is it just me?" (WIDGETS.md §20): ONE checker for the whole app, running while a widget shows it.
// A check = the homeserver's `/_matrix/client/versions` three times in a row (Chat's answer + your ping, the median),
// then at once: the call JWT service's `/healthz` (the focus new calls use), the media repo's
// `/_matrix/client/v1/media/config` (with the bearer) and the Tin Hat server's `/api/presence` (no bearer: its 401 is
// an answer) — each aborted after TIMEOUT_MS; plus the time since the last sync that answered (core/matrix syncAgeMs).
// The verdict is the shared logic's (src/widgets/justme.ts, the desktop runs the same vectors).
// Cadence = the widget's registry refresh: every 60 s while the window is focused, every 5 min unfocused (the RENDER
// window state, core/winstate.ts), NEVER while hidden; on show and when a widget appears, one check after 3 s (a resumed
// sync answers first; a starting app is busy);
// "Check again" runs one now. The last 10 minutes stay in memory for the Large sparkline.
import { useEffect, useSyncExternalStore } from "react";
import { apiUrl } from "@/core/api";
import { bearerAllowed } from "@/core/bearer";
import { getAccessToken, getSession, onSessionEnding, peekClient, syncAgeMs } from "@/core/matrix";
import { onWinState, winState } from "@/core/winstate";
import { createLogger } from "@/core/log";
import { focusServiceUrl } from "@/features/calls";
import { refreshMs, widgetDef } from "@/widgets/registry";
import { SLOT_MS, SPARK_SLOTS, TIMEOUT_MS, checkOf, type Check, type Probe, type Sample } from "@/widgets/justme";

const log = createLogger("justme");

export type SeriesId = "chat" | "calls" | "media" | "tinhat" | "ping";

export interface JmState {
  /** the last check (null = none yet) */
  check: Check | null;
  /** when it finished (ms) */
  at: number | null;
  /** a check is running */
  running: boolean;
  /** the last 10 minutes per row (the Large sparkline) */
  history: Record<SeriesId, Sample[]>;
  rev: number;
}

const EMPTY_HISTORY = (): Record<SeriesId, Sample[]> => ({ chat: [], calls: [], media: [], tinhat: [], ping: [] });
let state: JmState = { check: null, at: null, running: false, history: EMPTY_HISTORY(), rev: 0 };
const listeners = new Set<() => void>();
function set(patch: Partial<JmState>) {
  state = { ...state, ...patch, rev: state.rev + 1 };
  for (const l of [...listeners]) l();
}
export function jmState(): JmState {
  return state;
}

const DEF = widgetDef("justMe");
const FOCUSED_MS = refreshMs(DEF?.refresh.focused ?? "60s") || 60_000;
const UNFOCUSED_MS = refreshMs(DEF?.refresh.unfocused ?? "300s") || 300_000;
/** after the window shows again: let a resumed sync answer before its age is read */
const ON_SHOW_MS = 3_000;

let consumers = 0;
let timer = 0;
let offWin: (() => void) | null = null;

function schedule(ms?: number) {
  window.clearTimeout(timer);
  timer = 0;
  if (consumers <= 0) return;
  const ws = winState();
  if (ws === "hidden") return; // never while hidden; resumes on show (onWinState)
  timer = window.setTimeout(() => void checkNow(), ms ?? (ws === "focused" ? FOCUSED_MS : UNFOCUSED_MS));
}

/** One request: its status (null = no answer) and the round trip to the response headers. */
async function probe(url: string, headers?: Record<string, string>): Promise<Probe> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { cache: "no-store", credentials: "omit", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = performance.now() - t0;
    void r.body?.cancel().catch(() => undefined);
    return { status: r.status, ms };
  } catch {
    return { status: null, ms: null };
  }
}

function push(list: Sample[], sample: Sample): Sample[] {
  const from = sample.at - SPARK_SLOTS * SLOT_MS;
  return [...list.filter((x) => x.at > from), sample].slice(-2 * SPARK_SLOTS);
}

/** Run a check now (no-op while one runs or while the window is hidden). */
export async function checkNow(): Promise<void> {
  if (state.running || winState() === "hidden") return;
  const hs = (peekClient()?.baseUrl || getSession().hsUrl || "").replace(/\/+$/, "");
  if (!hs) return;
  window.clearTimeout(timer);
  timer = 0;
  set({ running: true });
  try {
    const versions = `${hs}/_matrix/client/versions`;
    const pings: Probe[] = [];
    for (let i = 0; i < 3; i++) pings.push(await probe(versions));
    const mediaUrl = `${hs}/_matrix/client/v1/media/config`;
    const token = getAccessToken();
    const [calls, media, tinhat] = await Promise.all([
      focusServiceUrl()
        .then((u) => probe(`${u.replace(/\/+$/, "")}/healthz`))
        .catch(() => ({ status: null, ms: null }) as Probe),
      probe(mediaUrl, token && bearerAllowed(mediaUrl) ? { Authorization: `Bearer ${token}` } : undefined),
      probe(new URL(apiUrl("/presence"), location.href).href),
    ]);
    const check = checkOf({ pings, syncAgoMs: syncAgeMs(), calls, media, tinhat });
    const at = Date.now();
    const h = { ...state.history };
    for (const row of check.rows) h[row.id as SeriesId] = push(h[row.id as SeriesId], { at, band: row.band, ms: row.ms });
    h.ping = push(h.ping, { at, band: check.ping.band, ms: check.ping.ms });
    set({ check, at, running: false, history: h });
    if (check.verdict.tone === "poor") log.info(`check: ${check.verdict.text}`);
  } catch (e) {
    log.info(`check failed: ${(e as Error)?.message ?? e}`);
    set({ running: false });
  } finally {
    if (state.running) set({ running: false });
    schedule();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const snap = () => state;

/** React: the state, and keep the checker running while mounted (`active` false = read only). */
export function useJustMe(active = true): JmState {
  useEffect(() => {
    if (!active) return;
    consumers += 1;
    if (consumers === 1) {
      offWin = onWinState((now, prev) => {
        if (now === "hidden") schedule();
        else if (prev === "hidden") schedule(ON_SHOW_MS);
        else if (!state.running) schedule(); // focused ↔ unfocused: the new cadence from now
      });
      // a widget appeared: check in 3 s (the app may still be loading — a busy start reads as a slow network) unless the
      // last check is recent
      if (!state.check || (state.at !== null && Date.now() - state.at > FOCUSED_MS)) schedule(ON_SHOW_MS);
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

/** Sign-out / account switch: forget everything. */
export function resetJustMe(): void {
  set({ check: null, at: null, running: false, history: EMPTY_HISTORY() });
}

onSessionEnding(() => resetJustMe());
