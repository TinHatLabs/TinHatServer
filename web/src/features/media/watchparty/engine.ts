// watchparty/engine.ts — the watch-party sync controller (port of native watchparty.rs, itself
// the port of the old web fork's useWatchSync.ts). One party at a time, module singleton.
//
// State events (wire = law, tw-spec/media.md §4.1):
//   dev.tinhat.watchparty          ""      {queue:[{url,title,addedBy}], hostId}
//   dev.tinhat.watchparty.playback ""      {url, positionMs, positionSecs:"42.500", playing,
//                                                updatedAt, seekNonce}  ({} = cleared)
//   dev.tinhat.watchparty.viewer   <mxid>  {joinedAt, lastSeen}  ({} on leave)
// Timing (native consts): tick 1 s · HARD_TOL 2 s · viewer heartbeat 7 s / TTL 20 s · advancer
// heartbeat 15 s · applying-remote 1.5 s · seek de-dup 2.5 s · local-write grace 3 s · live clock
// 60 s · memory-replay TTL 120 s · stale clock 6 h · MAX_MEDIA 24 h.
import { create } from "zustand";
import { ensureWritable, getState, getStateAll, peekClient, sendState } from "@/core/matrix";
import { apiFetch } from "@/core/api";
import { createLogger } from "@/core/log";
import { withRetry } from "../shared/retry";
import { HISTORY_DEBOUNCE_MS, HISTORY_EVENT, historyPush, normHistory } from "./model";
import { asU64, clearPlayed as clearPlayedOp, moveToNext as moveToNextOp, nextQueueUrl, normParty, normQueueItem, normalizeWatchResults, shuffleUpcoming as shuffleUpcomingOp, type Party, type QueueItem, type SearchResult } from "./queue";

export { nextQueueUrl, normParty, normQueueItem, normalizeWatchResults, SONG_SERVICES, fmtTime, upcomingLabel } from "./queue";
export type { Party, QueueItem, QueueKind, QueueSource, SearchResult, SongService } from "./queue";

const log = createLogger("watchparty");

export const WP_EVENT = "dev.tinhat.watchparty";
export const PLAYBACK_EVENT = "dev.tinhat.watchparty.playback";
export const VIEWER_EVENT = "dev.tinhat.watchparty.viewer";

export const HARD_TOL_SECS = 2.0;
export const VIEWER_TTL_MS = 20_000;
export const VIEWER_HEARTBEAT_MS = 7_000;
export const ADVANCER_HEARTBEAT_MS = 15_000;
export const APPLYING_REMOTE_MS = 1_500;
export const SEEK_DEDUP_MS = 2_500;
export const LOCAL_WRITE_GRACE_MS = 3_000;
export const PLAYBACK_LIVE_TTL_MS = 60_000;
export const MEMORY_PLAYBACK_TTL_MS = 120_000;
export const STALE_CLOCK_SECS = 6 * 3600;
export const MAX_MEDIA_SECS = 24 * 3600;

export interface Playback {
  url: string;
  positionSecs: number;
  playing: boolean;
  updatedAt: number;
  seekNonce: number;
}
export interface Viewer {
  userId: string;
  joinedAt: number;
  lastSeen: number;
}

type Json = Record<string, unknown>;

// ---- read-side normalisation (both directions must interoperate) ------------------------------

export function playbackPositionSecs(o: Json): number {
  const ms = asU64(o.positionMs);
  if (ms !== null && typeof o.positionMs !== "string") return ms / 1000;
  const p = o.positionSecs;
  if (typeof p === "number" && Number.isFinite(p)) return Math.max(0, p);
  if (typeof p === "string" && Number.isFinite(parseFloat(p))) return Math.max(0, parseFloat(p));
  if (ms !== null) return ms / 1000;
  return 0;
}

