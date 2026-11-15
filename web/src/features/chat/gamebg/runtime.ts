// runtime.ts — "Match the game" (lane sun-gamebg): which game a room shows, live. The inputs are only what this device
// already has: the Reach statuses of the room's joined members who SHARE them (the presence service lists nobody
// else), the room's Now playing (`dev.tinhat.activity`) and who is in the room's call. A status counts only when its
// text names a game in the person's OWN server's catalogue (POST /api/games/resolve — a local lookup there, never
// forwarded). The answer goes through the stabiliser (model.ts stepStable): the first look as soon as the inputs are
// known, then at most one change per 3 minutes. No work while the chat or the app is hidden (no lookups, no timers).
//
//   useGameBackdrop(roomId, roomBg, spaceBg?, visible?)  → { src, gameId, mode }   (src null = draw nothing)
import { useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { apiJson } from "@/core/api";
import { usePref } from "@/core/prefs";
import { peekClient, useMembers, useRoomState } from "@/core/matrix";
import { serverFeatureOn } from "@/core/server/store";
import { createLogger } from "@/core/log";
import { CATALOG_BASE } from "@/features/calendar";
import { usePresenceStore } from "@/features/presence";
import { useCallParticipants } from "@/features/callui/Incoming";
import { useLiveWin } from "../ambience/layer";
import { PREF_BACKGROUNDS, prefOn } from "../ambience/core";
import { artMode, backgroundUrl, gameKey, nextStepIn, pickGame, stepStable, PREF_GAME_ART, type Claim, type Stable } from "./model";

const log = createLogger("gamebg");
const ACTIVITY_TYPE = "dev.tinhat.activity";
const HIT_TTL_MS = 6 * 3600_000;
const MISS_TTL_MS = 10 * 60_000;
const FAIL_RETRY_MS = 60_000;
/** the first look waits this long at most for the presence list (a server without presence still gets a look) */
const READY_WAIT_MS = 8_000;

/** The two personal switches: "Show chat backgrounds" (sun-ambience) and "Game art backgrounds" (default ON). */
export function useGameArtPrefs(): { backgrounds: boolean; gameArt: boolean } {
  const bg = usePref(PREF_BACKGROUNDS, "");
  const ga = usePref(PREF_GAME_ART, "");
  return { backgrounds: prefOn(bg, true), gameArt: prefOn(ga, true) };
}

// ---- session-scoped caches: a new account or server starts empty (nothing of one session leaks into the next) --------
interface Resolved {
  id: string | null;
  at: number;
  ttl: number;
}
let scope = "";
let gen = 0;
const resolved = new Map<string, Resolved>();
/** user → their current status text and when this device first saw THAT text (a change restarts the clock) */
const current = new Map<string, { text: string; at: number }>();
const stable = new Map<string, Stable>();
const openedAt = new Map<string, number>();
function checkScope(): void {
  const s = `${peekClient()?.getUserId() ?? ""}|${CATALOG_BASE}`;
  if (s === scope) return;
  scope = s;
  gen++;
  resolved.clear();
  current.clear();
  stable.clear();
  openedAt.clear();
}
function statusAt(user: string, text: string, now: number): number {
  const c = current.get(user);
  if (c && c.text === text) return c.at;
  current.delete(user);
  current.set(user, { text, at: now });
  if (current.size > 5000) current.delete(current.keys().next().value as string);
  return now;
}

// ---- name → id lookups (one per name per 6 h; a miss again after 10 min; a failure after 1 min) ----------------------
let ver = 0;
const subs = new Set<() => void>();
const bump = () => {
  ver++;
  for (const f of subs) f();
};
let inflight = false;
const fresh = (k: string, now: number) => {
  const r = resolved.get(k);
  return !!r && now - r.at < r.ttl;
};
/** When the earliest answer among `keys` goes stale (ms from now), or null. */
function nextExpiry(keys: readonly string[], now: number): number | null {
  let t: number | null = null;
  for (const k of keys) {
    const r = resolved.get(k);
    if (!r) continue;
    const left = r.at + r.ttl - now;
    if (t === null || left < t) t = left;
  }
  return t === null ? null : Math.max(0, t);
}
async function resolveNames(texts: readonly string[]): Promise<void> {
  if (inflight || !serverFeatureOn("games")) return;
  const now = Date.now();
  const byKey = new Map<string, string>();
  for (const t of texts) {
    const k = gameKey(t);
    if (k && !fresh(k, now) && !byKey.has(k)) byKey.set(k, t);
  }
  if (!byKey.size) return;
  const batch = [...byKey.entries()].slice(0, 20);
  const myGen = gen;
  inflight = true;
  try {
    const r = await apiJson<{ ids?: Record<string, string | null> }>("/games/resolve", { method: "POST", json: { names: batch.map(([, t]) => t) }, timeoutMs: 10_000 });
    if (myGen !== gen) return; // answered for an earlier session
    const t = Date.now();
    for (const [k, text] of batch) {
      const id = typeof r?.ids?.[text] === "string" ? (r.ids[text] as string) : null;
      resolved.set(k, { id, at: t, ttl: id ? HIT_TTL_MS : MISS_TTL_MS });
    }
  } catch (e) {
    if (myGen !== gen) return;
    log.debug(`resolve failed: ${(e as Error)?.message ?? e}`);
    const t = Date.now();
    for (const [k] of batch) resolved.set(k, { id: null, at: t, ttl: FAIL_RETRY_MS });
  } finally {
    inflight = false;
    if (resolved.size > 2000) for (const k of [...resolved.keys()].slice(0, 500)) resolved.delete(k);
    bump();
  }
}
function useResolvedVer(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => ver,
  );
}

