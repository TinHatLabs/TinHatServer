// media.ts — authenticated Matrix media (Synapse enforces MSC3916: /_matrix/client/v1/media/*
// with a bearer token), encrypted attachments (AES-CTR-256 + SHA-256 per the spec), uploads.
//
//   const src = useMxcUrl(avatarMxc, { width: 64, height: 64, method: "crop" }); // object URL | undefined
//   const src = useEncryptedMedia(content.file, content.info?.mimetype);           // E2EE image/video/audio
//   const up  = await uploadFile(file, { encrypt: roomIsEncrypted, onProgress });  // → up.content to send
//   const blob = await fetchMedia(mxc);                                             // raw bytes (downloads)
//
// Object URLs live in an LRU (≤ 400 entries / 192 MB) with reference counts: an URL is revoked
// only when evicted AND unreferenced, so a mounted <img> never loses its source.
import { useEffect, useState } from "react";
import { onClientChanged, peekClient } from "./client";
import { bearerAllowed } from "@/core/bearer";
import { createLogger } from "@/core/log";
import { blobType, inertBlob } from "@/core/mediatype";

const log = createLogger("media");

export interface EncryptedFile {
  url: string;
  key: { alg: string; key_ops: string[]; kty: string; k: string; ext: boolean };
  iv: string;
  hashes: Record<string, string>;
  v: string;
}

export interface MediaOpts {
  /** Thumbnail box (server-side scaling). Omit both for the original file. */
  width?: number;
  height?: number;
  method?: "crop" | "scale";
  /** Ask for an animated thumbnail (GIF/WebP) where the server supports it. */
  animated?: boolean;
}

// ---- URLs ------------------------------------------------------------------------------------

export function parseMxc(mxc: string | null | undefined): { server: string; mediaId: string } | null {
  if (!mxc || !mxc.startsWith("mxc://")) return null;
  const rest = mxc.slice(6);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const server = rest.slice(0, slash);
  const mediaId = rest.slice(slash + 1).split(/[?#]/)[0]!;
  if (!/^[A-Za-z0-9._:\-[\]]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(mediaId)) return null;
  return { server, mediaId };
}

/**
 * The authenticated HTTP URL for an mxc (needs `Authorization: Bearer` — not usable in <img>
 * directly; use useMxcUrl / fetchMedia).
 */
export function mxcHttpUrl(mxc: string, opts: MediaOpts = {}, hsUrl?: string): string | null {
  const p = parseMxc(mxc);
  const base = (hsUrl ?? peekClient()?.getHomeserverUrl() ?? "").replace(/\/+$/, "");
  if (!p || !base) return null;
  const path = `${encodeURIComponent(p.server)}/${encodeURIComponent(p.mediaId)}`;
  if (opts.width || opts.height) {
    const q = new URLSearchParams();
    q.set("width", String(Math.max(1, Math.round(opts.width ?? opts.height ?? 96))));
    q.set("height", String(Math.max(1, Math.round(opts.height ?? opts.width ?? 96))));
    q.set("method", opts.method ?? "scale");
    if (opts.animated) q.set("animated", "true");
    return `${base}/_matrix/client/v1/media/thumbnail/${path}?${q}`;
  }
  return `${base}/_matrix/client/v1/media/download/${path}`;
}

// ---- fetching --------------------------------------------------------------------------------

const inflightBlobs = new Map<string, Promise<Blob>>();

/** Download media bytes with the bearer token. Thumbnail failures fall back to the full file. The Blob's type comes from
 *  the allow-list (core/mediatype), never straight from the server's Content-Type. */
export async function fetchMedia(mxc: string, opts: MediaOpts = {}): Promise<Blob> {
  const url = mxcHttpUrl(mxc, opts);
  if (!url) throw new Error(`not an mxc url: ${mxc}`);
  const hit = inflightBlobs.get(url);
  if (hit) return hit;
  const run = (async () => {
    const token = bearerAllowed(url) ? peekClient()?.getAccessToken() : undefined;
    const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) {
      // Some media (e.g. SVG, tiny images) have no thumbnail: use the original instead.
      if ((opts.width || opts.height) && (r.status === 400 || r.status === 404 || r.status === 415)) {
        return fetchMedia(mxc, {});
      }
      throw new Error(`media ${r.status}`);
    }
    // H1 (security review 2026-10-26): the server's Content-Type is the uploader's choice — a blob of these bytes
    // (an object URL in an <img>, "Open image in new tab") must never be text/html or SVG in this origin
    return inertBlob(await r.blob());
  })();
  inflightBlobs.set(url, run);
  try {
    return await run;
  } finally {
    inflightBlobs.delete(url);
  }
}

// ---- object-URL LRU --------------------------------------------------------------------------

interface Entry {
  url?: string;
  bytes: number;
  refs: number;
  lastUsed: number;
  promise: Promise<string>;
  failed?: number; // time of failure (negative cache)
}

const MAX_ENTRIES = 400;
const MAX_BYTES = 192 * 1024 * 1024;
const FAIL_TTL = 60 * 1000;
const lru = new Map<string, Entry>();
let totalBytes = 0;

function evict() {
  if (lru.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) return;
  const victims = [...lru.entries()].filter(([, e]) => e.refs === 0 && e.url).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [k, e] of victims) {
    if (lru.size <= MAX_ENTRIES && totalBytes <= MAX_BYTES) break;
    URL.revokeObjectURL(e.url!);
    totalBytes -= e.bytes;
    lru.delete(k);
  }
}

