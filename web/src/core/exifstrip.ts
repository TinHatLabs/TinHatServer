// exifstrip.ts: "location is removed from photos you send" (docs/PHOTO-METADATA.md).
//
// Every image the app uploads (chat attach / paste / drag-drop, Memories "Add photos", profile, room and space photos)
// goes through stripImageMetadata first: GPS and every other identifying tag (camera serial, owner name, maker notes,
// XMP, IPTC, comments, secondary pictures) is removed WITHOUT re-encoding the picture; only the EXIF Orientation
// survives, so a phone photo doesn't turn sideways. The desktop runs the same rule in Rust
// (crates/widgets/src/exifstrip.rs); both replay testvectors/exif-strip/ (a byte-identical copy in both repos, made by
// the independent reference scripts/exif-strip-oracle.py in the desktop repo). Pure: no DOM, no I/O.
//
//   JPEG  keep SOI, the JFIF APP0 (header only, no thumbnail), APP2 "ICC_PROFILE", APP14 "Adobe" (its fields only), every
//         non-APP marker and the scans; drop the other APPn and COM; stop at the first EOI. A truncated last scan is
//         kept as it is.
//   PNG   keep the chunks that draw the picture (PNG_KEEP; iCCP's name replaced, IEND empty), drop the rest; stop
//         after IEND.
//   WebP  drop EXIF, "XMP " and unknown chunks (also inside animation frames); fix the VP8X flags and the RIFF size.
//   HEIF  (HEIC/HEIF/AVIF) overwrite every metadata item (Exif, mime, uri) in place (same length, same offsets) and
//         clear every top-level box but ftyp/the first meta/mdat/moov (Samsung sefd, uuid, a second meta, …), the main
//         meta's xml boxes and moov's user data; refused when such an item has no location, lies outside the media
//         data or overlaps the picture, or when any item's extent runs past its end.
//   other unchanged (GIF, BMP, SVG, anything else).
// Orientation (1..8) is written back as the only tag of a minimal big-endian TIFF. A structure the rule can't walk
// throws ExifStripError: the caller does NOT upload the file.

export class ExifStripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExifStripError";
  }
}

export type StripFormat = "jpeg" | "png" | "webp" | "heif" | "other";
export interface Stripped {
  format: StripFormat;
  bytes: Uint8Array;
  /** The source's EXIF orientation, 1..8 (1 = none). */
  orientation: number;
}

const fail = (m: string): never => {
  throw new ExifStripError(m);
};

const u16be = (d: Uint8Array, p: number) => (d[p] << 8) | d[p + 1];
const u32be = (d: Uint8Array, p: number) => ((d[p] << 24) >>> 0) + ((d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]);
const u16le = (d: Uint8Array, p: number) => d[p] | (d[p + 1] << 8);
const u32le = (d: Uint8Array, p: number) => ((d[p + 3] << 24) >>> 0) + ((d[p + 2] << 16) | (d[p + 1] << 8) | d[p]);

function startsWith(d: Uint8Array, p: number, s: string): boolean {
  if (p + s.length > d.length) return false;
  for (let i = 0; i < s.length; i++) if (d[p + i] !== s.charCodeAt(i)) return false;
  return true;
}

class Out {
  private parts: Uint8Array[] = [];
  len = 0;
  push(b: Uint8Array): void {
    this.parts.push(b);
    this.len += b.length;
  }
  bytes(): Uint8Array {
    const o = new Uint8Array(this.len);
    let p = 0;
    for (const b of this.parts) {
      o.set(b, p);
      p += b.length;
    }
    return o;
  }
}

const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function be16(v: number): Uint8Array {
  return Uint8Array.of((v >>> 8) & 255, v & 255);
}
function be32(v: number): Uint8Array {
  return Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}
function le32(v: number): Uint8Array {
  return Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
}

// ---- TIFF / EXIF ---------------------------------------------------------------------------------------------------

