// store.ts — voice notes: the per-room drafts and their state machine (docs/VOICE-NOTES.md §2 "States", §6, §7).
// Pure (zustand/vanilla + the shared core, no DOM, no Matrix): the app's side — the recorder, the upload, the send, the
// toasts, the audio session — comes in through configureVoice(deps) (wire.ts), so store.test.ts drives the very same
// code with fakes.
//
//   idle → requesting → recording → finalizing → review → sending → idle;  sending failed → review (+ error)
//
// Each recording has an id; every async answer (permission, encoder output/EOS, upload, send) checks that its draft is
// still the current one of the same account + room, so a late answer after Cancel / a room switch / a call join /
// sign-out is dropped. A retry after a failed send reuses the finished upload and the SAME transaction id. One draft
// per room, one microphone for the app: starting a recording stops any other into review.
import { createStore } from "zustand/vanilla";
import { VOICE_MIN_MS, durationMs, voiceContent } from "./core";

export type VoiceState = "idle" | "requesting" | "recording" | "finalizing" | "review" | "sending";

export interface UploadRef {
  /** unencrypted room (a plaintext upload: never sent into a room that has turned encrypted meanwhile) */
  mxc?: string;
  /** encrypted room: the EncryptedFile (with its url) */
  file?: { url: string; [k: string]: unknown };
}

export interface VoiceDraft {
  id: number;
  roomId: string;
  account: string;
  state: Exclude<VoiceState, "idle">;
  /** samples captured so far / in the note (48 kHz) */
  samples: number;
  durationMs: number;
  /** recording: the recent frame peaks (the live strip) */
  recent: number[];
  /** review: the note's waveform (0..1024) */
  waveform: number[];
  blob: Blob | null;
  url: string;
  mimetype: string;
  size: number;
  /** review: the inline error of a failed send ("" = none) */
  error: string;
  /** review: why it stopped by itself ("The microphone stopped", the cap) */
  note: string;
  /** the ONE transaction id of this draft, for every attempt (a lost answer can never post twice) */
  txnId: string;
  upload: UploadRef | null;
  /** a send was attempted (an SDK local echo may exist: Delete cancels it) */
  sendTried: boolean;
  /** the content changed since the last attempt (re-uploaded encrypted): the unsent SDK echo must be rebuilt */
  rebuild: boolean;
}

export interface FinishedNote {
  blob: Blob;
  mimetype: string;
  samples: number;
  durationMs: number;
  waveform: number[];
}
export interface Capture {
  stop(): Promise<FinishedNote>;
  cancel(): void;
}
export type EndReason = "cap" | "device" | "revoked" | "error";
export interface CaptureCallbacks {
  onProgress(p: { samples: number; recent: number[] }): void;
  onEnd(reason: EndReason, detail?: string): void;
}

export interface VoiceDeps {
  /** the signed-in account (null = none) */
  account(): string | null;
  /** start the microphone + encoder; rejects with { code: "permission" | "nodevice" | "rate" | "start" | "busy" }.
   *  `signal` aborts a start in progress: whatever it acquired stops at once and it rejects. */
  startCapture(cb: CaptureCallbacks, signal: AbortSignal): Promise<Capture>;
  /** upload the finished file (`encrypt`: as an EncryptedFile). `alive` (VN-1 review): false once the draft is gone —
   *  an upload that awaits before its request checks it right before starting, so a discarded draft never uploads */
  upload(roomId: string, blob: Blob, mimetype: string, encrypt: boolean, alive?: () => boolean): Promise<UploadRef>;
  /** is the room encrypted NOW (checked again at every send): the room state OR the crypto store (VN-1); rejects
   *  when it can't be told — then nothing is uploaded and the draft goes back to review with the error */
  isEncrypted(roomId: string): boolean | Promise<boolean>;
  /** the server's m.upload.size (null = unknown: no refusal) */
  uploadLimit(): Promise<number | null>;
  /** send the m.room.message with this transaction id (a retry passes the same id); `rebuild` = the content changed
   *  since the last attempt, so a failed local echo carrying the old content is replaced; resolves to the event id */
  send(roomId: string, content: Record<string, unknown>, txnId: string, rebuild: boolean): Promise<string>;
  /** Delete of a draft whose send failed: the SDK's NOT_SENT local echo for this transaction goes too */
  cancelPending?(roomId: string, txnId: string): void;
  newTxnId(): string;
  toast(message: string): void;
  /** the polite live region */
  announce(message: string): void;
  /** true while any recording is requesting / recording (the page's audio session: "play-and-record") */
  recordingSession(on: boolean): void;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  /** the timeline's local echo while uploading (like an attachment) */
  echo?: { add(roomId: string, blob: Blob, mimetype: string): string; drop(id: string): void };
  /** the attachment send-error words (403 / 429 / offline …) */
  failText?(e: unknown): string;
  /** phones say where to allow the microphone in Settings */
  phone?(): boolean;
  log?(message: string): void;
}

