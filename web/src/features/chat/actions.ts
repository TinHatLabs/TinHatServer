// actions.ts — everything the chat writes (wire §4.2) + media actions (room.rs:789-942).
import { EventStatus, RoomEvent, type MatrixEvent } from "matrix-js-sdk";
import { liveTimelineChain, onClientChanged, peekClient, uploadFile, fetchMedia, fetchEncryptedMedia, type EncryptedFile } from "@/core/matrix";
import { toast } from "@/core/bus";
import { failClass, failText, type FailClass } from "./lib/composerDraft";
import { resendable } from "./lib/resend";
import { clearAfterSend, deliverAfterSend, sendWithAfterSend } from "./lib/aftersend";
import { editMentions, editNotifyIds } from "./lib/editMentions";
import { isVoiceNote } from "./voicenote/core";
import { ROOM_NOT_SYNCED } from "@/core/matrix/sendGuard";
import { sendThreadPosition } from "@/core/matrix/receipts";
import { noteMyReceipt } from "./threads/receipts";
import { playUiSound } from "@/core/sounds";
import { useChatStore } from "./store";
import { editContent, mentionContent, textContent, type PickedMention } from "./lib/markdown";
import { failReason, type MediaRef, type Row } from "./lib/model";
import { pinsAfterDelete } from "./lib/pins";
import { replyMentionIds } from "./lib/reply";
import { replyRelation, threadOf, threadRelation } from "./threads/core";
import { mimeForName } from "./lib/format";
import { bytesAre, inertBlob, isTextLike, viewerExt } from "@/core/mediatype";
import { encryptedNowSync, roomEncryptedForUpload } from "@/core/matrix/uploadCrypto";
import { RETRY_PLAIN_MEDIA, RETRY_UNKNOWN, hasPlainMedia, retryVerdict } from "./retryRule";
import { reactKeyNorm } from "./lib/reactions";
import { overUploadLimit } from "./lib/uploadLimit";
import { uploadLimit } from "./voicenote/wire";
import { POST_KEY as MEMORIES_POST_KEY } from "@/features/media/memories/photos";

/** the same words as a server-side 413 (lib/model.ts failReason; the desktop's friendly_send_error) */
const TOO_LARGE = "That file is too large for the server";

function client() {
  const c = peekClient();
  if (!c) throw new Error("Not signed in");
  return c;
}

type Content = Record<string, unknown>;

/** threads (docs/THREADS.md): a send from a thread's panel — its root and the newest event in it (the spec's
 *  fallback reply target, so clients without threads show a normal reply). */
export interface ThreadCtx {
  root: string;
  latest: string;
}

/** threads: a message from a thread's composer gets the thread relation (one that already relates — a reply, an
 *  edit — keeps its own; sendReply builds the threaded reply itself). */
function inThread(content: Content, th?: ThreadCtx | null): Content {
  if (th && !content["m.relates_to"]) content["m.relates_to"] = threadRelation(th.root, th.latest);
  return content;
}

/** 2026-10-23: a room is encrypted from its first second, and js-sdk decides whether to encrypt from ITS copy of the
 *  room — for a room this client hasn't synced yet it sends in the clear. So nothing is sent (or uploaded) into a room
 *  the client doesn't know yet; it is a moment away (createRoom → the next sync). matrix-sdk asks the server instead,
 *  so the desktop has no such window. */
const NOT_YET = ROOM_NOT_SYNCED; // core/matrix/sendGuard.ts refuses any other send into such a room
function roomKnown(roomId: string): boolean {
  return !!peekClient()?.getRoom(roomId);
}
/** The composer asks before it clears the field: a message typed into a room that is still opening stays there. */
export function roomReadyToSend(roomId: string): boolean {
  if (roomKnown(roomId)) return true;
  toast(NOT_YET);
  return false;
}

