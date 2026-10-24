// gameservers.ts — the Game servers widget's shared logic (contract docs/GAMESERVERS.md §3; vectors
// testvectors/widgets/gameservers/*.json): reading the Tin Hat server's /api/gameservers/status answer, the state chip,
// the one-line texts, the CPU / RAM bars, which confirmation a power action needs (the server's own rules, previewed),
// the announcement text and the calendar link. Pure: no DOM, no React, no clock. The desktop's Rust port
// (crates/widgets/src/gameservers.rs) runs the same vectors; the server's planPower runs plan.json too.
import { cmpStr } from "./history";
import { asciiLower, asciiTrim } from "./people";
import { fmtDur } from "./time";

export type ServerState = "running" | "starting" | "stopping" | "offline";
export type PowerAction = "start" | "stop" | "restart";

export interface Players {
  count: number;
  names: string[];
}
export interface Pending {
  action: PowerAction;
  by: string;
  since: number;
  queued: boolean;
}
export interface GameServer {
  id: string;
  name: string;
  game: string;
  steamAppId: number | null;
  emoji: string;
  state: ServerState;
  unavailable: string | null;
  uptimeMs: number;
  cpu: { used: number; limit: number };
  memory: { usedMB: number; limitMB: number };
  players: Players | null;
  join: { address: string; password: string | null };
  info: string;
  outside: boolean;
  calendar: boolean;
  pending: Pending | null;
  next: { what: "backup" | "restart"; at: number } | null;
}
export interface SwitchJob {
  from: string;
  to: string;
  by: string;
  since: number;
  step: "stopping" | "starting" | "done" | "failed";
  ok: boolean | null;
  error: string | null;
}
export interface GameStatus {
  at: number;
  space: string;
  announceRoom: string | null;
  canManage: boolean;
  cap: number;
  running: number;
  memoryBudgetMB: number;
  memoryUsedMB: number;
  stale: boolean;
  servers: GameServer[];
  job: SwitchJob | null;
}

// ---- 3.1 reading the answer -----------------------------------------------------------------------------------------