/** IFD0 Orientation of a TIFF block (from its byte-order mark); 1 when missing or unreadable. */
export function orientationFromTiff(t: Uint8Array): number {
  if (t.length < 8) return 1;
  let le: boolean;
  if (t[0] === 0x49 && t[1] === 0x49 && t[2] === 0x2a && t[3] === 0) le = true;
  else if (t[0] === 0x4d && t[1] === 0x4d && t[2] === 0 && t[3] === 0x2a) le = false;
  else return 1;
  const r16 = (p: number) => (le ? u16le(t, p) : u16be(t, p));
  const r32 = (p: number) => (le ? u32le(t, p) : u32be(t, p));
  const ifd = r32(4);
  if (ifd + 2 > t.length) return 1;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + 12 * i;
    if (p + 12 > t.length) return 1;
    if (r16(p) === 0x0112) {
      if (r16(p + 2) !== 3 || r32(p + 4) < 1) return 1;
      const v = r16(p + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

const withoutExifPrefix = (d: Uint8Array) => (startsWith(d, 0, "Exif\0\0") ? d.subarray(6) : d);

/** Orientation as the only tag; 1 → an empty IFD0 (only HEIF writes that one). */
export function minimalTiff(orientation: number): Uint8Array {
  if (orientation === 1) return Uint8Array.of(0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0);
  return Uint8Array.of(0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0);
}

// ---- JPEG ----------------------------------------------------------------------------------------------------------

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const s = new Uint8Array(payload.length + 4);
  s[0] = 0xff;
  s[1] = marker;
  s.set(be16(payload.length + 2), 2);
  s.set(payload, 4);
  return s;
}

/** The segment to keep for an APPn/COM (rebuilt to its needed fields), or null to drop it. Other markers: kept. */
function jpegSegment(marker: number, payload: Uint8Array): Uint8Array | null {
  if (marker === 0xe0) {
    // JFIF only, its 14-byte header with the thumbnail size set to 0 (drops a JFIF thumbnail); JFXX and the rest go
    if (startsWith(payload, 0, "JFIF\0") && payload.length >= 14) {
      const p = new Uint8Array(14);
      p.set(payload.subarray(0, 12));
      return segment(0xe0, p);
    }
    return null;
  }
  if (marker === 0xe2) return startsWith(payload, 0, "ICC_PROFILE\0") ? segment(0xe2, payload) : null;
  if (marker === 0xee) {
    // Adobe: its 12 bytes of fields only ("Adobe", version, flags0, flags1, colour transform)
    return startsWith(payload, 0, "Adobe") && payload.length >= 12 ? segment(0xee, payload.subarray(0, 12)) : null;
  }
  if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) return null;
  return segment(marker, payload);
}

function stripJpeg(d: Uint8Array): { bytes: Uint8Array; orientation: number } {
  const n = d.length;
  const head: { m: number; seg: Uint8Array }[] = [];
  const tail = new Out();
  let orientation = 0;
  let i = 2;
  let inHead = true;
  while (i < n) {
    if (d[i] !== 0xff) fail(`jpeg: expected a marker at ${i}`);
    while (i < n && d[i] === 0xff) i++;
    if (i >= n) fail("jpeg: ends inside a marker");
    const m = d[i];
    i++;
    if (m === 0x00) fail("jpeg: stray 0xFF00");
    if (m === 0xd9) {
      tail.push(Uint8Array.of(0xff, 0xd9));
      break;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      const seg = Uint8Array.of(0xff, m);
      if (inHead) head.push({ m, seg });
      else tail.push(seg);
      continue;
    }
    if (m === 0xd8) fail("jpeg: second SOI");
    if (i + 2 > n) fail("jpeg: ends inside a segment length");
    const ln = u16be(d, i);
    if (ln < 2 || i + ln > n) fail("jpeg: segment length past the end");
    const payload = d.subarray(i + 2, i + ln);
    i += ln;
    if (m === 0xe1 && inHead && orientation === 0 && startsWith(payload, 0, "Exif\0\0")) {
      orientation = orientationFromTiff(payload.subarray(6));
    }
    const seg = jpegSegment(m, payload);
    if (seg) {
      if (inHead) head.push({ m, seg });
      else tail.push(seg);
    }
    if (m === 0xda) {
      inHead = false;
      // entropy-coded data: up to the next marker that isn't a stuffed byte, a restart or fill
      let j = i;
      while (j < n) {
        if (d[j] === 0xff && j + 1 < n) {
          const b = d[j + 1];
          if (b === 0x00 || (b >= 0xd0 && b <= 0xd7)) {
            j += 2;
            continue;
          }
          if (b === 0xff) {
            j += 1;
            continue;
          }
          break;
        }
        j++;
      }
      tail.push(d.subarray(i, j));
      i = j;
      if (j >= n) break; // truncated scan: kept as it is
    }
  }
  const o = orientation || 1;
  const out = new Out();
  out.push(Uint8Array.of(0xff, 0xd8));
  let k = 0;
  while (k < head.length && head[k].m === 0xe0) out.push(head[k++].seg);
  if (o !== 1) {
    const t = minimalTiff(o);
    const p = new Uint8Array(6 + t.length);
    p.set(latin("Exif\0\0"));
    p.set(t, 6);
    out.push(segment(0xe1, p));
  }
  for (; k < head.length; k++) out.push(head[k].seg);
  out.push(tail.bytes());
  return { bytes: out.bytes(), orientation: o };
}

// ---- PNG -----------------------------------------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The chunks that draw the picture; everything else (eXIf, tEXt, zTXt, iTXt = XMP, tIME, sPLT, private chunks) goes. */
const PNG_KEEP = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCV", "cLLI", "bKGD", "hIST",
  "pHYs", "acTL", "fcTL", "fdAT",
]);
const PNG_IEND = Uint8Array.of(0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
/** iCCP's free-text profile name is replaced by this one (the profile itself stays: it is the picture's colours). */
const ICCP_NAME = "ICC profile";

interface Chunk {
  type: string;
  start: number;
  end: number;
  dataAt: number;
  dataEnd: number;
}

function pngChunks(d: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  let i = 8;
  const n = d.length;
  while (i < n) {
    if (i + 8 > n) fail("png: ends inside a chunk header");
    const ln = u32be(d, i);
    const type = String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
    if (ln > 0x7fffffff || i + 12 + ln > n) fail("png: chunk length past the end");
    out.push({ type, start: i, end: i + 12 + ln, dataAt: i + 8, dataEnd: i + 8 + ln });
    i += 12 + ln;
    if (type === "IEND") break;
  }
  return out;
}

let crcTable: Uint32Array | null = null;
export function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typed = new Uint8Array(4 + data.length);
  typed.set(latin(type));
  typed.set(data, 4);
  const c = new Uint8Array(12 + data.length);
  c.set(be32(data.length));
  c.set(typed, 4);
  c.set(be32(crc32(typed)), 8 + data.length);
  return c;
}