/** null when cleared (url empty). */
export function normPlayback(c: unknown): Playback | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Json;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!url) return null;
  return {
    url,
    positionSecs: playbackPositionSecs(o),
    playing: o.playing === true,
    updatedAt: asU64(o.updatedAt) ?? Date.now(),
    seekNonce: asU64(o.seekNonce) ?? 0,
  };
}

function readViewers(roomId: string, now: number): Viewer[] {
  const out: Viewer[] = [];
  for (const t of getStateAll(roomId, VIEWER_EVENT)) {
    const last = asU64(t.content.lastSeen) ?? 0;
    if (last <= 0 || now - last > VIEWER_TTL_MS) continue;
    out.push({ userId: t.stateKey, joinedAt: asU64(t.content.joinedAt) ?? last, lastSeen: last });
  }
  out.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return out;
}

/** Someone is watching in this room right now (for the banner) — live viewers other than me. */
export function liveViewersOf(roomId: string): Viewer[] {
  return readViewers(roomId, Date.now());
}

// ---- store -------------------------------------------------------------------------------------

export interface WpState {
  roomId: string;
  inParty: boolean;
  amAdvancer: boolean;
  party: Party;
  /** presented clock (stale → playing false); null = nothing playing */
  playback: Playback | null;
  viewers: Viewer[];
  error: string;
  searchResults: SearchResult[];
  searching: boolean;
}

const EMPTY_PARTY: Party = { queue: [], hostId: "" };

export const useWatchParty = create<WpState>()(() => ({
  roomId: "",
  inParty: false,
  amAdvancer: false,
  party: EMPTY_PARTY,
  playback: null,
  viewers: [],
  error: "",
  searchResults: [],
  searching: false,
}));
const set = useWatchParty.setState;
const get = useWatchParty.getState;

interface SyncState {
  generation: number;
  lastPlaybackWrite: number;
  lastViewerWrite: number;
  lastUserWrite: number;
  applyingRemoteUntil: number;
  lastSeekTarget: number;
  lastSeekAt: number;
  lastNonce: number;
  localPosition: number;
}
const sync: SyncState = {
  generation: 0,
  lastPlaybackWrite: 0,
  lastViewerWrite: 0,
  lastUserWrite: 0,
  applyingRemoteUntil: 0,
  lastSeekTarget: 0,
  lastSeekAt: 0,
  lastNonce: 0,
  localPosition: 0,
};
let loop = 0;

// remote drift corrections (desiredSeek) → players (routing: see onDesiredSeek in Main.qml)
type SeekListener = (posSecs: number, url: string) => void;
const seekListeners = new Set<SeekListener>();
export function onDesiredSeek(cb: SeekListener): () => void {
  seekListeners.add(cb);
  return () => seekListeners.delete(cb);
}

const me = () => peekClient()?.getUserId() ?? "";

function markLocalWrite() {
  const now = Date.now();
  sync.lastPlaybackWrite = now;
  sync.lastUserWrite = now;
}

// ---- the pure decision core (decide_sync) ------------------------------------------------------

export function decideSync(s: SyncState, target: number, seekNonce: number, now: number): { emitSeek: number | null; advancerShouldWrite: boolean } {
  const drift = Math.abs(s.localPosition - target);
  const inApply = now < s.applyingRemoteUntil;
  let emitSeek: number | null = null;
  const takeSeek = () => {
    emitSeek = target;
    s.lastSeekTarget = target;
    s.lastSeekAt = now;
    s.applyingRemoteUntil = now + APPLYING_REMOTE_MS;
    s.localPosition = target;
    s.lastNonce = seekNonce;
  };
  if (drift > HARD_TOL_SECS && !inApply) {
    const sameRecent = Math.abs(target - s.lastSeekTarget) < HARD_TOL_SECS && now - s.lastSeekAt < SEEK_DEDUP_MS;
    const nonceForced = seekNonce !== 0 && seekNonce !== s.lastNonce;
    if (!sameRecent || nonceForced) takeSeek();
  } else if (seekNonce !== 0 && seekNonce !== s.lastNonce) {
    takeSeek();
  } else {
    s.lastNonce = seekNonce;
  }
  const advancerShouldWrite = !inApply && now - s.lastPlaybackWrite >= ADVANCER_HEARTBEAT_MS;
  return { emitSeek, advancerShouldWrite };
}