/** Drop every cached object URL (logout). */
export function clearMediaCache(): void {
  for (const e of lru.values()) if (e.url && e.refs === 0) URL.revokeObjectURL(e.url);
  lru.clear();
  totalBytes = 0;
}

function acquire(key: string, load: () => Promise<Blob>): { promise: Promise<string>; release: () => void } {
  let e = lru.get(key);
  if (e?.failed && Date.now() - e.failed > FAIL_TTL) {
    lru.delete(key);
    e = undefined;
  }
  if (!e) {
    const entry: Entry = { bytes: 0, refs: 0, lastUsed: Date.now(), promise: Promise.resolve("") };
    entry.promise = load().then(
      (blob) => {
        entry.url = URL.createObjectURL(blob);
        entry.bytes = blob.size;
        totalBytes += blob.size;
        evict();
        return entry.url;
      },
      (err: unknown) => {
        entry.failed = Date.now();
        throw err;
      },
    );
    entry.promise.catch(() => undefined);
    lru.set(key, entry);
    e = entry;
  }
  const entry = e;
  entry.refs++;
  entry.lastUsed = Date.now();
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      entry.lastUsed = Date.now();
      evict();
    },
  };
}

function mediaKey(mxc: string, o: MediaOpts) {
  return `${mxc}|${o.width ?? ""}x${o.height ?? ""}|${o.method ?? ""}|${o.animated ? "a" : ""}`;
}

/** Imperative: a referenced object URL for an mxc (call release() when done with it). */
export function acquireMxcUrl(mxc: string, opts: MediaOpts = {}): { promise: Promise<string>; release: () => void } {
  return acquire(mediaKey(mxc, opts), () => fetchMedia(mxc, opts));
}

/** React: object URL for an mxc (authenticated, cached, revoked when unused), or undefined. */
/** Shared by both hooks: hold a reference to `key` while mounted; the URL state is tagged with its key. */
function useAcquired(key: string, load: (() => Promise<Blob>) | null, what: string): string | undefined {
  const cached = key ? lru.get(key)?.url : undefined;
  const [st, setSt] = useState<{ key: string; url?: string }>({ key, url: cached });
  useEffect(() => {
    if (!key || !load) {
      setSt({ key, url: undefined });
      return;
    }
    let alive = true;
    const h = acquire(key, load);
    setSt({ key, url: lru.get(key)?.url });
    h.promise.then(
      (u) => {
        if (alive) setSt({ key, url: u });
      },
      (e: unknown) => {
        if (alive) setSt({ key, url: undefined });
        log.debug(`${what}: ${(e as Error)?.message ?? e}`);
      },
    );
    return () => {
      alive = false;
      h.release();
    };
    // `load` is derived from `key`
  }, [key]);
  if (!key) return undefined;
  // Never return the previous key's URL for one render after the source changed.
  return st.key === key ? st.url ?? cached : cached;
}