function send(roomId: string, content: Content, th?: ThreadCtx | null): void {
  inThread(content, th);
  if (!roomKnown(roomId)) {
    toast(NOT_YET);
    return;
  }
  // js-sdk creates the local echo (pending event) at once; failures stay as NOT_SENT rows (Retry/Delete).
  client()
    .sendMessage(roomId, content as never)
    .catch(() => {
      /* the row shows the failed state */
    });
}

export function sendText(roomId: string, text: string, th?: ThreadCtx | null): void {
  send(roomId, textContent(text), th);
}
export function sendEmote(roomId: string, text: string, th?: ThreadCtx | null): void {
  send(roomId, textContent(text, "m.emote"), th);
}
/** A reply (REACH A5.2): it mentions the person replied to (unless that is you) plus the mentions picked
 *  while replying — those keep their links in the body, as in a plain message. */
export function sendReply(roomId: string, parentId: string, text: string, picks: PickedMention[] = [], th?: ThreadCtx | null, parentSender?: string): void {
  const cl = client();
  const c = picks.length ? mentionContent(text, picks) : textContent(text);
  const parent = cl.getRoom(roomId)?.findEventById(parentId);
  const ids = replyMentionIds(parent?.getSender() ?? parentSender, cl.getUserId() ?? "", picks.map((p) => p.userId));
  c["m.mentions"] = { user_ids: ids };
  // A07.3: a reply to a message in a thread stays in that thread (a thread's panel: its own thread, root included)
  const parentThread = (parent ? threadOf(parent.getWireContent() ?? parent.getContent()) : "") || (th?.root ?? "");
  c["m.relates_to"] = replyRelation(parentId, parentThread);
  send(roomId, c);
}
export function sendWithMentions(roomId: string, text: string, picks: PickedMention[], th?: ThreadCtx | null): void {
  send(roomId, mentionContent(text, picks), th);
}
/** GIF pick: plain text, no markdown (4.2.8). */
export function sendPlain(roomId: string, body: string, th?: ThreadCtx | null): void {
  if (!roomKnown(roomId)) {
    toast(NOT_YET);
    return;
  }
  client()
    .sendMessage(roomId, inThread({ msgtype: "m.text", body }, th) as never)
    .catch((e: unknown) => {
      console.warn("[chat] GIF send failed:", e);
      toast(failText("gif", failClass(e), false)); // A20.1: it said "Couldn't send: Couldn't send"
    });
}

/** An edit; null when it went through, else why it didn't (failClass). The caller says so in plain words and puts the
 *  text back in the box (L1 A20.0: the composer was already empty and the row snaps back). */
export async function editMessage(roomId: string, targetId: string, text: string, picks: PickedMention[] = []): Promise<FailClass | null> {
  try {
    // A09.2: an emote stays an emote (the edit's msgtype is the original's); A09.3: its mention links stay, and the
    // people picked while editing are linked (lib/editMentions.ts)
    const orig = client().getRoom(roomId)?.findEventById(targetId)?.getContent() as { msgtype?: unknown; formatted_body?: unknown } | undefined;
    const formatted = typeof orig?.formatted_body === "string" ? orig.formatted_body : "";
    const mentions = editMentions(formatted, text, picks);
    const notify = editNotifyIds(formatted, mentions);
    await client().sendMessage(roomId, editContent(targetId, text, orig?.msgtype === "m.emote" ? "m.emote" : "m.text", mentions, notify) as never);
    return null;
  } catch (e) {
    console.warn("[chat] edit failed:", e);
    dropFailedLocal(roomId);
    return failClass(e);
  }
}