// ---- writes ------------------------------------------------------------------------------------

function playbackContent(url: string, positionSecs: number, playing: boolean, seekNonce: number): Json {
  const pos = Math.max(0, Number.isFinite(positionSecs) ? positionSecs : 0);
  return {
    url: url.trim(),
    positionMs: Math.round(pos * 1000),
    positionSecs: pos.toFixed(3),
    playing,
    updatedAt: Date.now(),
    seekNonce: Math.max(0, Math.trunc(seekNonce)),
  };
}

// The shared clock is ONE state key, so only the newest write matters — but a write that met a 429
// (Synapse rate limit: retry_after up to 5 s, twice) used to land AFTER later writes: a pause that sat
// in its retry let the advancer heartbeat re-publish "playing", then landed after the last viewer's
// sweep and left a stale clock behind (two-client run, tools/media-wp-sync.mjs). Playback writes now
// go out one at a time, in order, and a write that a newer one (or the leave sweep) superseded is
// dropped instead of retried.
class Superseded extends Error {
  constructor() {
    super("superseded by a newer watch-party clock write");
  }
}
/** Per room: write sequence, the ordered chain, writes queued or in flight, and the newest clock we
 *  asked for (so an action taken while an earlier write is still retrying builds on it, not on the
 *  stale server copy — a seek right after a 429'd pause must not re-publish "playing"). */
interface PbQueue {
  seq: number;
  pending: number;
  chain: Promise<unknown>;
  desired: Playback | null;
}
const pbQueues = new Map<string, PbQueue>();
const pbq = (roomId: string): PbQueue => {
  let q = pbQueues.get(roomId);
  if (!q) {
    q = { seq: 0, pending: 0, chain: Promise.resolve(), desired: null };
    pbQueues.set(roomId, q);
  }
  return q;
};
const isLimited = (e: unknown) => {
  const any = e as { errcode?: string; httpStatus?: number; data?: { errcode?: string } };
  return any?.errcode === "M_LIMIT_EXCEEDED" || any?.data?.errcode === "M_LIMIT_EXCEEDED" || any?.httpStatus === 429;
};
/** Queue a clock write for `roomId`. Order = call order (the slot is taken synchronously, before any
 *  await); a write superseded by a newer one for the same room — or by the leave sweep — is dropped. */
