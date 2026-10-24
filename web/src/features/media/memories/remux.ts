// memories/remux.ts — D17: play the recorder's Matroska files where the browser can't (Firefox,
// Safari/iPhone): a streaming EBML demuxer → fragmented MP4 (avc1 + Opus) → Media Source Extensions
// (ManagedMediaSource on iOS). Progressive: the file streams in (range requests, backpressure keeps
// ~90 s buffered ahead), seeks outside the buffered range restart the download at the nearest Cue.
// Chromium plays MKV natively and never takes this path unless forced with ?remux=1 (QA).
//
// Scope = what the recorder writes: H.264 (V_MPEG4/ISO/AVC, no B-frames) and Opus (A_OPUS), SimpleBlocks /
// BlockGroups, any lacing, known- or unknown-size Segment/Cluster, Cues via the SeekHead.

// ---- EBML ids -----------------------------------------------------------------------------------------
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueClusterPosition: 0xf1,
} as const;
const SEGMENT_CHILDREN = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, 0x1254c367 /*Tags*/, 0x1043a770 /*Chapters*/, 0x1941a469 /*Attachments*/, ID.Cluster]);
const UNKNOWN = -1;

export interface MkvTrack {
  number: number;
  type: number; // 1 video, 2 audio
  codecId: string;
  codecPrivate: Uint8Array | null;
  width: number;
  height: number;
  channels: number;
  rate: number;
  defaultDurationNs: number;
}
export interface MkvSample {
  track: number;
  ptsMs: number;
  key: boolean;
  data: Uint8Array;
}
export interface MkvCue {
  timeMs: number;
  pos: number; // relative to the Segment data start
}

// ---- small readers ------------------------------------------------------------------------------------

/** VINT at p: {len, value} (value without the marker unless keepMarker); null when not enough bytes. */
function vint(b: Uint8Array, p: number, keepMarker: boolean): { len: number; value: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || p + len > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  if (!keepMarker && allOnes) return { len, value: UNKNOWN };
  return { len, value };
}
function uint(b: Uint8Array, p: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[p + i];
  return v;
}
function float(b: Uint8Array, p: number, n: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + p, n);
  return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
}
function str(b: Uint8Array, p: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) if (b[p + i]) s += String.fromCharCode(b[p + i]);
  return s;
}
/** Iterate the children of a fully-buffered master element's payload. */
function* children(b: Uint8Array, start: number, end: number): Generator<{ id: number; p: number; size: number }> {
  let p = start;
  while (p < end) {
    const id = vint(b, p, true);
    if (!id) return;
    const sz = vint(b, p + id.len, false);
    if (!sz) return;
    const dataP = p + id.len + sz.len;
    const size = sz.value === UNKNOWN ? end - dataP : sz.value;
    yield { id: id.value, p: dataP, size };
    p = dataP + size;
  }
}

// ---- the streaming demuxer --------------------------------------------------------------------------------

export interface DemuxEvents {
  onInfo?(timecodeScaleNs: number, durationMs: number): void;
  onTracks?(tracks: MkvTrack[]): void;
  onSeekHead?(cuesPos: number): void;
  onCues?(cues: MkvCue[]): void;
  /** every complete cluster's samples (in file order) */
  onCluster?(samples: MkvSample[]): void;
}

export class MkvDemuxer {
  private buf = new Uint8Array(0);
  private abs = 0; // file offset of buf[0]
  private skip = 0; // bytes still to drop (skipped element body)
  segDataStart = -1;
  timecodeScale = 1_000_000;
  tracks = new Map<number, MkvTrack>();
  private cluster: MkvSample[] | null = null;
  private clusterTc = 0;

  constructor(private ev: DemuxEvents) {}

  /** Restart at a file offset (a Cue's cluster) keeping Info/Tracks. */
  resetAt(fileOffset: number): void {
    this.buf = new Uint8Array(0);
    this.abs = fileOffset;
    this.skip = 0;
    this.cluster = null;
  }

  push(chunk: Uint8Array): void {
    if (this.skip > 0) {
      const d = Math.min(this.skip, chunk.length);
      this.skip -= d;
      this.abs += d;
      chunk = chunk.subarray(d);
      if (!chunk.length) return;
    }
    if (this.buf.length) {
      const n = new Uint8Array(this.buf.length + chunk.length);
      n.set(this.buf);
      n.set(chunk, this.buf.length);
      this.buf = n;
    } else this.buf = chunk.slice();
    this.parse();
  }