/** → whether the delete went through (12.1.17: Memories' Delete says so; the chat ignores it). */
export async function redactMessage(roomId: string, eventId: string): Promise<boolean> {
  try {
    await client().redactEvent(roomId, eventId);
  } catch (e) {
    console.warn("[chat] delete failed:", e);
    toast(failText("delete", failClass(e), false));
    dropFailedLocal(roomId);
    return false;
  }
  // QA W1: deleting a pinned message also unpins it, when I may edit the room's pins (pins.ts pinsAfterDelete; a pin I
  // may not take back is only hidden). After the delete went through, so a failed delete never loses the pin.
  const cur = (client().getRoom(roomId)?.currentState.getStateEvents("m.room.pinned_events", "")?.getContent() as Content | undefined)?.pinned;
  const pins = Array.isArray(cur) ? cur.filter((x): x is string => typeof x === "string") : [];
  // (review: a failed unpin never turns a delete that went through into a failure)
  if (pinsAfterDelete(pins, eventId, canPin(roomId))) await setPinned(roomId, eventId, false).catch((e) => console.warn("[chat] unpin after delete failed:", e));
  return true;
}

/** Failed optimistic edits/redactions/reactions roll back (cancel the local echo). */
function dropFailedLocal(roomId: string) {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (!c || !room) return;
  for (const ev of room.getPendingEvents()) {
    if (ev.status !== EventStatus.NOT_SENT) continue;
    const t = ev.getType();
    const rel = (ev.getContent() as Content)["m.relates_to"] as Content | undefined;
    if (t === "m.reaction" || t === "m.room.redaction" || rel?.rel_type === "m.replace") c.cancelPendingEvent(ev);
  }
}

const inflight = new Set<string>();
/** Toggle my reaction (optimistic via the js-sdk local echo; a duplicate click never sends twice). */
export async function toggleReaction(roomId: string, row: Row, key: string): Promise<void> {
  if (!row.eventId) return;
  const k = `${row.eventId}|${reactKeyNorm(key)}`; // QOL A07.2 (review): ❤ and ❤️ are one reaction in flight too
  if (inflight.has(k)) return;
  const mine = row.reactions.find((r) => reactKeyNorm(r.key) === reactKeyNorm(key) && r.mine); // QOL A07.2: ❤ = ❤️
  inflight.add(k);
  try {
    if (mine) {
      // every one of mine this chip holds (QOL A07.2 review: ❤ and ❤️ both sent are one chip)
      const evs = mine.myEvents?.length ? mine.myEvents : mine.myEvent ? [mine.myEvent] : [];
      for (const ev of evs) {
        if (ev.status != null && ev.status !== EventStatus.SENT) {
          // only optimistic so far — nothing on the server to take back
          client().cancelPendingEvent(ev);
        } else if (ev.getId()) {
          await client().redactEvent(roomId, ev.getId()!);
        }
      }
      if (!evs.length && mine.myEventId) await client().redactEvent(roomId, mine.myEventId);
    } else {
      await client().sendEvent(roomId, "m.reaction" as never, {
        "m.relates_to": { event_id: row.eventId, key, rel_type: "m.annotation" },
      } as never);
    }
  } catch {
    dropFailedLocal(roomId);
  } finally {
    inflight.delete(k);
  }
}

/** Synapse answers a burst of state writes with 429 M_LIMIT_EXCEEDED + retry_after_ms; js-sdk only retries
 *  queued message sends, so a pin/unpin right after a few other actions used to fail outright (and the
 *  toast blamed permissions). Waits as told (≤ 10 s) and tries again, 3 attempts in all. */
async function retryOn429<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { httpStatus?: number; errcode?: string; data?: { retry_after_ms?: number } };
      const limited = err?.httpStatus === 429 || err?.errcode === "M_LIMIT_EXCEEDED";
      if (!limited || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(500, err.data?.retry_after_ms ?? 1500))));
    }
  }
}