export const TEXT = {
  tooShort: "Too short to send",
  tooLarge: "This voice message is too large for the server",
  sendFailed: "Couldn't send — try again",
  noMic: "No microphone found",
  permission: "Tin Hat can't use the microphone — allow it in the browser's site settings",
  permissionPhone: "Tin Hat can't use the microphone — allow it in Settings → Tin Hat",
  rate: "This browser can't record at 48 kHz",
  start: "Couldn't start recording",
  failed: "The recording failed",
  micStopped: "The microphone stopped",
  cap: "Stopped at the 15-minute limit",
  recording: "Recording",
  sent: "Voice message sent",
} as const;

export interface VoiceStore {
  drafts: Record<string, VoiceDraft>;
}
export const voiceStore = createStore<VoiceStore>()(() => ({ drafts: {} }));

let deps: VoiceDeps | null = null;
let seq = 0;
const captures = new Map<number, Capture>();
const finalizing = new Map<number, Promise<void>>();
/** starts in progress (permission prompt, worklet, RNNoise): abort + "settled once it has let go of everything" */
const starting = new Map<number, { ctrl: AbortController; settled: Promise<void> }>();
let sessionOn = false;

export function configureVoice(d: VoiceDeps | null): void {
  deps = d;
}

/** Tests: forget everything (no callbacks run). */
export function resetVoiceForTest(): void {
  for (const c of captures.values()) c.cancel();
  captures.clear();
  finalizing.clear();
  for (const st of starting.values()) st.ctrl.abort();
  starting.clear();
  sessionOn = false;
  voiceStore.setState({ drafts: {} });
}

export function getDraft(roomId: string): VoiceDraft | undefined {
  return voiceStore.getState().drafts[roomId];
}
export function voiceState(roomId: string): VoiceState {
  return getDraft(roomId)?.state ?? "idle";
}

function patch(roomId: string, p: Partial<VoiceDraft>): void {
  voiceStore.setState((s) => {
    const d = s.drafts[roomId];
    return d ? { drafts: { ...s.drafts, [roomId]: { ...d, ...p } } } : s;
  });
}

/** This answer still belongs to the current draft of the same account + room. */
function live(roomId: string, id: number): boolean {
  const d = getDraft(roomId);
  return !!d && d.id === id && !!deps && deps.account() === d.account;
}

function syncSession(): void {
  const on = Object.values(voiceStore.getState().drafts).some((d) => d.state === "requesting" || d.state === "recording");
  if (on === sessionOn) return;
  sessionOn = on;
  deps?.recordingSession(on);
}

