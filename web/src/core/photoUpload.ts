// photoUpload.ts: the upload-time rule "location is removed from photos you send" (docs/PHOTO-METADATA.md).
// Every upload goes through photoBytesForUpload first (core/matrix/media.ts uploadFile = chat attach / paste /
// drag-drop / Memories "Add photos" / profile, space and background photos; nav setRoomPhoto = the room photo). The
// desktop's mirror is room.rs photo_bytes_for_upload. 12.1.16 2-2: the BYTES decide, never the declared type or the
// name: a JPEG/PNG/WebP/HEIC/HEIF/AVIF is cleaned (or not sent) whatever it is called; a TIFF (DNG and the camera RAWs
// built on it) is not sent: it carries Exif/GPS and isn't cleaned (launch-gate 13:55); anything else, GIF included (the
// only pass-through picture format), goes up exactly as it is. Shared table: testvectors/exif-strip/upload-rule.json.
import { CLEANED_FORMATS, ExifStripError, SNIFF_HEAD, sniffImage, stripImageMetadata } from "./exifstrip";

export { ExifStripError };

/** The wording when a photo's metadata couldn't be removed (nothing was uploaded). Same words on the desktop. */
export const PHOTO_LOCATION_FAIL = "Couldn't remove this photo's location, so it wasn't sent";

/** The bytes to upload for `file`: a picture without its location and identifying metadata (only the orientation kept;
 *  lossless), anything else unchanged (the same Blob). `mimetype` is the declared type: it names the result's type and
 *  NEVER decides (12.1.16 2-2). Throws ExifStripError when a picture can't be cleaned: the caller must not upload it. */
/** 12.1.16 R3-1: an upload that is NOT a picture (a soundboard clip, a voice note) refuses bytes that sniff as a picture
 *  in ANY format (GIF, TIFF and RAWs included): such a path never sends pictures, and a picture renamed `clip.mp3` could
 *  carry a location. Nothing is cleaned; throws ExifStripError = nothing is uploaded (PHOTO_LOCATION_FAIL). Only the
 *  head is read. The desktop's room.rs refuse_picture_bytes. */
export async function refusePictureBytes(file: Blob): Promise<void> {
  const kind = sniffImage(new Uint8Array(await file.slice(0, SNIFF_HEAD).arrayBuffer()));
  if (kind !== null) throw new ExifStripError(`${kind}: a picture on a non-picture upload, not sent`);
}

export async function photoBytesForUpload(file: Blob, mimetype: string): Promise<Blob> {
  // only the head is read before deciding: a big video or archive is never loaded for this
  const head = new Uint8Array(await file.slice(0, SNIFF_HEAD).arrayBuffer());
  const kind = sniffImage(head);
  if (kind === "tiff" || kind === "raw") throw new ExifStripError(`${kind}: not cleaned, not sent`);
  if (kind === null || !CLEANED_FORMATS.has(kind)) return file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const s = stripImageMetadata(bytes);
  // the sniff says picture, the cleaner doesn't recognise it (e.g. a HEIC cut inside its ftyp): fail closed
  if (s.format === "other") throw new ExifStripError(`${kind}: not a picture the cleaner can read`);
  if (s.bytes === bytes) return file;
  if (s.bytes.length === bytes.length && s.bytes.every((b, i) => b === bytes[i])) return file;
  return new Blob([s.bytes as Uint8Array<ArrayBuffer>], { type: file.type || mimetype });
}