export async function setPinned(roomId: string, eventId: string, pin: boolean): Promise<void> {
  const c = client();
  // recomputed per attempt: a 429 wait must not write back a stale list over pins changed meanwhile
  const nextPins = () => {
    const room = c.getRoom(roomId);
    const cur = ((room?.currentState.getStateEvents("m.room.pinned_events", "")?.getContent() as Content | undefined)?.pinned as string[] | undefined) ?? [];
    return pin ? (cur.includes(eventId) ? cur : [...cur, eventId]) : cur.filter((x) => x !== eventId);
  };
  try {
    await retryOn429(() => c.sendStateEvent(roomId, "m.room.pinned_events" as never, { pinned: nextPins() } as never, ""));
  } catch (e) {
    const status = (e as { httpStatus?: number })?.httpStatus;
    const why = status === 403 ? "you may not have permission in this room" : status === 429 ? "the server is busy — try again in a moment" : "check your connection and try again";
    toast(`Couldn't ${pin ? "pin" : "unpin"} that message: Couldn't ${pin ? "pin" : "unpin"} — ${why}`);
  }
}

/** A30.0: may I delete OTHER people's messages here (the room's redact level; the desktop's canRedactOthers). */
export function canRedactOthers(roomId: string): boolean {
  const c = peekClient();
  const st = c?.getRoom(roomId)?.currentState;
  if (!c || !st) return false;
  const me = c.getUserId() ?? "";
  // both rules, like the desktop's user_can_redact_event_of_other: the redact level AND the m.room.redaction event level
  return st.hasSufficientPowerLevelFor("redact", st.getMember(me)?.powerLevel ?? 0) && st.maySendEvent("m.room.redaction", me);
}

export function canPin(roomId: string): boolean {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (!c || !room) return false;
  return room.currentState.maySendStateEvent("m.room.pinned_events", c.getUserId() ?? "");
}

export function retryLocal(roomId: string, row: Row): void {
  const c = peekClient();
  const room = c?.getRoom(roomId);
  if (row.uploadId) {
    const u = useChatStore.getState().uploads.find((x) => x.id === row.uploadId);
    if (u) {
      useChatStore.getState().patchUpload(u.id, { state: "uploading", error: "", cls: "", autoTries: 0, ts: Date.now() });
      void runUpload(roomId, u.id);
    }
    return;
  }
  if (!c || !room || !row.local) return;
  const ev = row.local;
  autoTries.delete(ev); // a Retry starts the automatic count over (D08.2)
  const content = ev.getContent() as Record<string, unknown>;
  void retryVerdict(c, roomId, content).then((v) => {
    if (v === "unknown") return toast(RETRY_UNKNOWN);
    // re-read as late as we can; js-sdk does one more asynchronous check of its own inside resendEvent, a window this
    // narrows and can't close (the same residual as VN-1)
    if (v === "refuse-plain-media" || (hasPlainMedia(content) && encryptedNowSync(c, roomId))) return toast(RETRY_PLAIN_MEDIA);
    c.resendEvent(ev, room).then((r) => deliverAfterSend(ev.getTxnId(), r.event_id), () => {});
  });
}

/** One failed event again, on the Retry's rules (retryRule: a file uploaded in the clear into a room that turned
 *  encrypted is never resent by itself; it keeps its Retry, which explains). */
async function resendOne(c: NonNullable<ReturnType<typeof peekClient>>, room: NonNullable<ReturnType<NonNullable<ReturnType<typeof peekClient>>["getRoom"]>>, ev: MatrixEvent): Promise<void> {
  const content = ev.getContent() as Record<string, unknown>;
  const v = await retryVerdict(c, room.roomId, content);
  if (v !== "resend" || (hasPlainMedia(content) && encryptedNowSync(c, room.roomId))) return;
  if (ev.status !== EventStatus.NOT_SENT) return; // sent or deleted meanwhile
  await c.resendEvent(ev, room).then((r) => deliverAfterSend(ev.getTxnId(), r.event_id), () => {});
}

/** L1 D08.2: the connection is back (session syncDown true -> false): every message that failed for lack of connection
 *  is sent again, per room oldest first, same transaction id (lib/resend.ts, the desktop's resend_after_reconnect).
 *  Returns how many were picked up. */
