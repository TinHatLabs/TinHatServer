// memories/photosStore.ts — Memories photos in the app (docs/MEMORIES-PHOTOS.md): every member's
// `dev.tinhat.memories` list from the room state → the shared rules (photos.ts) → each photo's message fetched with MY
// token and decrypted on this device (the room's history visibility and my keys decide what I can see; nothing goes
// to the Tin Hat server). Writes go to MY list only (state_key = my user id; Matrix refuses anyone else's key).
import { useEffect, useMemo, useState } from "react";
import { MatrixEvent, MatrixEventEvent, Method, RoomEvent, type MatrixClient, type Room } from "matrix-js-sdk";
import { onClientChanged, peekClient, usePowerLevels, useRoomStateEvents, ensureWritable } from "@/core/matrix";
import { joinOrStart } from "./inflight";
import { queueBound } from "./boundqueue";
import { onTimelineEvent, readStillGood } from "./redactwatch";
import { MEMORIES_TYPE, candidates, commentCount as commentCountOf, shown, threadRoot, withHidden, withPhoto, withoutHidden, withoutPhoto, type Candidate, type Edit, type Fetched } from "./photos";

/** One photo the timeline shows: the shared rule's answer + the message (for its media and its comment count). */
export interface MemoryPhoto extends Candidate {
  content: Record<string, unknown>;
  comments: number;
}

interface Got {
  fetched: Fetched | null;
  content: Record<string, unknown>;
  comments: number;
  /** when it was read (a readable photo is re-read after 2 min, an unreadable one after 30 s) */
  at: number;
}
const FRESH_OK_MS = 120_000;
const FRESH_FAIL_MS = 30_000;
const fresh = (g: Got | undefined) => !!g && Date.now() - g.at < (g.fetched ? FRESH_OK_MS : FRESH_FAIL_MS);

const key = (room: string, id: string) => `${room}\u0000${id}`;
/** room \0 event id → what fetching it gave (null fetched = can't be read here); memory only, this session */
const cache = new Map<string, Got>();
/** the reads in flight (shared: a second viewer of the same photo waits for the same read) */
const inflight = new Map<string, Promise<void>>();
/** told whenever a read lands in the cache (a mounted hook re-renders at once, not only when its batch is done) */
const landed = new Set<() => void>();
/** redactions seen this session (room \0 event id): a read that finishes later never brings the photo back */
const redacted = new Set<string>();
/** 2-4: key → when a redaction event for it arrived (a read started before is not stored) */
const stale = new Map<string, number>();
onClientChanged(() => {
  cache.clear();
  inflight.clear();
  redacted.clear();
  stale.clear();
});

// one redaction listener per client, whether or not a Memories window is open
const watched = new WeakSet<object>();
function watchRedactions(c: MatrixClient): void {
  if (watched.has(c)) return;
  watched.add(c);
  const deps = { key, cache, redacted, stale, notify: () => { for (const f of landed) f(); } };
  // the SDK's notice (only for a target in a loaded timeline; also for my own redaction before the server took it):
  // the same handling (review): the redaction's own target, its cached read dropped, the server's next answer decides
  c.on(RoomEvent.Redaction, (ev: MatrixEvent) => onTimelineEvent(ev, deps));
  // 2-4: every incoming redaction event too: a photo read one by one (fetchOne) is not in any timeline the SDK holds
  c.on(RoomEvent.Timeline, (ev: MatrixEvent) => onTimelineEvent(ev, deps));
}

/** The comment count of a photo: the server's thread aggregation on its message (relations only; content stays
 *  encrypted). Approximate by nature (docs/MEMORIES-PHOTOS.md): the viewer shows only replies that decrypt. */
export function commentCount(ev: MatrixEvent): number {
  return commentCountOf(ev.getUnsigned());
}

function gotOf(ev: MatrixEvent, roomId: string): Got {
  const undecrypted = ev.isDecryptionFailure() || (ev.getWireType() === "m.room.encrypted" && ev.getClearContent() === null);
  if (undecrypted) return { fetched: null, content: {}, comments: 0, at: Date.now() };
  const content = (ev.getContent() ?? {}) as Record<string, unknown>;
  return {
    fetched: {
      sender: ev.getSender() ?? "",
      room_id: ev.getRoomId() ?? roomId,
      type: ev.getType(),
      msgtype: typeof content.msgtype === "string" ? content.msgtype : "",
      redacted: ev.isRedacted(),
      ts: ev.getTs(),
    },
    content,
    comments: commentCount(ev),
    at: Date.now(),
  };
}

