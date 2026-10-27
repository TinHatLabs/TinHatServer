// mediatype.ts — the ONE rule for the type a blob of someone else's bytes may carry (security review 2026-10-26, H1).
//
// A `blob:` URL has this page's origin. Opened as a document — "Open" on an attachment, the browser's own "Open image
// in new tab" / drag-to-the-address-bar on an <img src="blob:…">, a middle-click — it runs with this origin's session
// token and crypto store whenever its type is one a browser renders as a scriptable document (text/html, image/svg+xml,
// any XML, XHTML, …). So every blob made from remote or member-supplied bytes (attachments, avatars, thumbnails, link
// preview images, GIFs, posters) gets its type from the allow-list below and NEVER from the event's `info.mimetype`,
// the server's Content-Type or a file name: an inert type a browser shows as a picture, a player, a PDF viewer or plain
// text — else application/octet-stream. Inline <img>/<video>/<audio> sniff the bytes, so pictures and players keep
// working with octet-stream; a document of that type is a download. SVG is never shown (as in Element Web): an <img>
// needs the svg type to draw it, and that type must not exist on a blob.
//
// The desktop app has the same allow-list for its attachment "Open" (the desktop lane, 2026-10-26); keep the two equal.
// Pure (no imports): mediatype.test.ts runs it under Node.

/** Lower-case essence (no parameters) → the type a blob may carry. Every value is inert as a top-level document. */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  // pictures
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
  "image/avif": "image/avif",
  // video
  "video/mp4": "video/mp4",
  "video/webm": "video/webm",
  // audio
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/aac": "audio/aac",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "audio/webm": "audio/webm",
  "audio/wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
  // documents the browser shows in its own viewer
  "application/pdf": "application/pdf",
  // plain text: always UTF-8 (a sender-chosen charset is never honoured)
  "text/plain": "text/plain;charset=utf-8",
});

/** What every other type becomes. */
export const OPAQUE_TYPE = "application/octet-stream";

/** Media types a blob may ALSO keep so a player can play it inline, though "Open" doesn't show them in a tab (the Open
 *  list is the desktop's): video and audio containers a browser shows as a media document or downloads, never as a page.
 *  WebKit on Apple platforms picks its player by the blob's type, so an iPhone's .MOV (video/quicktime), 3GPP or
 *  CAF/AIFF recording played black / silent as octet-stream (launch-gate review of this branch). */
const PLAYABLE: Readonly<Record<string, string>> = Object.freeze({
  "video/quicktime": "video/quicktime",
  "video/x-m4v": "video/x-m4v",
  "video/3gpp": "video/3gpp",
  "video/3gpp2": "video/3gpp2",
  "video/ogg": "video/ogg",
  "audio/3gpp": "audio/3gpp",
  "audio/3gpp2": "audio/3gpp2",
  "audio/x-caf": "audio/x-caf",
  "audio/aiff": "audio/aiff",
  "audio/x-aiff": "audio/aiff",
  "audio/amr": "audio/amr",
});

/** The essence of a MIME type string: `type/subtype`, lower case, parameters and spaces dropped ("" when malformed). */
export function mimeEssence(mime: unknown): string {
  if (typeof mime !== "string") return "";
  const e = mime.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(e) ? e : "";
}

/** The type a "Open"-in-a-tab of these bytes may use, or null = download only. */
export function viewerType(mime: unknown): string | null {
  return ALLOWED[mimeEssence(mime)] ?? null;
}

/** The type a blob of remote / member bytes may carry: the allow-listed type for `mime` (the viewer list, or a media
 *  type that only ever plays), else application/octet-stream. */
export function blobType(mime: unknown): string {
  return viewerType(mime) ?? PLAYABLE[mimeEssence(mime)] ?? OPAQUE_TYPE;
}

/** A type a browser could run as a scriptable document (HTML, SVG, any XML, XSLT, JavaScript). The timeline shows such
 *  an `m.image` as a file card instead of a broken picture (its blob is octet-stream, which no <img> draws as SVG). */
export function isScriptableType(mime: unknown): boolean {
  return /svg|xml|html|xsl|javascript|ecmascript/.test(mimeEssence(mime));
}

/** The file extension each viewer type is opened as on the desktop (viewer.rs) — the shared vectors' `ext`. */
const EXT: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "text/plain;charset=utf-8": "txt",
});

/** The extension for `mime` (through the allow-list), or null = download only. */
export function viewerExt(mime: unknown): string | null {
  const t = viewerType(mime);
  return t ? EXT[t] ?? null : null;
}

/** Pictures shown inline (the timeline, the lightbox): PNG, JPEG, GIF, WebP — the shared rule (the desktop's
 *  INLINE_EXTS; AVIF opens but isn't drawn inline: no shipped Qt reads it, so neither app does). */
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function isInlineImage(mime: unknown): boolean {
  const t = viewerType(mime);
  return t !== null && INLINE.has(t);
}