export function resendAfterReconnect(): Promise<number> {
  // one pass at a time (a sync during a pass would start a second one over the same events; the next sync looks again)
  resendRun ??= resendPass().finally(() => {
    resendRun = null;
  });
  return resendRun;
}
let resendRun: Promise<number> | null = null;
/** automatic resends so far per failed event (lib/resend.ts MAX_AUTO_TRIES) */
const autoTries = new WeakMap<MatrixEvent, number>();

async function resendPass(): Promise<number> {
  const c = peekClient();
  if (!c) return 0;
  let n = 0;
  for (const u of useChatStore.getState().uploads) {
    if (u.state === "failed" && resendable(u.cls ?? "", false, u.autoTries ?? 0)) {
      n++;
      useChatStore.getState().patchUpload(u.id, { state: "uploading", error: "", cls: "", autoTries: (u.autoTries ?? 0) + 1, ts: Date.now() });
      void runUpload(u.roomId, u.id);
    }
  }
  for (const room of c.getRooms()) {
    // js-sdk fails the events queued behind a failed one too: those carry no error of their own (a refusal always has
    // one), so they go again with it, also when the one they waited behind has gone meanwhile
    const list = room.getPendingEvents().filter((ev) => {
      if (ev.status !== EventStatus.NOT_SENT) return false;
      const cls = ev.error ? failClass(ev.error) : "network";
      return resendable(cls, isVoiceNote(ev.getContent()), autoTries.get(ev) ?? 0);
    });
    if (!list.length) continue;
    n += list.length;
    console.info(`[chat] connection back: sending ${list.length} failed message(s) again in ${room.roomId}`);
    for (const ev of list) {
      // 4-3 (the desktop's class): a sign-out or another account ends the pass — nothing of this session's queue is
      // sent after it (the upload queue is emptied on loggedOut; runUpload checks it)
      if (peekClient() !== c) {
        console.info("[chat] the session ended: the rest of the resend pass is dropped");
        return n;
      }
      autoTries.set(ev, (autoTries.get(ev) ?? 0) + 1);
      await resendOne(c, room, ev);
    }
  }
  return n;
}

export function deleteLocal(row: Row): void {
  if (row.uploadId) {
    useChatStore.getState().dropUpload(row.uploadId);
    return;
  }
  if (row.local) peekClient()?.cancelPendingEvent(row.local);
}

// ---- attachments -----------------------------------------------------------------------------

let upSeq = 0;

async function imageSize(file: File): Promise<{ w: number; h: number }> {
  try {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return { w: 0, h: 0 };
    const b = await createImageBitmap(file);
    const out = { w: b.width, h: b.height };
    b.close();
    return out;
  } catch {
    return { w: 0, h: 0 };
  }
}

/** Stage → echo row at once (local image), upload (+ encrypt), then send (room.rs send_attachment).
 *  Echoes appear synchronously in staging order; uploads + sends run one after another per room. */
