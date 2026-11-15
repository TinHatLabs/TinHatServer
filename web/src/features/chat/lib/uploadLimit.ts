// uploadLimit.ts — an attachment's or a voice note's size against the server's upload limit (QOL A08.2; voice notes §6).
// limit = m.upload.size (null = unknown: never refused). SHARED LOGIC: the desktop's room.rs voice_over_limit; both
// replay testvectors/upload-limit/vectors.json.
export function overUploadLimit(size: number, limit: number | null | undefined): boolean {
  return typeof limit === "number" && limit > 0 && size > limit;
}