export function useMxcUrl(mxc: string | null | undefined, opts: MediaOpts = {}): string | undefined {
  const key = mxc && parseMxc(mxc) ? mediaKey(mxc, opts) : "";
  return useAcquired(key, key && mxc ? () => fetchMedia(mxc, opts) : null, `media ${mxc}`);
}

// ---- encrypted attachments -------------------------------------------------------------------

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array, urlSafe = false): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  let s = btoa(bin).replace(/=+$/, "");
  if (urlSafe) s = s.replace(/\+/g, "-").replace(/\//g, "_");
  return s;
}

/**
 * Decrypt an encrypted attachment (spec "Sending encrypted attachments"): verify the SHA-256 of
 * the ciphertext FIRST, then AES-CTR-256 with the JWK key and 128-bit counter block `iv`.
 */
export async function decryptAttachment(data: ArrayBuffer, file: EncryptedFile): Promise<ArrayBuffer> {
  if (!file?.key || file.key.alg !== "A256CTR" || !file.iv || !file.hashes?.sha256) {
    throw new Error("unsupported encrypted attachment");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  if (bytesToB64(digest) !== file.hashes.sha256.replace(/=+$/, "")) throw new Error("attachment hash mismatch");
  const key = await crypto.subtle.importKey("jwk", { ...file.key, ext: true } as JsonWebKey, { name: "AES-CTR" }, false, ["decrypt"]);
  const counter = b64ToBytes(file.iv);
  // v1/v2 use a 64-bit counter; v0 (no `v`) used the whole 128-bit block.
  const length = file.v === "v1" || file.v === "v2" ? 64 : 128;
  return crypto.subtle.decrypt({ name: "AES-CTR", counter, length }, key, data);
}

/** Encrypt bytes for an E2EE room: returns the ciphertext + the EncryptedFile (minus `url`). */
export async function encryptAttachment(plain: ArrayBuffer): Promise<{ data: ArrayBuffer; file: Omit<EncryptedFile, "url"> }> {
  const key = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  // 128-bit IV: random top 64 bits, zero counter half (as Element does — avoids counter wrap).
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const data = await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plain);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return {
    data,
    file: {
      v: "v2",
      key: { alg: "A256CTR", ext: true, k: jwk.k!, key_ops: ["encrypt", "decrypt"], kty: "oct" },
      iv: bytesToB64(iv),
      hashes: { sha256: bytesToB64(hash) },
    },
  };
}

/** Download + decrypt an encrypted file to a Blob typed by the event's mimetype through the allow-list (core/mediatype:
 *  never text/html, SVG or any other type a browser would run as a page in this origin). */
export async function fetchEncryptedMedia(file: EncryptedFile, mimetype?: string): Promise<Blob> {
  const raw = await fetchMedia(file.url);
  const plain = await decryptAttachment(await raw.arrayBuffer(), file);
  return new Blob([plain], { type: blobType(mimetype) });
}

/** React: object URL of a decrypted E2EE attachment (cached like useMxcUrl), or undefined. */
export function useEncryptedMedia(file: EncryptedFile | null | undefined, mimetype?: string): string | undefined {
  const key = file?.url && parseMxc(file.url) ? `enc|${file.url}|${file.hashes?.sha256 ?? ""}|${mimetype ?? ""}` : "";
  return useAcquired(key, key && file ? () => fetchEncryptedMedia(file, mimetype) : null, `encrypted media ${file?.url}`);
}

/** React: either kind — pass the message content's `url` or `file`. */
export function useMessageMedia(
  content: { url?: string; file?: EncryptedFile; info?: { mimetype?: string } } | null | undefined,
  opts: MediaOpts = {},
): string | undefined {
  const enc = useEncryptedMedia(content?.file, content?.info?.mimetype);
  const plain = useMxcUrl(content?.file ? undefined : content?.url, opts);
  return content?.file ? enc : plain;
}

// ---- uploads ---------------------------------------------------------------------------------