/** 2-8: a photo's comment count = the server's count of the thread its comments go to (threadRoot: a photo posted inside
 *  a thread → that thread). `photoRaw` = the photo's own server copy when already read. */
async function countFor(c: MatrixClient, roomId: string, id: string, content: unknown, photoRaw: Record<string, unknown> | null): Promise<number | null> {
  // a photo inside a thread shows no count (the thread's count is not the photo's: commentsFace, launch-gate ruling)
  if (threadRoot(id, content) !== id) return 0;
  const raw = photoRaw ?? ((await c.fetchRoomEvent(roomId, id).catch(() => null)) as unknown as Record<string, unknown> | null);
  return raw ? commentCountOf(raw.unsigned) : null;
}

async function fetchOne(c: MatrixClient, room: Room | null, roomId: string, id: string): Promise<void> {
  const k = key(roomId, id);
  const startedAt = Date.now();
  const store = (g: Got) => {
    // the account changed while this was read: it is not this session's
    if (peekClient() !== c) return;
    // 2-4: a redaction arrived while this read was under way: not trusted (the next read decides)
    if (!readStillGood(k, startedAt, stale)) return;
    if (redacted.has(k) && g.fetched) g = { ...g, fetched: { ...g.fetched, redacted: true } };
    cache.set(k, g);
    for (const f of landed) f();
  };
  try {
    // the loaded timeline's own event when it is there (decrypted with it), else the fetched one (the pinned popover's
    // way). The comment count always comes from the server's answer: the timeline copy's thread aggregation is the one
    // it was loaded with and doesn't follow new replies (lab interop 2026-11-14: "0 comments" after a comment).
    let ev = room?.findEventById(id) ?? null;
    if (!ev) {
      const raw = (await c.fetchRoomEvent(roomId, id)) as unknown as Record<string, unknown>;
      ev = new MatrixEvent(raw as never);
      if (ev.isEncrypted()) await c.decryptEventIfNeeded(ev).catch(() => {});
      const g = gotOf(ev, roomId);
      if (g.fetched) g.comments = (await countFor(c, roomId, id, g.content, raw)) ?? 0;
      store(g);
      return;
    }
    // in the timeline: shown at once, then the server's count when it answers (a slow answer never holds the photo)
    const g = gotOf(ev, roomId);
    store(g);
    if (!g.fetched) return;
    const n = await countFor(c, roomId, id, g.content, null);
    const cur = cache.get(k);
    if (n !== null && cur === g) store({ ...g, comments: n });
  } catch (e) {
    // 403 / 404: this account can't see it (history visibility, gone) → unavailable; anything else (network) is
    // not remembered: the next look tries again
    const status = (e as { httpStatus?: number })?.httpStatus;
    if (status === 403 || status === 404) store({ fetched: null, content: {}, comments: 0, at: Date.now() });
  }
}

/** Read one photo (or join the read in flight; inflight.ts: the entry goes when the read settles, even at once). */
function readOne(c: MatrixClient, room: Room | null, roomId: string, id: string): Promise<void> {
  return joinOrStart(inflight, key(roomId, id), () => fetchOne(c, room, roomId, id));
}