function stripPng(d: Uint8Array): { bytes: Uint8Array; orientation: number } {
  const chunks = pngChunks(d);
  let o = 1;
  for (const c of chunks) {
    if (c.type === "IDAT") break;
    if (c.type === "eXIf") {
      o = orientationFromTiff(withoutExifPrefix(d.subarray(c.dataAt, c.dataEnd)));
      break;
    }
  }
  const out = new Out();
  out.push(Uint8Array.from(PNG_SIG));
  let wrote = false;
  for (const c of chunks) {
    if (c.type === "IDAT" && !wrote) {
      wrote = true;
      if (o !== 1) out.push(pngChunk("eXIf", minimalTiff(o)));
    }
    if (c.type === "IEND") out.push(PNG_IEND); // an IEND carries nothing
    else if (c.type === "iCCP") {
      const z = indexOf(d, 0, c.dataAt, c.dataEnd);
      if (z < 0) fail("png: iCCP without a name");
      const name = latin(ICCP_NAME);
      const data = new Uint8Array(name.length + (c.dataEnd - z));
      data.set(name);
      data.set(d.subarray(z, c.dataEnd), name.length);
      out.push(pngChunk("iCCP", data));
    } else if (PNG_KEEP.has(c.type)) out.push(d.subarray(c.start, c.end));
  }
  return { bytes: out.bytes(), orientation: o };
}

