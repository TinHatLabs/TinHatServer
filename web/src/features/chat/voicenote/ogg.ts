// ogg.ts — voice notes: the Ogg/Opus muxer of the web recorder (docs/VOICE-NOTES.md §3 "Ogg timing contract",
// RFC 3533 + RFC 7845) and a small demuxer the tests read it back with. Pure: no DOM, no I/O.
//
//   const mux = new OggOpusMuxer({ preSkip });            // preSkip from the encoder's OpusHead, else 312
//   out.push(...mux.headers());                             // OpusHead page (BOS) + OpusTags page
//   out.push(...mux.addPacket(packet));                     // per encoder output, in order
//   out.push(...mux.finish(capturedSamples));               // after encoder.flush(): the EOS page, end-trimmed
//
// Pages hold at most 50 packets (1 s of 20 ms frames) and 255 lacing values; a packet's lacing is ⌊len/255⌋ values of
// 255 then len % 255 (so a packet of exactly 255 bytes is [255, 0]). A page's granule = the decoded samples (48 kHz) of
// every packet completed up to the end of that page, priming included; the last page (EOS) carries
// preSkip + capturedSamples, so a player drops the priming at the front and the encoder's padding at the end.

/** libopus' 48 kHz lookahead: what every encoder of our browsers reports as pre-skip. */
export const DEFAULT_PRE_SKIP = 312;
export const MAX_PACKETS_PER_PAGE = 50;
const MAX_SEGMENTS = 255;

// ---- CRC-32 (Ogg: poly 0x04C11DB7, init 0, no reflection, no final xor) --------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

// ---- Opus packet length (RFC 6716 §3.1) ----------------------------------------------------------------------------
/** Decoded samples at 48 kHz of one Opus packet, from its TOC byte (and the frame count byte of a code-3 packet). */
export function opusPacketSamples(p: Uint8Array): number {
  if (p.length < 1) return 0;
  const toc = p[0]!;
  const config = toc >> 3;
  let frame: number; // samples at 48 kHz per frame
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3]!; // SILK 10/20/40/60 ms
  else if (config < 16) frame = [480, 960][config & 1]!; // hybrid 10/20 ms
  else frame = [120, 240, 480, 960][config & 3]!; // CELT 2.5/5/10/20 ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (p.length > 1 ? p[1]! & 0x3f : 0) : 2;
  return frame * frames;
}

// ---- headers (RFC 7845 §5) -----------------------------------------------------------------------------------------
export function opusHead(preSkip: number, channels = 1, inputRate = 48000): Uint8Array {
  const b = new Uint8Array(19);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  const v = new DataView(b.buffer);
  b[8] = 1; // version
  b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  v.setInt16(16, 0, true); // output gain
  b[18] = 0; // mapping family 0 (mono / stereo)
  return b;
}

/** The pre-skip of an OpusHead (the encoder's decoderConfig.description), or null when it isn't one. */
export function preSkipOf(desc: ArrayBuffer | ArrayBufferView | null | undefined): number | null {
  if (!desc) return null;
  const b = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
  if (b.length < 19) return null;
  const magic = String.fromCharCode(...b.subarray(0, 8));
  if (magic !== "OpusHead") return null;
  return b[10]! | (b[11]! << 8);
}

export function opusTags(vendor = "Tin Hat"): Uint8Array {
  const v = new TextEncoder().encode(vendor);
  const b = new Uint8Array(8 + 4 + v.length + 4);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // "OpusTags"
  const dv = new DataView(b.buffer);
  dv.setUint32(8, v.length, true);
  b.set(v, 12);
  dv.setUint32(12 + v.length, 0, true); // no user comments
  return b;
}

// ---- pages --------------------------------------------------------------------------------------------------------
export const FLAG_CONTINUED = 0x01;
export const FLAG_BOS = 0x02;
export const FLAG_EOS = 0x04;
/** "No packet completes on this page" (RFC 3533). */
export const GRANULE_NONE = -1n;

export function lacing(len: number): number[] {
  const out: number[] = [];
  for (let n = len; n >= 255; n -= 255) out.push(255);
  out.push(len % 255);
  return out;
}

