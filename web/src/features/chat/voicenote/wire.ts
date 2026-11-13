// wire.ts — voice notes: the store's app side (configureVoice) — the recorder, the upload (encrypted rooms through the
// attachment path), the send with its transaction id, the server's upload limit, toasts + the polite live region, the
// audio session, the timeline's upload echo, and the cleanup rules: sign-out / account switch / leaving the room discard
// drafts, a phone page going to the background stops a recording into review, the call join waits for the recorder
// (core/micyield). Plus the React hooks the composer uses and the test hook `window.__twVoice` (dev builds or
// __TW_DEBUG__, like core/devhook.ts).
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { EventStatus, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { encryptAttachment, onClientChanged, peekClient } from "@/core/matrix";
import { ROOM_NOT_SYNCED } from "@/core/matrix/sendGuard";
import { encryptedNowSync, roomEncryptedForUpload } from "@/core/matrix/uploadCrypto";
import { bus, toast } from "@/core/bus";
import { setRecordingAudioSession } from "@/core/sounds";
import { onMicYield } from "@/core/micyield";
import { getFormFactor } from "@/core/device";
import { inertBlob } from "@/core/mediatype";
import { createLogger } from "@/core/log";
import { useChatStore } from "../store";
import { failReason } from "../lib/model";
import { voiceFileName, waveform as waveformOf } from "./core";
import { encodeSynthetic, startCapture, voiceSupported, type Finished } from "./recorder";
import { cancelTxnEcho, planTxn } from "./txn";
import {
  configureVoice,
  discardAllVoice,
  discardVoice,
  getDraft,
  sendVoice,
  sentElsewhere,
  startVoice,
  stopVoice,
  stopVoiceForCall,
  voiceStore,
  type VoiceDraft,
} from "./store";

const log = createLogger("voice-note");

// ---- the polite live region (one for the app: announcements outlive the recorder row) -------------------------------
let region: HTMLElement | null = null;
let regionTimer = 0;
function announce(message: string): void {
  if (typeof document === "undefined") return;
  if (!region || !region.isConnected) {
    region = document.createElement("div");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("role", "status");
    region.dataset.voiceAnnouncer = "";
    Object.assign(region.style, { position: "fixed", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", left: "-9999px" });
    document.body.appendChild(region);
  }
  // cleared first, so the same words twice are announced twice
  region.textContent = "";
  window.clearTimeout(regionTimer);
  regionTimer = window.setTimeout(() => region && (region.textContent = message), 50);
}

// ---- the upload limit (m.upload.size, cached per client; unknown = no refusal) --------------------------------------
let limitFor: MatrixClient | null = null;
let limit: Promise<number | null> | null = null;
function uploadLimit(): Promise<number | null> {
  const c = peekClient();
  if (!c) return Promise.resolve(null);
  if (limitFor !== c || !limit) {
    limitFor = c;
    limit = c
      .getMediaConfig(true)
      .catch(() => c.getMediaConfig(false))
      .then((cfg) => {
        const n = (cfg as Record<string, unknown>)?.["m.upload.size"];
        return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
      })
      .catch(() => null);
    // a failure is not remembered for good
    void limit.then((v) => v === null && limitFor === c && (limit = null));
  }
  return limit;
}

let txnSeq = 0;
const lastSent = new Map<string, string>();

async function sendWithTxn(roomId: string, content: Record<string, unknown>, txnId: string, rebuild: boolean): Promise<string> {
  const c = peekClient();
  if (!c) throw new Error("Not signed in");
  const room = c.getRoom(roomId);
  if (!room) throw new Error(ROOM_NOT_SYNCED);
  // one transaction id for every attempt of this draft (txn.ts): resend the failed echo, or send fresh with the SAME id
  const plan = planTxn(room, txnId, rebuild, (ev) => c.cancelPendingEvent(ev), content);
  const id =
    plan.kind === "done"
      ? plan.eventId
      : plan.kind === "resend"
        ? (await c.resendEvent(plan.event, room)).event_id
        : (await c.sendEvent(roomId, "m.room.message" as never, content as never, txnId)).event_id;
  lastSent.set(roomId, id);
  return id;
}

/** The room's encryption for this note (core/matrix/uploadCrypto: the room state OR the crypto store's sticky setting —
 *  what js-sdk asks before it encrypts the event; review round 4, VN-1). Throws when it can't be told: no upload. */
function isEncrypted(roomId: string): Promise<boolean> {
  const c = peekClient();
  if (!c) return Promise.reject(new Error("Not signed in"));
  return roomEncryptedForUpload(c, roomId);
}

let echoSeq = 0;
let wired = false;
/** Wire the store to the app (once, at feature setup). */
export function wireVoice(): void {
  if (wired) return;
  wired = true;
  configureVoice({
    account: () => peekClient()?.getUserId() ?? null,
    startCapture: (cb, signal) => startCapture(cb, signal),
    upload: async (roomId, blob, mimetype, encrypt, alive) => {
      const c = peekClient();
      if (!c?.getRoom(roomId)) throw new Error(ROOM_NOT_SYNCED);
      // VN-1: plaintext only when the state AND the crypto store say so (unsure = throws = nothing uploaded); then the
      // last (synchronous) read and the start of a PLAINTEXT request are in the same tick (no await between them —
      // core's uploadFile probes the file first): a plaintext upload never begins once the room is encrypted
      const encryptIt = encrypt || (await roomEncryptedForUpload(c, roomId));
      // the oracle awaited: a draft discarded meanwhile (Delete, leave, sign-out, another account) uploads nothing
      if ((alive && !alive()) || peekClient() !== c) throw new Error("voice: discarded");
      if (!encryptIt && !encryptedNowSync(c, roomId)) {
        const res = await c.uploadContent(blob, { name: voiceFileName(mimetype), type: mimetype, includeFilename: true });
        return { mxc: res.content_uri };
      }
      const enc = await encryptAttachment(await blob.arrayBuffer());
      const res = await c.uploadContent(new Blob([enc.data], { type: "application/octet-stream" }), { type: "application/octet-stream", includeFilename: false });
      return { file: { ...enc.file, url: res.content_uri } };
    },
    uploadLimit,
    isEncrypted,
    send: sendWithTxn,
    cancelPending: (roomId, txnId) => {
      const c = peekClient();
      const room = c?.getRoom(roomId);
      if (c && room) cancelTxnEcho(room, txnId, (ev) => c.cancelPendingEvent(ev));
    },
    newTxnId: () => `tw-voice-${Date.now().toString(36)}-${(++txnSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    toast: (m) => toast(m),
    announce,
    recordingSession: (on) => setRecordingAudioSession(on),
    createUrl: (b) => URL.createObjectURL(inertBlob(b, "audio/ogg")),
    revokeUrl: (u) => URL.revokeObjectURL(u),
    echo: {
      add: (roomId, blob, mimetype) => {
        const id = `~voice${Date.now()}-${++echoSeq}`;
        const file = new File([blob], voiceFileName(mimetype), { type: mimetype });
        useChatStore.getState().addUpload({ id, roomId, ts: Date.now(), file, localUrl: URL.createObjectURL(inertBlob(file, mimetype)), w: 0, h: 0, state: "uploading", error: "", msgtype: "m.audio" });
        return id;
      },
      drop: (id) => useChatStore.getState().dropUpload(id),
    },
    failText: (e) => failReason(e),
    phone: () => getFormFactor() === "mobile",
    log: (m) => log.info(m),
  });

  // one owner of the microphone: the call join waits for the recorder to stop (≤ 2 s) — the draft stays in review
  onMicYield((ms) => stopVoiceForCall(ms));

  // sign-out / account switch: every draft is gone
  bus.on("loggedOut", () => discardAllVoice());
  let lastUser: string | null = peekClient()?.getUserId() ?? null;
  let off: (() => void) | null = null;
  const attach = () => {
    off?.();
    off = null;
    const c = peekClient();
    const user = c?.getUserId() ?? null;
    if (user !== lastUser) discardAllVoice();
    lastUser = user;
    if (!c) return;
    const onMember = (room: Room, membership: string) => {
      if (membership === "leave" || membership === "ban") discardVoice(room.roomId);
    };
    const onEcho = (ev: MatrixEvent, room: Room) => {
      if (ev.status !== EventStatus.SENT && ev.status !== null) return;
      const t = ev.getTxnId() ?? (ev.getUnsigned().transaction_id as string | undefined);
      if (t) sentElsewhere(room.roomId, t);
    };
    c.on(RoomEvent.MyMembership, onMember as never);
    c.on(RoomEvent.LocalEchoUpdated, onEcho as never);
    off = () => {
      c.off(RoomEvent.MyMembership, onMember as never);
      c.off(RoomEvent.LocalEchoUpdated, onEcho as never);
    };
  };
  attach();
  onClientChanged(attach);

  // phones: the page going to the background (an OS interruption, an app switch) stops a recording into review
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden" || getFormFactor() !== "mobile") return;
      for (const d of Object.values(voiceStore.getState().drafts)) if (d.state === "recording") void stopVoice(d.roomId);
    });
  }
}

// ---- React -----------------------------------------------------------------------------------------------------------
export function useVoiceDraft(roomId: string): VoiceDraft | undefined {
  return useStore(voiceStore, (s) => s.drafts[roomId]);
}

let supported: boolean | null = null;
/** AudioEncoder Opus exists here (null while the check runs: the button stays hidden). */
export function useVoiceSupported(): boolean | null {
  const [v, setV] = useState<boolean | null>(supported);
  useEffect(() => {
    if (supported !== null) return;
    let on = true;
    void voiceSupported().then((ok) => {
      supported = ok;
      if (on) setV(ok);
    });
    return () => {
      on = false;
    };
  }, []);
  return v;
}

// ---- the test hook --------------------------------------------------------------------------------------------------
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function curRoom(roomId?: string): string {
  const r = roomId ?? useChatStore.getState().mainRoom;
  if (!r) throw new Error("no room open (pass a room id)");
  return r;
}
async function untilState(roomId: string, states: string[], ms = 15000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const s = getDraft(roomId)?.state ?? "idle";
    if (states.includes(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`voice note stuck in ${s}`);
    await wait(25);
  }
}

export interface TwVoice {
  supported(): Promise<boolean>;
  /** the recorder alone (no room, no sign-in): record `ms` of the microphone → the finished note with its bytes */
  recordRaw(ms: number): Promise<Omit<Finished, "blob"> & { size: number; base64: string }>;
  /** the encoder + muxer alone, exact length: `samples` of a synthetic tone (no microphone) → the file */
  encodeRaw(samples: number): Promise<{ preSkip: number; short: boolean; dropped: number; size: number; base64: string; waveform: number[] }>;
  /** the composer flow in a room (default: the open room) */
  start(roomId?: string): Promise<string>;
  stop(roomId?: string): Promise<string>;
  /** start, wait `ms`, stop → review; returns info() */
  record(ms: number, roomId?: string): Promise<ReturnType<TwVoice["info"]>>;
  cancel(roomId?: string): void;
  info(roomId?: string): { state: string; durationMs: number; waveform: number[]; mimetype: string; size: number; error: string; note: string; txnId: string };
  /** send the draft; resolves with the sent event id (throws with the draft's error) */
  send(roomId?: string): Promise<string>;
  lastSent(roomId?: string): string | null;
  /** a received voice note's <audio>: reached loadedmetadata with a duration (seconds) */
  received(eventId: string): { found: boolean; readyState: number; duration: number; ok: boolean };
  stopForCall(ms?: number): Promise<void>;
}

export function installVoiceHook(): void {
  const w = window as unknown as { __twVoice?: TwVoice };
  if (w.__twVoice) return;
  const info: TwVoice["info"] = (roomId) => {
    const d = getDraft(curRoom(roomId));
    return { state: d?.state ?? "idle", durationMs: d?.durationMs ?? 0, waveform: d?.waveform ?? [], mimetype: d?.mimetype ?? "", size: d?.size ?? 0, error: d?.error ?? "", note: d?.note ?? "", txnId: d?.txnId ?? "" };
  };
  w.__twVoice = {
    supported: () => voiceSupported(),
    async recordRaw(ms) {
      let ended = "";
      const h = await startCapture({ onProgress: () => undefined, onEnd: (r) => (ended = r) });
      await wait(ms);
      const f = await h.stop();
      if (ended) log.info(`recordRaw ended by itself: ${ended}`);
      const bytes = new Uint8Array(await f.blob.arrayBuffer());
      const { blob: _b, ...rest } = f;
      return { ...rest, size: bytes.length, base64: b64(bytes) };
    },
    async encodeRaw(samples) {
      const r = await encodeSynthetic(samples);
      const bytes = new Uint8Array(await r.blob.arrayBuffer());
      return { preSkip: r.preSkip, short: r.short, dropped: r.dropped, size: bytes.length, base64: b64(bytes), waveform: waveformOf(r.peaks) };
    },
    async start(roomId) {
      const r = curRoom(roomId);
      void startVoice(r);
      return untilState(r, ["recording", "idle"]);
    },
    async stop(roomId) {
      const r = curRoom(roomId);
      await stopVoice(r);
      return getDraft(r)?.state ?? "idle";
    },
    async record(ms, roomId) {
      const r = curRoom(roomId);
      void startVoice(r);
      if ((await untilState(r, ["recording", "idle"])) !== "recording") throw new Error("the recording didn't start");
      await wait(ms);
      await stopVoice(r);
      return info(r);
    },
    cancel: (roomId) => discardVoice(curRoom(roomId)),
    info,
    async send(roomId) {
      const r = curRoom(roomId);
      lastSent.delete(r);
      await sendVoice(r);
      const d = getDraft(r);
      if (d) throw new Error(d.error || `voice note still ${d.state}`);
      const id = lastSent.get(r);
      if (!id) throw new Error("not sent");
      return id;
    },
    lastSent: (roomId) => lastSent.get(curRoom(roomId)) ?? null,
    received(eventId) {
      const el = document.querySelector(`[data-event-id="${CSS.escape(eventId)}"] audio`) as HTMLAudioElement | null;
      if (!el) return { found: false, readyState: 0, duration: 0, ok: false };
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      return { found: true, readyState: el.readyState, duration: d, ok: el.readyState >= 1 && d > 0 };
    },
    stopForCall: (ms) => stopVoiceForCall(ms),
  };
}