  /** End of input: emit the last cluster. */
  end(): void {
    this.flushCluster();
  }

  private flushCluster() {
    if (this.cluster && this.cluster.length) this.ev.onCluster?.(this.cluster);
    this.cluster = null;
  }

  private parse() {
    const b = this.buf;
    let p = 0;
    for (;;) {
      if (this.skip > 0) break;
      const id = vint(b, p, true);
      if (!id) break;
      const sz = vint(b, p + id.len, false);
      if (!sz) break;
      const hdr = id.len + sz.len;
      const dataP = p + hdr;
      const eid = id.value;
      // containers we step INTO (size ignored → unknown sizes just work)
      if (eid === ID.Segment) {
        this.segDataStart = this.abs + dataP;
        p = dataP;
        continue;
      }
      if (eid === ID.Cluster) {
        this.flushCluster();
        this.cluster = [];
        this.clusterTc = 0;
        p = dataP;
        continue;
      }
      if (this.cluster && SEGMENT_CHILDREN.has(eid)) this.flushCluster();
      if (sz.value === UNKNOWN) {
        // an unknown-size leaf we don't understand: step into it
        p = dataP;
        continue;
      }
      const size = sz.value;
      const wanted = eid === ID.Info || eid === ID.Tracks || eid === ID.SeekHead || eid === ID.Cues || eid === ID.Timecode || eid === ID.SimpleBlock || eid === ID.BlockGroup;
      if (!wanted) {
        // skip without buffering the body
        const have = b.length - dataP;
        if (have >= size) {
          p = dataP + size;
          continue;
        }
        this.skip = size - have;
        p = b.length;
        break;
      }
      if (b.length - dataP < size) break; // wait for the whole element
      this.element(eid, b, dataP, size);
      p = dataP + size;
    }
    // drop consumed bytes
    this.abs += Math.min(p, b.length);
    this.buf = p >= b.length ? new Uint8Array(0) : b.subarray(p);
    if (this.skip > 0 && this.buf.length) {
      const d = Math.min(this.skip, this.buf.length);
      this.skip -= d;
      this.abs += d;
      this.buf = this.buf.subarray(d);
    }
  }

  private element(id: number, b: Uint8Array, p: number, size: number) {
    switch (id) {
      case ID.Info: {
        let dur = 0;
        for (const c of children(b, p, p + size)) {
          if (c.id === ID.TimecodeScale) this.timecodeScale = uint(b, c.p, c.size);
          else if (c.id === ID.Duration) dur = float(b, c.p, c.size);
        }
        this.ev.onInfo?.(this.timecodeScale, (dur * this.timecodeScale) / 1e6);
        break;
      }
      case ID.Tracks: {
        for (const te of children(b, p, p + size)) {
          if (te.id !== ID.TrackEntry) continue;
          const t: MkvTrack = { number: 0, type: 0, codecId: "", codecPrivate: null, width: 0, height: 0, channels: 2, rate: 48000, defaultDurationNs: 0 };
          for (const c of children(b, te.p, te.p + te.size)) {
            if (c.id === ID.TrackNumber) t.number = uint(b, c.p, c.size);
            else if (c.id === ID.TrackType) t.type = uint(b, c.p, c.size);
            else if (c.id === ID.CodecID) t.codecId = str(b, c.p, c.size);
            else if (c.id === ID.CodecPrivate) t.codecPrivate = b.slice(c.p, c.p + c.size);
            else if (c.id === ID.DefaultDuration) t.defaultDurationNs = uint(b, c.p, c.size);
            else if (c.id === ID.Video)
              for (const v of children(b, c.p, c.p + c.size)) {
                if (v.id === ID.PixelWidth) t.width = uint(b, v.p, v.size);
                else if (v.id === ID.PixelHeight) t.height = uint(b, v.p, v.size);
              }
            else if (c.id === ID.Audio)
              for (const a of children(b, c.p, c.p + c.size)) {
                if (a.id === ID.SamplingFrequency) t.rate = float(b, a.p, a.size);
                else if (a.id === ID.Channels) t.channels = uint(b, a.p, a.size);
              }
          }
          this.tracks.set(t.number, t);
        }
        this.ev.onTracks?.([...this.tracks.values()]);
        break;
      }
      case ID.SeekHead: {
        for (const s of children(b, p, p + size)) {
          if (s.id !== ID.Seek) continue;
          let sid = 0;
          let pos = -1;
          for (const c of children(b, s.p, s.p + s.size)) {
            if (c.id === ID.SeekID) sid = uint(b, c.p, c.size);
            else if (c.id === ID.SeekPosition) pos = uint(b, c.p, c.size);
          }
          if (sid === ID.Cues && pos >= 0) this.ev.onSeekHead?.(pos);
        }
        break;
      }
      case ID.Cues:
        this.ev.onCues?.(parseCues(b, p, size, this.timecodeScale));
        break;
      case ID.Timecode:
        this.clusterTc = uint(b, p, size);
        break;
      case ID.SimpleBlock:
        this.block(b, p, size, null);
        break;
      case ID.BlockGroup: {
        let blk: { p: number; size: number } | null = null;
        let ref = false;
        for (const c of children(b, p, p + size)) {
          if (c.id === ID.Block) blk = { p: c.p, size: c.size };
          else if (c.id === ID.ReferenceBlock) ref = true;
        }
        if (blk) this.block(b, blk.p, blk.size, !ref);
        break;
      }
    }
  }