const ID_RE = /^[0-9a-f]{8}$/;
const STATES = new Set(["running", "starting", "stopping", "offline"]);
const ACTIONS = new Set(["start", "stop", "restart"]);
const STEPS = new Set(["stopping", "starting", "done", "failed"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** r(x) = floor(x + 0.5) (the contract's rounding; never banker's). */
export const r = (x: number): number => Math.floor(x + 0.5);
const nonNeg = (v: unknown): number => (fin(v) && v >= 0 ? r(v) : 0);
const cps = (s: string): number => [...s].length;
const strMax = (v: unknown, max: number): string | null => (typeof v === "string" && cps(v) <= max ? v : null);
/** Own keys only (a key named like an Object.prototype member reads as absent unless the object really has it). */
const own = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function readServer(v: Record<string, unknown>, id: string): GameServer {
  // trims are ASCII-only everywhere here (JS trim and Rust trim disagree on U+FEFF / U+0085)
  const nameRaw = own(v, "name");
  const nameT = typeof nameRaw === "string" ? asciiTrim(nameRaw) : "";
  const name = cps(nameT) >= 1 && cps(nameT) <= 64 ? nameT : id;
  const app = own(v, "steamAppId");
  const state = own(v, "state");
  const cpuV = own(v, "cpu");
  const cpu = isObj(cpuV) ? cpuV : {};
  const used = own(cpu, "used");
  const limit = own(cpu, "limit");
  const memV = own(v, "memory");
  const mem = isObj(memV) ? memV : {};
  const plV = own(v, "players");
  let players: Players | null = null;
  if (isObj(plV)) {
    const count = own(plV, "count");
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
      const namesV = own(plV, "names");
      const names: string[] = [];
      if (Array.isArray(namesV))
        for (const n of namesV) {
          if (typeof n !== "string") continue;
          const t = asciiTrim(n);
          if (cps(t) >= 1 && cps(t) <= 32 && names.length < 16) names.push(t);
        }
      players = { count, names };
    }
  }
  const joinV = own(v, "join");
  const join = isObj(joinV) ? joinV : {};
  const pw = own(join, "password");
  const pendV = own(v, "pending");
  let pending: Pending | null = null;
  if (isObj(pendV) && typeof own(pendV, "action") === "string" && ACTIONS.has(own(pendV, "action") as string)) {
    const since = own(pendV, "since");
    pending = {
      action: own(pendV, "action") as PowerAction,
      by: strMax(own(pendV, "by"), 255) ?? "",
      since: fin(since) ? since : 0,
      queued: own(pendV, "queued") === true,
    };
  }
  const nextV = own(v, "next");
  let next: GameServer["next"] = null;
  if (isObj(nextV)) {
    const what = own(nextV, "what");
    const at = own(nextV, "at");
    if ((what === "backup" || what === "restart") && fin(at)) next = { what, at };
  }
  const unav = strMax(own(v, "unavailable"), 40);
  return {
    id,
    name,
    game: strMax(own(v, "game"), 64) ?? "",
    steamAppId: typeof app === "number" && Number.isInteger(app) && app > 0 && app < 1e9 ? app : null,
    emoji: strMax(own(v, "emoji"), 16) ?? "",
    state: typeof state === "string" && STATES.has(state) ? (state as ServerState) : "offline",
    unavailable: unav === null || unav === "" ? null : unav,
    uptimeMs: nonNeg(own(v, "uptimeMs")),
    cpu: { used: fin(used) && used >= 0 ? r(used * 10) / 10 : 0, limit: fin(limit) && limit > 0 ? r(limit) : 100 },
    memory: { usedMB: nonNeg(own(mem, "usedMB")), limitMB: nonNeg(own(mem, "limitMB")) },
    players,
    join: { address: strMax(own(join, "address"), 300) ?? "", password: typeof pw === "string" && cps(pw) >= 1 && cps(pw) <= 128 ? pw : null },
    info: strMax(own(v, "info"), 280) ?? "",
    outside: own(v, "outside") === true,
    calendar: own(v, "calendar") !== false,
    pending,
    next,
  };
}

/** The /status answer as the widget uses it (§3.1), or null when it is not one. */
export function readStatus(value: unknown): GameStatus | null {
  if (!isObj(value) || own(value, "v") !== 1) return null;
  const list = own(value, "servers");
  if (!Array.isArray(list)) return null;
  const servers: GameServer[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (servers.length >= 32) break;
    if (!isObj(item)) continue;
    const id = own(item, "id");
    if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    servers.push(readServer(item, id));
  }
  const cap = own(value, "cap");
  const jobV = own(value, "job");
  let job: SwitchJob | null = null;
  if (isObj(jobV)) {
    const from = own(jobV, "from");
    const to = own(jobV, "to");
    const step = own(jobV, "step");
    if (typeof from === "string" && ID_RE.test(from) && typeof to === "string" && ID_RE.test(to) && typeof step === "string" && STEPS.has(step)) {
      const ok = own(jobV, "ok");
      const since = own(jobV, "since");
      job = {
        from,
        to,
        by: typeof own(jobV, "by") === "string" ? (own(jobV, "by") as string) : "",
        since: fin(since) ? since : 0,
        step: step as SwitchJob["step"],
        ok: ok === true ? true : ok === false ? false : null,
        error: strMax(own(jobV, "error"), 300),
      };
    }
  }
  const at = own(value, "at");
  const ar = own(value, "announceRoom");
  const sp = own(value, "space");
  return {
    at: fin(at) ? at : 0,
    space: typeof sp === "string" ? sp : "",
    announceRoom: typeof ar === "string" ? ar : null,
    canManage: own(value, "canManage") === true,
    cap: typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= 8 ? cap : 2,
    running: nonNeg(own(value, "running")),
    memoryBudgetMB: nonNeg(own(value, "memoryBudgetMB")),
    memoryUsedMB: nonNeg(own(value, "memoryUsedMB")),
    stale: own(value, "stale") === true,
    servers,
    job,
  };
}

// ---- 3.2 the state chip ---------------------------------------------------------------------------------------------

export type Tone = "online" | "busy" | "offline";

/** "running" in the widget's sense: not offline, or a start / restart on its way (queued included). */
export function isUp(s: GameServer): boolean {
  return s.state !== "offline" || s.pending?.action === "start" || s.pending?.action === "restart";
}

export function chipOf(s: GameServer): { tone: Tone; text: string } {
  const p = s.pending;
  if (p) {
    if (p.queued) return { tone: "busy", text: "Queued" };
    return { tone: "busy", text: p.action === "start" ? "Starting…" : p.action === "stop" ? "Stopping…" : "Restarting…" };
  }
  if (s.state === "running") {
    const pl = s.players;
    return { tone: "online", text: pl === null ? "Online" : pl.count > 0 ? `Online · ${pl.count} on` : "Online · nobody on" };
  }
  if (s.state === "starting") return { tone: "busy", text: "Starting…" };
  if (s.state === "stopping") return { tone: "busy", text: "Stopping…" };
  return { tone: "offline", text: s.unavailable ? `Offline · ${s.unavailable}` : "Offline" };
}

// ---- 3.3 lines ------------------------------------------------------------------------------------------------------

const lowerFirst = (t: string): string => (t.length && t[0]! >= "A" && t[0]! <= "Z" ? t[0]!.toLowerCase() + t.slice(1) : t);

/** The S / collapsed line. */
export function summaryOf(st: GameStatus): string {
  const up = st.servers.filter(isUp);
  if (up.length === 0) return "No game running";
  if (up.length === 1) return `${up[0]!.name} · ${lowerFirst(chipOf(up[0]!).text)}`;
  let text = `${up[0]!.name} + ${up[1]!.name}`;
  if (up.length > 2) text += ` + ${up.length - 2} more`;
  const known = up.filter((s) => s.players !== null && s.state === "running");
  if (known.length) text += ` · ${known.reduce((a, s) => a + s.players!.count, 0)} on`;
  return text;
}

export function playersLine(s: GameServer): string {
  const p = s.players;
  if (p === null) return "—";
  if (p.count === 0) return "Nobody on";
  if (p.names.length === 0) return `${p.count} on`;
  const extra = p.count - p.names.length;
  return p.names.join(", ") + (extra > 0 ? ` +${extra}` : "");
}

/** The card's "who's on" line, "" = no line: the names when known; "N on" only while the chip doesn't carry the count
 *  (starting, stopping, pending); nothing for unknown or nobody (the chip says it). */
export function whoLine(s: GameServer): string {
  const p = s.players;
  if (p === null || p.count === 0) return "";
  if (p.names.length === 0 && s.state === "running" && !s.pending) return "";
  return playersLine(s);
}

export function uptimeText(ms: number): string {
  return `up ${fmtDur(ms)}`;
}

export function cpuPm(cpu: { used: number; limit: number }): number {
  return cpu.limit > 0 ? Math.min(1000, r((cpu.used / cpu.limit) * 1000)) : 0;
}
export function cpuText(cpu: { used: number; limit: number }): string {
  return `${cpu.limit > 0 ? r((cpu.used / cpu.limit) * 100) : 0} %`;
}
export function memPm(mem: { usedMB: number; limitMB: number }): number {
  return mem.limitMB > 0 ? Math.min(1000, r((mem.usedMB / mem.limitMB) * 1000)) : 0;
}
/** GB with one decimal, or whole when it is whole ("8", "12.5"). */
function gbShort(mb: number): string {
  const t = r((mb / 1024) * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}
export function memText(mem: { usedMB: number; limitMB: number }): string {
  const a = (r((mem.usedMB / 1024) * 10) / 10).toFixed(1);
  return mem.limitMB > 0 ? `${a} / ${gbShort(mem.limitMB)} GB` : `${a} GB`;
}
export function sizeText(mb: number): string {
  return `${gbShort(mb)} GB`;
}

// ---- 3.4 which Start (the server's rules, previewed) ---------------------------------------------------------------

export type StartPlan =
  | { kind: "ok" }
  | { kind: "unknown" }
  | { kind: "refused"; text: string }
  | { kind: "cap"; running: string[] }
  | { kind: "memory"; needMB: number; freeMB: number; text: string };

const gbText = (mb: number): string => `${gbShort(mb)} GB`;

function planWith(st: GameStatus, targetId: string, firstId: string | null): StartPlan {
  const t = st.servers.find((s) => s.id === targetId);
  if (!t) return { kind: "unknown" };
  if (t.pending) return { kind: "refused", text: `${t.name} is busy — try again in a moment` };
  if (t.unavailable) return { kind: "refused", text: `${t.name} can't start right now (${t.unavailable})` };
  if (t.state !== "offline")
    return { kind: "refused", text: t.state === "stopping" ? `${t.name} is still stopping — try again in a moment` : `${t.name} is already running` };
  let first: GameServer | null = null;
  if (firstId !== null) {
    first = st.servers.find((s) => s.id === firstId) ?? null;
    if (!first) return { kind: "unknown" };
    if (first.id === t.id) return { kind: "refused", text: "stopFirst must be another server" };
    if (first.pending) return { kind: "refused", text: `${first.name} is busy — try again in a moment` };
    if (first.state === "offline") return { kind: "refused", text: `${first.name} isn't running` };
  }
  const active = st.servers.filter((s) => s.id !== t.id && (!first || s.id !== first.id) && isUp(s));
  if (active.length >= st.cap) return { kind: "cap", running: active.map((s) => s.id) };
  const budget = st.memoryBudgetMB;
  const lim = (s: GameServer) => (s.memory.limitMB > 0 ? s.memory.limitMB : budget);
  const used = active.reduce((a, s) => a + lim(s), 0);
  const free = Math.max(0, budget - used);
  if (used + lim(t) > budget)
    return { kind: "memory", needMB: lim(t), freeMB: free, text: `${t.name} needs ${gbText(lim(t))} and only ${gbText(free)} is free — stop a game first` };
  return { kind: "ok" };
}

/** Which confirmation a Start of `targetId` needs (§3.4). */
export function planStart(st: GameStatus, targetId: string): StartPlan {
  return planWith(st, targetId, null);
}
/** The same with `firstId` stopped first (the switch). */
export function planSwitch(st: GameStatus, targetId: string, firstId: string): StartPlan {
  return planWith(st, targetId, firstId);
}

// ---- 3.5 confirmations ----------------------------------------------------------------------------------------------

export interface Confirm {
  title: string;
  body: string;
  confirm: string;
  destructive: boolean;
}

const LAN = "Ports closed — LAN only: people outside this network can't join (ask the server's owner to open them).";
const onLine = (n: number, name: string) => `${n} ${n === 1 ? "person is" : "people are"} on ${name}`;
const playing = (s: GameServer) => (s.state === "running" && s.players !== null ? s.players.count : 0);

/** The dialog a power action needs, or null (§3.5). */
export function confirmOf(st: GameStatus, action: PowerAction, id: string, firstId: string | null = null): Confirm | null {
  const s = st.servers.find((x) => x.id === id);
  if (!s) return null;
  if (firstId !== null) {
    const f = st.servers.find((x) => x.id === firstId);
    if (!f || action !== "start") return null;
    let body = `Two games are already running. Stop ${f.name} and start ${s.name}?`;
    const n = playing(f);
    if (n > 0) body += ` ${onLine(n, f.name)}.`;
    if (!s.outside) body += ` ${LAN}`;
    return { title: `Start ${s.name}?`, body, confirm: `Stop ${f.name} and start ${s.name}`, destructive: true };
  }
  const n = playing(s);
  if (action === "stop") return n > 0 ? { title: `Stop ${s.name}?`, body: `${onLine(n, s.name)} — stop anyway?`, confirm: "Stop", destructive: true } : null;
  if (action === "restart")
    return n > 0 ? { title: `Restart ${s.name}?`, body: `${onLine(n, s.name)} — restart anyway?`, confirm: "Restart", destructive: true } : null;
  return s.outside ? null : { title: `Start ${s.name}?`, body: LAN, confirm: "Start", destructive: false };
}

// ---- 3.6 the announcement -------------------------------------------------------------------------------------------

export function noticeText(actor: string, action: PowerAction, name: string, firstName: string | null = null): string {
  if (firstName !== null && action === "start") return `${actor} stopped ${firstName} and started ${name}`;
  return `${actor} ${action === "start" ? "started" : action === "stop" ? "stopped" : "restarted"} ${name}`;
}

// ---- 3.7 the calendar link ------------------------------------------------------------------------------------------

export interface LinkEvent {
  game?: string | null;
  gameId?: string | null;
}
export interface CalItem extends LinkEvent {
  container: string;
  id: string;
  title: string;
  kind: string;
  start: number;
  end: number;
  canceled: boolean;
}

const STEAM_ID = /^steam:([1-9][0-9]{0,8})$/;

/** The server a calendar event is for, or null (§3.7). */
export function linkServer(ev: LinkEvent, st: GameStatus): GameServer | null {
  const gid = typeof ev.gameId === "string" ? STEAM_ID.exec(ev.gameId) : null;
  const app = gid ? Number(gid[1]) : null;
  const g = typeof ev.game === "string" ? asciiLower(asciiTrim(ev.game)) : "";
  const cands = st.servers.filter((s) => {
    if (!s.calendar) return false;
    if (app !== null && s.steamAppId === app) return true;
    if (!g) return false;
    const sg = asciiLower(s.game);
    const sn = asciiLower(s.name);
    return (sg !== "" && sg === g) || (sn !== "" && sn === g);
  });
  return cands.find(isUp) ?? cands[0] ?? null;
}

const DAY_MS = 86_400_000;

/** The next calendar event for `serverId` (§3.7), or null. */
export function nextEventFor<T extends CalItem>(serverId: string, events: readonly T[], now: number, st: GameStatus): T | null {
  const list = events.filter(
    (e) => e.canceled !== true && e.kind !== "focus" && e.end > now && e.start < now + 14 * DAY_MS && linkServer(e, st)?.id === serverId,
  );
  list.sort((a, b) => a.start - b.start || a.end - b.end || cmpStr(a.container, b.container) || cmpStr(a.id, b.id));
  return list[0] ?? null;
}