// ---- WebP ----------------------------------------------------------------------------------------------------------

const WEBP_KEEP = new Set(["VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"]);
/** Inside an animation frame: only the picture's own chunks. */
const ANMF_KEEP = new Set(["ALPH", "VP8 ", "VP8L"]);

function riffChunks(d: Uint8Array, start: number, end: number, what: string): Chunk[] {
  const out: Chunk[] = [];
  let i = start;
  while (i < end) {
    if (i + 8 > end) fail(`webp: ends inside a ${what} header`);
    const type = String.fromCharCode(d[i], d[i + 1], d[i + 2], d[i + 3]);
    const ln = u32le(d, i + 4);
    if (i + 8 + ln > end) fail(`webp: ${what} length past the end`);
    const padded = ln + (ln & 1);
    out.push({ type, start: i, end: Math.min(i + 8 + padded, end), dataAt: i + 8, dataEnd: i + 8 + ln });
    i += 8 + padded;
  }
  return out;
}

function stripWebp(d: Uint8Array): { bytes: Uint8Array; orientation: number } {
  if (d.length < 12) fail("webp: too short");
  const riff = u32le(d, 4);
  const end = 8 + riff;
  if (riff < 4 || end > d.length) fail("webp: RIFF size past the end");
  const chunks = riffChunks(d, 12, end, "chunk");
  // an animation frame: 16 bytes of frame header, then its own sub-chunks (only the picture ones are kept)
  const frames = new Map<number, Uint8Array>();
  chunks.forEach((c, k) => {
    if (c.type !== "ANMF") return;
    if (c.dataEnd - c.dataAt < 16) fail("webp: short ANMF");
    const subs = riffChunks(d, c.dataAt + 16, c.dataEnd, "frame chunk");
    if (subs.every((s) => ANMF_KEEP.has(s.type))) return;
    const f = new Out();
    f.push(d.subarray(c.dataAt, c.dataAt + 16));
    for (const s of subs) {
      if (!ANMF_KEEP.has(s.type)) continue;
      f.push(d.subarray(s.start, s.end));
      if ((s.end - s.start) & 1) f.push(Uint8Array.of(0));
    }
    frames.set(k, f.bytes());
  });
  if (!frames.size && chunks.every((c) => WEBP_KEEP.has(c.type))) return { bytes: d.subarray(0, end), orientation: 1 }; // nothing to remove (anything after the RIFF goes)
  let o = 1;
  const exif = chunks.find((c) => c.type === "EXIF");
  if (exif) o = orientationFromTiff(withoutExifPrefix(d.subarray(exif.dataAt, exif.dataEnd)));
  const body = new Out();
  chunks.forEach((c, k) => {
    if (!WEBP_KEEP.has(c.type)) return;
    let chunk: Uint8Array = d.subarray(c.start, c.end);
    const frame = frames.get(k);
    if (frame) {
      chunk = new Uint8Array(8 + frame.length);
      chunk.set(latin("ANMF"));
      chunk.set(le32(frame.length), 4);
      chunk.set(frame, 8);
    } else if (c.type === "VP8X") {
      if (c.dataEnd - c.dataAt < 10) fail("webp: short VP8X");
      let flags = d[c.dataAt] & ~0x0c;
      if (o !== 1) flags |= 0x08;
      chunk = chunk.slice();
      chunk[8] = flags;
    }
    body.push(chunk);
    if (chunk.length & 1) body.push(Uint8Array.of(0));
  });
  if (o !== 1) {
    if (!chunks.some((c) => c.type === "VP8X")) fail("webp: orientation without VP8X");
    const t = minimalTiff(o);
    body.push(latin("EXIF"));
    body.push(le32(t.length));
    body.push(t);
  }
  const b = body.bytes();
  const out = new Uint8Array(12 + b.length);
  out.set(latin("RIFF"));
  out.set(le32(4 + b.length), 4);
  out.set(latin("WEBP"), 8);
  out.set(b, 12);
  return { bytes: out, orientation: o };
}

