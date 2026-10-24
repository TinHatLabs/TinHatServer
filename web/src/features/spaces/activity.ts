// activity.ts — per-room "now playing" (dev.tinhat.activity, activity.rs) and per-person status
// (dev.tinhat.userstatus, status_ctl.rs). The native polls every 3 s; the web reads the room
// state live (useRoomState*) and re-filters expired statuses on a 30 s tick. Writes are optimistic:
// the value we just wrote shows at once until the echoed state event replaces it.
//
//   useRoomActivity(roomId)   {game, emoji, code, setBy} | null
//   setActivity(roomId, game, emoji, code)   empty game = clear ({}); ensureWritable first
//   useRoomStatuses(roomId)   [{userId, text, expiresAt}] (non-blank, not expired)
//   useMyStatus(roomId)       my status text ("" = none)
//   postStatus(roomId, text, ttlMin)         blank = clear ({}), ttl 0 = no expiry
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ensureWritable, getClient, peekClient, sendState, useRoomState, useRoomStateEvents } from "@/core/matrix";
import { toast } from "@/core/bus";
import { createLogger } from "@/core/log";
import { rl } from "./ratelimit";
import { ACTIVITY_TYPE, USERSTATUS_TYPE, activityContent, parseActivity, statusContent, type Activity, type UserStatus } from "./activityModel";
export { ACTIVITY_TYPE, USERSTATUS_TYPE, parseActivity, type Activity, type UserStatus } from "./activityModel";

const log = createLogger("spaces.activity");

const FAIL = "Couldn't set — you may not have permission in this room";

// ---- optimistic overlay ------------------------------------------------------------------------------

interface Pending<T> {
  value: T;
  at: number;
}
const pendingActivity = new Map<string, Pending<Activity | null>>();
const pendingStatus = new Map<string, Pending<string>>(); // roomId → my text
const listeners = new Set<() => void>();
let ver = 0;
function bump() {
  ver++;
  for (const l of listeners) l();
}
function useVer() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => ver,
  );
}
/** optimistic values live until the echo matches or 8 s pass */
const PENDING_MS = 8000;

// ---- activity ----------------------------------------------------------------------------------------


const sameActivity = (a: Activity | null, b: Activity | null) =>
  a === b || (!!a && !!b && a.game === b.game && a.emoji.trim() === b.emoji.trim() && a.code.trim() === b.code.trim());

export function useRoomActivity(roomId: string | null | undefined): Activity | null {
  useVer();
  const content = useRoomState(roomId, ACTIVITY_TYPE, "");
  const live = useMemo(() => parseActivity(content), [content]);
  const p = roomId ? pendingActivity.get(roomId) : undefined;
  if (p && Date.now() - p.at < PENDING_MS && !sameActivity(p.value, live)) return p.value;
  return live;
}

/** activity.rs set_activity: blank game → clear; else ensureWritable + {game,setBy,ts,emoji?,code?}. */
export async function setActivity(roomId: string, game: string, emoji = "", code = ""): Promise<boolean> {
  const client = peekClient();
  if (!client || !roomId) return false;
  const me = client.getUserId() ?? "";
  const clear = game.trim() === "";
  try {
    if (clear) {
      await rl(() => sendState(roomId, ACTIVITY_TYPE, "", {}));
    } else {
      await ensureWritable(roomId, [ACTIVITY_TYPE]);
      const content = activityContent(game, me, Date.now(), emoji, code);
      await rl(() => sendState(roomId, ACTIVITY_TYPE, "", content));
    }
    pendingActivity.set(roomId, { value: clear ? null : { game: game.trim(), emoji: emoji.trim(), code: code.trim(), setBy: me }, at: Date.now() });
    bump();
    return true;
  } catch (e) {
    log.warn(`set failed: ${(e as Error)?.message ?? e}`);
    toast(FAIL, { kind: "error", timeoutMs: 6000 });
    return false;
  }
}