/** One Ogg page: header + lacing + body, CRC filled in. `granule` is a BigInt (−1 = none). */
export function oggPage(flags: number, granule: bigint, serial: number, seq: number, segments: number[], body: Uint8Array): Uint8Array {
  if (segments.length > MAX_SEGMENTS) throw new Error(`ogg page with ${segments.length} segments`);
  const p = new Uint8Array(27 + segments.length + body.length);
  const v = new DataView(p.buffer);
  p.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  p[4] = 0; // version
  p[5] = flags;
  v.setBigUint64(6, BigInt.asUintN(64, granule), true);
  v.setUint32(14, serial >>> 0, true);
  v.setUint32(18, seq >>> 0, true);
  v.setUint32(22, 0, true); // CRC (computed over the page with this field zero)
  p[26] = segments.length;
  p.set(segments, 27);
  p.set(body, 27 + segments.length);
  v.setUint32(22, oggCrc(p), true);
  return p;
}

interface Pending {
  data: Uint8Array;
  samples: number;
}

export interface MuxerOptions {
  preSkip?: number;
  /** stream serial number (any u32; the recorder picks a random one) */
  serial?: number;
  vendor?: string;
}

/** The Ogg/Opus muxer (mono, 48 kHz). Feed it the encoder's packets in order; it returns finished pages. */
export class OggOpusMuxer {
  readonly preSkip: number;
  readonly serial: number;
  private readonly vendor: string;
  private seq = 0;
  private granule = 0; // decoded samples of every packet already on a written page
  private pending: Pending[] = [];
  private headersDone = false;
  private finished = false;
  /** decoded samples of every packet received (priming included) */
  totalSamples = 0;
  /** set by finish(): the end trim had to be clamped (fewer samples were encoded than preSkip + captured) */
  short = false;

  constructor(o: MuxerOptions = {}) {
    this.preSkip = o.preSkip ?? DEFAULT_PRE_SKIP;
    this.serial = (o.serial ?? 0x5448564e) >>> 0;
    this.vendor = o.vendor ?? "Tin Hat";
  }

  /** The two header pages: OpusHead (BOS, granule 0) and OpusTags (granule 0), each on a page of its own. */
  headers(): Uint8Array[] {
    if (this.headersDone) return [];
    this.headersDone = true;
    const head = opusHead(this.preSkip);
    const tags = opusTags(this.vendor);
    return [oggPage(FLAG_BOS, 0n, this.serial, this.seq++, lacing(head.length), head), oggPage(0, 0n, this.serial, this.seq++, lacing(tags.length), tags)];
  }

  /** One encoder packet; returns the pages it completed (a page is written only once the next packet doesn't fit, so
   *  the last page — the EOS page — always holds at least one packet). `samples` defaults to the TOC's count. */
  addPacket(data: Uint8Array, samples: number = opusPacketSamples(data)): Uint8Array[] {
    if (this.finished) throw new Error("muxer finished");
    const out = this.headers();
    const segs = (p: Pending[]) => p.reduce((n, x) => n + lacing(x.data.length).length, 0);
    if (this.pending.length >= MAX_PACKETS_PER_PAGE || (this.pending.length > 0 && segs(this.pending) + lacing(data.length).length > MAX_SEGMENTS)) {
      out.push(this.writePage(this.pending, 0));
      this.pending = [];
    }
    this.pending.push({ data, samples });
    this.totalSamples += samples;
    return out;
  }

  /** After encoder.flush() resolved: the last page with the EOS flag and granule = preSkip + capturedSamples (clamped to
   *  what was encoded, `short` = true then). */
  finish(capturedSamples: number): Uint8Array[] {
    if (this.finished) return [];
    this.finished = true;
    const out = this.headers();
    let end = this.preSkip + Math.max(0, Math.floor(capturedSamples));
    if (end > this.totalSamples) {
      this.short = true;
      end = this.totalSamples;
    }
    // RFC 7845 §4.4: the end trim only shortens the LAST page — its granule may never fall below the page before it
    // (more packets than preSkip + captured need: muxOggOpus drops them before they reach a page)
    if (this.granule > 0 && end <= this.granule) {
      throw new Error(`Ogg EOS granule ${end} would run backwards (pages already end at ${this.granule}): drop the packets past the end first`);
    }
    out.push(this.writePage(this.pending, FLAG_EOS, BigInt(end)));
    this.pending = [];
    return out;
  }

  private writePage(packets: Pending[], flags: number, granuleOverride?: bigint): Uint8Array {
    const segments: number[] = [];
    let size = 0;
    for (const p of packets) {
      segments.push(...lacing(p.data.length));
      size += p.data.length;
      this.granule += p.samples;
    }
    const body = new Uint8Array(size);
    let o = 0;
    for (const p of packets) {
      body.set(p.data, o);
      o += p.data.length;
    }
    const g = granuleOverride ?? (packets.length ? BigInt(this.granule) : GRANULE_NONE);
    return oggPage(flags, g, this.serial, this.seq++, segments, body);
  }
}

