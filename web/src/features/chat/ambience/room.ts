// room.ts — a room's shared background on Tin Hat Web (the desktop: room.rs background_* + AmbienceController): read
// the state, write it, and the custom image (docs/AMBIENCE.md §3.2): re-encoded as JPEG here (no EXIF / GPS can
// survive), sent as a NORMAL image message (encrypted on this device in an encrypted room), the state holding only its
// event id + a preset fallback. Readers fetch the message with their own token and decrypt it with their own keys;
// core.imageShown decides, anything else shows the preset — never a broken tile.
import { useEffect, useMemo, useState } from "react";
import { MatrixEvent, RoomEvent } from "matrix-js-sdk";
import { canSendState, peekClient, sendMessage, sendState, uploadFile, fetchEncryptedMedia, fetchMedia, useDerived, useRoomStateEvents, type EncryptedFile } from "@/core/matrix";
import { encryptedNowSync, roomEncryptedForUpload } from "@/core/matrix/uploadCrypto";
import { createLogger } from "@/core/log";
import { backgroundPermissionSpec, type BackgroundPermission } from "./sheetPerm";
import { BACKGROUND_STATE, IMAGE_MAX_BYTES, IMAGE_QUALITIES, IMAGE_SHRINK, fitImage, imageCells, imageDims, imageShown, parseBackground, type Background, type Cell, type ImageEvent } from "./core";

const log = createLogger("ambience");

/** The room's background (with who set it). */
export function useRoomBackground(roomId: string | null | undefined): Background {
  const evs = useRoomStateEvents(roomId, BACKGROUND_STATE);
  const e = evs.find((x) => x.stateKey === "");
  return useMemo(() => parseBackground(e ? e.content : null, e?.sender ?? ""), [e?.eventId, e?.content, e?.sender]);
}

/** May I change this room's background? (the room's power levels — moderators; both people in a Tin Hat DM) */
export function canSetBackground(roomId: string): boolean {
  return canSendState(roomId, BACKGROUND_STATE);
}

/** The same, LIVE (bgsheet-1220): null until the room's power levels are here, then re-evaluated whenever they change
 *  (the "Chat background" sheet; sheetPerm.ts). */
export function useCanSetBackground(roomId: string): BackgroundPermission {
  return useDerived(`canSetBackground:${roomId}`, () => backgroundPermissionSpec(roomId, BACKGROUND_STATE));
}

export async function setRoomBackground(roomId: string, content: Record<string, unknown>): Promise<void> {
  await sendState(roomId, BACKGROUND_STATE, "", content);
  log.info(`background set: ${String(content.kind ?? "")}${content.preset ? ` ${String(content.preset)}` : ""}`);
}

/** Is the room encrypted right now (for the sheet's one-line warning; the upload decides again by itself)? */
export function roomEncrypted(roomId: string): boolean {
  const c = peekClient();
  return !!c && encryptedNowSync(c, roomId);
}

/** Re-encode an image as JPEG within the limits: ≤ 2560 px on the long side, ≤ 1.5 MB (quality ladder, then shrink). */
export async function reencode(file: Blob): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  try {
    let { w, h } = fitImage(bmp.width, bmp.height);
    if (!w || !h) throw new Error("not an image");
    for (let round = 0; round < 8; round++) {
      const cv = new OffscreenCanvas(w, h);
      const g = cv.getContext("2d");
      if (!g) throw new Error("no canvas");
      g.fillStyle = "#000";
      g.fillRect(0, 0, w, h);
      g.drawImage(bmp, 0, 0, w, h);
      for (const q of IMAGE_QUALITIES) {
        const blob = await cv.convertToBlob({ type: "image/jpeg", quality: q });
        if (blob.size <= IMAGE_MAX_BYTES) return { blob, w, h };
      }
      w = Math.max(1, Math.round(w * IMAGE_SHRINK));
      h = Math.max(1, Math.round(h * IMAGE_SHRINK));
    }
    throw new Error("image too large");
  } finally {
    bmp.close();
  }
}