  private block(b: Uint8Array, p: number, size: number, keyOverride: boolean | null) {
    if (!this.cluster) this.cluster = [];
    const tn = vint(b, p, false);
    if (!tn) return;
    let q = p + tn.len;
    const rel = (b[q] << 24) >> 16 | b[q + 1]; // int16
    const flags = b[q + 2];
    q += 3;
    const end = p + size;
    const key = keyOverride ?? !!(flags & 0x80);
    const lacing = (flags >> 1) & 3;
    const track = this.tracks.get(tn.value);
    const baseMs = ((this.clusterTc + rel) * this.timecodeScale) / 1e6;
    const frameMs = track?.defaultDurationNs ? track.defaultDurationNs / 1e6 : track?.type === 2 ? 20 : 33.333;
    const frames: Uint8Array[] = [];
    if (lacing === 0) frames.push(b.slice(q, end));
    else {
      const count = b[q] + 1;
      q += 1;
      const sizes: number[] = [];
      if (lacing === 1) {
        // Xiph
        for (let i = 0; i < count - 1; i++) {
          let s = 0;
          while (b[q] === 255) {
            s += 255;
            q++;
          }
          s += b[q++];
          sizes.push(s);
        }
      } else if (lacing === 3) {
        // EBML
        const f = vint(b, q, false);
        if (!f) return;
        q += f.len;
        sizes.push(f.value);
        for (let i = 1; i < count - 1; i++) {
          const d = vint(b, q, false);
          if (!d) return;
          q += d.len;
          const bias = 2 ** (7 * d.len - 1) - 1;
          sizes.push(sizes[i - 1] + (d.value - bias));
        }
      } else {
        // fixed
        const each = Math.floor((end - q) / count);
        for (let i = 0; i < count - 1; i++) sizes.push(each);
      }
      const used = sizes.reduce((a, c) => a + c, 0);
      sizes.push(end - q - used);
      for (const s of sizes) {
        frames.push(b.slice(q, q + s));
        q += s;
      }
    }
    frames.forEach((data, i) => this.cluster!.push({ track: tn.value, ptsMs: baseMs + i * frameMs, key: i === 0 ? key : track?.type === 2, data }));
  }
}

export function parseCues(b: Uint8Array, p: number, size: number, timecodeScale: number): MkvCue[] {
  const out: MkvCue[] = [];
  for (const cp of children(b, p, p + size)) {
    if (cp.id !== ID.CuePoint) continue;
    let t = -1;
    let pos = -1;
    for (const c of children(b, cp.p, cp.p + cp.size)) {
      if (c.id === ID.CueTime) t = uint(b, c.p, c.size);
      else if (c.id === ID.CueTrackPositions)
        for (const x of children(b, c.p, c.p + c.size)) if (x.id === ID.CueClusterPosition && pos < 0) pos = uint(b, x.p, x.size);
    }
    if (t >= 0 && pos >= 0) out.push({ timeMs: (t * timecodeScale) / 1e6, pos });
  }
  out.sort((a, c) => a.timeMs - c.timeMs);
  return out;
}

// ---- the fMP4 muxer ------------------------------------------------------------------------------------------

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function u16(n: number): number[] {
  return [(n >>> 8) & 255, n & 255];
}
function u64(n: number): number[] {
  const hi = Math.floor(n / 2 ** 32);
  return [...u32(hi), ...u32(n >>> 0)];
}
function cat(parts: Array<Uint8Array | number[]>): Uint8Array {
  let n = 0;
  for (const x of parts) n += x.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}