function remove(roomId: string): void {
  const d = getDraft(roomId);
  if (!d) return;
  const c = captures.get(d.id);
  if (c) {
    captures.delete(d.id);
    c.cancel();
  }
  starting.get(d.id)?.ctrl.abort(); // a start still in progress lets go at once (a late stream is stopped on arrival)
  if (d.url) deps?.revokeUrl(d.url);
  voiceStore.setState((s) => {
    const { [roomId]: _gone, ...rest } = s.drafts;
    return { drafts: rest };
  });
  syncSession();
}

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? "" : "s"}`;
}

function startError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "permission") return deps?.phone?.() ? TEXT.permissionPhone : TEXT.permission;
  if (code === "nodevice") return TEXT.noMic;
  if (code === "rate") return TEXT.rate;
  return TEXT.start;
}

/** Wait until no other capture holds or is acquiring the microphone: other rooms' recordings stop into review (their
 *  finalize awaited), their pending permission requests are dropped and their starts awaited until they have let go. */
function micWaits(except: number): Promise<unknown>[] {
  const waits: Promise<unknown>[] = [];
  for (const d of Object.values(voiceStore.getState().drafts)) {
    if (d.id === except) continue;
    if (d.state === "requesting") cancelVoice(d.roomId);
    else if (d.state === "recording" || d.state === "finalizing") waits.push(stopVoice(d.roomId));
  }
  for (const [id, st] of starting) if (id !== except) waits.push(st.settled);
  return waits;
}

/** Start recording in `roomId` (the mic button). One microphone: any other recording stops into review and any other
 *  start lets go BEFORE this one asks for the microphone. */
export async function startVoice(roomId: string): Promise<void> {
  const d0 = deps;
  const account = d0?.account();
  if (!d0 || !account || getDraft(roomId)) return;
  const id = ++seq;
  const draft: VoiceDraft = {
    id,
    roomId,
    account,
    state: "requesting",
    samples: 0,
    durationMs: 0,
    recent: [],
    waveform: [],
    blob: null,
    url: "",
    mimetype: "audio/ogg",
    size: 0,
    error: "",
    note: "",
    txnId: d0.newTxnId(),
    upload: null,
    sendTried: false,
    rebuild: false,
  };
  voiceStore.setState((s) => ({ drafts: { ...s.drafts, [roomId]: draft } }));
  syncSession();
  const waits = micWaits(id);
  if (waits.length) {
    await Promise.all(waits);
    if (!live(roomId, id) || getDraft(roomId)?.state !== "requesting") return;
  }
  const ctrl = new AbortController();
  let settle!: () => void;
  starting.set(id, { ctrl, settled: new Promise<void>((r) => (settle = r)) });
  let cap: Capture;
  try {
    cap = await d0.startCapture(
      {
        onProgress: (p) => {
          if (!live(roomId, id) || getDraft(roomId)?.state !== "recording") return;
          patch(roomId, { samples: p.samples, durationMs: durationMs(p.samples), recent: p.recent });
        },
        onEnd: (reason, detail) => {
          if (!live(roomId, id)) return;
          d0.log?.(`voice note ended by itself: ${reason}${detail ? ` (${detail})` : ""}`);
          void stopVoice(roomId, reason);
        },
      },
      ctrl.signal,
    );
  } catch (e) {
    starting.delete(id);
    settle();
    if (live(roomId, id) && !ctrl.signal.aborted) {
      remove(roomId);
      const msg = startError(e);
      d0.toast(msg);
      d0.announce(msg);
    }
    return;
  }
  if (!live(roomId, id) || getDraft(roomId)?.state !== "requesting" || ctrl.signal.aborted) {
    cap.cancel(); // cancelled / switched account while the start was finishing: released before anyone waits on it
    starting.delete(id);
    settle();
    syncSession();
    return;
  }
  captures.set(id, cap);
  starting.delete(id);
  settle();
  patch(roomId, { state: "recording" });
  syncSession();
  d0.announce(TEXT.recording);
}

/** Stop into review (Stop, Escape, a room switch, a call join, the cap, the device going away). */
export function stopVoice(roomId: string, reason?: EndReason): Promise<void> {
  const d = getDraft(roomId);
  if (!d || !deps) return Promise.resolve();
  if (d.state === "requesting") {
    cancelVoice(roomId);
    return Promise.resolve();
  }
  if (d.state === "finalizing") return finalizing.get(d.id) ?? Promise.resolve();
  if (d.state !== "recording") return Promise.resolve();
  const id = d.id;
  const dd = deps;
  const cap = captures.get(id);
  patch(roomId, { state: "finalizing" });
  syncSession();
  const p = (async () => {
    let f: FinishedNote;
    try {
      if (!cap) throw new Error("no capture");
      f = await cap.stop();
    } catch (e) {
      captures.delete(id);
      if (live(roomId, id)) {
        dd.log?.(`voice note failed to finalize: ${(e as Error)?.message ?? e}`);
        remove(roomId);
        dd.toast(TEXT.failed);
        dd.announce(TEXT.failed);
      }
      return;
    }
    captures.delete(id);
    if (!live(roomId, id)) return;
    if (f.durationMs < VOICE_MIN_MS) {
      remove(roomId);
      dd.toast(TEXT.tooShort);
      dd.announce(TEXT.tooShort);
      return;
    }
    const note = reason === "cap" ? TEXT.cap : reason === "device" || reason === "revoked" || reason === "error" ? TEXT.micStopped : "";
    patch(roomId, {
      state: "review",
      blob: f.blob,
      url: dd.createUrl(f.blob),
      mimetype: f.mimetype,
      size: f.blob.size,
      samples: f.samples,
      durationMs: f.durationMs,
      waveform: f.waveform,
      recent: [],
      note,
    });
    dd.announce(`${note ? `${note}. ` : ""}Recording stopped, ${seconds(f.durationMs)}`);
  })();
  finalizing.set(id, p);
  return p.finally(() => finalizing.delete(id));
}

/** Cancel (recording) / Delete (review): the draft is gone. Not while sending (the button is disabled then). */
export function cancelVoice(roomId: string): void {
  remove(roomId);
}
/** Delete (review): the draft is gone — and if a send was tried, the SDK's failed local echo of it too (the timeline
 *  must not offer to retry a note the user threw away). Not while sending (the button is disabled then). */
export function deleteVoice(roomId: string): void {
  const d = getDraft(roomId);
  if (!d || d.state === "sending") return;
  if (d.sendTried) deps?.cancelPending?.(roomId, d.txnId);
  remove(roomId);
}

function isTooLarge(e: unknown): boolean {
  const x = e as { errcode?: string; httpStatus?: number } | null;
  return x?.errcode === "M_TOO_LARGE" || x?.httpStatus === 413;
}

function sendError(e: unknown): string {
  if (isTooLarge(e)) return TEXT.tooLarge;
  const why = deps?.failText?.(e) ?? "";
  return !why || why === "Couldn't send" ? TEXT.sendFailed : `Couldn't send — ${why}`;
}