/** Can this device decode the picture (12.1.17: a HEIC on a browser without HEIC says so at the pick, not at Apply)? */
export async function decodable(file: Blob): Promise<boolean> {
  try {
    (await createImageBitmap(file)).close();
    return true;
  } catch {
    return false;
  }
}

/** Post the image to the chat (a normal image message: "Chat background") and return its event id. */
export async function postBackgroundImage(roomId: string, file: Blob): Promise<string> {
  const { blob, w, h } = await reencode(file);
  const pic = new File([blob], "Chat background.jpg", { type: "image/jpeg" });
  let up = await uploadFile(pic, { encrypt: false, room: roomId, name: "Chat background.jpg", mimetype: "image/jpeg" });
  if (!up.file) {
    // 2-6 (the chat attachments' rule, actions.ts runUpload; the desktop's attach_upload_checked): the room turned
    // encrypted while the plaintext upload ran → upload again, encrypted; a plaintext reference never goes into an
    // encrypted room (unsure = throws = nothing is posted)
    const c = peekClient();
    if (!c) throw new Error("Not signed in");
    if (await roomEncryptedForUpload(c, roomId)) up = await uploadFile(pic, { encrypt: true, name: "Chat background.jpg", mimetype: "image/jpeg" });
  }
  const content: Record<string, unknown> = { ...up.content, body: "Chat background", info: { ...(up.content.info as object), w, h, mimetype: "image/jpeg", size: blob.size } };
  const id = await sendMessage(roomId, content as never);
  log.info(`background image posted (${w}x${h}, ${blob.size} B, ${up.file ? "encrypted" : "plain room"})`);
  return id;
}

/** A shown custom image: the still picture that was analysed (an object URL) and its colour cells (core.imageCells over
 *  EVERY pixel — downsampling would average a thin line away). */
export interface ShownImage {
  src: string;
  cells: Cell[];
}
/** The largest image decoded for a background (a bigger one, from another client, shows the preset). */
const IMAGE_DECODE_MAX = 4096;
type Load = { ok: true; blob: Blob; cells: Cell[] } | { ok: false; retry: boolean };
async function loadImage(roomId: string, bg: Background): Promise<Load> {
  const c = peekClient();
  if (!c || !bg.image) return { ok: false, retry: false };
  let ev: MatrixEvent;
  try {
    ev = c.getRoom(roomId)?.findEventById(bg.image) ?? new MatrixEvent(await c.fetchRoomEvent(roomId, bg.image));
  } catch {
    return { ok: false, retry: false }; // not fetchable here (history visibility, gone): imageShown(…, null) = false
  }
  if (ev.isEncrypted()) await c.decryptEventIfNeeded(ev).catch(() => {});
  const content = ev.getContent() as { msgtype?: string; file?: EncryptedFile; url?: string };
  const info: ImageEvent = {
    type: ev.getType(),
    sender: ev.getSender() ?? "",
    room: ev.getRoomId() ?? roomId,
    msgtype: typeof content.msgtype === "string" ? content.msgtype : "",
    redacted: ev.isRedacted(),
    decrypted: !ev.isDecryptionFailure() && ev.getType() !== "m.room.encrypted",
  };
  // no key yet (joined later, keys still on their way): the preset now, and another try later
  if (!imageShown(bg, roomId, info)) return { ok: false, retry: !info.decrypted && !info.redacted };
  try {
    const blob = content.file ? await fetchEncryptedMedia(content.file, "image/jpeg") : content.url ? await fetchMedia(content.url) : null;
    if (!blob) return { ok: false, retry: false };
    // 3-6: the size from the header FIRST: a picture too large (or one whose size its header doesn't say) is never decoded
    const dims = imageDims(new Uint8Array(await blob.arrayBuffer()));
    if (!dims || dims.w > IMAGE_DECODE_MAX || dims.h > IMAGE_DECODE_MAX) return { ok: false, retry: false };
    const bmp = await createImageBitmap(blob).catch(() => null); // only bytes that decode as an image; its first frame
    if (!bmp) return { ok: false, retry: false };
    try {
      if (bmp.width > IMAGE_DECODE_MAX || bmp.height > IMAGE_DECODE_MAX) return { ok: false, retry: false };
      // the still frame that will be shown (an animated image never moves on; transparency on a black matte) …
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const g = cv.getContext("2d");
      if (!g) return { ok: false, retry: false };
      g.fillStyle = "#000";
      g.fillRect(0, 0, bmp.width, bmp.height);
      g.drawImage(bmp, 0, 0);
      const still = await cv.convertToBlob({ type: "image/png" });
      // … measured from its own decoded pixels (what is measured is exactly what is shown)
      const shown = await createImageBitmap(still);
      try {
        const cv2 = new OffscreenCanvas(shown.width, shown.height);
        const g2 = cv2.getContext("2d");
        if (!g2) return { ok: false, retry: false };
        g2.drawImage(shown, 0, 0);
        const cells = imageCells(g2.getImageData(0, 0, shown.width, shown.height).data, shown.width, shown.height, 8);
        return { ok: true, blob: still, cells };
      } finally {
        shown.close();
      }
    } finally {
      bmp.close();
    }
  } catch {
    return { ok: false, retry: false };
  }
}
const RETRY_MS = 20_000;
const RETRY_MAX = 30;
/** The custom image when core.imageShown says so (null = show the preset fallback). Keyed by account, room, image and
 *  setter: a result never outlives its key; a redaction of the image clears it at once; an image this device can't
 *  decrypt yet is tried again every 20 s (keys arriving later). */