// ---- HEIF (ISOBMFF) ------------------------------------------------------------------------------------------------

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "mif2"]);
/** Metadata items: never needed to draw the picture. */
const HEIF_BLANK = new Set(["Exif", "mime", "uri "]);
/** Any other top-level box (Samsung sefd, uuid, free, …) is cleared: a zero-filled "free" box of the same size. */
const HEIF_TOP_KEEP = new Set(["ftyp", "meta", "mdat", "moov"]);
/** Inside moov and its traks: QuickTime user data (GPS, author): cleared. */
const HEIF_USER_DATA = new Set(["udta", "meta"]);
/** XML metadata as a box of the main meta: cleared. */
const HEIF_META_XML = new Set(["xml ", "bxml"]);

interface Box {
  type: string;
  start: number;
  content: number;
  end: number;
}

function boxAt(d: Uint8Array, i: number, end: number): Box {
  if (i + 8 > end) fail("heif: ends inside a box header");
  let size = u32be(d, i);
  const type = String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
  let hdr = 8;
  if (size === 1) {
    if (i + 16 > end) fail("heif: ends inside a large size");
    const hi = u32be(d, i + 8);
    if (hi > 0x1fffff) fail("heif: box size past the end");
    size = hi * 0x100000000 + u32be(d, i + 12);
    hdr = 16;
  } else if (size === 0) {
    size = end - i;
  }
  if (size < hdr || i + size > end) fail("heif: box size past the end");
  return { type, start: i, content: i + hdr, end: i + size };
}

function boxes(d: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let i = start; i < end; ) {
    const b = boxAt(d, i, end);
    out.push(b);
    i = b.end;
  }
  return out;
}

export function isHeif(d: Uint8Array): boolean {
  if (d.length < 16 || !startsWith(d, 4, "ftyp")) return false;
  let size = u32be(d, 0);
  let hdr = 8;
  if (size === 1) {
    const hi = u32be(d, 8);
    if (hi > 0x1fffff) return false;
    size = hi * 0x100000000 + u32be(d, 12);
    hdr = 16;
  }
  if (size < hdr + 8 || size > d.length) return false;
  const brand = (p: number) => String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
  if (HEIF_BRANDS.has(brand(hdr))) return true;
  for (let k = hdr + 8; k + 4 <= size; k += 4) if (HEIF_BRANDS.has(brand(k))) return true;
  return false;
}

function uint(d: Uint8Array, p: number, size: number, end: number): [number, number] {
  if (size === 0) return [0, p];
  if (p + size > end) fail("heif: ends inside a field");
  let v = 0;
  for (let k = 0; k < size; k++) v = v * 256 + d[p + k];
  return [v, p + size];
}

function indexOf(d: Uint8Array, byte: number, from: number, to: number): number {
  for (let k = from; k < to; k++) if (d[k] === byte) return k;
  return -1;
}