function sent(roomId: string): void {
  remove(roomId);
  deps?.announce(TEXT.sent);
}

/** Send (while recording: stop + send at once; in review: upload, then send; after a failure: retry with the same
 *  transaction id, and the same upload unless the room has turned encrypted since — then the bytes go up again,
 *  encrypted, and the failed echo is rebuilt). Everything after an await checks it is still THIS draft. */
export async function sendVoice(roomId: string): Promise<void> {
  const d0 = getDraft(roomId);
  if (!d0 || !deps) return;
  const id = d0.id;
  if (d0.state === "recording" || d0.state === "finalizing") {
    await stopVoice(roomId);
    if (!live(roomId, id)) return; // cancelled meanwhile — a new draft in this room is not ours to send
  }
  const d = getDraft(roomId);
  if (!d || d.id !== id || d.state !== "review" || !d.blob) return;
  const dd = deps;
  const blob = d.blob;
  patch(roomId, { state: "sending", error: "" });
  // The reference must fit the room's encryption at the moment of sending: checked before the upload, AGAIN after it
  // (encryption can be turned on while a plaintext upload is in flight) — a plaintext upload never goes into an
  // encrypted room; it is uploaded again, encrypted, and the failed echo carrying the old content must be rebuilt.
  let up = d.upload;
  // (VN-1: the answer may come from the crypto store — awaited, and unsure = no upload: the draft goes back to review)
  const encryptedNow = async (): Promise<boolean | null> => {
    try {
      const v = await dd.isEncrypted(roomId);
      return v === true ? true : v === false ? false : null;
    } catch (e) {
      if (live(roomId, id) && getDraft(roomId)?.state === "sending") {
        const msg = sendError(e);
        patch(roomId, { state: "review", error: msg });
        dd.announce(msg);
      }
      return null;
    }
  };
  for (let round = 0; ; round++) {
    const encrypt = await encryptedNow();
    if (encrypt === null || !live(roomId, id) || getDraft(roomId)?.state !== "sending") {
      if (encrypt === null && live(roomId, id) && getDraft(roomId)?.state === "sending") {
        patch(roomId, { state: "review", error: TEXT.sendFailed });
        dd.announce(TEXT.sendFailed);
      }
      return;
    }
    if (up && encrypt && !up.file) {
      dd.log?.("voice note: the room is encrypted now — the plaintext upload is not used; uploading again, encrypted");
      up = null;
      const cur0 = getDraft(roomId)!;
      // (kept until a send with the new content went through: an attempt that fails doesn't clear it)
      patch(roomId, { upload: null, rebuild: cur0.rebuild || cur0.sendTried });
    }
    if (up) break;
    if (round >= 3) {
      patch(roomId, { state: "review", error: TEXT.sendFailed });
      dd.announce(TEXT.sendFailed);
      return;
    }
    const limit = await dd.uploadLimit().catch(() => null);
    if (!live(roomId, id)) return;
    if (limit !== null && limit > 0 && blob.size > limit) {
      patch(roomId, { state: "review", error: TEXT.tooLarge });
      dd.announce(TEXT.tooLarge);
      return;
    }
    // encryption read again after the limit lookup awaited (the upload itself checks once more, last, in the same tick
    // as a plaintext request starts): a plaintext upload can never begin once the room is encrypted
    const encrypt2 = encrypt || (await encryptedNow());
    if (encrypt2 === null || !live(roomId, id) || getDraft(roomId)?.state !== "sending") {
      if (encrypt2 === null && live(roomId, id) && getDraft(roomId)?.state === "sending") {
        patch(roomId, { state: "review", error: TEXT.sendFailed });
        dd.announce(TEXT.sendFailed);
      }
      return;
    }
    const echo = dd.echo?.add(roomId, blob, d.mimetype);
    let got: UploadRef;
    try {
      got = await dd.upload(roomId, blob, d.mimetype, encrypt2, () => live(roomId, id) && getDraft(roomId)?.state === "sending");
    } catch (e) {
      if (echo) dd.echo?.drop(echo);
      if (live(roomId, id) && getDraft(roomId)?.state === "sending") {
        const msg = sendError(e);
        patch(roomId, { state: "review", error: msg });
        dd.announce(msg);
      }
      return;
    }
    if (echo) dd.echo?.drop(echo); // the send's own local echo takes over
    if (!live(roomId, id)) return;
    up = got;
    patch(roomId, { upload: up });
  }
  const cur = getDraft(roomId)!;
  const content = voiceContent({ mxc: up.mxc, file: up.file, mimetype: cur.mimetype, size: cur.size, duration: cur.durationMs, waveform: cur.waveform });
  patch(roomId, { sendTried: true });
  try {
    // `rebuild` stays set until a send went through (a refused or failed attempt — e.g. the timeline's own Retry of
    // the old echo still in flight — must not lose it); the send also compares the failed echo's media itself
    await dd.send(roomId, content, cur.txnId, cur.rebuild);
  } catch (e) {
    // (a delivery confirmed meanwhile removed the draft: live() is false, nothing comes back)
    if (live(roomId, id) && getDraft(roomId)?.state === "sending") {
      const msg = sendError(e);
      patch(roomId, { state: "review", error: msg });
      dd.announce(msg);
    }
    return;
  }
  if (live(roomId, id)) sent(roomId);
}

