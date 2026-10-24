// gamesStore.ts — the Game Reel controller (port of games.rs GamesController): container from the
// CURRENT room, session (auto-picked from the calendar's upcoming list or set by "Game TBD"),
// presence (the call I'm in), the store read (`loadRoomData`, seeds verified, catalog names), the
// pure snapshot (model/reel.ts compute) and every write: prefs, spin (two writes, seed-derived
// winner, calendar write-back), veto / respin, late arrivals, settings (D8 wire form), adjust,
// void, reset credits; 10.5.2: admin adjustments at "admin:<mxid>" (they now land for everyone),
// per-spin "Don't count for credit", free spins (settings credits.mode). Live: subscribes to the
// container's state events + a 5 s fingerprint poll fallback + the 30 s write-back timer (CAL-84).
import { create } from "zustand";
import { EventType, RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { ensureWritable, getClient, onClientChanged, peekClient } from "@/core/matrix";
import { sendStateRetry as sendState } from "./retry";
import { apiJson, apiUrl, ApiError } from "@/core/api";
import { createLogger } from "@/core/log";
import { serverFeatureOn } from "@/core/server";
import {
  adhocSessionId,
  adjustContent,
  adjustTarget,
  adminAdjustKey,
  creditDetail,
  creditOverrideContent,
  creditOverrideKey,
  creditOverrides,
  defaultSettings,
  effectiveSession,
  emptyPrefs,
  mergeAdjustments,
  zeroContent,
  nightEndMs,
  deriveWinner,
  effectiveWinner,
  prefsFromJson,
  prefsIsEmpty,
  prefsNormalized,
  prefsToJson,
  resetWrites,
  settingsFromJson,
  settingsMerged,
  settingsToJson,
  settingsToWire,
  spinFromJson,
  spinToJson,
  toMicro,
  verify,
  emptySpin,
  type Prefs,
  type SeedEvent,
  type Settings,
  type SpinRecord,
} from "./model/games";
import { compute, draw, gameName, tonight, type CatalogEntry, type RoomData, type Snapshot } from "./model/reel";
import { EVENT_TYPE, GAME_TYPE, RSVP_TYPE, randHex4 } from "./model/calendar";
import { containerForRoom, useCal } from "./calendarStore";

const log = createLogger("games");
export const PREFS_TYPE = "dev.tinhat.games.prefs";
export const SPIN_TYPE = "dev.tinhat.games.spin";
export const SETTINGS_TYPE = "dev.tinhat.games.settings";
export const ADJUST_TYPE = "dev.tinhat.games.adjust";
const POLL_MS = 5_000;
const SEED_FETCH_LIMIT = 30;
const CATALOG_FETCH_LIMIT = 48;
const CATALOG_RETRY_MS = 5 * 60_000;
const SEED_RETRY_MS = 60_000;
/** The catalog base the snapshot's art URLs are built on (same-origin /api/games). */
export const CATALOG_BASE = apiUrl("/games");

type Json = Record<string, unknown>;

export interface GamesState {
  roomId: string;
  containerId: string;
  sessionId: string;
  present: string[];
  data: RoomData | null;
  snap: Snapshot | null;
  myPrefs: Json;
  settingsJson: Json;
  settingsDefaults: Json;
  search: Json[];
  importState: Json;
  simulation: Snapshot | null;
  busy: boolean;
  lastError: string;
  isAdmin: boolean;
  featureEnabled: boolean;
  windowOpen: boolean;
  spinning: boolean;
  gen: number;
}

export const useGames = create<GamesState>()(() => ({
  roomId: "",
  containerId: "",
  sessionId: "",
  present: [],
  data: null,
  snap: null,
  myPrefs: {},
  settingsJson: settingsToJson(defaultSettings()),
  settingsDefaults: settingsToJson(defaultSettings()),
  search: [],
  importState: {},
  simulation: null,
  busy: false,
  lastError: "",
  isAdmin: false,
  featureEnabled: true,
  windowOpen: false,
  spinning: false,
  gen: 0,
}));
const set = useGames.setState;
const get = useGames.getState;

function friendly(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  const code = String((e as { errcode?: string })?.errcode ?? "");
  const http = String((e as { httpStatus?: number })?.httpStatus ?? "");
  if (code === "M_FORBIDDEN" || http === "403" || s.includes("M_FORBIDDEN") || s.includes("403"))
    return "You can't write game-night state here yet — ask a space admin to open the flyout once (that unlocks it for everyone)";
  if (code === "M_LIMIT_EXCEEDED" || http === "429" || s.includes("M_LIMIT_EXCEEDED") || s.includes("429")) return "Slow down a little — the server is rate-limiting";
  return `Couldn't save: ${s}`;
}
class UserError extends Error {}

async function sendStateId(roomId: string, type: string, key: string, content: Json): Promise<string> {
  try {
    return await sendState(roomId, type, key, content);
  } catch (e) {
    throw new UserError(friendly(e));
  }
}

/**
 * 10.5.2 review: wait (≤ `ms`) until the local store holds the state event we just wrote. The send
 * returns before the sync delivers it, so the re-read after an admin credit write could still see the
 * OLD adjustment — busy cleared, and a quick second "+" (or a "+" right after "Zero") started from that
 * stale value and overwrote the first write. Bounded: another admin's newer write simply times out.
 * games.rs `wait_for_echo` is the twin.
 */
async function waitForEcho(roomId: string, type: string, key: string, eventId: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (eventId && Date.now() < until) {
    if (peekClient()?.getRoom(roomId)?.currentState.getStateEvents(type, key)?.getId() === eventId) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------------------------
// catalog (§4.11) — names + art from the server's Tin Hat API, cached; ≤ 48 lookups per refresh, 8 in parallel
// ---------------------------------------------------------------------------------------------

const catalogCache = new Map<string, CatalogEntry>();

function entryFromJson(v: Json, now: number): CatalogEntry {
  const name = typeof v.name === "string" ? v.name.trim() : "";
  return { name, year: typeof v.year === "number" && v.year > 0 ? v.year : 0, fetchedAt: now, ok: name !== "" };
}

export function rememberCatalogEntry(id: string, v: Json): void {
  const e = entryFromJson(v, Date.now());
  if (e.ok) catalogCache.set(id, e);
}

async function resolveCatalog(ids: string[], now: number): Promise<Map<string, CatalogEntry>> {
  const out = new Map<string, CatalogEntry>();
  const missing: string[] = [];
  for (const id of ids) {
    const e = catalogCache.get(id);
    if (e && (e.ok || now - e.fetchedAt < CATALOG_RETRY_MS)) out.set(id, e);
    else missing.push(id);
  }
  // docs/SELFHOST.md: a server without the games catalogue answers nothing — the ids keep their stored names
  const todo = serverFeatureOn("games") ? missing.slice(0, CATALOG_FETCH_LIMIT) : [];
  for (let i = 0; i < todo.length; i += 8) {
    const chunk = todo.slice(i, i + 8);
    const res = await Promise.all(
      chunk.map(async (id) => {
        try {
          const v = await apiJson<Json>(`/games/game/${encodeURIComponent(id)}`, { timeoutMs: 20000 } as never);
          const g = (v && typeof v.game === "object" ? (v.game as Json) : v) ?? {};
          return [id, entryFromJson(g, now)] as const;
        } catch (e) {
          log.debug(`catalog ${id}: ${e}`);
          return [id, { name: "", year: 0, fetchedAt: now, ok: false }] as const;
        }
      }),
    );
    for (const [id, e] of res) {
      catalogCache.set(id, e);
      out.set(id, e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// store read (games.rs load_room_data)
// ---------------------------------------------------------------------------------------------

interface FullState {
  stateKey: string;
  sender: string;
  eventId: string;
  ts: number;
  content: Json;
}

function stateFull(room: Room, type: string): FullState[] {
  return room.currentState.getStateEvents(type).map((ev: MatrixEvent) => ({
    stateKey: ev.getStateKey() ?? "",
    sender: ev.getSender() ?? "",
    eventId: ev.getId() ?? "",
    ts: ev.getTs(),
    content: (ev.getContent() ?? {}) as Json,
  }));
}
const nonEmpty = (c: Json) => !!c && typeof c === "object" && Object.keys(c).length > 0;

const seedCache = new Map<string, { at: number; event: SeedEvent | null }>();

async function fetchSeed(client: MatrixClient, roomId: string, eventId: string, now: number): Promise<SeedEvent | null> {
  const hit = seedCache.get(eventId);
  if (hit && (hit.event || now - hit.at < SEED_RETRY_MS)) return hit.event;
  let ev: SeedEvent | null = null;
  try {
    const raw = (await client.fetchRoomEvent(roomId, eventId)) as unknown as SeedEvent;
    ev = raw && typeof raw === "object" ? { origin_server_ts: raw.origin_server_ts, sender: raw.sender, content: raw.content } : null;
  } catch (e) {
    log.debug(`seed ${eventId} fetch failed: ${e}`);
  }
  seedCache.set(eventId, { at: now, event: ev });
  return ev;
}

function fnv(h: bigint, s: string): bigint {
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/** games.rs fingerprint — cheap change detection over the local store. */
function fingerprint(room: Room, sessionId: string): string {
  let fp = 0xcbf29ce484222325n;
  const s = room.currentState.getStateEvents(SETTINGS_TYPE, "")?.getContent();
  fp = fnv(fp, String(typeof s?.rev === "number" ? s.rev : 0));
  for (const t of [PREFS_TYPE, ADJUST_TYPE, SPIN_TYPE]) {
    for (const e of stateFull(room, t)) {
      if (!nonEmpty(e.content)) continue;
      if (t === PREFS_TYPE && e.stateKey !== e.sender) continue;
      fp = fnv(fp, e.eventId);
    }
  }
  for (const e of stateFull(room, EVENT_TYPE)) if (e.stateKey === sessionId && typeof e.content.title === "string" && e.content.title.trim()) fp = fnv(fp, e.eventId);
  for (const e of stateFull(room, RSVP_TYPE)) if (e.content && Object.prototype.hasOwnProperty.call(e.content, sessionId)) fp = fnv(fp, e.eventId);
  // 10.5.1: tonight's ad-hoc session rolls over at 14:00 UTC, a fixed day boundary — the poll sees the new id (always
  // hashed: a picked event that vanished falls back to it too)
  fp = fnv(fp, adhocSessionId(Date.now()));
  return fp.toString(16);
}

function myPowerLevel(room: Room, me: string): number {
  return room.getMember(me)?.powerLevel ?? 0;
}

/** Room versions without "hydra" power levels (js-sdk utils/roomVersion PRE_HYDRA_ROOM_VERSIONS). */
const PRE_HYDRA = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];

/** Anyone's power level from m.room.power_levels (also for people who left — a sender of old state).
 * Room v12+ ("hydra"): the creators (m.room.create sender + additional_creators) are above every level,
 * like ruma's `UserPowerLevel::Infinite` on the desktop. */
function powerLevelOf(room: Room, mxid: string): number {
  const create = room.currentState.getStateEvents(EventType.RoomCreate, "");
  const version = String((create?.getContent() as Json | undefined)?.room_version ?? "1");
  if (create && !PRE_HYDRA.includes(version)) {
    const extra = (create.getContent() as Json).additional_creators;
    if (create.getSender() === mxid || (Array.isArray(extra) && extra.includes(mxid))) return Infinity;
  }
  const c = room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() as Json | undefined;
  const users = c && typeof c.users === "object" && c.users ? (c.users as Record<string, unknown>) : {};
  const v = users[mxid];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const d = c?.users_default;
  return typeof d === "number" && Number.isFinite(d) ? d : 0;
}

export async function loadRoomData(client: MatrixClient, cid: string, sessionId: string, present: string[] = [], opts: { readOnly?: boolean } = {}): Promise<RoomData | null> {
  const me = client.getUserId() ?? "";
  const room = client.getRoom(cid);
  if (!room) return null;
  const now = Date.now();
  // 10.5.1: with no (or a vanished) calendar session the reel works on tonight's ad-hoc session —
  // its records are "this session's" for seed verification too
  const adhoc = adhocSessionId(now);
  const current = (sid: string) => sid === sessionId || sid === adhoc;
  // widgets W2 (Game night reads the credit): a reader never changes the room's power levels
  if (!opts.readOnly) await ensureWritable(cid, [PREFS_TYPE, SPIN_TYPE]);
  const myPl = myPowerLevel(room, me);
  const canWrite = room.currentState.maySendStateEvent(SPIN_TYPE, me);
  const sRaw = room.currentState.getStateEvents(SETTINGS_TYPE, "")?.getContent();
  const settings = sRaw && typeof sRaw === "object" && !Array.isArray(sRaw) ? settingsFromJson(sRaw) : defaultSettings();

  const prefs = new Map<string, Prefs>();
  for (const e of stateFull(room, PREFS_TYPE)) {
    if (!e.stateKey || e.stateKey !== e.sender || !nonEmpty(e.content)) continue;
    prefs.set(e.stateKey, prefsNormalized(prefsFromJson(e.content), settings.favorite_slots));
  }
  // 10.5.2: an adjustment counts only while its sender is an admin (power level ≥ admin.min_pl) —
  // the admin key "admin:<mxid>" or the legacy self-key; per person the one written last wins
  const isAdminNow = (m: string) => powerLevelOf(room, m) >= settings.admin_min_pl;
  const adjustEvents = stateFull(room, ADJUST_TYPE).map((e) => ({ stateKey: e.stateKey, sender: e.sender, ts: e.ts, content: e.content }));
  const adjustments = mergeAdjustments(adjustEvents, isAdminNow);

  const spins: SpinRecord[] = [];
  for (const e of stateFull(room, SPIN_TYPE)) {
    if (!nonEmpty(e.content)) continue;
    const rec = spinFromJson(e.stateKey, e.eventId, e.ts, e.sender, e.content);
    if (rec.session_id && rec.pool.length) spins.push(rec);
  }
  spins.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = spins.map((_, i) => i).sort((a, b) => {
    const pa = current(spins[a].session_id) ? 1 : 0;
    const pb = current(spins[b].session_id) ? 1 : 0;
    return pb - pa || spins[b].ts - spins[a].ts;
  });
  let fetched = 0;
  for (const i of order) {
    const seed = spins[i].seed;
    let ev: SeedEvent | null = null;
    if (seed && (current(spins[i].session_id) || fetched < SEED_FETCH_LIMIT)) {
      fetched++;
      ev = await fetchSeed(client, cid, seed, now);
    }
    // rec.sender is still the CURRENT copy's sender here (verify swaps in the seed's spinner)
    await verify(spins[i], ev, isAdminNow(spins[i].sender));
  }
  // 10.5.2: an admin's "Don't count for credit" / "Count for credit" (admin-only state, see creditOverrides)
  const overrides = creditOverrides(adjustEvents, isAdminNow);
  for (const sp of spins) {
    const o = overrides.get(sp.id);
    if (o !== undefined) sp.credit = o;
  }
  spins.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const events = new Map<string, Json>();
  for (const e of stateFull(room, EVENT_TYPE)) if (typeof e.content.title === "string" && e.content.title.trim()) events.set(e.stateKey, e.content);
  const rsvps = new Map<string, Array<[string, string]>>();
  for (const e of stateFull(room, RSVP_TYPE)) {
    if (!e.content || typeof e.content !== "object") continue;
    for (const [eid, entry] of Object.entries(e.content)) {
      const st = entry && typeof entry === "object" && typeof (entry as Json).status === "string" ? ((entry as Json).status as string) : "";
      if (!st) continue;
      let l = rsvps.get(eid);
      if (!l) rsvps.set(eid, (l = []));
      l.push([e.stateKey, st]);
    }
  }
  const calGames = stateFull(room, GAME_TYPE)
    .filter((e) => typeof e.content.name === "string" && e.content.name)
    .map((e) => ({ ...e.content, slug: e.stateKey }));

  const mxids = new Set<string>([...prefs.keys(), ...adjustments.keys()]);
  for (const sp of spins) {
    sp.roster.forEach((p) => mxids.add(p));
    mxids.add(sp.sender);
    if (sp.voided) mxids.add(sp.voided.by);
  }
  for (const [u] of rsvps.get(sessionId) ?? []) mxids.add(u);
  // 10.5.1 open roster: everyone in the call is on it, RSVP or not — name them too
  for (const p of present) mxids.add(p);
  if (me) mxids.add(me);
  const people = new Map<string, { name: string; avatar: string }>();
  for (const m of mxids) {
    if (!m.startsWith("@")) continue;
    const mem = room.getMember(m);
    const local = m.replace(/^@+/, "").split(":")[0] ?? m;
    people.set(m, { name: mem?.rawDisplayName && mem.rawDisplayName !== m ? mem.rawDisplayName : local, avatar: mem?.getMxcAvatarUrl() ?? "" });
  }
  const ids: string[] = [];
  const push = (id: string) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const p of prefs.values()) [...p.would_play, ...p.favorites, ...p.definitely_not].forEach(push);
  for (const sp of [...spins].reverse()) {
    sp.pool.forEach(([g]) => push(g));
    const w = effectiveWinner(sp);
    if (w) push(w);
  }
  const gid = events.get(sessionId)?.gameId;
  if (typeof gid === "string") push(gid);
  const catalog = await resolveCatalog(ids, now);
  return { me, myPl, canWrite, settings, prefs, adjustments, spins, events, rsvps, people, catalog, calGames };
}

/** widgets W2 (the Game night widget, WIDGETS.md §23): MY banked Game Reel credit in space `cid` for session
 *  `sessionId` — the Reel's own computation (loadRoomData READ-ONLY: no power-level write, + compute's credit rows) —
 *  and the credits mode ("free" = spins don't use credit). null credit = unknown (no room data / not listed). */
export async function myCredit(cid: string, sessionId: string): Promise<{ credit: number | null; mode: string }> {
  const client = peekClient();
  if (!client || !cid) return { credit: null, mode: "" };
  const data = await loadRoomData(client, cid, sessionId, [], { readOnly: true });
  if (!data) return { credit: null, mode: "" };
  const c = compute(data, CATALOG_BASE, sessionId, [], data.settings, Date.now());
  const row = c.snap.credits.find((x) => x.mxid === data.me);
  return { credit: row ? row.credit : 0, mode: String(c.snap.creditsMode ?? "") };
}

// ---------------------------------------------------------------------------------------------
// refresh / recompute / live
// ---------------------------------------------------------------------------------------------

let writebackDue = 0;
let lastFp = "";

function recompute(): ReturnType<typeof compute> | null {
  const { data, sessionId, present } = get();
  if (!data) return null;
  const c = compute(data, CATALOG_BASE, sessionId, present, data.settings, Date.now());
  const myPrefs = data.prefs.get(data.me);
  set({
    snap: c.snap,
    myPrefs: myPrefs ? prefsToJson(myPrefs) : {},
    isAdmin: c.isAdmin,
    featureEnabled: data.settings.feature_enabled,
    settingsJson: settingsToJson(data.settings),
  });
  writebackDue = c.writebackDue;
  return c;
}

export async function refresh(): Promise<void> {
  const cid = get().containerId;
  const client = peekClient();
  if (!cid || !client) return;
  const gen = get().gen + 1;
  set({ gen, busy: true });
  const session = get().sessionId;
  try {
    const data = await loadRoomData(client, cid, session, get().present);
    if (!data) return;
    // the room / session moved on while this read ran: no side effects, no stale publish
    if (get().gen !== gen || get().containerId !== cid || get().sessionId !== session) return;
    const now = Date.now();
    const c = compute(data, CATALOG_BASE, session, get().present, data.settings, now);
    if (c.writeback && c.writebackDue > 0 && now >= c.writebackDue) {
      await writeBackCalendar(cid, c.sessionId, c.writeback[0], c.writeback[1]);
    }
    const room = client.getRoom(cid);
    if (room) lastFp = fingerprint(room, session);
    if (get().gen !== gen) return;
    set({ data });
    recompute();
  } catch (e) {
    log.warn(`refresh failed: ${e}`);
  } finally {
    if (get().gen === gen) set({ busy: false });
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let detach: (() => void) | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLive(): void {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    void refresh();
  }, 250);
}

/** games.rs start(): the 5 s poll (fingerprint + write-back due) + a state-event subscription. */
export function start(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    // GPU.md §2.8 (C6): the poll only runs while the reel window is open (or a calendar write-back is still due) —
    // it used to run for the rest of the session once the reel had been opened; setWindowOpen(true) restarts it
    if (!get().windowOpen && !(writebackDue > 0)) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const cid = get().containerId;
    const room = peekClient()?.getRoom(cid);
    if (!cid || !room) return;
    const fp = fingerprint(room, get().sessionId);
    const due = writebackDue > 0 && Date.now() >= writebackDue;
    if ((lastFp && fp !== lastFp) || due) {
      lastFp = fp;
      if (due) writebackDue = 0;
      void refresh();
    } else if (!lastFp) lastFp = fp;
  }, POLL_MS);
  attach();
}

const WATCH = new Set([PREFS_TYPE, SPIN_TYPE, SETTINGS_TYPE, ADJUST_TYPE, EVENT_TYPE, RSVP_TYPE, GAME_TYPE, EventType.RoomPowerLevels]);
function attach(): void {
  detach?.();
  const client = peekClient();
  if (!client) return;
  const on = (ev: MatrixEvent) => {
    if (ev.getRoomId() === get().containerId && WATCH.has(ev.getType())) scheduleLive();
  };
  client.on(RoomStateEvent.Events, on);
  detach = () => client.off(RoomStateEvent.Events, on);
}
onClientChanged(() => {
  attach();
  if (!peekClient()) set({ roomId: "", containerId: "", data: null, snap: null, sessionId: "" });
});

export function setRoom(roomId: string): void {
  if (!roomId || roomId === get().roomId) return;
  set({ roomId });
  const cid = containerForRoom(roomId);
  if (!cid) return;
  if (cid !== get().containerId) {
    set({ containerId: cid, data: null, snap: null, gen: get().gen + 1, busy: false });
    lastFp = "";
    writebackDue = 0;
  }
  if (get().windowOpen) void refresh();
}

let sessionExplicit = false;
/** 10.5.1: the session pickSession chose itself (kept only while it is tonight's); anything else set = explicit. */
let autoPicked = "";
/** A full refresh (another session's seeds need verifying). */
export function setSession(id: string, explicit = false): void {
  if (explicit) sessionExplicit = true;
  if (explicit && id === autoPicked) autoPicked = "";
  if (id === get().sessionId) return;
  set({ sessionId: id, gen: get().gen + 1, busy: false });
  if (get().windowOpen) void refresh();
}

/**
 * CAL-71 auto-pick: the first upcoming non-canceled non-focus event without a game, else the first.
 * 10.5.1: only a session that starts before tonight's game night ends (the next 14:00 UTC, a fixed day
 * boundary, `nightEndMs`) auto-picks, and an auto-pick is dropped once it no longer is tonight's (moved,
 * canceled, over); with none the reel spins for tonight on its own (the ad-hoc `night-…` session)
 * instead of writing tonight's pick into next week's event. An explicit pick (the calendar's Game
 * TBD pill) stands while its event exists, isn't canceled and hasn't ended (a proposal without a
 * time counts as open). GameReelPanel.qml pickSession is the same rule.
 */
export function pickSession(): void {
  const cur = get().sessionId;
  const { upcoming, events } = useCal.getState();
  const now = Date.now();
  const nightEnd = nightEndMs(now);
  const tonightsSession = (e: (typeof upcoming)[number] | undefined) => !!e && !e.canceled && e.kind !== "focus" && e.effStart > 0 && e.effStart < nightEnd;
  if (cur && cur === autoPicked) {
    if (upcoming.some((e) => e.id === cur && tonightsSession(e))) return;
  } else if (cur) {
    if (upcoming.some((e) => e.id === cur)) return;
    if (events.some((e) => e.id === cur && !e.canceled && (e.effStart === 0 || e.effEnd >= now))) return;
    sessionExplicit = false; // an explicit pick stood until its event was over
  }
  let pick = null as (typeof upcoming)[number] | null;
  for (const e of upcoming) {
    if (!tonightsSession(e)) continue;
    if (!e.game) {
      pick = e;
      break;
    }
    if (!pick) pick = e;
  }
  if (pick) {
    autoPicked = pick.id;
    if (pick.id !== cur) setSession(pick.id);
  } else if (cur) {
    autoPicked = "";
    setSession("");
  }
}

export function setPresent(list: string[]): void {
  const dedup: string[] = [];
  for (const p of list) if (p.startsWith("@") && !dedup.includes(p)) dedup.push(p);
  const cur = get().present;
  if (dedup.length === cur.length && dedup.every((p, i) => p === cur[i])) return;
  set({ present: dedup });
  const c = recompute();
  const data = get().data;
  // 10.5.1 open roster: the pool above is already live; someone the last read never named (no
  // prefs / RSVP / spin on record) gets a re-read so the header shows who they are
  if (data && get().windowOpen && dedup.some((p) => !data.people.has(p))) void refresh();
  if (!c || !data || !c.standing) return;
  // 10.5.1 open roster: outside a call the roster is the planned-roster PREVIEW (RSVPs + me), not
  // arrivals — leaving the call within the grace window must not append the RSVP'd no-shows as late
  // arrivals (games.rs set_present does the same)
  if (data.settings.roster_presence === "open" && dedup.length === 0) return;
  const st = c.standing;
  const graceMs = data.settings.roster_grace_min * 60_000;
  const now = Date.now();
  if (st.sender !== data.me || graceMs === 0 || st.voided || now - st.ts > graceMs) return;
  const newcomers = c.rosterActual.filter((p) => !st.roster.includes(p));
  if (newcomers.length === 0) return;
  const cid = get().containerId;
  void doLateArrivals(cid, st.id, newcomers)
    .then(() => refresh())
    .catch((e) => log.warn(`late arrivals not recorded: ${e}`));
}

// ---------------------------------------------------------------------------------------------
// writes (games.rs)
// ---------------------------------------------------------------------------------------------

function fail(msg: string): void {
  log.warn(msg);
  set({ lastError: msg });
}
export const clearError = () => set({ lastError: "" });

export async function savePrefs(payload: Json): Promise<void> {
  const cid = get().containerId;
  if (!cid) return;
  set({ lastError: "" });
  try {
    const client = getClient();
    const me = client.getUserId() ?? "";
    await ensureWritable(cid, [PREFS_TYPE, SPIN_TYPE]);
    const sRaw = client.getRoom(cid)?.currentState.getStateEvents(SETTINGS_TYPE, "")?.getContent();
    const settings = sRaw ? settingsFromJson(sRaw) : defaultSettings();
    const p = prefsNormalized(prefsFromJson(payload), settings.favorite_slots);
    p.updated_at = Date.now();
    await sendStateId(cid, PREFS_TYPE, me, prefsIsEmpty(p) ? {} : prefsToJson(p));
    log.info(`prefs saved: ${p.would_play.length} would-play, favorite ${p.favorites[0] ?? "-"}, flexible ${p.flexible}`);
    await refresh();
  } catch (e) {
    fail(e instanceof UserError ? e.message : friendly(e));
  }
}

type SpinMode = "initial" | "veto" | "respin";

async function doSpin(cid: string, pickedSession: string, present: string[], mode: SpinMode): Promise<void> {
  const client = getClient();
  await ensureWritable(cid, [PREFS_TYPE, SPIN_TYPE]);
  const data = await loadRoomData(client, cid, pickedSession, present);
  if (!data) throw new UserError("Couldn't read the space");
  const s = data.settings;
  const now = Date.now();
  const c = compute(data, CATALOG_BASE, pickedSession, present, s, now);
  // 10.5.1: the session compute resolved (tonight's ad-hoc id when no calendar session is picked)
  const sessionId = c.sessionId;
  const me = data.me;
  const t = tonight(data, sessionId, present, s);
  // Native bug fixed (docs/native-bugs/calendar.md): native points `supersedes` at the STANDING
  // record; after an admin voided the latest re-spin that makes every later veto/re-spin a sibling of
  // the voided record, which (older) wins the race — the session is stuck. The web chains onto the
  // chain's TAIL (voided or not); native readers resolve that chain to the new record.
  const chainTail = (fallback: string) => {
    const chain = t.resolved.get(sessionId)?.chain ?? [];
    return chain.length ? chain[chain.length - 1] : fallback;
  };
  let kind = "initial";
  let supersedes: string | null = null;
  let vetoed: string[] = [];
  let vetoBy: Record<string, string> = {};
  if (mode === "initial") {
    if (c.standing) throw new UserError("Someone already spun — the result is on its way.");
    if (!c.canSpin) throw new UserError(c.notice || "Can't spin right now.");
    // 10.5.1: after an admin voided tonight's spin a new initial spin with no `supersedes` was a
    // sibling of the voided record and lost the race to it (nothing ever stood again) — chain it
    // onto the tail (games.rs do_spin does the same)
    const chain = t.resolved.get(sessionId)?.chain ?? [];
    if (chain.length) supersedes = chain[chain.length - 1];
  } else if (mode === "veto") {
    const st = c.standing;
    if (!st) throw new UserError("Nothing to veto yet.");
    if (!c.canVeto) throw new UserError("You can't veto this one.");
    const w = effectiveWinner(st);
    if (!w) throw new UserError("No result to veto.");
    vetoed = [...st.vetoed];
    if (!vetoed.includes(w)) vetoed.push(w);
    vetoBy = { ...st.veto_by, [w]: me };
    kind = "respin";
    supersedes = chainTail(st.id);
  } else {
    const st = c.standing;
    if (!st) throw new UserError("Nothing to re-spin yet.");
    // native skips this check (a re-spin still worked with game night switched off) — review finding
    if (!s.feature_enabled) throw new UserError("Game night is switched off.");
    if (c.respinsLeft === 0) throw new UserError("No re-spins left tonight.");
    if (!t.roster.actual.includes(me)) throw new UserError("You're not on tonight's roster.");
    kind = "respin";
    supersedes = chainTail(st.id);
    vetoed = [...st.vetoed];
    vetoBy = { ...st.veto_by };
  }
  const [, reel] = draw(t, data, s, vetoed);
  if (reel.length === 0) throw new UserError("No game left to spin — everything was vetoed.");
  const favorites: Record<string, string> = {};
  for (const p of t.roster.actual) {
    if (t.roster.flexible.includes(p)) continue;
    const f = data.prefs.get(p)?.favorites[0];
    if (f) favorites[p] = f;
  }
  const rec: SpinRecord = {
    ...emptySpin(),
    id: `sp-${now}-${randHex4()}`,
    session_id: sessionId,
    kind,
    supersedes,
    vetoed,
    veto_by: vetoBy,
    roster: [...t.roster.actual],
    maybes: [...t.roster.maybes],
    flexible: [...t.roster.flexible],
    favorites,
    // DECISIONS D8: integer micro-units on the wire (Synapse refuses floats in room v10 state).
    pool: reel.map(([id, w]) => [id, toMicro(w)] as [string, number]),
    settings_rev: s.rev,
    // 10.5.2 free spins: captured at write time (write 1 = the seed, so it can't be flipped later by
    // anyone but an admin) — changing credits.mode never rewrites history
    credit: s.credits_mode !== "free",
  };
  // Write 1: no winner — its event id is the seed nobody controls.
  const seed = await sendStateId(cid, SPIN_TYPE, rec.id, spinToJson(rec));
  const winner = await deriveWinner(seed, rec.pool);
  if (!winner) throw new UserError("The draw came up empty");
  rec.seed = seed;
  rec.winner = winner;
  try {
    await sendState(cid, SPIN_TYPE, rec.id, spinToJson(rec));
  } catch (e) {
    log.warn(`winner write failed after seed ${seed}: ${e}`); // every client derives it from write 1
  }
  log.info(`spin ${rec.id} (${rec.kind}) in ${sessionId}: seed ${seed} → ${winner} over ${rec.pool.length} games`);
  await writeBackCalendar(cid, sessionId, winner, gameName(data, winner));
}

/** §7.2 write-back: the session event gets `game` + `gameId` (idempotent, every field kept). */
async function writeBackCalendar(cid: string, sessionId: string, gameId: string, name: string): Promise<boolean> {
  const ev = peekClient()?.getRoom(cid)?.currentState.getStateEvents(EVENT_TYPE, sessionId)?.getContent() as Json | undefined;
  if (!ev || typeof ev.title !== "string" || !ev.title.trim()) return false;
  if (ev.gameId === gameId) return true;
  try {
    await sendState(cid, EVENT_TYPE, sessionId, { ...ev, game: name, gameId, updatedAt: Date.now() });
    log.info(`calendar ${sessionId} set to ${name} (${gameId})`);
    return true;
  } catch (e) {
    log.warn(`calendar write-back failed: ${e}`);
    return false;
  }
}

async function doLateArrivals(cid: string, spinId: string, newcomers: string[]): Promise<void> {
  const ev = peekClient()?.getRoom(cid)?.currentState.getStateEvents(SPIN_TYPE, spinId);
  if (!ev) throw new UserError("Spin vanished");
  const c = { ...(ev.getContent() as Json) };
  if (typeof c.seed !== "string" || !c.seed) c.seed = ev.getId() ?? "";
  const roster = Array.isArray(c.roster) ? (c.roster.filter((x) => typeof x === "string") as string[]) : [];
  const late = Array.isArray(c.late) ? (c.late.filter((x) => typeof x === "string") as string[]) : [];
  let changed = false;
  for (const p of newcomers) {
    if (!roster.includes(p)) {
      roster.push(p);
      late.push(p);
      changed = true;
    }
  }
  if (!changed) return;
  await sendStateId(cid, SPIN_TYPE, spinId, { ...c, roster, late });
}

async function runSpin(mode: SpinMode): Promise<void> {
  const { containerId: cid, sessionId, present, spinning } = get();
  // 10.5.1: an empty session is fine — doSpin resolves it to tonight's ad-hoc session
  if (!cid || spinning) return;
  set({ spinning: true, lastError: "", busy: true });
  try {
    await doSpin(cid, sessionId, present, mode);
  } catch (e) {
    fail(e instanceof UserError ? e.message : friendly(e));
  } finally {
    set({ spinning: false });
    await refresh();
  }
}
export const spin = () => runSpin("initial");
export const veto = () => runSpin("veto");
export const respin = () => runSpin("respin");

async function adminWrite(guard: string, fn: () => Promise<void>): Promise<void> {
  if (!get().containerId) return;
  if (!get().isAdmin) return fail(guard);
  // busy from the write until the re-read: the credit buttons stay disabled, so two clicks can't
  // both read the same cumulative adjustment and overwrite each other
  set({ lastError: "", busy: true });
  try {
    await fn();
    await refresh();
  } catch (e) {
    fail(e instanceof UserError ? e.message : friendly(e));
    set({ busy: false });
  }
}

/** Save the admin's settings patch (merged over the CURRENT stored settings, rev + 1) — D8 wire form. */
export function saveSettings(patch: Json): Promise<void> {
  return adminWrite("Only a space admin can tune game night", async () => {
    const cid = get().containerId;
    const client = getClient();
    const me = client.getUserId() ?? "";
    const sRaw = client.getRoom(cid)?.currentState.getStateEvents(SETTINGS_TYPE, "")?.getContent();
    const current = sRaw ? settingsFromJson(sRaw) : defaultSettings();
    const next: Settings = { ...settingsMerged(current, patch), rev: current.rev + 1 };
    const wire = settingsToWire(next);
    if (wire.error || !wire.content) throw new UserError(wire.error ?? "Bad settings data");
    await sendStateId(cid, SETTINGS_TYPE, "", { ...wire.content, updatedBy: me, updatedAt: Date.now() });
    log.info(`settings rev ${next.rev} saved by ${me}`);
  });
}

/** The store read the admin credit writes start from + tonight's history (finals of other sessions). */
async function creditBase(): Promise<{ cid: string; me: string; data: RoomData; finals: SpinRecord[] }> {
  const { containerId: cid, sessionId: picked, present } = get();
  const client = getClient();
  const me = client.getUserId() ?? "";
  const data = await loadRoomData(client, cid, picked, present);
  if (!data) throw new UserError("Couldn't read the space");
  const sessionId = effectiveSession(picked, data.events.has(picked), Date.now());
  // every result so far, TONIGHT'S TOO: a win tonight has already spent an old offset, so a "+1" given
  // after it must not carry that offset forward (the Tune list shows the same, see reel.ts compute)
  const finals = tonight(data, sessionId, present, data.settings).finalsAll;
  return { cid, me, data, finals };
}

/**
 * Admin ±N on one person's credit (Tune → Credit). 10.5.2: written at "admin:<mxid>" — the target's
 * own @-key is refused by Matrix for anyone but them — starting from the adjustment that counts now
 * (`adjustContent`: a live offset carries forward, a lapsed one starts over).
 */
export function adjustCredit(mxid: string, delta: number, reason: string): Promise<void> {
  if (!mxid.startsWith("@") || delta === 0) return Promise.resolve();
  return adminWrite("Only a space admin can adjust credit", async () => {
    const { cid, me, data, finals } = await creditBase();
    const cur = data.adjustments.get(mxid) ?? null;
    const live = creditDetail(mxid, finals, data.prefs.get(mxid) ?? emptyPrefs(), data.settings, cur).offsetLive;
    const key = adminAdjustKey(mxid);
    await waitForEcho(cid, ADJUST_TYPE, key, await sendStateId(cid, ADJUST_TYPE, key, adjustContent(cur, live, delta, reason, me, Date.now())));
    log.info(`credit of ${mxid} adjusted by ${delta > 0 ? "+" : ""}${delta} by ${me}`);
  });
}

/** Admin: one person's credit back to 0 as of now (Tune → Credit → Zero). */
export function zeroCredit(mxid: string): Promise<void> {
  if (!mxid.startsWith("@")) return Promise.resolve();
  return adminWrite("Only a space admin can reset credits", async () => {
    const cid = get().containerId;
    const me = getClient().getUserId() ?? "";
    const key = adminAdjustKey(mxid);
    await waitForEcho(cid, ADJUST_TYPE, key, await sendStateId(cid, ADJUST_TYPE, key, zeroContent("Reset", me, Date.now())));
    log.info(`credit of ${mxid} reset by ${me}`);
  });
}

export function voidSpin(spinId: string, reason: string): Promise<void> {
  if (!spinId) return Promise.resolve();
  return adminWrite("Only a space admin can void a spin", async () => {
    const cid = get().containerId;
    const client = getClient();
    const me = client.getUserId() ?? "";
    const ev = client.getRoom(cid)?.currentState.getStateEvents(SPIN_TYPE, spinId);
    const c = ev?.getContent() as Json | undefined;
    if (!ev || !c || typeof c !== "object") throw new UserError("No such spin");
    const next: Json = { ...c };
    if (typeof next.seed !== "string" || !next.seed) next.seed = ev.getId() ?? "";
    next.voided = { by: me, reason: reason.trim(), at: Date.now() };
    await sendStateId(cid, SPIN_TYPE, spinId, next);
  });
}

/** A record without its winner younger than this is a spin still in flight (write 1 → write 2). */
const LANDING_MS = 20_000;

/**
 * Admin "Reset spins" (next to "N re-spins left"): tonight's spins are voided and the re-spins used
 * stop counting, so the next spin starts fresh — full re-spins, vetoes back. Every client reads it
 * unchanged, desktop 10.5.0 / 10.5.1 included (see `resetWrites` for the wire form and why a plain void
 * isn't enough). A fresh read like doSpin; refuses while a spin is still landing (its winner write
 * would overwrite the void); a retry after a partial failure only writes what is left.
 */
export function resetSpins(): Promise<void> {
  return adminWrite("Only a space admin can reset tonight's spins", async () => {
    const { containerId: cid, sessionId: picked, present } = get();
    const client = getClient();
    const me = client.getUserId() ?? "";
    const data = await loadRoomData(client, cid, picked, present);
    const room = client.getRoom(cid);
    if (!data || !room) throw new UserError("Couldn't read the space");
    const now = Date.now();
    const sessionId = compute(data, CATALOG_BASE, picked, present, data.settings, now).sessionId;
    const chain = tonight(data, sessionId, present, data.settings).resolved.get(sessionId)?.chain ?? [];
    const mine = stateFull(room, SPIN_TYPE).filter((e) => nonEmpty(e.content) && e.content.sessionId === sessionId);
    if (mine.some((e) => typeof e.content.winner !== "string" && !e.content.voided && now - e.ts < LANDING_MS)) throw new UserError("A spin is still landing — try again in a moment.");
    const writes = resetWrites(chain, mine.map((e) => ({ id: e.stateKey, eventId: e.eventId, content: e.content })), me, now);
    for (const [id, content] of writes) await sendStateId(cid, SPIN_TYPE, id, content);
    log.info(`spins reset in ${sessionId} by ${me}: ${writes.length} write(s) over ${mine.length} record(s), chain ${chain.length}`);
  });
}

/**
 * Admin "Don't count for credit" / "Count for credit" on one spin (tonight's result or a past
 * night's): `dev.tinhat.games.adjust` "credit:<spin id>" `{credit, by, at}` (creditOverrideContent) —
 * admin-only state next to the adjustments, so no member rewrite of the record can undo it; the spin
 * record itself is not touched (it still verifies, the result stands).
 */
export function setSpinCredit(spinId: string, counts: boolean): Promise<void> {
  if (!spinId) return Promise.resolve();
  return adminWrite("Only a space admin can change what counts for credit", async () => {
    const cid = get().containerId;
    const client = getClient();
    const me = client.getUserId() ?? "";
    const c = client.getRoom(cid)?.currentState.getStateEvents(SPIN_TYPE, spinId)?.getContent() as Json | undefined;
    if (!c || !nonEmpty(c)) throw new UserError("No such spin");
    const key = creditOverrideKey(spinId);
    await waitForEcho(cid, ADJUST_TYPE, key, await sendStateId(cid, ADJUST_TYPE, key, creditOverrideContent(counts, me, Date.now())));
    log.info(`spin ${spinId} ${counts ? "counts for credit" : "no longer counts for credit"} (${me})`);
  });
}

export function resetCredits(): Promise<void> {
  return adminWrite("Only a space admin can reset credits", async () => {
    const cid = get().containerId;
    const client = getClient();
    const me = client.getUserId() ?? "";
    const room = client.getRoom(cid);
    if (!room) return;
    const now = Date.now();
    const people = new Set<string>();
    for (const e of stateFull(room, PREFS_TYPE)) if (nonEmpty(e.content)) people.add(e.stateKey);
    for (const e of stateFull(room, ADJUST_TYPE)) {
      const t = adjustTarget(e.stateKey);
      if (t) people.add(t[0]);
    }
    for (const e of stateFull(room, SPIN_TYPE)) if (Array.isArray(e.content.roster)) for (const p of e.content.roster) if (typeof p === "string") people.add(p);
    // 10.5.2: one reset line per person at "admin:<mxid>". Up to 10.5.1 it went to the person's own
    // @-key, which Matrix (room v10 auth rules) refuses for anyone but them — only the admin's own
    // credit was ever reset. Keep going past a failure and say who is left.
    const failed: string[] = [];
    let last: [string, string] | null = null;
    for (const p of [...people].sort()) {
      if (!p.startsWith("@")) continue;
      try {
        last = [adminAdjustKey(p), await sendStateId(cid, ADJUST_TYPE, adminAdjustKey(p), zeroContent("Reset", me, now))];
      } catch {
        failed.push(p);
      }
    }
    // the sync delivers in order: once the last reset is local, so are the others (see waitForEcho)
    if (last) await waitForEcho(cid, ADJUST_TYPE, last[0], last[1]);
    if (failed.length) throw new UserError(`Couldn't reset ${failed.join(", ")} — try again`);
    log.info(`credits reset for ${people.size} people by ${me}`);
  });
}

/** The admin simulator: the same snapshot under `patch` laid over the saved settings. Pure. */
export function simulate(patch: Json): void {
  const { data, sessionId, present } = get();
  if (!data) return set({ simulation: null });
  const s = settingsMerged(data.settings, patch);
  set({ simulation: compute(data, CATALOG_BASE, sessionId, present, s, Date.now()).snap });
}

// ---- catalog calls (My games editor) --------------------------------------------------------------

let searchAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

export function searchCatalog(q0: string): void {
  const q = q0.trim();
  if (searchTimer) clearTimeout(searchTimer);
  searchAbort?.abort();
  if (!q) {
    set({ search: [] });
    return;
  }
  searchTimer = setTimeout(async () => {
    const ac = new AbortController();
    searchAbort = ac;
    try {
      const v = await apiJson<Json>(`/games/search?q=${encodeURIComponent(q)}`, { signal: ac.signal, timeoutMs: 20000 });
      const list = (Array.isArray(v.items) ? v.items : Array.isArray(v.results) ? v.results : Array.isArray(v) ? v : []) as Json[];
      if (!ac.signal.aborted) set({ search: list });
    } catch (e) {
      if (ac.signal.aborted) return;
      log.warn(`search failed: ${e}`);
      set({ search: [], lastError: "Couldn't reach the game catalog" });
    }
  }, 300);
}

export async function addCustomGame(name0: string): Promise<void> {
  const name = name0.trim();
  if (!name) return;
  set({ lastError: "" });
  try {
    const v = await apiJson<Json>("/games/custom", { method: "POST", json: { name }, timeoutMs: 20000 });
    const entry = (v && typeof v.game === "object" ? v.game : v) as Json;
    if (typeof entry.id === "string") rememberCatalogEntry(entry.id, entry);
    set({ search: [entry] });
  } catch (e) {
    set({ lastError: `Couldn't add that game: ${e instanceof ApiError ? e.message : e}` });
  }
}

export async function importSteamLibrary(profile0: string, multiplayerOnly: boolean): Promise<void> {
  const profile = profile0.trim();
  if (!profile) return;
  set({ lastError: "", importState: { loading: true } });
  try {
    const v = await apiJson<Json>("/games/steam/library", { method: "POST", json: { profile, multiplayerOnly }, timeoutMs: 20000 });
    if (Array.isArray(v.items)) for (const g of v.items as Json[]) if (typeof g.id === "string") rememberCatalogEntry(g.id, g);
    set({ importState: v });
  } catch (e) {
    set({ importState: { error: e instanceof ApiError ? e.message : String(e) }, lastError: "Steam import didn't work — see the note in the editor" });
  }
}

export function setWindowOpen(open: boolean): void {
  set({ windowOpen: open });
  if (open) {
    start();
    pickSession();
    void refresh();
  }
}

// the calendar's upcoming list drives the auto-pick (GameReelPanel.qml pickSession)
useCal.subscribe((s, prev) => {
  if (s.upcoming !== prev.upcoming && get().windowOpen) pickSession();
});