function stripHeif(d: Uint8Array): { bytes: Uint8Array; orientation: number } {
  // top level: every box must parse (unreadable bytes could be anything); meta, the mdats, and the boxes to clear
  let meta: Box | undefined;
  const mdats: Box[] = [];
  const cleared: Box[] = [];
  for (const b of boxes(d, 0, d.length)) {
    if (b.type === "meta" && !meta) meta = b;
    else if (b.type === "mdat") mdats.push(b);
    else if (b.type === "moov") {
      for (const b2 of boxes(d, b.content, b.end)) {
        if (HEIF_USER_DATA.has(b2.type)) cleared.push(b2);
        else if (b2.type === "trak") for (const b3 of boxes(d, b2.content, b2.end)) if (HEIF_USER_DATA.has(b3.type)) cleared.push(b3);
      }
    } else if (!HEIF_TOP_KEEP.has(b.type) || b.type === "meta") cleared.push(b); // incl. a second meta
  }
  if (!meta) fail("heif: no meta box");
  if (meta!.content + 4 > meta!.end) fail("heif: short meta");
  let iinf: Box | undefined;
  let iloc: Box | undefined;
  let idat: Box | undefined;
  for (const b of boxes(d, meta!.content + 4, meta!.end)) {
    if (b.type === "iinf" && !iinf) iinf = b;
    else if (b.type === "iloc" && !iloc) iloc = b;
    else if (b.type === "idat" && !idat) idat = b;
    else if (HEIF_META_XML.has(b.type)) cleared.push(b);
  }
  if (!iinf || !iloc) fail("heif: no iinf/iloc");
  if (iinf!.content + 4 > iinf!.end || iloc!.content + 4 > iloc!.end) fail("heif: short iinf/iloc");
  // the items to blank: Exif (its orientation is written back), XMP and any other mime / uri item
  const targets = new Map<number, string>();
  const seen = new Set<number>();
  const v = d[iinf!.content];
  const p0 = iinf!.content + 4 + (v === 0 ? 2 : 4);
  if (p0 > iinf!.end) fail("heif: short iinf");
  for (const b of boxes(d, p0, iinf!.end)) {
    if (b.type !== "infe" || b.content + 4 > b.end) continue;
    const iv = d[b.content];
    if (iv < 2) continue;
    let [itemId, q] = uint(d, b.content + 4, iv === 2 ? 2 : 4, b.end);
    if (seen.has(itemId)) fail("heif: duplicate item id");
    seen.add(itemId);
    q += 2; // protection index
    if (q + 4 > b.end) fail("heif: short infe");
    const itype = String.fromCharCode(d[q], d[q + 1], d[q + 2], d[q + 3]);
    if (HEIF_BLANK.has(itype)) targets.set(itemId, itype);
  }
  // every item's location
  const lv = d[iloc!.content];
  const end = iloc!.end;
  let p = iloc!.content + 4;
  if (p + 2 > end) fail("heif: short iloc");
  const offsetSize = d[p] >> 4;
  const lengthSize = d[p] & 15;
  const baseSize = d[p + 1] >> 4;
  const indexSize = lv === 1 || lv === 2 ? d[p + 1] & 15 : 0;
  p += 2;
  const okSize = (x: number) => x === 0 || x === 4 || x === 8;
  if (lv > 2 || !okSize(offsetSize) || !okSize(lengthSize) || !okSize(baseSize) || !okSize(indexSize)) fail("heif: iloc sizes");
  const fieldless = offsetSize === 0 && lengthSize === 0 && indexSize === 0; // an extent costs no bytes: at most one each
  let count: number;
  [count, p] = uint(d, p, lv < 2 ? 2 : 4, end);
  const located = new Set<number>();
  const targetRanges: { a: number; b: number; id: number }[] = [];
  const otherRanges: [number, number][] = [];
  for (let it = 0; it < count; it++) {
    let itemId: number, method = 0, dref: number, base: number, nex: number;
    [itemId, p] = uint(d, p, lv < 2 ? 2 : 4, end);
    if (lv === 1 || lv === 2) {
      [method, p] = uint(d, p, 2, end);
      method &= 15;
    }
    [dref, p] = uint(d, p, 2, end);
    [base, p] = uint(d, p, baseSize, end);
    [nex, p] = uint(d, p, 2, end);
    if (fieldless && nex > 1) fail("heif: iloc extents without fields");
    const extents: [number, number][] = [];
    for (let e = 0; e < nex; e++) {
      let off: number, ln: number;
      [, p] = uint(d, p, indexSize, end);
      [off, p] = uint(d, p, offsetSize, end);
      [ln, p] = uint(d, p, lengthSize, end);
      extents.push([off, ln]);
    }
    const kind = targets.get(itemId);
    if (kind !== undefined) {
      if (located.has(itemId)) fail("heif: an item located twice");
      located.add(itemId);
    }
    if (dref !== 0) continue; // in another file: nothing of it is here
    let lo: number, hi: number;
    if (method === 0) [lo, hi] = [0, d.length];
    else if (method === 1) {
      if (!idat) fail("heif: idat item without idat");
      [lo, hi] = [idat!.content, idat!.end];
    } else if (kind === undefined) continue; // made from other items (their data is located on its own)
    else fail("heif: metadata item by reference");
    const rs: [number, number][] = [];
    for (const [off, ln] of extents) {
      const a = lo! + base + off;
      const b = ln === 0 ? hi! : a + ln;
      // (8-byte fields: anything past 2^53 is far past the end anyway)
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < lo! || b > hi! || a > b) fail("heif: item extent past the end");
      rs.push([a, b]);
    }
    if (kind === undefined) {
      otherRanges.push(...rs);
      continue;
    }
    for (const [a, b] of rs) {
      if (method === 0) {
        // the mdats are in file order: sorted, disjoint; the last one starting at or before a
        let lo2 = 0;
        let hi2 = mdats.length;
        while (lo2 < hi2) {
          const mid = (lo2 + hi2) >>> 1;
          if (mdats[mid].content <= a) lo2 = mid + 1;
          else hi2 = mid;
        }
        if (lo2 === 0 || b > mdats[lo2 - 1].end) fail("heif: metadata outside the media data");
      }
      targetRanges.push({ a, b, id: itemId });
    }
  }
  for (const id of targets.keys()) if (!located.has(id)) fail("heif: a metadata item without a location");
  // never write over another item or over a metadata extent twice (sorted sweeps: no quadratic work)
  const sorted = targetRanges.filter((r) => r.b > r.a).sort((x, y) => x.a - y.a || x.b - y.b);
  for (let k = 1; k < sorted.length; k++) if (sorted[k].a < sorted[k - 1].b) fail("heif: overlapping metadata extents");
  // the type and the content are rewritten; disjoint
  const cl = cleared.map((b) => ({ content: b.start + 4, end: b.end })).sort((x, y) => x.content - y.content);
  // the first entry whose end is past c (ends are sorted)
  const firstEndAfter = <T>(xs: T[], endOf: (x: T) => number, c: number): number => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (endOf(xs[mid]) <= c) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const [c, e] of otherRanges) {
    if (e <= c) continue;
    let k = firstEndAfter(sorted, (r) => r.b, c);
    if (k < sorted.length && sorted[k].a < e) fail("heif: metadata overlaps the picture");
    k = firstEndAfter(cl, (b) => b.end, c);
    if (k < cl.length && cl[k].content < e) fail("heif: picture data in a box that is cleared");
  }
  const out = d.slice();
  for (const b of cleared) {
    out.set(latin("free"), b.start + 4);
    out.fill(0, b.content, b.end);
  }
  let o = 1;
  const byId = new Map<number, { a: number; b: number }[]>();
  for (const r of targetRanges) {
    const list = byId.get(r.id);
    if (list) list.push(r);
    else byId.set(r.id, [r]);
  }
  for (const id of [...byId.keys()].sort((x, y) => x - y)) {
    const ranges = byId.get(id)!;
    const total = ranges.reduce((s, r) => s + (r.b - r.a), 0);
    const fill = new Uint8Array(total);
    if (targets.get(id) === "Exif") {
      const data = new Uint8Array(total);
      let k = 0;
      for (const r of ranges) {
        data.set(d.subarray(r.a, r.b), k);
        k += r.b - r.a;
      }
      if (data.length >= 4) {
        const hoff = u32be(data, 0);
        if (4 + hoff <= data.length) {
          const t = data.subarray(4 + hoff);
          o = orientationFromTiff(hoff === 0 ? withoutExifPrefix(t) : t);
        }
      }
      const tf = minimalTiff(o);
      if (4 + tf.length <= total) fill.set(tf, 4); // the 4-byte header offset stays 0
    }
    let k = 0;
    for (const r of ranges) {
      out.set(fill.subarray(k, k + (r.b - r.a)), r.a);
      k += r.b - r.a;
    }
  }
  return { bytes: out, orientation: o };
}