function box(type: string, ...payload: Array<Uint8Array | number[]>): Uint8Array {
  const body = cat(payload);
  return cat([u32(body.length + 8), [...type].map((c) => c.charCodeAt(0)), body]);
}
function fbox(type: string, version: number, flags: number, ...payload: Array<Uint8Array | number[]>): Uint8Array {
  return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...payload);
}
const MATRIX = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

interface OutTrack {
  id: number;
  src: number; // mkv track number
  kind: "video" | "audio";
  timescale: number;
  pending: MkvSample | null;
  lastDur: number;
  gotKey: boolean;
  codec: string;
  entry: Uint8Array;
  w: number;
  h: number;
  /** audio: end (ms) of the last emitted frame, −1 = none yet */
  endMs: number;
  channels: number;
}

/** Tracks → init segment + codecs string; clusters → moof/mdat fragments. */
export class Fmp4Muxer {
  private out: OutTrack[] = [];
  private seq = 1;
  mime = "";

  constructor(tracks: MkvTrack[]) {
    let id = 1;
    for (const t of tracks) {
      if (t.type === 1 && t.codecId === "V_MPEG4/ISO/AVC" && t.codecPrivate) {
        const cp = t.codecPrivate;
        const codec = `avc1.${[cp[1], cp[2], cp[3]].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
        const entry = box(
          "avc1",
          [0, 0, 0, 0, 0, 0, ...u16(1)],
          new Array(16).fill(0),
          u16(t.width),
          u16(t.height),
          u32(0x480000),
          u32(0x480000),
          u32(0),
          u16(1),
          new Array(32).fill(0),
          u16(0x18),
          u16(0xffff),
          box("avcC", cp),
        );
        this.out.push({ id: id++, src: t.number, kind: "video", timescale: 90000, pending: null, lastDur: 3000, gotKey: false, codec, entry, w: t.width, h: t.height, endMs: -1, channels: 0 });
      } else if (t.type === 2 && t.codecId === "A_OPUS" && t.codecPrivate && t.codecPrivate.length >= 19) {
        const h = t.codecPrivate; // "OpusHead" v ch preskip(le16) rate(le32) gain(le16) family [table]
        const ch = h[9];
        const preskip = h[10] | (h[11] << 8);
        const rate = (h[12] | (h[13] << 8) | (h[14] << 16) | (h[15] << 24)) >>> 0;
        const gain = h[16] | (h[17] << 8);
        const family = h[18];
        const dOps = box("dOps", [0, ch], u16(preskip), u32(rate), u16(gain), [family], family ? Array.from(h.subarray(19, 21 + ch)) : []);
        const entry = box("Opus", [0, 0, 0, 0, 0, 0, ...u16(1)], u32(0), u32(0), u16(ch), u16(16), u16(0), u16(0), u32(48000 * 65536), dOps);
        this.out.push({ id: id++, src: t.number, kind: "audio", timescale: 48000, pending: null, lastDur: 960, gotKey: true, codec: "opus", entry, w: 0, h: 0, endMs: -1, channels: ch });
      }
    }
    const hasVideo = this.out.some((o) => o.kind === "video");
    this.mime = `${hasVideo ? "video" : "audio"}/mp4; codecs="${this.out.map((o) => o.codec).join(", ")}"`;
  }

  get usable(): boolean {
    return this.out.length > 0;
  }

  /**
   * MSE only reports (and plays) what EVERY track covers, so a camera file whose voices start late or
   * end early would stall there. Fill audio gaps > 0.5 s under the video with Opus silence frames
   * (CELT 20 ms "silent" packet) — never overlapping audio already emitted.
   */
  private padAudio(per: Array<Array<{ s: MkvSample; dur: number }>>) {
    const vi = this.out.findIndex((o) => o.kind === "video");
    const ai = this.out.findIndex((o) => o.kind === "audio");
    if (vi < 0 || ai < 0 || !per[vi].length) return;
    const ao = this.out[ai];
    const v = per[vi];
    const vStart = v[0].s.ptsMs;
    const vEnd = v[v.length - 1].s.ptsMs + v[v.length - 1].dur / 90;
    const real = per[ai];
    const silence = new Uint8Array([ao.channels > 1 ? 0xfc : 0xf8, 0xff, 0xfe]);
    const fill = (from: number, to: number) => {
      const out: Array<{ s: MkvSample; dur: number }> = [];
      for (let t = from; t + 20 <= to + 0.01; t += 20) out.push({ s: { track: ao.src, ptsMs: t, key: true, data: silence }, dur: 960 });
      return out;
    };
    let cursor = ao.endMs >= 0 ? ao.endMs : vStart;
    const firstReal = real.length ? real[0].s.ptsMs : Infinity;
    const lead = Math.min(firstReal, vEnd) - cursor > 500 ? fill(cursor, Math.min(firstReal, vEnd)) : [];
    if (real.length) cursor = Math.max(cursor, real[real.length - 1].s.ptsMs + real[real.length - 1].dur / 48);
    else if (lead.length) cursor = lead[lead.length - 1].s.ptsMs + 20;
    const tail = vEnd - cursor > 500 ? fill(cursor, vEnd) : [];
    const all = [...lead, ...real, ...tail];
    per[ai] = all;
    if (all.length) ao.endMs = Math.max(ao.endMs, all[all.length - 1].s.ptsMs + all[all.length - 1].dur / 48);
  }

  init(): Uint8Array {
    const traks = this.out.map((o) => {
      const video = o.kind === "video";
      const tkhd = fbox("tkhd", 0, 3, u32(0), u32(0), u32(o.id), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u16(video ? 0 : 0x100), u16(0), MATRIX, u32(o.w * 65536), u32(o.h * 65536));
      const mdhd = fbox("mdhd", 0, 0, u32(0), u32(0), u32(o.timescale), u32(0), u16(0x55c4), u16(0));
      const hdlr = fbox("hdlr", 0, 0, u32(0), [...(video ? "vide" : "soun")].map((c) => c.charCodeAt(0)), u32(0), u32(0), u32(0), [...(video ? "VideoHandler" : "SoundHandler")].map((c) => c.charCodeAt(0)), [0]);
      const xmhd = video ? fbox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)) : fbox("smhd", 0, 0, u16(0), u16(0));
      const dinf = box("dinf", fbox("dref", 0, 0, u32(1), fbox("url ", 0, 1)));
      const stbl = box("stbl", fbox("stsd", 0, 0, u32(1), o.entry), fbox("stts", 0, 0, u32(0)), fbox("stsc", 0, 0, u32(0)), fbox("stsz", 0, 0, u32(0), u32(0)), fbox("stco", 0, 0, u32(0)));
      return box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", xmhd, dinf, stbl)));
    });
    const mvhd = fbox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(this.out.length + 1));
    const mvex = box("mvex", ...this.out.map((o) => fbox("trex", 0, 0, u32(o.id), u32(1), u32(0), u32(0), u32(0))));
    const ftyp = box("ftyp", [..."isom"].map((c) => c.charCodeAt(0)), u32(0x200), [..."isomiso6avc1mp41"].map((c) => c.charCodeAt(0)));
    return cat([ftyp, box("moov", mvhd, ...traks, mvex)]);
  }

  /** Forget pending samples (after a seek restart). */
  reset(): void {
    for (const o of this.out) {
      o.pending = null;
      o.gotKey = o.kind === "audio";
      o.endMs = -1;
    }
  }

  /** One cluster's samples → moof+mdat (null when nothing to emit). `final` flushes the pending tail. */
  fragment(samples: MkvSample[], final = false): Uint8Array | null {
    const per = this.out.map(() => [] as Array<{ s: MkvSample; dur: number }>);
    this.out.forEach((o, i) => {
      const mine = samples.filter((s) => s.track === o.src).sort((a, c) => a.ptsMs - c.ptsMs);
      if (o.kind === "audio") {
        // audio frames go out at once (20 ms Opus; the duration comes from the next frame's pts)
        mine.forEach((s, k) => {
          const next = mine[k + 1];
          const ms = next ? Math.max(2.5, Math.min(120, next.ptsMs - s.ptsMs)) : o.lastDur / 48;
          const d = Math.round(ms * 48);
          o.lastDur = d;
          per[i].push({ s, dur: d });
        });
        return;
      }
      for (const s of mine) {
        if (!o.gotKey) {
          if (!s.key) continue; // MSE must start a track on a random-access point
          o.gotKey = true;
        }
        if (o.pending) {
          const d = Math.max(1, Math.round(((s.ptsMs - o.pending.ptsMs) * o.timescale) / 1000));
          o.lastDur = d;
          per[i].push({ s: o.pending, dur: d });
        }
        o.pending = s;
      }
      if (final && o.pending) {
        per[i].push({ s: o.pending, dur: o.lastDur });
        o.pending = null;
      }
    });
    this.padAudio(per);
    if (per.every((x) => !x.length)) return null;
    // moof size is fixed by the sample counts: mfhd 16 + per traf (8 + tfhd 16 + tfdt 20 + trun 20 + 12·n)
    const trafSizes = per.map((x) => (x.length ? 8 + 16 + 20 + 20 + 12 * x.length : 0));
    const moofSize = 8 + 16 + trafSizes.reduce((a, c) => a + c, 0);
    let dataOff = moofSize + 8;
    const trafs: Uint8Array[] = [];
    const payload: Uint8Array[] = [];
    per.forEach((x, i) => {
      if (!x.length) return;
      const o = this.out[i];
      const base = Math.max(0, Math.round((x[0].s.ptsMs * o.timescale) / 1000));
      const rows: number[] = [];
      for (const { s, dur } of x) {
        rows.push(...u32(dur), ...u32(s.data.length), ...u32(o.kind === "audio" || s.key ? 0x02000000 : 0x01010000));
        payload.push(s.data);
      }
      trafs.push(
        box(
          "traf",
          fbox("tfhd", 0, 0x020000, u32(o.id)),
          fbox("tfdt", 1, 0, u64(base)),
          fbox("trun", 0, 0x000701, u32(x.length), u32(dataOff), rows),
        ),
      );
      dataOff += x.reduce((a, c) => a + c.s.data.length, 0);
    });
    const moof = box("moof", fbox("mfhd", 0, 0, u32(this.seq++)), ...trafs);
    const mdat = box("mdat", ...payload);
    return cat([moof, mdat]);
  }
}

// ---- capability ------------------------------------------------------------------------------------------------

type MSCtor = typeof MediaSource;
function mediaSourceCtor(): MSCtor | null {
  const w = window as unknown as { ManagedMediaSource?: MSCtor; MediaSource?: MSCtor };
  return w.ManagedMediaSource ?? w.MediaSource ?? null;
}

/** Remux is possible here (MSE takes fMP4 H.264 + Opus). */
export function canRemux(): boolean {
  const MS = mediaSourceCtor();
  if (!MS) return false;
  try {
    return MS.isTypeSupported('video/mp4; codecs="avc1.42e01f, opus"') && MS.isTypeSupported('audio/mp4; codecs="opus"');
  } catch {
    return false;
  }
}

// ---- the MSE driver ----------------------------------------------------------------------------------------------

// stop downloading this far ahead of the playhead (QA: ?remuxahead=<s> to exercise the Cue restarts)
const AHEAD_MAX_S = Number((/[?&#]remuxahead=(\d+)/.exec(typeof location !== "undefined" ? location.search + location.hash : "") ?? [])[1] ?? 90);
const BEHIND_KEEP_S = 30; // evict buffered media older than this
const DEBUG = typeof location !== "undefined" && /[?&#](memdebug|remuxdebug)=1/.test(location.search + location.hash);
const dlog = (m: string) => {
  if (DEBUG) console.log(`[remux] ${m}`);
};

/** Plays one Matroska URL on a media element through MSE. `destroy()` detaches. */
export class MkvMsePlayer {
  private ms: MediaSource;
  private sb: SourceBuffer | null = null;
  private muxer: Fmp4Muxer | null = null;
  private demux: MkvDemuxer;
  private queue: Uint8Array[] = [];
  private abort: AbortController | null = null;
  private dead = false;
  private cues: MkvCue[] = [];
  private cuesPos = -1;
  private eos = false;
  private durationMs = 0;
  private objectUrl: string;
  private lastAppendedMs = 0;
  private gen = 0;
  private clusterLogs = 0;
  private pumpLogs = 0;

  constructor(private el: HTMLMediaElement, private url: string, private onError?: (msg: string) => void) {
    const MS = mediaSourceCtor()!;
    this.ms = new MS();
    this.demux = this.makeDemux();
    (el as HTMLMediaElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    this.objectUrl = URL.createObjectURL(this.ms);
    el.src = this.objectUrl;
    this.ms.addEventListener("sourceopen", () => this.download(0), { once: true });
    el.addEventListener("seeking", this.onSeeking);
    el.addEventListener("timeupdate", this.onTime);
  }

  destroy(): void {
    this.dead = true;
    this.abort?.abort();
    this.el.removeEventListener("seeking", this.onSeeking);
    this.el.removeEventListener("timeupdate", this.onTime);
    URL.revokeObjectURL(this.objectUrl);
  }

  private makeDemux(): MkvDemuxer {
    return new MkvDemuxer({
      onInfo: (_scale, durMs) => {
        this.durationMs = durMs;
        this.setDuration();
      },
      onTracks: (tracks) => {
        if (this.sb) return;
        const mux = new Fmp4Muxer(tracks);
        if (!mux.usable) {
          this.fail("unsupported codecs in this recording");
          return;
        }
        this.muxer = mux;
        try {
          this.sb = this.ms.addSourceBuffer(mux.mime);
        } catch (e) {
          this.fail(`this browser can't play ${mux.mime}: ${(e as Error)?.message ?? e}`);
          return;
        }
        this.sb.addEventListener("updateend", () => this.pump());
        this.sb.addEventListener("error", () => dlog("SourceBuffer error"));
        if (DEBUG) {
          let n = 0;
          this.sb.addEventListener("updateend", () => {
            const b = this.sb!.buffered;
            if (n++ % 4 === 0) dlog(`updateend #${n} buffered ${b.length ? `${b.start(0).toFixed(1)}-${b.end(b.length - 1).toFixed(1)} (${b.length})` : "∅"}`);
          });
          this.sb.addEventListener("abort", () => dlog("SourceBuffer abort"));
        }
        this.el.addEventListener("error", () => dlog(`element error ${this.el.error?.code} ${this.el.error?.message}`));
        this.enqueue(mux.init());
        this.setDuration();
      },
      onSeekHead: (pos) => {
        dlog(`seekhead: cues at +${pos}`);
        if (this.cuesPos < 0) {
          this.cuesPos = pos;
          void this.fetchCues();
        }
      },
      onCues: (c) => {
        if (c.length) this.cues = c;
      },
      onCluster: (samples) => {
        const f = this.muxer?.fragment(samples);
        if (DEBUG && (this.lastAppendedMs < 1 || this.clusterLogs++ < 3)) dlog(`cluster ${samples.length} samples from ${samples[0]?.ptsMs.toFixed(0)} ms → ${f ? f.length : 0} B`);
        if (f) this.enqueue(f);
        const last = samples[samples.length - 1];
        if (last) this.lastAppendedMs = last.ptsMs;
      },
    });
  }

  private fail(msg: string) {
    if (this.dead) return;
    this.onError?.(msg);
  }

  private setDuration() {
    if (!this.durationMs || this.ms.readyState !== "open" || (this.sb && this.sb.updating)) return;
    try {
      if (!Number.isFinite(this.ms.duration) || Math.abs(this.ms.duration - this.durationMs / 1000) > 0.5) this.ms.duration = this.durationMs / 1000;
    } catch {
      /* not yet */
    }
  }

  private enqueue(b: Uint8Array) {
    this.queue.push(b);
    this.pump();
  }

  private pump() {
    const sb = this.sb;
    if (!sb || sb.updating || this.dead || this.ms.readyState !== "open") {
      if (DEBUG && this.queue.length && this.pumpLogs++ < 5) dlog(`pump held: sb=${!!sb} updating=${sb?.updating} ms=${this.ms.readyState} queue=${this.queue.length}`);
      return;
    }
    this.setDuration();
    const next = this.queue.shift();
    if (!next) {
      if (this.eos && !this.queue.length) {
        try {
          this.ms.endOfStream();
        } catch {
          /* already ended */
        }
      }
      return;
    }
    try {
      sb.appendBuffer(next as unknown as BufferSource);
    } catch (e) {
      if ((e as DOMException)?.name === "QuotaExceededError") {
        this.queue.unshift(next);
        this.evict(5);
      } else {
        dlog(`append failed: ${(e as Error)?.message ?? e}`);
        this.fail(`couldn't feed the player: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  private evict(keep = BEHIND_KEEP_S) {
    const sb = this.sb;
    if (!sb || sb.updating) return;
    const cut = this.el.currentTime - keep;
    if (cut > 1 && sb.buffered.length && sb.buffered.start(0) < cut) {
      dlog(`evict 0-${cut.toFixed(1)}`);
      try {
        sb.remove(0, cut);
      } catch {
        /* busy */
      }
    }
  }

  private aheadS(): number {
    return this.lastAppendedMs / 1000 - this.el.currentTime;
  }

  private onTime = () => {
    if (this.sb && !this.sb.updating) this.evict();
  };

  private isBuffered(t: number): boolean {
    const r = this.el.buffered;
    for (let i = 0; i < r.length; i++) if (t >= r.start(i) - 0.1 && t <= r.end(i) + 0.1) return true;
    return false;
  }

  private onSeeking = () => {
    const t = this.el.currentTime;
    dlog(`seeking to ${t.toFixed(1)} buffered=${this.isBuffered(t)} cues=${this.cues.length} seg=${this.demux.segDataStart} last=${(this.lastAppendedMs / 1000).toFixed(1)} eos=${this.eos}`);
    if (this.isBuffered(t) || !this.cues.length || this.demux.segDataStart < 0) return;
    // inside the stretch the current download is about to deliver: let it arrive
    if (!this.eos && t * 1000 >= this.lastAppendedMs && t * 1000 - this.lastAppendedMs < 20_000) return;
    let cue = this.cues[0];
    for (const c of this.cues) if (c.timeMs <= t * 1000) cue = c;
    const off = this.demux.segDataStart + cue.pos;
    this.queue = [];
    try {
      if (this.sb?.updating) this.sb.abort();
    } catch {
      /* fine */
    }
    this.muxer?.reset();
    this.demux.resetAt(off);
    this.eos = false;
    this.lastAppendedMs = cue.timeMs;
    this.clusterLogs = 0;
    this.pumpLogs = 0;
    void this.download(off);
  };

  private async fetchCues() {
    if (this.demux.segDataStart < 0 || this.cuesPos < 0) return;
    const start = this.demux.segDataStart + this.cuesPos;
    try {
      const r = await fetch(this.url, { headers: { Range: `bytes=${start}-${start + 4 * 1024 * 1024 - 1}` } });
      if (!r.ok) return;
      const b = new Uint8Array(await r.arrayBuffer());
      const id = vint(b, 0, true);
      const sz = id && vint(b, id.len, false);
      if (!id || !sz || id.value !== ID.Cues) return;
      const size = sz.value === UNKNOWN ? b.length - id.len - sz.len : Math.min(sz.value, b.length - id.len - sz.len);
      const c = parseCues(b, id.len + sz.len, size, this.demux.timecodeScale);
      if (c.length) this.cues = c;
      dlog(`cues: ${c.length}`);
    } catch (e) {
      dlog(`cues fetch failed: ${(e as Error)?.message ?? e}`);
    }
  }

  private async download(from: number) {
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    const gen = ++this.gen;
    dlog(`download from byte ${from}`);
    try {
      const r = await fetch(this.url, { signal: ctl.signal, headers: from > 0 ? { Range: `bytes=${from}-` } : {} });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      for (;;) {
        // backpressure: don't run more than AHEAD_MAX_S ahead of the playhead
        while (!this.dead && gen === this.gen && this.sb && this.aheadS() > AHEAD_MAX_S) await new Promise((res) => setTimeout(res, 500));
        if (this.dead || gen !== this.gen) {
          ctl.abort();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        this.demux.push(value);
      }
      if (gen !== this.gen) return;
      this.demux.end();
      const tail = this.muxer?.fragment([], true);
      if (tail) this.enqueue(tail);
      this.eos = true;
      this.pump();
    } catch (e) {
      if (ctl.signal.aborted || this.dead) return;
      dlog(`download failed: ${(e as Error)?.message ?? e}`);
      this.fail(`couldn't load the recording: ${(e as Error)?.message ?? e}`);
    }
  }
}

// ---- element helper --------------------------------------------------------------------------------------------

const attached = new WeakMap<HTMLMediaElement, MkvMsePlayer>();

/** Remux when the browser can't play Matroska (or ?remux=1 forces it for QA) and MSE can take fMP4. */
export function wantRemux(): boolean {
  if (/[?&#]remux=1/.test(location.search + location.hash)) return canRemux();
  try {
    const v = document.createElement("video");
    if (v.canPlayType('video/x-matroska; codecs="avc1.42E01E, opus"') !== "" || v.canPlayType("video/x-matroska") !== "") return false;
  } catch {
    /* fall through */
  }
  return canRemux();
}

/** Point a media element at a recording URL (or detach with ""), remuxing when needed. */
export function setRecordingSource(el: HTMLMediaElement, url: string, onError?: (msg: string) => void): void {
  attached.get(el)?.destroy();
  attached.delete(el);
  if (!url) {
    el.pause();
    el.removeAttribute("src");
    el.load();
    return;
  }
  if (wantRemux()) {
    attached.set(el, new MkvMsePlayer(el, url, onError));
    return;
  }
  el.src = url;
  el.load();
}