export function useBackgroundImage(roomId: string | null | undefined, bg: Background): ShownImage | null {
  const me = peekClient()?.getUserId() ?? "";
  const key = roomId && bg.kind === "image" && bg.image ? `${me}|${roomId}|${bg.image}|${bg.by}` : "";
  const [shown, setShown] = useState<{ key: string; img: ShownImage } | null>(null);
  useEffect(() => {
    if (!key || !roomId) return;
    let live = true;
    let url = "";
    let timer = 0;
    let tries = 0;
    const attempt = async () => {
      const r = await loadImage(roomId, bg);
      if (!live) return;
      // revalidate after the awaits: deleted meanwhile → the preset
      const ev = peekClient()?.getRoom(roomId)?.findEventById(bg.image ?? "");
      if (r.ok && !(ev && ev.isRedacted())) {
        url = URL.createObjectURL(r.blob);
        setShown({ key, img: { src: url, cells: r.cells } });
        log.info(`background image shown (${r.cells.length} cells)`);
      } else if (!r.ok && r.retry && ++tries < RETRY_MAX) timer = window.setTimeout(() => void attempt(), RETRY_MS);
    };
    void attempt();
    const c = peekClient();
    const onRedaction = (ev: MatrixEvent, room: { roomId?: string } | undefined) => {
      if (room?.roomId !== roomId) return;
      const target = (ev.event as { redacts?: string }).redacts ?? (ev.getContent() as { redacts?: string }).redacts;
      if (target === bg.image) {
        live = false; // a load still in flight is dropped too
        window.clearTimeout(timer);
        setShown((s) => (s?.key === key ? null : s));
        log.info("background image deleted: the preset");
      }
    };
    // the SDK names a redaction only for events it holds; an image fetched outside the timeline is caught here
    const onTimeline = (ev: MatrixEvent, room: { roomId?: string } | undefined) => {
      if (ev.getType() === "m.room.redaction") onRedaction(ev, room);
    };
    c?.on(RoomEvent.Redaction, onRedaction as never);
    c?.on(RoomEvent.Timeline, onTimeline as never);
    return () => {
      live = false;
      window.clearTimeout(timer);
      c?.off(RoomEvent.Redaction, onRedaction as never);
      c?.off(RoomEvent.Timeline, onTimeline as never);
      setShown((s) => (s?.key === key ? null : s));
      if (url) URL.revokeObjectURL(url);
    };
  }, [key]);
  return shown && shown.key === key ? shown.img : null;
}