const at = (h: Uint8Array, off: number, magic: number[] | string): boolean => {
  const m = typeof magic === "string" ? [...magic].map((c) => c.charCodeAt(0)) : magic;
  if (h.length < off + m.length) return false;
  for (let i = 0; i < m.length; i++) if (h[off + i] !== m[i]) return false;
  return true;
};
/** The size of a well-formed ISO-BMFF `ftyp` box at the start: a 32-bit size of at least 16, a whole number of 4-byte
 *  brands, at most 4 KiB, all of it inside `h` — a size that doesn't fit is a forgery, never clamped (viewer.rs ftyp_box;
 *  `<!--ftypavif` read as a 1 GB box). null = no such box. */
function ftypBox(h: Uint8Array): number | null {
  if (!at(h, 4, "ftyp")) return null;
  const size = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return size >= 16 && size % 4 === 0 && size <= 4096 && size <= h.length ? size : null;
}
/** A well-formed `ftyp` box whose major or compatible brands include one of `brands` (viewer.rs ftyp_has). */
function ftypHas(h: Uint8Array, brands: string[]): boolean {
  const end = ftypBox(h);
  if (end === null) return false;
  const has = (i: number) => brands.some((b) => at(h, i, b));
  if (has(8)) return true;
  for (let i = 16; i + 4 <= end; i += 4) if (has(i)) return true;
  return false;
}
/** UTF-8 text without NULs that doesn't start like a page (HTML / SVG / XML / script) — viewer.rs plain_text. */
function plainText(h: Uint8Array): boolean {
  const head = h.subarray(0, 8192);
  if (head.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true }); // a character cut at the end is fine
  } catch {
    return false;
  }
  const t = text.replace(/^\uFEFF+/, "").trimStart().toLowerCase();
  return !["<!doctype", "<html", "<?xml", "<svg", "<script", "<head", "<body", "<iframe"].some((p) => t.startsWith(p));
}

/** The bytes (the first few KiB are enough) are what extension `ext` says (viewer.rs sniff, the shared vectors' `sniff`):
 *  Open shows a tab only when they are. */
export function bytesAre(ext: string, h: Uint8Array): boolean {
  switch (ext) {
    case "png":
      return at(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
      return at(h, 0, [0xff, 0xd8, 0xff]);
    case "gif":
      return at(h, 0, "GIF87a") || at(h, 0, "GIF89a");
    case "webp":
      return at(h, 0, "RIFF") && at(h, 8, "WEBP");
    case "avif":
      return ftypHas(h, ["avif", "avis"]);
    case "mp4":
      return ftypBox(h) !== null && !ftypHas(h, ["avif", "avis", "heic", "heix", "mif1"]);
    case "m4a":
      return ftypHas(h, ["M4A ", "M4B ", "mp42", "isom", "mp41", "dash"]);
    case "webm":
    case "weba":
      return at(h, 0, [0x1a, 0x45, 0xdf, 0xa3]);
    case "ogg":
    case "opus":
      return at(h, 0, "OggS");
    case "wav":
      return at(h, 0, "RIFF") && at(h, 8, "WAVE");
    case "flac":
      return at(h, 0, "fLaC");
    case "mp3":
      return at(h, 0, "ID3") || (h.length >= 2 && h[0] === 0xff && (h[1]! & 0xe0) === 0xe0);
    case "aac":
      return at(h, 0, "ID3") || (h.length >= 2 && h[0] === 0xff && (h[1]! & 0xf6) === 0xf0);
    case "pdf":
      return at(h, 0, "%PDF-");
    case "txt":
      return plainText(h);
  }
  return false;
}

/** Types (or, untyped, file names) of text-like files — JSON, CSV, Markdown, logs, source code — that "Open" shows as
 *  UTF-8 plain text in a tab when the bytes pass the plain-text sniff (bytesAre "txt"): a text/plain;charset=utf-8 blob
 *  never renders as a page, whatever the file is (launch-gate review: these only downloaded). HTML / XML / SVG are not
 *  text-like here (they download). */
const TEXT_LIKE = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/x-sh",
  "application/x-shellscript",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/x-python",
  "application/x-log",
]);
const TEXT_EXT = /\.(txt|text|md|markdown|log|csv|tsv|json|ndjson|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|ps1|bat|py|js|mjs|cjs|ts|tsx|jsx|rs|go|c|h|cc|cpp|hpp|cs|java|kt|swift|rb|php|pl|lua|sql|css|scss|diff|patch|srt|vtt|nfo)$/i;

export function isTextLike(mime: unknown, name = ""): boolean {
  const e = mimeEssence(mime);
  if (e.startsWith("text/")) return !/html|xml|xsl/.test(e);
  if (TEXT_LIKE.has(e)) return true;
  return (e === "" || e === OPAQUE_TYPE) && TEXT_EXT.test(String(name ?? ""));
}

/** The same bytes with a safe type: `hint` (the event's mimetype) when given, else the blob's own type, through the
 *  allow-list. Returns `blob` itself when its type already is the safe one. */
export function inertBlob(blob: Blob, hint?: string | null): Blob {
  const t = blobType(hint ? hint : blob.type);
  return blob.type === t ? blob : new Blob([blob], { type: t });
}