// ---- sniff (12.1.16 2-2) -------------------------------------------------------------------------------------------

/** How many bytes the sniff reads (the upload reads only this much before deciding). */
export const SNIFF_HEAD = 65536;
/** tiff = classic TIFF (TIFF, DNG, CR2, NEF, ARW, …) and BigTIFF; raw = camera RAWs with their own signature (ORF,
 *  RW2/RWL, RAF, CR3). Both carry Exif/GPS and aren't cleaned: the upload refuses them. */
export type SniffFormat = "jpeg" | "png" | "webp" | "heif" | "gif" | "tiff" | "raw";
/** The formats the cleaner cleans. Outside the list: GIF (passes through, the documented v1 exception) and TIFF (the
 *  upload refuses it: launch-gate 13:55). */
export const CLEANED_FORMATS: ReadonlySet<SniffFormat> = new Set(["jpeg", "png", "webp", "heif"]);

/** A HEIF picture by its ftyp's MAJOR brand, read from the head whatever the box's size (a 70 KB ftyp is still a
 *  HEIC; a video whose ftyp only lists a HEIF brand among its compatible ones is not a picture). */
function sniffHeif(d: Uint8Array): boolean {
  if (d.length < 12 || !startsWith(d, 4, "ftyp")) return false;
  const hdr = u32be(d, 0) === 1 ? 16 : 8;
  return d.length >= hdr + 4 && HEIF_BRANDS.has(String.fromCharCode(d[hdr], d[hdr + 1], d[hdr + 2], d[hdr + 3]));
}

