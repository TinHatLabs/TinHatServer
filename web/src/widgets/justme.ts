// justme.ts — "Is it just me?" (widget `justMe`, contract WIDGETS.md §20, vectors testvectors/widgets/justme/*): what one
// check of the server's services, measured from THIS device, says — a green / amber / red light per service with a
// one-line reason, your ping, the Small line, and the friendly sentence shown when something is red. Pure: the apps
// run the requests (§20.1) and hand the numbers in; the thresholds below are the contract's, the same in both apps.
// The desktop's Rust port (crates/widgets/src/justme.rs) runs the same vectors, so every rule is exact: numbers are
// rounded with r() (x ≤ 0 ? 0 : floor(x + 0.5)), strings are ASCII.

import { r } from "./quality";

export type Band = "good" | "ok" | "poor";
export type ServiceId = "chat" | "calls" | "media" | "tinhat";
/** Why a row has its colour: answered quickly · slowly · some of the pings failed · sync is late · sync stopped ·
 *  no answer · the server answered with an error (5xx). */
export type Cause = "ok" | "slow" | "unsteady" | "late" | "stuck" | "down" | "error";

/** The services, in row order. */
export const SERVICES: readonly ServiceId[] = ["chat", "calls", "media", "tinhat"];
export const SERVICE_NAME: Readonly<Record<ServiceId, string>> = { chat: "Chat", calls: "Calls", media: "Media", tinhat: "Extras" };

/** A probe that answered in this many ms or more is slow (amber). */
export const SLOW_MS = 1000;
/** A probe with no answer after this long is not reachable (red) — the apps abort the request here. */
export const TIMEOUT_MS = 8000;
/** No successful sync for this long = messages are late (amber). The sync long poll answers at least every 30 s. */
export const SYNC_LATE_MS = 60_000;
/** No successful sync for this long = messages aren't arriving (red). */
export const SYNC_STUCK_MS = 120_000;
/** Your ping's bands = Call stats' round-trip bands (WIDGETS.md §5): under 150 ms good, under 400 ms ok, else poor. */
export const PING_OK_MS = 150;
export const PING_POOR_MS = 400;
/** The sparkline (Large): this many one-minute slots, the newest ending at the latest check. */
export const SPARK_SLOTS = 10;
export const SLOT_MS = 60_000;

/** One request's outcome: the HTTP status (null = no answer: a network error or the timeout) and how long it took. */
export interface Probe {
  status: number | null;
  ms: number | null;
}

export interface CheckInput {
  /** the homeserver's `/_matrix/client/versions`, three in a row (Chat's answer and your ping) */
  pings: Probe[];
  /** ms since the last successful sync (or since the session started, before the first); null = unknown */
  syncAgoMs: number | null;
  calls: Probe;
  media: Probe;
  tinhat: Probe;
}

export interface Row {
  id: ServiceId | "ping";
  name: string;
  band: Band;
  cause: Cause;
  /** the round trip shown (r() ms), null = none */
  ms: number | null;
  /** the one line after the name: "reachable · 84 ms" */
  reason: string;
}

