// CalendarRoot.tsx — always-mounted (r.overlays) glue: follows the shell's current room (both the
// calendar and the reel resolve their container from it — CAL-98), feeds the reel the people in
// the call I'm in (CAL-71/§3.7 presence), honours the `?calendar=1` dev flag (CAL-09: open the
// calendar once a container is known) and hosts the dev harness (`?calharness=1`).
import { useEffect } from "react";
import { useRoute } from "@/app/router";
import { useBus } from "@/core/bus";
import { peekClient, useSession } from "@/core/matrix";
import { useCallStore } from "@/features/calls";
import * as calStore from "./calendarStore";
import { setRoom as setCalRoom, useCal } from "./calendarStore";
import * as gamesStore from "./gamesStore";
import { setRoom as setReelRoom, setPresent } from "./gamesStore";
import { openCalendar, openGameReel } from "./entry";
import * as reminders from "./reminders";
import { CalendarHarness } from "./ui/CalendarHarness";

// dev/test hook (like core's __tw): stores + entry points, only in DEV or with __TW_DEBUG__
if (typeof window !== "undefined" && (import.meta.env.DEV || (window as unknown as { __TW_DEBUG__?: unknown }).__TW_DEBUG__)) {
  (window as unknown as Record<string, unknown>).__twCal = { cal: calStore, games: gamesStore, reminders, openCalendar, openGameReel };
}

function resolveRoomId(target: string): string {
  if (!target) return "";
  if (target.startsWith("!")) return target;
  const client = peekClient();
  if (!client || !target.startsWith("#")) return "";
  for (const r of client.getRooms()) if (r.getCanonicalAlias() === target || r.getAltAliases().includes(target)) return r.roomId;
  return "";
}

const flag = (name: string) => {
  const q = location.search + "&" + (location.hash.split("?")[1] ?? "");
  return new RegExp(`[?&]${name}=1(?:&|$)`).test(q);
};

/** Participant ids of the call I'm in (+ me) — from the real calls store (features/calls contract):
 *  `inCall` + `tiles[].participant` (LiveKit identity "@user:server:DEVICE" → the user id; the self
 *  tile is "You"). The older defensive shapes (participants / members / … arrays or maps) are still
 *  accepted so a dev fake call keeps working. [] when not in a call. */
export function presentFromCall(st: unknown): string[] {
  const s = st as Record<string, unknown> | null;
  if (!s || !(s.inCall || s.joined)) return [];
  const me = peekClient()?.getUserId() ?? "";
  const tiles = Array.isArray(s.tiles) ? (s.tiles as unknown[]) : [];
  const raw = s.participants ?? s.members ?? s.remoteParticipants ?? s.participantIds ?? s.people ?? [];
  const extra: unknown[] = Array.isArray(raw) ? raw : raw instanceof Map ? [...raw.values()] : raw && typeof raw === "object" ? Object.values(raw) : [];
  const out: string[] = me ? [me] : [];
  for (const x of [...tiles, ...extra]) {
    let id = "";
    if (typeof x === "string") id = x;
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      id = String(o.participant ?? o.userId ?? o.mxid ?? o.user ?? o.identity ?? "");
    }
    // a LiveKit identity is "@user:server:DEVICE" → the user id (a server name may carry a port)
    const m = /^(@[^:]+:[^:]+?(?::\d+)?)(?::[A-Za-z0-9_.-]+)?$/.exec(id);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function CalendarRoot() {
  const route = useRoute();
  const session = useSession();
  const ready = session.state === "ready";
  const target = route.name === "room" ? route.target : "";
  useEffect(() => {
    if (!ready) return;
    const id = resolveRoomId(target);
    if (id) {
      setCalRoom(id);
      setReelRoom(id);
    }
  }, [target, ready]);

  // bus intents (spec §7): other features may emit these instead of openWindow("calendar"/"gameReel")
  useBus("openCalendar", (p) => openCalendar(p ?? {}));
  useBus("openGameReel", (p) => openGameReel(p ?? {}));

  // presence = the call I'm in
  useEffect(() => {
    // the call store ticks at ~15 Hz (audio levels) — only publish when the set of people changes
    let last = "\u0000";
    const apply = () => {
      const ids = presentFromCall(useCallStore.getState());
      const key = ids.join("\n");
      if (key === last) return;
      last = key;
      setPresent(ids);
    };
    apply();
    return useCallStore.subscribe(apply);
  }, []);

  // CAL-09 dev hook: ?calendar=1 → open the calendar once a container is known
  useEffect(() => {
    if (!flag("calendar")) return;
    let done = false;
    const tryOpen = (cid: string) => {
      if (done || !cid) return;
      done = true;
      openCalendar();
    };
    tryOpen(useCal.getState().containerId);
    return useCal.subscribe((s) => tryOpen(s.containerId));
  }, []);

  return flag("calharness") && ready ? <CalendarHarness roomId={resolveRoomId(target)} /> : null;
}