function sendPlaybackOrdered(roomId: string, content: Json): Promise<void> {
  const q = pbq(roomId);
  const mine = ++q.seq;
  q.pending += 1;
  q.desired = normPlayback(content);
  const run = async () => {
    if (mine !== q.seq) throw new Superseded();
    await ensureWritable(roomId, [PLAYBACK_EVENT]);
    for (let i = 0; ; i++) {
      if (mine !== q.seq) throw new Superseded();
      try {
        await sendState(roomId, PLAYBACK_EVENT, "", content);
        return;
      } catch (e) {
        if (!isLimited(e) || i >= 2) throw e;
        const ms = Math.min(5000, Math.max(500, Number((e as { data?: { retry_after_ms?: number } })?.data?.retry_after_ms ?? 1000)));
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  };
  const p = q.chain.then(run, run).finally(() => {
    q.pending -= 1;
    if (q.pending === 0) q.desired = null;
  });
  q.chain = p.catch(() => {});
  return p;
}
/** A clock write of ours for this room is queued or in flight (keep the optimistic local state). */
const playbackWritePending = (roomId: string) => (pbQueues.get(roomId)?.pending ?? 0) > 0;
/** The clock to build the next action on: our newest queued write while one is pending, else the room's. */
function currentClock(roomId: string): Playback | null {
  const q = pbQueues.get(roomId);
  if (q && q.pending > 0 && q.desired) return q.desired;
  return normPlayback(getState(roomId, PLAYBACK_EVENT, "")) ?? get().playback;
}
const quietSuperseded = (e: unknown) => e instanceof Superseded;

async function writePlayback(roomId: string, url: string, positionSecs: number, playing: boolean, seekNonce: number): Promise<Json> {
  const content = playbackContent(url, positionSecs, playing, seekNonce);
  await sendPlaybackOrdered(roomId, content);
  return content;
}

async function writeViewer(roomId: string): Promise<void> {
  const uid = me();
  if (!uid) return;
  await ensureWritable(roomId, [VIEWER_EVENT]);
  const now = Date.now();
  const prev = getState(roomId, VIEWER_EVENT, uid);
  const joinedAt = asU64(prev?.joinedAt) ?? now;
  await withRetry(() => sendState(roomId, VIEWER_EVENT, uid, { joinedAt, lastSeen: Date.now() }), 2);
}

/** Rate-limit retries of a party write: the advancer's own heartbeats (viewer 7 s + clock 15 s ≈ Synapse's default
 *  0.2 msg/s) keep its bucket near empty, so an edit may meet several 429s in a row before a slot frees up. */
const PARTY_WRITE_TRIES = 6;
async function writeParty(roomId: string, party: Party): Promise<void> {
  await ensureWritable(roomId, [WP_EVENT]);
  // every field of an item goes back out (CONTRACT §1: never strip what a newer client wrote)
  await withRetry(() => sendState(roomId, WP_EVENT, "", { queue: party.queue.map((q) => ({ ...q })), hostId: party.hostId }), PARTY_WRITE_TRIES);
}

let historyUrl = "";
let historyTimer = 0;
async function writeHistory(roomId: string, url: string, by: string): Promise<void> {
  try {
    const item = normParty(getState(roomId, WP_EVENT, "")).queue.find((q) => q.url === url) ?? get().party.queue.find((q) => q.url === url) ?? { url, title: "", addedBy: "" };
    const items = historyPush(normHistory(getState(roomId, HISTORY_EVENT, "")), item, Date.now(), by);
    await ensureWritable(roomId, [HISTORY_EVENT]);
    await withRetry(() => sendState(roomId, HISTORY_EVENT, "", { v: 1, items: items.map((h) => ({ ...h })) }), 1);
  } catch (e) {
    log.debug(`history write failed: ${(e as Error)?.message ?? e}`);
  }
}

function pushPlayback(content: Json | null, gen: number) {
  if (sync.generation !== gen) return;
  sync.lastUserWrite = Date.now();
  set({ playback: content ? normPlayback(content) : null });
}

// ---- tick ----------------------------------------------------------------------------------------

async function runTick(roomId: string, gen: number): Promise<void> {
  const uid = me();
  const now = Date.now();
  const party = normParty(getState(roomId, WP_EVENT, ""));
  let playback = normPlayback(getState(roomId, PLAYBACK_EVENT, ""));
  const viewers = readViewers(roomId, now);
  if (playback && playback.url.startsWith("tinhat-memory://") && now - playback.updatedAt > MEMORY_PLAYBACK_TTL_MS) playback = null;

  const advancer = viewers.length ? viewers[0].userId : uid;
  const amAdvancer = advancer === uid;

  const url = playback?.url ?? "";
  let position = playback ? playback.positionSecs : 0;
  if (!Number.isFinite(position) || position < 0 || position > MAX_MEDIA_SECS) position = 0;
  const playing = playback?.playing ?? false;
  const updatedAt = playback?.updatedAt ?? now;
  const seekNonce = playback?.seekNonce ?? 0;
  const elapsed = Math.max(0, now - updatedAt) / 1000;
  const stale = elapsed > STALE_CLOCK_SECS;
  const target = position + (playing && !stale ? elapsed : 0);

  if (sync.generation !== gen) return;
  const suppressLocal = now - sync.lastUserWrite < LOCAL_WRITE_GRACE_MS || playbackWritePending(roomId);
  const patch: Partial<WpState> = { viewers, amAdvancer };
  if (!suppressLocal) {
    patch.party = party;
    patch.playback = playback ? { ...playback, positionSecs: position, playing: stale ? false : playback.playing } : null;
  }
  set(patch);

  const d = decideSync(sync, target, seekNonce, now);
  const wantViewer = now - sync.lastViewerWrite >= VIEWER_HEARTBEAT_MS;
  if (wantViewer) sync.lastViewerWrite = now;
  if (!suppressLocal && d.emitSeek !== null) for (const l of [...seekListeners]) l(d.emitSeek, url);

  // CONTRACT §2: the ADVANCER records a new playing url (never a tinhat-memory:// replay) in the room's History,
  // 5 s after it changed and only if it is still playing then (a mis-click that is skipped at once leaves no trace)
  if (amAdvancer && url && !url.startsWith("tinhat-memory://") && url !== historyUrl) {
    historyUrl = url;
    window.clearTimeout(historyTimer);
    historyTimer = window.setTimeout(() => {
      if (sync.generation !== gen || get().roomId !== roomId) return;
      const nowUrl = get().playback?.url ?? "";
      if (nowUrl !== url || !get().amAdvancer) return;
      void writeHistory(roomId, url, uid);
    }, HISTORY_DEBOUNCE_MS);
  } else if (!url) historyUrl = "";

  if (amAdvancer && d.advancerShouldWrite && url && !playbackWritePending(roomId)) {
    const fresh = normPlayback(getState(roomId, PLAYBACK_EVENT, ""));
    if (fresh && !(fresh.seekNonce > seekNonce)) {
      const age = Math.max(0, now - fresh.updatedAt);
      let wPos: number;
      let wPlaying: boolean;
      if (age > PLAYBACK_LIVE_TTL_MS) {
        wPos = fresh.positionSecs;
        wPlaying = false;
      } else {
        wPos = fresh.positionSecs + (fresh.playing ? age / 1000 : 0);
        wPlaying = fresh.playing;
      }
      wPos = Number.isFinite(wPos) ? Math.min(MAX_MEDIA_SECS, Math.max(0, wPos)) : 0;
      try {
        await writePlayback(roomId, fresh.url, wPos, wPlaying, fresh.seekNonce);
      } catch (e) {
        if (!quietSuperseded(e)) log.warn(`advancer heartbeat write failed: ${(e as Error)?.message ?? e}`);
      }
    }
    if (sync.generation === gen) sync.lastPlaybackWrite = now;
  }
  if (wantViewer && sync.generation === gen) {
    try {
      await writeViewer(roomId);
    } catch (e) {
      log.debug(`viewer heartbeat failed: ${(e as Error)?.message ?? e}`);
    }
  }
}

// ---- public actions ----------------------------------------------------------------------------

/** Join `roomId`'s party (DESTRUCTIVE: resets the sync state — never re-join while in one). */
export function joinParty(roomId: string): void {
  if (!roomId) return;
  sync.generation += 1;
  const gen = sync.generation;
  Object.assign(sync, {
    lastPlaybackWrite: Date.now(),
    lastViewerWrite: 0,
    lastUserWrite: 0,
    applyingRemoteUntil: 0,
    lastSeekTarget: 0,
    lastSeekAt: 0,
    lastNonce: 0,
    localPosition: 0,
  });
  set({ roomId, inParty: true, party: EMPTY_PARTY, playback: null, viewers: [], amAdvancer: false, error: "" });
  window.clearInterval(loop);
  historyUrl = "";
  window.clearTimeout(historyTimer);
  sync.lastViewerWrite = Date.now();
  void ensureWritable(roomId, [WP_EVENT, PLAYBACK_EVENT, VIEWER_EVENT])
    .catch(() => {})
    .then(() => writeViewer(roomId))
    .catch((e) => log.debug(`viewer write failed: ${(e as Error)?.message ?? e}`));
  let busy = false;
  loop = window.setInterval(() => {
    if (sync.generation !== gen || get().roomId !== roomId || !get().inParty) {
      window.clearInterval(loop);
      return;
    }
    if (busy) return;
    busy = true;
    void runTick(roomId, gen).finally(() => {
      busy = false;
    });
  }, 1000);
}

/** Leave (idempotent): stop the tick, clear my viewer; the LAST viewer out sweeps the clock (never the queue). */
export function leaveParty(opts: { keepalive?: boolean } = {}): void {
  const roomId = get().roomId;
  sync.generation += 1;
  window.clearInterval(loop);
  set({ inParty: false, amAdvancer: false, playback: null, roomId: "" });
  if (!roomId) return;
  const uid = me();
  if (opts.keepalive) {
    // page unload: best-effort only (sendState may not complete)
    void sendState(roomId, VIEWER_EVENT, uid, {}).catch(() => {});
    return;
  }
  void (async () => {
    try {
      await withRetry(() => sendState(roomId, VIEWER_EVENT, uid, {}));
    } catch {
      /* best effort */
    }
    const othersLive = readViewers(roomId, Date.now()).some((v) => v.userId !== uid);
    if (!othersLive) {
      try {
        await sendPlaybackOrdered(roomId, {});
        log.info("last viewer out — swept the shared playback clock");
      } catch (e) {
        log.warn(`leave sweep (playback) failed: ${(e as Error)?.message ?? e}`);
      }
    }
  })();
}

/** The id of the room's current party event ("" = none) — tells "our write's echo hasn't arrived yet" apart. */
function partyEventId(roomId: string): string {
  return peekClient()?.getRoom(roomId)?.currentState.getStateEvents(WP_EVENT, "")?.getId() ?? "";
}
/** Our last party write and the room's party event it replaced: until the room's event moves on from `staleId`, the
 *  room still shows the copy our write replaced, so the next edit builds on ours (11.3 QOL: back-to-back reorders —
 *  Play next then Shuffle — must not lose the first; the desktop's dd785688 is the same fix). */
let ourParty: { roomId: string; party: Party; staleId: string; at: number } | null = null;
const OUR_PARTY_TTL_MS = 30_000;

/** The queue as the next edit must see it: the room's copy, our own newer write while its echo lags, or our newer
 *  optimistic mirror (an add whose echo lags). */
function baseParty(roomId: string): Party {
  if (ourParty && ourParty.roomId === roomId && Date.now() - ourParty.at < OUR_PARTY_TTL_MS && partyEventId(roomId) === ourParty.staleId) return ourParty.party;
  const party = normParty(getState(roomId, WP_EVENT, ""));
  const mirror = get().party;
  return mirror.queue.length > party.queue.length ? { queue: mirror.queue, hostId: party.hostId || mirror.hostId } : party;
}

/** Party writes go out one at a time, each computed on the newest base (a second edit issued while the first is still
 *  in flight waits for it instead of rewriting the same stale copy). */
let partyChain: Promise<unknown> = Promise.resolve();
function editParty(roomId: string, edit: (base: Party) => Party | null, what: string): void {
  const gen = sync.generation;
  const run = async () => {
    try {
      const staleId = partyEventId(roomId);
      const base = baseParty(roomId);
      const next = edit({ queue: base.queue.map((q) => ({ ...q })), hostId: base.hostId });
      if (!next) return;
      await writeParty(roomId, next);
      ourParty = { roomId, party: next, staleId, at: Date.now() };
      if (sync.generation !== gen) return;
      sync.lastUserWrite = Date.now();
      set({ party: next, error: "" });
    } catch (e) {
      log.warn(`${what} failed: ${(e as Error)?.message ?? e}`);
      set({ error: "Couldn't update the Media Party — this room may need an admin to enable it" });
    }
  };
  partyChain = partyChain.then(run, run);
}

/** Read-modify-write the queue (every field of every item goes back out — CONTRACT §1). */
function editQueue(edit: (queue: QueueItem[]) => QueueItem[] | null): void {
  const roomId = get().roomId;
  if (!roomId || !get().inParty) return;
  sync.lastUserWrite = Date.now();
  editParty(
    roomId,
    (base) => {
      const queue = edit(base.queue);
      return queue ? { queue, hostId: base.hostId } : null;
    },
    "queue edit",
  );
}

/** Append a full item (a song with its art / source, a video with its thumbnail …); `addedBy` is always me. */
export function enqueueItem(item: QueueItem): void {
  const n = normQueueItem({ ...item, addedBy: me() });
  if (!n) return;
  editQueue((q) => [...q, n]);
}

/** Append several items in ONE write (a playlist's "Add all"). */
export function enqueueItems(items: QueueItem[]): void {
  const list = items.map((it) => normQueueItem({ ...it, addedBy: me() })).filter((x): x is QueueItem => !!x);
  if (!list.length) return;
  editQueue((q) => [...q, ...list]);
}

export function enqueue(url: string, title: string): void {
  if (!url.trim()) return;
  enqueueItem({ url: url.trim(), title: title.trim(), addedBy: me() });
}

/** 11.4 (DESIGN §2.3): remove / move up & down / clear. The UI gates Clear on the host; anyone may remove and move. */
export function removeAt(index: number): void {
  editQueue((q) => (index >= 0 && index < q.length ? q.filter((_, i) => i !== index) : null));
}
export function moveItem(from: number, to: number): void {
  editQueue((q) => {
    if (from < 0 || from >= q.length || to < 0 || to >= q.length || from === to) return null;
    const [it] = q.splice(from, 1);
    q.splice(to, 0, it);
    return q;
  });
}
export function clearQueue(): void {
  editQueue((q) => (q.length ? [] : null));
}
/** The playing url as the next queue edit must see it (our newest clock write, else the room's). */
function playingUrl(): string {
  const roomId = get().roomId;
  return (roomId ? currentClock(roomId)?.url : get().playback?.url) ?? "";
}
const sameOrder = (a: QueueItem[], b: QueueItem[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** 11.3 QOL (QOL.md §5), one write each: "Play next" (anyone in the party, like moving), "Clear played" and "Shuffle"
 *  (the UI gates both on the host). The ops are the shared-vector ones in queue.ts; a no-op writes nothing. */
export function moveToNext(from: number): void {
  editQueue((q) => {
    const n = moveToNextOp(q, playingUrl(), from);
    return sameOrder(n, q) ? null : n;
  });
}
export function clearPlayed(): void {
  editQueue((q) => {
    const n = clearPlayedOp(q, playingUrl());
    return n.length === q.length ? null : n;
  });
}
export function shuffleUpcoming(seed: number = Date.now() & 0xffffffff): void {
  editQueue((q) => {
    const n = shuffleUpcomingOp(q, playingUrl(), seed);
    return sameOrder(n, q) ? null : n;
  });
}

export function playUrl(url: string): void {
  const roomId = get().roomId;
  if (!roomId || !url.trim()) return;
  const gen = sync.generation;
  const nonce = Date.now();
  void writePlayback(roomId, url, 0, true, nonce)
    .then((c) => pushPlayback(c, gen))
    .catch((e) => {
      if (quietSuperseded(e)) return;
      log.warn(`play_url failed: ${(e as Error)?.message ?? e} ${(e as { errcode?: string })?.errcode ?? ""}`);
      set({ error: "Couldn't start playback — this room may need an admin to enable Media Party" });
    });
  markLocalWrite();
}

function setPlaying(playing: boolean): void {
  const roomId = get().roomId;
  if (!roomId) return;
  const gen = sync.generation;
  const local = sync.localPosition;
  const cur = currentClock(roomId);
  const url = cur?.url ?? "";
  const nonce = cur?.seekNonce ?? 0;
  void writePlayback(roomId, url, local, playing, nonce)
    .then((c) => pushPlayback(c, gen))
    .catch((e) => quietSuperseded(e) || log.warn(`set_playing failed: ${(e as Error)?.message ?? e}`));
  markLocalWrite();
}
export const play = () => setPlaying(true);
export const pause = () => setPlaying(false);

export function seek(posSecs: number): void {
  const roomId = get().roomId;
  if (!roomId) return;
  sync.localPosition = posSecs;
  const gen = sync.generation;
  const nonce = Date.now();
  const cur = currentClock(roomId);
  void writePlayback(roomId, cur?.url ?? "", posSecs, cur?.playing ?? false, nonce)
    .then((c) => pushPlayback(c, gen))
    .catch((e) => quietSuperseded(e) || log.warn(`seek failed: ${(e as Error)?.message ?? e}`));
  markLocalWrite();
}

/** The clock the next action builds on (our newest queued write while one is pending, else the room's): a second
 *  play/pause click while the first write still waits out a 429 must toggle from what was just asked, not from the
 *  stale mirror (11.3 QOL: the video surface toggles on click). */
export function desiredClock(): Playback | null {
  const roomId = get().roomId;
  return roomId ? currentClock(roomId) : null;
}

export function reportPosition(posSecs: number): void {
  if (Number.isFinite(posSecs)) sync.localPosition = posSecs;
}

export function assignHost(userId: string): void {
  const roomId = get().roomId;
  if (!roomId) return;
  editParty(roomId, (base) => ({ ...base, hostId: userId }), "set host");
}

/** Join + start a synced Memories replay (join-don't-stomp). */
export function syncStartMemory(roomId: string, memUrl: string): void {
  const mem = memUrl.trim();
  if (!roomId || !mem) return;
  joinParty(roomId);
  const gen = sync.generation;
  const cur = normPlayback(getState(roomId, PLAYBACK_EVENT, ""));
  markLocalWrite();
  if (cur && cur.url === mem && Date.now() - cur.updatedAt < PLAYBACK_LIVE_TTL_MS) {
    log.info("sync_start_memory: live replay of this memory in progress — following it");
    sync.lastUserWrite = 0;
    return;
  }
  void writePlayback(roomId, mem, 0, true, Date.now())
    .then((c) => pushPlayback(c, gen))
    .catch((e) => {
      if (quietSuperseded(e)) return;
      log.warn(`sync_start_memory write failed: ${(e as Error)?.message ?? e}`);
      set({ error: "Couldn't start the synced replay — this room may need an admin to enable Media Party" });
    });
}

// ---- YouTube search (the server's Tin Hat API, /api/watch/search) --------------------------------------------------

let searchTimer = 0;
let searchAbort: AbortController | null = null;
export function searchVideos(text: string): void {
  const q = text.trim();
  set({ error: "" });
  window.clearTimeout(searchTimer);
  searchAbort?.abort();
  if (!q) {
    set({ searching: false, searchResults: [] });
    return;
  }
  set({ searching: true });
  const ctl = new AbortController();
  searchAbort = ctl;
  searchTimer = window.setTimeout(async () => {
    try {
      const r = await apiFetch(`/watch/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = normalizeWatchResults(await r.json());
      if (!ctl.signal.aborted) set({ searching: false, searchResults: res });
    } catch (e) {
      if (ctl.signal.aborted) return;
      log.warn(`search: ${(e as Error)?.message ?? e}`);
      set({ searching: false, error: "Couldn't search videos", searchResults: [] });
    }
  }, 450);
}

/** Page unload: best-effort leave (installed from the feature's setup). */
export function installUnloadLeave(): () => void {
  const on = () => {
    if (get().inParty) leaveParty({ keepalive: true });
  };
  window.addEventListener("pagehide", on);
  return () => window.removeEventListener("pagehide", on);
}