export interface Check {
  rows: Row[];
  ping: Row;
  /** the Small line / the header's verdict */
  verdict: { tone: Band; text: string };
  /** the friendly sentence under the rows ("" = none) */
  note: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A probe answered: a status 100–599 and a time ≥ 0. */
export function answered(p: Probe | null | undefined): boolean {
  return !!p && isNum(p.status) && p.status >= 100 && p.status <= 599 && isNum(p.ms) && p.ms >= 0;
}

/** "42 ms", "1.2 s", "12 s". */
export function fmtMs(ms: number): string {
  const m = r(ms);
  if (m < 1000) return `${m} ms`;
  const t = Math.floor((m + 50) / 100);
  if (t < 100) return `${Math.floor(t / 10)}.${t % 10} s`;
  return `${Math.floor((m + 500) / 1000)} s`;
}

/** The ping = the median of the pings' times, a failed ping counting as endless: of 3, the middle one (null when two
 *  or more failed). Any HTTP answer counts (the network round trip), a 5xx too. */
export function pingOf(pings: Probe[]): number | null {
  if (!Array.isArray(pings) || pings.length === 0) return null;
  const t = pings.map((p) => (answered(p) ? r(p.ms as number) : Infinity)).sort((a, b) => a - b);
  const m = t[Math.floor(t.length / 2)]!;
  return m === Infinity ? null : m;
}

export function pingBand(ms: number | null): Band {
  if (ms === null) return "poor";
  return ms < PING_OK_MS ? "good" : ms < PING_POOR_MS ? "ok" : "poor";
}

function row(id: ServiceId | "ping", band: Band, cause: Cause, ms: number | null, reason: string): Row {
  return { id, name: id === "ping" ? "Your ping" : SERVICE_NAME[id], band, cause, ms, reason };
}

/** One service's light from its probe: no answer → red "not reachable"; 5xx → red "having problems"; ≥ SLOW_MS →
 *  amber "slow · 1.2 s"; else green "reachable · 84 ms". */
export function probeRow(id: ServiceId, p: Probe): Row {
  if (!answered(p)) return row(id, "poor", "down", null, "not reachable");
  const ms = r(p.ms as number);
  if ((p.status as number) >= 500) return row(id, "poor", "error", ms, "having problems");
  if (ms >= SLOW_MS) return row(id, "ok", "slow", ms, `slow · ${fmtMs(ms)}`);
  return row(id, "good", "ok", ms, `reachable · ${fmtMs(ms)}`);
}

/** Chat = the pings to the homeserver and whether sync is flowing. */
export function chatRow(pings: Probe[], syncAgoMs: number | null): Row {
  const list = Array.isArray(pings) ? pings : [];
  const got = list.filter(answered);
  let base: Row;
  if (got.length === 0) base = row("chat", "poor", "down", null, "not reachable");
  else if (got.some((p) => (p.status as number) >= 500)) base = row("chat", "poor", "error", pingOf(list), "having problems");
  else {
    const ms = pingOf(list);
    if (got.length < list.length) base = row("chat", "ok", "unsteady", ms, ms === null ? "unsteady" : `unsteady · ${fmtMs(ms)}`);
    else if ((ms as number) >= SLOW_MS) base = row("chat", "ok", "slow", ms, `slow · ${fmtMs(ms as number)}`);
    else base = row("chat", "good", "ok", ms, `reachable · ${fmtMs(ms as number)}`);
  }
  if (base.band === "poor" || !isNum(syncAgoMs)) return base;
  if (syncAgoMs >= SYNC_STUCK_MS) return row("chat", "poor", "stuck", base.ms, "messages aren't arriving");
  if (syncAgoMs >= SYNC_LATE_MS) return row("chat", "ok", "late", base.ms, "messages are late");
  return base;
}

/** Your ping row: "42 ms" in its band; none → red "no answer". */
export function pingRow(pings: Probe[]): Row {
  const ms = pingOf(pings);
  if (ms === null) return row("ping", "poor", "down", null, "no answer");
  const band = pingBand(ms);
  return row("ping", band, band === "good" ? "ok" : "slow", ms, fmtMs(ms));
}

// ---- the words --------------------------------------------------------------------------------------------------

const NOUN: Readonly<Record<ServiceId, string>> = { chat: "chat", calls: "calls", media: "media", tinhat: "the extras" };
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** "calls", "calls and media", "chat, calls and media" — capitalised. */
export function namesOf(ids: ServiceId[]): string {
  const n = ids.map((i) => NOUN[i]);
  if (n.length <= 1) return cap(n[0] ?? "");
  return cap(`${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`);
}
const plural = (ids: ServiceId[]) => ids.length > 1 || ids[0] === "calls" || ids[0] === "tinhat";

const NOTE_DOWN: Readonly<Record<ServiceId, string>> = {
  chat: "Chat isn't reachable from here. If friends can chat, it's your connection.",
  calls: "Calls aren't reachable from here. If friends can call, it's your connection.",
  media: "Pictures and files aren't loading from here. If friends can see them, it's your connection.",
  tinhat: "The extras (sounds, GIFs, Memories) aren't reachable from here. If they work for friends, it's your connection.",
};
const NOTE_STUCK = "New messages aren't arriving here. If friends can chat, it's your connection.";
const NOTE_ALL = "The server isn't reachable from here. If other websites work, the server itself may be down.";
const NOTE_SLOW = "Your connection to the server is slow right now, so calls may stutter.";

/** The whole check: the rows, your ping, the verdict and the note. */
export function checkOf(input: CheckInput): Check {
  const rows = [chatRow(input.pings, input.syncAgoMs), probeRow("calls", input.calls), probeRow("media", input.media), probeRow("tinhat", input.tinhat)];
  const ping = pingRow(input.pings);
  const red = rows.filter((x) => x.band === "poor");
  const redIds = red.map((x) => x.id as ServiceId);
  let verdict: Check["verdict"];
  let note = "";
  if (red.length === rows.length) {
    verdict = { tone: "poor", text: "Can't reach the server" };
    note = NOTE_ALL;
  } else if (red.length > 0) {
    verdict = { tone: "poor", text: `${namesOf(redIds)} ${plural(redIds) ? "look" : "looks"} down` };
    if (red.length === 1) {
      const x = red[0]!;
      if (x.cause === "error") note = `${namesOf(redIds)} ${plural(redIds) ? "are" : "is"} having problems on the server's side. It's not just you.`;
      else if (x.cause === "stuck") note = NOTE_STUCK;
      else note = NOTE_DOWN[x.id as ServiceId];
    } else if (red.every((x) => x.cause === "error")) note = `${namesOf(redIds)} are having problems on the server's side. It's not just you.`;
    else note = `${namesOf(redIds)} aren't reachable from here. If they work for friends, it's your connection.`;
  } else if (ping.ms === null) {
    verdict = { tone: "ok", text: "Unsteady connection" };
  } else if (ping.band === "poor") {
    verdict = { tone: "ok", text: `Slow connection · ${fmtMs(ping.ms)}` };
    note = NOTE_SLOW;
  } else if (ping.band === "ok" || rows.some((x) => x.band === "ok")) {
    verdict = { tone: "ok", text: `A bit slow · ${fmtMs(ping.ms)}` };
  } else verdict = { tone: "good", text: `All good · ${fmtMs(ping.ms)}` };
  return { rows, ping, verdict, note };
}

// ---- the sparkline (Large) --------------------------------------------------------------------------------------

export interface Sample {
  at: number;
  band: Band;
  ms: number | null;
}
export interface Slot {
  band: Band;
  /** the bar's height, per-mille of the lane */
  h: number;
}

/** A bar's height: red → full; else by the round trip in five steps (under 50 / 150 / 400 / 1000 ms, then full). */
export function barPm(band: Band, ms: number | null): number {
  if (band === "poor" || !isNum(ms)) return 1000;
  const m = r(ms);
  return m < 50 ? 250 : m < 150 ? 450 : m < 400 ? 650 : m < 1000 ? 850 : 1000;
}

/**
 * The last 10 minutes as SPARK_SLOTS one-minute slots ending at `at` (the latest check — so the bars move only when a
 * check lands): slot k (0 = oldest) holds the samples with at − (SPARK_SLOTS − k)·SLOT_MS < t ≤ at − (SPARK_SLOTS −
 * 1 − k)·SLOT_MS; the latest of them (the later one in the list on a tie) paints it; an empty slot is null.
 */
export function sparkSlots(samples: Sample[], at: number): (Slot | null)[] {
  const out: (Slot | null)[] = new Array(SPARK_SLOTS).fill(null);
  const best: (Sample | null)[] = new Array(SPARK_SLOTS).fill(null);
  if (!isNum(at) || !Array.isArray(samples)) return out;
  for (const s of samples) {
    if (!s || !isNum(s.at) || s.at > at || s.at <= at - SPARK_SLOTS * SLOT_MS) continue;
    if (s.band !== "good" && s.band !== "ok" && s.band !== "poor") continue;
    const k = SPARK_SLOTS - 1 - Math.floor((at - s.at) / SLOT_MS);
    const b = best[k];
    if (!b || s.at >= b.at) best[k] = s;
  }
  for (let k = 0; k < SPARK_SLOTS; k++) {
    const b = best[k];
    if (b) out[k] = { band: b.band, h: barPm(b.band, b.ms) };
  }
  return out;
}