export interface GameBackdrop {
  /** the art url on the person's own server, or null = draw nothing */
  src: string | null;
  gameId: string | null;
  mode: "game" | "off";
}

export function useGameBackdrop(roomId: string | null | undefined, roomBg: unknown, spaceBg?: unknown, visible = true): GameBackdrop {
  checkScope();
  const prefs = useGameArtPrefs();
  const mode = artMode(roomBg, spaceBg, prefs);
  const active = mode === "game" && !!roomId && serverFeatureOn("games");
  const hidden = useLiveWin() === "hidden" || !visible;
  const working = active && !hidden;
  const members = useMembers(working ? roomId : null, "join");
  const callers = useCallParticipants(working ? roomId : null);
  const users = usePresenceStore((s) => s.users);
  const presenceOkAt = usePresenceStore((s) => s.okAt);
  const act = useRoomState(working ? roomId : null, ACTIVITY_TYPE, "") as { game?: unknown; ts?: unknown } | undefined;
  const rver = useResolvedVer();
  const [tick, force] = useReducer((x: number) => x + 1, 0);
  if (roomId && working && !openedAt.has(roomId)) openedAt.set(roomId, Date.now());

  const input = useMemo(() => {
    if (!working) return null;
    const now = Date.now();
    const ids = members.map((m) => m.userId);
    const claims: Claim[] = [];
    for (const u of ids) {
      const text = users[u]?.status?.text;
      if (typeof text === "string" && text.trim()) claims.push({ user: u, text, at: statusAt(u, text, now) });
      else current.delete(u); // a cleared status: the next one starts a new clock (A → nothing → A is "recent" again)
    }
    const game = typeof act?.game === "string" ? act.game : "";
    const activity = game.trim() ? { text: game, at: typeof act?.ts === "number" ? act.ts : 0 } : null;
    return { members: ids, callers, claims, activity };
  }, [working, members, callers, users, act]);

  const texts = useMemo(() => (input ? [...input.claims.map((c) => c.text), ...(input.activity ? [input.activity.text] : [])] : []), [input]);
  const keys = useMemo(() => texts.map(gameKey).filter(Boolean), [texts]);

  // look up names this device hasn't, and again when an answer goes stale (only while shown)
  useEffect(() => {
    if (!working || !texts.length) return;
    void resolveNames(texts);
    const wait = nextExpiry(keys, Date.now());
    if (wait === null || wait === 0) return; // stale now: the lookup just started answers through rver
    const t = window.setTimeout(force, wait + 50);
    return () => window.clearTimeout(t);
  }, [working, texts, keys, rver, tick]);

  // pick + stabilise (nothing while hidden; the first look waits until the inputs are known)
  useEffect(() => {
    if (!working || !input || !roomId) return;
    const now = Date.now();
    const st0 = stable.get(roomId) ?? null;
    if (!st0) {
      // the first look waits (READY_WAIT_MS at most) for the presence list and for fresh, real answers for every name:
      // a stale or failed lookup is not "nobody plays"
      const waited = now - (openedAt.get(roomId) ?? now) >= READY_WAIT_MS;
      if (keys.some((k) => !fresh(k, now))) return; // a name still being looked up (or refreshed): its answer re-runs this
      const failed = keys.some((k) => resolved.get(k)?.ttl === FAIL_RETRY_MS);
      if (!waited && (presenceOkAt === 0 || failed)) {
        const t = window.setTimeout(force, Math.max(50, READY_WAIT_MS - (now - (openedAt.get(roomId) ?? now))));
        return () => window.clearTimeout(t);
      }
    }
    const ids: Record<string, string | null> = {};
    for (const k of keys) ids[k] = resolved.get(k)?.id ?? null;
    const cand = pickGame({ ...input, ids }).game;
    const st = stepStable(st0, cand, now);
    if (!st0 || st.shown !== st0.shown || st.cand !== st0.cand || st.candSince !== st0.candSince) {
      stable.delete(roomId);
      stable.set(roomId, st);
      if (stable.size > 500) stable.delete(stable.keys().next().value as string);
      if (!st0 || st.shown !== st0.shown) bump(); // every view of this room (not just this one) draws the change
    }
    const wait = nextStepIn(st, now);
    if (wait === null) return;
    const t = window.setTimeout(force, wait + 50);
    return () => window.clearTimeout(t);
  }, [working, input, keys, roomId, rver, presenceOkAt, tick]);

  const shown = active && roomId ? (stable.get(roomId)?.shown ?? null) : null;
  if (!shown) return { src: null, gameId: null, mode };
  return { src: backgroundUrl(CATALOG_BASE, shown), gameId: shown, mode };
}

/** Test hooks (window.__twGamebg in dev/gates). */
export function gamebgDebug() {
  return { scope, resolved: Object.fromEntries(resolved), stable: Object.fromEntries(stable), current: current.size };
}