/** The whole note at once (what the recorder does after encoder.flush()): only the packets up to the FIRST one that
 *  covers preSkip + capturedSamples are muxed — an encoder may emit more (Chromium pads the lookahead itself on flush,
 *  on top of our own padding), and a page of those would end past the EOS granule, which then could not trim it
 *  (RFC 7845 §4.4). Returns the pages, the packets dropped, and `short` when the encoder gave too few samples. */
export function muxOggOpus(
  packets: readonly Uint8Array[],
  o: { preSkip: number; capturedSamples: number; serial?: number; vendor?: string },
): { pages: Uint8Array[]; dropped: number; short: boolean; totalSamples: number } {
  const end = o.preSkip + Math.max(0, Math.floor(o.capturedSamples));
  let keep = packets.length;
  let cum = 0;
  for (let i = 0; i < packets.length; i++) {
    cum += opusPacketSamples(packets[i]!);
    if (cum >= end) {
      keep = i + 1;
      break;
    }
  }
  const mux = new OggOpusMuxer({ preSkip: o.preSkip, serial: o.serial, vendor: o.vendor });
  const pages = [...mux.headers()];
  for (let i = 0; i < keep; i++) pages.push(...mux.addPacket(packets[i]!));
  pages.push(...mux.finish(o.capturedSamples));
  return { pages, dropped: packets.length - keep, short: mux.short, totalSamples: mux.totalSamples };
}

// ---- demuxer (tests, diagnostics) ---------------------------------------------------------------------------------
export interface DemuxPage {
  flags: number;
  granule: bigint;
  serial: number;
  seq: number;
  segments: number[];
  crcOk: boolean;
  /** packets completed on this page */
  completed: number;
}
export interface Demuxed {
  pages: DemuxPage[];
  packets: Uint8Array[];
  preSkip: number | null;
  /** decoded samples after pre-skip and the end trim (RFC 7845 §4): last granule − preSkip */
  playableSamples: number | null;
  /** every audio page's granule ≥ the one before (headers 0, "none" pages skipped) */
  granulesMonotonic: boolean;
}

/** Read an Ogg stream back: every page (CRC checked), the packets reassembled from the lacing (continuations across
 *  pages included). Throws on a malformed page. */
export function demuxOgg(bytes: Uint8Array): Demuxed {
  const pages: DemuxPage[] = [];
  const packets: Uint8Array[] = [];
  let partial: number[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (bytes.length - at < 27 || bytes[at] !== 0x4f || bytes[at + 1] !== 0x67 || bytes[at + 2] !== 0x67 || bytes[at + 3] !== 0x53)
      throw new Error(`no Ogg page at ${at}`);
    const v = new DataView(bytes.buffer, bytes.byteOffset + at);
    const n = bytes[at + 26]!;
    const segments = Array.from(bytes.subarray(at + 27, at + 27 + n));
    const bodyLen = segments.reduce((a, b) => a + b, 0);
    const len = 27 + n + bodyLen;
    if (at + len > bytes.length) throw new Error(`truncated page at ${at}`);
    const page = bytes.slice(at, at + len);
    const stored = new DataView(page.buffer).getUint32(22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    const crcOk = oggCrc(page) === stored;
    let off = at + 27 + n;
    let completed = 0;
    for (const s of segments) {
      for (let i = 0; i < s; i++) partial.push(bytes[off + i]!);
      off += s;
      if (s < 255) {
        packets.push(Uint8Array.from(partial));
        partial = [];
        completed++;
      }
    }
    pages.push({ flags: bytes[at + 5]!, granule: v.getBigInt64(6, true), serial: v.getUint32(14, true), seq: v.getUint32(18, true), segments, crcOk, completed });
    at += len;
  }
  const preSkip = packets.length ? preSkipOf(packets[0]) : null;
  const last = pages[pages.length - 1];
  let mono = true;
  let prev = -1n;
  for (const p of pages) {
    if (p.granule === GRANULE_NONE) continue;
    if (p.granule < prev) mono = false;
    prev = p.granule;
  }
  return { pages, packets, preSkip, playableSamples: last && preSkip !== null ? Number(last.granule) - preSkip : null, granulesMonotonic: mono };
}