export function sendAttachment(roomId: string, file: File, th?: ThreadCtx | null, onSent?: (eventId: string) => void, opts?: { memories?: boolean }): Promise<void> {
  const mime = file.type || mimeForName(file.name);
  const f = file.type ? file : new File([file], file.name, { type: mime });
  const msgtype = mime.startsWith("image/") ? "m.image" : mime.startsWith("video/") ? "m.video" : mime.startsWith("audio/") ? "m.audio" : "m.file";
  const id = `~up${Date.now()}-${++upSeq}`;
  // QOL A08.2 (review): over the limit we already know → a failed row at once, with no preview to decode
  if (overUploadLimit(f.size, knownLimit())) {
    useChatStore.getState().addUpload({ id, roomId, ts: Date.now(), file: f, localUrl: "", w: 0, h: 0, state: "failed", error: TOO_LARGE, msgtype, thread: th?.root, threadLatest: th?.latest });
    return Promise.resolve();
  }
  // the echo's object URL carries a safe type too (core/mediatype): even our own file never becomes a page of this origin
  useChatStore.getState().addUpload({ id, roomId, ts: Date.now(), file: f, localUrl: URL.createObjectURL(inertBlob(f)), w: 0, h: 0, state: "uploading", error: "", msgtype, thread: th?.root, threadLatest: th?.latest, ...(opts?.memories ? { memories: true } : {}) });
  // QOL A08.2 (review): a file over the upload limit is never decoded for its size either (runUpload refuses it)
  const probe = (async () => {
    if (overUploadLimit(f.size, await uploadLimit().catch(() => null))) return;
    const { w, h } = await imageSize(f);
    useChatStore.getState().patchUpload(id, { w, h });
  })();
  const prev = uploadChains.get(roomId) ?? Promise.resolve();
  if (onSent) sentHooks.set(id, onSent);
  const next = prev.then(() => probe).then(() => runUpload(roomId, id)).catch(() => {});
  uploadChains.set(roomId, next);
  return next;
}
const uploadChains = new Map<string, Promise<void>>();
// 2-7: a hook waiting for a resend never carries over to another account
onClientChanged(() => clearAfterSend());
/** 2-7 (review): a send whose answer was lost but which the server took shows up as its remote echo: deliver then too */
const echoWatched = new WeakSet<object>();
function watchSentEchoes(cl: ReturnType<typeof client>): void {
  if (echoWatched.has(cl)) return;
  echoWatched.add(cl);
  cl.on(RoomEvent.LocalEchoUpdated, (ev: MatrixEvent) => {
    const id = ev.getId() ?? "";
    if ((ev.status === null || ev.status === EventStatus.SENT) && id.startsWith("$")) deliverAfterSend(ev.getTxnId(), id);
  });
}
/** upload id → told the sent message's event id (Memories "Add photos" adds it to my list); dropped once used */
const sentHooks = new Map<string, (eventId: string) => void>();
/** QOL A08.2: the server's upload limit as last read, for the client it was read for (null = not known yet) */
let knownLimitFor: { client: unknown; limit: number | null } | null = null;
function knownLimit(): number | null {
  return knownLimitFor && knownLimitFor.client === peekClient() ? knownLimitFor.limit : null;
}

