// actions.ts — everything the chat writes (wire §4.2) + media actions (room.rs:789-942).
import { EventStatus, type MatrixEvent } from "matrix-js-sdk";
import { liveTimelineChain, peekClient, uploadFile, fetchMedia, fetchEncryptedMedia, type EncryptedFile } from "@/core/matrix";
import { toast } from "@/core/bus";
import { ROOM_NOT_SYNCED } from "@/core/matrix/sendGuard";
import { playUiSound } from "@/core/sounds";
import { useChatStore } from "./store";
import { editContent, mentionContent, textContent, type PickedMention } from "./lib/markdown";
import { failReason, type MediaRef, type Row } from "./lib/model";
import { replyMentionIds } from "./lib/reply";
import { mimeForName } from "./lib/format";
import { bytesAre, inertBlob, isTextLike, viewerExt } from "@/core/mediatype";

function client() {
  const c = peekClient();
  if (!c) throw new Error("Not signed in");
  return c;
}

type Content = Record<string, unknown>;

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

function send(roomId: string, content: Content): void {
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

export function sendText(roomId: string, text: string): void {
  send(roomId, textContent(text));
}
export function sendEmote(roomId: string, text: string): void {
  send(roomId, textContent(text, "m.emote"));
}
/** A reply (REACH A5.2): it mentions the person replied to (unless that is you) plus the mentions picked
 *  while replying — those keep their links in the body, as in a plain message. */
export function sendReply(roomId: string, parentId: string, text: string, picks: PickedMention[] = []): void {
  const cl = client();
  const c = picks.length ? mentionContent(text, picks) : textContent(text);
  const parent = cl.getRoom(roomId)?.findEventById(parentId);
  const ids = replyMentionIds(parent?.getSender(), cl.getUserId() ?? "", picks.map((p) => p.userId));
  c["m.mentions"] = { user_ids: ids };
  c["m.relates_to"] = { "m.in_reply_to": { event_id: parentId } };
  send(roomId, c);
}
export function sendWithMentions(roomId: string, text: string, picks: PickedMention[]): void {
  send(roomId, mentionContent(text, picks));
}
/** GIF pick: plain text, no markdown (4.2.8). */
export function sendPlain(roomId: string, body: string): void {
  if (!roomKnown(roomId)) {
    toast(NOT_YET);
    return;
  }
  client()
    .sendMessage(roomId, { msgtype: "m.text", body } as never)
    .catch((e: unknown) => toast(`Couldn't send: ${failReason(e)}`));
}

export async function editMessage(roomId: string, targetId: string, text: string): Promise<void> {
  try {
    await client().sendMessage(roomId, editContent(targetId, text) as never);
  } catch (e) {
    toast(`Edit failed: ${(e as Error)?.message ?? e}`);
    dropFailedLocal(roomId);
  }
}

export async function redactMessage(roomId: string, eventId: string): Promise<void> {
  try {
    await client().redactEvent(roomId, eventId);
  } catch (e) {
    toast(`Delete failed: ${(e as Error)?.message ?? e}`);
    dropFailedLocal(roomId);
  }
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
  const k = `${row.eventId}|${key}`;
  if (inflight.has(k)) return;
  const mine = row.reactions.find((r) => r.key === key && r.mine);
  inflight.add(k);
  try {
    if (mine) {
      const ev = mine.myEvent;
      if (ev && ev.status != null && ev.status !== EventStatus.SENT) {
        // only optimistic so far — nothing on the server to take back
        client().cancelPendingEvent(ev);
      } else if (mine.myEventId) {
        await client().redactEvent(roomId, mine.myEventId);
      }
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
      useChatStore.getState().patchUpload(u.id, { state: "uploading", error: "", ts: Date.now() });
      void runUpload(roomId, u.id);
    }
    return;
  }
  if (c && room && row.local) c.resendEvent(row.local, room).catch(() => {});
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
function isEncrypted(roomId: string): boolean {
  const c = peekClient();
  return !!c?.getRoom(roomId)?.hasEncryptionStateEvent();
}

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
export function sendAttachment(roomId: string, file: File): Promise<void> {
  const mime = file.type || mimeForName(file.name);
  const f = file.type ? file : new File([file], file.name, { type: mime });
  const msgtype = mime.startsWith("image/") ? "m.image" : mime.startsWith("video/") ? "m.video" : mime.startsWith("audio/") ? "m.audio" : "m.file";
  const id = `~up${Date.now()}-${++upSeq}`;
  // the echo's object URL carries a safe type too (core/mediatype): even our own file never becomes a page of this origin
  useChatStore.getState().addUpload({ id, roomId, ts: Date.now(), file: f, localUrl: URL.createObjectURL(inertBlob(f)), w: 0, h: 0, state: "uploading", error: "", msgtype });
  const probe = imageSize(f).then(({ w, h }) => useChatStore.getState().patchUpload(id, { w, h }));
  const prev = uploadChains.get(roomId) ?? Promise.resolve();
  const next = prev.then(() => probe).then(() => runUpload(roomId, id)).catch(() => {});
  uploadChains.set(roomId, next);
  return next;
}
const uploadChains = new Map<string, Promise<void>>();

async function runUpload(roomId: string, id: string): Promise<void> {
  const u = useChatStore.getState().uploads.find((x) => x.id === id);
  if (!u) return;
  try {
    if (!roomKnown(roomId)) {
      useChatStore.getState().patchUpload(id, { state: "failed", error: NOT_YET });
      return;
    }
    const mime = u.file.type || mimeForName(u.file.name);
    const up = await uploadFile(u.file, { encrypt: isEncrypted(roomId), name: u.file.name, mimetype: mime });
    // native info = {mimetype, size, w/h for images}; no duration, no video size, no thumbnail
    const info: Content = { mimetype: mime, size: u.file.size };
    if (up.msgtype === "m.image" && u.w && u.h) {
      info.w = u.w;
      info.h = u.h;
    }
    const content: Content = { body: u.file.name, info, msgtype: up.msgtype };
    if (up.file) content.file = up.file;
    else content.url = up.mxc;
    if (!useChatStore.getState().uploads.some((x) => x.id === id)) return; // deleted meanwhile
    useChatStore.getState().dropUpload(id);
    send(roomId, content);
  } catch (e) {
    useChatStore.getState().patchUpload(id, { state: "failed", error: failReason(e) });
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

export async function copyText(text: string, done?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    if (done) toast(done);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    if (done) toast(done);
  }
}

// ---- typing + receipts ------------------------------------------------------------------------

export function sendTyping(roomId: string, on: boolean): void {
  peekClient()
    ?.sendTyping(roomId, on, 4000)
    .catch(() => {});
}

const lastReceipt = new Map<string, string>();
export function sendReceipt(roomId: string, ev: MatrixEvent): void {
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
  c.sendReadReceipt(ev, undefined, true).catch(() => lastReceipt.delete(roomId));
}

export function playSend() {
  playUiSound("send");
}