/** The send of a failed draft went through another way (the timeline row's own Retry): the draft is done. */
export function sentElsewhere(roomId: string, txnId: string): void {
  const d = getDraft(roomId);
  // review (a failed send retried from the timeline) or sending (the /sync echo came before the HTTP answer — a late
  // failure of that request can't bring the draft back: it is gone)
  if (d && d.txnId === txnId && (d.state === "review" || d.state === "sending") && d.sendTried) sent(roomId);
}

/** The composer showing `roomId` went away (a room switch): a recording there stops into review, a permission
 *  request is dropped. */
export function leaveVoiceView(roomId: string): void {
  const d = getDraft(roomId);
  if (d?.state === "recording") void stopVoice(roomId);
  else if (d?.state === "requesting") cancelVoice(roomId);
}

/** The call join awaits this (bounded) before it opens its own microphone: every recording stops into review (the
 *  draft is kept), a pending permission request is dropped and its start awaited until it has let go. */
export async function stopVoiceForCall(timeoutMs = 2000): Promise<void> {
  const waits: Promise<unknown>[] = [];
  for (const d of Object.values(voiceStore.getState().drafts)) {
    if (d.state === "requesting") cancelVoice(d.roomId);
    else if (d.state === "recording" || d.state === "finalizing") waits.push(stopVoice(d.roomId));
  }
  for (const st of starting.values()) waits.push(st.settled);
  if (!waits.length) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(waits), new Promise<void>((r) => (t = setTimeout(r, timeoutMs)))]);
  if (t) clearTimeout(t);
}

/** Sign-out / account switch: every draft is gone (Blob URLs revoked, captures cancelled). */
export function discardAllVoice(): void {
  for (const roomId of Object.keys(voiceStore.getState().drafts)) remove(roomId);
}
/** Left the room: its draft is gone. */
export function discardVoice(roomId: string): void {
  remove(roomId);
}

/** Is a microphone in use by a voice note right now (requesting / recording / finalizing)? */
export function voiceBusy(): boolean {
  return starting.size > 0 || Object.values(voiceStore.getState().drafts).some((d) => d.state === "requesting" || d.state === "recording" || d.state === "finalizing");
}