async function runUpload(roomId: string, id: string): Promise<void> {
  const u = useChatStore.getState().uploads.find((x) => x.id === id);
  if (!u) return;
  try {
    if (!roomKnown(roomId)) {
      useChatStore.getState().patchUpload(id, { state: "failed", error: NOT_YET });
      return;
    }
    // QOL A08.2: the server's upload limit (m.upload.size; unknown = no refusal), before anything is read or uploaded
    const limit = await uploadLimit().catch(() => null);
    knownLimitFor = { client: peekClient(), limit };
    if (overUploadLimit(u.file.size, limit)) {
      // the preview goes too (review): a refused file is not kept decoded on screen
      if (u.localUrl) URL.revokeObjectURL(u.localUrl);
      useChatStore.getState().patchUpload(id, { state: "failed", error: TOO_LARGE, localUrl: "" });
      return;
    }
    const mime = u.file.type || mimeForName(u.file.name);
    // security review round 4 (VN-1 class): the room's encryption is decided at the upload (uploadFile `room`: the room
    // state OR the crypto store; unsure = throws = failed, nothing uploaded) — never from the room state alone
    let up = await uploadFile(u.file, { encrypt: false, room: roomId, name: u.file.name, mimetype: mime });
    if (!up.file) {
      // the room turned encrypted while the plaintext upload ran: upload again, encrypted (a plaintext reference never
      // goes into an encrypted room; unsure = throws = failed)
      const c = peekClient();
      if (!c) throw new Error("Not signed in");
      if (await roomEncryptedForUpload(c, roomId)) up = await uploadFile(u.file, { encrypt: true, name: u.file.name, mimetype: mime });
    }
    // native info = {mimetype, size, w/h for images}; no duration, no video size, no thumbnail. The size is what was
    // uploaded (a photo loses its metadata on the way: core/photoUpload)
    const info: Content = { mimetype: mime, size: up.info.size };
    if (up.msgtype === "m.image" && u.w && u.h) {
      info.w = u.w;
      info.h = u.h;
    }
    const content: Content = { body: u.file.name, info, msgtype: up.msgtype };
    if (up.file) content.file = up.file;
    else content.url = up.mxc;
    // 12.1.17: Memories' "Add photos" marks its photo (inside the encryption): quiet at once for 12.1.17+ receivers
    if (u.memories && up.msgtype === "m.image") content[MEMORIES_POST_KEY] = { v: 1 };
    if (!useChatStore.getState().uploads.some((x) => x.id === id)) return; // deleted meanwhile
    useChatStore.getState().dropUpload(id);
    const hook = sentHooks.get(id);
    sentHooks.delete(id);
    // Memories "Add photos" (onSent) posts to the main timeline and needs the event id; a thread's attachment goes
    // through send() with its thread relation (threads). The two never meet: Memories passes no thread.
    if (hook && !u.thread && roomKnown(roomId)) {
      // 2-7: the hook waits under the message's transaction id until it IS sent (a failed send keeps it for the Retry or
      // the automatic resend after a reconnect, which deliver it: lib/aftersend.ts)
      const cl = client();
      watchSentEchoes(cl);
      const txn = cl.makeTxnId();
      sendWithAfterSend(txn, () => cl.sendMessage(roomId, content as never, txn), hook).catch(() => {
        /* the row shows the failed state (send) */
      });
    }
    else send(roomId, content, u.thread ? { root: u.thread, latest: u.threadLatest ?? "" } : null);
  } catch (e) {
    useChatStore.getState().patchUpload(id, { state: "failed", error: failReason(e), cls: failClass(e) });
  }
}

// ---- media: open / save --------------------------------------------------------------------

/** The attachment's bytes as a Blob whose type comes from the allow-list (core/mediatype), by the event's mimetype
 *  (else the server's) — never the event's string itself: H1, security review 2026-10-26. */
export async function mediaBlob(m: MediaRef): Promise<Blob> {
  if (m.localUrl) return inertBlob(await (await fetch(m.localUrl)).blob(), m.mimetype);
  if (m.file) return fetchEncryptedMedia(m.file as unknown as EncryptedFile, m.mimetype);
  if (m.url) return inertBlob(await fetchMedia(m.url), m.mimetype);
  throw new Error("no media");
}

/** "Open": decrypt + show in a new tab, or download. A tab only for the viewer allow-list (core/mediatype: PNG/JPEG/
 *  GIF/WebP/AVIF, MP4/WebM, common audio, PDF, text/plain as UTF-8) whose bytes are that type — a `blob:` page has this
 *  app's origin, so anything else (HTML, SVG, XML, mislabelled bytes, …) is only ever downloaded. */
export async function openMedia(m: MediaRef): Promise<void> {
  try {
    const blob = await mediaBlob(m);
    const head = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
    // a tab only when the bytes are what the type says (the desktop's viewer.rs sniff); a text-like file (JSON, CSV,
    // Markdown, logs, source) whose bytes are plain text opens as UTF-8 plain text; anything else is a download
    const ext = viewerExt(blob.type);
    const view = ext && bytesAre(ext, head) ? blob : !ext && isTextLike(m.mimetype, m.name) && bytesAre("txt", head) ? new Blob([blob], { type: "text/plain;charset=utf-8" }) : null;
    const url = URL.createObjectURL(view ?? blob);
    if (view) {
      // noopener makes window.open answer null even when the tab opened (HTML "window open steps"), and Safari may have
      // let the click's permission lapse during the download: the toast says "Opening…" and offers the download
      window.open(url, "_blank", "noopener,noreferrer");
      toast(`Opening ${m.name || "the file"}…`, { action: { label: "Download", run: () => download(url, m.name) }, timeoutMs: 8000 });
    } else download(url, m.name);
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    toast("Couldn't download that file");
  }
}