// ---- statuses ----------------------------------------------------------------------------------------

export function useRoomStatuses(roomId: string | null | undefined): UserStatus[] {
  useVer();
  const [now, setNow] = useState(() => Date.now());
  const evs = useRoomStateEvents(roomId, USERSTATUS_TYPE);
  const me = peekClient()?.getUserId() ?? "";
  // GPU.md §2.8 (C8): ONE timeout at the next moment the list changes by itself — a status's `expiresAt` or the
  // end of our own pending echo — instead of a 30 s tick that re-rendered the members pane for nothing
  useEffect(() => {
    const t = Date.now();
    let next = Infinity;
    for (const e of evs) {
      const c = e.content as Record<string, unknown>;
      if (typeof c.expiresAt === "number" && c.expiresAt > t) next = Math.min(next, c.expiresAt);
    }
    const p = roomId ? pendingStatus.get(roomId) : undefined;
    if (p && t - p.at < PENDING_MS) next = Math.min(next, p.at + PENDING_MS);
    if (!Number.isFinite(next)) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(2_000_000_000, next - t + 50));
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evs, now, roomId, ver]);
  return useMemo(() => {
    const t = Date.now();
    const out: UserStatus[] = [];
    let mineSeen = false;
    const p = roomId ? pendingStatus.get(roomId) : undefined;
    const pendingLive = p && t - p.at < PENDING_MS ? p : undefined;
    for (const e of evs) {
      const c = e.content as Record<string, unknown>;
      let text = typeof c.text === "string" ? c.text.trim() : "";
      const exp = typeof c.expiresAt === "number" && c.expiresAt >= 0 ? c.expiresAt : null;
      if (e.stateKey === me && pendingLive && pendingLive.value !== text) {
        text = pendingLive.value;
        mineSeen = true;
        if (!text) continue;
        out.push({ userId: me, text, expiresAt: null });
        continue;
      }
      if (e.stateKey === me) mineSeen = true;
      if (!text) continue;
      if (exp !== null && exp <= t) continue;
      out.push({ userId: e.stateKey, text, expiresAt: exp });
    }
    if (!mineSeen && pendingLive?.value) out.push({ userId: me, text: pendingLive.value, expiresAt: null });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evs, now, me, roomId, ver]);
}

export function useMyStatus(roomId: string | null | undefined): string {
  const all = useRoomStatuses(roomId);
  const me = peekClient()?.getUserId() ?? "";
  return all.find((s) => s.userId === me)?.text ?? "";
}

/** status_ctl.rs post_status: blank → {} under my mxid; else ensureWritable + {text, expiresAt?}. */
export async function postStatus(roomId: string, text: string, ttlMin: number): Promise<boolean> {
  const client = peekClient();
  if (!client || !roomId) return false;
  const me = client.getUserId() ?? "";
  try {
    if (!text.trim()) {
      await rl(() => sendState(roomId, USERSTATUS_TYPE, me, {}));
    } else {
      await ensureWritable(roomId, [USERSTATUS_TYPE]);
      const content = statusContent(text, ttlMin, Date.now());
      await rl(() => sendState(roomId, USERSTATUS_TYPE, me, content));
    }
    pendingStatus.set(roomId, { value: text.trim(), at: Date.now() });
    bump();
    return true;
  } catch (e) {
    log.warn(`status failed: ${(e as Error)?.message ?? e}`);
    toast(FAIL, { kind: "error", timeoutMs: 6000 });
    return false;
  }
}

/** Is this room a DM (the status editor hides there). */
export function isDmRoom(roomId: string): boolean {
  try {
    const c = getClient();
    const direct = c.getAccountData("m.direct" as never)?.getContent() as Record<string, string[]> | undefined;
    if (!direct) return false;
    return Object.values(direct).some((ids) => Array.isArray(ids) && ids.includes(roomId));
  } catch {
    return false;
  }
}
