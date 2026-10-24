// animimg.ts — how long an animated GIF / WebP plays (GPU.md §2.6): frame count, one loop's length and the file's
// own loop count, read from the bytes (no decoding). Pure; unit-tested in animimg.test.ts. The desktop gets the same
// numbers from QMovie (frameCount, nextFrameDelay, loopCount) — see notes/gpu-web.md "rules for the desktop".
//
//   GIF   GIF87a/GIF89a: every image descriptor (0x2C) is a frame; its delay is the preceding Graphic Control
//         Extension's (0xF9, centiseconds; 0–1 → 100 ms like every browser); the NETSCAPE2.0 / ANIMEXTS1.0 block
//         carries the loop count (0 = forever; n = n + 1 plays; no block = one play).
//   WebP  RIFF/WEBP: VP8X flag 0x02 = animation, ANIM = loop count (0 = forever, n = n plays), one ANMF per frame
//         with a 24-bit duration in ms (0–10 → 100 ms, as Chromium).
// Anything else (JPEG, PNG — APNG is not handled —, a truncated or broken file) → not animated.
import { gifFrameMs } from "./lowgpu";

export interface AnimInfo {
  kind: "gif" | "webp" | "other";
  /** more than one frame */
  animated: boolean;
  frames: number;
  /** one loop, in ms (0 when unknown) */
  loopMs: number;
  /** total plays: 0 = forever, else the number of times the file plays */
  plays: number;
  width: number;
  height: number;
}

const NOT: AnimInfo = { kind: "other", animated: false, frames: 0, loopMs: 0, plays: 0, width: 0, height: 0 };

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Is this worth inspecting? (a cheap sniff of the first bytes) */
export function sniffKind(b: Uint8Array): AnimInfo["kind"] {
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF89a" || ascii(b, 0, 6) === "GIF87a")) return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  return "other";
}

export function inspectAnimation(b: Uint8Array): AnimInfo {
  const kind = sniffKind(b);
  try {
    if (kind === "gif") return inspectGif(b);
    if (kind === "webp") return inspectWebp(b);
  } catch {
    /* truncated / broken: treat as a still image */
  }
  return NOT;
}

function skipSubBlocks(b: Uint8Array, at: number): number {
  while (at < b.length) {
    const n = b[at];
    at += 1;
    if (n === 0) return at;
    at += n;
  }
  return at;
}

function inspectGif(b: Uint8Array): AnimInfo {
  const width = u16(b, 6);
  const height = u16(b, 8);
  const packed = b[10];
  let at = 13;
  if (packed & 0x80) at += 3 * (1 << ((packed & 7) + 1));
  let frames = 0;
  let loopMs = 0;
  let delay = 0;
  let loop: number | null = null;
  while (at < b.length) {
    const block = b[at];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      const label = b[at + 1];
      if (label === 0xf9 && b[at + 2] === 4) {
        delay = u16(b, at + 4);
        at = skipSubBlocks(b, at + 2);
      } else if (label === 0xff && b[at + 2] === 11) {
        const app = ascii(b, at + 3, 11);
        let p = at + 14;
        if ((app === "NETSCAPE2.0" || app === "ANIMEXTS1.0") && b[p] >= 3 && b[p + 1] === 1) loop = u16(b, p + 2);
        at = skipSubBlocks(b, p);
      } else at = skipSubBlocks(b, at + 2);
      continue;
    }
    if (block === 0x2c) {
      const ipacked = b[at + 9];
      let p = at + 10;
      if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 7) + 1));
      p += 1; // LZW minimum code size
      at = skipSubBlocks(b, p);
      if (at > b.length) break; // a frame cut short: not counted
      frames += 1;
      loopMs += gifFrameMs(delay);
      delay = 0;
      continue;
    }
    break; // unknown block: stop reading
  }
  const plays = loop === null ? 1 : loop === 0 ? 0 : loop + 1;
  return { kind: "gif", animated: frames > 1, frames, loopMs: frames > 1 ? loopMs : 0, plays, width, height };
}

function inspectWebp(b: Uint8Array): AnimInfo {
  const end = Math.min(b.length, 8 + u32(b, 4));
  let at = 12;
  let flagAnim = false;
  let loop = 0;
  let frames = 0;
  let loopMs = 0;
  let width = 0;
  let height = 0;
  while (at + 8 <= end) {
    const tag = ascii(b, at, 4);
    const size = u32(b, at + 4);
    const data = at + 8;
    if (tag === "VP8X") {
      flagAnim = (b[data] & 0x02) !== 0;
      width = u24(b, data + 4) + 1;
      height = u24(b, data + 7) + 1;
    } else if (tag === "ANIM") loop = u16(b, data + 4);
    else if (tag === "ANMF") {
      if (data + 16 > end) break;
      frames += 1;
      const d = u24(b, data + 12);
      loopMs += d <= 10 ? 100 : d;
    }
    at = data + size + (size & 1);
  }
  const animated = flagAnim && frames > 1;
  return { kind: "webp", animated, frames, loopMs: animated ? loopMs : 0, plays: loop, width, height };
}