function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "file";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "Save as…": showSaveFilePicker where available, else a download. */
export async function saveMedia(m: MediaRef): Promise<void> {
  const name = m.name || (m.kind === "video" ? "video" : "file");
  type Picker = (o: { suggestedName: string }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
  const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  try {
    if (picker) {
      let handle;
      try {
        handle = await picker({ suggestedName: name });
      } catch {
        return; // cancelled
      }
      toast("Saving…");
      const blob = await mediaBlob(m);
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast(`Saved ${name}`);
      return;
    }
    toast("Saving…");
    const blob = await mediaBlob(m);
    const url = URL.createObjectURL(blob);
    download(url, name);
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`Saved ${name}`);
  } catch (e) {
    toast(e instanceof Error && e.message !== "no media" ? `Couldn't save: ${e.message}` : "Couldn't download that file");
  }
}

/** Copy `text`; true when it reached the clipboard (`done` is toasted only then). */
export async function copyText(text: string, done?: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (done) toast(done);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    if (ok && done) toast(done);
    return ok;
  }
}

// ---- typing + receipts ------------------------------------------------------------------------

export function sendTyping(roomId: string, on: boolean): void {
  peekClient()
    ?.sendTyping(roomId, on, 4000)
    .catch(() => {});
}

const lastReceipt = new Map<string, string>();
export function markReadPosition(roomId: string, ev: MatrixEvent): void {
  const c = peekClient();
  const id = ev.getId();
  if (!c || !id || id.startsWith("~")) return;
  if (lastReceipt.get(roomId) === id) return;
  const room = c.getRoom(roomId);
  const me = c.getUserId() ?? "";
  // never move my receipt backwards
  if (room) {
    // the server's receipt, not the SDK's synthetic one (a failed send must be able to retry)
    const cur = room.getEventReadUpTo(me, true);
    if (cur === id) {
      lastReceipt.set(roomId, id);
      return;
    }
    if (cur) {
      // the whole timeline chain (core/matrix/timeline.ts): after a gappy sync my receipt can sit in an
      // older, linked timeline
      const tl = liveTimelineChain(room).events;
      const iCur = tl.findIndex((e) => e.getId() === cur);
      const iNew = tl.findIndex((e) => e.getId() === id);
      if (iCur >= 0 && iNew >= 0 && iNew < iCur) return;
    }
  }
  lastReceipt.set(roomId, id);
  // public m.read only in a room of my own server, else m.read.private (core/matrix/receipts.ts). threads (MSC3771):
  // the main timeline's receipt carries thread_id "main", so reading it never clears a thread (the caller aims it at
  // the newest event NOT in a thread: threads/core mainReceiptTarget)
  sendThreadPosition(ev, "main")
    .then(() => noteMyReceipt(roomId, "main", id, ev.getTs()))
    .catch(() => lastReceipt.delete(roomId));
}

/** threads (MSC3771): my receipt inside one thread (thread_id = its root), on the thread's newest event, when the
 *  thread panel shows its end. Never backwards (by the event's ts against my last receipt in that thread). */
export function markThreadReadPosition(roomId: string, root: string, ev: MatrixEvent): void {
  const id = ev.getId();
  if (!peekClient() || !id || id.startsWith("~")) return;
  const key = `${roomId}|${root}`;
  if (lastReceipt.get(key) === id) return;
  lastReceipt.set(key, id);
  // the event's own ts, not the completion time: two receipts finishing out of order never move it back (review #7)
  sendThreadPosition(ev, root)
    .then(() => noteMyReceipt(roomId, root, id, ev.getTs()))
    .catch(() => lastReceipt.delete(key));
}

export function playSend() {
  playUiSound("send");
}