export interface MediaInfo {
  mimetype: string;
  size: number;
  w?: number;
  h?: number;
  /** Milliseconds (audio/video). */
  duration?: number;
}

export interface UploadedMedia {
  /** mxc:// of the uploaded (cipher)text. */
  mxc: string;
  /** Present for encrypted uploads (put it in content.file). */
  file?: EncryptedFile;
  info: MediaInfo;
  msgtype: "m.image" | "m.video" | "m.audio" | "m.file";
  /** A ready-to-send m.room.message content (body = file name, like the native send_attachment). */
  content: Record<string, unknown>;
}

function msgtypeFor(mime: string): UploadedMedia["msgtype"] {
  if (mime.startsWith("image/")) return "m.image";
  if (mime.startsWith("video/")) return "m.video";
  if (mime.startsWith("audio/")) return "m.audio";
  return "m.file";
}

async function probe(blob: Blob, mime: string): Promise<Partial<MediaInfo>> {
  try {
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      const bmp = await createImageBitmap(blob);
      const out = { w: bmp.width, h: bmp.height };
      bmp.close();
      return out;
    }
    if (mime.startsWith("video/") || mime.startsWith("audio/")) {
      const url = URL.createObjectURL(blob);
      try {
        return await new Promise<Partial<MediaInfo>>((resolve) => {
          const el = document.createElement(mime.startsWith("video/") ? "video" : "audio");
          const done = (v: Partial<MediaInfo>) => {
            el.removeAttribute("src");
            resolve(v);
          };
          el.preload = "metadata";
          el.onloadedmetadata = () => {
            const v: Partial<MediaInfo> = {};
            if (Number.isFinite(el.duration)) v.duration = Math.round(el.duration * 1000);
            if (el instanceof HTMLVideoElement && el.videoWidth) {
              v.w = el.videoWidth;
              v.h = el.videoHeight;
            }
            done(v);
          };
          el.onerror = () => done({});
          setTimeout(() => done({}), 5000);
          el.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch (e) {
    log.debug("probe failed", e);
  }
  return {};
}

/**
 * Upload a file (encrypting it first for E2EE rooms) and build the m.room.message content,
 * matching the native send_attachment: body = file name, info = {mimetype, size, w/h for images
 * (+ video), duration for audio/video}.
 */
export async function uploadFile(
  file: File | Blob,
  opts: { encrypt: boolean; name?: string; mimetype?: string; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal },
): Promise<UploadedMedia> {
  const client = peekClient();
  if (!client) throw new Error("Not signed in");
  const name = opts.name ?? (file instanceof File ? file.name : "file");
  const mimetype = opts.mimetype || file.type || "application/octet-stream";
  const extra = await probe(file, mimetype);
  const info: MediaInfo = { mimetype, size: file.size, ...extra };
  if (mimetype.startsWith("audio/")) {
    delete info.w;
    delete info.h;
  }
  let body: Blob = file;
  let encFile: Omit<EncryptedFile, "url"> | undefined;
  if (opts.encrypt) {
    const enc = await encryptAttachment(await file.arrayBuffer());
    body = new Blob([enc.data], { type: "application/octet-stream" });
    encFile = enc.file;
  }
  const abortController = new AbortController();
  opts.signal?.addEventListener("abort", () => abortController.abort());
  const res = await client.uploadContent(body, {
    name: opts.encrypt ? undefined : name,
    type: opts.encrypt ? "application/octet-stream" : mimetype,
    includeFilename: !opts.encrypt,
    abortController,
    progressHandler: (p) => opts.onProgress?.(p.loaded, p.total),
  });
  const mxc = res.content_uri;
  const msgtype = msgtypeFor(mimetype);
  const content: Record<string, unknown> = { msgtype, body: name, info: { ...info } };
  let fileOut: EncryptedFile | undefined;
  if (encFile) {
    fileOut = { ...encFile, url: mxc };
    content.file = fileOut;
  } else {
    content.url = mxc;
  }
  return { mxc, file: fileOut, info, msgtype, content };
}

// Signed out (or switched account): nothing cached may leak into the next session.
onClientChanged(() => {
  if (!peekClient()) clearMediaCache();
});