/** What the bytes are, from their first SNIFF_HEAD bytes, never the file's type or name; null = not a picture. */
export function sniffImage(head: Uint8Array): SniffFormat | null {
  const d = head.subarray(0, SNIFF_HEAD);
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return "jpeg";
  if (d.length >= 8 && PNG_SIG.every((b, k) => d[k] === b)) return "png";
  if (startsWith(d, 0, "RIFF") && startsWith(d, 8, "WEBP")) return "webp";
  if (sniffHeif(d)) return "heif";
  if (startsWith(d, 0, "GIF87a") || startsWith(d, 0, "GIF89a")) return "gif";
  if (["II*\0", "MM\0*", "II+\0", "MM\0+"].some((m) => startsWith(d, 0, m))) return "tiff";
  if (["IIRO", "IIRS", "MMOR", "IIU\0", "FUJIFILMCCD-RAW"].some((m) => startsWith(d, 0, m)) || (startsWith(d, 4, "ftyp") && startsWith(d, 8, "crx "))) return "raw";
  return null;
}

// ---- entry ---------------------------------------------------------------------------------------------------------

/** Strip the identifying metadata of an image's bytes (see the header). Throws ExifStripError when the structure
 *  can't be walked: the caller must not upload the original then. */
export function stripImageMetadata(d: Uint8Array): Stripped {
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return { format: "jpeg", ...stripJpeg(d) };
  if (d.length >= 8 && PNG_SIG.every((b, k) => d[k] === b)) return { format: "png", ...stripPng(d) };
  if (startsWith(d, 0, "RIFF") && startsWith(d, 8, "WEBP")) return { format: "webp", ...stripWebp(d) };
  if (isHeif(d)) return { format: "heif", ...stripHeif(d) };
  return { format: "other", bytes: d, orientation: 1 };
}