/** Refresh: forget this room's reads so the next render reads them again. */
export function refreshPhotos(roomId: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${roomId}\u0000`)) cache.delete(k);
}

/** The people whose take-downs count now: may delete other people's messages (the redact level and the redaction
 *  event's own level, the member's power level as js-sdk computes it — room-v12 creators included). */
export function moderatorsOf(room: Room | null, people: string[]): string[] {
  if (!room) return [];
  const out: string[] = [];
  for (const p of people) {
    try {
      const pl = room.getMember(p)?.powerLevel ?? room.currentState.getStateEvents("m.room.power_levels", "")?.getContent()?.users_default ?? 0;
      if (room.currentState.hasSufficientPowerLevelFor("redact", Number(pl)) && room.currentState.maySendEvent("m.room.redaction", p)) out.push(p);
    } catch {
      /* unknown member: not a moderator */
    }
  }
  return out;
}

/** Am I a moderator here (may take other people's photos down)? */
export function iModerate(roomId: string): boolean {
  const c = peekClient();
  const me = c?.getUserId() ?? "";
  return !!me && moderatorsOf(c?.getRoom(roomId) ?? null, [me]).length === 1;
}

/** The room's Memories photos as I may see them, newest first, + how many I can't see on this device. */
export function useMemoryPhotos(roomId: string, tick = 0): { photos: MemoryPhoto[]; unavailable: number; loading: boolean } {
  const states = useRoomStateEvents(roomId, MEMORIES_TYPE);
  // R3: take-downs count while their writer is a moderator NOW — the power levels are an input too
  const pl = usePowerLevels(roomId);
  const [rev, setRev] = useState(0);
  // the reads of the current ids (and refresh tick) are done: "Loading photos…" ends even when some failed
  const [done, setDone] = useState(false);
  const cands = useMemo(() => {
    const room = peekClient()?.getRoom(roomId) ?? null;
    const st = states.map((e) => ({ state_key: e.stateKey, sender: e.sender, content: e.content }));
    return candidates(st, moderatorsOf(room, [...new Set(states.map((e) => e.stateKey))]));
  }, [states, roomId, pl]);

  // fetch what isn't known yet; re-render when one arrives, is decrypted or redacted
  const ids = useMemo(() => [...new Set(cands.photos.filter((p) => !cands.hidden.includes(p.event_id)).map((p) => p.event_id))], [cands]);
  useEffect(() => {
    const c = peekClient();
    setDone(false);
    if (!c || !ids.length) {
      setDone(true);
      return;
    }
    let alive = true;
    const bump = () => alive && setRev((x) => x + 1);
    const mine = new Set(ids);
    const onEvent = (ev: MatrixEvent) => {
      if (ev.getRoomId() === roomId && mine.has(ev.getId() ?? "")) {
        cache.set(key(roomId, ev.getId() ?? ""), gotOf(ev, roomId));
        bump();
      }
    };
    const onRedaction = (ev: MatrixEvent) => {
      if (ev.getRoomId() === roomId && mine.has(ev.getAssociatedId() ?? "")) bump();  // watchRedactions marked it
    };
    watchRedactions(c);
    landed.add(bump);
    c.on(MatrixEventEvent.Decrypted, onEvent);
    c.on(RoomEvent.Redaction, onRedaction);
    const room = c.getRoom(roomId);
    const todo = ids.filter((id) => !fresh(cache.get(key(roomId, id))));
    // newest first, a few at a time (each is one /event read + one decrypt); a read already in flight is joined
    void (async () => {
      for (let i = 0; i < todo.length && alive; i += 6) {
        await Promise.all(todo.slice(i, i + 6).map((id) => readOne(c, room, roomId, id)));
        bump();
      }
      if (alive) setDone(true);
    })();
    return () => {
      alive = false;
      landed.delete(bump);
      c.off(MatrixEventEvent.Decrypted, onEvent);
      c.off(RoomEvent.Redaction, onRedaction);
    };
  }, [ids, roomId, tick]);

  return useMemo(() => {
    const fetched: Record<string, Fetched | null> = {};
    for (const id of ids) {
      const g = cache.get(key(roomId, id));
      if (g) fetched[id] = g.fetched;
    }
    const out = shown(cands, fetched, roomId);
    const photos = out.photos.map((p) => {
      const g = cache.get(key(roomId, p.event_id));
      return { ...p, content: g?.content ?? {}, comments: g?.comments ?? 0 };
    });
    return { photos, unavailable: out.unavailable, loading: !done && ids.length > 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cands, ids, roomId, rev, done]);
}

// ---- writes (my own list only) ----------------------------------------------------------------------------------

/** The words of a refused write (same words in both apps). */
export const MEMORIES_WORDS = {
  full: "Your Memories here are full (500 photos). Remove some first.",
  newer: "A newer Tin Hat wrote your Memories here. Update Tin Hat to change them.",
  forbidden: "This room doesn't allow it yet. Ask an admin to open it in Tin Hat.",
  unreachable: "Couldn't reach the server. Try again.",
};

function myList(roomId: string): unknown {
  const c = peekClient();
  const me = c?.getUserId() ?? "";
  return c?.getRoom(roomId)?.currentState.getStateEvents(MEMORIES_TYPE, me)?.getContent();
}

/** Is this message in MY list? */
export function inMyMemories(roomId: string, eventId: string): boolean {
  const l = myList(roomId) as { photos?: Array<{ event_id?: unknown }> } | undefined;
  return Array.isArray(l?.photos) && l!.photos!.some((p) => p?.event_id === eventId);
}

/** Is this message taken down by me (a moderator)? */
export function hiddenByMe(roomId: string, eventId: string): boolean {
  const l = myList(roomId) as { hidden?: unknown[] } | undefined;
  return Array.isArray(l?.hidden) && l!.hidden!.includes(eventId);
}

const writeChains = new Map<string, Promise<void>>();

/** 2-5: my list as the SERVER holds it now (authoritative, inside the per-room write chain); null when I have none.
 *  Throws when the server can't be asked (the write is refused). */
async function serverList(c: MatrixClient, roomId: string, me: string): Promise<unknown> {
  try {
    return await c.http.authedRequest(Method.Get, `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(MEMORIES_TYPE)}/${encodeURIComponent(me)}`);
  } catch (e) {
    // only Matrix's own "no such state" (review: a proxy's 404 is not proof I have no list)
    if ((e as { errcode?: string })?.errcode === "M_NOT_FOUND") return null;
    throw e;
  }
}

/** One write of my list per room at a time, bound to the account (client) and room that queued it (R3-2: a sign-out or
 *  an account switch drops what's queued, and a write under way stops at its next step; boundqueue.ts). `owner` = the
 *  client at the moment the action was taken (an Add-photos photo: when it was queued, before its send). */
function write(roomId: string, change: (cur: unknown) => Edit, owner: MatrixClient | null = peekClient()): Promise<void> {
  return queueBound(writeChains, roomId, owner, peekClient, (check) => writeNow(owner as MatrixClient, roomId, change, check));
}

async function writeNow(c: MatrixClient, roomId: string, change: (cur: unknown) => Edit, check: () => void): Promise<void> {
  const me = c.getUserId() ?? "";
  if (!me) throw new Error("Not signed in");
  // 2-5: edit what the server holds now (another of my devices may have written since). When it can't be asked, nothing
  // is written (review: editing what this device knows could bring back what another device removed)
  let cur: unknown;
  try {
    cur = await serverList(c, roomId, me);
  } catch {
    throw new Error(MEMORIES_WORDS.unreachable);
  }
  check();
  const res = change(cur);
  if ("error" in res) throw new Error(MEMORIES_WORDS[res.error]);
  // an admin's app lowers events["dev.tinhat.memories"] to 0 here (once per room per session; own server's rooms only)
  await ensureWritable(roomId, [MEMORIES_TYPE]).catch(() => {});
  check();
  try {
    // through the account that queued it (never whichever client is current by now)
    await c.sendStateEvent(roomId, MEMORIES_TYPE as never, res.content as never, me);
  } catch (e) {
    if ((e as { errcode?: string })?.errcode === "M_FORBIDDEN") throw new Error(MEMORIES_WORDS.forbidden);
    throw e;
  }
}

/** "Add to Memories" on one of MY image messages. */
export function addToMemories(roomId: string, eventId: string, ts: number, owner: MatrixClient | null = peekClient()): Promise<void> {
  return write(roomId, (cur) => withPhoto(cur, { event_id: eventId, ts }), owner);
}
/** "Remove from Memories" (my own photo). */
export function removeFromMemories(roomId: string, eventId: string, owner: MatrixClient | null = peekClient()): Promise<void> {
  return write(roomId, (cur) => withoutPhoto(cur, eventId), owner);
}
/** A moderator's take-down of someone else's photo. */
export function takeDown(roomId: string, eventId: string, owner: MatrixClient | null = peekClient()): Promise<void> {
  return write(roomId, (cur) => withHidden(cur, eventId), owner);
}
/** Undo my take-down. */
export function undoTakeDown(roomId: string, eventId: string, owner: MatrixClient | null = peekClient()): Promise<void> {
  return write(roomId, (cur) => withoutHidden(cur, eventId), owner);
}

/** May I write my list here (power levels; an admin's app provisions it on room open)? */
export function canAddHere(roomId: string): boolean {
  const c = peekClient();
  const r = c?.getRoom(roomId);
  const me = c?.getUserId();
  return !!r && !!me && r.currentState.maySendStateEvent(MEMORIES_TYPE, me);
}
